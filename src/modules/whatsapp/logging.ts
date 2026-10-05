import { logger } from "@/shared/logging/logger";

// Fixed-field webhook logging, in the pattern of emitSecurityEvent: ONLY the fields below can ever be written, so a
// body, message text, name, phone number, wa_id, BSUID, token, App Secret, signature or header cannot be logged by
// construction. Provider ids appear only as short hashes (see idempotency.shortHash); `reason` must be a short fixed code.

export type WebhookLogEvent =
  | "webhook.verification_succeeded"
  | "webhook.verification_failed"
  | "webhook.config_missing"
  | "webhook.signature_invalid"
  | "webhook.body_too_large"
  | "webhook.request_unprocessable"
  | "webhook.request_accepted"
  | "webhook.events_rejected"
  | "webhook.ingest_failed";

export type WebhookCounts = {
  events?: number;
  inserted?: number;
  duplicates?: number;
  pending?: number;
  held?: number;
  ignored?: number;
  dead?: number;
};

export type WebhookLog = {
  event: WebhookLogEvent;
  outcome: "success" | "denied" | "failure";
  requestId?: string;
  organizationId?: string;
  whatsappAccountId?: string;
  eventType?: string;
  reason?: string;
  ingestStatus?: string;
  bodyBytes?: number;
  durationMs?: number;
  counts?: WebhookCounts;
};

const REASON = /^[a-z0-9_]{1,64}$/;

export function emitWebhookLog(e: WebhookLog): void {
  const counts = e.counts ?? {};
  const context = {
    webhook_event: e.event,
    outcome: e.outcome,
    request_id: e.requestId,
    organization_id: e.organizationId,
    whatsapp_account_id: e.whatsappAccountId,
    event_type: e.eventType,
    reason:
      e.reason === undefined ? undefined : REASON.test(e.reason) ? e.reason : "invalid_reason",
    ingest_status: e.ingestStatus,
    body_bytes: e.bodyBytes,
    duration_ms: e.durationMs === undefined ? undefined : Math.round(e.durationMs),
    count_events: counts.events,
    count_inserted: counts.inserted,
    count_duplicates: counts.duplicates,
    count_pending: counts.pending,
    count_held: counts.held,
    count_ignored: counts.ignored,
    count_dead: counts.dead,
  };
  if (e.event === "webhook.ingest_failed") logger.error("webhook", context);
  else if (e.outcome === "success") logger.info("webhook", context);
  else logger.warn("webhook", context);
}
