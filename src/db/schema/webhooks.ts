import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, oneOf, pk, tz } from "./_shared";
import { WEBHOOK_EVENT_STATUSES } from "./enums";
import { whatsappAccounts } from "./whatsapp";

/**
 * One row per signature-verified HTTP delivery. Delivery-level data only: no organization or account
 * (one delivery can carry several entries/changes). Invalid signatures are rejected before storage.
 */
export const webhookRequests = pgTable(
  "webhook_requests",
  {
    id: pk(),
    receivedAt: tz("received_at").notNull().defaultNow(),
    rawPayload: jsonb("raw_payload").notNull(),
    payloadSha256: text("payload_sha256").notNull(), // informational; deliberately not unique
    createdAt: createdAt(),
  },
  (t) => [index("webhook_requests_received_at_idx").on(t.receivedAt)],
);

/** One row per normalized item; the PostgreSQL-backed inbox/queue (ADR 0006). */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: pk(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => webhookRequests.id),
    // Nullable until routed by whatsapp_accounts.phone_number_id; both set or both null.
    organizationId: uuid("organization_id"),
    whatsappAccountId: uuid("whatsapp_account_id"),
    eventType: text("event_type").notNull(),
    providerObjectId: text("provider_object_id"),
    idempotencyKey: text("idempotency_key")
      .notNull()
      .unique("webhook_events_idempotency_key_unique"),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: WEBHOOK_EVENT_STATUSES }).notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tz("next_attempt_at").notNull().defaultNow(),
    lockedAt: tz("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"), // sanitized; never tokens
    processedAt: tz("processed_at"),
    receivedAt: tz("received_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    // FK target so business rows can only reference webhook events routed to their own organization.
    // (Unrouted events have a NULL organization_id and therefore can never be referenced.)
    unique("webhook_events_org_id_unique").on(t.organizationId, t.id),
    foreignKey({
      name: "webhook_events_org_account_fk",
      columns: [t.organizationId, t.whatsappAccountId],
      foreignColumns: [whatsappAccounts.organizationId, whatsappAccounts.id],
    }),
    check(
      "webhook_events_routing_check",
      sql`(${t.organizationId} IS NULL) = (${t.whatsappAccountId} IS NULL)`,
    ),
    check("webhook_events_status_check", oneOf(t.status, WEBHOOK_EVENT_STATUSES)),
    index("webhook_events_queue_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} IN ('PENDING', 'FAILED')`),
    // Reclaim path: PROCESSING rows whose lease (locked_at) has expired.
    index("webhook_events_lease_idx")
      .on(t.lockedAt)
      .where(sql`${t.status} = 'PROCESSING'`),
    index("webhook_events_request_idx").on(t.requestId),
    index("webhook_events_status_received_idx").on(t.status, t.receivedAt),
    index("webhook_events_org_received_idx").on(t.organizationId, t.receivedAt),
  ],
);
