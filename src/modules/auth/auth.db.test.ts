import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PASSWORD,
  authRequest,
  login,
  provisionUser,
  realAuth,
  headersWith,
  type RealAuth,
} from "@/db/__tests__/real-auth";
import { createTestDatabase, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import { PUBLIC_DISABLED_PATHS } from "./public-instance";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("real public/private Better Auth instances (production configuration)", () => {
  let t: TestDb;
  let a: RealAuth;
  let orgId: string;
  beforeAll(async () => {
    t = await createTestDatabase();
    a = realAuth(t);
    orgId = (await seedOrg(t.db)).id;
  });
  afterAll(async () => t.close());

  describe("shared base configuration", () => {
    // Replace functions by a marker so structural equality ignores closures created per instance.
    const normalize = (v: unknown): unknown =>
      typeof v === "function"
        ? "[fn]"
        : Array.isArray(v)
          ? v.map(normalize)
          : v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]))
            : v;

    it("public and private instances differ ONLY in sign-up/auto-sign-in and disabled paths", () => {
      const pub = normalize(a.pub.options) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      const prov = normalize(a.prov.options) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(pub.emailAndPassword.disableSignUp).toBe(true);
      expect(prov.emailAndPassword.disableSignUp).toBe(false);
      expect(prov.emailAndPassword.autoSignIn).toBe(false);
      expect(pub.disabledPaths).toEqual([...PUBLIC_DISABLED_PATHS]);
      expect(prov.disabledPaths).toBeUndefined();

      delete pub.disabledPaths;
      delete pub.emailAndPassword.disableSignUp;
      delete prov.emailAndPassword.disableSignUp;
      delete prov.emailAndPassword.autoSignIn;
      expect(pub).toEqual(prov);
    });

    it("pins the approved invariants on both instances", () => {
      for (const inst of [a.pub, a.prov]) {
        const o = inst.options as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        expect(o.emailAndPassword).toMatchObject({
          enabled: true,
          minPasswordLength: 12,
          maxPasswordLength: 128,
        });
        expect(o.session).toMatchObject({
          expiresIn: 604800,
          updateAge: 86400,
          cookieCache: { enabled: false },
          modelName: "sessions",
        });
        expect(o.advanced.database.generateId).toBe("uuid");
        expect(o.rateLimit).toMatchObject({
          enabled: true,
          storage: "database",
          modelName: "rate_limits",
        });
        expect(o.user.modelName).toBe("users");
        expect(o.plugins ?? []).toHaveLength(0); // no Admin / Organization / other plugins
        expect(o.emailAndPassword.sendResetPassword).toBeUndefined();
      }
    });

    it("uses adapter transaction: true (the adapter opens a real database transaction)", async () => {
      const spy = vi.spyOn(t.db, "transaction");
      await provisionUser(a, t, "tx.check@example.com");
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("public instance: allowed functionality", () => {
    it("signs in, resolves the session, lists sessions, changes password and signs out", async () => {
      await provisionUser(a, t, "full.flow@example.com", { organizationId: orgId });
      const cookie = await login(a, "FULL.flow@example.com");
      const headers = headersWith(cookie);

      const session = await a.pub.api.getSession({ headers });
      expect(session?.user.email).toBe("full.flow@example.com");
      expect(session?.session.id).toMatch(UUID);
      const days = (session!.session.expiresAt.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);

      const sessions = await a.pub.handler(
        authRequest("/list-sessions", { method: "GET", headers: { cookie } }),
      );
      expect(sessions.status).toBe(200);

      const change = await a.pub.handler(
        authRequest("/change-password", {
          body: { currentPassword: PASSWORD, newPassword: "a-brand-new-password-9" },
          headers: { cookie },
        }),
      );
      expect(change.status).toBe(200);
      const old = await a.pub.handler(
        authRequest("/sign-in/email", {
          body: { email: "full.flow@example.com", password: PASSWORD },
        }),
      );
      expect(old.status).toBe(401);
      const fresh = await a.pub.handler(
        authRequest("/sign-in/email", {
          body: { email: "full.flow@example.com", password: "a-brand-new-password-9" },
        }),
      );
      expect(fresh.status).toBe(200);

      const out = await a.pub.handler(authRequest("/sign-out", { body: {}, headers: { cookie } }));
      expect(out.status).toBe(200);
      expect(await a.pub.api.getSession({ headers })).toBeNull();
    });

    it("keeps the cookie cache off: a deleted session row is rejected immediately", async () => {
      await provisionUser(a, t, "nocache@example.com", { organizationId: orgId });
      const cookie = await login(a, "nocache@example.com");
      expect(await a.pub.api.getSession({ headers: headersWith(cookie) })).not.toBeNull();
      await t.pool.query(
        "delete from sessions where user_id = (select id from users where email = 'nocache@example.com')",
      );
      expect(await a.pub.api.getSession({ headers: headersWith(cookie) })).toBeNull();
    });

    it("rejects wrong password and unknown user with identical public failures", async () => {
      await provisionUser(a, t, "equal.fail@example.com", { organizationId: orgId });
      const wrong = await a.pub.handler(
        authRequest("/sign-in/email", {
          body: { email: "equal.fail@example.com", password: "wrong-wrong-wrong-1" },
        }),
      );
      const unknown = await a.pub.handler(
        authRequest("/sign-in/email", {
          body: { email: "ghost@example.com", password: "wrong-wrong-wrong-1" },
        }),
      );
      expect([wrong.status, unknown.status]).toEqual([401, 401]);
      expect(await wrong.json()).toEqual(await unknown.json());
    });
  });

  describe("public instance: closed surface", () => {
    it.each([...PUBLIC_DISABLED_PATHS])(
      "POST %s is not reachable over HTTP (404)",
      async (path) => {
        const res = await a.pub.handler(
          authRequest(path, {
            body: { name: "x", email: "mallory@example.com", password: PASSWORD },
          }),
        );
        expect(res.status).toBe(404);
      },
    );

    it("cannot create a user through sign-up over HTTP or the server API", async () => {
      const before = (await t.pool.query("select count(*)::int n from users")).rows[0].n;
      const http = await a.pub.handler(
        authRequest("/sign-up/email", {
          body: { name: "M", email: "m@example.com", password: PASSWORD },
        }),
      );
      expect(http.status).toBe(404);
      await expect(
        a.pub.api.signUpEmail({ body: { name: "M", email: "m2@example.com", password: PASSWORD } }),
      ).rejects.toMatchObject({ body: { code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" } });
      expect((await t.pool.query("select count(*)::int n from users")).rows[0].n).toBe(before);
    });

    it("the parameterized /reset-password/:token callback is inert (no reset is configured)", async () => {
      await provisionUser(a, t, "inert@example.com", { organizationId: orgId });
      const before = await t.pool.query(
        "select (select count(*)::int from verifications) v, (select count(*)::int from sessions) s",
      );
      const res = await a.pub.handler(authRequest("/reset-password/some-token", { method: "GET" }));
      expect([302, 400, 401, 404]).toContain(res.status);
      expect(res.headers.getSetCookie()).toHaveLength(0);
      const after = await t.pool.query(
        "select (select count(*)::int from verifications) v, (select count(*)::int from sessions) s",
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    });

    it("password reset requests are disabled even if the path were reachable (no sendResetPassword)", async () => {
      await expect(
        a.pub.api.requestPasswordReset({ body: { email: "inert@example.com" } }),
      ).rejects.toMatchObject({ body: { code: "RESET_PASSWORD_DISABLED" } });
    });
  });

  describe("session creation gate (databaseHooks.session.create.before)", () => {
    it("refuses a session for a partially provisioned user (no ACTIVE membership); allows it once ACTIVE", async () => {
      const email = "partial@example.com";
      const user = await provisionUser(a, t, email); // auth user exists, NO membership
      const denied = await a.pub.handler(
        authRequest("/sign-in/email", { body: { email, password: PASSWORD } }),
      );
      expect(denied.status).toBe(401);
      expect((await denied.json()).code).toBe("FAILED_TO_CREATE_SESSION");
      expect(
        (await t.pool.query("select count(*)::int n from sessions where user_id = $1", [user.id]))
          .rows[0].n,
      ).toBe(0);

      await t.pool.query(
        "insert into organization_memberships (organization_id, user_id, role) values ($1, $2, 'STAFF')",
        [orgId, user.id],
      );
      expect(
        (
          await a.pub.handler(
            authRequest("/sign-in/email", { body: { email, password: PASSWORD } }),
          )
        ).status,
      ).toBe(200);

      await t.pool.query(
        "update organization_memberships set status = 'SUSPENDED' where user_id = $1",
        [user.id],
      );
      const again = await a.pub.handler(
        authRequest("/sign-in/email", { body: { email, password: PASSWORD } }),
      );
      expect(again.status).toBe(401);
    });
  });

  describe("database-backed rate limiting", () => {
    it("returns 429 on the 6th sign-in attempt from one IP within the window", async () => {
      await t.pool.query("truncate rate_limits");
      const ip = "198.51.100.77";
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        const r = await a.pub.handler(
          authRequest("/sign-in/email", {
            ip,
            body: { email: "nobody@example.com", password: "wrong-wrong-wrong-1" },
          }),
        );
        statuses.push(r.status);
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
      const rows = await t.pool.query("select key, count from rate_limits");
      expect(rows.rows).toEqual([{ key: `${ip}|/sign-in/email`, count: 5 }]);
    });
  });
});
