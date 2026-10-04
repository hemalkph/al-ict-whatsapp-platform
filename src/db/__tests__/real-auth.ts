import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "../index";
import { createProvisioningAuth } from "@/modules/auth/provisioning";
import { createPublicAuth } from "@/modules/auth/public-instance";
import type { AuthEnv } from "@/modules/auth";
import type { TestDb } from "./helpers";

// TEST-ONLY wiring of the REAL auth factories (the production configuration, not a test copy) to a disposable
// database. Used by the auth/access integration tests.

export const TEST_AUTH_ENV: AuthEnv = {
  secret: "test-secret-".padEnd(48, "x"),
  baseURL: "http://localhost:3000",
  origin: "http://localhost:3000",
};
export const PASSWORD = "correct-horse-battery";

export function realAuth(t: TestDb) {
  const deps = { db: t.db, env: TEST_AUTH_ENV };
  return { pub: createPublicAuth(deps), prov: createProvisioningAuth(deps) };
}
export type RealAuth = ReturnType<typeof realAuth>;

let ipCounter = 0;
/** A distinct client IP per request so the (always-on) rate limiter never interferes unless a test targets it. */
export function uniqueIp(): string {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export function authRequest(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {},
) {
  return new Request(`${TEST_AUTH_ENV.origin}/api/auth${path}`, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      origin: TEST_AUTH_ENV.origin,
      "x-forwarded-for": init.ip ?? uniqueIp(),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Provisions a user through the private instance; optionally gives it a membership. */
export async function provisionUser(
  a: RealAuth,
  t: TestDb,
  email: string,
  membership?: {
    organizationId: string;
    role?: "ADMIN" | "STAFF" | "VIEWER";
    status?: "ACTIVE" | "SUSPENDED";
  },
) {
  const res = await a.prov.api.signUpEmail({
    body: { name: "Test User", email, password: PASSWORD },
  });
  if (membership) {
    await t.db.insert(schema.organizationMemberships).values({
      organizationId: membership.organizationId,
      userId: res.user.id,
      role: membership.role ?? "STAFF",
      status: membership.status ?? "ACTIVE",
    });
  }
  return res.user;
}

/** Signs in over HTTP on the public instance and returns the Cookie header value. */
export async function login(a: RealAuth, email: string, password = PASSWORD): Promise<string> {
  const res = await a.pub.handler(authRequest("/sign-in/email", { body: { email, password } }));
  if (res.status !== 200) throw new Error(`login failed with ${res.status}: ${await res.text()}`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

export const headersWith = (cookie: string, extra: Record<string, string> = {}) =>
  new Headers({ cookie, ...extra });

/**
 * A SECOND Drizzle instance over the same pool. Staff-service tests inject it as `deps.db` so that failures can be
 * injected into the service's own transactions without touching the transactions Better Auth opens on `t.db`.
 */
export function serviceDb(t: TestDb) {
  return drizzle(t.pool, { schema });
}

type GlobalCaches = {
  __alIctDb?: { $client: { end(): Promise<void> } };
  __alIctPublicAuth?: unknown;
  __alIctProvisioningAuth?: unknown;
};
const globals = globalThis as unknown as GlobalCaches;
const ENV_KEYS = ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"] as const;

/**
 * Points the lazy production singletons (getDb/getAuth/getProvisioningAuth, used by the real route handlers) at the
 * disposable database. Call releaseGlobalAuth() in afterAll BEFORE closing the harness: it ends the pool the
 * singletons created so the scratch database can be dropped without leaked connections.
 */
export function useGlobalAuth(t: TestDb): () => Promise<void> {
  const previous = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.DATABASE_URL = t.url;
  process.env.BETTER_AUTH_SECRET = TEST_AUTH_ENV.secret;
  process.env.BETTER_AUTH_URL = TEST_AUTH_ENV.baseURL;
  delete globals.__alIctDb;
  delete globals.__alIctPublicAuth;
  delete globals.__alIctProvisioningAuth;
  return async () => {
    await globals.__alIctDb?.$client.end();
    delete globals.__alIctDb;
    delete globals.__alIctPublicAuth;
    delete globals.__alIctProvisioningAuth;
    for (const k of ENV_KEYS) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
  };
}
