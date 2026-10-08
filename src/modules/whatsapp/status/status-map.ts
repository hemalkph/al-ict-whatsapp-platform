import { isRecord } from "../parse";
import { PermanentWebhookError } from "../queue/errors";
import { sanitizeString } from "../sanitize";
import { parseProviderTimestamp } from "../time";

// Turns the stored, normalized STATUS envelope into what the status history needs: validated, sanitized and bounded. Pure
// (no database, no clock). Only the documented fields are read: statuses[].id (the wamid, opaque), .status, .timestamp and,
// for a failure, the first element of .errors[]. recipient_id / recipient_user_id are deliberately NOT read: a status is
// matched to a message by its wamid within the routed account, never by who the recipient is.

export const STATUS_LIMITS = { wamid: 512, errorCode: 64, errorMessage: 500 } as const;

export type MessageStatusValue = "SENT" | "DELIVERED" | "READ" | "FAILED";

/** The documented Meta statuses we mirror. `played` and unknown values are ignored at ingest and refused here. */
const MAPPED: Readonly<Record<string, MessageStatusValue>> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};

export type StatusObservation = {
  wamid: string;
  status: MessageStatusValue;
  /** The provider's own timestamp, unchanged. */
  occurredAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
};

const fail = (code: string): never => {
  throw new PermanentWebhookError(code);
};

/** Sanitized, bounded text or null. Error text is untrusted provider text: it is cut to the limit, never a reason to fail. */
function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = sanitizeString(value).trim();
  if (clean === "") return null;
  return Array.from(clean).slice(0, max).join("");
}

/** The first error of a failed status: its code and a short description. Everything else in `errors[]` is dropped. */
function readFirstError(errors: unknown): { code: string | null; message: string | null } {
  const first = Array.isArray(errors) ? errors.find(isRecord) : undefined;
  if (!first) return { code: null, message: null };
  const rawCode = first.code;
  const code =
    typeof rawCode === "number" && Number.isFinite(rawCode)
      ? String(Math.trunc(rawCode))
      : boundedText(rawCode, STATUS_LIMITS.errorCode);
  const details = isRecord(first.error_data) ? first.error_data.details : undefined;
  const message =
    boundedText(first.message, STATUS_LIMITS.errorMessage) ??
    boundedText(first.title, STATUS_LIMITS.errorMessage) ??
    boundedText(details, STATUS_LIMITS.errorMessage);
  return { code: code === null ? null : code.slice(0, STATUS_LIMITS.errorCode), message };
}

export function mapStatusEvent(payload: unknown): StatusObservation {
  if (!isRecord(payload) || !isRecord(payload.status)) return fail("invalid_event_payload");
  const raw = payload.status;
  const wamid = typeof raw.id === "string" ? sanitizeString(raw.id) : "";
  if (wamid === "" || wamid.length > STATUS_LIMITS.wamid) return fail("invalid_status");
  const status = typeof raw.status === "string" ? MAPPED[raw.status] : undefined;
  if (!status) return fail("unsupported_status");
  const occurredAt = parseProviderTimestamp(raw.timestamp);
  if (!occurredAt) return fail("invalid_timestamp");
  const error = status === "FAILED" ? readFirstError(raw.errors) : { code: null, message: null };
  return { wamid, status, occurredAt, errorCode: error.code, errorMessage: error.message };
}
