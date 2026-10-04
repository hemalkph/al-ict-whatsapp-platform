import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, seedContact, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import {
  headersWith,
  login,
  provisionUser,
  realAuth,
  type RealAuth,
} from "@/db/__tests__/real-auth";
import {
  ForbiddenError,
  NotFoundError,
  OrganizationSelectionRequiredError,
  PasswordChangeRequiredError,
  UnauthenticatedError,
  toErrorResponse,
} from "@/shared/errors/http-errors";
import { requireAccess, requirePermission, requireUser, type AccessContext } from "./access";

let n = 0;
const email = (label: string) => `${label}-${Date.now().toString(36)}${n++}@example.com`;

describe("access context from a real session + ACTIVE membership (real PostgreSQL)", () => {
  let t: TestDb;
  let a: RealAuth;
  beforeAll(async () => {
    t = await createTestDatabase();
    a = realAuth(t);
  });
  afterAll(async () => t.close());
  afterEach(() => vi.restoreAllMocks());

  const deps = () => ({ db: t.db, auth: a.pub });
  /** Provisions + signs in a user with the given membership; returns headers carrying only the session cookie. */
  async function actor(role: "ADMIN" | "STAFF" | "VIEWER", orgId?: string) {
    const organizationId = orgId ?? (await seedOrg(t.db)).id;
    const address = email(role.toLowerCase());
    const user = await provisionUser(a, t, address, { organizationId, role });
    const cookie = await login(a, address);
    return { user, organizationId, cookie, headers: headersWith(cookie), address };
  }
  const membershipOf = async (userId: string) =>
    (
      await t.db
        .select()
        .from(schema.organizationMemberships)
        .where(eq(schema.organizationMemberships.userId, userId))
    )[0]!;
  const expectRejects = async (p: Promise<unknown>, type: new (...args: never[]) => Error) => {
    let caught: unknown;
    try {
      await p;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(type);
    return caught as Error & { httpStatus: number; code: string };
  };

  describe("valid access", () => {
    it("builds an AccessContext from the session and the ACTIVE membership", async () => {
      const x = await actor("STAFF");
      const ctx = await requireAccess(x.headers, deps());
      const membership = await membershipOf(x.user.id);
      expect(ctx).toMatchObject({
        userId: x.user.id,
        membershipId: membership.id,
        organizationId: x.organizationId,
        role: "STAFF",
      });
      expect(ctx.can("conversation.reply")).toBe(true);
      expect(ctx.can("staff.manage")).toBe(false);
    });

    it("works with a database session after sign-in and exposes only the approved shape", async () => {
      const x = await actor("ADMIN");
      const ctx = await requireAccess(x.headers, deps());
      expect(Object.keys(ctx).sort()).toEqual([
        "can",
        "membershipId",
        "organizationId",
        "role",
        "userId",
      ]);
      expect(ctx.can("staff.manage")).toBe(true);
    });

    it("ignores browser-supplied organization, role, membership and user hints", async () => {
      const org = await seedOrg(t.db);
      const other = await seedOrg(t.db);
      const x = await actor("VIEWER", org.id);
      const spoofed = headersWith(x.cookie, {
        "x-organization-id": other.id,
        "x-role": "ADMIN",
        "x-membership-id": "00000000-0000-4000-8000-000000000000",
        "x-user-id": "00000000-0000-4000-8000-000000000001",
      });
      const ctx = await requireAccess(spoofed, deps());
      expect(ctx.organizationId).toBe(org.id);
      expect(ctx.role).toBe("VIEWER");
      expect(ctx.userId).toBe(x.user.id);
    });
  });

  describe("authentication failures (401)", () => {
    it("rejects requests without a session", async () => {
      const e = await expectRejects(requireAccess(new Headers(), deps()), UnauthenticatedError);
      expect(e.httpStatus).toBe(401);
    });

    it("rejects a forged or garbage session cookie", async () => {
      for (const cookie of [
        "better-auth.session_token=garbage",
        "better-auth.session_token=abc.def",
        "x=1",
      ]) {
        await expectRejects(requireAccess(headersWith(cookie), deps()), UnauthenticatedError);
      }
    });

    it("rejects a deleted session immediately (cookie cache off)", async () => {
      const x = await actor("STAFF");
      await requireAccess(x.headers, deps());
      await t.pool.query("delete from sessions where user_id = $1", [x.user.id]);
      await expectRejects(requireAccess(x.headers, deps()), UnauthenticatedError);
    });

    it("rejects an expired session", async () => {
      const x = await actor("STAFF");
      await requireAccess(x.headers, deps());
      await t.pool.query(
        "update sessions set expires_at = now() - interval '1 minute' where user_id = $1",
        [x.user.id],
      );
      await expectRejects(requireAccess(x.headers, deps()), UnauthenticatedError);
    });
  });

  describe("membership resolution (403 / 409, fail closed)", () => {
    it("rejects a user with no membership at all (partially provisioned) even with identity proof", async () => {
      const x = await actor("STAFF");
      await t.pool.query("delete from organization_memberships where user_id = $1", [x.user.id]); // simulate partial state
      const e = await expectRejects(requireAccess(x.headers, deps()), ForbiddenError);
      expect(e.httpStatus).toBe(403);
      // identity alone is still available for flows that need only a session
      expect((await requireUser(x.headers, deps())).userId).toBe(x.user.id);
    });

    it("rejects a SUSPENDED membership", async () => {
      const x = await actor("STAFF");
      await t.pool.query(
        "update organization_memberships set status = 'SUSPENDED' where user_id = $1",
        [x.user.id],
      );
      await expectRejects(requireAccess(x.headers, deps()), ForbiddenError);
    });

    it("fails closed with 409 when two memberships are ACTIVE (no organization selector yet)", async () => {
      const x = await actor("STAFF");
      const second = await seedOrg(t.db);
      await t.db
        .insert(schema.organizationMemberships)
        .values({ organizationId: second.id, userId: x.user.id, role: "ADMIN" });
      const e = await expectRejects(
        requireAccess(x.headers, deps()),
        OrganizationSelectionRequiredError,
      );
      expect(e.httpStatus).toBe(409);
    });

    it("uses the single ACTIVE membership when the other one is SUSPENDED", async () => {
      const x = await actor("STAFF");
      const second = await seedOrg(t.db);
      await t.db.insert(schema.organizationMemberships).values({
        organizationId: second.id,
        userId: x.user.id,
        role: "ADMIN",
        status: "SUSPENDED",
      });
      const ctx = await requireAccess(x.headers, deps());
      expect(ctx.organizationId).toBe(x.organizationId);
      expect(ctx.role).toBe("STAFF");
    });

    it("a membership in another organization cannot be used as authority for this one", async () => {
      const orgA = await seedOrg(t.db);
      const orgB = await seedOrg(t.db);
      const a1 = await actor("STAFF", orgA.id);
      const b1 = await actor("ADMIN", orgB.id);
      const ctxA = await requireAccess(a1.headers, deps());
      const ctxB = await requireAccess(b1.headers, deps());
      expect(ctxA.organizationId).toBe(orgA.id);
      expect(ctxB.organizationId).toBe(orgB.id);
      expect(ctxA.membershipId).not.toBe(ctxB.membershipId);
      expect(ctxA.can("staff.manage")).toBe(false); // org B's ADMIN rights do not leak to org A's STAFF
    });
  });

  describe("changes take effect on the next authorization lookup", () => {
    it("role changes are visible immediately on the same session", async () => {
      const x = await actor("STAFF");
      expect((await requireAccess(x.headers, deps())).can("staff.manage")).toBe(false);
      await expectRejects(requirePermission(x.headers, "staff.manage", deps()), ForbiddenError);

      await t.pool.query("update organization_memberships set role = 'ADMIN' where user_id = $1", [
        x.user.id,
      ]);
      const promoted = await requireAccess(x.headers, deps());
      expect(promoted.role).toBe("ADMIN");
      expect((await requirePermission(x.headers, "staff.manage", deps())).role).toBe("ADMIN");

      await t.pool.query("update organization_memberships set role = 'VIEWER' where user_id = $1", [
        x.user.id,
      ]);
      await expectRejects(requirePermission(x.headers, "contact.edit", deps()), ForbiddenError);
      expect((await requirePermission(x.headers, "contact.read", deps())).role).toBe("VIEWER");
    });

    it("suspension is visible immediately on the same still-valid session; reactivation restores access", async () => {
      const x = await actor("STAFF");
      await requireAccess(x.headers, deps());
      await t.pool.query(
        "update organization_memberships set status = 'SUSPENDED' where user_id = $1",
        [x.user.id],
      );
      expect(await a.pub.api.getSession({ headers: x.headers })).not.toBeNull(); // the session itself is still valid
      await expectRejects(requireAccess(x.headers, deps()), ForbiddenError);
      await t.pool.query(
        "update organization_memberships set status = 'ACTIVE' where user_id = $1",
        [x.user.id],
      );
      expect((await requireAccess(x.headers, deps())).userId).toBe(x.user.id);
    });
  });

  describe("requirePermission", () => {
    it.each([
      ["ADMIN", "staff.manage", true],
      ["ADMIN", "webhook.manage", true],
      ["STAFF", "conversation.reply", true],
      ["STAFF", "staff.manage", false],
      ["STAFF", "organization.manage", false],
      ["VIEWER", "contact.read", true],
      ["VIEWER", "contact.edit", false],
      ["VIEWER", "conversation.reply", false],
    ] as const)("%s + %s -> %s", async (role, permission, allowed) => {
      const x = await actor(role);
      if (allowed) expect((await requirePermission(x.headers, permission, deps())).role).toBe(role);
      else {
        const e = await expectRejects(
          requirePermission(x.headers, permission, deps()),
          ForbiddenError,
        );
        expect(e.httpStatus).toBe(403);
      }
    });
  });

  describe("password_change_required gate", () => {
    const setState = (userId: string, required: boolean) =>
      t.db
        .insert(schema.userSecurityState)
        .values({ userId, passwordChangeRequired: required })
        .onConflictDoUpdate({
          target: schema.userSecurityState.userId,
          set: { passwordChangeRequired: required },
        });

    it("a missing user_security_state row means false (access allowed)", async () => {
      const x = await actor("STAFF");
      expect(
        await t.db
          .select()
          .from(schema.userSecurityState)
          .where(eq(schema.userSecurityState.userId, x.user.id)),
      ).toHaveLength(0);
      await requireAccess(x.headers, deps());
    });

    it("an explicit false row allows access", async () => {
      const x = await actor("STAFF");
      await setState(x.user.id, false);
      await requireAccess(x.headers, deps());
    });

    it("password_change_required = true blocks normal access with PASSWORD_CHANGE_REQUIRED, including permission checks", async () => {
      const x = await actor("ADMIN");
      await setState(x.user.id, true);
      const e = await expectRejects(requireAccess(x.headers, deps()), PasswordChangeRequiredError);
      expect([e.httpStatus, e.code]).toEqual([403, "PASSWORD_CHANGE_REQUIRED"]);
      await expectRejects(
        requirePermission(x.headers, "contact.read", deps()),
        PasswordChangeRequiredError,
      );
    });

    it("the gate is decided by the database, never by browser input", async () => {
      const x = await actor("STAFF");
      await setState(x.user.id, true);
      const spoofed = headersWith(x.cookie, {
        "x-password-change-required": "false",
        "x-password-changed": "true",
      });
      await expectRejects(requireAccess(spoofed, deps()), PasswordChangeRequiredError);
    });

    it("only the explicit opt-in used by the future password-change flow bypasses it; identity checks still work", async () => {
      const x = await actor("STAFF");
      await setState(x.user.id, true);
      const ctx = await requireAccess(x.headers, { ...deps(), allowPasswordChangeRequired: true });
      expect(ctx.userId).toBe(x.user.id);
      expect((await requireUser(x.headers, deps())).userId).toBe(x.user.id);
    });

    it("clearing the flag restores normal access on the next call", async () => {
      const x = await actor("STAFF");
      await setState(x.user.id, true);
      await expectRejects(requireAccess(x.headers, deps()), PasswordChangeRequiredError);
      await setState(x.user.id, false);
      await requireAccess(x.headers, deps());
    });

    it("a user with no membership gets 403 (not the password gate) so nothing about security state leaks", async () => {
      const x = await actor("STAFF");
      await setState(x.user.id, true);
      await t.pool.query("delete from organization_memberships where user_id = $1", [x.user.id]);
      await expectRejects(requireAccess(x.headers, deps()), ForbiddenError);
    });
  });

  describe("tenant scoping pattern: foreign-organization resources are indistinguishable from missing ones", () => {
    // The pattern every feature module must follow: scope by ctx.organizationId and answer 404 otherwise.
    async function findContact(ctx: AccessContext, id: string) {
      const [row] = await t.db
        .select()
        .from(schema.contacts)
        .where(
          and(eq(schema.contacts.organizationId, ctx.organizationId), eq(schema.contacts.id, id)),
        );
      if (!row) throw new NotFoundError();
      return row;
    }

    it("another organization's contact id yields the same 404 as a non-existent id", async () => {
      const orgA = await seedOrg(t.db);
      const orgB = await seedOrg(t.db);
      const a1 = await actor("STAFF", orgA.id);
      const ctxA = await requireAccess(a1.headers, deps());
      const own = await seedContact(t.db, orgA.id);
      const foreign = await seedContact(t.db, orgB.id);

      expect((await findContact(ctxA, own.id)).id).toBe(own.id);
      const foreignRes = await toErrorResponse(
        await findContact(ctxA, foreign.id).catch((e) => e),
      ).text();
      const missingRes = await toErrorResponse(
        await findContact(ctxA, "00000000-0000-4000-8000-0000000000ff").catch((e) => e),
      ).text();
      expect(foreignRes).toBe(missingRes);
      expect(JSON.parse(foreignRes).error.code).toBe("NOT_FOUND");
      expect(foreignRes).not.toContain(orgB.id);
      expect(foreignRes).not.toContain(foreign.id);
    });
  });

  describe("security events and error responses", () => {
    it("maps every access failure to the right status without leaking identifiers", async () => {
      const x = await actor("VIEWER");
      const cases: Array<[Promise<unknown>, number, string]> = [
        [requireAccess(new Headers(), deps()), 401, "UNAUTHENTICATED"],
        [requirePermission(x.headers, "staff.manage", deps()), 403, "FORBIDDEN"],
      ];
      for (const [promise, status, code] of cases) {
        const res = toErrorResponse(await promise.catch((e) => e));
        const body = await res.json();
        expect([res.status, body.error.code]).toEqual([status, code]);
        expect(JSON.stringify(body)).not.toContain(x.organizationId);
        expect(JSON.stringify(body)).not.toContain(x.user.id);
      }
    });

    it("never writes the session token, cookie or password into security logs", async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const x = await actor("VIEWER");
      const token = x.cookie.split("=")[1] ?? "";
      await requirePermission(x.headers, "staff.manage", deps()).catch(() => undefined);
      await requireAccess(headersWith("better-auth.session_token=garbage"), deps()).catch(
        () => undefined,
      );
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("access.permission_denied");
      expect(logged).toContain("access.unauthenticated");
      expect(logged).not.toContain(token.slice(0, 16));
      expect(logged).not.toContain("garbage");
      expect(logged).not.toMatch(/correct-horse-battery|better-auth\.session_token/);
    });
  });
});
