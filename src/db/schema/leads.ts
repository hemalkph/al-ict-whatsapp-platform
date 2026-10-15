import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { organizationMemberships } from "./access";
import { contacts } from "./contacts";
import { createdAt, oneOf, pk, tz, updatedAt } from "./_shared";
import {
  ATTRIBUTION_SOURCE_TYPES,
  LEAD_EVENT_KINDS,
  LEAD_ORIGINS,
  LEAD_RECONCILE_DECISIONS,
  LEAD_RECONCILE_MAX_ATTEMPTS,
  LEAD_STATUSES,
  OPEN_LEAD_STATUSES,
  STAFF_SETTABLE_LEAD_STATUSES,
} from "./enums";
import { messages } from "./messaging";
import { orgId } from "./organizations";

/**
 * An opportunity record for a contact (ADR 0016). A contact may have several leads over time, but at most ONE open lead at a
 * time (partial unique index): without offerings there is nothing that could tell two simultaneous open leads apart.
 *
 * `revision` is the optimistic-concurrency token: a lead is inserted at 0, and it increases by exactly 1 with every status
 * change and never otherwise.
 * `closed_at` is the start of the CURRENT closed period: NULL while the lead is open, set when it enters a closed status, kept
 * while it moves between closed statuses, cleared when it is reopened.
 * `cycle_started_at` is the start of the current inquiry cycle: the initiating referral's receipt time for an automatic lead
 * (the database copies it from the touch named by `initiating_attribution_id`; a supplied value is ignored), the creation
 * time for a manual one, the reopening time after a reopen. An attribution touch that predates it does not belong to this
 * cycle. The insert and transition rules are enforced by triggers (migration 0006); earlier closures stay recoverable from
 * lead_events.
 */
export const leads = pgTable(
  "leads",
  {
    id: pk(),
    organizationId: orgId(),
    contactId: uuid("contact_id").notNull(),
    status: text("status", { enum: LEAD_STATUSES }).notNull().default("NEW"),
    statusChangedAt: tz("status_changed_at").notNull().defaultNow(),
    revision: integer("revision").notNull().default(0),
    closedAt: tz("closed_at"),
    cycleStartedAt: tz("cycle_started_at").notNull().defaultNow(),
    // The confirmed Meta ad referral this lead was created from; NULL for every other lead. Written by the INSERT of the lead
    // and never afterwards (trigger), so it cannot be claimed for a lead that already exists.
    initiatingAttributionId: uuid("initiating_attribution_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // The return type is spelled out because leads and lead_attributions reference each other (TypeScript cannot infer both).
  (t): PgTableExtraConfigValue[] => [
    unique("leads_org_id_unique").on(t.organizationId, t.id),
    // FK target so attributions can prove their lead belongs to the same contact.
    unique("leads_org_id_contact_unique").on(t.organizationId, t.id, t.contactId),
    foreignKey({
      name: "leads_org_contact_fk",
      columns: [t.organizationId, t.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }),
    // The initiating touch belongs to the same contact of the same organization.
    foreignKey({
      name: "leads_org_initiating_attribution_contact_fk",
      columns: [t.organizationId, t.initiatingAttributionId, t.contactId],
      foreignColumns: [
        leadAttributions.organizationId,
        leadAttributions.id,
        leadAttributions.contactId,
      ],
    }),
    index("leads_org_contact_idx").on(t.organizationId, t.contactId),
    index("leads_org_status_idx").on(
      t.organizationId,
      t.status,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // The default list: newest first, stable while it is being polled (created_at never changes).
    index("leads_org_created_idx").on(
      t.organizationId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // One OPEN lead per contact. Closed leads are history and are not limited.
    uniqueIndex("leads_org_contact_open_uidx")
      .on(t.organizationId, t.contactId)
      .where(oneOf(t.status, OPEN_LEAD_STATUSES)),
    check("leads_status_check", oneOf(t.status, LEAD_STATUSES)),
    check("leads_revision_check", sql`${t.revision} >= 0`),
    // closed_at is set exactly while the status is a closed one. (Named so that it is evaluated AFTER leads_status_check:
    // PostgreSQL checks constraints in name order, and an unknown status should be reported as that.)
    check(
      "leads_status_closed_at_check",
      sql`(${t.closedAt} IS NULL) = (${oneOf(t.status, OPEN_LEAD_STATUSES)})`,
    ),
    // a lead cannot close before its cycle began
    check(
      "leads_cycle_order_check",
      sql`${t.closedAt} IS NULL OR ${t.closedAt} >= ${t.cycleStartedAt}`,
    ),
  ],
);

/**
 * Attribution touch events (e.g. Meta Click-to-WhatsApp referral): contact-level provider evidence. From migration 0006 the
 * database protects it: a row is inserted UNLINKED (lead_id NULL), nothing in it can be changed afterwards, it cannot be
 * deleted, and the only permitted update is linking it to a lead ONCE (see the guard trigger and ADR 0016).
 */
export const leadAttributions = pgTable(
  "lead_attributions",
  {
    id: pk(),
    organizationId: orgId(),
    contactId: uuid("contact_id").notNull(),
    leadId: uuid("lead_id"), // a touch may precede any lead
    messageId: uuid("message_id"), // the inbound message that carried the referral
    sourceType: text("source_type", { enum: ATTRIBUTION_SOURCE_TYPES }).notNull(),
    sourceId: text("source_id"),
    sourceUrl: text("source_url"),
    headline: text("headline"),
    body: text("body"),
    mediaType: text("media_type"),
    mediaUrl: text("media_url"),
    ctwaClid: text("ctwa_clid"),
    providerData: jsonb("provider_data"), // untrusted provider-specific leftovers
    receivedAt: tz("received_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "lead_attributions_org_contact_fk",
      columns: [t.organizationId, t.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }),
    // If lead_id is set, the lead must belong to the same contact (and organization).
    foreignKey({
      name: "lead_attributions_org_lead_contact_fk",
      columns: [t.organizationId, t.leadId, t.contactId],
      foreignColumns: [leads.organizationId, leads.id, leads.contactId],
    }),
    foreignKey({
      name: "lead_attributions_org_message_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }),
    index("lead_attributions_contact_idx").on(
      t.organizationId,
      t.contactId,
      t.receivedAt.desc().nullsFirst(),
    ),
    // FK target so lead history and reconcile decisions can prove their touch belongs to the same contact.
    unique("lead_attributions_org_id_contact_unique").on(t.organizationId, t.id, t.contactId),
    // Candidates for automatic lead handling: unlinked, confirmed Meta ad referrals that arrived with a message, in receipt
    // order. Deliberately not led by organization_id: the reconciler is a system process that walks every organization.
    index("lead_attributions_unlinked_ad_idx")
      .on(t.receivedAt, t.id)
      .where(
        sql`${t.leadId} IS NULL AND ${t.sourceType} = 'META_AD' AND ${t.messageId} IS NOT NULL`,
      ),
    // One referring inbound message carries at most one attribution touch. A database guarantee, so that a bug or a second
    // writer cannot duplicate it. Rows without a message (message_id NULL) are unconstrained by this index.
    uniqueIndex("lead_attributions_org_message_uidx")
      .on(t.organizationId, t.messageId)
      .where(sql`${t.messageId} IS NOT NULL`),
    index("lead_attributions_source_idx").on(t.organizationId, t.sourceType, t.sourceId),
    check("lead_attributions_source_type_check", oneOf(t.sourceType, ATTRIBUTION_SOURCE_TYPES)),
  ],
);

/**
 * Append-only history of a lead (a trigger refuses UPDATE and DELETE). Three kinds:
 *  - CREATED: how the lead came to exist. MANUAL has the staff member and no touch; AD_REFERRAL has the initiating touch and
 *    no staff member. At most one per lead, and it must name exactly `leads.initiating_attribution_id` (a trigger): history
 *    cannot give a lead an origin its INSERT did not record. Leads from before migration 0006 have none (nothing is invented).
 *  - STATUS: a staff status change, with the revision it produced. Only the staff-settable statuses can appear.
 *  - TOUCH_LINKED: an attribution touch was linked to the lead. It names the touch, and a touch has at most one.
 * The composite foreign keys prove that the lead and the touch belong to the same contact of the same organization.
 */
export const leadEvents = pgTable(
  "lead_events",
  {
    id: pk(),
    organizationId: orgId(),
    leadId: uuid("lead_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    kind: text("kind", { enum: LEAD_EVENT_KINDS }).notNull(),
    actorMembershipId: uuid("actor_membership_id"), // NULL = the system (the reconciler)
    origin: text("origin", { enum: LEAD_ORIGINS }),
    fromStatus: text("from_status", { enum: LEAD_STATUSES }),
    toStatus: text("to_status", { enum: LEAD_STATUSES }),
    attributionId: uuid("attribution_id"),
    revision: integer("revision"), // the lead's revision after this event, where it applies
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "lead_events_org_lead_contact_fk",
      columns: [t.organizationId, t.leadId, t.contactId],
      foreignColumns: [leads.organizationId, leads.id, leads.contactId],
    }),
    foreignKey({
      name: "lead_events_org_actor_fk",
      columns: [t.organizationId, t.actorMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
    }),
    foreignKey({
      name: "lead_events_org_attribution_contact_fk",
      columns: [t.organizationId, t.attributionId, t.contactId],
      foreignColumns: [
        leadAttributions.organizationId,
        leadAttributions.id,
        leadAttributions.contactId,
      ],
    }),
    index("lead_events_lead_idx").on(
      t.organizationId,
      t.leadId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // a lead is created once
    uniqueIndex("lead_events_created_uidx")
      .on(t.organizationId, t.leadId)
      .where(sql`${t.kind} = 'CREATED'`),
    // a touch creates at most one lead
    uniqueIndex("lead_events_created_attribution_uidx")
      .on(t.organizationId, t.attributionId)
      .where(sql`${t.kind} = 'CREATED' AND ${t.attributionId} IS NOT NULL`),
    // a touch is linked at most once
    uniqueIndex("lead_events_touch_linked_uidx")
      .on(t.organizationId, t.attributionId)
      .where(sql`${t.kind} = 'TOUCH_LINKED'`),
    // each revision of a lead is recorded by at most one status change
    uniqueIndex("lead_events_status_revision_uidx")
      .on(t.organizationId, t.leadId, t.revision)
      .where(sql`${t.kind} = 'STATUS'`),
    check("lead_events_kind_check", oneOf(t.kind, LEAD_EVENT_KINDS)),
    check("lead_events_origin_check", sql`${t.origin} IS NULL OR ${oneOf(t.origin, LEAD_ORIGINS)}`),
    check(
      "lead_events_status_values_check",
      sql`(${t.fromStatus} IS NULL OR ${oneOf(t.fromStatus, STAFF_SETTABLE_LEAD_STATUSES)})
        AND (${t.toStatus} IS NULL OR ${oneOf(t.toStatus, STAFF_SETTABLE_LEAD_STATUSES)})`,
    ),
    // Written so that it can never evaluate to NULL (a CHECK accepts NULL): every comparison is on a column that the same
    // branch has just required to be present, and the whole expression is forced to TRUE.
    check(
      "lead_events_shape_check",
      sql`((${t.kind} = 'CREATED'
            AND ${t.fromStatus} IS NULL AND ${t.toStatus} IS NULL
            AND ${t.revision} IS NOT NULL AND ${t.revision} = 0
            AND ${t.origin} IS NOT NULL
            AND ((${t.origin} = 'MANUAL' AND ${t.actorMembershipId} IS NOT NULL AND ${t.attributionId} IS NULL)
              OR (${t.origin} = 'AD_REFERRAL' AND ${t.actorMembershipId} IS NULL AND ${t.attributionId} IS NOT NULL)))
          OR (${t.kind} = 'STATUS'
            AND ${t.origin} IS NULL AND ${t.attributionId} IS NULL AND ${t.actorMembershipId} IS NOT NULL
            AND ${t.fromStatus} IS NOT NULL AND ${t.toStatus} IS NOT NULL
            AND ${t.fromStatus} <> ${t.toStatus}
            AND ${t.revision} IS NOT NULL AND ${t.revision} >= 1)
          OR (${t.kind} = 'TOUCH_LINKED'
            AND ${t.origin} IS NULL AND ${t.attributionId} IS NOT NULL
            AND ${t.fromStatus} IS NULL AND ${t.toStatus} IS NULL AND ${t.revision} IS NULL)) IS TRUE`,
    ),
  ],
);

/**
 * The durable outcome of considering one attribution touch for automatic lead handling (the reconciler, checkpoint 07C).
 * A touch has at most one row. It lives beside the evidence and never changes it. SKIPPED_* and PARKED are terminal: a
 * trigger refuses to change or delete them, and a terminally decided touch can never be linked. RETRY is a transient failure
 * waiting for `next_attempt_at` (attempts 1..4; the fifth failure is PARKED); a newly assigned time must be in the future by
 * the database clock. A LINKED touch has no row: a decision can only be written for an unlinked touch, a link cannot commit
 * beside one, and a RETRY row is deleted only by the transaction that links its touch (link first, then DELETE), never
 * earlier, so its attempts cannot be reset.
 */
export const leadReconcileDecisions = pgTable(
  "lead_reconcile_decisions",
  {
    organizationId: orgId(),
    attributionId: uuid("attribution_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    decision: text("decision", { enum: LEAD_RECONCILE_DECISIONS }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tz("next_attempt_at"),
    lastErrorCode: text("last_error_code"), // a short fixed code, never a message or content
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "lead_reconcile_decisions_pk",
      columns: [t.organizationId, t.attributionId],
    }),
    foreignKey({
      name: "lead_reconcile_decisions_org_attribution_contact_fk",
      columns: [t.organizationId, t.attributionId, t.contactId],
      foreignColumns: [
        leadAttributions.organizationId,
        leadAttributions.id,
        leadAttributions.contactId,
      ],
    }),
    // Retries that are due, oldest first (a bounded keyset scan; terminal rows are not in it).
    index("lead_reconcile_decisions_due_idx")
      .on(t.nextAttemptAt, t.attributionId)
      .where(sql`${t.decision} = 'RETRY'`),
    check("lead_reconcile_decisions_decision_check", oneOf(t.decision, LEAD_RECONCILE_DECISIONS)),
    check(
      "lead_reconcile_decisions_shape_check",
      sql`((${t.decision} = 'RETRY'
            AND ${t.attempts} BETWEEN 1 AND ${sql.raw(String(LEAD_RECONCILE_MAX_ATTEMPTS - 1))}
            AND ${t.nextAttemptAt} IS NOT NULL)
          OR (${t.decision} = 'PARKED'
            AND ${t.attempts} = ${sql.raw(String(LEAD_RECONCILE_MAX_ATTEMPTS))}
            AND ${t.nextAttemptAt} IS NULL)
          OR (${t.decision} IN ('SKIPPED_STALE', 'SKIPPED_BEFORE_CYCLE', 'SKIPPED_CONVERTED', 'SKIPPED_ARCHIVED')
            AND ${t.attempts} BETWEEN 0 AND ${sql.raw(String(LEAD_RECONCILE_MAX_ATTEMPTS - 1))}
            AND ${t.nextAttemptAt} IS NULL)) IS TRUE`,
    ),
    check(
      "lead_reconcile_decisions_error_code_check",
      sql`${t.lastErrorCode} IS NULL OR ${t.lastErrorCode} ~ '^[a-z0-9_.:-]{1,64}$'`,
    ),
  ],
);
