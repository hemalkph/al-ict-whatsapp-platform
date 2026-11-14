import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type Database } from "@/db";
import { CLIENT_IP_HEADER, getAuth, trustedClientIp, type PublicAuth } from "@/modules/auth";
import { ForbiddenError, UnauthenticatedError, ValidationError } from "@/shared/errors/http-errors";
import { emitSecurityEvent } from "@/shared/security/events";
import { requireUser, type AccessOptions } from "./access";
import { parseInput } from "./staff/schemas";

// The user's OWN password change, including the forced change after an administrator reset or provisioning.
//
// ONE transaction (Phase 08G-7B C1A, ADR 0012 amendment): under the user row lock (FOR UPDATE, the lock every tenant
// credential replacement and every platform grant takes) and the credential row lock, the CURRENT password is verified
// against the stored hash and the new hash (Better Auth's hashPassword, computed before the transaction) is written to the
// same row, with password_change_required cleared and every session deleted. Verification and write cannot be separated, so
// a password proof can never overwrite a credential that changed after it was checked (Better Auth's own /change-password
// verifies and writes in separate statements and is closed on the public instance). The database trigger increments
// credential_generation with the write. A replacement session is then issued through the normal email sign-in, which
// re-verifies the new password against the current credential; if that sign-in fails, the change still stands and the user
// signs in again. Needs only a valid session (a platform-only operator has no membership).

const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
});

export type PasswordChangeStatus = "unauthenticated" | "required" | "not_required";

/** Is a password change pending for the signed-in user? Needs only a valid session (no membership check). */
export async function getPasswordChangeStatus(
  headers: Headers,
  options: Pick<AccessOptions, "db" | "auth"> = {},
): Promise<PasswordChangeStatus> {
  let userId: string;
  try {
    userId = (await requireUser(headers, options)).userId;
  } catch (error) {
    if (error instanceof UnauthenticatedError) return "unauthenticated";
    throw error;
  }
  const db = options.db ?? getDb();
  const [state] = await db
    .select({ required: schema.userSecurityState.passwordChangeRequired })
    .from(schema.userSecurityState)
    .where(eq(schema.userSecurityState.userId, userId));
  return state?.required === true ? "required" : "not_required";
}

export type ChangeOwnPasswordResult = {
  /** Response headers of the replacement sign-in (Set-Cookie): forward them to the browser. Empty if it did not succeed. */
  readonly headers: Headers;
  readonly flagCleared: boolean;
};

export async function changeOwnPassword(
  headers: Headers,
  rawInput: unknown,
  options: { db?: Database; auth?: PublicAuth } = {},
): Promise<ChangeOwnPasswordResult> {
  // This operation issues a session: like /api/auth/*, it needs a trusted client IP before anything is evaluated (C1B-P3).
  const clientIp = trustedClientIp(headers);
  if (clientIp === null) {
    emitSecurityEvent({ event: "auth.client_ip_rejected", outcome: "denied" });
    throw new ForbiddenError("client_ip_required");
  }
  const user = await requireUser(headers, options);
  const input = parseInput(changePasswordSchema, rawInput);
  const auth = options.auth ?? getAuth();
  const db = options.db ?? getDb();
  const newHash = await hashPassword(input.newPassword);

  const email = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, user.userId))
      .for("update");
    const [account] = await tx
      .select({ id: schema.accounts.id, hash: schema.accounts.password })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.userId, user.userId),
          eq(schema.accounts.providerId, "credential"),
          eq(schema.accounts.accountId, user.userId),
        ),
      )
      .for("update");
    if (
      !row ||
      !account?.hash ||
      !(await verifyPassword({ hash: account.hash, password: input.currentPassword }))
    )
      throw new ValidationError(["currentPassword"]);
    // The verifier applies Better Auth's NFKC normalization; re-salting the same secret is not a password change.
    if (await verifyPassword({ hash: account.hash, password: input.newPassword }))
      throw new ValidationError(["newPassword"]);
    await tx
      .update(schema.accounts)
      .set({ password: newHash, updatedAt: new Date() })
      .where(eq(schema.accounts.id, account.id));
    await tx
      .insert(schema.userSecurityState)
      .values({ userId: user.userId, passwordChangeRequired: false })
      .onConflictDoUpdate({
        target: schema.userSecurityState.userId,
        set: { passwordChangeRequired: false },
      });
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, user.userId));
    return row.email;
  });

  let responseHeaders = new Headers();
  try {
    const signedIn = await auth.api.signInEmail({
      body: { email, password: input.newPassword },
      // Only these two reach the session row (ip_address, user_agent); without headers both were stored empty.
      headers: new Headers({
        [CLIENT_IP_HEADER]: clientIp,
        "user-agent": headers.get("user-agent") ?? "",
      }),
      returnHeaders: true,
    });
    responseHeaders = signedIn.headers;
  } catch {
    // The password changed; the user signs in again with it.
  }

  emitSecurityEvent({ event: "auth.password_changed", outcome: "success", userId: user.userId });
  return { headers: responseHeaders, flagCleared: true };
}
