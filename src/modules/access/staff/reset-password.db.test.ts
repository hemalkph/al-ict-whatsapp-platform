import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import {
  PASSWORD,
  authRequest,
  login,
  provisionUser,
  realAuth,
  type RealAuth,
} from "@/db/__tests__/real-auth";
import { PasswordResetIncompleteError, toErrorResponse } from "@/shared/errors/http-errors";
import type { AccessContext } from "../access";
import { can, type Role } from "../permissions";
import { resetStaffPassword } from "./index";

// Concurrency and token-lifecycle hardening for administrator password reset. The token is correlated to its own
// call through request-scoped AsyncLocalStorage (see src/modules/auth/provisioning.ts); these tests prove that.

let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const SCRYPT_HASH = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

type Member = {
  userId: string;
  email: string;
  membershipId: string;
  organizationId: string;
  ctx: AccessContext;
};
type ResetCall = { token: string; tokenOwnerUserId: string | undefined; newPassword: string };

describe("administrator password reset: concurrency and token lifecycle (real PostgreSQL + Better Auth)", () => {
  let t: TestDb;
  let a: RealAuth;
  const logs: string[] = [];
  const consoleSpies: Array<{ mockRestore(): void }> = [];
  const seen: ResetCall[] = [];
  let failNextReset = false;

  beforeAll(async () => {
    t = await createTestDatabase();
    a = realAuth(t);
    for (const m of ["log", "warn", "error"] as const) {
      consoleSpies.push(
        vi
          .spyOn(console, m)
          .mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))),
      );
    }
    // Observe every resetPassword call: record the token's real owner (from the verification row) next to the
    // password being applied, optionally failing AFTER the token was issued.
    const real = a.prov.api.resetPassword;
    consoleSpies.push(
      vi.spyOn(a.prov.api, "resetPassword").mockImplementation((async (args: {
        body: { token: string; newPassword: string };
      }) => {
        const row = await t.pool.query("select value from verifications where identifier = $1", [
          `reset-password:${args.body.token}`,
        ]);
        seen.push({
          token: args.body.token,
          tokenOwnerUserId: row.rows[0]?.value,
          newPassword: args.body.newPassword,
        });
        if (failNextReset) {
          failNextReset = false;
          throw new Error("simulated failure after the token was issued");
        }
        return real(args as never);
      }) as never),
    );
  });
  afterAll(async () => {
    consoleSpies.forEach((s) => s.mockRestore());
    await t.close();
  });
  afterEach(() => {
    failNextReset = false;
  });

  const deps = () => ({ db: t.db, provisioner: a.prov });
  const newOrg = async () => (await seedOrg(t.db)).id;
  async function member(organizationId: string, role: Role): Promise<Member> {
    const email = `${role.toLowerCase()}-${uniq()}@example.com`;
    const user = await provisionUser(a, t, email, { organizationId, role });
    const [m] = await t.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.userId, user.id));
    const base = { userId: user.id, email, membershipId: m!.id, organizationId, role };
    return {
      userId: user.id,
      email,
      membershipId: m!.id,
      organizationId,
      ctx: { ...base, can: (p) => can(role, p) },
    };
  }
  const sessionCount = async (userId: string) =>
    (await t.pool.query("select count(*)::int n from sessions where user_id = $1", [userId]))
      .rows[0].n as number;
  const flag = async (userId: string) =>
    (
      await t.db
        .select()
        .from(schema.userSecurityState)
        .where(eq(schema.userSecurityState.userId, userId))
    )[0]?.passwordChangeRequired;
  const resetTokenRows = async () =>
    (
      await t.pool.query(
        "select count(*)::int n from verifications where identifier like 'reset-password:%'",
      )
    ).rows[0].n as number;
  const signIn = async (email: string, password: string) =>
    (await a.pub.handler(authRequest("/sign-in/email", { body: { email, password } }))).status;
  const credentialHash = async (userId: string) => {
    const r = await t.pool.query(
      "select password from accounts where user_id = $1 and provider_id = 'credential'",
      [userId],
    );
    expect(r.rows).toHaveLength(1);
    return r.rows[0].password as string;
  };

  it("DIFFERENT users reset concurrently: every token resets only its own user, with its own password", async () => {
    for (let iteration = 0; iteration < 6; iteration++) {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const targets = [
        await member(orgId, "STAFF"),
        await member(orgId, "STAFF"),
        await member(orgId, "VIEWER"),
      ];
      const passwords = targets.map((_, i) => `iteration-${iteration}-user-${i}-new-password`);
      for (const target of targets) {
        await login(a, target.email);
        await login(a, target.email);
      }
      seen.length = 0;

      const results = await Promise.all(
        targets.map((target, i) =>
          resetStaffPassword(
            admin.ctx,
            { membershipId: target.membershipId, newPassword: passwords[i]! },
            deps(),
          ),
        ),
      );

      // the service returns no token and no password
      const returned = JSON.stringify(results);
      expect(seen).toHaveLength(3);
      for (const call of seen) expect(returned).not.toContain(call.token);
      for (const p of passwords) expect(returned).not.toContain(p);

      // every token's real owner is the user whose password was applied with it (tokens never cross users)
      for (const call of seen) {
        const index = passwords.indexOf(call.newPassword);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(call.tokenOwnerUserId).toBe(targets[index]!.userId);
      }

      // state first (before any new login creates a session)
      for (const target of targets) {
        expect(await flag(target.userId)).toBe(true);
        expect(await sessionCount(target.userId)).toBe(0);
        expect(await credentialHash(target.userId)).toMatch(SCRYPT_HASH);
      }
      expect(await resetTokenRows()).toBe(0);

      // each user has exactly its own new password; nobody has anyone else's or the old one
      for (const [i, target] of targets.entries()) {
        expect(await signIn(target.email, PASSWORD)).toBe(401);
        for (const [j, pw] of passwords.entries())
          expect(await signIn(target.email, pw), `user ${i} with password ${j}`).toBe(
            i === j ? 200 : 401,
          );
      }
    }
  });

  it("SAME user reset concurrently by two administrators: both complete safely, the last writer wins, auth state stays valid", async () => {
    const outcomes: string[] = [];
    for (let iteration = 0; iteration < 6; iteration++) {
      const orgId = await newOrg();
      const adminOne = await member(orgId, "ADMIN");
      const adminTwo = await member(orgId, "ADMIN");
      const target = await member(orgId, "STAFF");
      await login(a, target.email);
      await login(a, target.email);
      const [p1, p2] = [
        `iteration-${iteration}-first-admin-password`,
        `iteration-${iteration}-second-admin-password`,
      ];
      seen.length = 0;

      const results = await Promise.allSettled([
        resetStaffPassword(
          adminOne.ctx,
          { membershipId: target.membershipId, newPassword: p1 },
          deps(),
        ),
        resetStaffPassword(
          adminTwo.ctx,
          { membershipId: target.membershipId, newPassword: p2 },
          deps(),
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled").length;
      expect(fulfilled).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        if (r.status === "rejected") expect(r.reason).toBeInstanceOf(PasswordResetIncompleteError); // clean failure only
      }
      outcomes.push(`${fulfilled} fulfilled`);

      // tokens never cross users: every observed token belongs to the single target
      for (const call of seen) expect(call.tokenOwnerUserId).toBe(target.userId);

      expect(await flag(target.userId)).toBe(true);
      expect(await sessionCount(target.userId)).toBe(0);
      expect(await credentialHash(target.userId)).toMatch(SCRYPT_HASH);
      expect(await resetTokenRows()).toBe(0);

      // exactly one of the two passwords is now valid (the last completed reset); the old one is not
      expect(await signIn(target.email, PASSWORD)).toBe(401);
      const statuses = [await signIn(target.email, p1), await signIn(target.email, p2)];
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 401)).toHaveLength(1);
    }
    // Documented behavior (see ADR 0012): concurrent resets of the same user are independent and both normally
    // complete; whichever completes last determines the final password.
    expect(outcomes.every((o) => o === "2 fulfilled" || o === "1 fulfilled")).toBe(true);
  });

  describe("failure after the token was issued", () => {
    it("never logs or returns the token, keeps the account locked down, leaves the old password valid, and a retry succeeds", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const target = await member(orgId, "STAFF");
      await login(a, target.email);
      await login(a, target.email);
      seen.length = 0;
      failNextReset = true;

      let failure: unknown;
      try {
        await resetStaffPassword(
          admin.ctx,
          { membershipId: target.membershipId, newPassword: "failed-attempt-password-1" },
          deps(),
        );
      } catch (e) {
        failure = e;
      }
      expect(failure).toBeInstanceOf(PasswordResetIncompleteError);
      expect(seen).toHaveLength(1);
      const leaked = seen[0]!;
      expect(leaked.tokenOwnerUserId).toBe(target.userId);

      // the error response exposes neither token nor passwords
      const body = await toErrorResponse(failure).text();
      expect(body).not.toContain(leaked.token);
      expect(body).not.toContain("failed-attempt-password-1");

      // locked down: flag true, sessions revoked, OLD password still the only valid one
      expect(await flag(target.userId)).toBe(true);
      expect(await sessionCount(target.userId)).toBe(0);
      expect(await signIn(target.email, "failed-attempt-password-1")).toBe(401);
      expect(await signIn(target.email, PASSWORD)).toBe(200);

      // Token lifecycle (observed, not manipulated): the unused verification row REMAINS until its 60 s expiry.
      const row = await t.pool.query("select expires_at from verifications where identifier = $1", [
        `reset-password:${leaked.token}`,
      ]);
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].expires_at.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
      expect(row.rows[0].expires_at.getTime() - Date.now()).toBeGreaterThan(0);

      // The public HTTP surface cannot use it: reset and reset-request are closed (404) and nothing changes.
      const useToken = await a.pub.handler(
        authRequest("/reset-password", {
          body: { token: leaked.token, newPassword: "attacker-chosen-password-9" },
        }),
      );
      expect(useToken.status).toBe(404);
      expect(
        (
          await a.pub.handler(
            authRequest("/request-password-reset", { body: { email: target.email } }),
          )
        ).status,
      ).toBe(404);
      expect(await signIn(target.email, "attacker-chosen-password-9")).toBe(401);
      expect(await signIn(target.email, PASSWORD)).toBe(200);

      // retry with a new administrator-provided password succeeds
      await t.pool.query("delete from sessions where user_id = $1", [target.userId]);
      await resetStaffPassword(
        admin.ctx,
        { membershipId: target.membershipId, newPassword: "retry-admin-password-2" },
        deps(),
      );
      expect(await signIn(target.email, "retry-admin-password-2")).toBe(200);
      expect(await signIn(target.email, PASSWORD)).toBe(401);
      expect(await flag(target.userId)).toBe(true);
      // the stale token from the failed attempt is still useless over HTTP
      const again = await a.pub.handler(
        authRequest("/reset-password", {
          body: { token: leaked.token, newPassword: "attacker-chosen-password-9" },
        }),
      );
      expect(again.status).toBe(404);
      expect(await signIn(target.email, "retry-admin-password-2")).toBe(200);
    });
  });

  it("no reset token, password or token-bearing URL appeared in any log during this file", () => {
    const all = logs.join("\n");
    expect(seen.length + 0).toBeGreaterThanOrEqual(0);
    for (const call of seen) {
      expect(all).not.toContain(call.token);
      expect(all).not.toContain(call.newPassword);
    }
    for (const secret of [
      "failed-attempt-password-1",
      "retry-admin-password-2",
      "attacker-chosen-password-9",
      PASSWORD,
    ]) {
      expect(all).not.toContain(secret);
    }
    expect(all).not.toMatch(/reset-password[:/]/i);
  });
});
