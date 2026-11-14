import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizationMemberships } from "./access";
import { botSessions } from "./bots";
import { createdAt, oneOf, pk, tz, updatedAt } from "./_shared";
import {
  OUTBOUND_MESSAGE_TYPES,
  OUTBOUND_ORIGINS,
  OUTBOUND_REQUEST_STATES,
  RECIPIENT_KINDS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_STATUSES,
} from "./enums";
import { conversations, messages } from "./messaging";
import { orgId } from "./organizations";
import { whatsappAccounts } from "./whatsapp";

/**
 * Message templates this platform may send, per WhatsApp account. A row is a registration made by an operator; nothing here
 * is fetched from Meta (no Graph call exists), so `APPROVED` is an operator's attestation (attested_at), never a verified
 * fact. Staff cannot create or change rows.
 */
export const whatsappTemplates = pgTable(
  "whatsapp_templates",
  {
    id: pk(),
    organizationId: orgId(),
    whatsappAccountId: uuid("whatsapp_account_id").notNull(),
    name: text("name").notNull(),
    languageCode: text("language_code").notNull(),
    category: text("category", { enum: TEMPLATE_CATEGORIES }).notNull(),
    status: text("status", { enum: TEMPLATE_STATUSES }).notNull().default("PENDING_ATTESTATION"),
    // Number of {{n}} text parameters of the BODY component. Only body text parameters are supported in Phase 05.
    bodyParameterCount: smallint("body_parameter_count").notNull().default(0),
    attestedAt: tz("attested_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "whatsapp_templates_org_account_fk",
      columns: [t.organizationId, t.whatsappAccountId],
      foreignColumns: [whatsappAccounts.organizationId, whatsappAccounts.id],
    }),
    unique("whatsapp_templates_org_account_name_lang_unique").on(
      t.organizationId,
      t.whatsappAccountId,
      t.name,
      t.languageCode,
    ),
    // FK targets: a request proves its template belongs to the same organization AND WhatsApp account.
    unique("whatsapp_templates_org_id_unique").on(t.organizationId, t.id),
    unique("whatsapp_templates_org_id_account_unique").on(
      t.organizationId,
      t.id,
      t.whatsappAccountId,
    ),
    check(
      "whatsapp_templates_name_check",
      sql`char_length(${t.name}) BETWEEN 1 AND 512 AND ${t.name} ~ '^[a-z0-9_]+$'`,
    ),
    check(
      "whatsapp_templates_language_check",
      sql`${t.languageCode} ~ '^[a-z]{2,3}(_[A-Za-z]{2,4})?$'`,
    ),
    check("whatsapp_templates_category_check", oneOf(t.category, TEMPLATE_CATEGORIES)),
    check("whatsapp_templates_status_check", oneOf(t.status, TEMPLATE_STATUSES)),
    check("whatsapp_templates_params_check", sql`${t.bodyParameterCount} BETWEEN 0 AND 20`),
    check(
      "whatsapp_templates_attested_check",
      sql`${t.status} <> 'APPROVED' OR ${t.attestedAt} IS NOT NULL`,
    ),
  ],
);

/**
 * One outbound send and its dispatch lifecycle, requested by a member (origin STAFF) or, from Phase 08D, by the bot runtime for
 * one session step (origin BOT; ADR 0020). The logical message is the `messages` row (direction
 * OUTBOUND, wamid NULL until Meta accepts); this row carries what the message row must not: who asked, the idempotency
 * key, the exact recipient, and where the send is in its lifecycle. Provider delivery state is NOT stored here: it comes
 * from message_status_events through the existing STATUS pipeline. No access token is ever stored.
 */
export const outboundRequests = pgTable(
  "outbound_requests",
  {
    id: pk(),
    organizationId: orgId(),
    whatsappAccountId: uuid("whatsapp_account_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    messageId: uuid("message_id").notNull(),
    // STAFF: the requesting member. BOT: NULL (the shape CHECK below enforces which).
    requestedByMembershipId: uuid("requested_by_membership_id"),
    // Client-chosen, scoped to (organization, account, requesting membership); see outbound_requests_idempotency_unique.
    idempotencyKey: text("idempotency_key").notNull(),
    // sha256 (hex) of the canonical request; the same key with a different fingerprint is a conflict, never a second send.
    requestFingerprint: text("request_fingerprint").notNull(),
    messageType: text("message_type", { enum: OUTBOUND_MESSAGE_TYPES }).notNull(),
    templateId: uuid("template_id"),
    // The exact provider identifier the request will be sent to (a BSUID or a phone-based id), never cut or cleaned.
    recipientKind: text("recipient_kind", { enum: RECIPIENT_KINDS }).notNull(),
    recipientId: text("recipient_id").notNull(),
    // Sanitized content spec: TEXT {body, replyToWamid?}; TEMPLATE {parameters: string[]}; INTERACTIVE the versioned
    // InteractivePayload of messaging/interactive.ts (stored identically on the message row).
    payload: jsonb("payload").notNull(),
    state: text("state", { enum: OUTBOUND_REQUEST_STATES }).notNull().default("QUEUED"),
    holdReason: text("hold_reason"),
    failureCode: text("failure_code"),
    providerHttpStatus: integer("provider_http_status"),
    providerErrorCode: text("provider_error_code"),
    providerMessageStatus: text("provider_message_status"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: tz("next_attempt_at").notNull().defaultNow(),
    dispatchDeadline: tz("dispatch_deadline").notNull(),
    claimedBy: text("claimed_by"),
    claimedAt: tz("claimed_at"),
    // Set in the SAME transaction that moves QUEUED to SENDING, BEFORE any network I/O. From here on the send may have happened.
    sendStartedAt: tz("send_started_at"),
    acceptedAt: tz("accepted_at"),
    finishedAt: tz("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Phase 08D (ADR 0020). Immutable after insert (guard). control_seq is allocated by the database on insert (V3.2 J.1).
    origin: text("origin", { enum: OUTBOUND_ORIGINS }).notNull().default("STAFF"),
    botSessionId: uuid("bot_session_id"),
    botStepSeq: integer("bot_step_seq"),
    botSendEpoch: bigint("bot_send_epoch", { mode: "number" }),
    controlSeq: bigint("control_seq", { mode: "number" }),
  },
  (t) => [
    foreignKey({
      name: "outbound_requests_org_account_fk",
      columns: [t.organizationId, t.whatsappAccountId],
      foreignColumns: [whatsappAccounts.organizationId, whatsappAccounts.id],
    }),
    // The conversation belongs to this organization AND WhatsApp account (the contact is reached through it).
    foreignKey({
      name: "outbound_requests_org_conversation_account_fk",
      columns: [t.organizationId, t.conversationId, t.whatsappAccountId],
      foreignColumns: [
        conversations.organizationId,
        conversations.id,
        conversations.whatsappAccountId,
      ],
    }),
    foreignKey({
      name: "outbound_requests_org_message_account_fk",
      columns: [t.organizationId, t.messageId, t.whatsappAccountId],
      foreignColumns: [messages.organizationId, messages.id, messages.whatsappAccountId],
    }),
    foreignKey({
      name: "outbound_requests_org_member_fk",
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
    }),
    foreignKey({
      name: "outbound_requests_org_template_account_fk",
      columns: [t.organizationId, t.templateId, t.whatsappAccountId],
      foreignColumns: [
        whatsappTemplates.organizationId,
        whatsappTemplates.id,
        whatsappTemplates.whatsappAccountId,
      ],
    }),
    unique("outbound_requests_idempotency_unique").on(
      t.organizationId,
      t.whatsappAccountId,
      t.requestedByMembershipId,
      t.idempotencyKey,
    ),
    unique("outbound_requests_org_message_unique").on(t.organizationId, t.messageId),
    // A BOT request belongs to one session of the same organization, conversation and account (MATCH SIMPLE: skipped for STAFF).
    foreignKey({
      name: "outbound_requests_bot_session_fk",
      columns: [t.organizationId, t.botSessionId, t.conversationId, t.whatsappAccountId],
      foreignColumns: [
        botSessions.organizationId,
        botSessions.id,
        botSessions.conversationId,
        botSessions.whatsappAccountId,
      ],
    }),
    // One request per session step; one in-flight BOT request per session and per conversation (V3.2 K.8).
    uniqueIndex("outbound_requests_bot_step_uidx")
      .on(t.organizationId, t.botSessionId, t.botStepSeq)
      .where(sql`${t.origin} = 'BOT'`),
    uniqueIndex("outbound_requests_bot_inflight_uidx")
      .on(t.organizationId, t.botSessionId)
      .where(sql`${t.origin} = 'BOT' AND ${t.state} IN ('QUEUED', 'SENDING')`),
    uniqueIndex("outbound_requests_bot_conv_inflight_uidx")
      .on(t.organizationId, t.conversationId)
      .where(sql`${t.origin} = 'BOT' AND ${t.state} IN ('QUEUED', 'SENDING')`),
    index("outbound_requests_staff_control_idx")
      .on(t.organizationId, t.conversationId, t.controlSeq)
      .where(sql`${t.origin} = 'STAFF'`),
    index("outbound_requests_queue_idx")
      .on(t.nextAttemptAt, t.id)
      .where(sql`${t.state} = 'QUEUED'`),
    index("outbound_requests_sending_idx")
      .on(t.sendStartedAt)
      .where(sql`${t.state} = 'SENDING'`),
    index("outbound_requests_state_idx").on(t.state, t.createdAt),
    index("outbound_requests_account_send_idx")
      .on(t.whatsappAccountId, t.sendStartedAt.desc())
      .where(sql`${t.sendStartedAt} IS NOT NULL`),
    index("outbound_requests_conversation_idx").on(t.organizationId, t.conversationId, t.createdAt),
    check("outbound_requests_state_check", oneOf(t.state, OUTBOUND_REQUEST_STATES)),
    check("outbound_requests_type_check", oneOf(t.messageType, OUTBOUND_MESSAGE_TYPES)),
    check("outbound_requests_recipient_kind_check", oneOf(t.recipientKind, RECIPIENT_KINDS)),
    check("outbound_requests_origin_check", oneOf(t.origin, OUTBOUND_ORIGINS)),
    // NULL-safe shape: each branch states every column explicitly, so a NULL BOT column makes both branches false.
    check(
      "outbound_requests_origin_shape_check",
      sql`(${t.origin} = 'STAFF' AND ${t.requestedByMembershipId} IS NOT NULL
            AND ${t.botSessionId} IS NULL AND ${t.botStepSeq} IS NULL AND ${t.botSendEpoch} IS NULL)
          OR (${t.origin} = 'BOT' AND ${t.requestedByMembershipId} IS NULL
            AND ${t.botSessionId} IS NOT NULL
            AND ${t.botStepSeq} IS NOT NULL AND ${t.botStepSeq} >= 1
            AND ${t.botSendEpoch} IS NOT NULL AND ${t.botSendEpoch} >= 1)`,
    ),
    // Bots never send templates; staff never send interactive messages.
    check(
      "outbound_requests_origin_type_check",
      sql`(${t.origin} <> 'BOT' OR ${t.messageType} IN ('TEXT', 'INTERACTIVE'))
        AND (${t.origin} <> 'STAFF' OR ${t.messageType} IN ('TEXT', 'TEMPLATE'))`,
    ),
    // A BOT request's idempotency key is derived from its session and step.
    check(
      "outbound_requests_bot_key_check",
      sql`(${t.origin} <> 'BOT' OR ${t.idempotencyKey} = 'bot-' || ${t.botSessionId}::text || '-' || ${t.botStepSeq}::text) IS TRUE`,
    ),
    check(
      "outbound_requests_idempotency_key_check",
      sql`char_length(${t.idempotencyKey}) BETWEEN 8 AND 128 AND ${t.idempotencyKey} ~ '^[A-Za-z0-9._:-]+$'`,
    ),
    check("outbound_requests_fingerprint_check", sql`${t.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      "outbound_requests_recipient_id_check",
      sql`char_length(${t.recipientId}) BETWEEN 1 AND 255`,
    ),
    check("outbound_requests_attempts_check", sql`${t.attemptCount} BETWEEN 0 AND 20`),
    check(
      "outbound_requests_codes_check",
      sql`(${t.holdReason} IS NULL OR ${t.holdReason} ~ '^[a-z0-9_]{1,64}$')
        AND (${t.failureCode} IS NULL OR ${t.failureCode} ~ '^[a-z0-9_]{1,64}$')
        AND (${t.providerErrorCode} IS NULL OR char_length(${t.providerErrorCode}) <= 64)
        AND (${t.providerMessageStatus} IS NULL OR char_length(${t.providerMessageStatus}) <= 64)`,
    ),
    // A template request names its template; a text request does not.
    check(
      "outbound_requests_template_check",
      sql`(${t.messageType} = 'TEMPLATE') = (${t.templateId} IS NOT NULL)`,
    ),
    // The lifecycle fields always agree with the state.
    check(
      "outbound_requests_lifecycle_check",
      sql`(${t.state} <> 'HELD' OR ${t.holdReason} IS NOT NULL)
        AND (${t.state} <> 'REJECTED' OR ${t.failureCode} IS NOT NULL)
        AND (${t.state} <> 'SENDING' OR (${t.claimedBy} IS NOT NULL AND ${t.sendStartedAt} IS NOT NULL))
        AND (${t.state} <> 'QUEUED' OR ${t.claimedBy} IS NULL)
        AND (${t.state} <> 'ACCEPTED' OR (${t.acceptedAt} IS NOT NULL AND ${t.sendStartedAt} IS NOT NULL))
        AND (${t.state} <> 'UNKNOWN_OUTCOME' OR ${t.sendStartedAt} IS NOT NULL)
        AND (${t.state} NOT IN ('ACCEPTED', 'REJECTED', 'HELD', 'UNKNOWN_OUTCOME') OR ${t.finishedAt} IS NOT NULL)`,
    ),
  ],
);
