import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { sql } from "drizzle-orm";
import { accounts, rateLimits, sessions, users, verifications } from "../schema/auth";
import type { TestDb } from "./helpers";

// TEST-ONLY Better Auth wiring against the PERMANENT schema in src/db/schema/auth.ts. These are not the
// permanent application auth modules (those come later); they exist to prove schema/library compatibility
// and to exercise the database behavior the future provisioning workflow depends on.

export const TEST_PASSWORD = "correct-horse-battery";
export const TEST_ORIGIN = "http://localhost:3000";

/** The explicit adapter schema mapping required by ADR 0012 (the adapter looks tables up by model name). */
export const authSchemaMapping = {
  users,
  sessions,
  accounts,
  verifications,
  rate_limits: rateLimits,
};

/** One shared base configuration; public and private instances differ only where listed below. */
function baseOptions(t: TestDb, transaction = true): BetterAuthOptions {
  return {
    secret: "test-secret-test-secret-test-secret-0123456789abcdef",
    baseURL: TEST_ORIGIN,
    trustedOrigins: [TEST_ORIGIN],
    telemetry: { enabled: false },
    database: drizzleAdapter(t.db, {
      provider: "pg",
      schema: authSchemaMapping,
      usePlural: false,
      transaction, // MANDATORY in production wiring (ADR 0012); false only in the explicit control test
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    user: { modelName: "users" },
    session: { modelName: "sessions" },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
    advanced: { database: { generateId: "uuid" } },
  };
}

type Extra = Partial<BetterAuthOptions> & { transaction?: boolean };

/** PUBLIC instance: sign-up disabled. The only kind of instance that may ever be HTTP-mounted. */
export function publicAuth(t: TestDb, extra: Extra = {}) {
  const { transaction, ...rest } = extra;
  const base = baseOptions(t, transaction ?? true);
  return betterAuth({
    ...base,
    ...rest,
    emailAndPassword: { ...base.emailAndPassword, enabled: true, disableSignUp: true },
  });
}

/** PRIVATE provisioning instance: server-only, never HTTP-mounted; sign-up enabled, no auto sign-in. */
export function provisionerAuth(t: TestDb, extra: Extra = {}) {
  const { transaction, ...rest } = extra;
  const base = baseOptions(t, transaction ?? true);
  return betterAuth({
    ...base,
    ...rest,
    emailAndPassword: {
      ...base.emailAndPassword,
      enabled: true,
      disableSignUp: false,
      autoSignIn: false,
    },
  });
}

export async function provisionUser(
  t: TestDb,
  email: string,
  name = "Test User",
  password = TEST_PASSWORD,
) {
  const res = await provisionerAuth(t).api.signUpEmail({ body: { name, email, password } });
  return res.user;
}

/** Fail-closed application-access predicate used by the future access layer: ACTIVE membership required. */
export async function hasActiveMembership(t: TestDb, userId: string): Promise<boolean> {
  const r = await t.db.execute<{ ok: boolean }>(
    sql`select exists(select 1 from organization_memberships where user_id = ${userId} and status = 'ACTIVE') as ok`,
  );
  return r.rows[0]?.ok === true;
}

export function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

export function authRequest(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  return new Request(`${TEST_ORIGIN}/api/auth${path}`, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      origin: TEST_ORIGIN,
      "x-forwarded-for": "203.0.113.7",
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
