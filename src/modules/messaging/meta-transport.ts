import https from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { HTTP_TIMEOUT_MS, MAX_RESPONSE_BYTES } from "./policy";
import { classifyResponse, classifyTransportError } from "./classify";
import {
  HttpAttemptError,
  type OutboundTransport,
  type SendHooks,
  type SendRequest,
  type SendResult,
} from "./transport";
import { readOutboundConfig } from "./config";

// The ONLY file in the application that can make an HTTP request to Meta. It talks to one fixed host over HTTPS, builds the
// request from a typed SendRequest (never from browser text), uses the account's trusted phone_number_id, reads the access
// token from the variable NAMED by the account's credential_ref, bounds time and response size, and re-checks the live-send
// gates on EVERY call. The token is never stored, logged, put in a URL or returned.
//
// Request contract (Meta documentation, see docs/WHATSAPP_OUTBOUND_EVIDENCE.md):
//   POST https://graph.facebook.com/{version}/{phone-number-id}/messages   Authorization: Bearer {token}
//   {"messaging_product":"whatsapp","recipient_type":"individual","to":"<phone>"|"recipient":"<BSUID>","type":"text"|"template",...}
// BSUID addressing uses `recipient` and omits `to` (Meta: "set recipient to the user's BSUID ... and omit the to property"),
// but that page marks the feature "coming soon" and the message-API reference does not list `recipient`, so it needs its own
// explicit gate (WHATSAPP_BSUID_RECIPIENT_ENABLED) in addition to the two live-send gates.

const HOST = "https://graph.facebook.com";
const META_HOSTNAME = "graph.facebook.com";
const PHONE_NUMBER_ID = /^[0-9]{6,30}$/;
const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

type Env = Record<string, string | undefined>;

/** What one HTTP attempt produced. `body` is null when the response had no body or exceeded the size bound. */
export type HttpPostResult = {
  status: number;
  headers: { get(name: string): string | null };
  body: Uint8Array | null;
};
/**
 * ONE HTTP POST, exactly one attempt: no redirect is followed, nothing is replayed, no status triggers a second request, and
 * a failure after the attempt began rejects with HttpAttemptError. The destination is not an argument: it is fixed inside the
 * implementation (production: https://graph.facebook.com), only the path comes from the caller.
 */
export type HttpPost = (
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<HttpPostResult>;

type RequestFn = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

/**
 * The single-attempt HTTP implementation, over a Node `request` function (node:https in production, node:http only in the
 * local regression tests, which is why the request function and the target are parameters of THIS factory and never of a
 * send). Why not fetch: Node's fetch (undici) may transparently replay a request, for example on a 421 or after a connection
 * error, so one `fetch()` can put two POSTs on the wire and report the second one's connection error. `http(s).request` has
 * no redirect, retry or replay logic: it writes one request on one connection and reports what came back. `agent: false`
 * gives every call its own non-keep-alive connection, so there is no reused-socket ambiguity either.
 * TLS: node's defaults (certificate chain and hostname verification) are untouched; nothing here sets rejectUnauthorized.
 */
export function singleAttemptPost(
  requestImpl: RequestFn,
  target: {
    readonly protocol: "https:" | "http:";
    readonly hostname: string;
    readonly port?: number;
  },
  limits: { readonly timeoutMs: number; readonly maxBytes: number } = {
    timeoutMs: HTTP_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
  },
): HttpPost {
  return (url, init) =>
    new Promise<HttpPostResult>((resolve, reject) => {
      let settled = false;
      let request: ClientRequest | undefined;
      const onAbort = () => fail("aborted");
      const timer = setTimeout(() => fail("timeout"), limits.timeoutMs);
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        init.signal.removeEventListener("abort", onAbort);
        action();
      };
      const fail = (kind: HttpAttemptError["kind"]) =>
        settle(() => {
          request?.destroy();
          reject(new HttpAttemptError(kind));
        });
      init.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const body = Buffer.from(init.body, "utf8");
        request = requestImpl(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port,
            path: new URL(url).pathname,
            method: "POST",
            agent: false,
            headers: { ...init.headers, "Content-Length": String(body.byteLength) },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              if (settled) return;
              size += chunk.byteLength;
              if (size > limits.maxBytes) {
                settle(() => {
                  response.destroy();
                  resolve(result(response, null));
                });
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () =>
              settle(() => resolve(result(response, Buffer.concat(chunks)))),
            );
            response.on("error", () => fail("response_incomplete"));
            response.on("close", () => {
              if (!response.complete) fail("response_incomplete");
            });
          },
        );
        request.on("error", () => fail("network"));
        request.end(body);
      } catch {
        fail("network");
      }
    });
}

function result(response: IncomingMessage, body: Uint8Array | null): HttpPostResult {
  return {
    status: response.statusCode ?? 0,
    headers: {
      get: (name) => {
        const value = response.headers[name.toLowerCase()];
        return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
      },
    },
    body,
  };
}

/** Production: https://graph.facebook.com only. The URL's host is checked even though the implementation ignores it. */
export const postToMeta: HttpPost = (() => {
  const post = singleAttemptPost(https.request, { protocol: "https:", hostname: META_HOSTNAME });
  return (url, init) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== HOST || parsed.username || parsed.password)
        return Promise.reject(new HttpAttemptError("network"));
    } catch {
      return Promise.reject(new HttpAttemptError("network"));
    }
    return post(url, init);
  };
})();

export type MetaTransportOptions = {
  /** Read at every send, never cached. Production passes process.env. */
  readonly env: () => Env;
  /**
   * TEST SEAM ONLY. Production never passes it (a static test pins that no script does): the default is the fixed-host HTTPS
   * single-attempt implementation. A replacement can change how the bytes travel, not what the gates, credentials or URL path are.
   */
  readonly post?: HttpPost;
};

export function buildPayload(
  request: SendRequest,
  bsuidAllowed: boolean,
): Record<string, unknown> | null {
  const base: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
  };
  if (request.recipient.kind === "PHONE") base.to = request.recipient.id;
  else if (bsuidAllowed)
    base.recipient = request.recipient.id; // `to` is omitted
  else return null;
  const m = request.message;
  if (m.type === "text") {
    const payload: Record<string, unknown> = { ...base, type: "text", text: { body: m.body } };
    if (m.replyToWamid) payload.context = { message_id: m.replyToWamid };
    return payload;
  }
  return {
    ...base,
    type: "template",
    template: {
      name: m.name,
      language: { code: m.languageCode },
      ...(m.bodyParameters.length > 0
        ? {
            components: [
              {
                type: "body",
                parameters: m.bodyParameters.map((text) => ({ type: "text", text })),
              },
            ],
          }
        : {}),
    },
  };
}

function parseBody(body: Uint8Array | null): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
}

export class MetaTransport implements OutboundTransport {
  constructor(private readonly options: MetaTransportOptions) {}

  async send(request: SendRequest, signal: AbortSignal, hooks?: SendHooks): Promise<SendResult> {
    const env = this.options.env();
    const config = readOutboundConfig(env);
    // The gates are checked HERE, at the HTTP boundary, on every call, whatever started the process.
    if (!config.outboundEnabled) return { kind: "not_sent", reason: "outbound_disabled" };
    if (!config.liveSendEnabled) return { kind: "not_sent", reason: "live_send_disabled" };
    if (!config.graphApiVersion) return { kind: "not_sent", reason: "graph_version_unconfigured" };
    if (!PHONE_NUMBER_ID.test(request.phoneNumberId))
      return { kind: "not_sent", reason: "invalid_phone_number_id" };
    const credential = request.credentialRef;
    if (!credential || !CREDENTIAL_NAME.test(credential))
      return { kind: "not_sent", reason: "credential_not_configured" };
    const token = env[credential];
    if (!token || token.length < 16 || /[\s]/.test(token))
      return { kind: "not_sent", reason: "credential_unavailable" };
    const payload = buildPayload(request, config.bsuidRecipientEnabled);
    if (payload === null) return { kind: "not_sent", reason: "bsuid_recipient_not_enabled" };

    if (signal.aborted) return { kind: "not_sent", reason: "aborted_before_http" };

    const url = `${HOST}/${config.graphApiVersion}/${request.phoneNumberId}/messages`;
    // From here on an HTTP attempt exists. The dispatcher is told first, and no result can read as "not sent" after this.
    hooks?.httpStarted();
    try {
      const response = await (this.options.post ?? postToMeta)(url, {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal,
      });
      return classifyResponse(
        response.status,
        parseBody(response.body),
        response.headers.get("retry-after"),
      );
    } catch (error) {
      return classifyTransportError(error);
    }
  }
}
