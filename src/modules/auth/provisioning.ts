import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { getDb } from "@/db";
import { buildBaseAuthOptions, type AuthDeps } from "./base-config";
import { readAuthEnv } from "./env";

// PRIVATE provisioning instance (ADR 0012). SERVER-ONLY and NEVER mounted at any HTTP route.
//
// Sign-up is enabled here only because Better Auth core has no create-user API (verified: disableSignUp also
// blocks the server-side auth.api.signUpEmail). `autoSignIn: false` means no session is created.
//
// This file is deliberately NOT exported from `@/modules/auth` (the public barrel). Only the auth and access
// modules may import it (ESLint). Callers MUST follow the provisioning order in ADR 0012 (acquire the
// staff_provisioning_intents row first), and must themselves check that the email is unused: with
// autoSignIn:false a duplicate email returns a fabricated success response (fake user id) instead of an error.
//
// Administrator password replacement: Better Auth core has no "set password for user" API (setPassword is for
// users without one, changePassword needs the current password, the Admin plugin is excluded). The supported
// server-side route is the documented requestPasswordReset -> resetPassword pair, whose token normally goes out by
// email through the documented `sendResetPassword` callback. On THIS instance only, that callback hands the
// single-use token to the in-process caller (never logged, stored or returned), so replaceCredentialPassword() can
// complete the reset with the library's own hashing and session revocation. The public instance has no
// sendResetPassword, so password reset stays disabled over HTTP.

// Token correlation is REQUEST-SCOPED: every replaceCredentialPassword() call creates its own capture object and
// runs requestPasswordReset inside an AsyncLocalStorage context holding it. Better Auth awaits the
// sendResetPassword callback inside that same async context (verified: no background-task handler is configured),
// so the callback writes the token into the capture of the call that triggered it and into no other. There is no
// module- or instance-level "current token", resolver or callback registry that a concurrent call could overwrite;
// if the context were ever lost the capture stays empty and the reset fails closed.
type ResetCapture = { readonly userId: string; token?: string };
const resetCapture = new AsyncLocalStorage<ResetCapture>();

export function createProvisioningAuth(deps: AuthDeps) {
  const base = buildBaseAuthOptions(deps);
  return betterAuth({
    ...base,
    emailAndPassword: {
      ...base.emailAndPassword,
      enabled: true,
      disableSignUp: false,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60, // seconds; the token never leaves this process
      sendResetPassword: async ({ user, token }) => {
        const capture = resetCapture.getStore();
        // Defense in depth: only accept a token issued for the very user this call asked about.
        if (capture && capture.userId === user.id) capture.token = token;
      },
    },
  });
}

export type ProvisioningAuth = ReturnType<typeof createProvisioningAuth>;

/**
 * Replaces a user's credential password through Better Auth's supported reset flow (library hashing, library
 * session revocation). Throws if the reset could not be completed; never logs, stores or returns the password or
 * the token. Concurrent calls (same or different users) are independent: each owns its own capture.
 */
export async function replaceCredentialPassword(
  auth: ProvisioningAuth,
  target: { readonly userId: string; readonly email: string },
  newPassword: string,
): Promise<void> {
  const capture: ResetCapture = { userId: target.userId };
  await resetCapture.run(capture, () =>
    auth.api.requestPasswordReset({ body: { email: target.email } }),
  );
  const token = capture.token;
  if (!token) throw new Error("no reset token was issued");
  await auth.api.resetPassword({ body: { newPassword, token } });
}

const globalForAuth = globalThis as unknown as { __alIctProvisioningAuth?: ProvisioningAuth };

/** Lazy singleton: validates auth env and connects only when first called. */
export function getProvisioningAuth(): ProvisioningAuth {
  globalForAuth.__alIctProvisioningAuth ??= createProvisioningAuth({
    db: getDb(),
    env: readAuthEnv(),
  });
  return globalForAuth.__alIctProvisioningAuth;
}
