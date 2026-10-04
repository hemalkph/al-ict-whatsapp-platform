import { betterAuth } from "better-auth";
import { getDb } from "@/db";
import { buildBaseAuthOptions, type AuthDeps } from "./base-config";
import { readAuthEnv } from "./env";

// PUBLIC Better Auth instance: the ONLY instance that may ever be mounted at /api/auth/* (via toNextJsHandler).
// Sign-up is disabled; the generic user-mutation surface is closed.

/**
 * HTTP paths closed on the public instance. Defense in depth on top of the options that already disable the
 * features (changeEmail/deleteUser disabled, no sendResetPassword, no social providers); `disableSignUp`, not this
 * list, is the primary sign-up protection. `/set-password` is server-only (404 over HTTP).
 * Limitation: `disabledPaths` matches exact paths, so the parameterized `/reset-password/:token` callback cannot be
 * listed; it is inert because password reset is not configured (covered by a test).
 * Kept: /sign-in/email, /sign-out, /get-session, /change-password, /list-sessions and session revocation.
 */
export const PUBLIC_DISABLED_PATHS = [
  "/sign-up/email",
  "/update-user",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
  "/link-social",
  "/request-password-reset",
  "/reset-password",
  "/set-password",
] as const;

export function createPublicAuth(deps: AuthDeps) {
  const base = buildBaseAuthOptions(deps);
  return betterAuth({
    ...base,
    emailAndPassword: { ...base.emailAndPassword, enabled: true, disableSignUp: true },
    disabledPaths: [...PUBLIC_DISABLED_PATHS],
  });
}

export type PublicAuth = ReturnType<typeof createPublicAuth>;

const globalForAuth = globalThis as unknown as { __alIctPublicAuth?: PublicAuth };

/** Lazy singleton: validates auth env and connects only when first called. */
export function getAuth(): PublicAuth {
  globalForAuth.__alIctPublicAuth ??= createPublicAuth({ db: getDb(), env: readAuthEnv() });
  return globalForAuth.__alIctPublicAuth;
}
