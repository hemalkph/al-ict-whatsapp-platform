import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type Database } from "@/db";
import { getAuth, type PublicAuth } from "@/modules/auth";
import {
  PasswordChangeIncompleteError,
  UnauthenticatedError,
  ValidationError,
} from "@/shared/errors/http-errors";
import { emitSecurityEvent } from "@/shared/security/events";
import { requireAccess, requireUser, type AccessOptions } from "./access";
import { parseInput } from "./staff/schemas";

// The user's OWN password change, including the forced change after an administrator reset or provisioning.
//
// Safe ordering: Better Auth changes the credential password FIRST (it verifies the current password and does the
// hashing); only after it reports success do we clear user_security_state.password_change_required. If clearing
// fails the password HAS changed but the user stays blocked (fail closed); retrying the same flow, with the password
// they just set as the "current" one, completes it. The flag is never cleared before the change succeeded and
// accounts.password is never written by us.

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
  /** Better Auth's response headers (carries the replacement session cookie): forward Set-Cookie to the browser. */
  readonly headers: Headers;
  readonly flagCleared: boolean;
};

export async function changeOwnPassword(
  headers: Headers,
  rawInput: unknown,
  options: { db?: Database; auth?: PublicAuth } = {},
): Promise<ChangeOwnPasswordResult> {
  // The explicit exception: this is the ONLY flow that may run while password_change_required is true.
  const ctx = await requireAccess(headers, { ...options, allowPasswordChangeRequired: true });
  const input = parseInput(changePasswordSchema, rawInput);
  const auth = options.auth ?? getAuth();
  const db = options.db ?? getDb();

  let responseHeaders: Headers;
  try {
    const result = await auth.api.changePassword({
      headers,
      body: {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        revokeOtherSessions: true,
      },
      returnHeaders: true,
    });
    responseHeaders = result.headers;
  } catch (error) {
    const code = (error as { body?: { code?: string } })?.body?.code;
    if (code === "INVALID_PASSWORD") throw new ValidationError(["currentPassword"]);
    if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG")
      throw new ValidationError(["newPassword"]);
    throw error;
  }

  // Better Auth has confirmed the change: only now may the application flag be cleared.
  try {
    await db
      .update(schema.userSecurityState)
      .set({ passwordChangeRequired: false })
      .where(eq(schema.userSecurityState.userId, ctx.userId));
  } catch {
    emitSecurityEvent({
      event: "auth.password_change_incomplete",
      outcome: "failure",
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      reason: "flag_clear_failed",
    });
    throw new PasswordChangeIncompleteError();
  }

  emitSecurityEvent({
    event: "auth.password_changed",
    outcome: "success",
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    membershipId: ctx.membershipId,
  });
  return { headers: responseHeaders, flagCleared: true };
}
