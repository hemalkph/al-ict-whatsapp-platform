import { and, eq, sql } from "drizzle-orm";
import { schema } from "@/db";
import { ForbiddenError, LastAdminRequiredError, NotFoundError } from "@/shared/errors/http-errors";
import type { AccessContext } from "../access";
import { can, type Permission } from "../permissions";
import type { Tx } from "./types";

// Transaction helpers shared by the staff operations. ALWAYS call lockOrganization first: it serializes every
// staff mutation of one organization, which is what makes the last-active-admin check race-free.

/** SELECT ... FOR UPDATE on the organization row. */
export async function lockOrganization(tx: Tx, organizationId: string): Promise<void> {
  await tx
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .for("update");
}

/**
 * Re-validates the ACTOR inside the transaction: the AccessContext may be stale (role changed or suspended
 * after it was built), so the actor must still be an ACTIVE member of the organization holding the permission.
 */
export async function revalidateActor(
  tx: Tx,
  ctx: AccessContext,
  permission: Permission,
): Promise<void> {
  const [actor] = await tx
    .select({
      role: schema.organizationMemberships.role,
      status: schema.organizationMemberships.status,
    })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.id, ctx.membershipId),
        eq(schema.organizationMemberships.organizationId, ctx.organizationId),
        eq(schema.organizationMemberships.userId, ctx.userId),
      ),
    );
  if (!actor || actor.status !== "ACTIVE" || !can(actor.role, permission)) {
    throw new ForbiddenError("stale_actor");
  }
}

export type TargetMembership = {
  readonly id: string;
  readonly userId: string;
  readonly role: "ADMIN" | "STAFF" | "VIEWER";
  readonly status: "ACTIVE" | "SUSPENDED";
};

/** Finds a membership INSIDE the actor's organization (locking it). Foreign or missing ids both give NotFound. */
export async function loadTarget(
  tx: Tx,
  ctx: AccessContext,
  membershipId: string,
): Promise<TargetMembership> {
  const [row] = await tx
    .select({
      id: schema.organizationMemberships.id,
      userId: schema.organizationMemberships.userId,
      role: schema.organizationMemberships.role,
      status: schema.organizationMemberships.status,
    })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.id, membershipId),
        eq(schema.organizationMemberships.organizationId, ctx.organizationId),
      ),
    )
    .for("update");
  if (!row) throw new NotFoundError();
  return row;
}

export async function countActiveAdmins(tx: Tx, organizationId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, organizationId),
        eq(schema.organizationMemberships.role, "ADMIN"),
        eq(schema.organizationMemberships.status, "ACTIVE"),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Last-active-admin invariant: an organization must never end with zero ACTIVE ADMIN memberships. Call it,
 * under lockOrganization, BEFORE a change that would stop `target` from being an ACTIVE ADMIN.
 */
export async function assertNotLastActiveAdmin(
  tx: Tx,
  organizationId: string,
  target: Pick<TargetMembership, "role" | "status">,
): Promise<void> {
  if (target.role !== "ADMIN" || target.status !== "ACTIVE") return;
  if ((await countActiveAdmins(tx, organizationId)) <= 1) throw new LastAdminRequiredError();
}

/** Does the user have an ACTIVE membership in any organization? */
export async function hasAnyActiveMembership(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: schema.organizationMemberships.id })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.userId, userId),
        eq(schema.organizationMemberships.status, "ACTIVE"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function countMemberships(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.organizationMemberships)
    .where(eq(schema.organizationMemberships.userId, userId));
  return row?.n ?? 0;
}

/** Revokes every Better Auth session of the user (database sessions: effective immediately, no cookie cache). */
export async function revokeUserSessions(tx: Tx, userId: string): Promise<void> {
  await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}
