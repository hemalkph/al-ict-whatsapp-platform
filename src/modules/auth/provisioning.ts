import { betterAuth } from "better-auth";
import { getDb } from "@/db";
import { buildBaseAuthOptions, type AuthDeps } from "./base-config";
import { readAuthEnv } from "./env";

// PRIVATE provisioning instance (ADR 0012). SERVER-ONLY and NEVER mounted at any HTTP route.
//
// Sign-up is enabled here only because Better Auth core has no create-user API (verified: disableSignUp also
// blocks the server-side auth.api.signUpEmail). `autoSignIn: false` means no session is created.
//
// This file is deliberately NOT exported from `@/modules/auth` (the public barrel). Only the future provisioning
// service may import it, through this explicit path; `src/app/**` and unrelated modules are forbidden to by lint.
// Callers MUST follow the provisioning order in ADR 0012 (acquire the staff_provisioning_intents row first), and
// must themselves check that the email is unused: with autoSignIn:false a duplicate email returns a fabricated
// success response (fake user id) instead of an error.

export function createProvisioningAuth(deps: AuthDeps) {
  const base = buildBaseAuthOptions(deps);
  return betterAuth({
    ...base,
    emailAndPassword: {
      ...base.emailAndPassword,
      enabled: true,
      disableSignUp: false,
      autoSignIn: false,
    },
  });
}

export type ProvisioningAuth = ReturnType<typeof createProvisioningAuth>;

const globalForAuth = globalThis as unknown as { __alIctProvisioningAuth?: ProvisioningAuth };

/** Lazy singleton: validates auth env and connects only when first called. */
export function getProvisioningAuth(): ProvisioningAuth {
  globalForAuth.__alIctProvisioningAuth ??= createProvisioningAuth({
    db: getDb(),
    env: readAuthEnv(),
  });
  return globalForAuth.__alIctProvisioningAuth;
}
