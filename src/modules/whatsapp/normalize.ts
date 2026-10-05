import { malformedKey, messageKey, otherKey, scopeOf, statusKey } from "./idempotency";
import { isRecord, type Envelope } from "./parse";
import { sanitizeJson } from "./sanitize";

// Turns a verified delivery into webhook_events candidates. One HTTP delivery can hold many entries, changes, messages
// and statuses; each message and each status becomes its OWN event, and anything else becomes an OTHER event. This
// step is pure: no database, no routing, no domain interpretation (that is the worker's job, later).

export type EventKind = "MESSAGE" | "STATUS" | "OTHER";
export type ContactPairing = "user_id" | "wa_id" | "none" | "conflict";

/** What the event is, before accounts are consulted. */
export type Intrinsic =
  { kind: "queue" } | { kind: "ignored"; reason: string } | { kind: "dead"; reason: string };

export type NormalizedEvent = {
  readonly eventType: EventKind;
  readonly wabaId: string | null;
  readonly phoneNumberId: string | null;
  readonly idempotencyKey: string;
  readonly providerObjectId: string | null;
  readonly payload: Record<string, unknown>;
  readonly intrinsic: Intrinsic;
  readonly pairing: ContactPairing | null;
};

const MIRRORED_STATUSES = new Set(["sent", "delivered", "read", "failed"]);
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Non-empty bounded text without control characters, else null. */
function text(value: unknown, max: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !CONTROL.test(value)
    ? value
    : null;
}

function timestampText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return text(value, 32);
}

/**
 * Pairs a message with ITS contacts[] element. Primary: messages[].from_user_id <-> contacts[].user_id. Fallback:
 * messages[].from <-> contacts[].wa_id. Never contacts[0], never array position. A matched element that contradicts
 * the message's own identifiers is dropped (the message keeps its identity; only the enrichment is lost).
 */
export function pairContact(
  message: Record<string, unknown>,
  contacts: unknown,
): { contact: Record<string, unknown> | null; pairing: ContactPairing } {
  const candidates = Array.isArray(contacts) ? contacts.filter(isRecord) : [];
  const fromUserId = typeof message.from_user_id === "string" ? message.from_user_id : null;
  const from = typeof message.from === "string" ? message.from : null;

  let match: Record<string, unknown> | undefined;
  let via: ContactPairing = "none";
  if (fromUserId) {
    match = candidates.find((c) => c.user_id === fromUserId);
    if (match) via = "user_id";
  }
  if (!match && from) {
    match = candidates.find((c) => c.wa_id === from);
    if (match) via = "wa_id";
  }
  if (!match) return { contact: null, pairing: "none" };

  const waContradicts = from !== null && typeof match.wa_id === "string" && match.wa_id !== from;
  const userContradicts =
    fromUserId !== null && typeof match.user_id === "string" && match.user_id !== fromUserId;
  if (waContradicts || userContradicts) return { contact: null, pairing: "conflict" };
  return { contact: match, pairing: via };
}

type Context = {
  wabaId: string | null;
  phoneNumberId: string | null;
  scope: string;
  field: string;
  metadata: unknown;
};

function eventPayload(ctx: Context, extra: Record<string, unknown>): Record<string, unknown> {
  return sanitizeJson({
    v: 1,
    wabaId: ctx.wabaId,
    field: ctx.field,
    metadata: ctx.metadata ?? null,
    ...extra,
  });
}

function other(ctx: Context, element: unknown, reason: string): NormalizedEvent {
  const payload = eventPayload(ctx, { element });
  return {
    eventType: "OTHER",
    wabaId: ctx.wabaId,
    phoneNumberId: ctx.phoneNumberId,
    idempotencyKey: otherKey(ctx.scope, payload.element),
    providerObjectId: null,
    payload,
    intrinsic: { kind: "ignored", reason },
    pairing: null,
  };
}

function malformed(ctx: Context, eventType: EventKind, element: unknown): NormalizedEvent {
  const payload = eventPayload(ctx, { element });
  return {
    eventType,
    wabaId: ctx.wabaId,
    phoneNumberId: ctx.phoneNumberId,
    idempotencyKey: malformedKey(ctx.scope, payload.element),
    providerObjectId: null,
    payload,
    intrinsic: { kind: "dead", reason: "malformed_event" },
    pairing: null,
  };
}

function normalizeMessage(ctx: Context, message: unknown, contacts: unknown): NormalizedEvent {
  if (!isRecord(message)) return malformed(ctx, "MESSAGE", message);
  const wamid = text(message.id, 512);
  if (!wamid) return malformed(ctx, "MESSAGE", message);

  // H1 is unresolved (docs.WHATSAPP_G0_EVIDENCE): identity-change system messages are not interpreted. Every system
  // message is preserved untouched as an IGNORED OTHER event so a later, reviewed handler can replay it explicitly.
  if (message.type === "system") return other(ctx, message, "system_message_pending_h1");

  const { contact, pairing } = pairContact(message, contacts);
  const payload = eventPayload(ctx, { contact, pairing, message });
  const grouped = typeof message.group_id === "string" && message.group_id !== "";
  return {
    eventType: "MESSAGE",
    wabaId: ctx.wabaId,
    phoneNumberId: ctx.phoneNumberId,
    idempotencyKey: messageKey(ctx.scope, wamid),
    providerObjectId: wamid,
    payload,
    intrinsic: grouped ? { kind: "ignored", reason: "group_unsupported" } : { kind: "queue" },
    pairing,
  };
}

function normalizeStatus(ctx: Context, status: unknown): NormalizedEvent {
  if (!isRecord(status)) return malformed(ctx, "STATUS", status);
  const wamid = text(status.id, 512);
  const state = text(status.status, 32);
  const timestamp = timestampText(status.timestamp);
  if (!wamid || !state || !timestamp) return malformed(ctx, "STATUS", status);
  return {
    eventType: "STATUS",
    wabaId: ctx.wabaId,
    phoneNumberId: ctx.phoneNumberId,
    idempotencyKey: statusKey(ctx.scope, wamid, state, timestamp),
    providerObjectId: wamid,
    payload: eventPayload(ctx, { status }),
    intrinsic: MIRRORED_STATUSES.has(state)
      ? { kind: "queue" }
      : { kind: "ignored", reason: "status_not_mirrored" },
    pairing: null,
  };
}

export function normalizeEnvelope(envelope: Envelope): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (const entry of envelope.entry) {
    const wabaId = text(entry.id, 64);
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (!isRecord(change)) continue;
      const value = isRecord(change.value) ? change.value : {};
      const metadata = isRecord(value.metadata) ? value.metadata : null;
      const phoneNumberId = text(metadata?.phone_number_id, 64);
      const field = typeof change.field === "string" ? change.field.slice(0, 64) : "";
      const ctx: Context = {
        wabaId,
        phoneNumberId,
        scope: scopeOf(phoneNumberId, wabaId),
        field,
        metadata,
      };

      if (field !== "messages") {
        events.push(other(ctx, change, "unsupported_field"));
        continue;
      }
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      for (const message of messages) events.push(normalizeMessage(ctx, message, value.contacts));
      for (const status of statuses) events.push(normalizeStatus(ctx, status));
      if (messages.length === 0 && statuses.length === 0)
        events.push(other(ctx, change, "unsupported_value"));
    }
  }
  return events;
}
