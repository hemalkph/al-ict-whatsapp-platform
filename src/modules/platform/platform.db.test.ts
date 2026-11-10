import { betterAuth } from "better-auth";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema, type Database } from "@/db";
import { pausingDatabase } from "@/db/__tests__/pausing-database";
import { buildBaseAuthOptions } from "@/modules/auth/base-config";
import { PUBLIC_DISABLED_PATHS } from "@/modules/auth/public-instance";
import {
  CHECK_VIOLATION,
  createTestDatabase,
  expectPgError,
  seedOrg,
  type TestDb,
} from "@/db/__tests__/helpers";
import {
  PASSWORD,
  TEST_AUTH_ENV,
  authRequest,
  login,
  provisionUser,
  realAuth,
  serviceDb,
  useGlobalAuth,
  type RealAuth,
} from "@/db/__tests__/real-auth";
import {
  createStaff,
  requireAccess,
  resetStaffPassword,
  type AccessContext,
} from "@/modules/access";
import {
  ForbiddenError,
  LastSecurityAdminRequiredError,
  OperationRefusedError,
  ProvisioningIncompleteError,
} from "@/shared/errors/http-errors";
import { BootstrapRefusedError, bootstrapPlatformSecurityAdmin } from "./bootstrap";
import { grantPlatformRole, revokePlatformRole } from "./operators";
import type { PlatformActor } from "./access";

// Phase 08G-7B C1A acceptance tests (C1A-T1..T18) on a disposable al_ict_test_* database: the REAL routes, the real Better
// Auth public instance and sessions, real PostgreSQL constraints, triggers, locks and concurrency. Synthetic users only.

const ORIGIN = TEST_AUTH_ENV.origin;
const NEW_PASSWORD = "c1a-new-password-2468";
let n = 0;
const email = (label: string) => `${label}.${Date.now().toString(36)}${n++}@c1a.example.test`;

type Routes = {
  operators: typeof import("../../app/api/platform/operators/route");
  revoke: typeof import("../../app/api/platform/operators/[grantId]/revoke/route");
  audit: typeof import("../../app/api/platform/audit/route");
  conversations: typeof import("../../app/api/inbox/conversations/route");
  reset: typeof import("../../app/api/staff/[membershipId]/reset-password/route");
  auth: typeof import("../../app/api/auth/[...all]/route");
  changePassword: typeof import("../../app/api/account/change-password/route");
};
type Opts = {
  cookie?: string;
  body?: unknown;
  origin?: string | null;
  headers?: Record<string, string>;
};

function req(method: string, path: string, o: Opts = {}): Request {
  const headers: Record<string, string> = { ...o.headers };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
}

describe("C1A platform operators (real routes, sessions and PostgreSQL)", () => {
  let t: TestDb;
  let a: RealAuth;
  let r: Routes;
  let release: () => Promise<void>;
  let orgId: string;
  const logs: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];

  // The bootstrapped security admin and a second one (granted through the route).
  let sa1: { id: string; email: string; cookie: string; grantId: string };
  let sa2: { id: string; email: string; cookie: string; grantId: string };

  beforeAll(async () => {
    t = await createTestDatabase();
    a = realAuth(t);
    release = useGlobalAuth(t);
    r = {
      operators: await import("../../app/api/platform/operators/route"),
      revoke: await import("../../app/api/platform/operators/[grantId]/revoke/route"),
      audit: await import("../../app/api/platform/audit/route"),
      conversations: await import("../../app/api/inbox/conversations/route"),
      reset: await import("../../app/api/staff/[membershipId]/reset-password/route"),
      auth: await import("../../app/api/auth/[...all]/route"),
      changePassword: await import("../../app/api/account/change-password/route"),
    };
    orgId = (await seedOrg(t.db)).id;
    for (const m of ["log", "warn", "error"] as const)
      spies.push(
        vi
          .spyOn(console, m)
          .mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))),
      );

    // Bootstrap: a platform-only user (no membership) proves control of the account with its password.
    const e1 = email("sa1");
    const u1 = await provisionUser(a, t, e1);
    const boot = await bootstrapPlatformSecurityAdmin(
      { email: e1, password: PASSWORD, verificationRef: "OWNER-VERIFY-001" },
      { db: t.db },
    );
    sa1 = { id: u1.id, email: e1, cookie: await login(a, e1), grantId: boot.grantId };
    const e2 = email("sa2");
    const u2 = await provisionUser(a, t, e2);
    const g = await grant(sa1.cookie, {
      email: e2,
      role: "PLATFORM_SECURITY_ADMIN",
      verificationRef: "V-SA2",
    });
    expect(g.status).toBe(201);
    sa2 = { id: u2.id, email: e2, cookie: await login(a, e2), grantId: (await g.json()).grantId };
  });
  afterAll(async () => {
    spies.forEach((s) => s.mockRestore());
    await release();
    await t.close();
  });

  // ------------------------------------------------------------------------------------------ helpers
  const list = (cookie?: string) =>
    r.operators.GET(req("GET", "/api/platform/operators", { cookie }));
  const grant = (cookie: string | undefined, body: unknown, o: Opts = {}) =>
    r.operators.POST(req("POST", "/api/platform/operators", { cookie, body, ...o }));
  const revoke = (cookie: string | undefined, grantId: string, o: Opts = {}) =>
    r.revoke.POST(req("POST", `/api/platform/operators/${grantId}/revoke`, { cookie, ...o }), {
      params: Promise.resolve({ grantId }),
    });
  const audit = (cookie?: string) =>
    r.audit.GET(req("GET", "/api/platform/audit?limit=200", { cookie }));
  const code = async (res: Response) =>
    ((await res.json()) as { error?: { code: string } }).error?.code;

  const rolesOf = (userId: string) =>
    t.db
      .select()
      .from(schema.platformOperatorRoles)
      .where(eq(schema.platformOperatorRoles.userId, userId));
  const auditRows = async (where: { action?: string; actorUserId?: string } = {}) =>
    (await t.db.select().from(schema.platformAuditEvents)).filter(
      (e) =>
        (!where.action || e.action === where.action) &&
        (!where.actorUserId || e.actorUserId === where.actorUserId),
    );
  const sessionCount = async (userId: string) =>
    (await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId))).length;
  /**
   * Sets a user's sessions' password-verification time (credential_verified_at, the platform freshness basis) and created_at
   * to `expr` (SQL over clock_timestamp()). Migration 0010 keeps both immutable for ordinary statements, so this runs with
   * triggers off (session_replication_role = replica), as only a privileged credential holder could: test-only time travel.
   */
  async function setSessionCreatedAt(userId: string, expr: string) {
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query(
        `update sessions set created_at = ${expr}, credential_verified_at = ${expr} where user_id = $1`,
        [userId],
      );
      await c.query("commit");
    } finally {
      c.release();
    }
  }
  const ageSessions = (userId: string, minutes: number) =>
    setSessionCreatedAt(userId, `clock_timestamp() - make_interval(mins => ${Number(minutes)})`);
  /** Barrier: waits until at least `count` backends of this test database are blocked on a lock (no fixed sleeps). */
  async function waitForLockWaiters(count: number) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const res = await t.pool.query(
        "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      );
      if (res.rows[0].n >= count) return;
      if (Date.now() > deadline) throw new Error(`expected ${count} lock waiter(s)`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const ROLE_LOCK = "select pg_advisory_lock(hashtextextended('platform_operator_roles', 0))";
  const ROLE_UNLOCK = "select pg_advisory_unlock(hashtextextended('platform_operator_roles', 0))";
  /**
   * A test-only BEFORE trigger that parks the statement on advisory lock `key` until release(): a deterministic pause INSIDE
   * a service's transaction at a known point (after the locks it took before that statement).
   */
  async function barrier(
    table: string,
    op: "INSERT" | "UPDATE" | "DELETE",
    key: number,
    when?: string, // optional trigger WHEN condition: park only the statement under test
  ) {
    // Named c1a_* so it fires BEFORE the migration's own sessions_* triggers (same-event triggers fire in name order).
    const fn = `c1a_barrier_${key}`;
    await t.pool.query(`
      create function ${fn}() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(${key}); return coalesce(NEW, OLD); end $$;
      create trigger ${fn}_trg before ${op} on ${table} for each row ${when ? `when (${when})` : ""}
        execute function ${fn}();`);
    const holder = await t.pool.connect();
    await holder.query("select pg_advisory_lock($1)", [key]);
    let open = true;
    const release = async () => {
      if (!open) return;
      open = false;
      await holder.query("select pg_advisory_unlock($1)", [key]);
      holder.release();
    };
    return {
      release,
      async drop() {
        await release();
        await t.pool.query(`drop trigger ${fn}_trg on ${table}; drop function ${fn}();`);
      },
    };
  }
  /** A single-membership tenant member of `organizationId` and its membership id. */
  async function tenantMember(organizationId: string, role: "ADMIN" | "STAFF" = "STAFF") {
    const e = email(role.toLowerCase());
    const u = await provisionUser(a, t, e, { organizationId, role });
    const [m] = await t.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.userId, u.id));
    return { id: u.id, email: e, membershipId: m!.id };
  }
  const flagOf = async (userId: string) =>
    (
      await t.db
        .select()
        .from(schema.userSecurityState)
        .where(eq(schema.userSecurityState.userId, userId))
    )[0];
  /** A platform-only operator (granted by sa1), freshly signed in. */
  async function newOperator(
    role: "PLATFORM_OPERATOR" | "PLATFORM_SECURITY_ADMIN" = "PLATFORM_OPERATOR",
  ) {
    const e = email("op");
    const u = await provisionUser(a, t, e);
    const res = await grant(sa1.cookie, { email: e, role, verificationRef: "V-OP" });
    expect(res.status).toBe(201);
    return {
      id: u.id,
      email: e,
      grantId: (await res.json()).grantId as string,
      cookie: await login(a, e),
    };
  }
  async function tenantAdmin() {
    const e = email("admin");
    const u = await provisionUser(a, t, e, { organizationId: orgId, role: "ADMIN" });
    return { id: u.id, email: e, cookie: await login(a, e) };
  }
  async function actorFor(userId: string): Promise<PlatformActor> {
    const [s] = await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId));
    const roles = (await rolesOf(userId)).filter((x) => x.status === "ACTIVE").map((x) => x.role);
    return { userId, sessionId: s!.id, roles };
  }
  const signIn = (e: string, password = PASSWORD) =>
    r.auth.POST(authRequest("/sign-in/email", { body: { email: e, password } }));

  // ------------------------------------------------------------------------------------------ T1 / T11 audit evidence
  describe("C1A-T1 authorized security administrator", () => {
    it("grants PLATFORM_OPERATOR to another existing user: 201, ACTIVE NORMAL grant and a SUCCEEDED audit row", async () => {
      const e = email("t1");
      const u = await provisionUser(a, t, e);
      const res = await grant(sa1.cookie, {
        email: e,
        role: "PLATFORM_OPERATOR",
        verificationRef: "V-T1",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toEqual({
        grantId: expect.any(String),
        userId: u.id,
        role: "PLATFORM_OPERATOR",
      });
      const [row] = await rolesOf(u.id);
      expect(row).toMatchObject({
        status: "ACTIVE",
        grantKind: "NORMAL",
        grantedByUserId: sa1.id,
        verificationRef: "V-T1",
        revokedAt: null,
      });
      const [ev] = (await auditRows({ action: "platform.operator.grant" })).filter(
        (x) => x.targetUserId === u.id,
      );
      expect(ev).toMatchObject({
        actorKind: "HUMAN",
        actorUserId: sa1.id,
        permission: "platform.operator.grant",
        outcome: "SUCCEEDED",
        approvalRef: "V-T1",
        correlationId: expect.any(String),
      });
      expect(ev!.occurredAt).toBeInstanceOf(Date);
    });

    it("lists grants (ids, roles, status, times; no emails) and reads every audit row", async () => {
      const res = await list(sa1.cookie);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("@");
      const ops = JSON.parse(text).operators as Array<Record<string, unknown>>;
      expect(Object.keys(ops[0]!).sort()).toEqual(
        [
          "grantId",
          "userId",
          "role",
          "status",
          "grantKind",
          "grantedByUserId",
          "grantedAt",
          "revokedByUserId",
          "revokedAt",
        ].sort(),
      );
      const au = await (await audit(sa1.cookie)).json();
      expect(au.scope).toBe("all");
      expect(au.events.some((e: { action: string }) => e.action === "platform.bootstrap")).toBe(
        true,
      );
    });
  });

  // ------------------------------------------------------------------------------------------ T2..T5 denials
  describe("C1A-T2..T5 denials", () => {
    it("T2: a signed-in user without a platform role gets 403 everywhere, with a best-effort DENIED audit row", async () => {
      const staff = await provisionUser(a, t, email("staff"), {
        organizationId: orgId,
        role: "STAFF",
      });
      const cookie = await login(
        a,
        (await t.db.select().from(schema.users).where(eq(schema.users.id, staff.id)))[0]!.email,
      );
      expect((await list(cookie)).status).toBe(403);
      expect((await audit(cookie)).status).toBe(403);
      expect(
        (await grant(cookie, { email: sa1.email, role: "PLATFORM_OPERATOR", verificationRef: "X" }))
          .status,
      ).toBe(403);
      const denied = await auditRows({ actorUserId: staff.id });
      expect(denied.map((d) => d.outcome)).toEqual(["DENIED", "DENIED", "DENIED"]);
      expect(denied.every((d) => d.resultCode === "FORBIDDEN")).toBe(true);
    });

    it("T3: a tenant ADMIN (every tenant permission) is refused every platform operation", async () => {
      const adm = await tenantAdmin();
      const ctx = await requireAccess(new Headers({ cookie: adm.cookie }));
      expect(ctx.role).toBe("ADMIN");
      expect((await list(adm.cookie)).status).toBe(403);
      expect((await audit(adm.cookie)).status).toBe(403);
      expect(
        (
          await grant(adm.cookie, {
            email: adm.email,
            role: "PLATFORM_SECURITY_ADMIN",
            verificationRef: "X",
          })
        ).status,
      ).toBe(403);
      expect((await revoke(adm.cookie, sa1.grantId)).status).toBe(403);
      expect(await rolesOf(adm.id)).toEqual([]);
    });

    it("T4: PLATFORM_OPERATOR is refused grant, another user's revoke, operator list and read_all; reads only its own audit", async () => {
      const op = await newOperator();
      expect(
        (
          await grant(op.cookie, {
            email: email("x"),
            role: "PLATFORM_OPERATOR",
            verificationRef: "X",
          })
        ).status,
      ).toBe(403);
      expect((await revoke(op.cookie, sa2.grantId)).status).toBe(403);
      expect((await revoke(op.cookie, "00000000-0000-4000-8000-000000000001")).status).toBe(403); // no existence oracle
      expect((await list(op.cookie)).status).toBe(403);
      const au = await (await audit(op.cookie)).json();
      expect(au.scope).toBe("own");
      expect(au.events.length).toBeGreaterThan(0);
      expect(au.events.every((e: { actorUserId: string }) => e.actorUserId === op.id)).toBe(true);
      expect((await rolesOf(sa2.id))[0]!.status).toBe("ACTIVE");
    });

    it("T5: identity in body, header or query is never trusted; forged and missing cookies are 401", async () => {
      const op = await newOperator();
      // A caller who IS allowed to grant: a body naming an actor (or granter) is rejected by the strict schema, and nothing
      // is committed.
      const spoofTarget = await provisionUser(a, t, email("spoof"));
      for (const extra of [
        { actorUserId: sa2.id },
        { grantedByUserId: sa2.id },
        { userId: sa1.id },
      ]) {
        const res = await grant(sa1.cookie, {
          email: spoofTarget.email,
          role: "PLATFORM_OPERATOR",
          verificationRef: "X",
          ...extra,
        });
        expect(res.status).toBe(400);
      }
      expect(await rolesOf(spoofTarget.id)).toEqual([]);
      expect(
        (await auditRows({ action: "platform.operator.grant" })).filter(
          (x) => x.targetUserId === spoofTarget.id && x.outcome === "SUCCEEDED",
        ),
      ).toEqual([]);
      // A header or query claiming to be the security admin changes nothing: the actor is the session user.
      const hdr = await r.operators.GET(
        req("GET", `/api/platform/operators?userId=${sa1.id}`, {
          cookie: op.cookie,
          headers: { "x-user-id": sa1.id, "x-actor": sa1.email },
        }),
      );
      expect(hdr.status).toBe(403);
      expect((await list("__Secure-better-auth.session_token=forged.value")).status).toBe(401);
      expect((await list("better-auth.session_token=forged.value")).status).toBe(401);
      expect((await list()).status).toBe(401);
      // Cross-origin mutation is refused before authentication.
      const cross = await grant(
        sa1.cookie,
        { email: email("x"), role: "PLATFORM_OPERATOR", verificationRef: "X" },
        { origin: "https://evil.example" },
      );
      expect(cross.status).toBe(403);
    });
  });

  // ------------------------------------------------------------------------------------------ T6 self-grant
  describe("C1A-T6 self-assignment", () => {
    it("a security admin cannot grant itself any role (409, no row); the CHECK refuses a direct insert", async () => {
      for (const role of ["PLATFORM_OPERATOR", "PLATFORM_SECURITY_ADMIN"]) {
        const res = await grant(sa2.cookie, { email: sa2.email, role, verificationRef: "SELF" });
        expect(res.status).toBe(409);
      }
      expect((await rolesOf(sa2.id)).map((x) => x.role)).toEqual(["PLATFORM_SECURITY_ADMIN"]);
      await expectPgError(
        t.pool.query(
          "insert into platform_operator_roles (user_id, role, grant_kind, granted_by_user_id, verification_ref) values ($1, 'PLATFORM_OPERATOR', 'NORMAL', $1, 'X')",
          [sa2.id],
        ),
        CHECK_VIOLATION,
        "platform_operator_roles_no_self_grant_check",
      );
    });
  });

  // ------------------------------------------------------------------------------------------ T7 revocation
  describe("C1A-T7 revocation", () => {
    it("revoking deletes every session: the next request is 401, and a platform-only user cannot sign in again", async () => {
      const op = await newOperator();
      const second = await login(a, op.email);
      expect((await audit(op.cookie)).status).toBe(200);
      const res = await revoke(sa1.cookie, op.grantId);
      expect(res.status).toBe(200);
      expect(await sessionCount(op.id)).toBe(0);
      expect((await audit(op.cookie)).status).toBe(401);
      expect((await audit(second)).status).toBe(401);
      expect((await signIn(op.email)).status).toBe(401);
      const [row] = await rolesOf(op.id);
      expect(row).toMatchObject({ status: "REVOKED", revokedByUserId: sa1.id });
      expect(row!.revokedAt).toBeInstanceOf(Date);
      expect((await revoke(sa1.cookie, op.grantId)).status).toBe(409); // already revoked
    });

    it("an operator who is also a tenant member: tenant access returns after a new sign-in, platform access does not", async () => {
      const e = email("both");
      const u = await provisionUser(a, t, e, { organizationId: orgId, role: "STAFF" });
      const g = await (
        await grant(sa1.cookie, { email: e, role: "PLATFORM_OPERATOR", verificationRef: "V" })
      ).json();
      const before = await login(a, e);
      expect((await audit(before)).status).toBe(200);
      expect((await revoke(sa1.cookie, g.grantId)).status).toBe(200);
      expect(
        (await r.conversations.GET(req("GET", "/api/inbox/conversations", { cookie: before })))
          .status,
      ).toBe(401);
      const after = await login(a, e);
      expect(
        (await r.conversations.GET(req("GET", "/api/inbox/conversations", { cookie: after })))
          .status,
      ).toBe(200);
      expect((await audit(after)).status).toBe(403);
      expect(u.id).toBeDefined();
    });

    it("anyone may revoke their OWN grant (re-authenticated); a role check denies a revoked actor even before session deletion", async () => {
      const op = await newOperator();
      expect((await revoke(op.cookie, op.grantId)).status).toBe(200);
      expect((await rolesOf(op.id))[0]!.revokedByUserId).toBe(op.id);
    });
  });

  // ------------------------------------------------------------------------------------------ T8 freshness
  describe("C1A-T8 re-authentication, expired and invalid sessions", () => {
    it("a mutation with a session created more than 10 minutes ago is 403 REAUTHENTICATION_REQUIRED; reads still work", async () => {
      const sa = await newOperator("PLATFORM_SECURITY_ADMIN");
      await ageSessions(sa.id, 11);
      const res = await grant(sa.cookie, {
        email: email("x"),
        role: "PLATFORM_OPERATOR",
        verificationRef: "X",
      });
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("REAUTHENTICATION_REQUIRED");
      expect((await revoke(sa.cookie, sa.grantId)).status).toBe(403);
      expect((await list(sa.cookie)).status).toBe(200);
      // Signing in again restarts the window.
      const fresh = await login(a, sa.email);
      const ok = await grant(fresh, {
        email: (await provisionUser(a, t, email("y"))).email,
        role: "PLATFORM_OPERATOR",
        verificationRef: "Y",
      });
      expect(ok.status).toBe(201);
    });

    it("an expired session is 401; a deleted session is 401", async () => {
      const op = await newOperator();
      await t.pool.query(
        "update sessions set expires_at = now() - interval '1 minute' where user_id = $1",
        [op.id],
      );
      expect((await audit(op.cookie)).status).toBe(401);
      const again = await login(a, op.email);
      await t.pool.query("delete from sessions where user_id = $1", [op.id]);
      expect((await audit(again)).status).toBe(401);
    });
  });

  // ------------------------------------------------------------------------------------------ T9 no tenant content
  describe("C1A-T9 a platform role grants no tenant access", () => {
    it("a platform-only security admin is 403 on tenant conversation, staff and page-access checks (no AccessContext)", async () => {
      expect(
        (await r.conversations.GET(req("GET", "/api/inbox/conversations", { cookie: sa1.cookie })))
          .status,
      ).toBe(403);
      await expect(requireAccess(new Headers({ cookie: sa1.cookie }))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      const staff = await import("../../app/api/staff/route");
      expect((await staff.GET(req("GET", "/api/staff", { cookie: sa1.cookie }))).status).toBe(403);
    });
  });

  // ------------------------------------------------------------------------------------------ T10 audit failure rollback
  describe("C1A-T10 audit failure rolls the change back", () => {
    it("a grant whose SUCCEEDED audit insert fails commits nothing (500); the FAILED row is still written best effort", async () => {
      // Refusal rows are throttled per (actor, action, outcome, minute): open sa1's FAILED slot for this check.
      await t.pool.query(
        "update platform_audit_throttle set last_recorded_at = last_recorded_at - interval '61 seconds' where actor_user_id = $1",
        [sa1.id],
      );
      const e = email("t10");
      const u = await provisionUser(a, t, e);
      await t.pool.query(`
        create function c1a_fail_audit() returns trigger language plpgsql as $$
        begin if NEW.outcome = 'SUCCEEDED' then raise exception 'injected audit failure'; end if; return NEW; end $$;
        create trigger c1a_fail_audit_trg before insert on platform_audit_events for each row execute function c1a_fail_audit();`);
      try {
        const res = await grant(sa1.cookie, {
          email: e,
          role: "PLATFORM_OPERATOR",
          verificationRef: "V",
        });
        expect(res.status).toBe(500);
        const revokeRes = await revoke(sa1.cookie, sa2.grantId);
        expect(revokeRes.status).toBe(500);
      } finally {
        await t.pool.query(
          "drop trigger c1a_fail_audit_trg on platform_audit_events; drop function c1a_fail_audit();",
        );
      }
      expect(await rolesOf(u.id)).toEqual([]);
      expect((await rolesOf(sa2.id))[0]!.status).toBe("ACTIVE");
      expect(await sessionCount(sa2.id)).toBeGreaterThan(0); // the revocation's session deletion rolled back too
      const failed = (await auditRows({ action: "platform.operator.grant" })).filter(
        (x) => x.outcome === "FAILED",
      );
      expect(failed.some((x) => x.resultCode === "INTERNAL_ERROR")).toBe(true);
    });

    it("a denial stays a denial when the best-effort denial row cannot be written", async () => {
      await t.pool.query(`
        create function c1a_fail_all() returns trigger language plpgsql as $$ begin raise exception 'down'; end $$;
        create trigger c1a_fail_all_trg before insert on platform_audit_events for each row execute function c1a_fail_all();`);
      try {
        const adm = await tenantAdmin();
        expect((await list(adm.cookie)).status).toBe(403);
        expect(logs.some((l) => l.includes("platform.audit_write_failed"))).toBe(true);
      } finally {
        await t.pool.query(
          "drop trigger c1a_fail_all_trg on platform_audit_events; drop function c1a_fail_all();",
        );
      }
    });
  });

  // ------------------------------------------------------------------------------------------ T11 database guards
  describe("C1A-T11 database guards", () => {
    it("audit rows cannot be updated or deleted through the application role (TRUNCATE is a credential-holder bypass, C1-G3)", async () => {
      await expectPgError(
        t.pool.query("update platform_audit_events set outcome = 'DENIED'"),
        CHECK_VIOLATION,
      );
      await expectPgError(t.pool.query("delete from platform_audit_events"), CHECK_VIOLATION);
    });

    it("grants change only ACTIVE -> REVOKED; never deleted, re-activated or re-assigned", async () => {
      const id = sa2.grantId;
      await expectPgError(
        t.pool.query("delete from platform_operator_roles where id = $1", [id]),
        CHECK_VIOLATION,
      );
      await expectPgError(
        t.pool.query(
          "update platform_operator_roles set role = 'PLATFORM_OPERATOR' where id = $1",
          [id],
        ),
        CHECK_VIOLATION,
      );
      await expectPgError(
        t.pool.query("update platform_operator_roles set user_id = $2 where id = $1", [id, sa1.id]),
        CHECK_VIOLATION,
      );
      await expectPgError(
        t.pool.query("update platform_operator_roles set verification_ref = 'Z' where id = $1", [
          id,
        ]),
        CHECK_VIOLATION,
      );
      const revoked = (
        await t.db
          .select()
          .from(schema.platformOperatorRoles)
          .where(eq(schema.platformOperatorRoles.status, "REVOKED"))
      )[0]!;
      await expectPgError(
        t.pool.query(
          "update platform_operator_roles set status = 'ACTIVE', revoked_at = null, revoked_by_user_id = null where id = $1",
          [revoked.id],
        ),
        CHECK_VIOLATION,
      );
      await expectPgError(
        t.pool.query(
          "insert into platform_operator_roles (user_id, role, status, grant_kind, granted_by_user_id, verification_ref, revoked_at, revoked_by_user_id) values ($1, 'PLATFORM_OPERATOR', 'REVOKED', 'NORMAL', $2, 'X', now(), $2)",
          [sa2.id, sa1.id],
        ),
        CHECK_VIOLATION,
      );
      // References that are personal data are refused by shape (no spaces, no @).
      await expectPgError(
        t.pool.query(
          "insert into platform_operator_roles (user_id, role, grant_kind, granted_by_user_id, verification_ref) values ($1, 'PLATFORM_OPERATOR', 'NORMAL', $2, 'Jane Doe jane@x.test')",
          [sa2.id, sa1.id],
        ),
        CHECK_VIOLATION,
        "platform_operator_roles_verification_ref_check",
      );
      // A second BOOTSTRAP grant is impossible even by direct insert.
      await expectPgError(
        t.pool.query(
          "insert into platform_operator_roles (user_id, role, grant_kind, verification_ref) values ($1, 'PLATFORM_OPERATOR', 'BOOTSTRAP', 'X')",
          [sa2.id],
        ),
        "23505",
        "platform_operator_roles_single_bootstrap_uidx",
      );
    });
  });

  // ------------------------------------------------------------------------------------------ T12 concurrency
  describe("C1A-T12 concurrent grant and revocation", () => {
    it("a grant by a security admin whose revocation is in flight waits for it, then is refused", async () => {
      const sa = await newOperator("PLATFORM_SECURITY_ADMIN");
      const actor = await actorFor(sa.id);
      const target = await provisionUser(a, t, email("t12"));
      const client = await t.pool.connect();
      try {
        await client.query("begin");
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended('platform_operator_roles', 0))",
        );
        await client.query(
          "update platform_operator_roles set status = 'REVOKED', revoked_by_user_id = $2 where id = $1",
          [sa.grantId, sa1.id],
        );
        const pending = grantPlatformRole(
          actor,
          { email: target.email, role: "PLATFORM_OPERATOR", verificationRef: "V" },
          { correlationId: crypto.randomUUID(), db: serviceDb(t) },
        );
        pending.catch(() => undefined);
        await waitForLockWaiters(1); // the grant is parked on the platform-roles lock held by the revocation
        await client.query("commit");
        await expect(pending).rejects.toBeInstanceOf(ForbiddenError);
      } finally {
        client.release();
      }
      expect(await rolesOf(target.id)).toEqual([]);
    });

    it("racing grant and revocation of the granter: exactly one serial order, never a grant after the revocation", async () => {
      for (let i = 0; i < 5; i++) {
        const sa = await newOperator("PLATFORM_SECURITY_ADMIN");
        const actor = await actorFor(sa.id);
        const sa1Actor = await actorFor(sa1.id);
        const target = await provisionUser(a, t, email("race"));
        const [g, rv] = await Promise.allSettled([
          grantPlatformRole(
            actor,
            { email: target.email, role: "PLATFORM_OPERATOR", verificationRef: "V" },
            { correlationId: crypto.randomUUID(), db: serviceDb(t) },
          ),
          revokePlatformRole(
            sa1Actor,
            { grantId: sa.grantId },
            { correlationId: crypto.randomUUID(), db: serviceDb(t) },
          ),
        ]);
        expect(rv.status).toBe("fulfilled");
        const [saRow] = await rolesOf(sa.id);
        const granted = await rolesOf(target.id);
        if (g.status === "fulfilled") {
          // microsecond precision, in SQL: the grant was written strictly before the granter's revocation
          const order = await t.pool.query(
            "select (select granted_at from platform_operator_roles where id = $1) < (select revoked_at from platform_operator_roles where id = $2) as ok",
            [granted[0]!.id, saRow!.id],
          );
          expect(order.rows[0].ok).toBe(true);
        } else {
          expect(g.reason).toBeInstanceOf(ForbiddenError);
          expect(granted).toEqual([]);
        }
      }
    });
  });

  // ------------------------------------------------------------------------------------------ T13 last security admin
  describe("C1A-T13 last security admin", () => {
    it("concurrent revocations of the two remaining security admins leave exactly one", async () => {
      // Revoke every other ACTIVE security admin first, so sa1 and sa2 are the last two.
      const others = (
        await t.db
          .select()
          .from(schema.platformOperatorRoles)
          .where(
            and(
              eq(schema.platformOperatorRoles.role, "PLATFORM_SECURITY_ADMIN"),
              eq(schema.platformOperatorRoles.status, "ACTIVE"),
            ),
          )
      ).filter((x) => x.userId !== sa1.id && x.userId !== sa2.id);
      for (const o of others)
        await revokePlatformRole(
          await actorFor(sa1.id),
          { grantId: o.id },
          { correlationId: crypto.randomUUID(), db: serviceDb(t) },
        );
      sa1.cookie = await login(a, sa1.email);
      sa2.cookie = await login(a, sa2.email);
      const [x, y] = await Promise.allSettled([
        revokePlatformRole(
          await actorFor(sa1.id),
          { grantId: sa2.grantId },
          { correlationId: crypto.randomUUID(), db: serviceDb(t) },
        ),
        revokePlatformRole(
          await actorFor(sa2.id),
          { grantId: sa1.grantId },
          { correlationId: crypto.randomUUID(), db: serviceDb(t) },
        ),
      ]);
      const outcomes = [x.status, y.status].sort();
      expect(outcomes).toEqual(["fulfilled", "rejected"]);
      const rejected = (x.status === "rejected" ? x : y) as PromiseRejectedResult;
      expect(
        [ForbiddenError, LastSecurityAdminRequiredError].some((E) => rejected.reason instanceof E),
      ).toBe(true);
      const active = await t.db
        .select()
        .from(schema.platformOperatorRoles)
        .where(
          and(
            eq(schema.platformOperatorRoles.role, "PLATFORM_SECURITY_ADMIN"),
            eq(schema.platformOperatorRoles.status, "ACTIVE"),
          ),
        );
      expect(active).toHaveLength(1);
      // The survivor cannot revoke itself (last security admin).
      const survivor = active[0]!;
      const cookie = await login(a, survivor.userId === sa1.id ? sa1.email : sa2.email);
      const res = await revoke(cookie, survivor.id);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe("LAST_SECURITY_ADMIN_REQUIRED");
      // Restore a second security admin for the remaining tests.
      const other = survivor.userId === sa1.id ? sa2 : sa1;
      expect(
        (
          await grant(cookie, {
            email: other.email,
            role: "PLATFORM_SECURITY_ADMIN",
            verificationRef: "RESTORE",
          })
        ).status,
      ).toBe(201);
      if (survivor.userId !== sa1.id) [sa1, sa2] = [sa2, sa1];
      sa1.cookie = cookie;
      sa2.cookie = await login(a, sa2.email);
      sa1.grantId = survivor.id;
      sa2.grantId = (await rolesOf(sa2.id)).find((g) => g.status === "ACTIVE")!.id;
    });

    it("bootstrap is refused after it ran, even with valid credentials and every original grant revoked", async () => {
      await expect(
        bootstrapPlatformSecurityAdmin(
          { email: sa2.email, password: PASSWORD, verificationRef: "AGAIN" },
          { db: t.db },
        ),
      ).rejects.toMatchObject({ reason: "already_bootstrapped" });
    });
  });

  // ------------------------------------------------------------------------------------------ T14 / T15 credentials
  describe("C1A-T14 tenant ADMIN cannot reset an operator's password", () => {
    it("refused while any platform role is ACTIVE; the normal reset works once every role is revoked", async () => {
      const adm = await tenantAdmin();
      const e = email("t14");
      const u = await provisionUser(a, t, e, { organizationId: orgId, role: "STAFF" });
      const [m] = await t.db
        .select()
        .from(schema.organizationMemberships)
        .where(eq(schema.organizationMemberships.userId, u.id));
      const g = await (
        await grant(sa1.cookie, { email: e, role: "PLATFORM_OPERATOR", verificationRef: "V" })
      ).json();
      const resetReq = () =>
        r.reset.POST(
          req("POST", `/api/staff/${m!.id}/reset-password`, {
            cookie: adm.cookie,
            body: { newPassword: NEW_PASSWORD },
          }),
          {
            params: Promise.resolve({ membershipId: m!.id }),
          },
        );
      const refused = await resetReq();
      expect(refused.status).toBe(409);
      expect((await signIn(e)).status).toBe(200); // old password still valid
      expect((await signIn(e, NEW_PASSWORD)).status).toBe(401);
      expect((await revoke(sa1.cookie, g.grantId)).status).toBe(200);
      expect((await resetReq()).status).toBe(200);
      expect((await signIn(e, NEW_PASSWORD)).status).toBe(200);
      // The reset left an administrator-known password: a grant is refused until the user changes it.
      const regrant = await grant(sa1.cookie, {
        email: e,
        role: "PLATFORM_OPERATOR",
        verificationRef: "V",
      });
      expect(regrant.status).toBe(409);
    });

    it("the create-staff resume path never replaces an operator's password", async () => {
      const adm = await tenantAdmin();
      const op = await newOperator();
      const [admMembership] = await t.db
        .select()
        .from(schema.organizationMemberships)
        .where(eq(schema.organizationMemberships.userId, adm.id));
      // A pre-existing, unbound intent of this organization for the operator's email (as after a crash).
      await t.db.insert(schema.staffProvisioningIntents).values({
        organizationId: orgId,
        emailKey: op.email,
        requestedByMembershipId: admMembership!.id,
      });
      const ctx: AccessContext = await requireAccess(new Headers({ cookie: adm.cookie }));
      await expect(
        createStaff(
          ctx,
          { email: op.email, name: "X", role: "STAFF", initialPassword: NEW_PASSWORD },
          { db: serviceDb(t) },
        ),
      ).rejects.toMatchObject({ code: "OPERATION_REFUSED" });
      expect((await signIn(op.email)).status).toBe(200);
      expect((await signIn(op.email, NEW_PASSWORD)).status).toBe(401);
      expect(
        await t.db
          .select()
          .from(schema.organizationMemberships)
          .where(eq(schema.organizationMemberships.userId, op.id)),
      ).toEqual([]);
    });

    it("a user with an organization provisioning in flight cannot be granted a role", async () => {
      const e = email("intent");
      await provisionUser(a, t, e);
      await t.db
        .insert(schema.staffProvisioningIntents)
        .values({ organizationId: orgId, emailKey: e });
      const res = await grant(sa1.cookie, {
        email: e,
        role: "PLATFORM_OPERATOR",
        verificationRef: "V",
      });
      expect(res.status).toBe(409);
    });
  });

  describe("C1A-T15 credential-changing auth endpoints cannot bypass the operator model", () => {
    const CLOSED = [
      "/update-session",
      "/account-info",
      "/list-accounts",
      "/unlink-account",
      "/get-access-token",
      "/refresh-token",
      "/send-verification-email",
      "/verify-email",
      "/update-user",
      "/change-email",
      "/set-password",
      "/reset-password",
      "/request-password-reset",
      "/link-social",
      "/sign-in/social",
      "/delete-user",
      "/change-password",
    ];
    it.each(CLOSED)(
      "%s is 404 over GET and POST even with a valid operator session",
      async (path) => {
        for (const method of ["GET", "POST"] as const) {
          const res = await r.auth[method](
            authRequest(path, {
              method,
              headers: { cookie: sa1.cookie },
              body:
                method === "POST"
                  ? {
                      providerId: "credential",
                      accountId: sa1.id,
                      token: "x",
                      email: sa1.email,
                      newPassword: NEW_PASSWORD,
                    }
                  : undefined,
            }),
          );
          expect(res.status, `${method} ${path}`).toBe(404);
        }
      },
    );

    it("own password changes go only through the application route: current password required, own account only", async () => {
      const adm = await tenantAdmin();
      const op = await newOperator();
      // Better Auth's public endpoint is closed: it verifies and writes in separate statements (no compare-and-swap).
      const pub = await r.auth.POST(
        authRequest("/change-password", {
          headers: { cookie: op.cookie },
          body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        }),
      );
      expect(pub.status).toBe(404);
      const changePw = (cookie: string, body: unknown) =>
        r.changePassword.POST(req("POST", "/api/account/change-password", { cookie, body }));
      expect(
        (
          await changePw(op.cookie, {
            currentPassword: "not-the-password-xx",
            newPassword: NEW_PASSWORD,
          })
        ).status,
      ).toBe(400);
      // naming another account is rejected by the strict schema; nothing changes for anyone
      expect(
        (
          await changePw(adm.cookie, {
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD,
            userId: op.id,
          })
        ).status,
      ).toBe(400);
      for (const e of [op.email, adm.email]) {
        expect((await signIn(e)).status).toBe(200);
        expect((await signIn(e, NEW_PASSWORD)).status).toBe(401);
      }
    });

    it("the reset callback with a token is inert (no reset is configured on the public instance)", async () => {
      const res = await r.auth.GET(
        authRequest("/reset-password/abc?callbackURL=/", { method: "GET" }),
      );
      expect(res.status).not.toBe(200);
      expect((await signIn(sa1.email)).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------------------------------ T16 sign-in eligibility
  describe("C1A-T16 sign-in eligibility", () => {
    it("member only, operator only and both sign in; neither, revoked-only and suspended-only are refused", async () => {
      const member = email("member");
      await provisionUser(a, t, member, { organizationId: orgId, role: "STAFF" });
      expect((await signIn(member)).status).toBe(200);
      const op = await newOperator();
      expect((await signIn(op.email)).status).toBe(200);
      const both = email("both2");
      await provisionUser(a, t, both, { organizationId: orgId, role: "VIEWER" });
      expect(
        (await grant(sa1.cookie, { email: both, role: "PLATFORM_OPERATOR", verificationRef: "V" }))
          .status,
      ).toBe(201);
      expect((await signIn(both)).status).toBe(200);
      const neither = email("neither");
      await provisionUser(a, t, neither);
      expect((await signIn(neither)).status).toBe(401);
      expect((await revoke(sa1.cookie, op.grantId)).status).toBe(200);
      expect((await signIn(op.email)).status).toBe(401);
      const suspended = email("suspended");
      await provisionUser(a, t, suspended, {
        organizationId: orgId,
        role: "STAFF",
        status: "SUSPENDED",
      });
      expect((await signIn(suspended)).status).toBe(401);
      expect((await signIn(sa1.email, "wrong-password-123456")).status).toBe(401);
    });
  });

  // ------------------------------------------------------------------------------------------ P1 credential races (review)
  describe("P1 tenant credential replacement versus platform grants (one per-user lock, deterministic barriers)", () => {
    const ADMIN_PW = "admin-chosen-password-1";
    const HUMAN_PW = "human-chosen-password-2";
    const INIT_PW = "provisioning-initial-pw-3";
    async function admin() {
      const m = await tenantMember(orgId, "ADMIN");
      return { ...m, ctx: await requireAccess(new Headers({ cookie: await login(a, m.email) })) };
    }
    const changeOwn = (cookie: string, currentPassword: string, newPassword: string) =>
      r.changePassword.POST(
        req("POST", "/api/account/change-password", {
          cookie,
          body: { currentPassword, newPassword },
        }),
      );

    it("P1-A reset first: a grant arriving while the reset holds the user waits, then is refused; the admin's password never reaches platform access", async () => {
      const adm = await admin();
      const target = await tenantMember(orgId);
      const b = await barrier("accounts", "UPDATE", 91001);
      let resetP: Promise<unknown> | undefined;
      let grantP: Promise<Response> | undefined;
      try {
        resetP = resetStaffPassword(
          adm.ctx,
          { membershipId: target.membershipId, newPassword: ADMIN_PW },
          { db: serviceDb(t) },
        );
        resetP.catch(() => undefined);
        await waitForLockWaiters(1); // the reset holds the user row and is parked at its credential write
        grantP = grant(sa1.cookie, {
          email: target.email,
          role: "PLATFORM_OPERATOR",
          verificationRef: "V-P1A",
        });
        await waitForLockWaiters(2); // the grant waits for the same user row
        await b.release();
      } finally {
        await b.drop();
      }
      await resetP;
      const g = await grantP!;
      expect(g.status).toBe(409);
      expect(await rolesOf(target.id)).toEqual([]);
      expect((await flagOf(target.id))?.passwordChangeRequired).toBe(true);

      // The administrator-known password signs in but carries no platform access.
      const adminSession = await login(a, target.email, ADMIN_PW);
      expect((await audit(adminSession)).status).toBe(403);
      // Only after the person replaces it can the (out-of-band verified) grant proceed; the admin's password is then dead
      // and the admin can no longer reset this account.
      expect((await changeOwn(adminSession, ADMIN_PW, HUMAN_PW)).status).toBe(200);
      expect(
        (
          await grant(sa1.cookie, {
            email: target.email,
            role: "PLATFORM_OPERATOR",
            verificationRef: "V-P1A",
          })
        ).status,
      ).toBe(201);
      expect((await signIn(target.email, ADMIN_PW)).status).toBe(401);
      await expect(
        resetStaffPassword(
          adm.ctx,
          { membershipId: target.membershipId, newPassword: ADMIN_PW },
          { db: serviceDb(t) },
        ),
      ).rejects.toBeInstanceOf(OperationRefusedError);
      expect((await signIn(target.email, HUMAN_PW)).status).toBe(200);
    });

    it("P1-A grant first: a reset arriving while the grant holds the user waits, then is refused; nothing about the credential changes", async () => {
      const adm = await admin();
      const target = await tenantMember(orgId);
      const sessionsBefore = await sessionCount(target.id);
      const b = await barrier("platform_operator_roles", "INSERT", 91002);
      let resetP: Promise<unknown> | undefined;
      let grantP: Promise<Response> | undefined;
      try {
        grantP = grant(sa1.cookie, {
          email: target.email,
          role: "PLATFORM_OPERATOR",
          verificationRef: "V-P1A2",
        });
        await waitForLockWaiters(1); // the grant holds the user row and is parked at its insert
        resetP = resetStaffPassword(
          adm.ctx,
          { membershipId: target.membershipId, newPassword: ADMIN_PW },
          { db: serviceDb(t) },
        );
        resetP.catch(() => undefined);
        await waitForLockWaiters(2);
        await b.release();
      } finally {
        await b.drop();
      }
      expect((await grantP!).status).toBe(201);
      await expect(resetP).rejects.toBeInstanceOf(OperationRefusedError);
      expect((await signIn(target.email, ADMIN_PW)).status).toBe(401);
      expect((await signIn(target.email)).status).toBe(200);
      expect((await flagOf(target.id))?.passwordChangeRequired ?? false).toBe(false);
      expect(await sessionCount(target.id)).toBeGreaterThanOrEqual(sessionsBefore);
    });

    it("P1-B resume during a grant: the grant waits for the resume, then is refused (administrator password pending)", async () => {
      const adm = await admin();
      const e = email("p1b");
      const u = await provisionUser(a, t, e); // the identity a crashed provisioning attempt created
      await t.db.insert(schema.staffProvisioningIntents).values({
        organizationId: orgId,
        emailKey: e,
        requestedByMembershipId: adm.membershipId,
        authUserId: u.id,
      });
      expect(
        (await grant(sa1.cookie, { email: e, role: "PLATFORM_OPERATOR", verificationRef: "V" }))
          .status,
      ).toBe(409);
      const b = await barrier("accounts", "UPDATE", 91003);
      let staffP: Promise<unknown> | undefined;
      let grantP: Promise<Response> | undefined;
      try {
        staffP = createStaff(
          adm.ctx,
          { email: e, name: "P1B", role: "STAFF", initialPassword: INIT_PW },
          { db: serviceDb(t) },
        );
        staffP.catch(() => undefined);
        await waitForLockWaiters(1);
        grantP = grant(sa1.cookie, { email: e, role: "PLATFORM_OPERATOR", verificationRef: "V" });
        await waitForLockWaiters(2);
        await b.release();
      } finally {
        await b.drop();
      }
      await staffP;
      expect((await grantP!).status).toBe(409);
      expect(await rolesOf(u.id)).toEqual([]);
      expect((await flagOf(u.id))?.passwordChangeRequired).toBe(true);
      expect((await signIn(e, INIT_PW)).status).toBe(200);
    });

    it("P1-B a role committed after the early check is caught under lock: the resume writes nothing", async () => {
      const adm = await admin();
      const e = email("p1b2");
      const u = await provisionUser(a, t, e);
      const [intent] = await t.db
        .insert(schema.staffProvisioningIntents)
        .values({
          organizationId: orgId,
          emailKey: e,
          requestedByMembershipId: adm.membershipId,
          authUserId: u.id,
        })
        .returning();
      // Park the resume at its locked step by holding the intent row; then a platform role commits (written directly:
      // a grant itself refuses while the intent exists).
      const holder = await t.pool.connect();
      let staffP: Promise<unknown> | undefined;
      try {
        await holder.query("begin");
        await holder.query("select id from staff_provisioning_intents where id = $1 for update", [
          intent!.id,
        ]);
        staffP = createStaff(
          adm.ctx,
          { email: e, name: "P1B2", role: "STAFF", initialPassword: INIT_PW },
          { db: serviceDb(t) },
        );
        staffP.catch(() => undefined);
        await waitForLockWaiters(1);
        await t.pool.query(
          "insert into platform_operator_roles (user_id, role, grant_kind, granted_by_user_id, verification_ref) values ($1, 'PLATFORM_OPERATOR', 'NORMAL', $2, 'V')",
          [u.id, sa1.id],
        );
        await holder.query("commit");
      } finally {
        holder.release();
      }
      await expect(staffP).rejects.toMatchObject({ code: "OPERATION_REFUSED" });
      expect((await signIn(e)).status).toBe(200);
      expect((await signIn(e, INIT_PW)).status).toBe(401);
      expect(
        await t.db
          .select()
          .from(schema.organizationMemberships)
          .where(eq(schema.organizationMemberships.userId, u.id)),
      ).toEqual([]);
      expect((await flagOf(u.id))?.passwordChangeRequired ?? false).toBe(false);
    });

    it("P1-B another administrator cannot continue someone else's provisioning intent", async () => {
      const first = await admin();
      const second = await admin();
      const e = email("p1b3");
      const u = await provisionUser(a, t, e);
      await t.db.insert(schema.staffProvisioningIntents).values({
        organizationId: orgId,
        emailKey: e,
        requestedByMembershipId: first.membershipId,
        authUserId: u.id,
      });
      await expect(
        createStaff(
          second.ctx,
          { email: e, name: "X", role: "STAFF", initialPassword: INIT_PW },
          { db: serviceDb(t) },
        ),
      ).rejects.toMatchObject({ code: "OPERATION_REFUSED" });
      expect((await signIn(e, INIT_PW)).status).toBe(401);
      const [still] = await t.db
        .select()
        .from(schema.staffProvisioningIntents)
        .where(eq(schema.staffProvisioningIntents.emailKey, e));
      expect(still).toMatchObject({
        requestedByMembershipId: first.membershipId,
        authUserId: u.id,
      });
      // the owner of the intent can still complete it
      await createStaff(
        first.ctx,
        { email: e, name: "X", role: "STAFF", initialPassword: INIT_PW },
        { db: serviceDb(t) },
      );
      expect((await signIn(e, INIT_PW)).status).toBe(200);
    });

    it("P1-H own change holding the user while an administrator reset arrives: strictly ordered, the reset's flag survives", async () => {
      const adm = await admin();
      const target = await tenantMember(orgId);
      const R1 = "first-reset-password-1";
      const R2 = "second-reset-password-2";
      await resetStaffPassword(
        adm.ctx,
        { membershipId: target.membershipId, newPassword: R1 },
        { db: serviceDb(t) },
      );
      const gen0 = (await flagOf(target.id))!.credentialGeneration;
      const cookie = await login(a, target.email, R1);
      const b = await barrier("sessions", "DELETE", 91010, `OLD.user_id = '${target.id}'`);
      let changeP: Promise<Response> | undefined;
      let resetP: Promise<unknown> | undefined;
      try {
        changeP = changeOwn(cookie, R1, HUMAN_PW);
        await waitForLockWaiters(1); // verified and written, parked at its session revocation, holding the user row
        resetP = resetStaffPassword(
          adm.ctx,
          { membershipId: target.membershipId, newPassword: R2 },
          { db: serviceDb(t) },
        );
        resetP.catch(() => undefined);
        await waitForLockWaiters(2); // the reset waits for the same user row
        await b.release();
      } finally {
        await b.drop();
      }
      expect((await changeP!).status).toBe(200);
      await resetP;
      expect(await flagOf(target.id)).toMatchObject({
        passwordChangeRequired: true,
        credentialGeneration: gen0 + 2,
      });
      expect((await signIn(target.email, R2)).status).toBe(200);
      expect((await signIn(target.email, HUMAN_PW)).status).toBe(401);
      expect(
        (
          await grant(sa1.cookie, {
            email: target.email,
            role: "PLATFORM_OPERATOR",
            verificationRef: "V",
          })
        ).status,
      ).toBe(409);
    });

    it("P1-H reset holding the user while an own change arrives: the own change's proof is checked against the new credential and refused", async () => {
      const adm = await admin();
      const target = await tenantMember(orgId);
      const R1 = "first-reset-password-1";
      const R2 = "second-reset-password-2";
      await resetStaffPassword(
        adm.ctx,
        { membershipId: target.membershipId, newPassword: R1 },
        { db: serviceDb(t) },
      );
      const gen0 = (await flagOf(target.id))!.credentialGeneration;
      const cookie = await login(a, target.email, R1);
      const b = await barrier("sessions", "DELETE", 91011, `OLD.user_id = '${target.id}'`);
      let changeP: Promise<Response> | undefined;
      let resetP: Promise<unknown> | undefined;
      try {
        resetP = resetStaffPassword(
          adm.ctx,
          { membershipId: target.membershipId, newPassword: R2 },
          { db: serviceDb(t) },
        );
        resetP.catch(() => undefined);
        await waitForLockWaiters(1); // reset written, parked at its session revocation, holding the user row
        changeP = changeOwn(cookie, R1, HUMAN_PW); // its session is still valid: admitted, then waits for the user row
        await waitForLockWaiters(2);
        await b.release();
      } finally {
        await b.drop();
      }
      await resetP;
      expect((await changeP!).status).toBe(400); // R1 no longer matches the current credential
      expect(await flagOf(target.id)).toMatchObject({
        passwordChangeRequired: true,
        credentialGeneration: gen0 + 1,
      });
      expect((await signIn(target.email, R2)).status).toBe(200);
      expect((await signIn(target.email, HUMAN_PW)).status).toBe(401);
    });

    it("P1-D an interrupted reset leaves no half state: nothing changed, nothing stuck, and a later grant still closes the account to resets", async () => {
      const adm = await admin();
      const target = await tenantMember(orgId);
      const hash = (
        await t.pool.query("select password from accounts where user_id = $1", [target.id])
      ).rows[0].password;
      await t.pool.query(`
        create function c1a_fault() returns trigger language plpgsql as $$ begin raise exception 'injected'; end $$;
        create trigger c1a_fault_trg before delete on sessions for each row execute function c1a_fault();`);
      try {
        await login(a, target.email);
        await expect(
          resetStaffPassword(
            adm.ctx,
            { membershipId: target.membershipId, newPassword: ADMIN_PW },
            { db: serviceDb(t) },
          ),
        ).rejects.toMatchObject({ code: "PASSWORD_RESET_INCOMPLETE" });
      } finally {
        await t.pool.query("drop trigger c1a_fault_trg on sessions; drop function c1a_fault();");
      }
      expect(
        (await t.pool.query("select password from accounts where user_id = $1", [target.id]))
          .rows[0].password,
      ).toBe(hash);
      expect(await flagOf(target.id)).toBeUndefined();
      expect(
        (
          await grant(sa1.cookie, {
            email: target.email,
            role: "PLATFORM_OPERATOR",
            verificationRef: "V",
          })
        ).status,
      ).toBe(201);
      await expect(
        resetStaffPassword(
          adm.ctx,
          { membershipId: target.membershipId, newPassword: ADMIN_PW },
          { db: serviceDb(t) },
        ),
      ).rejects.toBeInstanceOf(OperationRefusedError);
    });

    it("P1-D an interrupted provisioning keeps its intent (grants refused), and the same administrator's retry completes it", async () => {
      const adm = await admin();
      const e = email("p1d");
      await t.pool.query(`
        create function c1a_fault() returns trigger language plpgsql as $$ begin raise exception 'injected'; end $$;
        create trigger c1a_fault_trg before insert on organization_memberships for each row execute function c1a_fault();`);
      try {
        await expect(
          createStaff(
            adm.ctx,
            { email: e, name: "D", role: "STAFF", initialPassword: "first-attempt-pw-1" },
            { db: serviceDb(t) },
          ),
        ).rejects.toBeInstanceOf(ProvisioningIncompleteError);
      } finally {
        await t.pool.query(
          "drop trigger c1a_fault_trg on organization_memberships; drop function c1a_fault();",
        );
      }
      const [user] = await t.db.select().from(schema.users).where(eq(schema.users.email, e));
      expect(user).toBeDefined();
      expect(
        (await grant(sa1.cookie, { email: e, role: "PLATFORM_OPERATOR", verificationRef: "V" }))
          .status,
      ).toBe(409);
      await createStaff(
        adm.ctx,
        { email: e, name: "D", role: "STAFF", initialPassword: INIT_PW },
        { db: serviceDb(t) },
      );
      expect((await signIn(e, INIT_PW)).status).toBe(200);
      expect((await signIn(e, "first-attempt-pw-1")).status).toBe(401);
      expect(
        await t.db
          .select()
          .from(schema.staffProvisioningIntents)
          .where(eq(schema.staffProvisioningIntents.emailKey, e)),
      ).toEqual([]);
      expect(
        (await grant(sa1.cookie, { email: e, role: "PLATFORM_OPERATOR", verificationRef: "V" }))
          .status,
      ).toBe(409); // admin password pending
      const own = await login(a, e, INIT_PW);
      expect((await changeOwn(own, INIT_PW, HUMAN_PW)).status).toBe(200);
      expect(
        (await grant(sa1.cookie, { email: e, role: "PLATFORM_OPERATOR", verificationRef: "V" }))
          .status,
      ).toBe(201);
    });

    it("P1-E ordinary staff flows are unchanged: provisioning, own change (clears the flag), reset, sign-in", async () => {
      const adm = await admin();
      const e = email("p1e");
      const created = await createStaff(
        adm.ctx,
        { email: e, name: "E", role: "STAFF", initialPassword: INIT_PW },
        { db: serviceDb(t) },
      );
      // a NEW identity: no credential has been replaced yet
      expect(await flagOf(created.userId)).toMatchObject({
        passwordChangeRequired: true,
        credentialGeneration: 0,
      });
      const s1 = await login(a, e, INIT_PW);
      expect((await changeOwn(s1, INIT_PW, HUMAN_PW)).status).toBe(200);
      expect(await flagOf(created.userId)).toMatchObject({
        passwordChangeRequired: false,
        credentialGeneration: 1, // every stored-password change advances it, own changes included
      });
      await resetStaffPassword(
        adm.ctx,
        { membershipId: created.membershipId, newPassword: ADMIN_PW },
        { db: serviceDb(t) },
      );
      expect(await flagOf(created.userId)).toMatchObject({
        passwordChangeRequired: true,
        credentialGeneration: 2,
      });
      expect(await sessionCount(created.userId)).toBe(0);
      expect((await signIn(e, ADMIN_PW)).status).toBe(200);
      expect((await signIn(e, HUMAN_PW)).status).toBe(401);
    });
  });

  // ------------------------------------------------------------------------------------------ P2 re-authentication (review)
  describe("P2 re-authentication is judged on the current database clock, after the locks", () => {
    const target = () => provisionUser(a, t, email("p2"));
    const noGrant = async (userId: string) => {
      expect(await rolesOf(userId)).toEqual([]);
      expect(
        (await auditRows({ action: "platform.operator.grant" })).filter(
          (x) => x.targetUserId === userId && x.outcome === "SUCCEEDED",
        ),
      ).toEqual([]);
    };

    it("a grant that waits on the platform lock past the 10-minute window is refused", async () => {
      const sa = await newOperator("PLATFORM_SECURITY_ADMIN");
      await setSessionCreatedAt(sa.id, "clock_timestamp() - interval '9 minutes 58 seconds'");
      const u = await target();
      const holder = await t.pool.connect();
      let p: Promise<Response> | undefined;
      try {
        await holder.query(ROLE_LOCK);
        p = grant(sa.cookie, { email: u.email, role: "PLATFORM_OPERATOR", verificationRef: "V" });
        await waitForLockWaiters(1);
        // Barrier on the database clock itself: release only once the session is outside the window.
        for (;;) {
          const res = await t.pool.query(
            "select bool_and(created_at <= clock_timestamp() - interval '10 minutes') ok from sessions where user_id = $1",
            [sa.id],
          );
          if (res.rows[0].ok) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        await holder.query(ROLE_UNLOCK);
        holder.release();
      }
      const res = await p!;
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("REAUTHENTICATION_REQUIRED");
      await noGrant(u.id);
    });

    it("a session that expires between admission and the locked check is refused", async () => {
      const sa = await newOperator("PLATFORM_SECURITY_ADMIN");
      const u = await target();
      const holder = await t.pool.connect();
      let p: Promise<Response> | undefined;
      try {
        await holder.query(ROLE_LOCK);
        p = grant(sa.cookie, { email: u.email, role: "PLATFORM_OPERATOR", verificationRef: "V" });
        await waitForLockWaiters(1); // admitted (session valid), now parked on the lock
        await t.pool.query(
          "update sessions set expires_at = clock_timestamp() - interval '1 second' where user_id = $1",
          [sa.id],
        );
      } finally {
        await holder.query(ROLE_UNLOCK);
        holder.release();
      }
      const res = await p!;
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("REAUTHENTICATION_REQUIRED");
      await noGrant(u.id);
    });

    it("a future-dated session is refused, and the database stamps created_at itself (insert) and keeps it (update)", async () => {
      const sa = await newOperator("PLATFORM_SECURITY_ADMIN");
      await setSessionCreatedAt(sa.id, "clock_timestamp() + interval '1 hour'");
      const u = await target();
      const res = await grant(sa.cookie, {
        email: u.email,
        role: "PLATFORM_OPERATOR",
        verificationRef: "V",
      });
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("REAUTHENTICATION_REQUIRED");
      await noGrant(u.id);

      const row = await t.pool.query(
        "insert into sessions (user_id, token, expires_at, created_at) values ($1, $2, now() + interval '1 day', '2000-01-01') returning created_at, clock_timestamp() - created_at as age",
        [u.id, `c1a-${crypto.randomUUID()}`],
      );
      expect(row.rows[0].created_at.getUTCFullYear()).toBeGreaterThan(2000);
      const updated = await t.pool.query(
        "update sessions set created_at = clock_timestamp() + interval '1 day' where user_id = $1 returning created_at <= clock_timestamp() as unchanged",
        [u.id],
      );
      expect(updated.rows[0].unchanged).toBe(true);
    });

    it("a genuinely recent session still performs the operation", async () => {
      const sa = await newOperator("PLATFORM_SECURITY_ADMIN");
      const u = await target();
      expect(
        (
          await grant(sa.cookie, {
            email: u.email,
            role: "PLATFORM_OPERATOR",
            verificationRef: "V",
          })
        ).status,
      ).toBe(201);
      expect((await rolesOf(u.id)).map((x) => x.status)).toEqual(["ACTIVE"]);
    });
  });

  // ------------------------------------------------------------------------------------------ P2 denial flooding (review)
  describe("P2 refusals cannot write audit rows at request rate", () => {
    it("concurrent and repeated denials stay 403 and write one durable row per actor, action and minute", async () => {
      const adm = await tenantAdmin();
      const burst = await Promise.all(Array.from({ length: 25 }, () => list(adm.cookie)));
      expect(burst.map((x) => x.status)).toEqual(Array(25).fill(403));
      for (let i = 0; i < 10; i++) expect((await list(adm.cookie)).status).toBe(403);
      const rows = await auditRows({ actorUserId: adm.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "platform.operator.read",
        outcome: "DENIED",
        resultCode: "FORBIDDEN",
      });
      // every refusal is still a security log line
      expect(
        logs.filter((l) => l.includes("platform.access_denied") && l.includes(adm.id)).length,
      ).toBeGreaterThanOrEqual(35);
      // a different action has its own slot; the next window records again
      expect((await audit(adm.cookie)).status).toBe(403);
      await t.pool.query(
        "update platform_audit_throttle set last_recorded_at = last_recorded_at - interval '61 seconds' where actor_user_id = $1",
        [adm.id],
      );
      expect((await list(adm.cookie)).status).toBe(403);
      expect((await auditRows({ actorUserId: adm.id })).map((x) => x.action).sort()).toEqual([
        "platform.audit.read",
        "platform.operator.read",
        "platform.operator.read",
      ]);
      expect(await rolesOf(adm.id)).toEqual([]);
    });
  });

  // ------------------------------------------------------------------------------------------ P3 pagination (review)
  describe("P3 audit pagination", () => {
    async function pageAll(cookie: string, limit: number) {
      const events: Array<{ id: string; actorUserId: string }> = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await r.audit.GET(
          req("GET", `/api/platform/audit?limit=${limit}${cursor ? `&before=${cursor}` : ""}`, {
            cookie,
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { events: typeof events; nextCursor: string | null };
        expect(body.events.length).toBeLessThanOrEqual(Math.min(limit, 200));
        events.push(...body.events);
        cursor = body.nextCursor;
        pages++;
      } while (cursor);
      return { events, pages };
    }
    const orderedIds = async (actorUserId?: string) =>
      (
        await t.pool.query(
          `select id from platform_audit_events ${actorUserId ? "where actor_user_id = $1" : ""} order by occurred_at desc, id desc`,
          actorUserId ? [actorUserId] : [],
        )
      ).rows.map((x) => x.id as string);

    it("walks more than 200 rows with equal timestamps exactly once, in stable order, own scope filtered on every page", async () => {
      const op = await newOperator();
      const other = await newOperator();
      // one statement: every row gets the same occurred_at (the trigger stamps now())
      await t.pool.query(
        `insert into platform_audit_events (correlation_id, actor_kind, actor_user_id, action, outcome, result_code)
         select gen_random_uuid(), 'HUMAN', $1::uuid, 'platform.audit.read', 'DENIED', 'FORBIDDEN' from generate_series(1, 250)
         union all
         select gen_random_uuid(), 'HUMAN', $2::uuid, 'platform.audit.read', 'DENIED', 'FORBIDDEN' from generate_series(1, 5)`,
        [op.id, other.id],
      );
      const own = await pageAll(op.cookie, 200);
      expect(own.pages).toBe(2);
      expect(own.events.map((e) => e.id)).toEqual(await orderedIds(op.id));
      expect(own.events.every((e) => e.actorUserId === op.id)).toBe(true);

      const all = await pageAll(sa1.cookie, 97);
      const ids = all.events.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(await orderedIds());

      // another operator's row as the cursor reveals nothing in the own scope
      const [foreign] = await orderedIds(other.id);
      const res = await (
        await r.audit.GET(
          req("GET", `/api/platform/audit?before=${foreign}`, { cookie: op.cookie }),
        )
      ).json();
      expect(res).toMatchObject({ scope: "own", events: [], nextCursor: null });
      expect(
        (
          await r.audit.GET(
            req("GET", "/api/platform/audit?before=not-a-uuid", { cookie: op.cookie }),
          )
        ).status,
      ).toBe(400);
      const capped = await (
        await r.audit.GET(req("GET", "/api/platform/audit?limit=5000", { cookie: sa1.cookie }))
      ).json();
      expect(capped.events).toHaveLength(200);
    });
  });

  // ------------------------------------------------------------------------------------------ platform-only own password change
  describe("a platform-only operator changes its own password", () => {
    it("through the application route: old sessions are revoked, the replacement session works and is fresh", async () => {
      const op = await newOperator();
      const second = await login(a, op.email);
      const res = await r.changePassword.POST(
        req("POST", "/api/account/change-password", {
          cookie: op.cookie,
          body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        }),
      );
      expect(res.status).toBe(200);
      const fresh = res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      expect(fresh).toContain("session_token=");
      expect((await audit(op.cookie)).status).toBe(401);
      expect((await audit(second)).status).toBe(401);
      expect((await audit(fresh)).status).toBe(200);
      expect((await signIn(op.email, NEW_PASSWORD)).status).toBe(200);
      expect((await signIn(op.email)).status).toBe(401);
      expect((await revoke(fresh, op.grantId)).status).toBe(200); // a fresh session may mutate
    });
  });

  // ------------------------------------------------------------------------------------------ final review: stale proofs
  describe("stale password proofs, provisioning provenance and the canonical credential (final review)", () => {
    const ADMIN_PW = "admin-chosen-password-1";
    const HUMAN_PW = "human-chosen-password-2";
    async function admin() {
      const m = await tenantMember(orgId, "ADMIN");
      return { ...m, ctx: await requireAccess(new Headers({ cookie: await login(a, m.email) })) };
    }
    const changeOwn = (cookie: string, currentPassword: string, newPassword: string) =>
      r.changePassword.POST(
        req("POST", "/api/account/change-password", {
          cookie,
          body: { currentPassword, newPassword },
        }),
      );
    const hashOf = async (userId: string) =>
      (await t.pool.query("select password from accounts where user_id = $1", [userId])).rows[0]
        .password as string;

    it("C1A-CORR-REUSE exact and NFKC-equivalent temporary passwords preserve all state and cannot unlock enrollment", async () => {
      const adm = await admin();
      const target = await tenantMember(orgId);
      await resetStaffPassword(
        adm.ctx,
        { membershipId: target.membershipId, newPassword: ADMIN_PW },
        { db: serviceDb(t) },
      );
      const cookie = await login(a, target.email, ADMIN_PW);
      await login(a, target.email, ADMIN_PW);
      const before = {
        hash: await hashOf(target.id),
        state: await flagOf(target.id),
        sessions: await t.db
          .select()
          .from(schema.sessions)
          .where(eq(schema.sessions.userId, target.id)),
      };
      const equivalent = ADMIN_PW.replace("a", "\uff41");
      expect(equivalent).not.toBe(ADMIN_PW);
      expect(equivalent.normalize("NFKC")).toBe(ADMIN_PW);
      for (const proposed of [ADMIN_PW, equivalent]) {
        expect(await verifyPassword({ hash: before.hash, password: proposed })).toBe(true);
        const res = await changeOwn(cookie, ADMIN_PW, proposed);
        expect(res.status).toBe(400);
        expect(await code(res)).toBe("VALIDATION_ERROR");
        expect(await hashOf(target.id)).toBe(before.hash);
        expect(await flagOf(target.id)).toEqual(before.state);
        expect(
          await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, target.id)),
        ).toEqual(before.sessions);
        const denied = await grant(sa1.cookie, {
          email: target.email,
          role: "PLATFORM_SECURITY_ADMIN",
          verificationRef: "V-REUSE",
        });
        expect(denied.status).toBe(409);
        expect(await rolesOf(target.id)).toEqual([]);
      }
      expect((await changeOwn(cookie, ADMIN_PW, HUMAN_PW)).status).toBe(200);
      expect(await flagOf(target.id)).toMatchObject({
        passwordChangeRequired: false,
        credentialGeneration: before.state!.credentialGeneration + 1,
      });
      const sessions = await t.db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, target.id));
      expect(sessions).toHaveLength(1);
      expect(sessions.every((s) => !before.sessions.some((old) => old.id === s.id))).toBe(true);
      expect((await audit(cookie)).status).toBe(401);
      expect((await signIn(target.email, ADMIN_PW)).status).toBe(401);
      expect(
        (
          await grant(sa1.cookie, {
            email: target.email,
            role: "PLATFORM_SECURITY_ADMIN",
            verificationRef: "V-REUSE-OK",
          })
        ).status,
      ).toBe(201);
      expect((await audit(await login(a, target.email, HUMAN_PW))).status).toBe(200);
    });

    it.each(["audit", "operators"] as const)(
      "C1A-CORR-READ %s cannot inherit a new role after its session snapshot is revoked",
      async (route) => {
        const adm = await admin();
        const target = await tenantMember(orgId);
        await resetStaffPassword(
          adm.ctx,
          { membershipId: target.membershipId, newPassword: ADMIN_PW },
          { db: serviceDb(t) },
        );
        const cookie = await login(a, target.email, ADMIN_PW);
        const ownerCookie = await login(a, target.email, ADMIN_PW);
        const paused = pausingDatabase(t);
        const globals = globalThis as unknown as { __alIctDb?: Database };
        const original = globals.__alIctDb;
        const gate = paused.arm(/from "sessions"/, "after");
        let pending: Promise<Response> | undefined;
        try {
          pending = paused.db.transaction(async (tx) => {
            globals.__alIctDb = tx as unknown as Database;
            return route === "audit" ? audit(cookie) : list(cookie);
          });
          await paused.reachedBefore(gate, pending);
          globals.__alIctDb = original;
          expect((await changeOwn(ownerCookie, ADMIN_PW, HUMAN_PW)).status).toBe(200);
          expect(
            (
              await grant(sa1.cookie, {
                email: target.email,
                role: "PLATFORM_SECURITY_ADMIN",
                verificationRef: "V-READ-RACE",
              })
            ).status,
          ).toBe(201);
          gate.release();
          const res = await pending;
          expect(res.status).toBe(403);
          const body = await res.json();
          expect(body).not.toHaveProperty("events");
          expect(body).not.toHaveProperty("operators");
          expect((await audit(cookie)).status).toBe(401);
          const fresh = await login(a, target.email, HUMAN_PW);
          const allowed = await audit(fresh);
          expect(allowed.status).toBe(200);
          expect(await allowed.json()).toMatchObject({
            scope: "all",
            events: expect.arrayContaining([expect.objectContaining({ actorUserId: sa1.id })]),
          });
          expect((await list(fresh)).status).toBe(200);
          expect(gate.fired).toBe(1);
        } finally {
          globals.__alIctDb = original;
          gate.release();
          await pending;
          await paused.close();
        }
      },
    );

    it("C1A-CORR-READ role revocation before the admission statement denies the old request without records", async () => {
      const op = await newOperator("PLATFORM_SECURITY_ADMIN");
      const paused = pausingDatabase(t);
      const globals = globalThis as unknown as { __alIctDb?: Database };
      const original = globals.__alIctDb;
      const gate = paused.arm(/from "sessions"/);
      let pending: Promise<Response> | undefined;
      try {
        pending = paused.db.transaction(async (tx) => {
          globals.__alIctDb = tx as unknown as Database;
          return audit(op.cookie);
        });
        await paused.reachedBefore(gate, pending);
        globals.__alIctDb = original;
        expect((await revoke(sa1.cookie, op.grantId)).status).toBe(200);
        gate.release();
        const denied = await pending;
        expect(denied.status).toBe(403);
        expect(await denied.json()).not.toHaveProperty("events");
        expect((await audit(op.cookie)).status).toBe(401);
        expect((await signIn(op.email)).status).not.toBe(200);
      } finally {
        globals.__alIctDb = original;
        gate.release();
        await pending;
        await paused.close();
      }
    });

    it("C1A-CORR-READ revocation and re-enrollment cannot broaden an in-flight own-audit scope", async () => {
      const op = await newOperator();
      const paused = pausingDatabase(t);
      const globals = globalThis as unknown as { __alIctDb?: Database };
      const original = globals.__alIctDb;
      const gate = paused.arm(/from "sessions"/, "after");
      let pending: Promise<Response> | undefined;
      try {
        pending = paused.db.transaction(async (tx) => {
          globals.__alIctDb = tx as unknown as Database;
          return audit(op.cookie);
        });
        await paused.reachedBefore(gate, pending);
        globals.__alIctDb = original;
        expect((await revoke(sa1.cookie, op.grantId)).status).toBe(200);
        expect(
          (
            await grant(sa1.cookie, {
              email: op.email,
              role: "PLATFORM_SECURITY_ADMIN",
              verificationRef: "V-REGRANT",
            })
          ).status,
        ).toBe(201);
        gate.release();
        // Admitted before revocation: only the roles in that snapshot may set visibility, never the later grant.
        const res = await pending;
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.scope).toBe("own");
        expect(body.events.every((e: { actorUserId: string }) => e.actorUserId === op.id)).toBe(
          true,
        );
        expect((await audit(op.cookie)).status).toBe(401);
        expect(await (await audit(await login(a, op.email))).json()).toMatchObject({
          scope: "all",
        });
      } finally {
        globals.__alIctDb = original;
        gate.release();
        await pending;
        await paused.close();
      }
    });

    it("C1A-CORR-INTENT another administrator cannot advance an unbound intent; the original requester can finish", async () => {
      const first = await admin();
      const second = await admin();
      const e = email("unbound");
      const [intent] = await t.db
        .insert(schema.staffProvisioningIntents)
        .values({
          organizationId: orgId,
          emailKey: e,
          requestedByMembershipId: first.ctx.membershipId,
        })
        .returning();
      const input = {
        email: e,
        name: "Unbound",
        role: "STAFF" as const,
        initialPassword: ADMIN_PW,
      };
      await expect(createStaff(second.ctx, input, { db: serviceDb(t) })).rejects.toMatchObject({
        code: "OPERATION_REFUSED",
      });
      expect(await t.db.select().from(schema.users).where(eq(schema.users.email, e))).toEqual([]);
      expect(
        (
          await t.pool.query(
            "select a.id from accounts a join users u on u.id = a.user_id where u.email = $1",
            [e],
          )
        ).rows,
      ).toEqual([]);
      expect(
        await t.db
          .select()
          .from(schema.staffProvisioningIntents)
          .where(eq(schema.staffProvisioningIntents.id, intent!.id)),
      ).toEqual([intent]);
      expect(
        (
          await t.pool.query(
            "select m.id from organization_memberships m join users u on u.id = m.user_id where u.email = $1",
            [e],
          )
        ).rows,
      ).toEqual([]);
      const staff = await createStaff(first.ctx, input, { db: serviceDb(t) });
      expect(staff.passwordChangeRequired).toBe(true);
      expect(await verifyPassword({ hash: await hashOf(staff.userId), password: ADMIN_PW })).toBe(
        true,
      );
      expect(
        await t.db
          .select()
          .from(schema.staffProvisioningIntents)
          .where(eq(schema.staffProvisioningIntents.id, intent!.id)),
      ).toEqual([]);
      expect(await login(a, e, ADMIN_PW)).toContain("session_token=");
    });

    it("C1A-CORR-PREHOOK a proof superseded after Better Auth verification is refused by the real session hook", async () => {
      const adm = await admin();
      const target = await tenantMember(orgId);
      await resetStaffPassword(
        adm.ctx,
        { membershipId: target.membershipId, newPassword: ADMIN_PW },
        { db: serviceDb(t) },
      );
      const own = await login(a, target.email, ADMIN_PW);
      const base = buildBaseAuthOptions({ db: t.db, env: TEST_AUTH_ENV });
      let verified = 0;
      const locker = await t.pool.connect();
      const KEY = 91015;
      await locker.query("select pg_advisory_lock($1)", [KEY]);
      // Only Better Auth's FIRST verifier is wrapped. The production session hook still calls the real verifier itself.
      const pausedAuth = betterAuth({
        ...base,
        disabledPaths: [...PUBLIC_DISABLED_PATHS],
        emailAndPassword: {
          ...base.emailAndPassword,
          enabled: true,
          disableSignUp: true,
          password: {
            verify: async (proof) => {
              const valid = await verifyPassword(proof);
              if (valid) {
                verified++;
                await t.pool.query("select pg_advisory_xact_lock($1)", [KEY]);
              }
              return valid;
            },
          },
        },
      });
      const STALE_IP = "10.250.0.15";
      let pending: Promise<Response> | undefined;
      try {
        pending = pausedAuth.handler(
          authRequest("/sign-in/email", {
            body: { email: target.email, password: ADMIN_PW },
            ip: STALE_IP,
          }),
        );
        await waitForLockWaiters(1);
        expect(verified).toBe(1);
        expect((await changeOwn(own, ADMIN_PW, HUMAN_PW)).status).toBe(200);
        expect(
          (
            await grant(sa1.cookie, {
              email: target.email,
              role: "PLATFORM_SECURITY_ADMIN",
              verificationRef: "V-PREHOOK",
            })
          ).status,
        ).toBe(201);
      } finally {
        await locker.query("select pg_advisory_unlock($1)", [KEY]);
        locker.release();
      }
      const stale = await pending!;
      expect(stale.status).not.toBe(200);
      const staleCookie = stale.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      expect(staleCookie).not.toContain("session_token=");
      expect(
        (await t.pool.query("select id from sessions where ip_address = $1", [STALE_IP])).rows,
      ).toEqual([]);
      expect((await audit(staleCookie)).status).toBe(401);
      expect((await signIn(target.email, ADMIN_PW)).status).toBe(401);
      expect((await audit(await login(a, target.email, HUMAN_PW))).status).toBe(200);
    });

    it("C1A-P1-F a sign-in whose proof is superseded before its session is inserted gets no session", async () => {
      const adm = await admin();
      const target = await tenantMember(orgId);
      await resetStaffPassword(
        adm.ctx,
        { membershipId: target.membershipId, newPassword: ADMIN_PW },
        { db: serviceDb(t) },
      );
      const STALE_IP = "10.250.0.1";
      // Parks only the stale sign-in's INSERT: after Better Auth AND the session-create hook verified ADMIN_PW.
      const b = await barrier("sessions", "INSERT", 91012, `NEW.ip_address = '${STALE_IP}'`);
      let staleP: Promise<Response> | undefined;
      try {
        staleP = r.auth.POST(
          authRequest("/sign-in/email", {
            body: { email: target.email, password: ADMIN_PW },
            ip: STALE_IP,
          }),
        );
        await waitForLockWaiters(1);
        // Meanwhile the owner replaces the administrator-known password and is enrolled as a platform operator.
        const own = await login(a, target.email, ADMIN_PW);
        expect((await changeOwn(own, ADMIN_PW, HUMAN_PW)).status).toBe(200);
        expect(
          (
            await grant(sa1.cookie, {
              email: target.email,
              role: "PLATFORM_OPERATOR",
              verificationRef: "V-P1F",
            })
          ).status,
        ).toBe(201);
        await b.release();
      } finally {
        await b.drop();
      }
      const stale = await staleP!;
      expect(stale.status).not.toBe(200);
      expect(stale.headers.getSetCookie().join(";")).not.toContain("session_token=");
      expect(
        (
          await t.pool.query("select count(*)::int n from sessions where ip_address = $1", [
            STALE_IP,
          ])
        ).rows[0].n,
      ).toBe(0);
      expect((await signIn(target.email, ADMIN_PW)).status).toBe(401);
      expect((await signIn(target.email, HUMAN_PW)).status).toBe(200);
      expect(await auditRows({ actorUserId: target.id })).toEqual([]); // no privileged operation by anyone as the target
    });

    it("C1A-P1-G the public password change cannot write at all; the only own-change path verifies and writes atomically", async () => {
      const op = await newOperator();
      const before = await hashOf(op.id);
      const res = await r.auth.POST(
        authRequest("/change-password", {
          headers: { cookie: op.cookie },
          body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true },
        }),
      );
      expect(res.status).toBe(404);
      expect(await hashOf(op.id)).toBe(before);
      // No application code calls Better Auth's non-atomic changePassword (server-side calls bypass disabledPaths).
      const { execSync } = await import("node:child_process");
      const callers = execSync("grep -rln 'api.changePassword' src --include=*.ts || true", {
        encoding: "utf8",
      })
        .split("\n")
        .filter((f) => f && !f.endsWith(".test.ts"));
      expect(callers).toEqual([]);
    });

    it("C1A-P1-G a stale own change waiting behind the owner's change is checked against the owner's credential and refused", async () => {
      const adm = await admin();
      const target = await tenantMember(orgId);
      await resetStaffPassword(
        adm.ctx,
        { membershipId: target.membershipId, newPassword: ADMIN_PW },
        { db: serviceDb(t) },
      );
      const staleCookie = await login(a, target.email, ADMIN_PW); // the administrator, holding the known password
      const ownerCookie = await login(a, target.email, ADMIN_PW); // the owner, with the same initial password
      const b = await barrier("sessions", "DELETE", 91013, `OLD.user_id = '${target.id}'`);
      let ownerP: Promise<Response> | undefined;
      let staleP: Promise<Response> | undefined;
      try {
        ownerP = changeOwn(ownerCookie, ADMIN_PW, HUMAN_PW);
        await waitForLockWaiters(1); // the owner's change is written and parked, holding the user row
        staleP = changeOwn(staleCookie, ADMIN_PW, "attacker-password-9"); // admitted, then waits for the user row
        await waitForLockWaiters(2);
        await b.release();
      } finally {
        await b.drop();
      }
      expect((await ownerP!).status).toBe(200);
      expect((await staleP!).status).toBe(400);
      expect(
        (
          await grant(sa1.cookie, {
            email: target.email,
            role: "PLATFORM_OPERATOR",
            verificationRef: "V-P1G",
          })
        ).status,
      ).toBe(201);
      expect((await signIn(target.email, HUMAN_PW)).status).toBe(200);
      expect((await signIn(target.email, "attacker-password-9")).status).toBe(401);
      expect((await signIn(target.email, ADMIN_PW)).status).toBe(401);
      expect((await rolesOf(target.id)).map((x) => x.status)).toEqual(["ACTIVE"]);
    });

    it("C1A-P1-I a session on a superseded credential carries no platform authority, and a late stale session cannot be inserted", async () => {
      const sa = await newOperator("PLATFORM_SECURITY_ADMIN");
      expect((await audit(sa.cookie)).status).toBe(200);
      // The credential changes WITHOUT the session being revoked (an out-of-band writer).
      await t.pool.query("update accounts set password = $2 where user_id = $1", [
        sa.id,
        await hashPassword("out-of-band-password-7"),
      ]);
      const read = await audit(sa.cookie);
      expect(read.status).toBe(403);
      expect(await code(read)).toBe("REAUTHENTICATION_REQUIRED");
      const u = await provisionUser(a, t, email("p1i"));
      expect(
        (
          await grant(sa.cookie, {
            email: u.email,
            role: "PLATFORM_OPERATOR",
            verificationRef: "V",
          })
        ).status,
      ).toBe(403);
      expect(await rolesOf(u.id)).toEqual([]);
      // A session stamped with the old generation is refused by the database itself.
      await expectPgError(
        t.pool.query(
          "insert into sessions (user_id, token, expires_at, credential_generation) values ($1, $2, now() + interval '1 day', 0)",
          [sa.id, `c1a-${crypto.randomUUID()}`],
        ),
        CHECK_VIOLATION,
      );
      expect((await signIn(sa.email, "out-of-band-password-7")).status).toBe(200); // the current credential still signs in
    });

    it("re-authentication: the early check passes, a held target row outlasts the window, and the final locked check refuses", async () => {
      const sa = await newOperator("PLATFORM_SECURITY_ADMIN");
      await setSessionCreatedAt(sa.id, "clock_timestamp() - interval '9 minutes 58 seconds'");
      const u = await provisionUser(a, t, email("lockwin"));
      const holder = await t.pool.connect();
      let p: Promise<Response> | undefined;
      try {
        await holder.query("begin");
        await holder.query("select id from users where id = $1 for update", [u.id]);
        p = grant(sa.cookie, { email: u.email, role: "PLATFORM_OPERATOR", verificationRef: "V" });
        await waitForLockWaiters(1); // past the early check, waiting for the target row
        for (;;) {
          const res = await t.pool.query(
            "select bool_and(credential_verified_at <= clock_timestamp() - interval '10 minutes') ok from sessions where user_id = $1",
            [sa.id],
          );
          if (res.rows[0].ok) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await holder.query("commit");
      } finally {
        holder.release();
      }
      const res = await p!;
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("REAUTHENTICATION_REQUIRED");
      expect(await rolesOf(u.id)).toEqual([]);
      expect(
        (await auditRows({ action: "platform.operator.grant" })).filter(
          (x) => x.targetUserId === u.id && x.outcome === "SUCCEEDED",
        ),
      ).toEqual([]);
    });

    it("C1A-P2-PROVENANCE overlapping provisioning of a pre-existing account cannot replace its credential", async () => {
      const adm = await admin();
      const victim = await provisionUser(a, t, email("victim")); // pre-existing identity, no membership anywhere
      const before = { hash: await hashOf(victim.id), state: await flagOf(victim.id) };
      // Request 1 is held (JavaScript gate, no database lock) between inserting its intent and removing it.
      const db1 = serviceDb(t);
      const realDelete = db1.delete.bind(db1);
      let reached!: () => void;
      let open!: () => void;
      const atDelete = new Promise<void>((resolve) => (reached = resolve));
      const gate = new Promise<void>((resolve) => (open = resolve));
      (db1 as unknown as { delete: unknown }).delete = (table: unknown) => {
        const builder = realDelete(table as typeof schema.staffProvisioningIntents);
        if (table !== schema.staffProvisioningIntents) return builder;
        return {
          where: (cond: Parameters<typeof builder.where>[0]) => {
            reached();
            return gate.then(() => builder.where(cond));
          },
        };
      };
      const input = { email: victim.email, name: "Victim", role: "STAFF" as const };
      const p1 = createStaff(adm.ctx, { ...input, initialPassword: ADMIN_PW }, { db: db1 });
      p1.catch(() => undefined);
      await atDelete;
      // Request 2 finds request 1's (unbound) intent: it proves nothing about the identity and confers nothing.
      await expect(
        createStaff(
          adm.ctx,
          { ...input, initialPassword: "second-request-pw-2" },
          { db: serviceDb(t) },
        ),
      ).rejects.toMatchObject({ code: "OPERATION_REFUSED" });
      open();
      await expect(p1).rejects.toMatchObject({ code: "OPERATION_REFUSED" });

      expect(await hashOf(victim.id)).toBe(before.hash);
      expect(await flagOf(victim.id)).toEqual(before.state);
      expect(
        await t.db
          .select()
          .from(schema.organizationMemberships)
          .where(eq(schema.organizationMemberships.userId, victim.id)),
      ).toEqual([]);
      expect(
        await t.db
          .select()
          .from(schema.staffProvisioningIntents)
          .where(eq(schema.staffProvisioningIntents.emailKey, victim.email)),
      ).toEqual([]);
      // (the victim has no membership or role, so it cannot sign in at all: check the stored credential itself)
      const stored = await hashOf(victim.id);
      expect(await verifyPassword({ hash: stored, password: PASSWORD })).toBe(true);
      for (const pw of [ADMIN_PW, "second-request-pw-2"])
        expect(await verifyPassword({ hash: stored, password: pw })).toBe(false);
    });

    it("C1A-F a non-canonical credential row is never treated as the user's credential (Better Auth refuses it too)", async () => {
      const adm = await admin();
      const target = await tenantMember(orgId);
      const cookie = await login(a, target.email);
      await t.pool.query("update accounts set account_id = 'not-the-user-id' where user_id = $1", [
        target.id,
      ]);
      const before = await hashOf(target.id);
      expect((await signIn(target.email)).status).toBe(401); // the library's own lookup refuses it
      expect((await changeOwn(cookie, PASSWORD, HUMAN_PW)).status).toBe(400);
      await expect(
        resetStaffPassword(
          adm.ctx,
          { membershipId: target.membershipId, newPassword: ADMIN_PW },
          { db: serviceDb(t) },
        ),
      ).rejects.toMatchObject({ code: "PASSWORD_RESET_INCOMPLETE" });
      expect(await hashOf(target.id)).toBe(before);
      expect(await flagOf(target.id)).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------------------------------ T17 no content
  describe("C1A-T17 no personal data, secrets or content in audit rows, responses or logs", () => {
    it("scans every audit row, a sample of responses and the captured logs", async () => {
      const rows = await t.db.select().from(schema.platformAuditEvents);
      expect(rows.length).toBeGreaterThan(10);
      const tokens = (
        await t.db.select({ token: schema.sessions.token }).from(schema.sessions)
      ).map((s) => s.token);
      const hashes = (await t.db.select({ p: schema.accounts.password }).from(schema.accounts)).map(
        (x) => x.p!,
      );
      const corpus = [
        JSON.stringify(rows),
        await (await audit(sa1.cookie)).text(),
        await (await list(sa1.cookie)).text(),
        logs.join("\n"),
      ].join("\n");
      expect(corpus).not.toContain("@c1a.example.test");
      expect(corpus).not.toContain(PASSWORD);
      expect(corpus).not.toContain(NEW_PASSWORD);
      for (const tk of tokens) expect(corpus).not.toContain(tk);
      for (const h of hashes) expect(corpus).not.toContain(h.slice(0, 40));
      expect(Object.keys(rows[0]!).sort()).toEqual(
        [
          "id",
          "occurredAt",
          "correlationId",
          "actorKind",
          "actorUserId",
          "action",
          "permission",
          "outcome",
          "targetUserId",
          "targetOrganizationId",
          "approvalRef",
          "resultCode",
        ].sort(),
      );
    });
  });
});

// ---------------------------------------------------------------------------------------------- T15 (plan T13) bootstrap
describe("C1A single-use bootstrap (own disposable database)", () => {
  let t: TestDb;
  let a: RealAuth;
  beforeAll(async () => {
    t = await createTestDatabase();
    a = realAuth(t);
  });
  afterAll(async () => {
    await t.close();
  });

  it("refuses an unknown email, a wrong password and an administrator-set password, without granting anything", async () => {
    const e = `boot.${Date.now()}@c1a.example.test`;
    const u = await provisionUser(a, t, e);
    await expect(
      bootstrapPlatformSecurityAdmin(
        { email: "nobody@c1a.example.test", password: PASSWORD, verificationRef: "R" },
        { db: t.db },
      ),
    ).rejects.toMatchObject({ reason: "identity_not_verified" });
    await expect(
      bootstrapPlatformSecurityAdmin(
        { email: e, password: "guessed-password-000", verificationRef: "R" },
        { db: t.db },
      ),
    ).rejects.toMatchObject({ reason: "identity_not_verified" });
    await expect(
      bootstrapPlatformSecurityAdmin(
        { email: e, password: PASSWORD, verificationRef: "not a ref" },
        { db: t.db },
      ),
    ).rejects.toBeInstanceOf(BootstrapRefusedError);
    // a credential row Better Auth would not use (account_id is not the user id) proves nothing
    await t.pool.query("update accounts set account_id = 'not-the-user-id' where user_id = $1", [
      u.id,
    ]);
    await expect(
      bootstrapPlatformSecurityAdmin(
        { email: e, password: PASSWORD, verificationRef: "R" },
        { db: t.db },
      ),
    ).rejects.toMatchObject({ reason: "identity_not_verified" });
    await t.pool.query("update accounts set account_id = user_id::text where user_id = $1", [u.id]);
    await t.db
      .insert(schema.userSecurityState)
      .values({ userId: u.id, passwordChangeRequired: true });
    await expect(
      bootstrapPlatformSecurityAdmin(
        { email: e, password: PASSWORD, verificationRef: "R" },
        { db: t.db },
      ),
    ).rejects.toMatchObject({ reason: "password_change_required" });
    expect(
      (await t.pool.query("select count(*)::int n from platform_operator_roles")).rows[0].n,
    ).toBe(0);
    const denied = await t.db.select().from(schema.platformAuditEvents);
    expect(
      denied.every(
        (d) => d.outcome === "DENIED" && d.actorKind === "BOOTSTRAP" && d.actorUserId === null,
      ),
    ).toBe(true);
    expect(denied.find((d) => d.resultCode === "IDENTITY_NOT_VERIFIED")!.targetUserId).toBeNull(); // no guessed target recorded
  });

  it("five concurrent attempts for different verified users: exactly one succeeds, ever", async () => {
    const emails = Array.from({ length: 5 }, (_, i) => `boot${i}.${Date.now()}@c1a.example.test`);
    for (const e of emails) await provisionUser(a, t, e);
    const results = await Promise.allSettled(
      emails.map((e) =>
        bootstrapPlatformSecurityAdmin(
          { email: e, password: PASSWORD, verificationRef: "OWNER-1" },
          { db: serviceDb(t) },
        ),
      ),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const x of results.filter((y) => y.status === "rejected"))
      expect((x as PromiseRejectedResult).reason).toMatchObject({ reason: "already_bootstrapped" });
    const rows = await t.db.select().from(schema.platformOperatorRoles);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "PLATFORM_SECURITY_ADMIN",
      grantKind: "BOOTSTRAP",
      grantedByUserId: null,
      verificationRef: "OWNER-1",
    });
    const ok = (await t.db.select().from(schema.platformAuditEvents)).filter(
      (e) => e.outcome === "SUCCEEDED",
    );
    expect(ok).toEqual([
      expect.objectContaining({
        action: "platform.bootstrap",
        actorKind: "BOOTSTRAP",
        targetUserId: rows[0]!.userId,
        approvalRef: "OWNER-1",
      }),
    ]);

    // Even after the bootstrap grant is revoked (direct revocation as a stand-in), bootstrap stays closed.
    await t.pool.query(
      "update platform_operator_roles set status = 'REVOKED', revoked_by_user_id = user_id",
    );
    await expect(
      bootstrapPlatformSecurityAdmin(
        { email: emails[0]!, password: PASSWORD, verificationRef: "OWNER-2" },
        { db: t.db },
      ),
    ).rejects.toMatchObject({ reason: "already_bootstrapped" });
    expect(
      (await t.pool.query("select count(*)::int n from platform_operator_roles")).rows[0].n,
    ).toBe(1);
  });
});
