import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { BetterAuthOptions } from "better-auth";
import { verifyPassword } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@/db";
import type { AuthEnv } from "./env";
import { safeAuthLogger } from "./safe-log";

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
    // Phase 08G-7B C1B-P1 closure (safe-log.ts): the library's log calls carry raw database errors (SQL parameters such as
    // session tokens), emails and URLs; only allowlisted fields are printed. `throw` hands an exception that is not an APIError
    // to handleAuthRequest instead of the router's raw console.error; APIErrors still become their usual responses.
    logger: safeAuthLogger,
    onAPIError: { throw: true },
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
      // Written ONLY by the session-create hook below (input: false: never from a request); see migration 0010.
      additionalFields: {
        credentialGeneration: { type: "number", required: false, input: false },
        credentialVerifiedAt: { type: "date", required: false, input: false },
      },
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
          // Phase 08G-7B C1A (ADR 0012 amendment): a session is issued only for a password proof against the CURRENT
          // credential. Better Auth verifies the password and creates the session in separate steps, so a proof can be
          // superseded in between (an administrator-known password replaced by its owner). This hook re-verifies the
          // submitted password against the canonical credential row (user_id, provider_id 'credential', account_id = user
          // id: the row Better Auth itself signs in with) and stamps the credential generation and database time read in
          // that same statement; migration 0010's trigger refuses the insert if the generation moved before it commits.
          // Only email sign-in creates sessions on our instances (sign-up, social and password-change paths are closed or
          // not mounted), so any other path is refused.
          // Eligibility (defense in depth / UX only): an ACTIVE membership or an ACTIVE platform role. requireAccess() /
          // the platform access check remain the authoritative checks on every request.
          // Reads through our own connection, outside Better Auth's transaction (verified at Checkpoint 1).
          before: async (session, ctx) => {
            const password =
              ctx?.path === "/sign-in/email"
                ? (ctx.body as { password?: unknown })?.password
                : undefined;
            if (typeof password !== "string") return false;
            const [proof] = await db
              .select({
                hash: schema.accounts.password,
                generation: sql<number>`coalesce(${schema.userSecurityState.credentialGeneration}, 0)::float8`,
                readAt: sql<Date>`clock_timestamp()`,
              })
              .from(schema.accounts)
              .leftJoin(
                schema.userSecurityState,
                eq(schema.userSecurityState.userId, schema.accounts.userId),
              )
              .where(
                and(
                  eq(schema.accounts.userId, session.userId),
                  eq(schema.accounts.providerId, "credential"),
                  eq(schema.accounts.accountId, session.userId),
                ),
              );
            if (!proof?.hash || !(await verifyPassword({ hash: proof.hash, password })))
              return false;
            const eligible = await isEligible(session.userId);
            if (!eligible) return false;
            return {
              data: {
                ...session,
                credentialGeneration: Number(proof.generation),
                credentialVerifiedAt: new Date(proof.readAt),
              },
            };
          },
        },
      },
    },
  };

  async function isEligible(userId: string): Promise<boolean> {
    const rows = await db
      .select({ id: schema.organizationMemberships.id })
      .from(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.userId, userId),
          eq(schema.organizationMemberships.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (rows.length > 0) return true;
    const roles = await db
      .select({ id: schema.platformOperatorRoles.id })
      .from(schema.platformOperatorRoles)
      .where(
        and(
          eq(schema.platformOperatorRoles.userId, userId),
          eq(schema.platformOperatorRoles.status, "ACTIVE"),
        ),
      )
      .limit(1);
    return roles.length > 0;
  }
}
