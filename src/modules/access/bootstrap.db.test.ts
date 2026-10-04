import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import {
  TEST_AUTH_ENV,
  authRequest,
  headersWith,
  provisionUser,
  realAuth,
  serviceDb,
  type RealAuth,
} from "@/db/__tests__/real-auth";
import { PasswordChangeRequiredError, ValidationError } from "@/shared/errors/http-errors";
import { requireAccess } from "./access";
import { OperatorRefusedError, bootstrapFirstAdmin } from "./operator";

const SCRYPT_HASH = /^[0-9a-f]{32}:[0-9a-f]{128}$/;
const BOOT_PASSWORD = "first-admin-password-1";
const SECOND_PASSWORD = "first-admin-password-2";
const input = (over: Record<string, unknown> = {}) => ({
  organizationName: "A/L ICT Class",
  organizationSlug: "al-ict-class",
  email: "  First.Admin@Example.COM ",
  name: "First Admin",
  password: BOOT_PASSWORD,
  ...over,
});

describe("first-admin bootstrap (real PostgreSQL + Better Auth)", () => {
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
  // every test starts from an EMPTY system
  beforeEach(async () => {
    await t.pool.query(
      "truncate staff_provisioning_intents, user_security_state, organization_memberships, sessions, accounts, verifications, rate_limits, users, organizations cascade",
    );
  });

  const deps = () => ({ db: t.db, provisioner: a.prov });
  const counts = async () =>
    (
      await t.pool.query(
        `select (select count(*)::int from organizations) orgs, (select count(*)::int from users) users,
                (select count(*)::int from organization_memberships) memberships, (select count(*)::int from user_security_state) security,
                (select count(*)::int from staff_provisioning_intents) intents, (select count(*)::int from sessions) sessions,
                (select count(*)::int from accounts) accounts`,
      )
    ).rows[0] as Record<
      "orgs" | "users" | "memberships" | "security" | "intents" | "sessions" | "accounts",
      number
    >;
  async function rejection(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected rejection");
  }
  const signInStatus = async (email: string, password: string) =>
    (await a.pub.handler(authRequest("/sign-in/email", { body: { email, password } }))).status;

  it("bootstraps a clean database: one org, one user, one ADMIN membership, security state true, hashed password, no session", async () => {
    const result = await bootstrapFirstAdmin(input(), deps());
    expect(result.resumed).toBe(false);
    expect(await counts()).toEqual({
      orgs: 1,
      users: 1,
      memberships: 1,
      security: 1,
      intents: 0,
      sessions: 0,
      accounts: 1,
    });

    const [org] = await t.db.select().from(schema.organizations);
    expect(org).toMatchObject({
      id: result.organizationId,
      name: "A/L ICT Class",
      slug: "al-ict-class",
    });
    const [user] = await t.db.select().from(schema.users);
    expect(user).toMatchObject({
      id: result.userId,
      email: "first.admin@example.com",
      name: "First Admin",
    });
    const [membership] = await t.db.select().from(schema.organizationMemberships);
    expect(membership).toMatchObject({
      id: result.membershipId,
      organizationId: org!.id,
      userId: user!.id,
      role: "ADMIN",
      status: "ACTIVE",
    });
    const [state] = await t.db.select().from(schema.userSecurityState);
    expect(state!.passwordChangeRequired).toBe(true);

    const account = (await t.pool.query("select provider_id, password from accounts")).rows[0];
    expect(account.provider_id).toBe("credential");
    expect(account.password).toMatch(SCRYPT_HASH);
    expect(account.password).not.toContain(BOOT_PASSWORD);
  });

  it("the bootstrapped admin signs in, must change the password, and is then fully usable", async () => {
    await bootstrapFirstAdmin(input(), deps());
    const res = await a.pub.handler(
      authRequest("/sign-in/email", {
        body: { email: "first.admin@example.com", password: BOOT_PASSWORD },
      }),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    await expect(
      requireAccess(headersWith(cookie), { db: t.db, auth: a.pub }),
    ).rejects.toBeInstanceOf(PasswordChangeRequiredError);
  });

  it("refuses a second bootstrap (same or different details) and changes nothing", async () => {
    await bootstrapFirstAdmin(input(), deps());
    const before = await counts();
    for (const over of [
      {},
      { organizationSlug: "other-org", email: "other@example.com" },
      { email: "first.admin@example.com", password: SECOND_PASSWORD },
    ]) {
      const err = await rejection(bootstrapFirstAdmin(input(over), deps()));
      expect(err).toBeInstanceOf(OperatorRefusedError);
    }
    expect(await counts()).toEqual(before);
    expect(await signInStatus("first.admin@example.com", BOOT_PASSWORD)).toBe(200); // password untouched
  });

  it("refuses when ANY user already exists (even without an organization)", async () => {
    await provisionUser(a, t, "someone@example.com");
    expect(await rejection(bootstrapFirstAdmin(input(), deps()))).toBeInstanceOf(
      OperatorRefusedError,
    );
    expect((await counts()).orgs).toBe(0);
  });

  it("refuses when an organization already exists that is not an incomplete bootstrap of this workflow", async () => {
    await t.db.insert(schema.organizations).values({ name: "Existing", slug: "existing" });
    expect(await rejection(bootstrapFirstAdmin(input(), deps()))).toBeInstanceOf(
      OperatorRefusedError,
    );
    expect((await counts()).users).toBe(0);
  });

  it("validates input strictly (slug, email, name, 12-128 char password, no extra fields)", async () => {
    for (const bad of [
      input({ organizationSlug: "Not A Slug" }),
      input({ organizationSlug: "-bad-" }),
      input({ email: "nope" }),
      input({ name: "  " }),
      input({ password: "short" }),
      input({ organizationId: "x" }),
      input({ role: "STAFF" }),
    ]) {
      expect(await rejection(bootstrapFirstAdmin(bad, deps()))).toBeInstanceOf(ValidationError);
    }
    expect(await counts()).toMatchObject({ orgs: 0, users: 0 });
  });

  it("a failure before the membership step stays fail-closed (org + intent + user, NO usable admin) and re-running resumes it", async () => {
    const sdb = serviceDb(t);
    const real = sdb.transaction.bind(sdb);
    let call = 0;
    const spy = vi.spyOn(sdb, "transaction").mockImplementation((async (
      cb: (tx: never) => Promise<unknown>,
    ) => {
      call++;
      if (call < 2) return real(cb as never); // phase 1 (organization + intent) passes; phase 3 (membership) fails
      return real(async (tx) => {
        await cb(tx as never);
        throw new Error("simulated failure at commit time");
      });
    }) as never);
    let err: unknown;
    try {
      err = await rejection(bootstrapFirstAdmin(input(), { db: sdb, provisioner: a.prov }));
    } finally {
      spy.mockRestore();
    }
    expect(err).toBeInstanceOf(OperatorRefusedError);
    const partial = await counts();
    expect(partial).toMatchObject({ orgs: 1, users: 1, memberships: 0, security: 0, intents: 1 });
    // no usable admin: sign-in is refused by the session gate
    expect(await signInStatus("first.admin@example.com", BOOT_PASSWORD)).toBe(401);

    // resume with the SAME organization/email; the retry's password becomes the effective one
    const resumed = await bootstrapFirstAdmin(input({ password: SECOND_PASSWORD }), deps());
    expect(resumed.resumed).toBe(true);
    expect(await counts()).toEqual({
      orgs: 1,
      users: 1,
      memberships: 1,
      security: 1,
      intents: 0,
      sessions: 0,
      accounts: 1,
    });
    expect(await signInStatus("first.admin@example.com", BOOT_PASSWORD)).toBe(401);
    expect(await signInStatus("first.admin@example.com", SECOND_PASSWORD)).toBe(200);
    const [state] = await t.db.select().from(schema.userSecurityState);
    expect(state!.passwordChangeRequired).toBe(true);
  });

  it("a half-finished bootstrap cannot be hijacked by a different email or organization", async () => {
    const failing = {
      api: {
        signUpEmail: async () => {
          throw new Error("auth down");
        },
      },
    } as never;
    await rejection(bootstrapFirstAdmin(input(), { db: t.db, provisioner: failing }));
    expect(await counts()).toMatchObject({ orgs: 1, users: 0, intents: 1, memberships: 0 });
    expect(
      await rejection(bootstrapFirstAdmin(input({ email: "attacker@example.com" }), deps())),
    ).toBeInstanceOf(OperatorRefusedError);
    expect(
      await rejection(bootstrapFirstAdmin(input({ organizationSlug: "different" }), deps())),
    ).toBeInstanceOf(OperatorRefusedError);
    expect(await counts()).toMatchObject({ orgs: 1, users: 0, intents: 1 });
  });

  it("two concurrent bootstraps: exactly one succeeds", async () => {
    const results = await Promise.allSettled([
      bootstrapFirstAdmin(input(), deps()),
      bootstrapFirstAdmin(
        input({ organizationSlug: "second-org", email: "second@example.com" }),
        deps(),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await counts()).toMatchObject({
      orgs: 1,
      users: 1,
      memberships: 1,
      security: 1,
      intents: 0,
    });
  });

  it("never wrote the password, its hash or tokens to logs", async () => {
    logs.length = 0;
    await bootstrapFirstAdmin(input(), deps());
    const events = logs.filter((l) => l.includes("security_event")).map((l) => JSON.parse(l));
    expect(events.map((e) => e.security_event)).toContain("bootstrap.completed");
    const done = events.find((e) => e.security_event === "bootstrap.completed");
    expect(done).toMatchObject({ role: "ADMIN" });
    expect(done.email_hash).toMatch(/^[0-9a-f]{16}$/);
    const all = logs.join("\n");
    expect(all).not.toContain(BOOT_PASSWORD);
    expect(all).not.toMatch(/[0-9a-f]{32}:[0-9a-f]{128}/);
    expect(all).not.toContain("first.admin@example.com");
  });

  describe("operator CLI (npm run auth:bootstrap-admin)", { timeout: 120_000 }, () => {
    const cliEnv = (extra: Record<string, string | undefined> = {}) => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        DATABASE_URL: t.url,
        BETTER_AUTH_SECRET: TEST_AUTH_ENV.secret,
        BETTER_AUTH_URL: TEST_AUTH_ENV.baseURL,
        BOOTSTRAP_ADMIN_PASSWORD: undefined,
        TSX_DISABLE_CACHE: "1", // two tsx processes starting at once must not share its on-disk cache
        ...extra,
      };
      return Object.fromEntries(
        Object.entries(env).filter(([, v]) => v !== undefined),
      ) as NodeJS.ProcessEnv;
    };
    const run = (args: string[], env: NodeJS.ProcessEnv) =>
      spawnSync("node_modules/.bin/tsx", ["scripts/auth-bootstrap-admin.ts", ...args], {
        env,
        encoding: "utf8",
        input: "",
        timeout: 90_000,
      });
    const ARGS = [
      "--org-name",
      "CLI Org",
      "--org-slug",
      "cli-org",
      "--email",
      "cli.admin@example.com",
      "--name",
      "CLI Admin",
    ];
    const CLI_PASSWORD = "cli-bootstrap-password-9";

    it("bootstraps non-interactively via the one-shot env var, prints no secret, and refuses a second run", () => {
      const first = run(ARGS, cliEnv({ BOOTSTRAP_ADMIN_PASSWORD: CLI_PASSWORD }));
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain("Bootstrap completed");
      for (const out of [first.stdout, first.stderr]) {
        expect(out).not.toContain(CLI_PASSWORD);
        expect(out).not.toMatch(/[0-9a-f]{32}:[0-9a-f]{128}/);
      }
      const second = run(ARGS, cliEnv({ BOOTSTRAP_ADMIN_PASSWORD: CLI_PASSWORD }));
      expect(second.status).toBe(1);
      expect(second.stderr).toContain("Refused");
      expect(second.stdout + second.stderr).not.toContain(CLI_PASSWORD);
    });

    it("never takes the password from the command line, and without env var or terminal it refuses safely", async () => {
      const withArg = run([...ARGS, "--password", CLI_PASSWORD], cliEnv());
      expect(withArg.status).not.toBe(0); // unknown option: passwords are not CLI arguments
      expect((await t.pool.query("select count(*)::int n from users")).rows[0].n).toBe(0);
      const noPassword = run(ARGS, cliEnv());
      expect(noPassword.status).not.toBe(0);
      expect((await t.pool.query("select count(*)::int n from users")).rows[0].n).toBe(0);
      expect(noPassword.stdout + noPassword.stderr).not.toContain(CLI_PASSWORD);
    });

    it("prints usage (exit 2) when required options are missing", () => {
      const res = run(["--org-name", "X"], cliEnv({ BOOTSTRAP_ADMIN_PASSWORD: CLI_PASSWORD }));
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("Usage");
    });
  });
});
