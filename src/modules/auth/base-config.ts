import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { BetterAuthOptions } from "better-auth";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@/db";
import type { AuthEnv } from "./env";

// SHARED BASE CONFIGURATION for the public and private Better Auth instances (ADR 0012). Both instances are
// built from this single function so they cannot silently drift; the only differences are applied by
// public-instance.ts and provisioning.ts. INTERNAL: not exported from the module's public barrel.
//
// Fixed invariants (do not make these configurable):
//  - Drizzle adapter: provider "pg", explicit schema mapping, usePlural false, `transaction: true`
//    (MANDATORY: with false, a failure between the user insert and the credential insert leaves an orphan user)
//  - uuid ids, database sessions, cookie cache disabled (role/suspension changes apply on the next request)
//  - email + password, 12..128 characters; scrypt hashing by the library (no custom crypto)
//  - 7-day sliding sessions (expiresIn 7d, updateAge 1d); database-backed rate limiting
//  - NO Admin plugin, NO Organization plugin

export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export type AuthDeps = {
  readonly db: Database;
  readonly env: AuthEnv;
};

export function buildBaseAuthOptions({ db, env }: AuthDeps): BetterAuthOptions {
  return {
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: [env.origin],
    telemetry: { enabled: false },
    database: drizzleAdapter(db, {
      provider: "pg",
      // The adapter looks tables up by model name: the explicit mapping is required (rate_limits: rateLimits).
      schema: {
        users: schema.users,
        sessions: schema.sessions,
        accounts: schema.accounts,
        verifications: schema.verifications,
        rate_limits: schema.rateLimits,
      },
      usePlural: false,
      transaction: true,
    }),
    user: { modelName: "users", changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    session: {
      modelName: "sessions",
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      cookieCache: { enabled: false },
    },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      // sendResetPassword is deliberately NOT configured: password reset stays disabled (ADR 0012).
    },
    advanced: { database: { generateId: "uuid" } },
    // HTTP-only limiter (server-side auth.api calls bypass it); keyed on client IP and skipped when no IP is
    // present. Trustworthy client-IP propagation and WAF limiting are a DEPLOYMENT BLOCKER (ADR 0012).
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "rate_limits",
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
    databaseHooks: {
      session: {
        create: {
          // Defense in depth / UX only: refuse to start a session for a user with no ACTIVE membership (e.g. a
          // partially provisioned account). requireAccess() remains the authoritative check on every request.
          // Reads through our own connection, outside Better Auth's transaction (verified at Checkpoint 1).
          before: async (session) => {
            const rows = await db
              .select({ id: schema.organizationMemberships.id })
              .from(schema.organizationMemberships)
              .where(
                and(
                  eq(schema.organizationMemberships.userId, session.userId),
                  eq(schema.organizationMemberships.status, "ACTIVE"),
                ),
              )
              .limit(1);
            if (rows.length === 0) return false;
          },
        },
      },
    },
  };
}
