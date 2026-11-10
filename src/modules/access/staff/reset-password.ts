import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { hasActivePlatformRole } from "@/modules/platform";
import { AppError } from "@/shared/errors/app-error";
import { OperationRefusedError, PasswordResetIncompleteError } from "@/shared/errors/http-errors";
import { emitSecurityEvent } from "@/shared/security/events";
import type { AccessContext } from "../access";
import { assertCan } from "../permissions";
import {
  countMemberships,
  loadTarget,
  lockOrganization,
  replaceCredentialInTx,
  revalidateActor,
} from "./guards";
import { parseInput, resetStaffPasswordSchema } from "./schemas";
import type { StaffDeps } from "./types";

// Administrator password replacement, ONLY for identities exclusively managed by the actor's organization:
// the target user has EXACTLY ONE membership row in total and it is in ctx.organizationId. Shared identities are
// refused with the generic error (no hint about other organizations).
//
// ONE transaction (Phase 08G-7B C1A, P1): the actor re-check, the user row lock (FOR UPDATE), the refusal of platform
// operators, the credential write, password_change_required + a new credential generation, and the session revocation
// commit together or not at all. A platform grant takes the same user row lock, so a grant and a reset are strictly
// ordered: whichever is second sees the first (a grant refuses a password still marked as administrator-set). The new
// password is hashed BEFORE the transaction by Better Auth's own hashPassword; no write happens after the lock is released,
// so there is no half-done state to recover from: a failure leaves the old password, flag and sessions as they were.
// The password is never logged.

export async function resetStaffPassword(
  ctx: AccessContext,
  rawInput: unknown,
  deps: StaffDeps = {},
) {
  assertCan(ctx, "staff.manage");
  const input = parseInput(resetStaffPasswordSchema, rawInput);
  const db = deps.db ?? getDb();
  const hash = await hashPassword(input.newPassword);

  let target: { membershipId: string; userId: string };
  try {
    target = await db.transaction(async (tx) => {
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
      // A tenant administrator never chooses the password of a platform operator.
      if (await hasActivePlatformRole(tx, user.id)) return refuse("platform_operator");

      await replaceCredentialInTx(tx, user.id, hash);
      return { membershipId: membership.id, userId: user.id };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    emitSecurityEvent({
      event: "staff.password_reset_incomplete",
      outcome: "failure",
      reason: "password_reset_step",
      userId: ctx.userId,
      organizationId: ctx.organizationId,
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
