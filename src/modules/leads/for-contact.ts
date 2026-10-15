import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { assertCan, type AccessContext } from "@/modules/access";
import { NotFoundError } from "@/shared/errors/http-errors";
import { contactLabel } from "./display";
import { itemOf, openStatusesSql, selectLeadRows, type LeadsDeps } from "./items";
import { uuid } from "./schemas";
import type { ContactLeads } from "./types";

// The leads of one contact, for the inbox's lead card (07D). Read-only: lead.read and contact.read.
//
// `leads` is the newest ten (bounded history). The OPEN lead is looked up on its own, never searched for in that window: a contact
// whose open lead is older than its ten newest (closed) ones still has it, and `can.create` follows the real database state.

const LEADS_PER_CONTACT = 10;

export async function getContactLeads(
  ctx: AccessContext,
  contactId: string,
  deps: LeadsDeps = {},
): Promise<ContactLeads> {
  assertCan(ctx, "lead.read");
  assertCan(ctx, "contact.read");
  if (!uuid.safeParse(contactId).success) throw new NotFoundError();
  const db = deps.db ?? getDb();

  const found = await db.execute<{
    profile_name: string | null;
    username: string | null;
    wa_id: string | null;
    archived_at: Date | null;
    bsuid: string | null;
  }>(sql`
    SELECT ct.profile_name, ct.username, ct.wa_id, ct.archived_at,
           (SELECT b.bsuid FROM contact_bsuids b WHERE b.organization_id = ct.organization_id AND b.contact_id = ct.id
             ORDER BY (b.retired_at IS NULL) DESC, b.last_seen_at DESC LIMIT 1) AS bsuid
    FROM contacts ct
    WHERE ct.organization_id = ${ctx.organizationId}::uuid AND ct.id = ${contactId}::uuid`);
  const c = found.rows[0];
  // Another organization's contact is indistinguishable from a missing one.
  if (!c) throw new NotFoundError();

  const rows = await selectLeadRows(
    db,
    ctx.organizationId,
    [sql`l.contact_id = ${contactId}::uuid`],
    LEADS_PER_CONTACT,
  );
  const leads = rows.map(itemOf);
  // At most one exists (the partial unique index); read independently of the bounded list above.
  const [openRow] = await selectLeadRows(
    db,
    ctx.organizationId,
    [sql`l.contact_id = ${contactId}::uuid`, sql`l.status IN (${openStatusesSql()})`],
    1,
  );
  const openLead = openRow ? itemOf(openRow) : null;
  return {
    contact: {
      id: contactId,
      label: contactLabel({
        profileName: c.profile_name,
        username: c.username,
        waId: c.wa_id,
        bsuid: c.bsuid,
      }),
      archived: c.archived_at !== null,
    },
    openLead,
    leads,
    can: { create: ctx.can("lead.edit") && c.archived_at === null && openLead === null },
  };
}
