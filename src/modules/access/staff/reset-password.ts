import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getProvisioningAuth, replaceCredentialPassword } from "@/modules/auth/provisioning";
import { OperationRefusedError, PasswordResetIncompleteError } from "@/shared/errors/http-errors";
import { emitSecurityEvent } from "@/shared/security/events";
import type { AccessContext } from "../access";
import { assertCan } from "../permissions";
import {
  countMemberships,
  loadTarget,
  lockOrganization,
  revalidateActor,
  revokeUserSessions,
} from "./guards";
import { parseInput, resetStaffPasswordSchema } from "./schemas";
import type { StaffDeps } from "./types";

// Administrator password replacement, ONLY for identities exclusively managed by the actor's organization:
// the target user has EXACTLY ONE membership row in total and it is in ctx.organizationId. Shared identities are
// refused with the generic error (no hint about other organizations).
//
// Order (fail-closed, resumable by simply retrying):
//   1. tx: password_change_required = true + revoke the user's sessions   (more restrictive first)
//   2. Better Auth supported reset flow on the private instance            (library hashing)
//   3. tx: re-assert the flag and revoke sessions again                    (covers logins between 1 and 2)
// If step 2 fails the account is already forced into a password change with its OLD password still valid; the
// admin retries. The password is never logged.

export async function resetStaffPassword(
  ctx: AccessContext,
  rawInput: unknown,
  deps: StaffDeps = {},
) {
  assertCan(ctx, "staff.manage");
  const input = parseInput(resetStaffPasswordSchema, rawInput);
  const db = deps.db ?? getDb();
  const provisioner = deps.provisioner ?? getProvisioningAuth();

  const target = await db.transaction(async (tx) => {
    await lockOrganization(tx, ctx.organizationId);
    await revalidateActor(tx, ctx, "staff.manage");
    const membership = await loadTarget(tx, ctx, input.membershipId);
    const refuse = (reason: string): never => {
      emitSecurityEvent({
        event: "staff.password_reset_refused",
        outcome: "denied",
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        membershipId: ctx.membershipId,
        targetMembershipId: membership.id,
        targetUserId: membership.userId,
        reason,
      });
      throw new OperationRefusedError(reason);
    };
    if (membership.id === ctx.membershipId || membership.userId === ctx.userId)
      return refuse("self_mutation");

    // Lock the identity row, then require that this organization is its only membership.
    const [user] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, membership.userId))
      .for("update");
    if (!user) return refuse("missing_user");
    if ((await countMemberships(tx, user.id)) !== 1) return refuse("shared_identity");

    await tx
      .insert(schema.userSecurityState)
      .values({ userId: user.id, passwordChangeRequired: true })
      .onConflictDoUpdate({
        target: schema.userSecurityState.userId,
        set: { passwordChangeRequired: true },
      });
    await revokeUserSessions(tx, user.id);
    return { membershipId: membership.id, userId: user.id, email: user.email };
  });

  try {
    await replaceCredentialPassword(
      provisioner,
      { userId: target.userId, email: target.email },
      input.newPassword,
    );
    await db.transaction(async (tx) => {
      await tx
        .insert(schema.userSecurityState)
        .values({ userId: target.userId, passwordChangeRequired: true })
        .onConflictDoUpdate({
          target: schema.userSecurityState.userId,
          set: { passwordChangeRequired: true },
        });
      await revokeUserSessions(tx, target.userId);
    });
  } catch {
    emitSecurityEvent({
      event: "staff.password_reset_incomplete",
      outcome: "failure",
      reason: "password_reset_step",
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      targetMembershipId: target.membershipId,
      targetUserId: target.userId,
    });
    throw new PasswordResetIncompleteError();
  }

  emitSecurityEvent({
    event: "staff.password_reset",
    outcome: "success",
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    membershipId: ctx.membershipId,
    targetMembershipId: target.membershipId,
    targetUserId: target.userId,
  });
  return { membershipId: target.membershipId, passwordChangeRequired: true as const };
}
