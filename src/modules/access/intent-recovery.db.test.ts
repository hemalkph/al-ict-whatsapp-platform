import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import { TEST_AUTH_ENV, provisionUser, realAuth, type RealAuth } from "@/db/__tests__/real-auth";
import { ValidationError } from "@/shared/errors/http-errors";
import {
  OperatorRefusedError,
  inspectIntent,
  listIntents,
  removeIntent,
  resumeIntent,
} from "./operator";

let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const DAY = 24 * 60 * 60 * 1000;

describe("stale provisioning-intent recovery (operator tool; real PostgreSQL)", () => {
  let t: TestDb;
  let a: RealAuth;
  const logs: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    a = realAuth(t);
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

  const newOrg = async () => (await seedOrg(t.db)).id;
  // The user's created_at comes from the APPLICATION clock and the intent's from the DATABASE clock, so tests use
  // explicit, generous gaps instead of relying on insert ordering: every intent is back-dated by one hour.
  const HOUR = 60 * 60 * 1000;
  const addIntent = async (
    organizationId: string,
    emailKey: string,
    extra: Partial<typeof schema.staffProvisioningIntents.$inferInsert> = {},
  ) => {
    const [row] = await t.db
      .insert(schema.staffProvisioningIntents)
      .values({ organizationId, emailKey, ...extra })
      .returning();
    const createdAt = new Date(row!.createdAt.getTime() - HOUR);
    await t.pool.query("update staff_provisioning_intents set created_at = $1 where id = $2", [
      createdAt,
      row!.id,
    ]);
    return { ...row!, createdAt };
  };
  const intentCount = async () =>
    (await t.pool.query("select count(*)::int n from staff_provisioning_intents")).rows[0]
      .n as number;
  const membershipCount = async (userId: string) =>
    (
      await t.pool.query(
        "select count(*)::int n from organization_memberships where user_id = $1",
        [userId],
      )
    ).rows[0].n as number;
  async function rejection(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected rejection");
  }
  const email = (l: string) => `${l}-${uniq()}@example.com`;
  const future = (i: { createdAt: Date }, ms: number) => new Date(i.createdAt.getTime() + ms);

  it("lists and inspects a RECOVERABLE intent (same-workflow crash) without changing anything", async () => {
    const orgId = await newOrg();
    const e = email("recoverable");
    const intent = await addIntent(orgId, e);
    const user = await provisionUser(a, t, e); // created AFTER the intent, no membership
    const before = await intentCount();

    const report = await inspectIntent(intent.id, { db: t.db });
    expect(report).toMatchObject({
      intentId: intent.id,
      organizationId: orgId,
      emailKey: e,
      authUserExists: true,
      membershipCount: 0,
      classification: "RECOVERABLE_UNPROVISIONED_USER",
      allowedActions: ["resume"],
    });
    expect(report.authUserId).toBeNull();
    expect((await listIntents({ db: t.db })).some((r) => r.intentId === intent.id)).toBe(true);
    expect(await intentCount()).toBe(before);
    expect(await membershipCount(user.id)).toBe(0);
  });

  it("reports contain identifiers and classification only: no credentials, hashes or tokens", async () => {
    const orgId = await newOrg();
    const e = email("report");
    await addIntent(orgId, e);
    await provisionUser(a, t, e);
    const dump = JSON.stringify(await listIntents({ db: t.db }));
    expect(dump).not.toMatch(/password|hash|token|secret|credential|scrypt/i);
    expect(dump).not.toMatch(/[0-9a-f]{32}:[0-9a-f]{128}/);
  });

  it("RESUME finalizes a provable intent in the INTENT'S organization: membership + forced password change + intent deleted, atomically", async () => {
    const orgId = await newOrg();
    const e = email("resume");
    const intent = await addIntent(orgId, e);
    const user = await provisionUser(a, t, e);
    const res = await resumeIntent(intent.id, { role: "VIEWER" }, { db: t.db });
    expect(res.organizationId).toBe(orgId);
    const [m] = await t.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.userId, user.id));
    expect(m).toMatchObject({ organizationId: orgId, role: "VIEWER", status: "ACTIVE" });
    const [state] = await t.db
      .select()
      .from(schema.userSecurityState)
      .where(eq(schema.userSecurityState.userId, user.id));
    expect(state!.passwordChangeRequired).toBe(true);
    expect(
      await t.pool
        .query("select 1 from staff_provisioning_intents where id = $1", [intent.id])
        .then((r) => r.rowCount),
    ).toBe(0);
  });

  it("RESUME requires a valid explicit role and rejects extra fields", async () => {
    const orgId = await newOrg();
    const e = email("role");
    const intent = await addIntent(orgId, e);
    await provisionUser(a, t, e);
    for (const bad of [{}, { role: "OWNER" }, { role: "ADMIN", organizationId: "x" }]) {
      expect(await rejection(resumeIntent(intent.id, bad, { db: t.db }))).toBeInstanceOf(
        ValidationError,
      );
    }
    expect(await intentCount()).toBeGreaterThan(0);
  });

  it("REFUSES (and changes nothing) when the identity already has a membership in ANOTHER organization", async () => {
    const orgA = await newOrg();
    const orgB = await newOrg();
    const e = email("crossorg");
    const user = await provisionUser(a, t, e, { organizationId: orgB, role: "STAFF" }); // belongs to org B
    const intent = await addIntent(orgA, e);
    const report = await inspectIntent(intent.id, { db: t.db });
    expect(report.classification).toBe("UNSAFE_USER_HAS_MEMBERSHIP");
    expect(report.allowedActions).toEqual([]);
    expect(
      await rejection(resumeIntent(intent.id, { role: "ADMIN" }, { db: t.db })),
    ).toBeInstanceOf(OperatorRefusedError);
    expect(
      await rejection(removeIntent(intent.id, { db: t.db, now: future(intent, 365 * DAY) })),
    ).toBeInstanceOf(OperatorRefusedError);
    expect(await membershipCount(user.id)).toBe(1); // still only org B
    expect(
      await t.pool
        .query("select 1 from staff_provisioning_intents where id = $1", [intent.id])
        .then((r) => r.rowCount),
    ).toBe(1);
  });

  it("REFUSES an auth user that PREDATES the intent (not provably this workflow's identity)", async () => {
    const orgA = await newOrg();
    const e = email("predates");
    const user = await provisionUser(a, t, e); // exists first, no membership
    await t.pool.query("update users set created_at = now() - interval '3 hours' where id = $1", [
      user.id,
    ]);
    const intent = await addIntent(orgA, e); // intent acquired later (an hour ago): the user predates it by 2 hours
    const report = await inspectIntent(intent.id, { db: t.db });
    expect(report.classification).toBe("UNSAFE_USER_PREDATES_INTENT");
    expect(
      await rejection(resumeIntent(intent.id, { role: "STAFF" }, { db: t.db })),
    ).toBeInstanceOf(OperatorRefusedError);
    expect(
      await rejection(removeIntent(intent.id, { db: t.db, now: future(intent, 365 * DAY) })),
    ).toBeInstanceOf(OperatorRefusedError);
    expect(await membershipCount(user.id)).toBe(0);
  });

  it("REFUSES an intent bound to a different auth user than the one holding the email", async () => {
    const orgA = await newOrg();
    const e = email("mismatch");
    const other = await provisionUser(a, t, email("other"));
    const intent = await addIntent(orgA, e, { authUserId: other.id });
    await provisionUser(a, t, e);
    expect((await inspectIntent(intent.id, { db: t.db })).classification).toBe(
      "UNSAFE_INTENT_USER_MISMATCH",
    );
    expect(
      await rejection(resumeIntent(intent.id, { role: "STAFF" }, { db: t.db })),
    ).toBeInstanceOf(OperatorRefusedError);
  });

  it("REMOVE is allowed only when NO auth identity exists, and only once the intent is old enough", async () => {
    const orgId = await newOrg();
    const intent = await addIntent(orgId, email("noauth"));
    const report = await inspectIntent(intent.id, { db: t.db });
    expect(report.classification).toBe("NO_AUTH_USER");
    expect(report.allowedActions).toEqual(["remove"]);
    // a young intent may still be in flight
    expect(
      await rejection(removeIntent(intent.id, { db: t.db, now: future(intent, 60_000) })),
    ).toBeInstanceOf(OperatorRefusedError);
    expect(await intentCount()).toBeGreaterThan(0);
    // old enough: removed
    await removeIntent(intent.id, { db: t.db, now: future(intent, 30 * 60_000) });
    expect(
      await t.pool
        .query("select 1 from staff_provisioning_intents where id = $1", [intent.id])
        .then((r) => r.rowCount),
    ).toBe(0);
  });

  it("NEVER expires or removes by age: listing and inspecting leave even year-old intents untouched; remove refuses when an auth user exists", async () => {
    const orgId = await newOrg();
    const e = email("ancient");
    const intent = await addIntent(orgId, e);
    const user = await provisionUser(a, t, e); // recoverable, not removable
    const before = await intentCount();
    const yearLater = future(intent, 365 * DAY);
    await listIntents({ db: t.db, now: yearLater });
    const report = await inspectIntent(intent.id, { db: t.db, now: yearLater });
    expect(report.ageMinutes).toBeGreaterThan(300_000);
    expect(report.allowedActions).toEqual(["resume"]); // removal is not offered
    expect(await rejection(removeIntent(intent.id, { db: t.db, now: yearLater }))).toBeInstanceOf(
      OperatorRefusedError,
    );
    expect(await intentCount()).toBe(before);
    expect(await membershipCount(user.id)).toBe(0);
  });

  it("another organization can never claim an identity because its intent is old: resume always targets the intent's own organization", async () => {
    const orgA = await newOrg();
    const orgB = await newOrg();
    const e = email("owner");
    const intentA = await addIntent(orgA, e);
    const user = await provisionUser(a, t, e);
    // organization B cannot even create an intent for this email while A's exists
    await expect(addIntent(orgB, e)).rejects.toBeDefined();
    const res = await resumeIntent(intentA.id, { role: "STAFF" }, { db: t.db });
    expect(res.organizationId).toBe(orgA);
    const rows = await t.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.userId, user.id));
    expect(rows.map((r) => r.organizationId)).toEqual([orgA]);
  });

  it("unknown intent ids are refused", async () => {
    expect(
      await rejection(inspectIntent("00000000-0000-4000-8000-000000000000", { db: t.db })),
    ).toBeInstanceOf(OperatorRefusedError);
    expect(
      await rejection(
        resumeIntent("00000000-0000-4000-8000-000000000000", { role: "STAFF" }, { db: t.db }),
      ),
    ).toBeInstanceOf(OperatorRefusedError);
  });

  it("emits recovery security events without secrets", async () => {
    logs.length = 0;
    const orgId = await newOrg();
    const e = email("events");
    const intent = await addIntent(orgId, e);
    await provisionUser(a, t, e);
    await resumeIntent(intent.id, { role: "STAFF" }, { db: t.db });
    const orgB = await newOrg();
    const e2 = email("events2");
    const user2 = await provisionUser(a, t, e2, { organizationId: orgB, role: "STAFF" });
    const intent2 = await addIntent(orgId, e2);
    await rejection(resumeIntent(intent2.id, { role: "STAFF" }, { db: t.db }));
    const names = logs
      .filter((l) => l.includes("security_event"))
      .map((l) => JSON.parse(l).security_event);
    expect(names).toEqual(
      expect.arrayContaining(["provisioning_recovery.resumed", "provisioning_recovery.refused"]),
    );
    expect(logs.join("\n")).not.toMatch(/password|[0-9a-f]{32}:[0-9a-f]{128}/i);
    expect(user2.id).toBeTruthy();
  });

  describe("operator CLI (npm run auth:intents)", { timeout: 120_000 }, () => {
    const env = () =>
      Object.fromEntries(
        Object.entries({
          ...process.env,
          DATABASE_URL: t.url,
          BETTER_AUTH_SECRET: TEST_AUTH_ENV.secret,
          BETTER_AUTH_URL: TEST_AUTH_ENV.baseURL,
          TSX_DISABLE_CACHE: "1", // avoid sharing the tsx on-disk cache between concurrent processes
        }).filter(([, v]) => v !== undefined),
      ) as NodeJS.ProcessEnv;
    const run = (args: string[]) =>
      spawnSync("node_modules/.bin/tsx", ["scripts/auth-intents.ts", ...args], {
        env: env(),
        encoding: "utf8",
        timeout: 90_000,
      });

    it("lists/inspects intents with classifications, refuses unsafe actions, and prints no secrets", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const e = email("cli");
      await provisionUser(a, t, e, { organizationId: orgB, role: "STAFF" });
      const intent = await addIntent(orgA, e);
      const list = run(["list"]);
      expect(list.status, list.stderr).toBe(0);
      expect(list.stdout).toContain("UNSAFE_USER_HAS_MEMBERSHIP");
      expect(list.stdout).toContain(intent.id);
      expect(list.stdout + list.stderr).not.toMatch(/password|[0-9a-f]{32}:[0-9a-f]{128}/i);
      const inspect = run(["inspect", intent.id]);
      expect(inspect.status).toBe(0);
      const resume = run(["resume", intent.id, "--role", "ADMIN"]);
      expect(resume.status).toBe(1);
      expect(resume.stderr).toContain("Refused");
      expect(await intentCount()).toBeGreaterThan(0);
    });

    it("rejects missing arguments with a usage error", () => {
      expect(run(["inspect"]).status).toBe(2);
      expect(run(["bogus", "x"]).status).toBe(2);
    });
  });
});
