import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, oneOf, pk, tz, updatedAt } from "./_shared";
import { CONSENT_ACTIONS, CONSENT_SCOPES, CONSENT_SOURCES, CONSENT_STATUSES } from "./enums";
import { orgId } from "./organizations";
import { webhookEvents } from "./webhooks";

export const contacts = pgTable(
  "contacts",
  {
    id: pk(),
    organizationId: orgId(),
    // Opaque Meta WhatsApp identifier (the phone-based "WhatsApp user ID"). Not a display name; do not assume it is
    // a phone number. NULL for a user Meta identifies only by BSUID (usernames hide the phone number). BSUIDs live
    // ONLY in contact_bsuids. A contact must have a wa_id or at least one contact_bsuids row; that cross-table rule
    // is enforced by the single contact-creation code path (a table CHECK cannot express it), not by the database.
    waId: text("wa_id"),
    phoneE164: text("phone_e164"),
    profileName: text("profile_name"), // untrusted display text from the profile
    username: text("username"), // untrusted display text: the user's WhatsApp username, when they adopted one
    firstSeenAt: tz("first_seen_at").notNull(),
    lastSeenAt: tz("last_seen_at").notNull(),
    // Cache of the latest contact_consents MARKETING event; updated in the same transaction.
    marketingConsentStatus: text("marketing_consent_status", { enum: CONSENT_STATUSES })
      .notNull()
      .default("UNKNOWN"),
    marketingConsentUpdatedAt: tz("marketing_consent_updated_at"),
    archivedAt: tz("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("contacts_org_id_unique").on(t.organizationId, t.id),
    unique("contacts_org_wa_id_unique").on(t.organizationId, t.waId),
    index("contacts_org_last_seen_idx").on(
      t.organizationId,
      t.lastSeenAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    check(
      "contacts_marketing_consent_status_check",
      oneOf(t.marketingConsentStatus, CONSENT_STATUSES),
    ),
  ],
);

/** Append-only consent events (audit log). App code never updates or deletes rows. */
export const contactConsents = pgTable(
  "contact_consents",
  {
    id: pk(),
    organizationId: orgId(),
    contactId: uuid("contact_id").notNull(),
    scope: text("scope", { enum: CONSENT_SCOPES }).notNull(),
    action: text("action", { enum: CONSENT_ACTIONS }).notNull(),
    source: text("source", { enum: CONSENT_SOURCES }).notNull(),
    sourceRef: text("source_ref"),
    evidence: jsonb("evidence"),
    occurredAt: tz("occurred_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "contact_consents_org_contact_fk",
      columns: [t.organizationId, t.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }),
    index("contact_consents_contact_scope_idx").on(
      t.organizationId,
      t.contactId,
      t.scope,
      t.occurredAt.desc().nullsFirst(),
    ),
    check("contact_consents_scope_check", oneOf(t.scope, CONSENT_SCOPES)),
    check("contact_consents_action_check", oneOf(t.action, CONSENT_ACTIONS)),
    check("contact_consents_source_check", oneOf(t.source, CONSENT_SOURCES)),
  ],
);

/**
 * Every business-scoped user ID (BSUID) ever observed for a contact: the single source of truth for "which contact
 * does this BSUID belong to", current or retired. Meta regenerates a BSUID when the user changes phone number and
 * redelivers webhooks for days in no guaranteed order, so a late event carrying an OLD BSUID must still resolve to
 * the same contact instead of creating a duplicate. Phone numbers are deliberately NOT aliased: they can be
 * recycled between people, BSUIDs are unique per business portfolio-user pair.
 *
 * Scope: UNIQUE (organization_id, bsuid) is correct only while one organization = one Meta Business Portfolio
 * (BSUIDs are scoped to a portfolio). See ADR 0013.
 *
 * Deliberately NO "one current alias per contact" unique index: Meta's documentation does not say whether an old
 * BSUID stops being valid at once after regeneration, so the database must not assert it. The application keeps at
 * most one alias with retired_at NULL per contact, and picks the newest last_seen_at if it ever sees more.
 */
export const contactBsuids = pgTable(
  "contact_bsuids",
  {
    id: pk(),
    organizationId: orgId(),
    contactId: uuid("contact_id").notNull(),
    bsuid: text("bsuid").notNull(),
    firstSeenAt: tz("first_seen_at").notNull(),
    lastSeenAt: tz("last_seen_at").notNull(),
    retiredAt: tz("retired_at"), // NULL = not (known to be) superseded
    // Provenance only. It must never block pruning old webhook events, so it is a plain FK that is nulled when the
    // event is deleted. Tenant ownership comes from organization_id/contact_id, not from this pointer.
    sourceWebhookEventId: uuid("source_webhook_event_id"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("contact_bsuids_org_bsuid_unique").on(t.organizationId, t.bsuid),
    foreignKey({
      name: "contact_bsuids_org_contact_fk",
      columns: [t.organizationId, t.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }),
    foreignKey({
      name: "contact_bsuids_source_event_fk",
      columns: [t.sourceWebhookEventId],
      foreignColumns: [webhookEvents.id],
    }).onDelete("set null"),
    // Contact lookup, newest-seen first (choosing the current alias for a contact).
    index("contact_bsuids_org_contact_idx").on(
      t.organizationId,
      t.contactId,
      t.lastSeenAt.desc().nullsFirst(),
    ),
    // Lets "ON DELETE SET NULL" find referencing rows cheaply when old webhook events are pruned.
    index("contact_bsuids_source_event_idx")
      .on(t.sourceWebhookEventId)
      .where(sql`${t.sourceWebhookEventId} IS NOT NULL`),
    check("contact_bsuids_bsuid_check", sql`char_length(${t.bsuid}) BETWEEN 1 AND 255`),
    check("contact_bsuids_seen_order_check", sql`${t.lastSeenAt} >= ${t.firstSeenAt}`),
    check(
      "contact_bsuids_retired_order_check",
      sql`${t.retiredAt} IS NULL OR ${t.retiredAt} >= ${t.firstSeenAt}`,
    ),
  ],
);
