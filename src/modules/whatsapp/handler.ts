import type { Database } from "@/db";
import {
  BodyTooLargeError,
  MAX_WEBHOOK_BODY_BYTES,
  declaredContentLength,
  readBoundedBody,
} from "./body";
import { WebhookConfigError, readAppSecret, readVerifyToken } from "./config";
import { ingestVerifiedDelivery, type IngestDeps } from "./ingest";
import { emitWebhookLog } from "./logging";
import { classifySignatureHeader, verifyWebhookSignature } from "./signature";
import { checkVerification } from "./verification";

// The two HTTP entry points for /api/webhooks/whatsapp. No staff authentication (trust = verification token for GET,
// signature for POST). The POST path does exactly: read exact bytes -> verify signature -> persist the delivery and
// its per-item events -> acknowledge. It never processes anything.

export type WebhookDeps = IngestDeps & { db?: Database };

const reply = (status: number, headers: Record<string, string> = {}, body: string | null = null) =>
  new Response(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

// An oversized body is refused without reading it to the end. `Connection: close` makes the server drop the connection
// right after answering. Without it the connection (and the request) stays open for as long as the client keeps
// the rest of an upload we have already refused, tying it up until Node's much longer request timeout.
const tooLarge = () => reply(413, { Connection: "close" });

function configFailure(error: unknown): Response {
  if (error instanceof WebhookConfigError) {
    emitWebhookLog({
      event: "webhook.config_missing",
      outcome: "failure",
      reason: error.key.toLowerCase(),
    });
  } else {
    emitWebhookLog({ event: "webhook.config_missing", outcome: "failure", reason: "config_error" });
  }
  return reply(500); // fail closed, generic
}

export function handleWebhookGet(request: Request): Response {
  let token: string;
  try {
    token = readVerifyToken();
  } catch (error) {
    return configFailure(error);
  }
  const result = checkVerification(new URL(request.url).searchParams, token);
  if (!result.ok) {
    emitWebhookLog({
      event: "webhook.verification_failed",
      outcome: "denied",
      reason: result.reason,
    });
    return reply(403);
  }
  emitWebhookLog({ event: "webhook.verification_succeeded", outcome: "success" });
  return reply(
    200,
    { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
    result.challenge,
  );
}

export async function handleWebhookPost(
  request: Request,
  deps: WebhookDeps = {},
): Promise<Response> {
  const started = performance.now();
  let secret: string;
  try {
    secret = readAppSecret();
  } catch (error) {
    return configFailure(error);
  }

  const declared = declaredContentLength(request.headers);
  if (declared !== null && declared > MAX_WEBHOOK_BODY_BYTES) {
    emitWebhookLog({
      event: "webhook.body_too_large",
      outcome: "denied",
      reason: "declared_length",
    });
    return tooLarge();
  }

  let body: Uint8Array;
  try {
    body = await readBoundedBody(request.body);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      emitWebhookLog({
        event: "webhook.body_too_large",
        outcome: "denied",
        reason: "streamed_length",
      });
      return tooLarge();
    }
    emitWebhookLog({
      event: "webhook.request_unprocessable",
      outcome: "failure",
      reason: "body_read_failed",
    });
    return reply(400); // the client went away mid-body; nothing was stored
  }

  const header = request.headers.get("x-hub-signature-256");
  const state = classifySignatureHeader(header);
  const verified = state === "well_formed" && verifyWebhookSignature(body, header!, secret);
  if (!verified) {
    emitWebhookLog({
      event: "webhook.signature_invalid",
      outcome: "denied",
      reason: state === "well_formed" ? "signature_mismatch" : `${state}_header`,
      bodyBytes: body.byteLength,
    });
    return reply(403); // nothing is stored for an unverified delivery
  }

  try {
    const outcome = await ingestVerifiedDelivery(body, deps);
    const durationMs = performance.now() - started;
    if (outcome.ingestStatus === "ACCEPTED") {
      emitWebhookLog({
        event: "webhook.request_accepted",
        outcome: "success",
        requestId: outcome.requestId,
        ingestStatus: outcome.ingestStatus,
        bodyBytes: body.byteLength,
        durationMs,
        counts: outcome.counts,
      });
    } else {
      emitWebhookLog({
        event:
          outcome.ingestStatus === "EVENTS_REJECTED"
            ? "webhook.events_rejected"
            : "webhook.request_unprocessable",
        outcome: "failure",
        requestId: outcome.requestId,
        ingestStatus: outcome.ingestStatus,
        reason: outcome.ingestErrorCode ?? undefined,
        bodyBytes: body.byteLength,
        durationMs,
      });
    }
    return reply(200); // acknowledge: stored (or deliberately retained and flagged); never retried for a deterministic problem
  } catch {
    emitWebhookLog({
      event: "webhook.ingest_failed",
      outcome: "failure",
      reason: "storage_failed",
      bodyBytes: body.byteLength,
      durationMs: performance.now() - started,
    });
    return reply(500); // could not durably record the delivery: Meta retries
  }
}
