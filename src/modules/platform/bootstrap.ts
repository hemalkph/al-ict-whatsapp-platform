import { randomUUID } from "node:crypto";
import { verifyPassword } from "better-auth/crypto";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type Database } from "@/db";
import { emitSecurityEvent } from "@/shared/security/events";
import { recordAudit, recordAuditBestEffort } from "./audit";
import { lockPlatformRoles, VERIFICATION_REF } from "./operators";

// OPERATOR-ONLY, ONE-TIME: grants PLATFORM_SECURITY_ADMIN to the first platform human (plan 5.1, OD-C1-1). Reached only by
// the `platform:bootstrap-operator` CLI, never by a route (not exported from the module barrel).
//
// Identity is proven twice, never by a claimed email or id alone: (1) the owner verifies the person out of band and passes
// a short reference; (2) that person types the account's CURRENT password at the hidden prompt, checked against the stored
// credential with the library's own verifier. An account whose password an administrator set and that has not been
// changed since (password_change_required) is refused: someone else may know that password.
//
// Single use: the partial unique index on grant_kind = 'BOOTSTRAP' admits one row ever, and grants are never deleted, so
// revoking every operator does not reopen it. Concurrent runs serialize on the platform-roles advisory lock; the loser sees
// the row and is refused. Limitation (C1-G3): whoever runs this holds the database credential and could bypass it.

export class BootstrapRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`Platform bootstrap refused (${reason}).`);
    this.name = "BootstrapRefusedError";
  }
}

const inputSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(1).max(128),
  verificationRef: z.string().regex(VERIFICATION_REF),
});

export async function bootstrapPlatformSecurityAdmin(
  rawInput: unknown,
  deps: { readonly db?: Database } = {},
): Promise<{ readonly grantId: string; readonly userId: string }> {
  const db = deps.db ?? getDb();
  const correlationId = randomUUID();
  const parsed = inputSchema.safeParse(rawInput);
  let targetUserId: string | null = null;
  try {
    if (!parsed.success) throw new BootstrapRefusedError("invalid_input");
    const input = parsed.data;
    return await db.transaction(async (tx) => {
      await lockPlatformRoles(tx);
      // Checked before the password, so a completed bootstrap is never a password oracle.
      const done = await tx
        .select({ id: schema.platformOperatorRoles.id })
        .from(schema.platformOperatorRoles)
        .where(eq(schema.platformOperatorRoles.grantKind, "BOOTSTRAP"));
      if (done.length > 0) throw new BootstrapRefusedError("already_bootstrapped");

      const [user] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, input.email))
        .for("share");
      const [credential] = user
        ? await tx
            .select({ hash: schema.accounts.password })
            .from(schema.accounts)
            .where(
              and(
                eq(schema.accounts.userId, user.id),
                eq(schema.accounts.providerId, "credential"),
                // Better Auth's canonical credential row (the one its own sign-in verifies against).
                eq(schema.accounts.accountId, user.id),
              ),
            )
        : [];
      // One refusal for a missing user, a missing credential and a wrong password.
      if (
        !user ||
        !credential?.hash ||
        !(await verifyPassword({ hash: credential.hash, password: input.password }))
      )
        throw new BootstrapRefusedError("identity_not_verified");
      targetUserId = user.id;

      const [state] = await tx
        .select({ required: schema.userSecurityState.passwordChangeRequired })
        .from(schema.userSecurityState)
        .where(eq(schema.userSecurityState.userId, user.id));
      if (state?.required === true) throw new BootstrapRefusedError("password_change_required");
      const intents = await tx
        .select({ id: schema.staffProvisioningIntents.id })
        .from(schema.staffProvisioningIntents)
        .where(
          or(
            eq(schema.staffProvisioningIntents.emailKey, input.email),
            eq(schema.staffProvisioningIntents.authUserId, user.id),
          ),
        )
        .limit(1);
      if (intents.length > 0) throw new BootstrapRefusedError("provisioning_in_progress");

      const [grant] = await tx
        .insert(schema.platformOperatorRoles)
        .values({
          userId: user.id,
          role: "PLATFORM_SECURITY_ADMIN",
          grantKind: "BOOTSTRAP",
          grantedByUserId: null,
          verificationRef: input.verificationRef,
        })
        .returning({ id: schema.platformOperatorRoles.id });
      await recordAudit(tx, {
        correlationId,
        actorKind: "BOOTSTRAP",
        actorUserId: null,
        action: "platform.bootstrap",
        permission: null,
        outcome: "SUCCEEDED",
        targetUserId: user.id,
        approvalRef: input.verificationRef,
      });
      return { grantId: grant!.id, userId: user.id };
    });
  } catch (error) {
    const reason = error instanceof BootstrapRefusedError ? error.reason : "unexpected_error";
    emitSecurityEvent({
      event: "platform.bootstrap_refused",
      outcome: "denied",
      targetUserId: targetUserId ?? undefined,
      reason,
    });
    await recordAuditBestEffort(db, {
      correlationId,
      actorKind: "BOOTSTRAP",
      actorUserId: null,
      action: "platform.bootstrap",
      permission: null,
      outcome: error instanceof BootstrapRefusedError ? "DENIED" : "FAILED",
      targetUserId,
      resultCode: reason.toUpperCase(),
    });
    throw error;
  }
}
