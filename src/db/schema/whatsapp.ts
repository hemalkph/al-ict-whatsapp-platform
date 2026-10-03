import { check, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, oneOf, pk, tz, updatedAt } from "./_shared";
import { WHATSAPP_ACCOUNT_STATUSES } from "./enums";
import { orgId } from "./organizations";

export const whatsappAccounts = pgTable(
  "whatsapp_accounts",
  {
    id: pk(),
    organizationId: orgId(),
    wabaId: text("waba_id").notNull(),
    phoneNumberId: text("phone_number_id").notNull(),
    displayPhoneNumber: text("display_phone_number").notNull(),
    verifiedName: text("verified_name"),
    status: text("status", { enum: WHATSAPP_ACCOUNT_STATUSES }).notNull().default("PENDING"),
    // Name/pointer of a server-side secret. NEVER a token or any credential value.
    credentialRef: text("credential_ref"),
    archivedAt: tz("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("whatsapp_accounts_org_id_unique").on(t.organizationId, t.id),
    // Meta phone number IDs are globally unique; this is the webhook routing key.
    uniqueIndex("whatsapp_accounts_phone_number_id_uidx").on(t.phoneNumberId),
    check("whatsapp_accounts_status_check", oneOf(t.status, WHATSAPP_ACCOUNT_STATUSES)),
  ],
);
