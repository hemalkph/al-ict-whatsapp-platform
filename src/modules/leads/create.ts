import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { assertCan, type AccessContext } from "@/modules/access";
import { NotFoundError } from "@/shared/errors/http-errors";
import { alreadyOpen, contactArchived, isOpenLeadConflict } from "./errors";
import { getLeadItem, type LeadsDeps } from "./items";
import { afterLockTime, holdActor, lockContact, type Tx } from "./locks";
import { createLeadSchema, parseOrThrow } from "./schemas";
import type { CreateLeadResult } from "./types";

// Manual lead creation for an existing contact (lead.edit). The staff member creates the lead; nothing else happens: no
// message is generated, no consent is recorded, and NO attribution touch is linked: a manual lead claims no historical
// evidence (ADR 0016, decision 4). It starts as NEW at revision 0 with origin MANUAL, and its CREATED history row is written in the
// same transaction.
//
// Every lifecycle value is decided by the server. The client sends a contact id and nothing else (the schema is strict), and the
// cycle start, creation time and history time are one reading of the DATABASE clock (the action time) taken AFTER the contact's advisory lock was
// obtained, so a request that waited for the lock is not stamped with the time it started waiting (and cannot be backdated).

export async function createManualLead(
  ctx: AccessContext,
  rawInput: unknown,
  deps: LeadsDeps = {},
): Promise<CreateLeadResult> {
  assertCan(ctx, "lead.edit");
  const { contactId } = parseOrThrow(createLeadSchema.safeParse(rawInput));
  const db = deps.db ?? getDb();

  // The advisory lock already makes concurrent creations take turns. The partial unique index behind it is the final backstop for
  // a writer that does not follow the lock order: when it fires, the contact now has an open lead, so one more attempt returns it.
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction((tx) => createInTransaction(tx, ctx, contactId));
    } catch (error) {
      if (!isOpenLeadConflict(error)) throw error;
      if (attempt >= 1) throw alreadyOpen();
    }
  }
}

async function createInTransaction(
  tx: Tx,
  ctx: AccessContext,
  contactId: string,
): Promise<CreateLeadResult> {
  await holdActor(tx, ctx, "lead.edit");
  // 1. the contact-scoped advisory lock, before anything about the contact is read or the time is taken
  await lockContact(tx, ctx.organizationId, contactId);

  // The contact, locked FOR SHARE: it cannot be archived between this check and the insert. Another organization's contact is
  // the same 404 as a missing one.
  const [contact] = await tx
    .select({ id: schema.contacts.id, archivedAt: schema.contacts.archivedAt })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.organizationId, ctx.organizationId),
        eq(schema.contacts.id, contactId),
      ),
    )
    .for("share");
  if (!contact) throw new NotFoundError();

  // An open lead already exists: it is the answer. No second lead and no duplicate history.
  const [open] = await tx
    .select({ id: schema.leads.id })
    .from(schema.leads)
    .where(
      and(
        eq(schema.leads.organizationId, ctx.organizationId),
        eq(schema.leads.contactId, contactId),
        inArray(schema.leads.status, schema.OPEN_LEAD_STATUSES),
      ),
    );
  if (open) {
    const existing = await getLeadItem(tx, ctx.organizationId, open.id);
    return { created: false, lead: existing! };
  }
  // (checked after the open-lead answer: staff looking at an archived contact's open lead still see it)
  if (contact.archivedAt !== null) throw contactArchived();

  const at = await afterLockTime(tx);
  const stamp = sql`${at}::timestamptz`;
  const [lead] = await tx
    .insert(schema.leads)
    .values({
      organizationId: ctx.organizationId,
      contactId,
      status: "NEW",
      revision: 0,
      statusChangedAt: stamp,
      cycleStartedAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning({ id: schema.leads.id });
  await tx.insert(schema.leadEvents).values({
    organizationId: ctx.organizationId,
    leadId: lead!.id,
    contactId,
    kind: "CREATED",
    origin: "MANUAL",
    actorMembershipId: ctx.membershipId,
    revision: 0,
    createdAt: stamp,
  });
  return { created: true, lead: (await getLeadItem(tx, ctx.organizationId, lead!.id))! };
}
