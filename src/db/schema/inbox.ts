import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizationMemberships } from "./access";
import { createdAt, oneOf, pk, tz, updatedAt } from "./_shared";
import { CONVERSATION_EVENT_KINDS, CONVERSATION_STATUSES } from "./enums";
import { conversations, messages } from "./messaging";
import { orgId } from "./organizations";

// Phase 06 (staff inbox). Every table is organization-scoped with composite foreign keys, like the rest of the schema.

/**
 * Append-only history of staff workflow changes on a conversation: assignment and status. The CURRENT assignee and status
 * live on the conversation row; this table answers "who changed it, from what, to what, and when". Rows are never updated
 * or deleted (a trigger enforces it). A member who is later suspended stays in the history untouched.
 */
export const conversationEvents = pgTable(
  "conversation_events",
  {
    id: pk(),
    organizationId: orgId(),
    conversationId: uuid("conversation_id").notNull(),
    kind: text("kind", { enum: CONVERSATION_EVENT_KINDS }).notNull(),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    fromAssigneeMembershipId: uuid("from_assignee_membership_id"),
    toAssigneeMembershipId: uuid("to_assignee_membership_id"),
    fromStatus: text("from_status", { enum: CONVERSATION_STATUSES }),
    toStatus: text("to_status", { enum: CONVERSATION_STATUSES }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "conversation_events_org_conversation_fk",
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }),
    foreignKey({
      name: "conversation_events_org_actor_fk",
      columns: [t.organizationId, t.actorMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
    }),
    foreignKey({
      name: "conversation_events_org_from_assignee_fk",
      columns: [t.organizationId, t.fromAssigneeMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
    }),
    foreignKey({
      name: "conversation_events_org_to_assignee_fk",
      columns: [t.organizationId, t.toAssigneeMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
    }),
    index("conversation_events_conversation_idx").on(
      t.organizationId,
      t.conversationId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    check("conversation_events_kind_check", oneOf(t.kind, CONVERSATION_EVENT_KINDS)),
    check(
      "conversation_events_status_values_check",
      sql`(${t.fromStatus} IS NULL OR ${oneOf(t.fromStatus, CONVERSATION_STATUSES)})
        AND (${t.toStatus} IS NULL OR ${oneOf(t.toStatus, CONVERSATION_STATUSES)})`,
    ),
    check(
      "conversation_events_shape_check",
      sql`(${t.kind} = 'ASSIGNMENT'
            AND ${t.fromStatus} IS NULL AND ${t.toStatus} IS NULL
            AND ${t.fromAssigneeMembershipId} IS DISTINCT FROM ${t.toAssigneeMembershipId})
          OR (${t.kind} = 'STATUS'
            AND ${t.fromAssigneeMembershipId} IS NULL AND ${t.toAssigneeMembershipId} IS NULL
            AND ${t.fromStatus} IS NOT NULL AND ${t.toStatus} IS NOT NULL
            AND ${t.fromStatus} <> ${t.toStatus})`,
    ),
  ],
);

/**
 * Internal staff notes. They belong to the conversation, never to WhatsApp: nothing here is a message, is sent to Meta,
 * counts as unread, or touches last_inbound_at. Append-only (a trigger enforces it); the author is a membership.
 */
export const conversationNotes = pgTable(
  "conversation_notes",
  {
    id: pk(),
    organizationId: orgId(),
    conversationId: uuid("conversation_id").notNull(),
    authorMembershipId: uuid("author_membership_id").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "conversation_notes_org_conversation_fk",
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }),
    foreignKey({
      name: "conversation_notes_org_author_fk",
      columns: [t.organizationId, t.authorMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
    }),
    index("conversation_notes_conversation_idx").on(
      t.organizationId,
      t.conversationId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    check(
      "conversation_notes_body_check",
      sql`char_length(${t.body}) BETWEEN 1 AND 4000 AND btrim(${t.body}) <> ''`,
    ),
  ],
);

/**
 * Reusable staff-written text. NOT a Meta template: inserting one into the composer authorizes nothing, and the Phase 05
 * policy decides whether the resulting message may be sent. Archived rows are kept; titles are unique among active rows.
 */
export const quickReplies = pgTable(
  "quick_replies",
  {
    id: pk(),
    organizationId: orgId(),
    title: text("title").notNull(),
    // Generated by PostgreSQL so the uniqueness key can never drift from the title (same pattern as tags).
    titleKey: text("title_key")
      .notNull()
      .generatedAlwaysAs(sql`lower(btrim(title))`),
    body: text("body").notNull(),
    archivedAt: tz("archived_at"),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("quick_replies_org_id_unique").on(t.organizationId, t.id),
    foreignKey({
      name: "quick_replies_org_creator_fk",
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
    }),
    uniqueIndex("quick_replies_org_active_title_uidx")
      .on(t.organizationId, t.titleKey)
      .where(sql`${t.archivedAt} IS NULL`),
    check(
      "quick_replies_title_check",
      sql`char_length(${t.title}) BETWEEN 1 AND 60 AND btrim(${t.title}) <> ''`,
    ),
    check(
      "quick_replies_body_check",
      sql`char_length(${t.body}) BETWEEN 1 AND 1000 AND btrim(${t.body}) <> ''`,
    ),
  ],
);

/**
 * Per-staff "seen" state: one row = this membership has seen this INBOUND message. It is an internal staff convenience and
 * has nothing to do with a WhatsApp read receipt (nothing is ever sent to Meta). A message-level model, not a timestamp
 * high-water mark, so a message that commits late or carries an old provider time stays unread until it is actually seen.
 */
export const messageReads = pgTable(
  "message_reads",
  {
    organizationId: orgId(),
    membershipId: uuid("membership_id").notNull(),
    messageId: uuid("message_id").notNull(),
    seenAt: tz("seen_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "message_reads_pk",
      columns: [t.organizationId, t.membershipId, t.messageId],
    }),
    foreignKey({
      name: "message_reads_org_membership_fk",
      columns: [t.organizationId, t.membershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
    }),
    foreignKey({
      name: "message_reads_org_message_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }),
    index("message_reads_message_idx").on(t.organizationId, t.messageId),
  ],
);
