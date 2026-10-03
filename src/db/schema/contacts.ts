import { check, foreignKey, index, pgTable, text, unique, uuid, jsonb } from "drizzle-orm/pg-core";
import { createdAt, oneOf, pk, tz, updatedAt } from "./_shared";
import { CONSENT_ACTIONS, CONSENT_SCOPES, CONSENT_SOURCES, CONSENT_STATUSES } from "./enums";
import { orgId } from "./organizations";

export const contacts = pgTable(
  "contacts",
  {
    id: pk(),
    organizationId: orgId(),
    // Opaque Meta WhatsApp identifier. Not a display name; do not assume it is a phone number.
    waId: text("wa_id").notNull(),
    phoneE164: text("phone_e164"),
    profileName: text("profile_name"), // untrusted display text from the profile
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
