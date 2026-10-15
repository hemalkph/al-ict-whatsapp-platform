import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { assertCan, type AccessContext } from "@/modules/access";
import { NotFoundError } from "@/shared/errors/http-errors";
import { alreadyOpen, isOpenLeadConflict, reservedStatus, staleLead } from "./errors";
import { getLeadItem, type LeadsDeps } from "./items";
import { afterLockTime, holdActor, lockContact } from "./locks";
import { planTransition, isReserved } from "./rules";
import { parseOrThrow, statusChangeSchema, uuid } from "./schemas";
import type { LeadStatus, StatusChangeResult } from "./types";

// Staff change of a lead's status (lead.edit). A compare-and-set on the revision the browser saw, inside a transaction that takes
// the locks in the contract order: 1. the contact's advisory lock, 2. the lead row. A change made from a stale screen is refused
// (409 STALE_STATE) and nothing is overwritten. The status change and its STATUS history row are written together, as the
// database requires (a status change cannot commit without its event).
//
// Phase 07 staff set only NEW, QUALIFIED, INTERESTED, NOT_INTERESTED, NO_RESPONSE and INVALID: a reserved status is not even
// parseable as a target, and a lead already in one (registration, payment, converted) is read-only. The client never supplies a
// timestamp or a revision to store: the revision it sends is only compared; the new one is revision + 1, and the moment is one
// reading of the database clock taken AFTER the locks.

export async function changeLeadStatus(
  ctx: AccessContext,
  leadId: string,
  rawInput: unknown,
  deps: LeadsDeps = {},
): Promise<StatusChangeResult> {
  assertCan(ctx, "lead.edit");
  const { to, expectedRevision } = parseOrThrow(statusChangeSchema.safeParse(rawInput));
  const db = deps.db ?? getDb();

  try {
    return await db.transaction(async (tx) => {
      await holdActor(tx, ctx, "lead.edit");
      // Another organization's lead is the same 404 as a missing one.
      if (!uuid.safeParse(leadId).success) throw new NotFoundError();
      // The contact of a lead never changes (a trigger), so it can be read before the lock that is taken on it.
      const [identity] = await tx
        .select({ contactId: schema.leads.contactId })
        .from(schema.leads)
        .where(
          and(eq(schema.leads.organizationId, ctx.organizationId), eq(schema.leads.id, leadId)),
        );
      if (!identity) throw new NotFoundError();

      // 1. the contact's advisory lock, 2. the lead row
      await lockContact(tx, ctx.organizationId, identity.contactId);
      const [row] = await tx
        .select({
          id: schema.leads.id,
          status: schema.leads.status,
          revision: schema.leads.revision,
          closedAt: schema.leads.closedAt,
        })
        .from(schema.leads)
        .where(
          and(eq(schema.leads.organizationId, ctx.organizationId), eq(schema.leads.id, leadId)),
        )
        .for("update");
      if (!row) throw new NotFoundError();

      if (row.revision !== expectedRevision) throw staleLead();
      if (isReserved(row.status)) throw reservedStatus();
      const plan = planTransition(row.status, to);
      if (plan.kind === "noop")
        return { changed: false, lead: (await getLeadItem(tx, ctx.organizationId, row.id))! };

      if (plan.kind === "reopen") {
        // Another open lead of the contact blocks a reopening (the database refuses it too: the partial unique index).
        const [other] = await tx
          .select({ id: schema.leads.id })
          .from(schema.leads)
          .where(
            and(
              eq(schema.leads.organizationId, ctx.organizationId),
              eq(schema.leads.contactId, identity.contactId),
              inArray(schema.leads.status, schema.OPEN_LEAD_STATUSES),
              ne(schema.leads.id, row.id),
            ),
          );
        if (other) throw alreadyOpen();
      }

      const at = await afterLockTime(tx);
      const stamp = sql`${at}::timestamptz`;
      // closed_at is the start of the current closed period: set when the lead closes, kept while it stays closed, cleared on
      // reopening, which also starts a new cycle. status_changed_at, updated_at and the history row always carry the real ACTION
      // time. closed_at and a reopened cycle start are the action time too, EXCEPT that GREATEST holds them at a stored boundary
      // that is ahead of this clock (closed_at >= cycle_started_at; a reopened cycle never starts before the closure): a
      // conservative boundary, never earlier than the action.
      await tx
        .update(schema.leads)
        .set({
          status: to,
          revision: sql`${schema.leads.revision} + 1`,
          statusChangedAt: stamp,
          updatedAt: stamp,
          closedAt:
            plan.kind === "close"
              ? sql`GREATEST(${stamp}, ${schema.leads.cycleStartedAt})`
              : plan.kind === "reopen"
                ? null
                : schema.leads.closedAt,
          cycleStartedAt:
            plan.kind === "reopen"
              ? sql`GREATEST(${stamp}, ${schema.leads.closedAt})`
              : schema.leads.cycleStartedAt,
        })
        .where(
          and(eq(schema.leads.organizationId, ctx.organizationId), eq(schema.leads.id, row.id)),
        );
      await tx.insert(schema.leadEvents).values({
        organizationId: ctx.organizationId,
        leadId: row.id,
        contactId: identity.contactId,
        kind: "STATUS",
        actorMembershipId: ctx.membershipId,
        fromStatus: row.status as LeadStatus,
        toStatus: to,
        revision: row.revision + 1,
        createdAt: stamp,
      });
      return { changed: true, lead: (await getLeadItem(tx, ctx.organizationId, row.id))! };
    });
  } catch (error) {
    // The database's own backstop for a writer that did not follow the lock order.
    if (isOpenLeadConflict(error)) throw alreadyOpen();
    throw error;
  }
}
