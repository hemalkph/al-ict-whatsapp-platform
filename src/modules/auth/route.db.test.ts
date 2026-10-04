import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";
import { createTestDatabase, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import {
  PASSWORD,
  authRequest,
  headersWith,
  provisionUser,
  realAuth,
  useGlobalAuth,
  type RealAuth,
} from "@/db/__tests__/real-auth";
import { getAccessSummary, getPageAccess, requireAccess } from "@/modules/access";
import { UnauthenticatedError } from "@/shared/errors/http-errors";
import { PUBLIC_DISABLED_PATHS, getAuth } from "./index";
import { getProvisioningAuth } from "./provisioning";

type RouteModule = typeof import("../../app/api/auth/[...all]/route");

describe("/api/auth/[...all] route with the real public instance", () => {
  let t: TestDb;
  let a: RealAuth;
  let route: RouteModule;
  let release: () => Promise<void>;
  let orgId: string;
  const logs: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    a = realAuth(t);
    release = useGlobalAuth(t);
    route = await import("../../app/api/auth/[...all]/route");
    orgId = (await seedOrg(t.db)).id;
    for (const m of ["log", "warn", "error"] as const) {
      spies.push(
        vi
          .spyOn(console, m)
          .mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))),
      );
    }
  });
  afterAll(async () => {
    spies.forEach((s) => s.mockRestore());
    await release();
    await t.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    route.POST(authRequest(path, { body, headers }));
  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  const deps = () => ({ db: t.db, auth: getAuth() });

  describe("mounting and the private provisioner boundary", () => {
    it("exposes the standard method handlers", () => {
      for (const m of ["GET", "POST", "PATCH", "PUT", "DELETE"] as const)
        expect(typeof route[m]).toBe("function");
    });

    it("imports only the public auth API: no private provisioner reachable from the route source", () => {
      const source = readFileSync(
        new URL("../../app/api/auth/[...all]/route.ts", import.meta.url),
        "utf8",
      );
      const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)]
        .map((m) => m[1])
        .sort();
      expect(imports).toEqual(["@/modules/auth", "better-auth/next-js"]);
      expect(source.replace(/\/\/.*$/gm, "")).not.toMatch(/provision/i); // code only, comments stripped
    });

    it("the instance behind the route is not the provisioning instance and exposes no sign-up", async () => {
      expect(getAuth()).not.toBe(getProvisioningAuth());
      expect(getAuth().options.emailAndPassword?.disableSignUp).toBe(true);
      expect(getProvisioningAuth().options.emailAndPassword?.disableSignUp).toBe(false);
    });

    it("provisioner-only capabilities are not reachable over HTTP (sign-up, reset request, admin create-user)", async () => {
      const before = (await t.pool.query("select count(*)::int n from users")).rows[0].n;
      for (const path of [
        "/sign-up/email",
        "/request-password-reset",
        "/reset-password",
        "/admin/create-user",
        "/set-password",
      ]) {
        const res = await post(path, {
          name: "M",
          email: "mallory@example.com",
          password: PASSWORD,
          newPassword: PASSWORD,
          token: "x",
        });
        expect(res.status, path).toBe(404);
      }
      expect((await t.pool.query("select count(*)::int n from users")).rows[0].n).toBe(before);
    });

    it.each([...PUBLIC_DISABLED_PATHS])("keeps %s closed through the route", async (path) => {
      expect((await post(path, {})).status).toBe(404);
    });
  });

  describe("sign-in through the route", () => {
    it("signs in a user with an ACTIVE membership (case-insensitive email) and sets a session cookie", async () => {
      await provisionUser(a, t, "route.user@example.com", { organizationId: orgId, role: "STAFF" });
      const res = await post("/sign-in/email", {
        email: "ROUTE.User@Example.com",
        password: PASSWORD,
      });
      expect(res.status).toBe(200);
      expect(cookieOf(res)).toContain("session_token=");
      const set = res.headers.getSetCookie().join(";");
      expect(set).toMatch(/HttpOnly/i);
      expect(set).toMatch(/SameSite=Lax/i);
    });

    it("gives the SAME generic failure for a wrong password, an unknown user and a user without membership", async () => {
      await provisionUser(a, t, "nomembership@example.com"); // credentials valid, no membership
      const wrong = await post("/sign-in/email", {
        email: "route.user@example.com",
        password: "wrong-wrong-wrong-1",
      });
      const unknown = await post("/sign-in/email", {
        email: "ghost@example.com",
        password: "wrong-wrong-wrong-1",
      });
      const noMembership = await post("/sign-in/email", {
        email: "nomembership@example.com",
        password: PASSWORD,
      });
      expect([wrong.status, unknown.status, noMembership.status]).toEqual([401, 401, 401]);
      expect(await wrong.json()).toEqual(await unknown.json());
      // the no-membership user never obtains a session
      expect(
        (
          await t.pool.query(
            "select count(*)::int n from sessions s join users u on u.id = s.user_id where u.email = 'nomembership@example.com'",
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it("an authenticated normal user reaches the protected application (access context, page access, summary)", async () => {
      const user = await provisionUser(a, t, "landing@example.com", {
        organizationId: orgId,
        role: "ADMIN",
      });
      const res = await post("/sign-in/email", {
        email: "landing@example.com",
        password: PASSWORD,
      });
      const headers = headersWith(cookieOf(res));
      const ctx = await requireAccess(headers, deps());
      expect(ctx).toMatchObject({ userId: user.id, organizationId: orgId, role: "ADMIN" });
      const page = await getPageAccess(headers, deps());
      expect(page.status).toBe("ok");
      const summary = await getAccessSummary(ctx, { db: t.db });
      expect(summary).toEqual({ userName: "Test User", organizationName: "Org", role: "ADMIN" });
    });
  });

  describe("logout", () => {
    it("invalidates the DATABASE session and protected access is denied afterwards", async () => {
      await provisionUser(a, t, "logout@example.com", { organizationId: orgId, role: "STAFF" });
      const login = await post("/sign-in/email", {
        email: "logout@example.com",
        password: PASSWORD,
      });
      const cookie = cookieOf(login);
      const headers = headersWith(cookie);
      expect((await requireAccess(headers, deps())).role).toBe("STAFF");
      const before = (
        await t.pool.query(
          "select count(*)::int n from sessions s join users u on u.id = s.user_id where u.email = 'logout@example.com'",
        )
      ).rows[0].n;
      expect(before).toBe(1);

      const out = await post("/sign-out", {}, { cookie });
      expect(out.status).toBe(200);

      const after = (
        await t.pool.query(
          "select count(*)::int n from sessions s join users u on u.id = s.user_id where u.email = 'logout@example.com'",
        )
      ).rows[0].n;
      expect(after).toBe(0); // the row is gone, not merely a cleared client cookie
      await expect(requireAccess(headers, deps())).rejects.toBeInstanceOf(UnauthenticatedError); // the OLD cookie no longer works
      expect((await getPageAccess(headers, deps())).status).toBe("unauthenticated");
    });
  });

  describe("proxy is optimistic only", () => {
    it("a forged cookie passes the proxy but is rejected by the real requireAccess", async () => {
      const cookie = "better-auth.session_token=forged-value.signature";
      const passed = proxy(new NextRequest("http://localhost:3000/", { headers: { cookie } }));
      expect(passed.headers.get("x-middleware-next")).toBe("1"); // optimistic: cookie present
      await expect(requireAccess(headersWith(cookie), deps())).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    });

    it("a stale cookie (session deleted server-side) passes the proxy but fails the real check", async () => {
      await provisionUser(a, t, "stale@example.com", { organizationId: orgId, role: "STAFF" });
      const cookie = cookieOf(
        await post("/sign-in/email", { email: "stale@example.com", password: PASSWORD }),
      );
      await t.pool.query(
        "delete from sessions where user_id = (select id from users where email = 'stale@example.com')",
      );
      expect(
        proxy(new NextRequest("http://localhost:3000/", { headers: { cookie } })).headers.get(
          "x-middleware-next",
        ),
      ).toBe("1");
      await expect(requireAccess(headersWith(cookie), deps())).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    });

    it("no cookie: the proxy redirects page requests to /login", () => {
      const res = proxy(new NextRequest("http://localhost:3000/"));
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    });
  });

  describe("security events", () => {
    it("emits login success/failure and logout events without passwords, tokens, cookies or bodies", async () => {
      logs.length = 0;
      await provisionUser(a, t, "events@example.com", { organizationId: orgId, role: "STAFF" });
      const ok = await post("/sign-in/email", { email: "events@example.com", password: PASSWORD });
      await post("/sign-in/email", {
        email: "events@example.com",
        password: "definitely-wrong-password",
      });
      await post("/sign-out", {}, { cookie: cookieOf(ok) });

      const events = logs.filter((l) => l.includes("security_event")).map((l) => JSON.parse(l));
      const names = events.map((e) => e.security_event);
      expect(names).toEqual(
        expect.arrayContaining(["auth.login_succeeded", "auth.login_failed", "auth.logout"]),
      );
      expect(events.find((e) => e.security_event === "auth.login_succeeded").user_id).toBeTruthy();
      const failed = events.find((e) => e.security_event === "auth.login_failed");
      expect(failed.email_hash).toMatch(/^[0-9a-f]{16}$/);
      expect(failed.reason).toBe("http_401");

      const all = logs.join("\n");
      expect(all).not.toContain(PASSWORD);
      expect(all).not.toContain("definitely-wrong-password");
      expect(all).not.toContain("events@example.com");
      expect(all).not.toMatch(/session_token/);
      expect(all).not.toContain(cookieOf(ok).split("=")[1]?.slice(0, 20) ?? "never");
    });
  });
});
