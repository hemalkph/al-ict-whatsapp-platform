import { HttpAttemptError, type SendResult } from "./transport";
import { MAX_RESPONSE_BYTES, RETRY_AFTER_CAP_MS, THROTTLE_RETRY_VERIFIED } from "./policy";
import { isIntactIdentifier } from "@/modules/whatsapp/identifiers";

// Pure interpretation of Meta's answers. THE RULE: a send is only ever repeated, or recorded as definitively refused, when the
// answer is a WELL-FORMED Meta error object whose numeric code is in Meta's documented error table AND the body carries nothing
// that looks like a created message. Everything else is UNKNOWN (it may have been created) and never goes back in the queue:
//  * 2xx with exactly one message id and no error object -> accepted.   * any other 2xx -> UNKNOWN.
//  * a body that mixes an error with success-shaped data (a `messages` or `contacts` entry) -> UNKNOWN, whatever the status.
//  * 429 -> rejected for the documented 131048/131049. A documented throughput/rate code (130429, 131056, 80007, 4) is UNKNOWN
//    as well while THROTTLE_RETRY_VERIFIED is false (it is): Meta's table recommends retrying it but does not say that nothing
//    was created. A bare 429, an unparseable or oversized body or an undocumented code -> UNKNOWN.
//  * other 4xx (not 408) -> rejected ONLY for a documented rejection code; any other code or no code -> UNKNOWN.
//  * 5xx, 3xx, 408 and anything unexpected -> UNKNOWN: the documented 5xx codes (131000, 131016, 133004) say the service
//    failed, not that no message was created, and no idempotency feature is documented for this endpoint.
// What the documentation establishes (see docs/WHATSAPP_OUTBOUND_EVIDENCE.md): the error table lists a "retry" recommendation
// for the throttle codes; it does not guarantee that nothing was created, so no response that came back from Meta is ever
// repeated automatically, and neither is any failure of the HTTP attempt itself (classifyTransportError). The only repeats are
// refusals made BEFORE an HTTP attempt began (gates, credentials, payload), which never come through this file.
// The error `message` text from Meta is never kept: only the numeric code.

const AUTH_CODES = new Set([0, 3, 10, 190, 131005]);
const RESTRICTED_CODES = new Set([368, 131037, 131042]);
const TEMPLATE_CODES = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016, 132068]);
const RECIPIENT_CODES = new Set([131021, 131026, 131050, 131051]);
const REQUEST_CODES = new Set([100, 131008, 131009]);
/** Documented rate/throughput codes (HTTP 429). Recognised, but terminal (UNKNOWN) until THROTTLE_RETRY_VERIFIED. */
const THROTTLE_CODES = new Set([130429, 131056, 80007, 4]);
/** Documented 429 codes about spam/engagement restrictions: a final refusal, never retried. */
const ECOSYSTEM_CODES = new Set([131048, 131049]);
const REJECTION_CODES = new Set([
  ...AUTH_CODES,
  ...RESTRICTED_CODES,
  ...TEMPLATE_CODES,
  ...RECIPIENT_CODES,
  ...REQUEST_CODES,
  ...ECOSYSTEM_CODES,
  131047,
]);

function rejectionReason(code: number | null): string {
  if (code === null) return "provider_rejected";
  if (AUTH_CODES.has(code)) return "credential_rejected";
  if (RESTRICTED_CODES.has(code)) return "account_restricted";
  if (code === 131047) return "window_closed_at_provider";
  if (ECOSYSTEM_CODES.has(code)) return "ecosystem_limit";
  if (TEMPLATE_CODES.has(code)) return "template_rejected";
  if (RECIPIENT_CODES.has(code)) return "recipient_unreachable";
  if (REQUEST_CODES.has(code)) return "invalid_request";
  return "provider_rejected";
}

export function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header || !/^[0-9]{1,6}$/.test(header.trim())) return null;
  return Math.min(Number(header.trim()) * 1000, RETRY_AFTER_CAP_MS);
}

function errorCodeOf(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" && Number.isInteger(code) && code >= 0 && code < 1e9
    ? code
    : null;
}

/** A body that carries anything shaped like a created message or a resolved contact: it must not be read as a refusal. */
function looksCreated(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const { messages, contacts } = body as { messages?: unknown; contacts?: unknown };
  return (
    (Array.isArray(messages) && messages.length > 0) ||
    (Array.isArray(contacts) && contacts.length > 0) ||
    (messages !== undefined && messages !== null && !Array.isArray(messages))
  );
}

/** `body` is the parsed JSON, or undefined when the body was missing, too large or not JSON. */
export function classifyResponse(
  httpStatus: number,
  body: unknown,
  retryAfterHeader: string | null,
  options: { readonly throttleRetryVerified?: boolean } = {
    throttleRetryVerified: THROTTLE_RETRY_VERIFIED,
  },
): SendResult {
  const code = errorCodeOf(body);
  const providerErrorCode = code === null ? null : String(code);
  const hasError = typeof body === "object" && body !== null && "error" in body;
  const unknown = (reason: string): SendResult => ({ kind: "unknown", reason, httpStatus });

  if (httpStatus >= 200 && httpStatus < 300) {
    if (hasError) return unknown("contradictory_success_response");
    const messages =
      typeof body === "object" && body !== null
        ? (body as { messages?: unknown }).messages
        : undefined;
    const first =
      Array.isArray(messages) && messages.length === 1 ? (messages[0] as unknown) : undefined;
    const id =
      typeof first === "object" && first !== null ? (first as { id?: unknown }).id : undefined;
    if (typeof id === "string" && isIntactIdentifier(id, 512)) {
      const status = (first as { message_status?: unknown }).message_status;
      return {
        kind: "accepted",
        wamid: id,
        providerStatus: typeof status === "string" && status.length <= 64 ? status : null,
        httpStatus,
      };
    }
    return unknown("malformed_success_response");
  }

  const clientError = httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408;
  if (!clientError)
    return unknown(httpStatus >= 500 ? "provider_server_error" : "unexpected_status");
  // From here on only a well-formed, documented error object can establish a refusal or a throttle.
  if (code === null)
    return unknown(httpStatus === 429 ? "rate_limit_unrecognized" : "unrecognized_client_error");
  if (looksCreated(body)) return unknown("contradictory_error_response");

  if (httpStatus === 429) {
    if (ECOSYSTEM_CODES.has(code))
      return { kind: "rejected", reason: "ecosystem_limit", httpStatus, providerErrorCode };
    if (THROTTLE_CODES.has(code)) {
      // A well-formed, documented throttle. It is still not proof that no message was created, so unless that has been
      // verified (THROTTLE_RETRY_VERIFIED) it is terminal: UNKNOWN_OUTCOME, with the code kept for the operator.
      if (!options.throttleRetryVerified)
        return {
          kind: "unknown",
          reason: "rate_limited_semantics_unverified",
          httpStatus,
          providerErrorCode,
        };
      return {
        kind: "throttled",
        retryAfterMs: parseRetryAfter(retryAfterHeader),
        httpStatus,
        providerErrorCode,
      };
    }
    return unknown("rate_limit_unrecognized");
  }
  if (REJECTION_CODES.has(code))
    return { kind: "rejected", reason: rejectionReason(code), httpStatus, providerErrorCode };
  // A documented throttle code on a non-429 status, or any code we do not know: no proof that nothing was created.
  return unknown("unrecognized_client_error");
}

/**
 * A failure of the HTTP attempt itself. NOTHING here is proof that the message was not sent: an error code describes the last
 * thing that went wrong, which can be a later connection attempt, not the first request (the reproduced case: a server
 * received the full POST and answered 421, the client's own replay hit ECONNREFUSED, and the final error said "connection
 * refused"). The transport makes exactly one attempt and a failure after it began is UNKNOWN_OUTCOME, whatever the error says.
 * Only the transport's own pre-flight refusals (gates, credentials, payload) are `not_sent`, and they never reach this function.
 */
export function classifyTransportError(error: unknown): SendResult {
  const reason =
    error instanceof HttpAttemptError
      ? `transport_${error.kind}`
      : "transport_error_after_possible_send";
  return { kind: "unknown", reason, httpStatus: null };
}

export { MAX_RESPONSE_BYTES };
