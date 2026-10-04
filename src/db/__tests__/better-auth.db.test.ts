import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_PASSWORD,
  authRequest,
  cookieHeaderFrom,
  provisionUser,
  provisionerAuth,
  publicAuth,
} from "./auth-fixtures";
import { createTestDatabase, type TestDb } from "./helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCRYPT_HASH = /^[0-9a-f]{32}:[0-9a-f]{128}$/; // 16-byte salt : 64-byte key, hex

async function counts(t: TestDb, email?: string) {
  const r = await t.pool.query(
    `select (select count(*)::int from users) users, (select count(*)::int from accounts) accounts,
            (select count(*)::int from sessions) sessions,
            (select count(*)::int from users where email = $1) matching_users`,
    [email ?? ""],
  );
  return r.rows[0] as { users: number; accounts: number; sessions: number; matching_users: number };
}

describe("Better Auth 1.7.7 against the permanent schema (transaction: true, usePlural: false, generateId: uuid)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());

  describe("private provisioning instance", () => {
    it("creates a user with a single credential account, hashed password, uuid ids and timestamptz columns", async () => {
      const user = await provisionUser(t, "Staff.Member@Example.com", "Staff Member");

      expect(user.id).toMatch(UUID);
      expect(user.email).toBe("staff.member@example.com"); // normalized by the library

      const u = await t.pool.query("select * from users where id = $1", [user.id]);
      expect(u.rows).toHaveLength(1);
      expect(u.rows[0].id).toMatch(UUID);
      expect(u.rows[0].created_at).toBeInstanceOf(Date);
      expect(Math.abs(Date.now() - u.rows[0].created_at.getTime())).toBeLessThan(60_000);
      expect(u.rows[0].email_verified).toBe(false);

      const a = await t.pool.query("select * from accounts where user_id = $1", [user.id]);
      expect(a.rows).toHaveLength(1); // exactly one credential account
      expect(a.rows[0].provider_id).toBe("credential");
      expect(a.rows[0].account_id).toBe(user.id); // credential accountId is the user's own id
      expect(a.rows[0].id).toMatch(UUID);
      expect(a.rows[0].password).toMatch(SCRYPT_HASH);
      expect(a.rows[0].password).not.toContain(TEST_PASSWORD);

      expect(a.rows[0].updated_at).toBeInstanceOf(Date);
    });

    it("does not create a session (autoSignIn: false)", async () => {
      const before = await counts(t);
      await provisionUser(t, `nosession-${Date.now()}@example.com`);
      expect((await counts(t)).sessions).toBe(before.sessions);
    });

    it("rejects passwords shorter than the configured 12 characters", async () => {
      await expect(
        provisionerAuth(t).api.signUpEmail({
          body: { name: "X", email: "short@example.com", password: "12345678" },
        }),
      ).rejects.toMatchObject({ body: { code: "PASSWORD_TOO_SHORT" } });
      expect((await counts(t, "short@example.com")).matching_users).toBe(0);
    });

    it("never produces a second identity for the same email in a different case", async () => {
      await provisionUser(t, "case.test@example.com");
      // autoSignIn:false returns a generic response for duplicates; the database must still hold exactly one user
      await provisionUser(t, "CASE.TEST@EXAMPLE.COM").catch(() => undefined);
      await provisionUser(t, "Case.Test@Example.com").catch(() => undefined);
      expect((await counts(t, "case.test@example.com")).matching_users).toBe(1);
      const all = await t.pool.query(
        "select count(*)::int n from users where lower(email) = 'case.test@example.com'",
      );
      expect(all.rows[0].n).toBe(1);
    });
  });

  describe("public instance: sign-in, session, sign-out", () => {
    const email = "login.user@example.com";
    beforeAll(async () => {
      await provisionUser(t, email, "Login User");
    });

    it("signs in with the correct password (case-insensitive email), creating a session row", async () => {
      const auth = publicAuth(t);
      const before = (await counts(t)).sessions;
      const res = await auth.handler(
        authRequest("/sign-in/email", {
          body: { email: "LOGIN.User@EXAMPLE.com", password: TEST_PASSWORD },
        }),
      );
      expect(res.status).toBe(200);
      const cookie = cookieHeaderFrom(res);
      expect(cookie).toContain("session_token=");
      const after = await t.pool.query(
        "select s.*, u.email from sessions s join users u on u.id = s.user_id where u.email = $1 order by s.created_at desc limit 1",
        [email],
      );
      expect((await counts(t)).sessions).toBe(before + 1);
      expect(after.rows[0].id).toMatch(UUID);
      expect(after.rows[0].expires_at).toBeInstanceOf(Date);
      const days = (after.rows[0].expires_at.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1); // default 7-day session
    });

    it("resolves the session through getSession and removes it on sign-out", async () => {
      const auth = publicAuth(t);
      const login = await auth.handler(
        authRequest("/sign-in/email", { body: { email, password: TEST_PASSWORD } }),
      );
      const cookie = cookieHeaderFrom(login);
      const headers = new Headers({ cookie });

      const session = await auth.api.getSession({ headers });
      expect(session?.user.email).toBe(email);
      expect(session?.session.userId).toBe(session?.user.id);

      const out = await auth.handler(authRequest("/sign-out", { body: {}, headers: { cookie } }));
      expect(out.status).toBe(200);
      expect(await auth.api.getSession({ headers })).toBeNull();
      const token = session?.session.token ?? "";
      const left = await t.pool.query("select count(*)::int n from sessions where token = $1", [
        token,
      ]);
      expect(left.rows[0].n).toBe(0);
    });

    it("gives equivalent public failures for a wrong password and an unknown user", async () => {
      const auth = publicAuth(t);
      const wrong = await auth.handler(
        authRequest("/sign-in/email", { body: { email, password: "definitely-the-wrong-one" } }),
      );
      const unknown = await auth.handler(
        authRequest("/sign-in/email", {
          body: { email: "nobody@example.com", password: "definitely-the-wrong-one" },
        }),
      );
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(await wrong.json()).toEqual(await unknown.json());
    });

    it("keeps the cookie cache disabled: a deleted session row is rejected immediately", async () => {
      const auth = publicAuth(t);
      const login = await auth.handler(
        authRequest("/sign-in/email", { body: { email, password: TEST_PASSWORD } }),
      );
      const headers = new Headers({ cookie: cookieHeaderFrom(login) });
      expect(await auth.api.getSession({ headers })).not.toBeNull();
      await t.pool.query(
        "delete from sessions where user_id = (select id from users where email = $1)",
        [email],
      );
      expect(await auth.api.getSession({ headers })).toBeNull();
    });
  });

  describe("public sign-up is disabled (server and HTTP)", () => {
    it("rejects HTTP /sign-up/email and server auth.api.signUpEmail, but sign-in still works", async () => {
      await provisionUser(t, "still.works@example.com");
      const auth = publicAuth(t);
      const before = (await counts(t)).users;

      const http = await auth.handler(
        authRequest("/sign-up/email", {
          body: { name: "Mallory", email: "mallory@example.com", password: TEST_PASSWORD },
        }),
      );
      expect(http.status).toBe(400);
      expect((await http.json()).code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");

      await expect(
        auth.api.signUpEmail({
          body: { name: "Mallory", email: "mallory2@example.com", password: TEST_PASSWORD },
        }),
      ).rejects.toMatchObject({ body: { code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" } });

      expect((await counts(t)).users).toBe(before);
      const ok = await auth.handler(
        authRequest("/sign-in/email", {
          body: { email: "still.works@example.com", password: TEST_PASSWORD },
        }),
      );
      expect(ok.status).toBe(200);
    });
  });

  describe("adapter transaction: true", () => {
    const failingHooks = {
      databaseHooks: {
        account: {
          create: {
            before: async () => {
              throw new Error("simulated credential-account failure");
            },
          },
        },
      },
    };

    it("leaves no user-only orphan when credential-account creation fails", async () => {
      const email = "atomic@example.com";
      await expect(
        provisionerAuth(t, failingHooks).api.signUpEmail({
          body: { name: "A", email, password: TEST_PASSWORD },
        }),
      ).rejects.toThrow(/simulated credential-account failure/);
      const c = await counts(t, email);
      expect(c.matching_users).toBe(0);
    });

    it("CONTROL: with transaction: false the same failure DOES leave an orphan user (why true is mandatory)", async () => {
      const email = "orphan-control@example.com";
      await expect(
        provisionerAuth(t, { ...failingHooks, transaction: false }).api.signUpEmail({
          body: { name: "A", email, password: TEST_PASSWORD },
        }),
      ).rejects.toThrow(/simulated credential-account failure/);
      const c = await t.pool.query(
        "select (select count(*)::int from users where email = $1) users, (select count(*)::int from accounts a join users u on u.id = a.user_id where u.email = $1) accounts",
        [email],
      );
      expect(c.rows[0]).toEqual({ users: 1, accounts: 0 });
    });
  });

  describe("database-backed rate limiting against the permanent rate_limits table", () => {
    it("returns 429 after the configured limit and stores compatible rows", async () => {
      await provisionUser(t, "ratelimit@example.com");
      await t.pool.query("truncate rate_limits");
      const auth = publicAuth(t, {
        rateLimit: {
          enabled: true,
          storage: "database",
          modelName: "rate_limits",
          customRules: { "/sign-in/email": { window: 60, max: 3 } },
        },
      });
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await auth.handler(
          authRequest("/sign-in/email", {
            body: { email: "ratelimit@example.com", password: "wrong-wrong-wrong-1" },
          }),
        );
        statuses.push(r.status);
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
      const rows = await t.pool.query("select id, key, count, last_request from rate_limits");
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].key).toBe("203.0.113.7|/sign-in/email");
      expect(rows.rows[0].count).toBe(3);
      expect(rows.rows[0].id).toMatch(UUID);
      expect(Number(rows.rows[0].last_request)).toBeGreaterThan(Date.now() - 60_000);
    });
  });
});
