import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import {
  PASSWORD,
  authRequest,
  headersWith,
  login,
  provisionUser,
  realAuth,
  serviceDb,
  type RealAuth,
} from "@/db/__tests__/real-auth";
import {
  PasswordChangeIncompleteError,
  PasswordChangeRequiredError,
  UnauthenticatedError,
  ValidationError,
} from "@/shared/errors/http-errors";
import { requireAccess, requireUser } from "./access";
import { getPageAccess, pageRedirectFor } from "./page-access";
import { changeOwnPassword, getPasswordChangeStatus } from "./password-change";

let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const NEW_PASSWORD = "my-own-new-password-123";
const THIRD_PASSWORD = "another-fresh-password-456";
const SCRYPT_HASH = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

describe("forced password change (real PostgreSQL + Better Auth)", () => {
  let t: TestDb;
  let a: RealAuth;
  let orgId: string;
  const logs: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    a = realAuth(t);
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
    await t.close();
  });

  const deps = () => ({ db: t.db, auth: a.pub });
  async function flaggedUser(required = true) {
    const email = `pw-${uniq()}@example.com`;
    const user = await provisionUser(a, t, email, { organizationId: orgId, role: "STAFF" });
    if (required)
      await t.db
        .insert(schema.userSecurityState)
        .values({ userId: user.id, passwordChangeRequired: true });
    const cookie = await login(a, email); // sign-in itself is allowed: the flag gates application access
    return { user, email, cookie, headers: headersWith(cookie) };
  }
  const flag = async (userId: string) =>
    (
      await t.db
        .select()
        .from(schema.userSecurityState)
        .where(eq(schema.userSecurityState.userId, userId))
    )[0]?.passwordChangeRequired;
  const hash = async (userId: string) =>
    (
      await t.pool.query(
        "select password from accounts where user_id = $1 and provider_id = 'credential'",
        [userId],
      )
    ).rows[0].password as string;
  const signInStatus = async (email: string, password: string) =>
    (await a.pub.handler(authRequest("/sign-in/email", { body: { email, password } }))).status;
  const cookieOf = (h: Headers) =>
    h
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  async function rejection(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected rejection");
  }

  it("a required user is blocked from normal application access but can reach the password-change flow", async () => {
    const u = await flaggedUser();
    await expect(requireAccess(u.headers, deps())).rejects.toBeInstanceOf(
      PasswordChangeRequiredError,
    );
    const page = await getPageAccess(u.headers, deps());
    expect(page.status).toBe("password_change_required");
    expect(pageRedirectFor("password_change_required")).toBe("/change-password");
    expect(await getPasswordChangeStatus(u.headers, deps())).toBe("required");
    expect((await requireUser(u.headers, deps())).userId).toBe(u.user.id); // the flow only needs a session
  });

  it("status helper: unauthenticated, not required (missing row) and required", async () => {
    expect(await getPasswordChangeStatus(new Headers(), deps())).toBe("unauthenticated");
    const free = await flaggedUser(false);
    expect(await getPasswordChangeStatus(free.headers, deps())).toBe("not_required");
  });

  it("requires a valid session", async () => {
    expect(
      await rejection(
        changeOwnPassword(
          new Headers(),
          { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
          deps(),
        ),
      ),
    ).toBeInstanceOf(UnauthenticatedError);
  });

  it("a wrong current password fails and leaves the flag set and the password unchanged", async () => {
    const u = await flaggedUser();
    const before = await hash(u.user.id);
    const err = await rejection(
      changeOwnPassword(
        u.headers,
        { currentPassword: "not-my-password-1", newPassword: NEW_PASSWORD },
        deps(),
      ),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fields).toEqual(["currentPassword"]);
    expect(await flag(u.user.id)).toBe(true);
    expect(await hash(u.user.id)).toBe(before);
    expect(await signInStatus(u.email, PASSWORD)).toBe(200);
  });

  it("rejects short/long new passwords and unexpected fields before any change", async () => {
    const u = await flaggedUser();
    const before = await hash(u.user.id);
    for (const bad of [
      { currentPassword: PASSWORD, newPassword: "short" },
      { currentPassword: PASSWORD, newPassword: "x".repeat(129) },
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, passwordChangeRequired: false },
      {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        userId: "00000000-0000-4000-8000-000000000000",
      },
      { newPassword: NEW_PASSWORD },
    ]) {
      expect(await rejection(changeOwnPassword(u.headers, bad, deps()))).toBeInstanceOf(
        ValidationError,
      );
    }
    expect(await flag(u.user.id)).toBe(true);
    expect(await hash(u.user.id)).toBe(before);
  });

  it("succeeds with the right current password: password changed by Better Auth, flag cleared, new session works", async () => {
    const u = await flaggedUser();
    const second = await login(a, u.email); // another session that must be revoked
    const before = await hash(u.user.id);
    logs.length = 0;

    const result = await changeOwnPassword(
      u.headers,
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      deps(),
    );

    expect(result.flagCleared).toBe(true);
    expect(await flag(u.user.id)).toBe(false);
    const after = await hash(u.user.id);
    expect(after).not.toBe(before);
    expect(after).toMatch(SCRYPT_HASH);
    expect(after).not.toContain(NEW_PASSWORD);
    // old password dead, new password works
    expect(await signInStatus(u.email, PASSWORD)).toBe(401);
    // session behaviour: Better Auth revoked ALL sessions and issued a replacement cookie
    const replacement = cookieOf(result.headers);
    expect(replacement).toContain("session_token=");
    await expect(requireAccess(u.headers, deps())).rejects.toBeInstanceOf(UnauthenticatedError); // old cookie revoked
    await expect(requireAccess(headersWith(second), deps())).rejects.toBeInstanceOf(
      UnauthenticatedError,
    ); // other session revoked
    // normal access succeeds afterwards with the replacement session
    const ctx = await requireAccess(headersWith(replacement), deps());
    expect(ctx.userId).toBe(u.user.id);
    expect(await getPasswordChangeStatus(headersWith(replacement), deps())).toBe("not_required");
    expect(await signInStatus(u.email, NEW_PASSWORD)).toBe(200);

    // event emitted, no secrets
    const all = logs.join("\n");
    expect(all).toContain("auth.password_changed");
    for (const secret of [PASSWORD, NEW_PASSWORD, replacement.split("=")[1] ?? "x"])
      expect(all).not.toContain(secret.slice(0, 20));
  });

  it("ORDERING: the flag is still set while Better Auth performs the change, and is cleared only after it succeeds", async () => {
    const u = await flaggedUser();
    const observed: Array<boolean | undefined> = [];
    const original = a.pub.api.changePassword;
    const spy = vi.spyOn(a.pub.api, "changePassword").mockImplementation((async (args: never) => {
      observed.push(await flag(u.user.id)); // state at the moment Better Auth runs
      return original(args);
    }) as never);
    try {
      await changeOwnPassword(
        u.headers,
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        deps(),
      );
    } finally {
      spy.mockRestore();
    }
    expect(observed).toEqual([true]);
    expect(await flag(u.user.id)).toBe(false);
  });

  it("a Better Auth failure never clears the flag", async () => {
    const u = await flaggedUser();
    const spy = vi
      .spyOn(a.pub.api, "changePassword")
      .mockRejectedValue(new Error("auth down") as never);
    try {
      await expect(
        changeOwnPassword(
          u.headers,
          { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
          deps(),
        ),
      ).rejects.toThrow("auth down");
    } finally {
      spy.mockRestore();
    }
    expect(await flag(u.user.id)).toBe(true);
    expect(await signInStatus(u.email, PASSWORD)).toBe(200);
  });

  it("FAIL-CLOSED: if clearing the flag fails after Better Auth succeeded, the user stays blocked and a retry completes it", async () => {
    const u = await flaggedUser();
    const sdb = serviceDb(t);
    const spy = vi.spyOn(sdb, "update").mockImplementation((() => {
      throw new Error("simulated flag-clear failure");
    }) as never);
    let err: unknown;
    try {
      err = await rejection(
        changeOwnPassword(
          u.headers,
          { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
          { db: sdb, auth: a.pub },
        ),
      );
    } finally {
      spy.mockRestore();
    }
    expect(err).toBeInstanceOf(PasswordChangeIncompleteError);
    // password HAS changed, but the user is still blocked
    expect(await flag(u.user.id)).toBe(true);
    expect(await signInStatus(u.email, PASSWORD)).toBe(401);
    expect(await signInStatus(u.email, NEW_PASSWORD)).toBe(200);
    const fresh = await login(a, u.email, NEW_PASSWORD);
    await expect(requireAccess(headersWith(fresh), deps())).rejects.toBeInstanceOf(
      PasswordChangeRequiredError,
    );

    // retry: the password they just set is the "current" one
    const retry = await changeOwnPassword(
      headersWith(fresh),
      { currentPassword: NEW_PASSWORD, newPassword: THIRD_PASSWORD },
      deps(),
    );
    expect(await flag(u.user.id)).toBe(false);
    expect((await requireAccess(headersWith(cookieOf(retry.headers)), deps())).userId).toBe(
      u.user.id,
    );
    expect(await signInStatus(u.email, THIRD_PASSWORD)).toBe(200);
    expect(JSON.stringify(logs)).not.toContain(NEW_PASSWORD);
  });

  it("a user with nothing pending (no security-state row) can also change their own password", async () => {
    const u = await flaggedUser(false);
    const result = await changeOwnPassword(
      u.headers,
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      deps(),
    );
    expect(result.flagCleared).toBe(true);
    expect(await signInStatus(u.email, NEW_PASSWORD)).toBe(200);
  });

  it("never wrote a password, hash or session token to the logs", () => {
    const all = logs.join("\n");
    for (const secret of [PASSWORD, NEW_PASSWORD, THIRD_PASSWORD])
      expect(all).not.toContain(secret);
    expect(all).not.toMatch(/[0-9a-f]{32}:[0-9a-f]{128}/);
  });
});
