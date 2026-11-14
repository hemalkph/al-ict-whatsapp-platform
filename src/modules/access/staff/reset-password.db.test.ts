import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

// Concurrency and failure behavior of administrator password reset. Since Phase 08G-7B C1A (P1) the reset is ONE
// transaction: Better Auth's hashPassword runs first, then the actor re-check, the user row lock, the credential write,
// the flag + credential generation and the session revocation commit together. No reset token is ever issued.

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

describe("administrator password reset: concurrency and token lifecycle (real PostgreSQL + Better Auth)", () => {
  let t: TestDb;
  let a: RealAuth;
  const logs: string[] = [];
  const consoleSpies: Array<{ mockRestore(): void }> = [];

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
  });
  afterAll(async () => {
    consoleSpies.forEach((s) => s.mockRestore());
    await t.close();
  });

  const deps = () => ({ db: t.db });
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
  const generation = async (userId: string) =>
    (
      await t.db
        .select()
        .from(schema.userSecurityState)
        .where(eq(schema.userSecurityState.userId, userId))
    )[0]?.credentialGeneration ?? 0;
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

  it("DIFFERENT users reset concurrently: each gets exactly its own password; no reset token is ever issued", async () => {
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

      const results = await Promise.all(
        targets.map((target, i) =>
          resetStaffPassword(
            admin.ctx,
            { membershipId: target.membershipId, newPassword: passwords[i]! },
            deps(),
          ),
        ),
      );

      // the service returns no password
      const returned = JSON.stringify(results);
      for (const p of passwords) expect(returned).not.toContain(p);

      // committed state first (before any new login creates a session)
      for (const target of targets) {
        expect(await flag(target.userId)).toBe(true);
        expect(await generation(target.userId)).toBe(1);
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

  it("SAME user reset concurrently by two administrators: both complete in order, the last writer wins, auth state stays valid", async () => {
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
      // serialized on the organization and user row locks: both commit, one after the other
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

      expect(await flag(target.userId)).toBe(true);
      expect(await generation(target.userId)).toBe(2);
      expect(await sessionCount(target.userId)).toBe(0);
      expect(await credentialHash(target.userId)).toMatch(SCRYPT_HASH);
      expect(await resetTokenRows()).toBe(0);

      // exactly one of the two passwords is now valid (the last committed reset); the old one is not
      expect(await signIn(target.email, PASSWORD)).toBe(401);
      const statuses = [await signIn(target.email, p1), await signIn(target.email, p2)];
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 401)).toHaveLength(1);
    }
  });

  describe("failure inside the reset transaction", () => {
    it("changes NOTHING (old password, flag, generation, sessions), exposes no password, and a retry succeeds", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const target = await member(orgId, "STAFF");
      await login(a, target.email);
      await login(a, target.email);
      const hashBefore = await credentialHash(target.userId);

      // Fault injection: the session revocation (after the credential write, in the same transaction) fails.
      await t.pool.query(`
        create function c1a_fail_session_delete() returns trigger language plpgsql as $$
        begin raise exception 'injected failure after the credential write'; end $$;
        create trigger c1a_fail_session_delete_trg before delete on sessions
          for each row execute function c1a_fail_session_delete();`);
      let failure: unknown;
      try {
        await resetStaffPassword(
          admin.ctx,
          { membershipId: target.membershipId, newPassword: "failed-attempt-password-1" },
          deps(),
        );
      } catch (e) {
        failure = e;
      } finally {
        await t.pool.query(
          "drop trigger c1a_fail_session_delete_trg on sessions; drop function c1a_fail_session_delete();",
        );
      }
      expect(failure).toBeInstanceOf(PasswordResetIncompleteError);
      const body = await toErrorResponse(failure).text();
      expect(body).not.toContain("failed-attempt-password-1");

      // rolled back as a whole: nothing about the account changed
      expect(await credentialHash(target.userId)).toBe(hashBefore);
      expect(await flag(target.userId)).toBeUndefined();
      expect(await generation(target.userId)).toBe(0);
      expect(await sessionCount(target.userId)).toBe(2);
      expect(await signIn(target.email, "failed-attempt-password-1")).toBe(401);
      expect(await signIn(target.email, PASSWORD)).toBe(200);
      expect(await resetTokenRows()).toBe(0);

      // retry with a new administrator-provided password succeeds
      await resetStaffPassword(
        admin.ctx,
        { membershipId: target.membershipId, newPassword: "retry-admin-password-2" },
        deps(),
      );
      expect(await signIn(target.email, "retry-admin-password-2")).toBe(200);
      expect(await signIn(target.email, PASSWORD)).toBe(401);
      expect(await flag(target.userId)).toBe(true);
      expect(await generation(target.userId)).toBe(1);
    });
  });

  it("no password appeared in any log during this file", () => {
    const all = logs.join("\n");
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
