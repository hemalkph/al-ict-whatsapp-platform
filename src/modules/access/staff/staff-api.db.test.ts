import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import {
  PASSWORD,
  TEST_AUTH_ENV,
  login,
  provisionUser,
  realAuth,
  useGlobalAuth,
  type RealAuth,
} from "@/db/__tests__/real-auth";
import type { Role } from "../permissions";

// Route-level tests: the REAL handlers, real sessions (cookies) and real PostgreSQL. Business rules are covered by
// the service tests; these prove the HTTP boundary: authentication, authorization, same-origin, strict input, safe
// responses, IDOR behavior and the absence of secrets in responses and logs.

const ORIGIN = TEST_AUTH_ENV.origin;
const MISSING_ID = "00000000-0000-4000-8000-0000000000ff";
const NEW_PASSWORD = "route-new-password-9876";
const INITIAL_PASSWORD = "route-initial-password-5432";
const SCRYPT_HASH = /[0-9a-f]{32}:[0-9a-f]{128}/;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

type Routes = {
  staff: typeof import("../../../app/api/staff/route");
  role: typeof import("../../../app/api/staff/[membershipId]/role/route");
  suspend: typeof import("../../../app/api/staff/[membershipId]/suspend/route");
  reactivate: typeof import("../../../app/api/staff/[membershipId]/reactivate/route");
  reset: typeof import("../../../app/api/staff/[membershipId]/reset-password/route");
};
type Actor = {
  userId: string;
  email: string;
  membershipId: string;
  organizationId: string;
  role: Role;
  cookie: string;
};
type Opts = {
  cookie?: string;
  body?: unknown;
  rawBody?: string;
  contentType?: string | null;
  origin?: string | null;
  headers?: Record<string, string>;
};

describe("staff management HTTP API (real routes, sessions and PostgreSQL)", () => {
  let t: TestDb;
  let a: RealAuth;
  let r: Routes;
  let release: () => Promise<void>;
  const logs: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    a = realAuth(t);
    release = useGlobalAuth(t);
    r = {
      staff: await import("../../../app/api/staff/route"),
      role: await import("../../../app/api/staff/[membershipId]/role/route"),
      suspend: await import("../../../app/api/staff/[membershipId]/suspend/route"),
      reactivate: await import("../../../app/api/staff/[membershipId]/reactivate/route"),
      reset: await import("../../../app/api/staff/[membershipId]/reset-password/route"),
    };
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

  // ------------------------------------------------------------------------------------------ helpers
  const newOrg = async () => (await seedOrg(t.db)).id;
  async function actor(
    organizationId: string,
    role: Role,
    status: "ACTIVE" | "SUSPENDED" = "ACTIVE",
  ): Promise<Actor> {
    const email = `${role.toLowerCase()}-${uniq()}@example.com`;
    const user = await provisionUser(a, t, email, { organizationId, role, status });
    const [m] = await t.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.userId, user.id));
    const cookie = status === "ACTIVE" ? await login(a, email) : "";
    return { userId: user.id, email, membershipId: m!.id, organizationId, role, cookie };
  }
  function req(method: string, path: string, o: Opts = {}) {
    const headers: Record<string, string> = { ...o.headers };
    if (o.cookie) headers.cookie = o.cookie;
    if (method !== "GET" && o.origin !== null) headers.origin = o.origin ?? ORIGIN;
    let body: string | undefined;
    if (o.rawBody !== undefined) body = o.rawBody;
    else if (o.body !== undefined) body = JSON.stringify(o.body);
    if (body !== undefined && o.contentType !== null)
      headers["content-type"] = o.contentType ?? "application/json";
    return new Request(`${ORIGIN}${path}`, { method, headers, body });
  }
  const ctxFor = (membershipId: string) => ({ params: Promise.resolve({ membershipId }) });
  const list = (o: Opts) => r.staff.GET(req("GET", "/api/staff", o));
  const create = (o: Opts) => r.staff.POST(req("POST", "/api/staff", o));
  const changeRole = (id: string, o: Opts) =>
    r.role.PATCH(req("PATCH", `/api/staff/${id}/role`, o), ctxFor(id));
  const suspend = (id: string, o: Opts) =>
    r.suspend.POST(req("POST", `/api/staff/${id}/suspend`, o), ctxFor(id));
  const reactivate = (id: string, o: Opts) =>
    r.reactivate.POST(req("POST", `/api/staff/${id}/reactivate`, o), ctxFor(id));
  const reset = (id: string, o: Opts) =>
    r.reset.POST(req("POST", `/api/staff/${id}/reset-password`, o), ctxFor(id));
  const validCreate = (over: Record<string, unknown> = {}) => ({
    email: `New.Person-${uniq()}@Example.com`,
    name: "New Person",
    role: "STAFF",
    initialPassword: INITIAL_PASSWORD,
    ...over,
  });
  const membership = async (id: string) =>
    (
      await t.db
        .select()
        .from(schema.organizationMemberships)
        .where(eq(schema.organizationMemberships.id, id))
    )[0]!;
  const userCount = async () =>
    (await t.pool.query("select count(*)::int n from users")).rows[0].n as number;
  const intentCount = async () =>
    (await t.pool.query("select count(*)::int n from staff_provisioning_intents")).rows[0]
      .n as number;
  const activeAdmins = async (orgId: string) =>
    (
      await t.pool.query(
        "select count(*)::int n from organization_memberships where organization_id = $1 and role = 'ADMIN' and status = 'ACTIVE'",
        [orgId],
      )
    ).rows[0].n as number;
  const sessionCount = async (userId: string) =>
    (await t.pool.query("select count(*)::int n from sessions where user_id = $1", [userId]))
      .rows[0].n as number;
  const signIn = async (email: string, password: string) =>
    (
      await a.pub.handler(
        new Request(`${ORIGIN}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            "x-forwarded-for": `10.77.${n++ % 250}.${(n * 7) % 250}`,
          },
          body: JSON.stringify({ email, password }),
        }),
      )
    ).status;
  const codeOf = async (res: Response) =>
    ((await res.clone().json()) as { error?: { code?: string } }).error?.code;

  // --------------------------------------------------------------------------------------- route boundary
  describe("route files stay thin and import only public APIs", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === "route.ts") files.push(full);
      }
    };
    walk(new URL("../../../app/api/staff", import.meta.url).pathname);

    it("finds all five route files", () => {
      expect(files).toHaveLength(5);
    });

    it("imports only the access public API and the shared HTTP helper (no db, provisioner, tables or internals)", () => {
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
        for (const spec of imports)
          expect(["@/modules/access", "@/lib/route-helpers"], `${file}: ${spec}`).toContain(spec);
        const code = source.replace(/\/\/.*$/gm, "");
        expect(code).not.toMatch(
          /@\/db|provision|schema\.|drizzle|better-auth|\.accounts|\.sessions/,
        );
        expect(code.split("\n").length).toBeLessThan(30); // thin: no business logic lives here
      }
    });
  });

  // -------------------------------------------------------------------------------------------- authN/Z
  describe("authentication and authorization", () => {
    it("rejects unauthenticated requests with 401 on every endpoint", async () => {
      const org = await newOrg();
      const target = await actor(org, "STAFF");
      const calls = [
        list({}),
        create({ body: validCreate() }),
        changeRole(target.membershipId, { body: { role: "VIEWER" } }),
        suspend(target.membershipId, {}),
        reactivate(target.membershipId, {}),
        reset(target.membershipId, { body: { newPassword: NEW_PASSWORD } }),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(401);
        expect(await codeOf(res)).toBe("UNAUTHENTICATED");
      }
      expect((await membership(target.membershipId)).role).toBe("STAFF");
    });

    it("rejects forged and garbage cookies with 401", async () => {
      for (const cookie of ["better-auth.session_token=forged.value", "x=1"])
        expect((await list({ cookie })).status).toBe(401);
    });

    it("ADMIN and STAFF may list (staff.read); VIEWER may not", async () => {
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      const staff = await actor(org, "STAFF");
      const viewer = await actor(org, "VIEWER");
      expect((await list({ cookie: admin.cookie })).status).toBe(200);
      expect((await list({ cookie: staff.cookie })).status).toBe(200);
      const denied = await list({ cookie: viewer.cookie });
      expect(denied.status).toBe(403);
      expect(await codeOf(denied)).toBe("FORBIDDEN");
    });

    it("STAFF and VIEWER cannot perform any mutation (403, nothing changes)", async () => {
      const org = await newOrg();
      const target = await actor(org, "VIEWER");
      for (const who of [await actor(org, "STAFF"), await actor(org, "VIEWER")]) {
        const email = validCreate().email;
        const results = [
          await create({ cookie: who.cookie, body: validCreate({ email }) }),
          await changeRole(target.membershipId, { cookie: who.cookie, body: { role: "ADMIN" } }),
          await suspend(target.membershipId, { cookie: who.cookie }),
          await reactivate(target.membershipId, { cookie: who.cookie }),
          await reset(target.membershipId, {
            cookie: who.cookie,
            body: { newPassword: NEW_PASSWORD },
          }),
        ];
        for (const res of results) expect(res.status).toBe(403);
        expect(
          (
            await t.pool.query("select count(*)::int n from users where email = $1", [
              email.toLowerCase(),
            ])
          ).rows[0].n,
        ).toBe(0);
      }
      expect(await membership(target.membershipId)).toMatchObject({
        role: "VIEWER",
        status: "ACTIVE",
      });
    });

    it("forged organization / role / user headers have no effect", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const adminA = await actor(orgA, "ADMIN");
      const viewerA = await actor(orgA, "VIEWER");
      const inB = await actor(orgB, "STAFF");
      const forged = {
        "x-organization-id": orgB,
        "x-role": "ADMIN",
        "x-user-id": adminA.userId,
        "x-membership-id": adminA.membershipId,
      };
      // a VIEWER claiming ADMIN is still refused
      expect((await list({ cookie: viewerA.cookie, headers: forged })).status).toBe(403);
      expect(
        (await create({ cookie: viewerA.cookie, headers: forged, body: validCreate() })).status,
      ).toBe(403);
      // an ADMIN of org A claiming org B still only sees org A
      const res = await list({ cookie: adminA.cookie, headers: forged });
      const emails = ((await res.json()) as { staff: Array<{ email: string }> }).staff.map(
        (s) => s.email,
      );
      expect(emails).toContain(adminA.email);
      expect(emails).not.toContain(inB.email);
    });

    it("a user with a pending password change is blocked from staff endpoints", async () => {
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      await t.db
        .insert(schema.userSecurityState)
        .values({ userId: admin.userId, passwordChangeRequired: true });
      const res = await list({ cookie: admin.cookie });
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe("PASSWORD_CHANGE_REQUIRED");
    });
  });

  // ----------------------------------------------------------------------------------------- same-origin
  describe("same-origin protection on every mutation", () => {
    const cases: Array<[string, (admin: Actor, target: Actor, o: Opts) => Promise<Response>]> = [
      [
        "POST /api/staff",
        (admin, _t, o) => create({ ...o, cookie: admin.cookie, body: validCreate() }),
      ],
      [
        "PATCH role",
        (admin, target, o) =>
          changeRole(target.membershipId, { ...o, cookie: admin.cookie, body: { role: "VIEWER" } }),
      ],
      [
        "POST suspend",
        (admin, target, o) => suspend(target.membershipId, { ...o, cookie: admin.cookie }),
      ],
      [
        "POST reactivate",
        (admin, target, o) => reactivate(target.membershipId, { ...o, cookie: admin.cookie }),
      ],
      [
        "POST reset-password",
        (admin, target, o) =>
          reset(target.membershipId, {
            ...o,
            cookie: admin.cookie,
            body: { newPassword: NEW_PASSWORD },
          }),
      ],
    ];

    it.each(cases)(
      "%s: foreign, malformed, opaque and missing origin evidence are all 403 and change nothing",
      async (_name, call) => {
        const org = await newOrg();
        const admin = await actor(org, "ADMIN");
        const target = await actor(org, "STAFF");
        const users = await userCount();
        for (const o of [
          { origin: "https://evil.example" },
          { origin: "not a url" },
          { origin: "null" },
          { origin: "http://localhost:3000.evil.example" },
          { origin: null }, // no Origin and no Sec-Fetch-Site evidence
          { origin: null, headers: { "sec-fetch-site": "cross-site" } },
          { origin: null, headers: { "sec-fetch-site": "same-site" } },
        ]) {
          const res = await call(admin, target, o);
          expect(res.status, JSON.stringify(o)).toBe(403);
          expect(await codeOf(res)).toBe("FORBIDDEN");
        }
        expect(await userCount()).toBe(users);
        expect(await membership(target.membershipId)).toMatchObject({
          role: "STAFF",
          status: "ACTIVE",
        });
      },
    );

    it("accepts the correct Origin, and Sec-Fetch-Site: same-origin when Origin is absent", async () => {
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      const target = await actor(org, "STAFF");
      expect(
        (await changeRole(target.membershipId, { cookie: admin.cookie, body: { role: "VIEWER" } }))
          .status,
      ).toBe(200);
      const viaFetchMetadata = await changeRole(target.membershipId, {
        cookie: admin.cookie,
        body: { role: "STAFF" },
        origin: null,
        headers: { "sec-fetch-site": "same-origin" },
      });
      expect(viaFetchMetadata.status).toBe(200);
    });

    it("GET is not subject to the mutation guard", async () => {
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      expect(
        (
          await r.staff.GET(
            new Request(`${ORIGIN}/api/staff`, {
              headers: { cookie: admin.cookie, origin: "https://evil.example" },
            }),
          )
        ).status,
      ).toBe(200);
    });

    it("rejects non-JSON content types and malformed or oversized bodies with 400", async () => {
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      const users = await userCount();
      const json = JSON.stringify(validCreate());
      for (const o of [
        { rawBody: json, contentType: "text/plain" },
        { rawBody: json, contentType: null },
        { rawBody: "{not json", contentType: "application/json" },
        { rawBody: "", contentType: "application/json" },
        { rawBody: JSON.stringify({ pad: "x".repeat(20_000) }), contentType: "application/json" },
      ]) {
        const res = await create({ ...o, cookie: admin.cookie });
        expect(res.status, JSON.stringify(o).slice(0, 60)).toBe(400);
        expect(await codeOf(res)).toBe("VALIDATION_ERROR");
      }
      expect(await userCount()).toBe(users);
    });
  });

  // ------------------------------------------------------------------------------------------------ list
  describe("GET /api/staff", () => {
    it("returns only this organization with the exact safe fields and no credential/session/provisioning data", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const admin = await actor(orgA, "ADMIN");
      const staff = await actor(orgA, "STAFF");
      const inB = await actor(orgB, "ADMIN");
      await t.db
        .insert(schema.staffProvisioningIntents)
        .values({ organizationId: orgA, emailKey: `pending-${uniq()}@example.com` });

      const res = await list({ cookie: admin.cookie });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as { staff: Array<Record<string, unknown>> };
      expect(Object.keys(body)).toEqual(["staff"]);
      expect(body.staff.map((s) => s.email).sort()).toEqual([admin.email, staff.email].sort());
      for (const s of body.staff) {
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
      const dump = JSON.stringify(body);
      expect(dump).not.toContain(inB.email);
      expect(dump).not.toMatch(
        /password"|hash|token|secret|provision|credential|ipAddress|scrypt|accounts|sessions/i,
      );
      expect(dump).not.toMatch(SCRYPT_HASH);
    });
  });

  // ---------------------------------------------------------------------------------------------- create
  describe("POST /api/staff", () => {
    it("creates staff: 201, normalized email, safe member only, password neither returned nor stored in clear", async () => {
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      const input = validCreate({ email: `  Mixed.Case-${uniq()}@Example.COM  ` });
      logs.length = 0;
      const res = await create({ cookie: admin.cookie, body: input });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { staff: Record<string, unknown> };
      expect(Object.keys(body)).toEqual(["staff"]);
      expect(Object.keys(body.staff).sort()).toEqual([
        "createdAt",
        "email",
        "membershipId",
        "name",
        "passwordChangeRequired",
        "role",
        "status",
        "userId",
      ]);
      expect(body.staff).toMatchObject({
        email: (input.email as string).trim().toLowerCase(),
        name: "New Person",
        role: "STAFF",
        status: "ACTIVE",
        passwordChangeRequired: true,
      });
      const text = JSON.stringify(body);
      expect(text).not.toContain(INITIAL_PASSWORD);
      expect(text).not.toMatch(SCRYPT_HASH);
      expect(text).not.toMatch(/token|provision|intent|account|session/i);
      // persisted correctly, org from the actor's context
      const m = await membership(body.staff.membershipId as string);
      expect(m).toMatchObject({ organizationId: org, role: "STAFF", status: "ACTIVE" });
      expect(
        (
          await t.pool.query(
            "select count(*)::int n from staff_provisioning_intents where email_key = $1",
            [body.staff.email],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(logs.join("\n")).not.toContain(INITIAL_PASSWORD);
    });

    it("the created account can sign in with the initial password (and must then change it)", async () => {
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      const input = validCreate();
      expect((await create({ cookie: admin.cookie, body: input })).status).toBe(201);
      expect(await signIn((input.email as string).toLowerCase(), INITIAL_PASSWORD)).toBe(200);
    });

    it("generic, identical refusals for every kind of existing identity (409), nothing attached", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const orgC = await newOrg();
      const adminA = await actor(orgA, "ADMIN");
      const adminC = await actor(orgC, "ADMIN");
      const sameOrg = await actor(orgA, "STAFF");
      const inB = await actor(orgB, "STAFF");
      const suspendedB = await actor(orgB, "STAFF", "SUSPENDED");
      const orphanEmail = `orphan-${uniq()}@example.com`;
      await provisionUser(a, t, orphanEmail);
      const heldEmail = `held-${uniq()}@example.com`;
      await t.db.insert(schema.staffProvisioningIntents).values({
        organizationId: orgC,
        emailKey: heldEmail,
        requestedByMembershipId: adminC.membershipId,
      });

      const bodies = new Set<string>();
      for (const email of [sameOrg.email, inB.email, suspendedB.email, orphanEmail, heldEmail]) {
        const res = await create({ cookie: adminA.cookie, body: validCreate({ email }) });
        expect(res.status).toBe(409);
        bodies.add(await res.text());
      }
      expect(bodies.size).toBe(1); // the HTTP layer cannot distinguish them
      const only = [...bodies][0]!;
      expect(JSON.parse(only).error.code).toBe("OPERATION_REFUSED");
      expect(only).not.toMatch(/organization|suspended|exists|already|identity|member|intent/i);
      for (const e of [inB.email, suspendedB.email]) {
        expect(
          (
            await t.pool.query(
              "select count(*)::int n from organization_memberships m join users u on u.id = m.user_id where u.email = $1",
              [e],
            )
          ).rows[0].n,
        ).toBe(1);
      }
      expect(
        (
          await t.pool.query(
            "select count(*)::int n from organization_memberships m join users u on u.id = m.user_id where u.email = $1",
            [orphanEmail],
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it("rejects mass-assignment fields with 400 and creates nothing", async () => {
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      const users = await userCount();
      const intents = await intentCount();
      for (const extra of [
        { organizationId: org },
        { userId: MISSING_ID },
        { membershipId: MISSING_ID },
        { status: "ACTIVE" },
        { passwordChangeRequired: false },
        { authUserId: MISSING_ID },
        { requestedByMembershipId: MISSING_ID },
      ]) {
        const res = await create({ cookie: admin.cookie, body: validCreate(extra) });
        expect(res.status, JSON.stringify(extra)).toBe(400);
        expect(await codeOf(res)).toBe("VALIDATION_ERROR");
        expect(JSON.stringify(await res.json())).not.toContain(INITIAL_PASSWORD);
      }
      expect(await userCount()).toBe(users);
      expect(await intentCount()).toBe(intents);
    });

    it("validates fields (invalid role, short password, bad email) with 400 naming fields only", async () => {
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      for (const [over, field] of [
        [{ role: "OWNER" }, "role"],
        [{ initialPassword: "short" }, "initialPassword"],
        [{ email: "nope" }, "email"],
      ] as const) {
        const res = await create({ cookie: admin.cookie, body: validCreate(over) });
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(JSON.parse(text).error.fields).toContain(field);
        expect(text).not.toMatch(/short|nope|OWNER/);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------ role
  describe("PATCH /api/staff/:id/role", () => {
    it("changes a role (200) and rejects invalid roles, extra fields and a body-supplied membershipId (400)", async () => {
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      const target = await actor(org, "STAFF");
      const ok = await changeRole(target.membershipId, {
        cookie: admin.cookie,
        body: { role: "VIEWER" },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ membershipId: target.membershipId, role: "VIEWER" });
      expect((await membership(target.membershipId)).role).toBe("VIEWER");

      for (const body of [
        { role: "OWNER" },
        { role: "admin" },
        { role: "ADMIN", organizationId: org },
        { role: "ADMIN", userId: MISSING_ID },
        { role: "ADMIN", status: "ACTIVE" },
        { role: "ADMIN", passwordChangeRequired: false },
        { role: "ADMIN", membershipId: MISSING_ID },
        {},
      ]) {
        const res = await changeRole(target.membershipId, { cookie: admin.cookie, body });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect((await membership(target.membershipId)).role).toBe("VIEWER");
      expect(
        (await changeRole("not-a-uuid", { cookie: admin.cookie, body: { role: "ADMIN" } })).status,
      ).toBe(400);
    });

    it("refuses self-mutation (409, generic)", async () => {
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      await actor(org, "ADMIN");
      const res = await changeRole(admin.membershipId, {
        cookie: admin.cookie,
        body: { role: "VIEWER" },
      });
      expect(res.status).toBe(409);
      expect(await codeOf(res)).toBe("OPERATION_REFUSED");
      expect((await membership(admin.membershipId)).role).toBe("ADMIN");
    });

    it("keeps the last ADMIN: a demoted admin can no longer demote the remaining one, and a simultaneous race leaves exactly one", async () => {
      const org = await newOrg();
      const x = await actor(org, "ADMIN");
      const y = await actor(org, "ADMIN");
      expect(
        (await changeRole(y.membershipId, { cookie: x.cookie, body: { role: "VIEWER" } })).status,
      ).toBe(200);
      const back = await changeRole(x.membershipId, { cookie: y.cookie, body: { role: "VIEWER" } }); // y is a VIEWER now
      expect(back.status).toBe(403);
      expect(await activeAdmins(org)).toBe(1);

      for (let i = 0; i < 4; i++) {
        const o = await newOrg();
        const p = await actor(o, "ADMIN");
        const q = await actor(o, "ADMIN");
        const [one, two] = await Promise.all([
          changeRole(q.membershipId, { cookie: p.cookie, body: { role: "VIEWER" } }),
          changeRole(p.membershipId, { cookie: q.cookie, body: { role: "VIEWER" } }),
        ]);
        expect([one.status, two.status].filter((s) => s === 200)).toHaveLength(1);
        expect([one.status, two.status].filter((s) => s === 403 || s === 409)).toHaveLength(1);
        expect(await activeAdmins(o)).toBe(1);
      }
    });

    it("answers a foreign membership id exactly like a missing one (404, identical bodies)", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const adminA = await actor(orgA, "ADMIN");
      const inB = await actor(orgB, "STAFF");
      const foreign = await changeRole(inB.membershipId, {
        cookie: adminA.cookie,
        body: { role: "ADMIN" },
      });
      const missing = await changeRole(MISSING_ID, {
        cookie: adminA.cookie,
        body: { role: "ADMIN" },
      });
      expect([foreign.status, missing.status]).toEqual([404, 404]);
      expect(await foreign.text()).toBe(await missing.text());
      expect((await membership(inB.membershipId)).role).toBe("STAFF");
    });
  });

  // ------------------------------------------------------------------------------------ suspend/reactivate
  describe("POST /api/staff/:id/suspend and /reactivate", () => {
    it("runs the normal lifecycle with minimal responses (no session-revocation detail), reactivation keeps the role", async () => {
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      const target = await actor(org, "STAFF");
      expect(await sessionCount(target.userId)).toBe(1);

      const sus = await suspend(target.membershipId, { cookie: admin.cookie });
      expect(sus.status).toBe(200);
      expect(await sus.json()).toEqual({ membershipId: target.membershipId, status: "SUSPENDED" }); // no sessionsRevoked
      expect(await sessionCount(target.userId)).toBe(0); // exclusive identity: sessions revoked by the service

      const rea = await reactivate(target.membershipId, { cookie: admin.cookie });
      expect(rea.status).toBe(200);
      expect(await rea.json()).toEqual({ membershipId: target.membershipId, status: "ACTIVE" });
      expect(await membership(target.membershipId)).toMatchObject({
        status: "ACTIVE",
        role: "STAFF",
      });
    });

    it("session handling stays correct for shared identities and is indistinguishable in the response", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const adminA = await actor(orgA, "ADMIN");
      const exclusive = await actor(orgA, "STAFF");
      const shared = await actor(orgA, "STAFF");
      await t.db
        .insert(schema.organizationMemberships)
        .values({ organizationId: orgB, userId: shared.userId, role: "STAFF", status: "ACTIVE" });
      const a1 = await suspend(exclusive.membershipId, { cookie: adminA.cookie });
      const a2 = await suspend(shared.membershipId, { cookie: adminA.cookie });
      expect(await sessionCount(exclusive.userId)).toBe(0);
      expect(await sessionCount(shared.userId)).toBe(1); // kept: still ACTIVE in org B
      expect((await a1.text()).replace(exclusive.membershipId, "X")).toBe(
        (await a2.text()).replace(shared.membershipId, "X"),
      );
    });

    it("refuses self-suspension (409) and rejects extra fields (400); foreign id is 404 like a missing id", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const admin = await actor(orgA, "ADMIN");
      const other = await actor(orgA, "ADMIN");
      const inB = await actor(orgB, "STAFF");
      const self = await suspend(admin.membershipId, { cookie: admin.cookie });
      expect(self.status).toBe(409);
      expect((await membership(admin.membershipId)).status).toBe("ACTIVE");
      for (const body of [
        { role: "ADMIN" },
        { status: "ACTIVE" },
        { organizationId: orgB },
        { userId: MISSING_ID },
        { membershipId: MISSING_ID },
      ]) {
        expect(
          (await suspend(other.membershipId, { cookie: admin.cookie, body })).status,
          JSON.stringify(body),
        ).toBe(400);
        expect((await reactivate(other.membershipId, { cookie: admin.cookie, body })).status).toBe(
          400,
        );
      }
      const foreign = await suspend(inB.membershipId, { cookie: admin.cookie });
      const missing = await suspend(MISSING_ID, { cookie: admin.cookie });
      expect([foreign.status, missing.status]).toEqual([404, 404]);
      expect(await foreign.text()).toBe(await missing.text());
      expect((await reactivate(inB.membershipId, { cookie: admin.cookie })).status).toBe(404);
      expect((await membership(inB.membershipId)).status).toBe("ACTIVE");
    });

    it("last admin stays protected under a race (exactly one suspension wins)", async () => {
      for (let i = 0; i < 4; i++) {
        const o = await newOrg();
        const p = await actor(o, "ADMIN");
        const q = await actor(o, "ADMIN");
        const [one, two] = await Promise.all([
          suspend(q.membershipId, { cookie: p.cookie }),
          suspend(p.membershipId, { cookie: q.cookie }),
        ]);
        expect([one.status, two.status].filter((s) => s === 200)).toHaveLength(1);
        expect(await activeAdmins(o)).toBe(1);
      }
    });
  });

  // ------------------------------------------------------------------------------------- password reset
  describe("POST /api/staff/:id/reset-password", () => {
    it("resets an organization-exclusive identity: 200, minimal body, flag set, sessions revoked, new password works", async () => {
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      const target = await actor(org, "STAFF");
      logs.length = 0;
      const res = await reset(target.membershipId, {
        cookie: admin.cookie,
        body: { newPassword: NEW_PASSWORD },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        membershipId: target.membershipId,
        passwordChangeRequired: true,
      });
      const [state] = await t.db
        .select()
        .from(schema.userSecurityState)
        .where(eq(schema.userSecurityState.userId, target.userId));
      expect(state!.passwordChangeRequired).toBe(true);
      expect(await sessionCount(target.userId)).toBe(0);
      expect(await signIn(target.email, PASSWORD)).toBe(401);
      expect(await signIn(target.email, NEW_PASSWORD)).toBe(200);
      expect(logs.join("\n")).not.toContain(NEW_PASSWORD);
    });

    it("refuses a shared global identity (409) and changes nothing", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const adminA = await actor(orgA, "ADMIN");
      const shared = await actor(orgA, "STAFF");
      await t.db
        .insert(schema.organizationMemberships)
        .values({ organizationId: orgB, userId: shared.userId, role: "STAFF" });
      const res = await reset(shared.membershipId, {
        cookie: adminA.cookie,
        body: { newPassword: NEW_PASSWORD },
      });
      expect(res.status).toBe(409);
      expect(await codeOf(res)).toBe("OPERATION_REFUSED");
      expect(await res.text()).not.toMatch(/organization|shared|other|identity/i);
      expect(await signIn(shared.email, PASSWORD)).toBe(200);
      expect(await sessionCount(shared.userId)).toBeGreaterThanOrEqual(1);
    });

    it("rejects short/long/missing passwords and extra fields (400) before any change", async () => {
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      const target = await actor(org, "STAFF");
      for (const body of [
        { newPassword: "short" },
        { newPassword: "x".repeat(129) },
        {},
        { newPassword: NEW_PASSWORD, passwordChangeRequired: false },
        { newPassword: NEW_PASSWORD, role: "ADMIN" },
        { newPassword: NEW_PASSWORD, userId: MISSING_ID },
        { newPassword: NEW_PASSWORD, membershipId: MISSING_ID },
      ]) {
        const res = await reset(target.membershipId, { cookie: admin.cookie, body });
        expect(res.status, JSON.stringify(body).slice(0, 50)).toBe(400);
        expect(await res.text()).not.toContain(NEW_PASSWORD);
      }
      expect(await signIn(target.email, PASSWORD)).toBe(200);
    });

    it("cross-organization membership id is a 404 identical to a missing id; self-reset is refused", async () => {
      const orgA = await newOrg();
      const orgB = await newOrg();
      const adminA = await actor(orgA, "ADMIN");
      const inB = await actor(orgB, "STAFF");
      const foreign = await reset(inB.membershipId, {
        cookie: adminA.cookie,
        body: { newPassword: NEW_PASSWORD },
      });
      const missing = await reset(MISSING_ID, {
        cookie: adminA.cookie,
        body: { newPassword: NEW_PASSWORD },
      });
      expect([foreign.status, missing.status]).toEqual([404, 404]);
      expect(await foreign.text()).toBe(await missing.text());
      expect(
        (
          await reset(adminA.membershipId, {
            cookie: adminA.cookie,
            body: { newPassword: NEW_PASSWORD },
          })
        ).status,
      ).toBe(409);
      expect(await signIn(inB.email, PASSWORD)).toBe(200);
    });
  });

  // --------------------------------------------------------------------------------------- secrets in logs
  describe("secrets never leak", () => {
    it("no submitted password, hash, reset token or session cookie appears in any response or log, including failures", async () => {
      logs.length = 0;
      const org = await newOrg();
      const admin = await actor(org, "ADMIN");
      const target = await actor(org, "STAFF");
      const secretA = "leak-check-initial-password-111";
      const secretB = "leak-check-reset-password-222";
      const responses: string[] = [];
      for (const res of [
        await create({ cookie: admin.cookie, body: validCreate({ initialPassword: secretA }) }), // success
        await create({
          cookie: admin.cookie,
          body: validCreate({ initialPassword: secretA, organizationId: org }),
        }), // 400
        await create({
          cookie: admin.cookie,
          origin: "https://evil.example",
          body: validCreate({ initialPassword: secretA }),
        }), // 403
        await create({
          cookie: admin.cookie,
          rawBody: `{"initialPassword":"${secretA}"`,
          contentType: "application/json",
        }), // malformed
        await reset(target.membershipId, { cookie: admin.cookie, body: { newPassword: secretB } }), // success
        await reset(MISSING_ID, { cookie: admin.cookie, body: { newPassword: secretB } }), // 404
        await reset(target.membershipId, {
          cookie: admin.cookie,
          body: { newPassword: secretB, userId: MISSING_ID },
        }), // 400
      ]) {
        responses.push(await res.text());
      }
      const everything = [...responses, ...logs].join("\n");
      for (const secret of [secretA, secretB, admin.cookie.split("=")[1] ?? "x"])
        expect(everything).not.toContain(secret.slice(0, 24));
      expect(everything).not.toMatch(SCRYPT_HASH);
      expect(everything).not.toMatch(/reset-password[:/][A-Za-z0-9]{10,}/);
      expect(everything).not.toMatch(/session_token/);
    });
  });
});
