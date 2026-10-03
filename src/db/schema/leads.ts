import { check, foreignKey, index, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { contacts } from "./contacts";
import { createdAt, oneOf, pk, tz, updatedAt } from "./_shared";
import { ATTRIBUTION_SOURCE_TYPES, LEAD_STATUSES } from "./enums";
import { messages } from "./messaging";
import { orgId } from "./organizations";

/** An opportunity record for a contact. A contact may have several; no uniqueness until offerings exist. */
export const leads = pgTable(
  "leads",
  {
    id: pk(),
    organizationId: orgId(),
    contactId: uuid("contact_id").notNull(),
    status: text("status", { enum: LEAD_STATUSES }).notNull().default("NEW"),
    statusChangedAt: tz("status_changed_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("leads_org_id_unique").on(t.organizationId, t.id),
    // FK target so attributions can prove their lead belongs to the same contact.
    unique("leads_org_id_contact_unique").on(t.organizationId, t.id, t.contactId),
    foreignKey({
      name: "leads_org_contact_fk",
      columns: [t.organizationId, t.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }),
    index("leads_org_contact_idx").on(t.organizationId, t.contactId),
    index("leads_org_status_idx").on(
      t.organizationId,
      t.status,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    check("leads_status_check", oneOf(t.status, LEAD_STATUSES)),
  ],
);

/** Attribution touch events (e.g. Meta Click-to-WhatsApp referral). Append-only. */
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
    index("lead_attributions_source_idx").on(t.organizationId, t.sourceType, t.sourceId),
    check("lead_attributions_source_type_check", oneOf(t.sourceType, ATTRIBUTION_SOURCE_TYPES)),
  ],
);
