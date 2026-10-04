import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { OperationRefusedError } from "@/shared/errors/http-errors";
import { emitSecurityEvent } from "@/shared/security/events";
import type { AccessContext } from "../access";
import { assertCan } from "../permissions";
import {
  assertNotLastActiveAdmin,
  hasAnyActiveMembership,
  loadTarget,
  lockOrganization,
  revalidateActor,
  revokeUserSessions,
} from "./guards";
import {
  changeMemberRoleSchema,
  parseInput,
  reactivateMemberSchema,
  suspendMemberSchema,
} from "./schemas";
import type { StaffDeps } from "./types";

// All three operations: require staff.manage, run in ONE transaction that first locks the organization row,
// re-validates the actor, resolves the target INSIDE ctx.organizationId (foreign id -> 404), and refuses
// self-mutation. They change only this organization's membership row.

function refuseSelf(
  ctx: AccessContext,
  target: { id: string; userId: string },
  event: "membership.change_refused",
) {
  if (target.id === ctx.membershipId || target.userId === ctx.userId) {
    emitSecurityEvent({
      event,
      outcome: "denied",
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      membershipId: ctx.membershipId,
      reason: "self_mutation",
    });
    throw new OperationRefusedError("self_mutation");
  }
}

export async function changeMemberRole(
  ctx: AccessContext,
  rawInput: unknown,
  deps: StaffDeps = {},
) {
  assertCan(ctx, "staff.manage");
  const input = parseInput(changeMemberRoleSchema, rawInput);
  const db = deps.db ?? getDb();

  const result = await db.transaction(async (tx) => {
    await lockOrganization(tx, ctx.organizationId);
    await revalidateActor(tx, ctx, "staff.manage");
    const target = await loadTarget(tx, ctx, input.membershipId);
    refuseSelf(ctx, target, "membership.change_refused");
    if (target.role === input.role) return { changed: false as const, target };
    if (input.role !== "ADMIN") await assertNotLastActiveAdmin(tx, ctx.organizationId, target);
    await tx
      .update(schema.organizationMemberships)
      .set({ role: input.role })
      .where(eq(schema.organizationMemberships.id, target.id));
    return { changed: true as const, target };
  });

  if (result.changed) {
    emitSecurityEvent({
      event: "membership.role_changed",
      outcome: "success",
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      membershipId: ctx.membershipId,
      targetMembershipId: result.target.id,
      targetUserId: result.target.userId,
      previousRole: result.target.role,
      role: input.role,
    });
  }
  return { membershipId: result.target.id, role: input.role };
}

export async function suspendMember(ctx: AccessContext, rawInput: unknown, deps: StaffDeps = {}) {
  assertCan(ctx, "staff.manage");
  const input = parseInput(suspendMemberSchema, rawInput);
  const db = deps.db ?? getDb();

  const result = await db.transaction(async (tx) => {
    await lockOrganization(tx, ctx.organizationId);
    await revalidateActor(tx, ctx, "staff.manage");
    const target = await loadTarget(tx, ctx, input.membershipId);
    refuseSelf(ctx, target, "membership.change_refused");
    if (target.status === "SUSPENDED")
      return { changed: false as const, target, sessionsRevoked: false };
    await assertNotLastActiveAdmin(tx, ctx.organizationId, target);
    await tx
      .update(schema.organizationMemberships)
      .set({ status: "SUSPENDED" })
      .where(eq(schema.organizationMemberships.id, target.id));
    // Sessions are GLOBAL: revoke them only if the identity has no other ACTIVE membership anywhere. Otherwise the
    // session stays usable for the other organization (requireAccess already fails for this one).
    const stillActiveElsewhere = await hasAnyActiveMembership(tx, target.userId);
    if (!stillActiveElsewhere) await revokeUserSessions(tx, target.userId);
    return { changed: true as const, target, sessionsRevoked: !stillActiveElsewhere };
  });

  if (result.changed) {
    emitSecurityEvent({
      event: "membership.suspended",
      outcome: "success",
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      membershipId: ctx.membershipId,
      targetMembershipId: result.target.id,
      targetUserId: result.target.userId,
      reason: result.sessionsRevoked ? "sessions_revoked" : "sessions_kept_other_active_membership",
    });
  }
  return {
    membershipId: result.target.id,
    status: "SUSPENDED" as const,
    sessionsRevoked: result.sessionsRevoked,
  };
}

/** Reactivation changes only the status: the role is never altered. */
export async function reactivateMember(
  ctx: AccessContext,
  rawInput: unknown,
  deps: StaffDeps = {},
) {
  assertCan(ctx, "staff.manage");
  const input = parseInput(reactivateMemberSchema, rawInput);
  const db = deps.db ?? getDb();

  const result = await db.transaction(async (tx) => {
    await lockOrganization(tx, ctx.organizationId);
    await revalidateActor(tx, ctx, "staff.manage");
    const target = await loadTarget(tx, ctx, input.membershipId);
    refuseSelf(ctx, target, "membership.change_refused");
    if (target.status === "ACTIVE") return { changed: false as const, target };
    await tx
      .update(schema.organizationMemberships)
      .set({ status: "ACTIVE" })
      .where(eq(schema.organizationMemberships.id, target.id));
    return { changed: true as const, target };
  });

  if (result.changed) {
    emitSecurityEvent({
      event: "membership.reactivated",
      outcome: "success",
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      membershipId: ctx.membershipId,
      targetMembershipId: result.target.id,
      targetUserId: result.target.userId,
      role: result.target.role,
    });
  }
  return { membershipId: result.target.id, status: "ACTIVE" as const };
}
