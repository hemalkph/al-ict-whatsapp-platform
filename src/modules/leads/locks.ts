import { sql } from "drizzle-orm";
import { schema, type Database } from "@/db";
import { revalidateActor, type AccessContext, type Permission } from "@/modules/access";
import { and, eq } from "drizzle-orm";

// Transaction helpers shared by the lead writers. LOCK ORDER (ADR 0016, decision 9): 1. the contact-scoped advisory lock, 2. the
// lead row, 3. the attribution row, 4. the reconcile decision row, 5. history insertion. Manual creation and status changes
// take only (1) and (2); they never lock an attribution row or a decision row.
//
// BEFORE all of those, every lead write takes the ACTOR locks in the order the staff-management services use: the ORGANIZATION
// row first, then the actor's MEMBERSHIP row (organization -> membership). Staff management (suspend, role change, reactivate)
// locks the organization row FOR UPDATE and then the target membership FOR UPDATE. A lead write that held the membership first
// and reached the organization later (the INSERT of a lead or of its history takes FOR KEY SHARE on the organization through the
// foreign key) would be the inverse order and could deadlock (40P01) against a suspension or demotion of its own actor.

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The advisory-lock key of one contact. Everything that creates a lead or changes a lead's status of that contact takes it first. */
export const contactLockKey = (organizationId: string, contactId: string) =>
  `lead-contact:${organizationId}:${contactId}`;

export async function lockContact(tx: Tx, organizationId: string, contactId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${contactLockKey(organizationId, contactId)}, 0))`,
  );
}

/**
 * The actor, checked INSIDE the transaction and held there. The AccessContext may be stale (role changed or suspended after it
 * was built), so the membership is read again, and it is read FOR SHARE: a suspension or demotion (an UPDATE of that row) waits
 * until this transaction has finished. So either it commits before we look (we refuse) or after our commit (our write stands as
 * made while the actor was still allowed). Without the share lock the actor could be suspended during a lock wait and still
 * write afterwards.
 *
 * Lock order: the organization row FOR KEY SHARE (its identity is the authenticated context's, never the client's), then the
 * membership FOR SHARE. FOR KEY SHARE is the weakest row lock and is exactly what the foreign keys of the later INSERTs take, so
 * nothing new is held; it conflicts only with the FOR UPDATE that staff management takes, which is what puts both on the same
 * side of the order. Concurrent lead writes never block each other here.
 */
export async function holdActor(tx: Tx, ctx: AccessContext, permission: Permission) {
  await tx
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, ctx.organizationId))
    .for("key share");
  await tx
    .select({ id: schema.organizationMemberships.id })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.id, ctx.membershipId),
        eq(schema.organizationMemberships.organizationId, ctx.organizationId),
      ),
    )
    .for("share");
  await revalidateActor(tx, ctx, permission);
}

/**
 * The moment of a write, read AFTER the locks were obtained, from the database clock. now() is the transaction's START time,
 * which a lock wait can leave far in the past; a JavaScript Date is another machine's clock. One value (microsecond text), the
 * ACTION time, stamps the lead's status time and its history row, and a new lead's creation and cycle start. (closed_at and a
 * reopened cycle start take the later of it and a stored boundary: see workflow.ts.)
 */
export async function afterLockTime(tx: Tx): Promise<string> {
  const res = await tx.execute<{ t: string }>(sql`SELECT clock_timestamp()::text AS t`);
  return res.rows[0]!.t;
}
