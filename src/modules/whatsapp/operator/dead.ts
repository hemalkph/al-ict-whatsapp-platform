import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { schema, type Database } from "@/db";
import { shortHash } from "../idempotency";
import { emitWebhookLog } from "../logging";
import { isRecord } from "../parse";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// OPERATOR-ONLY, READ-ONLY review of DEAD webhook events. By default nothing a customer wrote is shown: only queue
// state, a fixed reason code, its category, routing ids and a content-free description of the event ("a text message",
// "a read status"). The stored payload is printed only on an explicit request (and the request is logged). There is no
// replay here: re-queueing a DEAD event is a policy decision that has not been taken (see docs/RUNBOOK_WHATSAPP.md).

export type DeadCategory =
  | "invalid_provider_payload"
  | "retries_exhausted"
  | "ambiguous_identity"
  | "routing_inconsistent"
  | "permanent_failure";

const INVALID_PAYLOAD = new Set([
  "invalid_provider_identifier",
  "invalid_envelope",
  "invalid_event_payload",
  "invalid_message",
  "invalid_status",
  "invalid_timestamp",
  "unsupported_status",
  "not_a_message_event",
  "content_too_large",
  "malformed_event",
  "system_message_unsupported",
]);
const IDENTITY = new Set([
  "phone_only_identity_ambiguous",
  "invalid_sender_identity",
  "missing_sender_identity",
  "identity_conflict",
]);

export function classifyDead(reason: string | null): { category: DeadCategory; guidance: string } {
  const r = reason ?? "";
  if (INVALID_PAYLOAD.has(r))
    return {
      category: "invalid_provider_payload",
      guidance:
        "The provider payload failed validation. Replaying cannot help unless the parser was wrong; compare the shape with the sanitized fixtures and Meta's documentation.",
    };
  if (r.startsWith("max_attempts_exhausted") || r.startsWith("exhausted_"))
    return {
      category: "retries_exhausted",
      guidance:
        "Every attempt failed transiently. Find and fix the cause (database, deployment) first; handlers are idempotent, so a reviewed replay would be safe once that policy exists.",
    };
  if (IDENTITY.has(r))
    return {
      category: "ambiguous_identity",
      guidance:
        "The sender cannot be tied to one contact without guessing. Nothing was written. Resolve the identity manually; contacts are never merged automatically.",
    };
  if (r === "missing_routing" || r === "account_missing")
    return {
      category: "routing_inconsistent",
      guidance:
        "The event's routing no longer matches a WhatsApp account. Investigate the account records; do not re-home the event.",
    };
  return {
    category: "permanent_failure",
    guidance:
      "A handler reported a permanent failure. Check the reason code against the handler that raised it.",
  };
}

const REPLAY_POLICY =
  "Replay is not available. Re-queueing DEAD events needs a policy decision (see docs/RUNBOOK_WHATSAPP.md, 'DEAD events').";

export async function deadSummary(db: Database) {
  const rows = await db.execute<{
    reason: string | null;
    event_type: string;
    n: number;
    oldest: Date;
    newest: Date;
  }>(sql`
    SELECT last_error AS reason, event_type, count(*)::int AS n, min(received_at) AS oldest, max(received_at) AS newest
    FROM webhook_events WHERE status = 'DEAD'
    GROUP BY last_error, event_type ORDER BY n DESC, last_error
  `);
  return rows.rows.map((r) => ({
    reason: r.reason,
    category: classifyDead(r.reason).category,
    eventType: r.event_type,
    count: r.n,
    oldestReceivedAt: new Date(r.oldest).toISOString(),
    newestReceivedAt: new Date(r.newest).toISOString(),
  }));
}

export async function listDead(db: Database, options: { reason?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const conditions: SQL[] = [eq(schema.webhookEvents.status, "DEAD")];
  if (options.reason) conditions.push(eq(schema.webhookEvents.lastError, options.reason));
  const rows = await db
    .select({
      id: schema.webhookEvents.id,
      eventType: schema.webhookEvents.eventType,
      reason: schema.webhookEvents.lastError,
      attempts: schema.webhookEvents.attempts,
      receivedAt: schema.webhookEvents.receivedAt,
      organizationId: schema.webhookEvents.organizationId,
      accountId: schema.webhookEvents.whatsappAccountId,
    })
    .from(schema.webhookEvents)
    .where(and(...conditions))
    .orderBy(desc(schema.webhookEvents.receivedAt), schema.webhookEvents.id)
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    receivedAt: r.receivedAt.toISOString(),
    category: classifyDead(r.reason).category,
  }));
}

const KIND = /^[a-z_]{1,32}$/;
const word = (v: unknown) => (typeof v === "string" && KIND.test(v) ? v : null);

/** What kind of event this was, without any of its content: the Meta field, the message type or the status word. */
export function describeKind(payload: unknown): {
  field: string | null;
  messageType: string | null;
  statusWord: string | null;
} {
  if (!isRecord(payload)) return { field: null, messageType: null, statusWord: null };
  return {
    field: word(payload.field),
    messageType: isRecord(payload.message) ? word(payload.message.type) : null,
    statusWord: isRecord(payload.status) ? word(payload.status.status) : null,
  };
}

/**
 * Defense in depth for payload reveal: it is disabled unless WHATSAPP_ALLOW_PII_REVEAL is EXACTLY the string "true"
 * (unset, "false", "TRUE", "1", "yes", " true" and everything else mean disabled). This is NOT authentication or
 * authorization: it does not say WHO is revealing, and it replaces neither restricted execution permissions, a trusted
 * operator identity, durable audit logs nor authorization to read personal data. Payload reveal stays unapproved for real
 * customer data until those controls exist (docs/RUNBOOK_WHATSAPP.md). The variable's value is never logged or returned.
 */
export const PII_REVEAL_VARIABLE = "WHATSAPP_ALLOW_PII_REVEAL";
export const piiRevealEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  env[PII_REVEAL_VARIABLE] === "true";

export async function inspectDead(
  db: Database,
  eventId: string,
  options: { revealPayload?: boolean; env?: Record<string, string | undefined> } = {},
) {
  // Enforced here, before the database is touched, so no caller can reach a payload without the opt-in.
  if (options.revealPayload && !piiRevealEnabled(options.env)) {
    emitWebhookLog({
      event: "operator.payload_reveal_refused",
      outcome: "denied",
      webhookEventId: UUID.test(eventId) ? eventId : undefined,
      reason: "pii_reveal_disabled",
    });
    return {
      ok: false as const,
      refused: "pii_reveal_disabled",
      detail: `Revealing a payload is disabled. It needs ${PII_REVEAL_VARIABLE}=true in the environment, and it is unapproved for real customer data (see docs/RUNBOOK_WHATSAPP.md). Nothing was read.`,
    };
  }
  const [row] = await db
    .select({
      event: schema.webhookEvents,
      payloadBytes: sql<number>`pg_column_size(${schema.webhookEvents.payload})`,
    })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.id, eventId));
  if (!row) return { ok: false as const, refused: "event_not_found" };
  const e = row.event;
  if (e.status !== "DEAD")
    return { ok: false as const, refused: "event_not_dead", detail: `status is ${e.status}` };
  if (options.revealPayload)
    emitWebhookLog({
      event: "operator.payload_revealed",
      outcome: "success",
      webhookEventId: e.id,
      organizationId: e.organizationId ?? undefined,
    });
  return {
    ok: true as const,
    event: {
      id: e.id,
      eventType: e.eventType,
      reason: e.lastError,
      ...classifyDead(e.lastError),
      attempts: e.attempts,
      receivedAt: e.receivedAt.toISOString(),
      organizationId: e.organizationId,
      accountId: e.whatsappAccountId,
      providerObjectIdHash: e.providerObjectId ? shortHash(e.providerObjectId) : null,
      ...describeKind(e.payload),
      payloadBytes: row.payloadBytes,
    },
    replay: REPLAY_POLICY,
    payload: options.revealPayload
      ? {
          warning:
            "UNAPPROVED FOR REAL CUSTOMER DATA. This is personal data. Nothing records WHICH person ran this command, and a log line is not an accountable audit trail. Do not copy it into tickets, chats or logs.",
          value: e.payload,
        }
      : "hidden (pass --reveal-payload to print it; the request is logged)",
  };
}
