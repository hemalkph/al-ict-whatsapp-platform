import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { contacts } from "./contacts";
import { createdAt, oneOf, pk, tz, updatedAt } from "./_shared";
import {
  ATTACHMENT_STORAGE_STATUSES,
  CONVERSATION_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES,
} from "./enums";
import { orgId } from "./organizations";
import { webhookEvents } from "./webhooks";
import { whatsappAccounts } from "./whatsapp";

export const conversations = pgTable(
  "conversations",
  {
    id: pk(),
    organizationId: orgId(),
    whatsappAccountId: uuid("whatsapp_account_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    status: text("status", { enum: CONVERSATION_STATUSES }).notNull().default("OPEN"),
    // Explicitly set from the message's actual occurred_at (no default); GREATEST on later updates.
    lastMessageAt: tz("last_message_at").notNull(),
    // Factual timestamp of the last inbound customer message. Window policy lives in app config.
    lastInboundAt: tz("last_inbound_at"),
    lastOutboundAt: tz("last_outbound_at"),
    resolvedAt: tz("resolved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("conversations_org_id_unique").on(t.organizationId, t.id),
    // FK target so messages can prove their account matches the conversation's account.
    unique("conversations_org_id_account_unique").on(t.organizationId, t.id, t.whatsappAccountId),
    unique("conversations_org_account_contact_unique").on(
      t.organizationId,
      t.whatsappAccountId,
      t.contactId,
    ),
    foreignKey({
      name: "conversations_org_account_fk",
      columns: [t.organizationId, t.whatsappAccountId],
      foreignColumns: [whatsappAccounts.organizationId, whatsappAccounts.id],
    }),
    foreignKey({
      name: "conversations_org_contact_fk",
      columns: [t.organizationId, t.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }),
    index("conversations_inbox_idx").on(
      t.organizationId,
      t.status,
      t.lastMessageAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index("conversations_account_inbox_idx").on(
      t.organizationId,
      t.whatsappAccountId,
      t.lastMessageAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index("conversations_org_contact_idx").on(t.organizationId, t.contactId),
    check("conversations_status_check", oneOf(t.status, CONVERSATION_STATUSES)),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: pk(),
    organizationId: orgId(),
    conversationId: uuid("conversation_id").notNull(),
    whatsappAccountId: uuid("whatsapp_account_id").notNull(),
    wamid: text("wamid"), // null until Meta accepts an outbound send
    direction: text("direction", { enum: MESSAGE_DIRECTIONS }).notNull(),
    type: text("type").notNull(), // app-level union with UNKNOWN fallback; intentionally no CHECK
    body: text("body"),
    content: jsonb("content"), // per-type structure, validated at write
    replyToMessageId: uuid("reply_to_message_id"),
    replyToWamid: text("reply_to_wamid"),
    occurredAt: tz("occurred_at").notNull(),
    // Cache of message_status_events; see MESSAGE_STATUS_PRIORITY. NULL = no status yet.
    latestStatus: text("latest_status", { enum: MESSAGE_STATUSES }),
    latestStatusAt: tz("latest_status_at"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"), // sanitized summary, not the raw provider payload
    clientRequestId: text("client_request_id"), // outbound send idempotency
    sourceWebhookEventId: uuid("source_webhook_event_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("messages_org_id_unique").on(t.organizationId, t.id),
    // FK target for the same-conversation reply integrity constraint.
    unique("messages_org_conversation_id_unique").on(t.organizationId, t.conversationId, t.id),
    // FK target so status events can prove their message belongs to the same WhatsApp account.
    unique("messages_org_id_account_unique").on(t.organizationId, t.id, t.whatsappAccountId),
    // Retention cleanup must first null source_webhook_event_id (app-controlled) before pruning events.
    foreignKey({
      name: "messages_org_source_webhook_event_fk",
      columns: [t.organizationId, t.sourceWebhookEventId],
      foreignColumns: [webhookEvents.organizationId, webhookEvents.id],
    }),
    foreignKey({
      name: "messages_org_conversation_account_fk",
      columns: [t.organizationId, t.conversationId, t.whatsappAccountId],
      foreignColumns: [
        conversations.organizationId,
        conversations.id,
        conversations.whatsappAccountId,
      ],
    }),
    foreignKey({
      name: "messages_reply_to_same_conversation_fk",
      columns: [t.organizationId, t.conversationId, t.replyToMessageId],
      foreignColumns: [t.organizationId, t.conversationId, t.id],
    }),
    uniqueIndex("messages_account_wamid_uidx")
      .on(t.organizationId, t.whatsappAccountId, t.wamid)
      .where(sql`${t.wamid} IS NOT NULL`),
    uniqueIndex("messages_client_request_uidx")
      .on(t.organizationId, t.clientRequestId)
      .where(sql`${t.clientRequestId} IS NOT NULL`),
    index("messages_timeline_idx").on(
      t.conversationId,
      t.occurredAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    check("messages_direction_check", oneOf(t.direction, MESSAGE_DIRECTIONS)),
    check(
      "messages_latest_status_check",
      sql`${t.latestStatus} IS NULL OR ${oneOf(t.latestStatus, MESSAGE_STATUSES)}`,
    ),
  ],
);

/** Append-only and authoritative. messages.latest_status is only a cache derived from these rows. */
export const messageStatusEvents = pgTable(
  "message_status_events",
  {
    id: pk(),
    organizationId: orgId(),
    whatsappAccountId: uuid("whatsapp_account_id").notNull(),
    // Nullable: a status can arrive before the outbound message row commits; resolved by wamid later.
    messageId: uuid("message_id"),
    wamid: text("wamid").notNull(),
    status: text("status", { enum: MESSAGE_STATUSES }).notNull(),
    occurredAt: tz("occurred_at").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    webhookEventId: uuid("webhook_event_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "message_status_events_org_account_fk",
      columns: [t.organizationId, t.whatsappAccountId],
      foreignColumns: [whatsappAccounts.organizationId, whatsappAccounts.id],
    }),
    // If message_id is set, the message must be in the same organization AND WhatsApp account.
    foreignKey({
      name: "message_status_events_org_message_account_fk",
      columns: [t.organizationId, t.messageId, t.whatsappAccountId],
      foreignColumns: [messages.organizationId, messages.id, messages.whatsappAccountId],
    }),
    // Retention cleanup must first null webhook_event_id (app-controlled) before pruning events.
    foreignKey({
      name: "message_status_events_org_webhook_event_fk",
      columns: [t.organizationId, t.webhookEventId],
      foreignColumns: [webhookEvents.organizationId, webhookEvents.id],
    }),
    // Replay-safe; its leading (account, wamid) columns also serve late message_id resolution.
    unique("message_status_events_dedupe_unique").on(
      t.whatsappAccountId,
      t.wamid,
      t.status,
      t.occurredAt,
    ),
    index("message_status_events_message_idx").on(t.messageId, t.occurredAt),
    check("message_status_events_status_check", oneOf(t.status, MESSAGE_STATUSES)),
  ],
);

/** Metadata only. Binaries live in object storage (not integrated in this milestone). */
export const messageAttachments = pgTable(
  "message_attachments",
  {
    id: pk(),
    organizationId: orgId(),
    messageId: uuid("message_id").notNull(),
    metaMediaId: text("meta_media_id"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    filename: text("filename"),
    sha256: text("sha256"),
    storageKey: text("storage_key"),
    storageStatus: text("storage_status", { enum: ATTACHMENT_STORAGE_STATUSES })
      .notNull()
      .default("PENDING"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "message_attachments_org_message_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }),
    unique("message_attachments_message_media_unique").on(t.messageId, t.metaMediaId),
    index("message_attachments_org_message_idx").on(t.organizationId, t.messageId),
    index("message_attachments_pending_idx")
      .on(t.storageStatus)
      .where(sql`${t.storageStatus} = 'PENDING'`),
    check(
      "message_attachments_storage_status_check",
      oneOf(t.storageStatus, ATTACHMENT_STORAGE_STATUSES),
    ),
  ],
);
