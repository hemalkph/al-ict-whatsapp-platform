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
import { createdAt, oneOf, pk, tz, updatedAt } from "./_shared";
import {
  BOT_DEPLOYMENT_EVENT_KINDS,
  BOT_DEPLOYMENT_STATUSES,
  BOT_FLOW_END_REASONS,
  BOT_FLOW_HANDOVER_REASONS,
  BOT_LIVE_SESSION_STATES,
  BOT_SESSION_END_REASONS,
  BOT_SESSION_EVENT_KINDS,
  BOT_SESSION_STATES,
  BOT_TERMINAL_SESSION_STATES,
  BOT_TRIGGER_STATUSES,
} from "./enums";
import { conversations, messages } from "./messaging";
import { orgId } from "./organizations";
import { whatsappAccounts } from "./whatsapp";

// Phase 08C (ADR 0019, V3.2 section K). Organization-scoped tables with composite foreign keys that prove whole
// relationships (a session's conversation, account, contact, messages, bot, version and deployment all agree), text + CHECK
// for constrained values, and NULL-safe state CHECKs: every state-dependent rule is written `(...) IS TRUE` or uses NOT NULL
// columns, because PostgreSQL accepts a CHECK that evaluates to NULL. The lifecycle guards, the control-sequence allocation
// and the privacy redaction are hand-written triggers and functions at the end of migration 0007 (Drizzle does not model
// them).

/** The exact flow-contract size (ADR 0017): UTF-8 bytes of the canonical JSON. Stored canonical text is measured, never jsonb. */
const CANONICAL_BYTES_MAX = 65536;
const CODE = "'^[a-z0-9_]{1,64}$'";
const TOKEN = "'^[A-Za-z0-9_-]{22}$'";
const NODE_ID = "'^[a-z][a-z0-9_]{0,31}$'";

/** A bot and its one mutable draft (V3.2 K.1; the draft is canonical JSON text, ADR 0019 amendment of K.1). */
export const bots = pgTable(
  "bots",
  {
    id: pk(),
    organizationId: orgId(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // Canonical (RFC 8785) JSON text written by the application; NULL until a draft is saved. Not necessarily a valid flow.
    draftConfigCanonical: text("draft_config_canonical"),
    draftRevision: integer("draft_revision").notNull().default(0),
    draftUpdatedByMembershipId: uuid("draft_updated_by_membership_id"),
    draftUpdatedAt: tz("draft_updated_at"),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    archivedAt: tz("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("bots_org_id_unique").on(t.organizationId, t.id),
    unique("bots_org_key_unique").on(t.organizationId, t.key),
    foreignKey({
      name: "bots_org_creator_fk",
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
    }),
    foreignKey({
      name: "bots_org_draft_updater_fk",
      columns: [t.organizationId, t.draftUpdatedByMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
    }),
    check("bots_key_check", sql`${t.key} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check(
      "bots_name_check",
      sql`char_length(${t.name}) BETWEEN 1 AND 100 AND btrim(${t.name}) <> ''`,
    ),
    check(
      "bots_description_check",
      sql`${t.description} IS NULL OR char_length(${t.description}) <= 500`,
    ),
    check(
      "bots_draft_size_check",
      sql`${t.draftConfigCanonical} IS NULL OR octet_length(${t.draftConfigCanonical}) <= ${sql.raw(String(CANONICAL_BYTES_MAX))}`,
    ),
    check("bots_draft_revision_check", sql`${t.draftRevision} >= 0`),
    check(
      "bots_draft_shape_check",
      sql`((${t.draftConfigCanonical} IS NULL) = (${t.draftUpdatedAt} IS NULL)
        AND (${t.draftUpdatedAt} IS NULL) = (${t.draftUpdatedByMembershipId} IS NULL)) IS TRUE`,
    ),
  ],
);

/** A published, immutable version (V3.2 K.2): canonical text, the equal jsonb and the SHA-256 of the canonical UTF-8 bytes. */
export const botVersions = pgTable(
  "bot_versions",
  {
    id: pk(),
    organizationId: orgId(),
    botId: uuid("bot_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    config: jsonb("config").notNull(),
    configCanonical: text("config_canonical").notNull(),
    configSha256: text("config_sha256").notNull(),
    publishedByMembershipId: uuid("published_by_membership_id").notNull(),
    // Stamped by the database (the insert trigger), never by the application.
    publishedAt: tz("published_at")
      .notNull()
      .default(sql`clock_timestamp()`),
    changeNote: text("change_note"),
  },
  (t) => [
    unique("bot_versions_org_id_unique").on(t.organizationId, t.id),
    unique("bot_versions_org_bot_id_unique").on(t.organizationId, t.botId, t.id),
    unique("bot_versions_org_bot_number_unique").on(t.organizationId, t.botId, t.versionNumber),
    foreignKey({
      name: "bot_versions_org_bot_fk",
      columns: [t.organizationId, t.botId],
      foreignColumns: [bots.organizationId, bots.id],
    }),
    foreignKey({
      name: "bot_versions_org_publisher_fk",
      columns: [t.organizationId, t.publishedByMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
    }),
    check("bot_versions_number_check", sql`${t.versionNumber} >= 1`),
    check("bot_versions_schema_version_check", sql`${t.schemaVersion} = 1`),
    check("bot_versions_config_object_check", sql`jsonb_typeof(${t.config}) = 'object'`),
    check(
      "bot_versions_canonical_size_check",
      sql`octet_length(${t.configCanonical}) BETWEEN 2 AND ${sql.raw(String(CANONICAL_BYTES_MAX))}`,
    ),
    check("bot_versions_sha256_check", sql`${t.configSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "bot_versions_change_note_check",
      sql`${t.changeNote} IS NULL OR char_length(${t.changeNote}) <= 500`,
    ),
  ],
);

/** A bot deployed on one WhatsApp account (V3.2 K.3). RETIRED rows are immutable and release their uniqueness slots. */
export const botDeployments = pgTable(
  "bot_deployments",
  {
    id: pk(),
    organizationId: orgId(),
    whatsappAccountId: uuid("whatsapp_account_id").notNull(),
    botId: uuid("bot_id").notNull(),
    versionId: uuid("version_id").notNull(),
    status: text("status", { enum: BOT_DEPLOYMENT_STATUSES }).notNull().default("ACTIVE"),
    priority: smallint("priority").notNull(),
    sendEpoch: bigint("send_epoch", { mode: "number" }).notNull().default(1),
    // The three times below are stamped by the database (the deployment guard), never by the application.
    startEligibleFrom: tz("start_eligible_from")
      .notNull()
      .default(sql`clock_timestamp()`),
    statusChangedAt: tz("status_changed_at")
      .notNull()
      .default(sql`clock_timestamp()`),
    activatedAt: tz("activated_at")
      .notNull()
      .default(sql`clock_timestamp()`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("bot_deployments_org_id_unique").on(t.organizationId, t.id),
    // FK target proving a session's (or event's) deployment serves that bot on that account.
    unique("bot_deployments_org_id_account_bot_unique").on(
      t.organizationId,
      t.id,
      t.whatsappAccountId,
      t.botId,
    ),
    uniqueIndex("bot_deployments_account_bot_uidx")
      .on(t.organizationId, t.whatsappAccountId, t.botId)
      .where(sql`${t.status} <> 'RETIRED'`),
    uniqueIndex("bot_deployments_account_priority_uidx")
      .on(t.organizationId, t.whatsappAccountId, t.priority)
      .where(sql`${t.status} <> 'RETIRED'`),
    foreignKey({
      name: "bot_deployments_org_account_fk",
      columns: [t.organizationId, t.whatsappAccountId],
      foreignColumns: [whatsappAccounts.organizationId, whatsappAccounts.id],
    }),
    foreignKey({
      name: "bot_deployments_org_bot_fk",
      columns: [t.organizationId, t.botId],
      foreignColumns: [bots.organizationId, bots.id],
    }),
    // The deployed version belongs to the deployed bot.
    foreignKey({
      name: "bot_deployments_org_bot_version_fk",
      columns: [t.organizationId, t.botId, t.versionId],
      foreignColumns: [botVersions.organizationId, botVersions.botId, botVersions.id],
    }),
    check("bot_deployments_status_check", oneOf(t.status, BOT_DEPLOYMENT_STATUSES)),
    check("bot_deployments_priority_check", sql`${t.priority} BETWEEN 1 AND 1000`),
    check("bot_deployments_epoch_check", sql`${t.sendEpoch} >= 1`),
  ],
);

/** Append-only history of deployment operations (V3.2 K.4). */
export const botDeploymentEvents = pgTable(
  "bot_deployment_events",
  {
    id: pk(),
    organizationId: orgId(),
    deploymentId: uuid("deployment_id").notNull(),
    whatsappAccountId: uuid("whatsapp_account_id").notNull(),
    botId: uuid("bot_id").notNull(),
    kind: text("kind", { enum: BOT_DEPLOYMENT_EVENT_KINDS }).notNull(),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    fromVersionId: uuid("from_version_id"),
    toVersionId: uuid("to_version_id"),
    fromStatus: text("from_status", { enum: BOT_DEPLOYMENT_STATUSES }),
    toStatus: text("to_status", { enum: BOT_DEPLOYMENT_STATUSES }).notNull(),
    sendEpoch: bigint("send_epoch", { mode: "number" }).notNull(),
    sessionsAffected: integer("sessions_affected").notNull().default(0),
    // BOT requests this operation itself moved QUEUED -> HELD (Phase 08D suppression primitive; 0 before 08D).
    requestsSuppressed: integer("requests_suppressed").notNull().default(0),
    // BOT requests of the affected sessions still QUEUED or SENDING in the snapshot of the operation's count statement (taken
    // after its hold statement), terminal notices included. NOT a count of HTTP attempts or Meta acceptances, and not a promise
    // that they stay unsent: the dispatcher's fences hold most of them; one already past its final authorization may be sent.
    requestsInFlight: integer("requests_in_flight").notNull().default(0),
    createdAt: tz("created_at")
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    foreignKey({
      name: "bot_deployment_events_deployment_fk",
      columns: [t.organizationId, t.deploymentId, t.whatsappAccountId, t.botId],
      foreignColumns: [
        botDeployments.organizationId,
        botDeployments.id,
        botDeployments.whatsappAccountId,
        botDeployments.botId,
      ],
    }),
    foreignKey({
      name: "bot_deployment_events_org_actor_fk",
      columns: [t.organizationId, t.actorMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
    }),
    foreignKey({
      name: "bot_deployment_events_from_version_fk",
      columns: [t.organizationId, t.botId, t.fromVersionId],
      foreignColumns: [botVersions.organizationId, botVersions.botId, botVersions.id],
    }),
    foreignKey({
      name: "bot_deployment_events_to_version_fk",
      columns: [t.organizationId, t.botId, t.toVersionId],
      foreignColumns: [botVersions.organizationId, botVersions.botId, botVersions.id],
    }),
    index("bot_deployment_events_deployment_idx").on(t.organizationId, t.deploymentId, t.createdAt),
    check("bot_deployment_events_kind_check", oneOf(t.kind, BOT_DEPLOYMENT_EVENT_KINDS)),
    check(
      "bot_deployment_events_status_check",
      sql`(${t.fromStatus} IS NULL OR ${oneOf(t.fromStatus, BOT_DEPLOYMENT_STATUSES)})
        AND ${oneOf(t.toStatus, BOT_DEPLOYMENT_STATUSES)}`,
    ),
    check(
      "bot_deployment_events_counts_check",
      sql`${t.sessionsAffected} >= 0 AND ${t.requestsSuppressed} >= 0 AND ${t.requestsInFlight} >= 0 AND ${t.sendEpoch} >= 1`,
    ),
  ],
);

const LIVE = sql.raw(BOT_LIVE_SESSION_STATES.map((s) => `'${s}'`).join(", "));
const TERMINAL = sql.raw(BOT_TERMINAL_SESSION_STATES.map((s) => `'${s}'`).join(", "));
const FLOW_ENDS = sql.raw(BOT_FLOW_END_REASONS.map((s) => `'${s}'`).join(", "));
const FLOW_REASONS = sql.raw(BOT_FLOW_HANDOVER_REASONS.map((s) => `'${s}'`).join(", "));

/**
 * One bot conversation with one student (V3.2 G.5, K.5). The session pins its version independently of the deployment's
 * current version. `started_control_seq`, `handover_control_seq`, `started_at` and `ended_at` are written by the database
 * (triggers); application values are overwritten. No `updated_at`: the terminal-row guard compares whole rows, and an
 * automatically changed timestamp would turn every no-op into a forbidden change (`revision` is the change counter).
 */
export const botSessions = pgTable(
  "bot_sessions",
  {
    id: pk(),
    organizationId: orgId(),
    botId: uuid("bot_id").notNull(),
    botVersionId: uuid("bot_version_id").notNull(),
    deploymentId: uuid("deployment_id").notNull(),
    whatsappAccountId: uuid("whatsapp_account_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    startedByMessageId: uuid("started_by_message_id").notNull(),
    state: text("state", { enum: BOT_SESSION_STATES }).notNull(),
    currentNodeId: text("current_node_id").notNull(),
    variables: jsonb("variables")
      .notNull()
      .default(sql`'{}'::jsonb`),
    awaiting: jsonb("awaiting"),
    awaitingToken: text("awaiting_token"),
    lastConsumedToken: text("last_consumed_token"),
    stepSeq: integer("step_seq").notNull().default(0),
    transitionCount: integer("transition_count").notNull().default(0),
    sendCount: integer("send_count").notNull().default(0),
    invalidAttempts: integer("invalid_attempts").notNull().default(0),
    revision: integer("revision").notNull().default(0),
    lastInputMessageId: uuid("last_input_message_id"),
    lastInputOccurredAt: tz("last_input_occurred_at"),
    startedControlSeq: bigint("started_control_seq", { mode: "number" }).notNull().default(0),
    handoverControlSeq: bigint("handover_control_seq", { mode: "number" }),
    terminalNoticeStepSeq: integer("terminal_notice_step_seq"),
    startedAt: tz("started_at")
      .notNull()
      .default(sql`clock_timestamp()`),
    expiresAt: tz("expires_at"),
    sendWaitExpiresAt: tz("send_wait_expires_at"),
    endedAt: tz("ended_at"),
    endReason: text("end_reason", { enum: BOT_SESSION_END_REASONS }),
    handoverReason: text("handover_reason"),
    outputSuppressedAt: tz("output_suppressed_at"),
    redactedAt: tz("redacted_at"),
  },
  (t) => [
    unique("bot_sessions_org_id_unique").on(t.organizationId, t.id),
    unique("bot_sessions_org_id_conversation_unique").on(t.organizationId, t.id, t.conversationId),
    // FK target for BOT requests (0008) and triggers.
    unique("bot_sessions_org_id_conversation_account_unique").on(
      t.organizationId,
      t.id,
      t.conversationId,
      t.whatsappAccountId,
    ),
    uniqueIndex("bot_sessions_live_conversation_uidx")
      .on(t.organizationId, t.conversationId)
      .where(sql`${t.state} IN (${LIVE})`),
    uniqueIndex("bot_sessions_awaiting_token_uidx")
      .on(t.organizationId, t.awaitingToken)
      .where(sql`${t.awaitingToken} IS NOT NULL`),
    index("bot_sessions_deployment_live_idx")
      .on(t.organizationId, t.deploymentId, t.id)
      .where(sql`${t.state} IN (${LIVE})`),
    index("bot_sessions_redaction_idx")
      .on(t.organizationId, t.endedAt, t.id)
      .where(sql`${t.redactedAt} IS NULL AND ${t.state} IN (${TERMINAL})`),
    // Migration 0009 (O-4, Batch 5 EXPLAIN evidence): the runtime's all-state conversation history reads (cooldown, latest
    // handover, last input, first_message fence) and the per-contact session cap. Sessions are never deleted.
    index("bot_sessions_conversation_idx").on(t.organizationId, t.conversationId),
    index("bot_sessions_contact_started_idx").on(t.organizationId, t.contactId, t.startedAt),
    foreignKey({
      name: "bot_sessions_conversation_account_fk",
      columns: [t.organizationId, t.conversationId, t.whatsappAccountId],
      foreignColumns: [
        conversations.organizationId,
        conversations.id,
        conversations.whatsappAccountId,
      ],
    }),
    foreignKey({
      name: "bot_sessions_conversation_contact_fk",
      columns: [t.organizationId, t.conversationId, t.contactId],
      foreignColumns: [conversations.organizationId, conversations.id, conversations.contactId],
    }),
    foreignKey({
      name: "bot_sessions_started_by_message_fk",
      columns: [t.organizationId, t.conversationId, t.startedByMessageId],
      foreignColumns: [messages.organizationId, messages.conversationId, messages.id],
    }),
    foreignKey({
      name: "bot_sessions_last_input_message_fk",
      columns: [t.organizationId, t.conversationId, t.lastInputMessageId],
      foreignColumns: [messages.organizationId, messages.conversationId, messages.id],
    }),
    foreignKey({
      name: "bot_sessions_bot_version_fk",
      columns: [t.organizationId, t.botId, t.botVersionId],
      foreignColumns: [botVersions.organizationId, botVersions.botId, botVersions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "bot_sessions_deployment_fk",
      columns: [t.organizationId, t.deploymentId, t.whatsappAccountId, t.botId],
      foreignColumns: [
        botDeployments.organizationId,
        botDeployments.id,
        botDeployments.whatsappAccountId,
        botDeployments.botId,
      ],
    }).onDelete("restrict"),
    check("bot_sessions_state_check", oneOf(t.state, BOT_SESSION_STATES)),
    check("bot_sessions_node_check", sql`${t.currentNodeId} ~ ${sql.raw(NODE_ID)}`),
    check("bot_sessions_variables_object_check", sql`jsonb_typeof(${t.variables}) = 'object'`),
    check(
      "bot_sessions_awaiting_object_check",
      sql`${t.awaiting} IS NULL OR jsonb_typeof(${t.awaiting}) = 'object'`,
    ),
    check(
      "bot_sessions_tokens_check",
      sql`(${t.awaitingToken} IS NULL OR ${t.awaitingToken} ~ ${sql.raw(TOKEN)})
        AND (${t.lastConsumedToken} IS NULL OR ${t.lastConsumedToken} ~ ${sql.raw(TOKEN)})`,
    ),
    check(
      "bot_sessions_counters_check",
      sql`${t.stepSeq} >= 0 AND ${t.transitionCount} >= 0 AND ${t.sendCount} >= 0
        AND ${t.invalidAttempts} >= 0 AND ${t.revision} >= 0`,
    ),
    check("bot_sessions_started_control_seq_check", sql`${t.startedControlSeq} >= 1`),
    check(
      "bot_sessions_end_reason_values_check",
      sql`${t.endReason} IS NULL OR ${oneOf(t.endReason, BOT_SESSION_END_REASONS)}`,
    ),
    // A terminal state has its end reason and end time; a live state has neither.
    check(
      "bot_sessions_terminal_fields_check",
      sql`((${t.state} IN (${TERMINAL})) = (${t.endReason} IS NOT NULL)
        AND (${t.state} IN (${TERMINAL})) = (${t.endedAt} IS NOT NULL)) IS TRUE`,
    ),
    // Which end reasons go with which terminal state.
    check(
      "bot_sessions_end_reason_state_check",
      sql`(${t.endReason} IS NULL
        OR (${t.state} = 'COMPLETED' AND ${t.endReason} IN ('flow_end', 'idle_timeout', 'conversation_resolved', 'error'))
        OR (${t.state} = 'HANDED_OVER' AND ${t.endReason} IN ('flow_handover', 'system_handover', 'error'))
        OR (${t.state} = 'FAILED' AND ${t.endReason} = 'error')) IS TRUE`,
    ),
    // A handover reason exactly when handed over: a configured one for flow_handover, a system one otherwise.
    check(
      "bot_sessions_handover_reason_check",
      sql`((${t.state} = 'HANDED_OVER') = (${t.handoverReason} IS NOT NULL)
        AND (${t.handoverReason} IS NULL OR ${t.handoverReason} ~ ${sql.raw(CODE)})
        AND (${t.state} <> 'HANDED_OVER'
          OR (${t.endReason} = 'flow_handover') = (${t.handoverReason} IN (${FLOW_REASONS})))) IS TRUE`,
    ),
    check(
      "bot_sessions_handover_control_seq_check",
      sql`((${t.state} = 'HANDED_OVER') = (${t.handoverControlSeq} IS NOT NULL)) IS TRUE`,
    ),
    // V3.2 K.5 terminal notice, NULL-safe: only an affirmative flow ending, in its terminal state, at the final step.
    check(
      "bot_sessions_terminal_notice_check",
      sql`${t.terminalNoticeStepSeq} IS NULL OR (${t.terminalNoticeStepSeq} = ${t.stepSeq}
        AND ${t.state} IN ('COMPLETED', 'HANDED_OVER')
        AND ${t.endReason} IN (${FLOW_ENDS})) IS TRUE`,
    ),
    // V3.2 K.11: a redacted row is terminal and holds only cleared values.
    check(
      "bot_sessions_redacted_check",
      sql`${t.redactedAt} IS NULL OR (${t.state} IN (${TERMINAL})
        AND ${t.variables} = '{}'::jsonb AND ${t.awaiting} IS NULL
        AND ${t.awaitingToken} IS NULL AND ${t.lastConsumedToken} IS NULL) IS TRUE`,
    ),
  ],
);

/** Append-only per-session facts (V3.2 K.6): codes and references only, never text, values or tokens. */
export const botSessionEvents = pgTable(
  "bot_session_events",
  {
    id: pk(),
    organizationId: orgId(),
    sessionId: uuid("session_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    kind: text("kind", { enum: BOT_SESSION_EVENT_KINDS }).notNull(),
    messageId: uuid("message_id"),
    stepSeq: integer("step_seq"),
    code: text("code"),
    createdAt: tz("created_at")
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    foreignKey({
      name: "bot_session_events_session_fk",
      columns: [t.organizationId, t.sessionId, t.conversationId],
      foreignColumns: [botSessions.organizationId, botSessions.id, botSessions.conversationId],
    }),
    foreignKey({
      name: "bot_session_events_message_fk",
      columns: [t.organizationId, t.conversationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.conversationId, messages.id],
    }),
    uniqueIndex("bot_session_events_input_uidx")
      .on(t.sessionId, t.messageId)
      .where(sql`${t.kind} IN ('INPUT_ACCEPTED', 'INPUT_REJECTED')`),
    uniqueIndex("bot_session_events_interaction_uidx")
      .on(t.sessionId, t.messageId)
      .where(sql`${t.kind} = 'PROMPT_INTERACTION'`),
    index("bot_session_events_session_idx").on(t.organizationId, t.sessionId, t.createdAt),
    check("bot_session_events_kind_check", oneOf(t.kind, BOT_SESSION_EVENT_KINDS)),
    check(
      "bot_session_events_message_check",
      sql`(${t.kind} NOT IN ('INPUT_ACCEPTED', 'INPUT_REJECTED', 'PROMPT_INTERACTION')
        OR ${t.messageId} IS NOT NULL) IS TRUE`,
    ),
    check(
      "bot_session_events_values_check",
      sql`(${t.code} IS NULL OR ${t.code} ~ ${sql.raw(CODE)}) AND (${t.stepSeq} IS NULL OR ${t.stepSeq} >= 0)`,
    ),
  ],
);

/** The inbound trigger outbox (V3.2 K.7). Created in 08C; nothing writes it before 08E. */
export const botTriggers = pgTable(
  "bot_triggers",
  {
    id: pk(),
    organizationId: orgId(),
    whatsappAccountId: uuid("whatsapp_account_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    messageId: uuid("message_id").notNull(),
    inputOccurredAt: tz("input_occurred_at").notNull(),
    enqueuedAt: tz("enqueued_at")
      .notNull()
      .default(sql`clock_timestamp()`),
    observedControlSeq: bigint("observed_control_seq", { mode: "number" }).notNull(),
    status: text("status", { enum: BOT_TRIGGER_STATUSES }).notNull().default("PENDING"),
    outcomeCode: text("outcome_code"),
    attempts: smallint("attempts").notNull().default(0),
    deferrals: smallint("deferrals").notNull().default(0),
    claimToken: uuid("claim_token"),
    claimedAt: tz("claimed_at"),
    nextAttemptAt: tz("next_attempt_at").notNull().defaultNow(),
    lastErrorCode: text("last_error_code"),
    sessionId: uuid("session_id"),
    processedAt: tz("processed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("bot_triggers_org_message_unique").on(t.organizationId, t.messageId),
    foreignKey({
      name: "bot_triggers_conversation_account_fk",
      columns: [t.organizationId, t.conversationId, t.whatsappAccountId],
      foreignColumns: [
        conversations.organizationId,
        conversations.id,
        conversations.whatsappAccountId,
      ],
    }),
    foreignKey({
      name: "bot_triggers_message_fk",
      columns: [t.organizationId, t.conversationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.conversationId, messages.id],
    }),
    foreignKey({
      name: "bot_triggers_session_fk",
      columns: [t.organizationId, t.sessionId, t.conversationId, t.whatsappAccountId],
      foreignColumns: [
        botSessions.organizationId,
        botSessions.id,
        botSessions.conversationId,
        botSessions.whatsappAccountId,
      ],
    }),
    index("bot_triggers_pending_due_idx")
      .on(t.nextAttemptAt, t.id)
      .where(sql`${t.status} = 'PENDING'`),
    index("bot_triggers_pending_conversation_idx")
      .on(t.organizationId, t.conversationId, t.inputOccurredAt, t.id)
      .where(sql`${t.status} = 'PENDING'`),
    index("bot_triggers_terminalization_idx")
      .on(t.attempts, t.claimedAt)
      .where(sql`${t.status} = 'PENDING' AND ${t.attempts} = 6`),
    check("bot_triggers_status_check", oneOf(t.status, BOT_TRIGGER_STATUSES)),
    check("bot_triggers_attempts_check", sql`${t.attempts} BETWEEN 0 AND 6`),
    check("bot_triggers_deferrals_check", sql`${t.deferrals} BETWEEN 0 AND 1000`),
    check("bot_triggers_observed_seq_check", sql`${t.observedControlSeq} >= 0`),
    check(
      "bot_triggers_claim_check",
      sql`((${t.claimToken} IS NULL) = (${t.claimedAt} IS NULL)) IS TRUE`,
    ),
    check(
      "bot_triggers_lifecycle_check",
      sql`((${t.status} = 'PENDING' AND ${t.processedAt} IS NULL)
        OR (${t.status} <> 'PENDING' AND ${t.processedAt} IS NOT NULL AND ${t.claimToken} IS NULL)) IS TRUE`,
    ),
    check(
      "bot_triggers_dead_check",
      sql`(${t.status} <> 'DEAD' OR ${t.outcomeCode} IS NOT NULL) IS TRUE`,
    ),
    check(
      "bot_triggers_codes_check",
      sql`(${t.outcomeCode} IS NULL OR ${t.outcomeCode} ~ ${sql.raw(CODE)})
        AND (${t.lastErrorCode} IS NULL OR ${t.lastErrorCode} ~ ${sql.raw(CODE)})`,
    ),
  ],
);
