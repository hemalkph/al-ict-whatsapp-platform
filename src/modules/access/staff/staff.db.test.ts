import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, seedContact, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import {
  PASSWORD,
  headersWith,
  login,
  provisionUser,
  realAuth,
  serviceDb,
  type RealAuth,
} from "@/db/__tests__/real-auth";
import type { ProvisioningAuth } from "@/modules/auth/provisioning";
import {
  ForbiddenError,
  LastAdminRequiredError,
  NotFoundError,
  OperationRefusedError,
  PasswordChangeRequiredError,
  PasswordResetIncompleteError,
  ProvisioningIncompleteError,
  ValidationError,
  toErrorResponse,
} from "@/shared/errors/http-errors";
import { requireAccess, type AccessContext } from "../access";
import { can, type Role } from "../permissions";
import { assertNotLastActiveAdmin } from "./guards";
import {
  changeMemberRole,
  createStaff,
  listStaff,
  reactivateMember,
  resetStaffPassword,
  suspendMember,
} from "./index";

let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const NEW_PASSWORD = "brand-new-password-4242";
const SECOND_PASSWORD = "second-attempt-password-7";
const SCRYPT_HASH = /^[0-9a-f]{32}:[0-9a-f]{128}$/;
const MISSING_ID = "00000000-0000-4000-8000-0000000000ff";

type Member = {
  userId: string;
  email: string;
  membershipId: string;
  organizationId: string;
  role: Role;
  ctx: AccessContext;
};

describe("staff lifecycle service (real PostgreSQL + real Better Auth)", () => {
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

  const deps = () => ({ db: t.db, provisioner: a.prov });
  const ctxOf = (m: {
    userId: string;
    membershipId: string;
    organizationId: string;
    role: Role;
  }): AccessContext => ({
    ...m,
    can: (p) => can(m.role, p),
  });
  const newOrg = async () => (await seedOrg(t.db)).id;
  async function member(
    organizationId: string,
    role: Role,
    status: "ACTIVE" | "SUSPENDED" = "ACTIVE",
    label = role.toLowerCase(),
  ): Promise<Member> {
    const email = `${label}-${uniq()}@example.com`;
    const user = await provisionUser(a, t, email, { organizationId, role, status });
    const [m] = await t.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.userId, user.id));
    const base = { userId: user.id, email, membershipId: m!.id, organizationId, role };
    return { ...base, ctx: ctxOf(base) };
  }
  const membershipRow = async (id: string) =>
    (
      await t.db
        .select()
        .from(schema.organizationMemberships)
        .where(eq(schema.organizationMemberships.id, id))
    )[0]!;
  const sessionCount = async (userId: string) =>
    (await t.pool.query("select count(*)::int n from sessions where user_id = $1", [userId]))
      .rows[0].n as number;
  const activeAdmins = async (orgId: string) =>
    (
      await t.pool.query(
        "select count(*)::int n from organization_memberships where organization_id = $1 and role = 'ADMIN' and status = 'ACTIVE'",
        [orgId],
      )
    ).rows[0].n as number;
  const rowsFor = async (email: string) => {
    const r = await t.pool.query(
      `select (select count(*)::int from users where email = $1) users,
              (select count(*)::int from staff_provisioning_intents where email_key = $1) intents,
              (select count(*)::int from organization_memberships m join users u on u.id = m.user_id where u.email = $1) memberships,
              (select count(*)::int from user_security_state s join users u on u.id = s.user_id where u.email = $1) security_rows,
              (select count(*)::int from sessions s join users u on u.id = s.user_id where u.email = $1) sessions`,
      [email],
    );
    return r.rows[0] as {
      users: number;
      intents: number;
      memberships: number;
      security_rows: number;
      sessions: number;
    };
  };
  async function rejection(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected the promise to reject");
  }
  const bodyOf = async (e: unknown) => toErrorResponse(e).clone().text();
  const validCreate = (over: Record<string, unknown> = {}) => ({
    email: `new-${uniq()}@example.com`,
    name: "New Staff",
    role: "STAFF",
    initialPassword: PASSWORD,
    ...over,
  });

  // ------------------------------------------------------------------------------------------ createStaff
  describe("createStaff", () => {
    it("creates a normalized user with hashed credential, ACTIVE membership, forced password change, no session, no leftover intent", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const raw = `  New.Staff-${uniq()}@Example.COM `;
      const email = raw.trim().toLowerCase();

      const staff = await createStaff(
        admin.ctx,
        { email: raw, name: " New Staff ", role: "STAFF", initialPassword: PASSWORD },
        deps(),
      );

      expect(staff).toMatchObject({
        email,
        name: "New Staff",
        role: "STAFF",
        status: "ACTIVE",
        passwordChangeRequired: true,
      });
      expect(JSON.stringify(staff)).not.toMatch(/password"?:\s*"|hash|token/i);
      const r = await rowsFor(email);
      expect(r).toEqual({ users: 1, intents: 0, memberships: 1, security_rows: 1, sessions: 0 });

      const acct = await t.pool.query(
        "select a.provider_id, a.account_id, a.password, u.id from accounts a join users u on u.id = a.user_id where u.email = $1",
        [email],
      );
      expect(acct.rows).toHaveLength(1);
      expect(acct.rows[0]).toMatchObject({
        provider_id: "credential",
        account_id: acct.rows[0].id,
      });
      expect(acct.rows[0].password).toMatch(SCRYPT_HASH);
      expect(acct.rows[0].password).not.toContain(PASSWORD);

      const m = await membershipRow(staff.membershipId);
      expect(m).toMatchObject({
        organizationId: orgId,
        userId: staff.userId,
        role: "STAFF",
        status: "ACTIVE",
      });
      const sec = await t.db
        .select()
        .from(schema.userSecurityState)
        .where(eq(schema.userSecurityState.userId, staff.userId));
      expect(sec[0]!.passwordChangeRequired).toBe(true);
    });

    it("the new account can sign in with the initial password but is blocked by the password-change gate", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const input = validCreate();
      await createStaff(admin.ctx, input, deps());
      const cookie = await login(a, input.email as string, PASSWORD);
      await expect(
        requireAccess(headersWith(cookie), { db: t.db, auth: a.pub }),
      ).rejects.toBeInstanceOf(PasswordChangeRequiredError);
    });

    it("requires staff.manage (STAFF and VIEWER are refused and nothing is created)", async () => {
      const orgId = await newOrg();
      for (const role of ["STAFF", "VIEWER"] as const) {
        const actor = await member(orgId, role);
        const input = validCreate();
        expect(await rejection(createStaff(actor.ctx, input, deps()))).toBeInstanceOf(
          ForbiddenError,
        );
        expect(await rowsFor(input.email)).toEqual({
          users: 0,
          intents: 0,
          memberships: 0,
          security_rows: 0,
          sessions: 0,
        });
      }
    });

    it("rejects mass-assignment payloads and creates nothing", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const other = await newOrg();
      for (const extra of [
        { organizationId: other },
        { userId: MISSING_ID },
        { membershipId: MISSING_ID },
        { status: "ACTIVE" },
        { passwordChangeRequired: false },
      ]) {
        const input = validCreate(extra);
        expect(await rejection(createStaff(admin.ctx, input, deps()))).toBeInstanceOf(
          ValidationError,
        );
        expect(await rowsFor(input.email)).toEqual({
          users: 0,
          intents: 0,
          memberships: 0,
          security_rows: 0,
          sessions: 0,
        });
      }
    });

    it("refuses an email that already belongs to this organization's staff, leaving no intent behind", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const existing = await member(orgId, "STAFF");
      const err = await rejection(
        createStaff(admin.ctx, validCreate({ email: existing.email.toUpperCase() }), deps()),
      );
      expect(err).toBeInstanceOf(OperationRefusedError);
      expect(await rowsFor(existing.email)).toMatchObject({ users: 1, intents: 0, memberships: 1 });
    });

    it("GLOBAL IDENTITY: refuses (generically and identically) every kind of existing identity and never attaches it", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const orgC = await newOrg();
      const adminA = await member(orgA, "ADMIN");
      const adminC = await member(orgC, "ADMIN");

      const activeInB = await member(orgB, "STAFF");
      const suspendedInB = await member(orgB, "STAFF", "SUSPENDED");
      const orphanEmail = `orphan-${uniq()}@example.com`;
      const orphan = await provisionUser(a, t, orphanEmail); // exists globally, no membership, no intent
      const heldEmail = `held-${uniq()}@example.com`;
      await t.db.insert(schema.staffProvisioningIntents).values({
        organizationId: orgC,
        emailKey: heldEmail,
        requestedByMembershipId: adminC.membershipId,
      });

      const bodies: string[] = [];
      for (const email of [activeInB.email, suspendedInB.email, orphanEmail, heldEmail]) {
        const err = await rejection(createStaff(adminA.ctx, validCreate({ email }), deps()));
        expect(err).toBeInstanceOf(OperationRefusedError);
        bodies.push(await bodyOf(err));
      }
      expect(new Set(bodies).size).toBe(1); // indistinguishable
      expect(bodies[0]).not.toMatch(/organization|suspended|exists|already|identity|orgB|member/i);

      // nothing attached, nothing claimed, nothing deleted
      expect((await rowsFor(activeInB.email)).memberships).toBe(1);
      expect((await rowsFor(suspendedInB.email)).memberships).toBe(1);
      expect((await rowsFor(orphanEmail)).memberships).toBe(0);
      expect(await rowsFor(heldEmail)).toMatchObject({ intents: 1, users: 0 });
      const held = await t.db
        .select()
        .from(schema.staffProvisioningIntents)
        .where(eq(schema.staffProvisioningIntents.emailKey, heldEmail));
      expect(held[0]!.organizationId).toBe(orgC); // org C still owns it
      expect((await rowsFor(orphanEmail)).intents).toBe(0); // org A's fresh intent was cleaned up
      expect(orphan.id).toBeTruthy();
    });

    it("RESUME: the same organization can finish a crashed provisioning (intent + auth user + no membership)", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const email = `resume-${uniq()}@example.com`;
      // crashed workflow: intent acquired, Better Auth user created with the FIRST password, no membership
      await t.db.insert(schema.staffProvisioningIntents).values({
        organizationId: orgId,
        emailKey: email,
        requestedByMembershipId: admin.membershipId,
      });
      const crashed = await provisionUser(a, t, email);
      expect(await rowsFor(email)).toMatchObject({
        users: 1,
        intents: 1,
        memberships: 0,
        security_rows: 0,
      });

      const staff = await createStaff(
        admin.ctx,
        { email, name: "Resumed", role: "VIEWER", initialPassword: SECOND_PASSWORD },
        deps(),
      );

      expect(staff.userId).toBe(crashed.id);
      expect(await rowsFor(email)).toEqual({
        users: 1,
        intents: 0,
        memberships: 1,
        security_rows: 1,
        sessions: 0,
      });
      // the retry's password is now the effective one
      expect(
        (
          await a.pub.handler(
            new Request("http://localhost:3000/api/auth/sign-in/email", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: "http://localhost:3000",
                "x-forwarded-for": "10.9.9.1",
              },
              body: JSON.stringify({ email, password: PASSWORD }),
            }),
          )
        ).status,
      ).toBe(401);
      expect(await login(a, email, SECOND_PASSWORD)).toContain("session_token");
      const sec = await t.db
        .select()
        .from(schema.userSecurityState)
        .where(eq(schema.userSecurityState.userId, crashed.id));
      expect(sec[0]!.passwordChangeRequired).toBe(true);
    });

    it("RESUME: a DIFFERENT organization can neither resume nor claim the partially provisioned identity", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const adminA = await member(orgA, "ADMIN");
      const adminB = await member(orgB, "ADMIN");
      const email = `claim-${uniq()}@example.com`;
      await t.db.insert(schema.staffProvisioningIntents).values({
        organizationId: orgA,
        emailKey: email,
        requestedByMembershipId: adminA.membershipId,
      });
      await provisionUser(a, t, email);

      const err = await rejection(createStaff(adminB.ctx, validCreate({ email }), deps()));
      expect(err).toBeInstanceOf(OperationRefusedError);
      expect(await rowsFor(email)).toMatchObject({
        users: 1,
        intents: 1,
        memberships: 0,
        security_rows: 0,
      });
      const intent = await t.db
        .select()
        .from(schema.staffProvisioningIntents)
        .where(eq(schema.staffProvisioningIntents.emailKey, email));
      expect(intent[0]!.organizationId).toBe(orgA);
    });

    it("RESUME is refused (and the intent kept) when the identity already has a membership anywhere", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const adminA = await member(orgA, "ADMIN");
      const inB = await member(orgB, "STAFF");
      await t.db.insert(schema.staffProvisioningIntents).values({
        organizationId: orgA,
        emailKey: inB.email,
        requestedByMembershipId: adminA.membershipId,
      });
      const err = await rejection(
        createStaff(adminA.ctx, validCreate({ email: inB.email }), deps()),
      );
      expect(err).toBeInstanceOf(OperationRefusedError);
      expect(await rowsFor(inB.email)).toMatchObject({ intents: 1, memberships: 1 });
      expect(
        (
          await t.pool.query(
            "select count(*)::int n from organization_memberships where user_id = $1",
            [inB.userId],
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it("a failing application transaction leaves the intent, the auth user, and NO membership or security state; a retry then succeeds", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const input = validCreate();
      const sdb = serviceDb(t);
      const real = sdb.transaction.bind(sdb);
      vi.spyOn(sdb, "transaction").mockImplementationOnce((async (
        cb: (tx: never) => Promise<unknown>,
      ) =>
        real(async (tx) => {
          await cb(tx as never);
          throw new Error("simulated failure at commit time");
        })) as never);

      const err = await rejection(createStaff(admin.ctx, input, { db: sdb, provisioner: a.prov }));
      expect(err).toBeInstanceOf(ProvisioningIncompleteError);
      expect(await rowsFor(input.email)).toEqual({
        users: 1,
        intents: 1,
        memberships: 0,
        security_rows: 0,
        sessions: 0,
      });
      const [intent] = await t.db
        .select()
        .from(schema.staffProvisioningIntents)
        .where(eq(schema.staffProvisioningIntents.emailKey, input.email));
      expect(intent!.authUserId).toBeNull();
      const [user] = await t.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, input.email));
      expect(
        (
          await t.pool.query(
            "select exists(select 1 from organization_memberships where user_id = $1 and status = 'ACTIVE') as ok",
            [user!.id],
          )
        ).rows[0].ok,
      ).toBe(false);

      const retried = await createStaff(
        admin.ctx,
        { ...input, initialPassword: SECOND_PASSWORD },
        deps(),
      );
      expect(retried.userId).toBe(user!.id);
      expect(await rowsFor(input.email)).toEqual({
        users: 1,
        intents: 0,
        memberships: 1,
        security_rows: 1,
        sessions: 0,
      });
    });

    it("a Better Auth failure keeps the intent and creates no membership; a retry creates the user", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const input = validCreate();
      const failing = {
        api: {
          signUpEmail: async () => {
            throw new Error("auth down");
          },
        },
      } as unknown as ProvisioningAuth;
      expect(
        await rejection(createStaff(admin.ctx, input, { db: t.db, provisioner: failing })),
      ).toBeInstanceOf(ProvisioningIncompleteError);
      expect(await rowsFor(input.email)).toEqual({
        users: 0,
        intents: 1,
        memberships: 0,
        security_rows: 0,
        sessions: 0,
      });
      await createStaff(admin.ctx, input, deps());
      expect(await rowsFor(input.email)).toEqual({
        users: 1,
        intents: 0,
        memberships: 1,
        security_rows: 1,
        sessions: 0,
      });
    });

    it("does not trust the Better Auth response alone: a fabricated user id is rejected against the persisted row", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const input = validCreate();
      const fake = {
        api: { signUpEmail: async () => ({ token: null, user: { id: MISSING_ID } }) },
      } as unknown as ProvisioningAuth;
      expect(
        await rejection(createStaff(admin.ctx, input, { db: t.db, provisioner: fake })),
      ).toBeInstanceOf(ProvisioningIncompleteError);
      expect(await rowsFor(input.email)).toEqual({
        users: 0,
        intents: 1,
        memberships: 0,
        security_rows: 0,
        sessions: 0,
      });
    });

    it("re-validates the actor inside the transaction: an admin demoted before commit cannot create staff", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const other = await member(orgId, "ADMIN");
      await t.pool.query("update organization_memberships set role = 'VIEWER' where id = $1", [
        admin.membershipId,
      ]);
      const input = validCreate();
      // stale ctx still says ADMIN
      expect(await rejection(createStaff(admin.ctx, input, deps()))).toBeInstanceOf(
        ProvisioningIncompleteError,
      );
      expect((await rowsFor(input.email)).memberships).toBe(0);
      expect(other.userId).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------------------------- listStaff
  describe("listStaff", () => {
    it("returns only the caller's organization and only safe fields", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const adminA = await member(orgA, "ADMIN");
      const staffA = await member(orgA, "STAFF");
      const inB = await member(orgB, "ADMIN");
      await t.db
        .insert(schema.userSecurityState)
        .values({ userId: staffA.userId, passwordChangeRequired: true });
      await t.db
        .insert(schema.staffProvisioningIntents)
        .values({ organizationId: orgA, emailKey: `pending-${uniq()}@example.com` });

      const list = await listStaff(adminA.ctx, { db: t.db });
      expect(list.map((s) => s.email).sort()).toEqual([adminA.email, staffA.email].sort());
      expect(list.some((s) => s.email === inB.email)).toBe(false);
      for (const s of list) {
        expect(Object.keys(s).sort()).toEqual([
          "createdAt",
          "email",
          "membershipId",
          "name",
          "passwordChangeRequired",
          "role",
          "status",
          "userId",
        ]);
      }
      expect(list.find((s) => s.email === staffA.email)!.passwordChangeRequired).toBe(true);
      expect(list.find((s) => s.email === adminA.email)!.passwordChangeRequired).toBe(false); // missing row = false
      const dump = JSON.stringify(list);
      expect(dump).not.toMatch(
        /password"|hash|token|secret|provision|credential|ipAddress|scrypt/i,
      );
      expect(dump).not.toMatch(SCRYPT_HASH);
    });

    it("allows staff.read (STAFF) and refuses VIEWER", async () => {
      const orgId = await newOrg();
      const staff = await member(orgId, "STAFF");
      const viewer = await member(orgId, "VIEWER");
      expect((await listStaff(staff.ctx, { db: t.db })).length).toBe(2);
      expect(await rejection(listStaff(viewer.ctx, { db: t.db }))).toBeInstanceOf(ForbiddenError);
    });

    it("an organization with other tenants' data never sees it, even by guessing", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const adminA = await member(orgA, "ADMIN");
      await member(orgB, "STAFF", "ACTIVE", "secretb");
      const dump = JSON.stringify(await listStaff(adminA.ctx, { db: t.db }));
      expect(dump).not.toContain("secretb");
    });
  });

  // ------------------------------------------------------------------------------------- changeMemberRole
  describe("changeMemberRole", () => {
    it("ADMIN changes another member's role, visible on that member's next authorization lookup", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const target = await member(orgId, "STAFF");
      const cookie = await login(a, target.email);
      const access = () => requireAccess(headersWith(cookie), { db: t.db, auth: a.pub });
      expect((await access()).role).toBe("STAFF");

      await changeMemberRole(
        admin.ctx,
        { membershipId: target.membershipId, role: "VIEWER" },
        deps(),
      );
      expect((await access()).role).toBe("VIEWER");
      await changeMemberRole(
        admin.ctx,
        { membershipId: target.membershipId, role: "ADMIN" },
        deps(),
      );
      expect((await access()).role).toBe("ADMIN");
    });

    it("STAFF and VIEWER cannot change roles", async () => {
      const orgId = await newOrg();
      const target = await member(orgId, "VIEWER");
      for (const role of ["STAFF", "VIEWER"] as const) {
        const actor = await member(orgId, role);
        expect(
          await rejection(
            changeMemberRole(
              actor.ctx,
              { membershipId: target.membershipId, role: "ADMIN" },
              deps(),
            ),
          ),
        ).toBeInstanceOf(ForbiddenError);
      }
      expect((await membershipRow(target.membershipId)).role).toBe("VIEWER");
    });

    it("an actor cannot change their own role", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      await member(orgId, "ADMIN");
      expect(
        await rejection(
          changeMemberRole(admin.ctx, { membershipId: admin.membershipId, role: "VIEWER" }, deps()),
        ),
      ).toBeInstanceOf(OperationRefusedError);
      expect((await membershipRow(admin.membershipId)).role).toBe("ADMIN");
    });

    it("a foreign-organization membership id behaves exactly like a missing one (404, identical body)", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const adminA = await member(orgA, "ADMIN");
      const inB = await member(orgB, "STAFF");
      const foreign = await rejection(
        changeMemberRole(adminA.ctx, { membershipId: inB.membershipId, role: "ADMIN" }, deps()),
      );
      const missing = await rejection(
        changeMemberRole(adminA.ctx, { membershipId: MISSING_ID, role: "ADMIN" }, deps()),
      );
      expect(foreign).toBeInstanceOf(NotFoundError);
      expect(await bodyOf(foreign)).toBe(await bodyOf(missing));
      expect((await membershipRow(inB.membershipId)).role).toBe("STAFF");
    });

    it("rejects invalid roles and mass-assignment before touching the database", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const target = await member(orgId, "STAFF");
      for (const bad of [
        { membershipId: target.membershipId, role: "OWNER" },
        { membershipId: target.membershipId, role: "admin" },
        { membershipId: target.membershipId, role: "ADMIN", organizationId: MISSING_ID },
        { membershipId: target.membershipId, role: "ADMIN", userId: MISSING_ID },
        { membershipId: target.membershipId, role: "ADMIN", status: "ACTIVE" },
        { membershipId: target.membershipId, role: "ADMIN", passwordChangeRequired: false },
      ]) {
        expect(await rejection(changeMemberRole(admin.ctx, bad, deps()))).toBeInstanceOf(
          ValidationError,
        );
      }
      expect((await membershipRow(target.membershipId)).role).toBe("STAFF");
    });

    it("LAST-ADMIN invariant: the guard refuses to remove the only ACTIVE admin and allows it with two", async () => {
      const orgId = await newOrg();
      const only = await member(orgId, "ADMIN");
      const target = { role: "ADMIN" as const, status: "ACTIVE" as const };
      await expect(
        t.db.transaction((tx) => assertNotLastActiveAdmin(tx, orgId, target)),
      ).rejects.toBeInstanceOf(LastAdminRequiredError);
      await member(orgId, "ADMIN");
      await expect(
        t.db.transaction((tx) => assertNotLastActiveAdmin(tx, orgId, target)),
      ).resolves.toBeUndefined();
      // non-admin or already-suspended targets are never "last admin" problems
      await expect(
        t.db.transaction((tx) =>
          assertNotLastActiveAdmin(tx, orgId, { role: "STAFF", status: "ACTIVE" }),
        ),
      ).resolves.toBeUndefined();
      expect(only.userId).toBeTruthy();
    });

    it("a STALE admin context cannot demote the remaining admin (actor is re-validated; the invariant holds)", async () => {
      const orgId = await newOrg();
      const first = await member(orgId, "ADMIN");
      const second = await member(orgId, "ADMIN");
      await changeMemberRole(
        second.ctx,
        { membershipId: first.membershipId, role: "VIEWER" },
        deps(),
      ); // second is now the only admin
      const err = await rejection(
        changeMemberRole(first.ctx, { membershipId: second.membershipId, role: "VIEWER" }, deps()),
      );
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(await activeAdmins(orgId)).toBe(1);
      expect((await membershipRow(second.membershipId)).role).toBe("ADMIN");
    });

    it("a no-op role change succeeds without side effects", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const target = await member(orgId, "STAFF");
      await changeMemberRole(
        admin.ctx,
        { membershipId: target.membershipId, role: "STAFF" },
        deps(),
      );
      expect((await membershipRow(target.membershipId)).role).toBe("STAFF");
    });
  });

  // --------------------------------------------------------------------------- suspension / reactivation
  describe("suspendMember / reactivateMember", () => {
    it("suspends and reactivates; authorization disappears and returns on the next lookup; the role is never altered", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const target = await member(orgId, "STAFF");
      const cookie = await login(a, target.email);
      const access = () => requireAccess(headersWith(cookie), { db: t.db, auth: a.pub });
      expect((await access()).role).toBe("STAFF");

      expect(
        await suspendMember(admin.ctx, { membershipId: target.membershipId }, deps()),
      ).toMatchObject({ status: "SUSPENDED", sessionsRevoked: true });
      await expect(access()).rejects.toBeInstanceOf(Error); // 401: sessions revoked (exclusive identity)

      await reactivateMember(admin.ctx, { membershipId: target.membershipId }, deps());
      const row = await membershipRow(target.membershipId);
      expect(row).toMatchObject({ status: "ACTIVE", role: "STAFF" });
      const fresh = await login(a, target.email);
      expect((await requireAccess(headersWith(fresh), { db: t.db, auth: a.pub })).role).toBe(
        "STAFF",
      );
    });

    it("an ADMIN reactivated keeps the ADMIN role", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const other = await member(orgId, "ADMIN");
      await suspendMember(admin.ctx, { membershipId: other.membershipId }, deps());
      await reactivateMember(admin.ctx, { membershipId: other.membershipId }, deps());
      expect(await membershipRow(other.membershipId)).toMatchObject({
        role: "ADMIN",
        status: "ACTIVE",
      });
    });

    it("an actor cannot suspend themselves", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      await member(orgId, "ADMIN");
      expect(
        await rejection(suspendMember(admin.ctx, { membershipId: admin.membershipId }, deps())),
      ).toBeInstanceOf(OperationRefusedError);
      expect((await membershipRow(admin.membershipId)).status).toBe("ACTIVE");
    });

    it("requires staff.manage and treats a foreign membership id as 404", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const adminA = await member(orgA, "ADMIN");
      const staffA = await member(orgA, "STAFF");
      const inB = await member(orgB, "STAFF");
      expect(
        await rejection(suspendMember(staffA.ctx, { membershipId: adminA.membershipId }, deps())),
      ).toBeInstanceOf(ForbiddenError);
      const foreign = await rejection(
        suspendMember(adminA.ctx, { membershipId: inB.membershipId }, deps()),
      );
      const missing = await rejection(
        suspendMember(adminA.ctx, { membershipId: MISSING_ID }, deps()),
      );
      expect(foreign).toBeInstanceOf(NotFoundError);
      expect(await bodyOf(foreign)).toBe(await bodyOf(missing));
      expect((await membershipRow(inB.membershipId)).status).toBe("ACTIVE");
      expect(
        await rejection(reactivateMember(adminA.ctx, { membershipId: inB.membershipId }, deps())),
      ).toBeInstanceOf(NotFoundError);
    });

    it("rejects mass-assignment on suspend/reactivate", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const target = await member(orgId, "STAFF");
      for (const extra of [
        { role: "ADMIN" },
        { status: "ACTIVE" },
        { organizationId: MISSING_ID },
        { userId: MISSING_ID },
      ]) {
        expect(
          await rejection(
            suspendMember(admin.ctx, { membershipId: target.membershipId, ...extra }, deps()),
          ),
        ).toBeInstanceOf(ValidationError);
        expect(
          await rejection(
            reactivateMember(admin.ctx, { membershipId: target.membershipId, ...extra }, deps()),
          ),
        ).toBeInstanceOf(ValidationError);
      }
      expect((await membershipRow(target.membershipId)).status).toBe("ACTIVE");
    });

    it("a STALE admin context cannot suspend the remaining admin (the last-admin invariant holds)", async () => {
      const orgId = await newOrg();
      const first = await member(orgId, "ADMIN");
      const second = await member(orgId, "ADMIN");
      await suspendMember(second.ctx, { membershipId: first.membershipId }, deps());
      expect(
        await rejection(suspendMember(first.ctx, { membershipId: second.membershipId }, deps())),
      ).toBeInstanceOf(ForbiddenError);
      expect(await activeAdmins(orgId)).toBe(1);
    });

    it("suspending an already-suspended member is a harmless no-op", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const target = await member(orgId, "STAFF", "SUSPENDED");
      expect(
        await suspendMember(admin.ctx, { membershipId: target.membershipId }, deps()),
      ).toMatchObject({ sessionsRevoked: false });
    });

    describe("global session rule", () => {
      it("REVOKES the user's sessions when no other ACTIVE membership exists", async () => {
        const orgId = await newOrg();
        const admin = await member(orgId, "ADMIN");
        const target = await member(orgId, "STAFF");
        await login(a, target.email);
        await login(a, target.email);
        expect(await sessionCount(target.userId)).toBe(2);
        await suspendMember(admin.ctx, { membershipId: target.membershipId }, deps());
        expect(await sessionCount(target.userId)).toBe(0);
      });

      it("revokes sessions when the only other membership is itself SUSPENDED", async () => {
        const orgA = await newOrg();
        const orgB = await newOrg();
        const adminA = await member(orgA, "ADMIN");
        const target = await member(orgA, "STAFF");
        await t.db.insert(schema.organizationMemberships).values({
          organizationId: orgB,
          userId: target.userId,
          role: "STAFF",
          status: "SUSPENDED",
        });
        await login(a, target.email);
        await suspendMember(adminA.ctx, { membershipId: target.membershipId }, deps());
        expect(await sessionCount(target.userId)).toBe(0);
      });

      it("KEEPS sessions when another organization still has an ACTIVE membership; this organization's access still fails", async () => {
        const orgA = await newOrg();
        const orgB = await newOrg();
        const adminA = await member(orgA, "ADMIN");
        const target = await member(orgA, "STAFF");
        await t.db
          .insert(schema.organizationMemberships)
          .values({ organizationId: orgB, userId: target.userId, role: "ADMIN", status: "ACTIVE" });
        // two ACTIVE memberships fail closed (409) at login-time access; suspend A and the session must survive for B
        const cookie = await login(a, target.email);
        expect(await sessionCount(target.userId)).toBe(1);

        const res = await suspendMember(adminA.ctx, { membershipId: target.membershipId }, deps());
        expect(res.sessionsRevoked).toBe(false);
        expect(await sessionCount(target.userId)).toBe(1);
        expect(await a.pub.api.getSession({ headers: headersWith(cookie) })).not.toBeNull();
        const ctx = await requireAccess(headersWith(cookie), { db: t.db, auth: a.pub });
        expect(ctx.organizationId).toBe(orgB); // never org A again
        expect((await membershipRow(target.membershipId)).status).toBe("SUSPENDED");
      });
    });
  });

  // ---------------------------------------------------------------------------------------- concurrency
  describe("concurrency (organization row lock)", () => {
    it("two admins demoting each other never leave zero ACTIVE admins; exactly one succeeds", async () => {
      for (let i = 0; i < 6; i++) {
        const orgId = await newOrg();
        const x = await member(orgId, "ADMIN");
        const y = await member(orgId, "ADMIN");
        const results = await Promise.allSettled([
          changeMemberRole(x.ctx, { membershipId: y.membershipId, role: "VIEWER" }, deps()),
          changeMemberRole(y.ctx, { membershipId: x.membershipId, role: "VIEWER" }, deps()),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(await activeAdmins(orgId)).toBe(1);
      }
    });

    it("two admins suspending each other never leave zero ACTIVE admins; exactly one succeeds", async () => {
      for (let i = 0; i < 6; i++) {
        const orgId = await newOrg();
        const x = await member(orgId, "ADMIN");
        const y = await member(orgId, "ADMIN");
        const results = await Promise.allSettled([
          suspendMember(x.ctx, { membershipId: y.membershipId }, deps()),
          suspendMember(y.ctx, { membershipId: x.membershipId }, deps()),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(await activeAdmins(orgId)).toBe(1);
      }
    });

    it("a demote racing a suspend between two admins also leaves exactly one succeeding", async () => {
      for (let i = 0; i < 6; i++) {
        const orgId = await newOrg();
        const x = await member(orgId, "ADMIN");
        const y = await member(orgId, "ADMIN");
        const results = await Promise.allSettled([
          changeMemberRole(x.ctx, { membershipId: y.membershipId, role: "STAFF" }, deps()),
          suspendMember(y.ctx, { membershipId: x.membershipId }, deps()),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(await activeAdmins(orgId)).toBe(1);
      }
    });

    it("a three-admin cycle (A->B, B->C, C->A) always ends with exactly one ACTIVE admin", async () => {
      for (let i = 0; i < 4; i++) {
        const orgId = await newOrg();
        const [p, q, r] = [
          await member(orgId, "ADMIN"),
          await member(orgId, "ADMIN"),
          await member(orgId, "ADMIN"),
        ];
        const results = await Promise.allSettled([
          changeMemberRole(p.ctx, { membershipId: q.membershipId, role: "VIEWER" }, deps()),
          changeMemberRole(q.ctx, { membershipId: r.membershipId, role: "VIEWER" }, deps()),
          changeMemberRole(r.ctx, { membershipId: p.membershipId, role: "VIEWER" }, deps()),
        ]);
        expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(2);
        expect(await activeAdmins(orgId)).toBe(1);
      }
    });
  });

  // ------------------------------------------------------------------------------------ password reset
  describe("resetStaffPassword", () => {
    it("resets an organization-exclusive identity: new password works, old fails, flag set, sessions revoked", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const target = await member(orgId, "STAFF");
      await login(a, target.email);
      await login(a, target.email);
      expect(await sessionCount(target.userId)).toBe(2);

      const res = await resetStaffPassword(
        admin.ctx,
        { membershipId: target.membershipId, newPassword: NEW_PASSWORD },
        deps(),
      );
      expect(res).toEqual({ membershipId: target.membershipId, passwordChangeRequired: true });

      expect(await sessionCount(target.userId)).toBe(0);
      const sec = await t.db
        .select()
        .from(schema.userSecurityState)
        .where(eq(schema.userSecurityState.userId, target.userId));
      expect(sec[0]!.passwordChangeRequired).toBe(true);
      const old = await a.pub.handler(
        new Request("http://localhost:3000/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3000",
            "x-forwarded-for": "10.9.9.2",
          },
          body: JSON.stringify({ email: target.email, password: PASSWORD }),
        }),
      );
      expect(old.status).toBe(401);
      const cookie = await login(a, target.email, NEW_PASSWORD);
      await expect(
        requireAccess(headersWith(cookie), { db: t.db, auth: a.pub }),
      ).rejects.toBeInstanceOf(PasswordChangeRequiredError);
      const acct = await t.pool.query(
        "select password from accounts where user_id = $1 and provider_id = 'credential'",
        [target.userId],
      );
      expect(acct.rows).toHaveLength(1);
      expect(acct.rows[0].password).toMatch(SCRYPT_HASH);
      expect(acct.rows[0].password).not.toContain(NEW_PASSWORD);
      // no reset token is left behind
      expect(
        (
          await t.pool.query(
            "select count(*)::int n from verifications where identifier like 'reset-password:%'",
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it("REFUSES a shared identity generically and changes nothing", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const adminA = await member(orgA, "ADMIN");
      const shared = await member(orgA, "STAFF");
      await t.db
        .insert(schema.organizationMemberships)
        .values({ organizationId: orgB, userId: shared.userId, role: "STAFF" });
      await t.db
        .insert(schema.userSecurityState)
        .values({ userId: shared.userId, passwordChangeRequired: false });
      const cookie = await login(a, shared.email); // two ACTIVE memberships: session creation is allowed

      const err = await rejection(
        resetStaffPassword(
          adminA.ctx,
          { membershipId: shared.membershipId, newPassword: NEW_PASSWORD },
          deps(),
        ),
      );
      expect(err).toBeInstanceOf(OperationRefusedError);
      expect(await bodyOf(err)).not.toMatch(/organization|shared|other|identity/i);
      expect(await sessionCount(shared.userId)).toBe(1); // sessions untouched
      expect(await a.pub.api.getSession({ headers: headersWith(cookie) })).not.toBeNull();
      expect(
        (
          await t.db
            .select()
            .from(schema.userSecurityState)
            .where(eq(schema.userSecurityState.userId, shared.userId))
        )[0]!.passwordChangeRequired,
      ).toBe(false);
      expect(await login(a, shared.email, PASSWORD)).toContain("session_token"); // old password still valid
    });

    it("refuses self-reset, requires staff.manage, and 404s foreign/missing membership ids identically", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const adminA = await member(orgA, "ADMIN");
      const staffA = await member(orgA, "STAFF");
      const inB = await member(orgB, "STAFF");
      expect(
        await rejection(
          resetStaffPassword(
            adminA.ctx,
            { membershipId: adminA.membershipId, newPassword: NEW_PASSWORD },
            deps(),
          ),
        ),
      ).toBeInstanceOf(OperationRefusedError);
      expect(
        await rejection(
          resetStaffPassword(
            staffA.ctx,
            { membershipId: adminA.membershipId, newPassword: NEW_PASSWORD },
            deps(),
          ),
        ),
      ).toBeInstanceOf(ForbiddenError);
      const foreign = await rejection(
        resetStaffPassword(
          adminA.ctx,
          { membershipId: inB.membershipId, newPassword: NEW_PASSWORD },
          deps(),
        ),
      );
      const missing = await rejection(
        resetStaffPassword(
          adminA.ctx,
          { membershipId: MISSING_ID, newPassword: NEW_PASSWORD },
          deps(),
        ),
      );
      expect(foreign).toBeInstanceOf(NotFoundError);
      expect(await bodyOf(foreign)).toBe(await bodyOf(missing));
    });

    it("enforces 12-128 characters and rejects mass assignment before any change", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const target = await member(orgId, "STAFF");
      for (const bad of [
        { membershipId: target.membershipId, newPassword: "short" },
        { membershipId: target.membershipId, newPassword: "x".repeat(129) },
        {
          membershipId: target.membershipId,
          newPassword: NEW_PASSWORD,
          passwordChangeRequired: false,
        },
        { membershipId: target.membershipId, newPassword: NEW_PASSWORD, role: "ADMIN" },
        { membershipId: target.membershipId, newPassword: NEW_PASSWORD, userId: MISSING_ID },
      ]) {
        expect(await rejection(resetStaffPassword(admin.ctx, bad, deps()))).toBeInstanceOf(
          ValidationError,
        );
      }
      expect(await login(a, target.email, PASSWORD)).toContain("session_token");
    });

    it("a mid-flow failure is fail-closed: password-change flag set, sessions revoked, old password still valid, retry works", async () => {
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const target = await member(orgId, "STAFF");
      await login(a, target.email);
      const broken = {
        api: {
          requestPasswordReset: async () => {
            throw new Error("auth down");
          },
          resetPassword: async () => undefined,
        },
      } as unknown as ProvisioningAuth;
      const err = await rejection(
        resetStaffPassword(
          admin.ctx,
          { membershipId: target.membershipId, newPassword: NEW_PASSWORD },
          { db: t.db, provisioner: broken },
        ),
      );
      expect(err).toBeInstanceOf(PasswordResetIncompleteError);
      expect(
        (
          await t.db
            .select()
            .from(schema.userSecurityState)
            .where(eq(schema.userSecurityState.userId, target.userId))
        )[0]!.passwordChangeRequired,
      ).toBe(true);
      expect(await sessionCount(target.userId)).toBe(0);
      await resetStaffPassword(
        admin.ctx,
        { membershipId: target.membershipId, newPassword: NEW_PASSWORD },
        deps(),
      );
      expect(await login(a, target.email, NEW_PASSWORD)).toContain("session_token");
    });
  });

  // ------------------------------------------------------------------------------------ security events
  describe("security events and secrets", () => {
    it("emits the lifecycle events with only allow-listed identifiers", async () => {
      logs.length = 0;
      const orgId = await newOrg();
      const admin = await member(orgId, "ADMIN");
      const staff = await createStaff(admin.ctx, validCreate(), deps());
      await changeMemberRole(
        admin.ctx,
        { membershipId: staff.membershipId, role: "VIEWER" },
        deps(),
      );
      await suspendMember(admin.ctx, { membershipId: staff.membershipId }, deps());
      await reactivateMember(admin.ctx, { membershipId: staff.membershipId }, deps());
      await resetStaffPassword(
        admin.ctx,
        { membershipId: staff.membershipId, newPassword: NEW_PASSWORD },
        deps(),
      );

      const events = logs.filter((l) => l.includes("security_event")).map((l) => JSON.parse(l));
      const names = events.map((e) => e.security_event);
      for (const expected of [
        "staff.created",
        "membership.role_changed",
        "membership.suspended",
        "membership.reactivated",
        "staff.password_reset",
      ]) {
        expect(names).toContain(expected);
      }
      const created = events.find((e) => e.security_event === "staff.created");
      expect(created).toMatchObject({
        user_id: admin.userId,
        organization_id: orgId,
        target_user_id: staff.userId,
        role: "STAFF",
      });
      expect(events.find((e) => e.security_event === "membership.role_changed")).toMatchObject({
        previous_role: "STAFF",
        role: "VIEWER",
      });
      const allowed = new Set([
        "level",
        "message",
        "time",
        "security_event",
        "outcome",
        "user_id",
        "organization_id",
        "membership_id",
        "target_user_id",
        "target_membership_id",
        "role",
        "previous_role",
        "permission",
        "reason",
        "email_hash",
      ]);
      for (const e of events) for (const k of Object.keys(e)) expect(allowed.has(k), k).toBe(true);
    });

    it("never wrote any password, hash, token or secret to the logs during this whole file", () => {
      const all = logs.join("\n");
      for (const secret of [PASSWORD, NEW_PASSWORD, SECOND_PASSWORD])
        expect(all).not.toContain(secret);
      expect(all).not.toMatch(/[0-9a-f]{32}:[0-9a-f]{128}/);
      expect(all).not.toMatch(/reset-password\//i);
      expect(all).not.toMatch(/session_token/);
    });
  });

  // tenant sanity: staff operations never touch other tenants' non-staff data
  it("staff operations do not affect other organizations' data", async () => {
    const orgA = await newOrg();
    const orgB = await newOrg();
    const adminA = await member(orgA, "ADMIN");
    const adminB = await member(orgB, "ADMIN");
    await seedContact(t.db, orgB);
    await createStaff(adminA.ctx, validCreate(), deps());
    expect((await listStaff(adminB.ctx, { db: t.db })).map((s) => s.userId)).toEqual([
      adminB.userId,
    ]);
    expect(
      (
        await t.pool.query("select count(*)::int n from contacts where organization_id = $1", [
          orgB,
        ])
      ).rows[0].n,
    ).toBe(1);
  });
});
