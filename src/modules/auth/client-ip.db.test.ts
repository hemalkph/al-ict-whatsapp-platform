import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import {
  PASSWORD,
  TEST_AUTH_ENV,
  authRequest,
  headersWith,
  provisionUser,
  realAuth,
  useGlobalAuth,
  type RealAuth,
} from "@/db/__tests__/real-auth";
import { requireAccess } from "@/modules/access";
import { getAuth } from "./index";

// Phase 08G-7B C1B-P3: the trusted client-IP contract through the REAL mounted routes (/api/auth/[...all] and
// /api/account/change-password), the real public Better Auth instance and a disposable PostgreSQL database.
// The tests play the trusted ingress by setting CF-Connecting-IP themselves. That proves what the application does with the
// header; it cannot prove the header came from Cloudflare (docs/DEPLOYMENT.md, staging gates).

type AuthRoute = typeof import("../../app/api/auth/[...all]/route");
type ChangeRoute = typeof import("../../app/api/account/change-password/route");

const WRONG = "wrong-wrong-wrong-1";
const NEW_PASSWORD = "a-brand-new-password-1";

describe("C1B-P3 trusted client IP (real routes, real limiter, PostgreSQL)", () => {
  let t: TestDb;
  let a: RealAuth;
  let route: AuthRoute;
  let change: ChangeRoute;
  let release: () => Promise<void>;
  let orgId: string;
  const logs: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    a = realAuth(t);
    release = useGlobalAuth(t);
    route = await import("../../app/api/auth/[...all]/route");
    change = await import("../../app/api/account/change-password/route");
    orgId = (await seedOrg(t.db)).id;
    await provisionUser(a, t, "ip.user@example.com", { organizationId: orgId, role: "STAFF" });
    for (const m of ["log", "warn", "error"] as const)
      spies.push(
        vi
          .spyOn(console, m)
          .mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))),
      );
  });
  afterAll(async () => {
    spies.forEach((s) => s.mockRestore());
    await release();
    await t.close();
  });
  beforeEach(async () => {
    logs.length = 0;
    await t.pool.query("truncate rate_limits");
  });

  /** A sign-in whose headers are EXACTLY `headers` plus content-type and origin (no client IP unless given). */
  const signIn = (
    headers: Record<string, string>,
    password = WRONG,
    email = "ip.user@example.com",
  ) =>
    route.POST(
      new Request(`${TEST_AUTH_ENV.origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_AUTH_ENV.origin, ...headers },
        body: JSON.stringify({ email, password }),
      }),
    );
  const cf = (ip: string, extra: Record<string, string> = {}) => ({
    "cf-connecting-ip": ip,
    ...extra,
  });
  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  const buckets = async () =>
    (await t.pool.query("select key, count from rate_limits order by key")).rows as Array<{
      key: string;
      count: number;
    }>;
  const sessionIps = async (email: string) =>
    (
      await t.pool.query(
        "select s.ip_address from sessions s join users u on u.id = s.user_id where u.email = $1 order by s.created_at",
        [email],
      )
    ).rows.map((r) => r.ip_address as string);
  const sessionCount = async () =>
    (await t.pool.query("select count(*)::int n from sessions")).rows[0].n as number;

  describe("rate limit: five attempts per sixty seconds per trusted client IP", () => {
    it("five attempts are evaluated, the sixth is 429, and forged forwarding headers neither reset nor split the bucket", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++)
        statuses.push(
          (
            await signIn(
              cf("203.0.113.50", {
                "x-forwarded-for": `198.51.100.${i + 1}`,
                "x-real-ip": `198.51.100.${i + 101}`,
                forwarded: `for=198.51.100.${i + 201}`,
              }),
            )
          ).status,
        );
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
      expect(await buckets()).toEqual([{ key: "203.0.113.50|/sign-in/email", count: 5 }]);
    });

    it("the correct password is refused too once the bucket is full (the limiter runs before authentication)", async () => {
      for (let i = 0; i < 5; i++) await signIn(cf("203.0.113.51"));
      const before = await sessionCount();
      expect((await signIn(cf("203.0.113.51"), PASSWORD)).status).toBe(429);
      expect(await sessionCount()).toBe(before);
    });

    it("two clients with different trusted IPs have separate buckets", async () => {
      for (let i = 0; i < 5; i++) await signIn(cf("203.0.113.52"));
      expect((await signIn(cf("203.0.113.52"))).status).toBe(429);
      expect((await signIn(cf("203.0.113.53"))).status).toBe(401);
      expect(await buckets()).toEqual([
        { key: "203.0.113.52|/sign-in/email", count: 5 },
        { key: "203.0.113.53|/sign-in/email", count: 1 },
      ]);
    });

    it("concurrent attempts cannot exceed the limit", async () => {
      const statuses = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          signIn(cf("203.0.113.54", { "x-forwarded-for": `198.51.100.${i + 1}` })).then(
            (r) => r.status,
          ),
        ),
      );
      expect(statuses.filter((s) => s === 401)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(15);
      expect(await buckets()).toEqual([{ key: "203.0.113.54|/sign-in/email", count: 5 }]);
    });

    it("IPv6 clients are limited per /64, and an IPv4-mapped address is the IPv4 client", async () => {
      for (let i = 0; i < 5; i++) await signIn(cf(`2001:db8:ab:cd::${i + 1}`));
      expect((await signIn(cf("2001:DB8:AB:CD:ffff:ffff:ffff:ffff"))).status).toBe(429);
      expect((await signIn(cf("2001:db8:ab:ce::1"))).status).toBe(401);
      for (const mapped of ["::ffff:203.0.113.55", "::FFFF:cb00:7137", "203.0.113.55"])
        expect((await signIn(cf(mapped))).status).toBe(401);
      expect(await buckets()).toEqual([
        { key: "2001:0db8:00ab:00cd:0000:0000:0000:0000|/sign-in/email", count: 5 },
        { key: "2001:0db8:00ab:00ce:0000:0000:0000:0000|/sign-in/email", count: 1 },
        { key: "203.0.113.55|/sign-in/email", count: 3 },
      ]);
    });
  });

  describe("fail closed: no trusted client IP, no authentication", () => {
    const forged = {
      "x-forwarded-for": "198.51.100.1",
      "x-real-ip": "198.51.100.2",
      forwarded: "for=198.51.100.3",
    };
    it.each([
      ["missing", {}],
      ["missing, with forged forwarding headers", forged],
      ["empty", cf("")],
      ["comma chain", cf("203.0.113.60, 10.0.0.1", forged)],
      ["the same address twice", cf("203.0.113.60,203.0.113.60")],
      ["trailing comma", cf("203.0.113.60,")],
      ["leading comma", cf(",203.0.113.60")],
      ["whitespace-only extra element", cf("203.0.113.60, ")],
      ["not an address", cf("not-an-ip", forged)],
      ["address with port", cf("203.0.113.60:443")],
      ["bracketed IPv6", cf("[2001:db8::1]")],
      ["out-of-range IPv4", cf("203.0.113.999")],
    ] as Array<[string, Record<string, string>]>)(
      "%s: 403 with the CORRECT password, no session, no limiter row",
      async (_name, headers) => {
        const before = await sessionCount();
        const res = await signIn(headers, PASSWORD);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          code: "CLIENT_IP_REQUIRED",
          message: "Request rejected.",
        });
        expect(res.headers.getSetCookie()).toEqual([]);
        expect(await sessionCount()).toBe(before);
        expect(await buckets()).toEqual([]); // neither "no-trusted-ip" nor the library's 127.0.0.1 test fallback
      },
    );

    it("a repeated CF-Connecting-IP header is rejected", async () => {
      const headers = new Headers({
        "content-type": "application/json",
        origin: TEST_AUTH_ENV.origin,
      });
      headers.append("cf-connecting-ip", "203.0.113.61");
      headers.append("cf-connecting-ip", "203.0.113.62");
      const res = await route.POST(
        new Request(`${TEST_AUTH_ENV.origin}/api/auth/sign-in/email`, {
          method: "POST",
          headers,
          body: JSON.stringify({ email: "ip.user@example.com", password: PASSWORD }),
        }),
      );
      expect(res.status).toBe(403);
      expect(await buckets()).toEqual([]);
    });

    it("a repeated header with one valid and one empty copy is rejected", async () => {
      const before = await sessionCount();
      for (const [first, second] of [
        ["203.0.113.64", ""],
        ["", "203.0.113.64"],
      ] as const) {
        const headers = new Headers({
          "content-type": "application/json",
          origin: TEST_AUTH_ENV.origin,
        });
        headers.append("cf-connecting-ip", first);
        headers.append("cf-connecting-ip", second);
        const res = await route.POST(
          new Request(`${TEST_AUTH_ENV.origin}/api/auth/sign-in/email`, {
            method: "POST",
            headers,
            body: JSON.stringify({ email: "ip.user@example.com", password: PASSWORD }),
          }),
        );
        expect(res.status).toBe(403);
      }
      expect(await sessionCount()).toBe(before);
      expect(await buckets()).toEqual([]);
    });

    it("every method and path of the mount is guarded, and rejected requests cannot fill a shared bucket", async () => {
      const bare = (method: "GET" | "POST", path: string) =>
        route[method](
          new Request(`${TEST_AUTH_ENV.origin}/api/auth${path}`, {
            method,
            headers: { origin: TEST_AUTH_ENV.origin, ...forged },
          }),
        );
      for (let i = 0; i < 8; i++) expect((await signIn(forged)).status).toBe(403);
      expect((await bare("GET", "/get-session")).status).toBe(403);
      expect((await bare("GET", "/list-sessions")).status).toBe(403);
      expect((await bare("POST", "/sign-out")).status).toBe(403);
      expect((await bare("POST", "/sign-up/email")).status).toBe(403);
      expect(await buckets()).toEqual([]);
      // a client with a trusted IP is unaffected by all of the above
      expect((await signIn(cf("203.0.113.63"), PASSWORD)).status).toBe(200);
    });

    it("rejections log one fixed event: no password, email, cookie or header value", async () => {
      await signIn(
        cf("MARKER-198.51.100.77, 10.0.0.1", { cookie: "session=MARKER-cookie" }),
        PASSWORD,
      );
      await signIn({ "x-forwarded-for": "MARKER-xff" }, PASSWORD);
      const events = logs
        .filter((l) => l.includes("auth.client_ip_rejected"))
        .map((l) => JSON.parse(l));
      expect(events.map((e) => [e.outcome, e.reason])).toEqual([
        ["denied", "invalid"],
        ["denied", "missing"],
      ]);
      const all = logs.join("\n");
      expect(all).not.toContain("MARKER");
      expect(all).not.toContain(PASSWORD);
      expect(all).not.toContain("ip.user@example.com");
      expect(all).not.toContain("10.0.0.1");
    });
  });

  describe("session IP integrity", () => {
    it("a session records the trusted IP, never a forged forwarding header", async () => {
      await provisionUser(a, t, "ip.v4@example.com", { organizationId: orgId, role: "STAFF" });
      const res = await signIn(
        cf("203.0.113.70", {
          "x-forwarded-for": "198.51.100.1",
          "x-real-ip": "198.51.100.2",
          forwarded: "for=198.51.100.3",
        }),
        PASSWORD,
        "ip.v4@example.com",
      );
      expect(res.status).toBe(200);
      expect(await sessionIps("ip.v4@example.com")).toEqual(["203.0.113.70"]);
    });

    it("IPv6 is recorded as its /64 and IPv4-mapped IPv6 as IPv4", async () => {
      await provisionUser(a, t, "ip.v6@example.com", { organizationId: orgId, role: "STAFF" });
      await signIn(cf("2001:DB8:AB:CD:1:2:3:4"), PASSWORD, "ip.v6@example.com");
      await signIn(cf("::ffff:203.0.113.71"), PASSWORD, "ip.v6@example.com");
      expect(await sessionIps("ip.v6@example.com")).toEqual([
        "2001:0db8:00ab:00cd:0000:0000:0000:0000",
        "203.0.113.71",
      ]);
    });

    it("sign-in, session use and logout keep working; the role is unchanged", async () => {
      const user = await provisionUser(a, t, "ip.flow@example.com", {
        organizationId: orgId,
        role: "ADMIN",
      });
      const cookie = cookieOf(await signIn(cf("203.0.113.72"), PASSWORD, "ip.flow@example.com"));
      expect(await requireAccess(headersWith(cookie), { db: t.db, auth: getAuth() })).toMatchObject(
        {
          userId: user.id,
          organizationId: orgId,
          role: "ADMIN",
        },
      );
      const session = await route.GET(
        authRequest("/get-session", { method: "GET", headers: { cookie }, ip: "203.0.113.73" }),
      );
      expect(((await session.json()) as { user: { id: string } }).user.id).toBe(user.id);
      // using the session from another address does not rewrite the recorded IP
      expect(await sessionIps("ip.flow@example.com")).toEqual(["203.0.113.72"]);
      expect(
        (await route.POST(authRequest("/sign-out", { body: {}, headers: { cookie } }))).status,
      ).toBe(200);
      expect(await sessionIps("ip.flow@example.com")).toEqual([]);
    });
  });

  describe("POST /api/account/change-password (issues the replacement session)", () => {
    const changeRequest = (cookie: string, headers: Record<string, string>) =>
      change.POST(
        new Request(`${TEST_AUTH_ENV.origin}/api/account/change-password`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: TEST_AUTH_ENV.origin,
            cookie,
            ...headers,
          },
          body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
        }),
      );

    it("without a trusted client IP: 403, the password and the session are untouched", async () => {
      await provisionUser(a, t, "ip.change@example.com", { organizationId: orgId, role: "STAFF" });
      const cookie = cookieOf(await signIn(cf("203.0.113.80"), PASSWORD, "ip.change@example.com"));
      for (const headers of [
        { "x-forwarded-for": "198.51.100.1" },
        cf("203.0.113.80, 10.0.0.1"),
        cf("203.0.113.80,"),
        cf(",203.0.113.80"),
        cf("203.0.113.80, "),
      ] as Array<Record<string, string>>) {
        const res = await changeRequest(cookie, headers);
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
      }
      // a repeated header: one valid copy, one empty
      const repeated = new Headers({
        "content-type": "application/json",
        origin: TEST_AUTH_ENV.origin,
        cookie,
      });
      repeated.append("cf-connecting-ip", "203.0.113.80");
      repeated.append("cf-connecting-ip", "");
      const res = await change.POST(
        new Request(`${TEST_AUTH_ENV.origin}/api/account/change-password`, {
          method: "POST",
          headers: repeated,
          body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
        }),
      );
      expect(res.status).toBe(403);
      expect(await buckets()).toEqual([{ key: "203.0.113.80|/sign-in/email", count: 1 }]); // only the sign-in above
      expect(await sessionIps("ip.change@example.com")).toEqual(["203.0.113.80"]);
      expect((await signIn(cf("203.0.113.81"), PASSWORD, "ip.change@example.com")).status).toBe(
        200,
      );
    });

    it("with one: the password is replaced and the new session records the trusted IP, not a forged header", async () => {
      await provisionUser(a, t, "ip.change2@example.com", { organizationId: orgId, role: "STAFF" });
      const cookie = cookieOf(await signIn(cf("203.0.113.82"), PASSWORD, "ip.change2@example.com"));
      const res = await changeRequest(
        cookie,
        cf("::ffff:203.0.113.83", { "x-forwarded-for": "198.51.100.1", "user-agent": "p3-test" }),
      );
      expect(res.status).toBe(200);
      const replacement = cookieOf(res);
      expect(replacement).toContain("session_token=");
      expect(await sessionIps("ip.change2@example.com")).toEqual(["203.0.113.83"]); // old sessions revoked
      expect(
        (await requireAccess(headersWith(replacement), { db: t.db, auth: getAuth() })).role,
      ).toBe("STAFF");
      expect((await signIn(cf("203.0.113.84"), PASSWORD, "ip.change2@example.com")).status).toBe(
        401,
      );
      expect(
        (await signIn(cf("203.0.113.84"), NEW_PASSWORD, "ip.change2@example.com")).status,
      ).toBe(200);
    });
  });
});
