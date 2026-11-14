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

/**
 * Re-validates the actor UNDER LOCK, for operations that must be ordered against a concurrent revocation (bot management,
 * Phase 08C, ADR 0019). Locks the organization FOR KEY SHARE (which conflicts with the FOR UPDATE every staff membership
 * change takes first, see lockOrganization) and then the actor's membership row FOR SHARE (which blocks any update of that
 * row), and only then checks status and permission. A revocation that committed first is seen and refused; one that comes
 * later waits until this transaction ends. Call it FIRST in the transaction, before any domain lock. Unlike lockOrganization,
 * it does not serialize operations of the same organization with one another.
 */
export async function lockAndRevalidateActor(
  tx: Tx,
  ctx: AccessContext,
  permission: Permission,
): Promise<void> {
  const [organization] = await tx
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, ctx.organizationId))
    .for("key share");
  const [actor] = organization
    ? await tx
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
        )
        .for("share")
    : [];
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

/** Records that an ADMINISTRATOR chose this user's current password (provisioning or reset): a change is required. */
export async function markAdministratorPassword(tx: Tx, userId: string): Promise<void> {
  await tx
    .insert(schema.userSecurityState)
    .values({ userId, passwordChangeRequired: true })
    .onConflictDoUpdate({
      target: schema.userSecurityState.userId,
      set: { passwordChangeRequired: true },
    });
}

/**
 * Phase 08G-7B C1A (P1): replaces the credential password INSIDE the caller's transaction, so the authorization checks the
 * caller made under the user row lock (FOR UPDATE; a platform grant takes the same lock) and the write commit together or
 * not at all. `hash` comes from Better Auth's own hashPassword. The row written is Better Auth's CANONICAL credential
 * (provider_id 'credential' AND account_id = user id, as internalAdapter.findCredentialAccount/updatePassword use); migration
 * 0010's trigger increments credential_generation with it. Also marks an administrator password and revokes every session.
 * Throws if the user has no canonical credential account.
 */
export async function replaceCredentialInTx(tx: Tx, userId: string, hash: string): Promise<void> {
  const updated = await tx
    .update(schema.accounts)
    .set({ password: hash, updatedAt: new Date() })
    .where(
      and(
        eq(schema.accounts.userId, userId),
        eq(schema.accounts.providerId, "credential"),
        eq(schema.accounts.accountId, userId),
      ),
    )
    .returning({ id: schema.accounts.id });
  if (updated.length !== 1) throw new Error("no credential account");
  await markAdministratorPassword(tx, userId);
  await revokeUserSessions(tx, userId);
}
