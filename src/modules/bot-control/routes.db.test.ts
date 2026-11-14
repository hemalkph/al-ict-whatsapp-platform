import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import {
  TEST_AUTH_ENV,
  login,
  provisionUser,
  realAuth,
  useGlobalAuth,
  type RealAuth,
} from "@/db/__tests__/real-auth";
import { createTestDatabase, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import type { Role } from "@/modules/access";
import { minimalFlow } from "@/modules/bots/testing";
import { canonicalJson } from "@/shared/canonical-json";
import { botWorld, deployedBot, insertSession } from "./testing";

// The Bot management HTTP API (DEV-1): the REAL route handlers, real Better Auth sessions and real PostgreSQL. Business rules
// are covered by the service tests; these prove the HTTP boundary: authentication, the permission matrix, same-origin, strict
// input, byte limits, tenant isolation, revision-protected saves, and that nothing here publishes, deploys, runs or sends.

const ORIGIN = TEST_AUTH_ENV.origin;
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const MARKER = "MARKER-STUDENT-TEXT-0771234567";
const DRAFT_MAX = 512 * 1024;
const UTF8 = new TextEncoder();
const bytes = (s: string) => UTF8.encode(s).byteLength;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

type Handlers = Record<
  string,
  (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
>;
type Member = {
  cookie: string;
  userId: string;
  membershipId: string;
  organizationId: string;
};
type CallOptions = {
  cookie?: string;
  body?: unknown;
  raw?: string | ReadableStream<Uint8Array>;
  origin?: string | null;
  type?: string | null;
  params?: Record<string, string>;
  headers?: Record<string, string>;
};
type Bot = { id: string; key: string; draftRevision: number; hasDraft: boolean };
type Saved = { botId: string; draftRevision: number; canonicalBytes: number; changed: boolean };
type ErrorBody = { error: { code: string; message: string; fields?: string[] } };

describe("bot management HTTP API (DEV-1)", () => {
  let t: TestDb;
  let a: RealAuth;
  let release: () => Promise<void>;
  const routes: Record<string, Handlers> = {};
  const logs: string[] = [];
  const outbound: string[] = [];
  const responses: string[] = [];
  let baseline: unknown;
  let deployed: { organizationId: string; botId: string; versionId: string; deploymentId: string };

  // Row fingerprints (versions, deployments, sessions) and row counts (the other listed tables) that a bot route must leave unchanged.
  const effects = async () =>
    (
      await t.pool.query(
        `select (select count(*)::int from bot_versions) versions,
                (select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by id), '')) from bot_versions x) "versionRows",
                (select count(*)::int from bot_deployments) deployments,
                (select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by id), '')) from bot_deployments x) "deploymentRows",
                (select count(*)::int from bot_deployment_events) "deploymentEvents",
                (select count(*)::int from bot_triggers) triggers,
                (select count(*)::int from bot_sessions) sessions,
                (select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by id), '')) from bot_sessions x) "sessionRows",
                (select count(*)::int from bot_session_events) "sessionEvents",
                (select count(*)::int from outbound_requests) requests,
                (select count(*)::int from messages) messages`,
      )
    ).rows[0] as unknown;

  beforeAll(async () => {
    t = await createTestDatabase();
    a = realAuth(t);
    release = useGlobalAuth(t);
    const load = async (key: string, loader: () => Promise<unknown>) =>
      (routes[key] = (await loader()) as Handlers);
    await load("bots", () => import("../../app/api/bots/route"));
    await load("detail", () => import("../../app/api/bots/[botId]/route"));
    await load("draft", () => import("../../app/api/bots/[botId]/draft/route"));
    await load("validation", () => import("../../app/api/bots/[botId]/draft/validation/route"));
    // A published bot, deployed, with one live session: the state the API must leave exactly as it is.
    const w = await botWorld(t.db);
    const d = await deployedBot(t.db, w);
    await insertSession(t.pool, {
      organizationId: w.org.id,
      botId: d.bot.id,
      versionId: d.version.id,
      deploymentId: d.deployment.id,
      whatsappAccountId: w.account.id,
      student: w.student,
    });
    deployed = {
      organizationId: w.org.id,
      botId: d.bot.id,
      versionId: d.version.id,
      deploymentId: d.deployment.id,
    };
    baseline = await effects();
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(
        (...args: unknown[]) => void logs.push(args.map(String).join(" ")),
      );
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      outbound.push(String(input instanceof Request ? input.url : input));
      return realFetch(input, init);
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await release();
    await t.close();
  });

  // ------------------------------------------------------------------------------------------ helpers
  const newOrg = async () => (await seedOrg(t.db)).id;
  async function member(organizationId: string, role: Role): Promise<Member> {
    const email = `${role.toLowerCase()}-${uniq()}@example.com`;
    const user = await provisionUser(a, t, email, { organizationId, role, status: "ACTIVE" });
    const [m] = await t.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.userId, user.id));
    return { cookie: await login(a, email), userId: user.id, membershipId: m!.id, organizationId };
  }
  async function call(route: string, method: string, path: string, o: CallOptions = {}) {
    const headers: Record<string, string> = { ...o.headers };
    if (o.cookie) headers.cookie = o.cookie;
    if (method !== "GET" && o.origin !== null) headers.origin = o.origin ?? ORIGIN;
    const body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    if (body !== undefined && o.type !== null)
      headers["content-type"] = o.type ?? "application/json";
    const handler = routes[route]![method];
    if (!handler) throw new Error(`no ${method} handler on ${route}`);
    const init = {
      method,
      headers,
      body,
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    };
    const res = await handler(new Request(`${ORIGIN}${path}`, init as RequestInit), {
      params: Promise.resolve(o.params ?? {}),
    });
    expect(res.headers.get("cache-control"), `${method} ${path}`).toBe("no-store");
    responses.push(await res.clone().text());
    return res;
  }
  const list = (o: CallOptions, search = "") => call("bots", "GET", `/api/bots${search}`, o);
  const create = (o: CallOptions) => call("bots", "POST", "/api/bots", o);
  const detail = (botId: string, o: CallOptions) =>
    call("detail", "GET", `/api/bots/${botId}`, { ...o, params: { botId } });
  const save = (botId: string, o: CallOptions) =>
    call("draft", "PUT", `/api/bots/${botId}/draft`, { ...o, params: { botId } });
  const validation = (botId: string, o: CallOptions) =>
    call("validation", "GET", `/api/bots/${botId}/draft/validation`, { ...o, params: { botId } });
  const code = async (res: Response) => ((await res.clone().json()) as ErrorBody).error?.code;
  const fields = async (res: Response) => ((await res.clone().json()) as ErrorBody).error?.fields;
  const row = async (botId: string) =>
    (await t.pool.query("select to_jsonb(b) r from bots b where id = $1", [botId])).rows[0] as
      { r: Record<string, unknown> } | undefined;
  const botCount = async (organizationId?: string) =>
    (
      await t.pool.query(
        "select count(*)::int n from bots where $1::uuid is null or organization_id = $1",
        [organizationId ?? null],
      )
    ).rows[0].n as number;
  async function newBot(admin: Member, key = `bot_${uniq()}`): Promise<Bot> {
    const res = await create({ cookie: admin.cookie, body: { key, name: "Bot" } });
    expect(res.status).toBe(201);
    return (await res.json()) as Bot;
  }
  /** Saves `config` and returns the parsed success body (the save must succeed). */
  async function saved(admin: Member, botId: string, expectedRevision: number, config: unknown) {
    const res = await save(botId, { cookie: admin.cookie, body: { expectedRevision, config } });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Saved;
  }
  const actorHeader = (m: Member) => ({
    "x-expected-actor": encodeURIComponent(
      JSON.stringify({
        userId: m.userId,
        organizationId: m.organizationId,
        membershipId: m.membershipId,
      }),
    ),
  });
  const adminActions = () => logs.filter((l) => l.includes("bots.admin_action")).length;

  // ------------------------------------------------------------------------------------------ authentication and roles
  it("without a session every handler answers 401 and nothing is written; a forged cookie is the same", async () => {
    const admin = await member(await newOrg(), "ADMIN");
    const bot = await newBot(admin);
    const before = { bots: await botCount(), row: await row(bot.id) };
    for (const cookie of [undefined, "better-auth.session_token=forged.value", "x=y"]) {
      const o = cookie ? { cookie } : {};
      const attempts = [
        list(o),
        create({ ...o, body: { key: `k_${uniq()}`, name: "N" } }),
        detail(bot.id, o),
        save(bot.id, { ...o, body: { expectedRevision: 0, config: {} } }),
        validation(bot.id, o),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(401);
        expect(await code(res)).toBe("UNAUTHENTICATED");
      }
    }
    expect({ bots: await botCount(), row: await row(bot.id) }).toEqual(before);
  });

  it("ADMIN reads and edits; STAFF reads but cannot edit; VIEWER has no bot access", async () => {
    const org = await newOrg();
    const admin = await member(org, "ADMIN");
    const staff = await member(org, "STAFF");
    const viewer = await member(org, "VIEWER");

    const created = await create({
      cookie: admin.cookie,
      body: { key: "enquiry", name: "Enquiry", description: "First contact" },
    });
    expect(created.status).toBe(201);
    const bot = (await created.json()) as Bot & Record<string, unknown>;
    expect(Object.keys(bot).sort()).toEqual(
      [
        "createdAt",
        "description",
        "draftRevision",
        "draftUpdatedAt",
        "hasDraft",
        "id",
        "key",
        "name",
      ].sort(),
    );
    expect(bot).toMatchObject({
      key: "enquiry",
      name: "Enquiry",
      description: "First contact",
      draftRevision: 0,
      hasDraft: false,
      draftUpdatedAt: null,
    });
    expect(await saved(admin, bot.id, 0, minimalFlow())).toEqual({
      botId: bot.id,
      draftRevision: 1,
      canonicalBytes: bytes(canonicalJson(minimalFlow())),
      changed: true,
    });

    for (const reader of [admin, staff]) {
      const listed = await list({ cookie: reader.cookie });
      expect(listed.status).toBe(200);
      expect(((await listed.json()) as { items: Bot[] }).items.map((i) => i.id)).toEqual([bot.id]);
      const got = await detail(bot.id, { cookie: reader.cookie });
      expect(got.status).toBe(200);
      expect(await got.json()).toMatchObject({
        id: bot.id,
        draftRevision: 1,
        hasDraft: true,
        draft: JSON.parse(canonicalJson(minimalFlow())),
      });
      const checked = await validation(bot.id, { cookie: reader.cookie });
      expect(checked.status).toBe(200);
      expect(await checked.json()).toEqual({ draftRevision: 1, ok: true, diagnostics: [] });
    }

    const before = await row(bot.id);
    for (const denied of [
      await create({ cookie: staff.cookie, body: { key: "staffbot", name: "S" } }),
      await save(bot.id, {
        cookie: staff.cookie,
        body: { expectedRevision: 1, config: { changed: true } },
      }),
      await list({ cookie: viewer.cookie }),
      await detail(bot.id, { cookie: viewer.cookie }),
      await validation(bot.id, { cookie: viewer.cookie }),
      await create({ cookie: viewer.cookie, body: { key: "viewerbot", name: "V" } }),
      await save(bot.id, {
        cookie: viewer.cookie,
        body: { expectedRevision: 1, config: { changed: true } },
      }),
    ]) {
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({
        error: { code: "FORBIDDEN", message: "You do not have permission to perform this action" },
      });
    }
    expect(await row(bot.id)).toEqual(before);
    expect(await botCount(org)).toBe(1);
  });

  it("a platform role alone, a pending password change and an ambiguous membership give no bot access", async () => {
    const org = await newOrg();
    const admin = await member(org, "ADMIN");
    const bot = await newBot(admin);
    const all = (cookie: string) =>
      Promise.all([
        list({ cookie }),
        create({ cookie, body: { key: `k_${uniq()}`, name: "N" } }),
        detail(bot.id, { cookie }),
        save(bot.id, { cookie, body: { expectedRevision: 0, config: {} } }),
        validation(bot.id, { cookie }),
      ]);

    // a platform security administrator with no organization membership
    const granter = await provisionUser(a, t, `granter-${uniq()}@example.com`);
    const platformEmail = `platform-${uniq()}@example.com`;
    const platformUser = await provisionUser(a, t, platformEmail);
    await t.pool.query(
      `insert into platform_operator_roles (user_id, role, grant_kind, granted_by_user_id, verification_ref)
       values ($1, 'PLATFORM_SECURITY_ADMIN', 'NORMAL', $2, 'DEV1-TEST')`,
      [platformUser.id, granter.id],
    );
    for (const res of await all(await login(a, platformEmail))) {
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("FORBIDDEN");
    }

    // an ADMIN who must change their password first
    const pending = await member(org, "ADMIN");
    await t.db
      .insert(schema.userSecurityState)
      .values({ userId: pending.userId, passwordChangeRequired: true })
      .onConflictDoUpdate({
        target: schema.userSecurityState.userId,
        set: { passwordChangeRequired: true },
      });
    for (const res of await all(pending.cookie)) {
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("PASSWORD_CHANGE_REQUIRED");
    }

    // an ADMIN with a second ACTIVE membership (no organization selector exists: fail closed)
    const two = await member(org, "ADMIN");
    await t.db.insert(schema.organizationMemberships).values({
      organizationId: await newOrg(),
      userId: two.userId,
      role: "ADMIN",
      status: "ACTIVE",
    });
    for (const res of await all(two.cookie)) {
      expect(res.status).toBe(409);
      expect(await code(res)).toBe("ORGANIZATION_SELECTION_REQUIRED");
    }

    expect(await botCount(org)).toBe(1);
    expect((await row(bot.id))!.r.draft_revision).toBe(0);
  });

  it("a suspended member is refused on the next request; a demoted ADMIN keeps exactly the permissions of the new role", async () => {
    const org = await newOrg();
    const admin = await member(org, "ADMIN");
    const toStaff = await member(org, "ADMIN");
    const toViewer = await member(org, "ADMIN");
    const suspended = await member(org, "ADMIN");
    const bot = await newBot(admin);
    await saved(admin, bot.id, 0, minimalFlow());
    for (const m of [toStaff, toViewer, suspended])
      expect((await detail(bot.id, { cookie: m.cookie })).status).toBe(200);
    const set = (m: Member, change: string) =>
      t.pool.query(`update organization_memberships set ${change} where id = $1`, [m.membershipId]);
    await set(toStaff, "role = 'STAFF'");
    await set(toViewer, "role = 'VIEWER'");
    await set(suspended, "status = 'SUSPENDED'");
    const write = { body: { expectedRevision: 1, config: { changed: true } } };
    const statuses = async (m: Member) => [
      (await list({ cookie: m.cookie })).status,
      (await detail(bot.id, { cookie: m.cookie })).status,
      (await validation(bot.id, { cookie: m.cookie })).status,
      (await create({ cookie: m.cookie, body: { key: `k_${uniq()}`, name: "N" } })).status,
      (await save(bot.id, { cookie: m.cookie, ...write })).status,
    ];
    expect(await statuses(toStaff)).toEqual([200, 200, 200, 403, 403]);
    expect(await statuses(toViewer)).toEqual([403, 403, 403, 403, 403]);
    expect(await statuses(suspended)).toEqual([403, 403, 403, 403, 403]);
    expect((await row(bot.id))!.r.draft_revision).toBe(1);
    expect(await botCount(org)).toBe(1);
  });

  it("the expected-actor assertion is enforced: a different actor is 409 before anything runs, a malformed one is 400, the right one is accepted", async () => {
    const org = await newOrg();
    const admin = await member(org, "ADMIN");
    const other = await member(org, "ADMIN");
    const bot = await newBot(admin);
    const wrongCreate = await create({
      cookie: admin.cookie,
      body: { key: "wrong_actor", name: "N" },
      headers: actorHeader(other),
    });
    const wrongSave = await save(bot.id, {
      cookie: admin.cookie,
      body: { expectedRevision: 0, config: {} },
      headers: actorHeader(other),
    });
    for (const res of [wrongCreate, wrongSave]) {
      expect(res.status).toBe(409);
      expect(await code(res)).toBe("ACTOR_CHANGED");
    }
    expect(
      (await detail(bot.id, { cookie: admin.cookie, headers: actorHeader(other) })).status,
    ).toBe(409);
    for (const header of ["%7Bnot", encodeURIComponent('{"userId":"x"}')])
      expect(
        (await list({ cookie: admin.cookie, headers: { "x-expected-actor": header } })).status,
      ).toBe(400);
    expect(await botCount(org)).toBe(1);
    expect((await row(bot.id))!.r.draft_revision).toBe(0);
    expect(
      (
        await save(bot.id, {
          cookie: admin.cookie,
          body: { expectedRevision: 0, config: {} },
          headers: actorHeader(admin),
        })
      ).status,
    ).toBe(200);
  });

  // ------------------------------------------------------------------------------------------ forbidden callers: valid versus malformed input
  it("a caller without the permission: valid input is always 403; malformed input is 403 on reads and 400/422 on writes; nothing leaks or changes", async () => {
    const org = await newOrg();
    const admin = await member(org, "ADMIN");
    const staff = await member(org, "STAFF");
    const viewer = await member(org, "VIEWER");
    const bot = await newBot(admin);
    const theirs = await newBot(await member(await newOrg(), "ADMIN"));
    const before = { row: await row(bot.id), theirs: await row(theirs.id), bots: await botCount() };

    // reads (VIEWER): the service checks the permission before it parses anything; only the HTTP query adapter runs earlier
    for (const [search, status] of [
      ["", 403],
      ["?limit=10", 403],
      ["?nope=1", 403],
      ["?limit=101", 403],
      ["?cursor=!!!", 403],
      ["?limit=1&limit=2", 400],
      ["?limit=abc", 400],
    ] as const)
      expect((await list({ cookie: viewer.cookie }, search)).status, search).toBe(status);
    for (const id of [bot.id, theirs.id, MISSING, "not-a-uuid"]) {
      const responsesFor = [
        await detail(id, { cookie: viewer.cookie }),
        await validation(id, { cookie: viewer.cookie }),
      ];
      for (const res of responsesFor) expect(res.status, id).toBe(403);
      expect(await responsesFor[0]!.text()).toBe(
        await (await detail(bot.id, { cookie: viewer.cookie })).text(),
      );
    }

    // writes (STAFF and VIEWER): the existing services parse before the permission check
    for (const who of [staff, viewer]) {
      const c = { cookie: who.cookie };
      expect((await create({ ...c, body: { key: `k_${uniq()}`, name: "N" } })).status).toBe(403);
      expect((await create({ ...c, body: { key: "Bad Key", name: "N" } })).status).toBe(400);
      expect((await create({ ...c, body: { key: "k", name: "N", role: "ADMIN" } })).status).toBe(
        400,
      );
      expect((await create({ ...c, raw: "{not json" })).status).toBe(400);
      const valid = { expectedRevision: 0, config: {} };
      // a valid save is 403 whatever the id names: an existing bot, another organization's bot, or nothing
      const refusals = [
        await save(bot.id, { ...c, body: valid }),
        await save(theirs.id, { ...c, body: valid }),
        await save(MISSING, { ...c, body: valid }),
      ];
      for (const res of refusals) expect(res.status).toBe(403);
      const refusalTexts = await Promise.all(refusals.map((res) => res.text()));
      expect(refusalTexts[1]).toBe(refusalTexts[0]);
      expect(refusalTexts[2]).toBe(refusalTexts[0]);
      expect(
        (await save(bot.id, { ...c, body: { expectedRevision: "0", config: {} } })).status,
      ).toBe(400);
      expect((await save("not-a-uuid", { ...c, body: valid })).status).toBe(400);
      const tooLarge = await save(bot.id, {
        ...c,
        body: { expectedRevision: 0, config: { p: "x".repeat(65_529) } },
      });
      expect(tooLarge.status).toBe(422);
      expect(await code(tooLarge)).toBe("DRAFT_INVALID");
      expect(
        (
          await save(bot.id, {
            ...c,
            raw: `{"expectedRevision":0,"config":{}}${" ".repeat(DRAFT_MAX)}`,
          })
        ).status,
      ).toBe(400);
    }
    expect({
      row: await row(bot.id),
      theirs: await row(theirs.id),
      bots: await botCount(),
    }).toEqual(before);
  });

  // ------------------------------------------------------------------------------------------ same-origin
  it("mutations follow the same-origin guard exactly; GET handlers are not origin-checked", async () => {
    const org = await newOrg();
    const admin = await member(org, "ADMIN");
    const bot = await newBot(admin);
    const fetchSite = (value: string) => ({ "sec-fetch-site": value });
    expect(await saved(admin, bot.id, 0, {})).toMatchObject({ draftRevision: 1 });
    // the save repeats the stored draft: a no-op, so every PERMITTED attempt answers 200 and none moves the revision
    const saveBody = { expectedRevision: 1, config: {} };
    const tryBoth = async (o: CallOptions) => [
      (await create({ cookie: admin.cookie, body: { key: `k_${uniq()}`, name: "N" }, ...o }))
        .status,
      (await save(bot.id, { cookie: admin.cookie, body: saveBody, ...o })).status,
    ];
    const created = async () => (await botCount(org)) - 1;

    // an allowed Origin passes, whatever Fetch Metadata says
    expect(await tryBoth({ origin: ORIGIN })).toEqual([201, 200]);
    expect(await tryBoth({ origin: ORIGIN, headers: fetchSite("cross-site") })).toEqual([201, 200]);
    // no Origin: only Sec-Fetch-Site: same-origin passes
    expect(await tryBoth({ origin: null, headers: fetchSite("same-origin") })).toEqual([201, 200]);
    expect(await created()).toBe(3);
    for (const headers of [{}, fetchSite("same-site"), fetchSite("cross-site"), fetchSite("none")])
      expect(await tryBoth({ origin: null, headers }), JSON.stringify(headers)).toEqual([403, 403]);
    // a foreign, opaque or unparseable Origin fails, even with same-origin Fetch Metadata
    for (const origin of ["https://evil.example", "null", "not a url", `${ORIGIN}.evil.example`])
      for (const headers of [{}, fetchSite("same-origin")])
        expect(await tryBoth({ origin, headers }), origin).toEqual([403, 403]);
    expect(await created()).toBe(3);
    expect((await row(bot.id))!.r.draft_revision).toBe(1);

    // Direct-handler precedence: the origin check runs before authentication, so no session + foreign Origin is 403, not 401.
    // (Behind the real proxy a cookieless request is answered 401 before any handler runs: src/proxy.ts, not tested here.)
    const anonymous = await create({
      origin: "https://evil.example",
      body: { key: "k", name: "N" },
    });
    expect(anonymous.status).toBe(403);
    expect((await create({ body: { key: "k", name: "N" } })).status).toBe(401);

    // safe methods are never origin-checked: a foreign Origin header on a GET changes nothing for an authorized caller
    const foreign = {
      cookie: admin.cookie,
      headers: { origin: "https://evil.example", ...fetchSite("cross-site") },
    };
    expect((await list(foreign)).status).toBe(200);
    expect((await detail(bot.id, foreign)).status).toBe(200);
    expect((await validation(bot.id, foreign)).status).toBe(200);
  });

  // ------------------------------------------------------------------------------------------ tenant isolation
  it("another organization's bot id is the same 404 as a missing one, byte for byte, and the list never shows it", async () => {
    const mine = await member(await newOrg(), "ADMIN");
    const other = await member(await newOrg(), "ADMIN");
    const theirs = await newBot(other, "shared_key");
    await saved(other, theirs.id, 0, { secret: MARKER });
    const own = await newBot(mine, "shared_key"); // the same key in another organization is not a conflict
    const before = await row(theirs.id);
    const compare = async (mk: (id: string) => Promise<Response>) => {
      const foreign = await mk(theirs.id);
      const none = await mk(MISSING);
      expect(foreign.status).toBe(404);
      expect(none.status).toBe(404);
      const [foreignText, noneText] = [await foreign.text(), await none.text()];
      expect(foreignText).toBe(noneText);
      expect(noneText).not.toContain(MARKER);
    };
    await compare((id) => detail(id, { cookie: mine.cookie }));
    await compare((id) => validation(id, { cookie: mine.cookie }));
    await compare((id) =>
      save(id, { cookie: mine.cookie, body: { expectedRevision: 1, config: { taken: true } } }),
    );
    // a body cannot redirect the save to another organization or another bot
    for (const extra of [
      { botId: theirs.id },
      { organizationId: other.organizationId },
      { actor: "someone@example.com" },
      { membershipId: other.membershipId },
    ]) {
      const res = await save(own.id, {
        cookie: mine.cookie,
        body: { expectedRevision: 0, config: {}, ...extra },
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(
      await fields(
        await save(own.id, {
          cookie: mine.cookie,
          body: { expectedRevision: 0, config: {}, botId: own.id },
        }),
      ),
    ).toEqual(["botId"]);
    const listed = (await (await list({ cookie: mine.cookie }, "?limit=100")).json()) as {
      items: Bot[];
    };
    expect(listed.items.map((i) => i.id)).toEqual([own.id]);
    expect(await row(theirs.id)).toEqual(before);
    expect((await row(own.id))!.r.draft_revision).toBe(0);
  });

  // ------------------------------------------------------------------------------------------ strict input
  it("bodies are strict JSON objects: content type, malformed JSON, non-objects, extra keys and bad values are 400", async () => {
    const org = await newOrg();
    const admin = await member(org, "ADMIN");
    const bot = await newBot(admin);
    const c = { cookie: admin.cookie };
    const good = { key: "good_key", name: "Good" };
    const badCreates: CallOptions[] = [
      { raw: JSON.stringify(good), type: "text/plain" },
      { raw: JSON.stringify(good), type: null },
      { raw: "{not json" },
      { raw: "" },
      {},
      { body: [] },
      { body: "x" },
      { body: null },
      { body: {} },
      { body: { key: "good_key" } },
      { body: { name: "Good" } },
      { body: { ...good, key: "Bad Key" } },
      { body: { ...good, key: "1bot" } },
      { body: { ...good, key: `a${"b".repeat(64)}` } },
      { body: { ...good, name: "" } },
      { body: { ...good, name: "   " } },
      { body: { ...good, name: "n".repeat(101) } },
      { body: { ...good, description: "d".repeat(501) } },
      { body: { ...good, description: null } },
      { body: { ...good, id: MISSING } },
      { body: { ...good, organizationId: org } },
      { body: { ...good, createdByMembershipId: admin.membershipId } },
      { body: { ...good, draftRevision: 7 } },
      { body: { ...good, config: minimalFlow() } },
      { raw: `{"key":"good_key","name":"Good","__proto__":{"polluted":true}}` },
    ];
    for (const o of badCreates) {
      const res = await create({ ...c, ...o });
      expect(res.status, JSON.stringify(o)).toBe(400);
      expect(await code(res)).toBe("VALIDATION_ERROR");
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(await botCount(org)).toBe(1);

    const badSaves: CallOptions[] = [
      { raw: '{"expectedRevision":0,"config":{}}', type: "text/plain" },
      { raw: '{"expectedRevision":0,"config":' },
      { body: [] },
      { body: {} },
      { body: { expectedRevision: 0 } }, // no config at all
      { body: { config: {} } },
      { body: { expectedRevision: "0", config: {} } },
      { body: { expectedRevision: -1, config: {} } },
      { body: { expectedRevision: 0.5, config: {} } },
      { body: { expectedRevision: 2_147_483_648, config: {} } },
      { body: { expectedRevision: 0, config: {}, dryRun: true } },
      { body: { expectedRevision: 0, config: {}, name: "renamed" } },
      { body: { expectedRevision: 0, config: {}, key: "renamed" } },
    ];
    for (const o of badSaves) {
      const res = await save(bot.id, { ...c, ...o });
      expect(res.status, JSON.stringify(o)).toBe(400);
      expect(await code(res)).toBe("VALIDATION_ERROR");
    }
    // a malformed bot id in the path is a validation error on every id route, never a database error
    for (const id of ["not-a-uuid", "00000000-0000-4000-8000-00000000000", "'; select 1 --"]) {
      for (const res of [
        await detail(id, c),
        await validation(id, c),
        await save(id, { ...c, body: { expectedRevision: 0, config: {} } }),
      ]) {
        expect(res.status, id).toBe(400);
        expect(await fields(res)).toEqual(["botId"]);
      }
    }
    expect((await row(bot.id))!.r).toMatchObject({
      draft_revision: 0,
      draft_config_canonical: null,
    });

    // a nested "__proto__" is ordinary draft data, stored and returned as such; nothing is polluted
    const stored = await save(bot.id, {
      ...c,
      raw: '{"expectedRevision":0,"config":{"__proto__":{"polluted":true},"a":1}}',
    });
    expect(stored.status).toBe(200);
    expect((await row(bot.id))!.r.draft_config_canonical).toBe(
      '{"__proto__":{"polluted":true},"a":1}',
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("the list query is strict: repeated keys, unknown keys and anything but a plain 1..100 limit are 400", async () => {
    const admin = await member(await newOrg(), "ADMIN");
    for (const [search, field] of [
      ["?limit=1&limit=2", "limit"],
      ["?cursor=a&cursor=b", "cursor"],
      ["?limit=10&cursor=a&limit=10", "limit"],
      ["?limit=0", "limit"],
      ["?limit=05", "limit"],
      ["?limit=1e1", "limit"],
      ["?limit=", "limit"],
      ["?limit=%205", "limit"],
      ["?limit=1000", "limit"],
      ["?limit=101", "limit"],
      ["?limit=-1", "limit"],
      ["?organizationId=x", "body"],
      ["?q=enquiry", "body"],
      ["?cursor=", "cursor"],
      ["?cursor=!!!", "body"],
    ] as const) {
      const res = await list({ cookie: admin.cookie }, search);
      expect(res.status, search).toBe(400);
      expect(await res.json(), search).toEqual({
        error: { code: "VALIDATION_ERROR", message: "Invalid input", fields: [field] },
      });
    }
    for (const search of ["", "?limit=1", "?limit=100"])
      expect((await list({ cookie: admin.cookie }, search)).status, search).toBe(200);
  });

  // ------------------------------------------------------------------------------------------ create and list
  it("create: 201 once, 409 BOT_KEY_TAKEN on the same key (no database detail), and the key is free in another organization", async () => {
    const admin = await member(await newOrg(), "ADMIN");
    const first = await create({ cookie: admin.cookie, body: { key: "dup", name: "First" } });
    expect(first.status).toBe(201);
    const second = await create({ cookie: admin.cookie, body: { key: "dup", name: "Second" } });
    expect(second.status).toBe(409);
    const text = await second.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: "BOT_KEY_TAKEN", message: "A bot with this key already exists." },
    });
    expect(text).not.toMatch(/duplicate key|bots_org_key_unique|constraint|23505/i);
    expect(await botCount(admin.organizationId)).toBe(1);
    const elsewhere = await member(await newOrg(), "ADMIN");
    expect(
      (await create({ cookie: elsewhere.cookie, body: { key: "dup", name: "Theirs" } })).status,
    ).toBe(201);
    // two simultaneous creates of one key: exactly one bot
    const racing = await Promise.all(
      [1, 2].map(() => create({ cookie: admin.cookie, body: { key: "race", name: "Race" } })),
    );
    expect(racing.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await botCount(admin.organizationId)).toBe(2);
  });

  it("list: empty, then bounded keyset pages of summaries with no gaps or repeats; malformed cursors are 400, a forged well-formed one only moves the start", async () => {
    const admin = await member(await newOrg(), "ADMIN");
    const staff = await member(admin.organizationId, "STAFF");
    expect(await (await list({ cookie: staff.cookie })).json()).toEqual({
      items: [],
      nextCursor: null,
    });
    const other = await member(await newOrg(), "ADMIN");
    for (const key of ["o1", "o2", "zz_foreign"]) await newBot(other, key);
    const made: Record<string, Bot> = {};
    for (const key of ["delta", "alpha", "echo", "bravo", "charlie"])
      made[key] = await newBot(admin, key);
    await saved(admin, made.bravo!.id, 0, { secret: MARKER });

    type Page = { items: Array<Bot & Record<string, unknown>>; nextCursor: string | null };
    const walk = async (limit: number) => {
      const keys: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const res = await list(
          { cookie: staff.cookie },
          `?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
        );
        expect(res.status).toBe(200);
        const text = await res.clone().text();
        expect(text).not.toContain(MARKER);
        expect(text).not.toMatch(/"draft"|config/);
        const page = (await res.json()) as Page;
        expect(Object.keys(page).sort()).toEqual(["items", "nextCursor"]);
        sizes.push(page.items.length);
        keys.push(...page.items.map((i) => i.key));
        for (const item of page.items)
          expect(Object.keys(item).sort()).toEqual(
            [
              "createdAt",
              "description",
              "draftRevision",
              "draftUpdatedAt",
              "hasDraft",
              "id",
              "key",
              "name",
            ].sort(),
          );
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return { keys, sizes };
    };
    const all = ["alpha", "bravo", "charlie", "delta", "echo"];
    expect(await walk(2)).toEqual({ keys: all, sizes: [2, 2, 1] });
    expect(await walk(5)).toEqual({ keys: all, sizes: [5] });
    expect(await walk(1)).toEqual({ keys: all, sizes: [1, 1, 1, 1, 1] });
    const page = (await (await list({ cookie: staff.cookie })).json()) as Page;
    expect(page.items.find((i) => i.key === "bravo")).toMatchObject({
      hasDraft: true,
      draftRevision: 1,
    });
    expect(page.items.find((i) => i.key === "alpha")).toMatchObject({
      hasDraft: false,
      draftRevision: 0,
      draftUpdatedAt: null,
    });

    const cursorOf = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const bad of [
      "!!!",
      cursorOf("bravo"),
      cursorOf([]),
      cursorOf(["bravo", "charlie"]),
      cursorOf(["Bravo"]),
      cursorOf([made.bravo!.id, 1, made.bravo!.id]), // a deployments-listing cursor
      Buffer.from("not json").toString("base64url"),
      `${cursorOf(["bravo"])}%3D%3D`,
      "a".repeat(301),
    ])
      expect((await list({ cookie: staff.cookie }, `?cursor=${bad}`)).status, bad).toBe(400);
    // Well-formed keys the server never issued here (one is a real key of the OTHER organization): the caller's own bots
    // after that key, nothing else. Not an error, and not a disclosure.
    for (const [forged, expected] of [
      ["zz_foreign", []],
      ["o1", []],
      ["c", ["charlie", "delta", "echo"]],
      ["a", all],
    ] as const) {
      const res = await list({ cookie: staff.cookie }, `?cursor=${cursorOf([forged])}`);
      expect(res.status, forged).toBe(200);
      expect(
        ((await res.json()) as Page).items.map((i) => i.key),
        forged,
      ).toEqual(expected);
    }
  });

  // ------------------------------------------------------------------------------------------ draft saves
  it("draft saves are revision-protected: stale is 409, identical content is a no-op, unfinished flows are accepted", async () => {
    const admin = await member(await newOrg(), "ADMIN");
    const bot = await newBot(admin);
    const c = { cookie: admin.cookie };
    // an unfinished, structurally acceptable draft is saved as it is
    expect(await saved(admin, bot.id, 0, { name: "half a flow" })).toMatchObject({
      draftRevision: 1,
      changed: true,
    });
    const stale = await save(bot.id, {
      ...c,
      body: { expectedRevision: 0, config: minimalFlow() },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: {
        code: "STALE_REVISION",
        message: "The draft changed since it was loaded. Reload and try again.",
      },
    });
    expect(await saved(admin, bot.id, 1, minimalFlow())).toMatchObject({
      draftRevision: 2,
      changed: true,
    });

    // identical content, and the same JSON with its keys reversed: 200, changed false, revision, metadata and audit untouched
    const before = await row(bot.id);
    const audited = adminActions();
    const reversed = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reversed)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reversed(x)]),
            )
          : v;
    for (const config of [minimalFlow(), reversed(minimalFlow())])
      expect(await saved(admin, bot.id, 2, config)).toEqual({
        botId: bot.id,
        draftRevision: 2,
        canonicalBytes: bytes(canonicalJson(minimalFlow())),
        changed: false,
      });
    expect(await row(bot.id)).toEqual(before);
    expect(adminActions()).toBe(audited);
    // the revision is checked before the no-op comparison: identical content at a stale revision is still refused
    const staleNoop = await save(bot.id, {
      ...c,
      body: { expectedRevision: 1, config: minimalFlow() },
    });
    expect(staleNoop.status).toBe(409);
    expect(await code(staleNoop)).toBe("STALE_REVISION");
    expect(await row(bot.id)).toEqual(before);
    // a committed change is audited once, by ids and the revision only
    await saved(admin, bot.id, 2, { ...minimalFlow(), name: MARKER });
    expect(adminActions()).toBe(audited + 1);
    const line = logs.filter((l) => l.includes("bots.admin_action")).at(-1)!;
    expect(JSON.parse(line)).toMatchObject({
      action: "bot.draft_updated",
      bot_id: bot.id,
      draft_revision: 3,
      organization_id: admin.organizationId,
      membership_id: admin.membershipId,
    });
    expect(line).not.toContain(MARKER);
    expect((await row(bot.id))!.r).toMatchObject({
      draft_revision: 3,
      draft_updated_by_membership_id: admin.membershipId,
    });
  });

  it("concurrent saves: two changes from one revision give one update and one 409 (even with the same new content); concurrent no-ops both succeed", async () => {
    const admin = await member(await newOrg(), "ADMIN");
    const other = await member(admin.organizationId, "ADMIN");
    const bot = await newBot(admin);
    await saved(admin, bot.id, 0, { v: 0 });
    const race = (configs: [unknown, unknown], expectedRevision: number) =>
      Promise.all(
        configs.map((config, i) =>
          save(bot.id, {
            cookie: (i === 0 ? admin : other).cookie,
            body: { expectedRevision, config },
          }),
        ),
      );
    const outcome = async (results: Response[]) =>
      Promise.all(
        results.map(async (r) =>
          r.status === 200
            ? { status: 200, ...((await r.json()) as Saved) }
            : { status: r.status, code: await code(r) },
        ),
      );

    // different new content from revision 1
    for (let round = 0; round < 3; round++) {
      const at = Number((await row(bot.id))!.r.draft_revision);
      const results = await outcome(await race([{ v: `a${round}` }, { v: `b${round}` }], at));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 200)).toMatchObject({
        draftRevision: at + 1,
        changed: true,
      });
      expect(results.find((r) => r.status === 409)).toMatchObject({ code: "STALE_REVISION" });
      expect((await row(bot.id))!.r.draft_revision).toBe(at + 1);
    }
    // the SAME new content from one revision: still exactly one update; the other checks a revision that has moved
    const at = Number((await row(bot.id))!.r.draft_revision);
    const same = await outcome(await race([{ v: "same" }, { v: "same" }], at));
    expect(same.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await row(bot.id))!.r).toMatchObject({
      draft_revision: at + 1,
      draft_config_canonical: '{"v":"same"}',
    });
    // content that already equals the stored draft: both are no-ops at the unchanged revision, and neither conflicts
    const before = await row(bot.id);
    const audited = adminActions();
    const noops = await outcome(await race([{ v: "same" }, { v: "same" }], at + 1));
    expect(noops).toEqual([
      { status: 200, botId: bot.id, draftRevision: at + 1, canonicalBytes: 12, changed: false },
      { status: 200, botId: bot.id, draftRevision: at + 1, canonicalBytes: 12, changed: false },
    ]);
    expect(await row(bot.id)).toEqual(before);
    expect(adminActions()).toBe(audited);
  });

  // ------------------------------------------------------------------------------------------ sizes and shapes
  it("the canonical draft limit is 65,536 UTF-8 bytes whatever the raw request looks like; drafts above 16 KiB save", async () => {
    const admin = await member(await newOrg(), "ADMIN");
    const bot = await newBot(admin);
    const c = { cookie: admin.cookie };
    // well above the 16 KiB default of every other route
    expect(await saved(admin, bot.id, 0, { pad: "x".repeat(40_000) })).toMatchObject({
      canonicalBytes: 40_010,
      changed: true,
    });
    // exactly 65,536 canonical bytes: {"p":"…"} is 8 bytes of envelope
    expect(await saved(admin, bot.id, 1, { p: "x".repeat(65_528) })).toMatchObject({
      canonicalBytes: 65_536,
      draftRevision: 2,
    });
    expect(
      (
        await t.pool.query(
          "select octet_length(draft_config_canonical) n from bots where id = $1",
          [bot.id],
        )
      ).rows[0].n,
    ).toBe(65_536);
    // the same boundary in Sinhala (3 bytes a letter): 21,842 letters + 2 ASCII = 65,528 bytes of text
    const sinhala = "අ".repeat(21_842);
    expect(await saved(admin, bot.id, 2, { p: `${sinhala}xx` })).toMatchObject({
      canonicalBytes: 65_536,
      draftRevision: 3,
    });
    const before = await row(bot.id);
    for (const config of [{ p: "x".repeat(65_529) }, { p: `${sinhala}xxx` }]) {
      const over = await save(bot.id, { ...c, body: { expectedRevision: 3, config } });
      expect(over.status).toBe(422);
      // the reason code stays out of the HTTP error in DEV-1
      expect(await over.json()).toEqual({
        error: { code: "DRAFT_INVALID", message: "The draft is not acceptable JSON." },
      });
    }
    // parseable JSON that is not JSON data once parsed (1e400 is Infinity): the same 422
    const infinite = await save(bot.id, {
      ...c,
      raw: '{"expectedRevision":3,"config":{"x":1e400}}',
    });
    expect(infinite.status).toBe(422);
    expect(await code(infinite)).toBe("DRAFT_INVALID");
    expect(await row(bot.id)).toEqual(before);
  });

  it("depth: nesting at the limit of 32 is saved; one level deeper is a deterministic 422 DRAFT_INVALID that changes nothing", async () => {
    const admin = await member(await newOrg(), "ADMIN");
    const bot = await newBot(admin);
    const c = { cookie: admin.cookie };
    const arrays = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;
    const objects = (depth: number) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
    const body = (revision: number, config: string) =>
      `{"expectedRevision":${revision},"config":${config}}`;
    const ok = await save(bot.id, { ...c, raw: body(0, arrays(32)) });
    expect(ok.status).toBe(200);
    expect((await row(bot.id))!.r.draft_config_canonical).toBe(arrays(32));
    expect((await save(bot.id, { ...c, raw: body(1, objects(32)) })).status).toBe(200);
    const before = await row(bot.id);
    for (const config of [arrays(33), objects(33), arrays(34), arrays(5_000)]) {
      expect(() => JSON.parse(config) as unknown).not.toThrow(); // parseable: the refusal is the shape guard's, not the parser's
      const res = await save(bot.id, { ...c, raw: body(2, config) });
      expect(res.status, `${config.length} bytes`).toBe(422);
      expect(await res.json()).toEqual({
        error: { code: "DRAFT_INVALID", message: "The draft is not acceptable JSON." },
      });
    }
    // extreme nesting stays bounded by the raw allowance: an ordinary 400 or 422, never a crash, and nothing is written
    const extreme = await save(bot.id, { ...c, raw: body(2, arrays(250_000)) });
    expect([400, 422]).toContain(extreme.status);
    expect((await save(bot.id, { ...c, raw: body(2, arrays(270_000)) })).status).toBe(400); // over 524,288 raw bytes
    expect(await row(bot.id)).toEqual(before);
  });

  it("multilingual drafts: compact, \\u-escaped and pretty-printed requests store the same canonical UTF-8 text", async () => {
    const admin = await member(await newOrg(), "ADMIN");
    const bot = await newBot(admin);
    const config = {
      name: 'ආයුබෝවන් வணக்கம் "quoted" back\\slash\nline 😀',
      nodes: { b: [1, 2.5, -0, 1e21], a: null },
    };
    const request = { expectedRevision: 0, config };
    const compact = JSON.stringify(request);
    const escaped = compact.replace(
      /[\u0080-￿]/g,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    const pretty = JSON.stringify({ ...request, expectedRevision: 1 }, null, 8);
    expect(escaped).toMatch(/^[\x20-\x7e]+$/);
    expect(bytes(escaped)).toBeGreaterThan(bytes(compact));
    const first = await save(bot.id, { cookie: admin.cookie, raw: compact });
    expect(first.status).toBe(200);
    const canonical = canonicalJson(config);
    expect(await first.json()).toEqual({
      botId: bot.id,
      draftRevision: 1,
      canonicalBytes: bytes(canonical),
      changed: true,
    });
    expect((await row(bot.id))!.r.draft_config_canonical).toBe(canonical);
    expect(canonical).toContain("ආයුබෝවන් வணக்கம்"); // stored as UTF-8, not escaped
    for (const raw of [escaped.replace('"expectedRevision":0', '"expectedRevision":1'), pretty]) {
      const again = await save(bot.id, { cookie: admin.cookie, raw });
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ draftRevision: 1, changed: false });
    }
    const got = (await (await detail(bot.id, { cookie: admin.cookie })).json()) as {
      draft: unknown;
    };
    expect(got.draft).toEqual(JSON.parse(canonical));
  });

  it("the raw allowance of a draft save is 524,288 bytes as received, with a truthful, false or absent Content-Length; other routes keep 16,384", async () => {
    const admin = await member(await newOrg(), "ADMIN");
    const bot = await newBot(admin);
    const c = { cookie: admin.cookie };
    const padded = (revision: number, size: number) => {
      const json = `{"expectedRevision":${revision},"config":{"pad":true}}`;
      return json + " ".repeat(size - json.length);
    };
    // exactly at the allowance: accepted (whitespace counts toward the transport limit, not toward the draft)
    const at = await save(bot.id, { ...c, raw: padded(0, DRAFT_MAX) });
    expect(at.status).toBe(200);
    expect(await at.json()).toMatchObject({ draftRevision: 1, canonicalBytes: 12 });
    const before = await row(bot.id);
    const over = padded(1, DRAFT_MAX + 1);
    expect(bytes(over)).toBe(524_289);
    const chunks = (text: string) => {
      const raw = UTF8.encode(text);
      let offset = 0;
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (offset >= raw.byteLength) return controller.close();
            pulled++;
            controller.enqueue(raw.slice(offset, (offset += 65_536)));
          },
        },
        { highWaterMark: 0 },
      );
      return { stream, pulled: () => pulled };
    };
    const attempts: Array<[string, CallOptions]> = [
      ["no Content-Length", { raw: over }],
      ["truthful Content-Length", { raw: over, headers: { "content-length": "524289" } }],
      ["understated Content-Length", { raw: over, headers: { "content-length": "10" } }],
      ["streamed, no Content-Length", { raw: chunks(over).stream }],
    ];
    for (const [name, o] of attempts) {
      const res = await save(bot.id, { ...c, ...o });
      expect(res.status, name).toBe(400);
      expect(await res.json(), name).toEqual({
        error: { code: "VALIDATION_ERROR", message: "Invalid input", fields: ["body"] },
      });
    }
    // a much larger stream is abandoned at the chunk that crosses the allowance, not read to the end
    const huge = chunks(padded(1, 4 * 1024 * 1024));
    expect((await save(bot.id, { ...c, raw: huge.stream })).status).toBe(400);
    expect(huge.pulled()).toBeLessThanOrEqual(10); // 9 chunks of 65,536 cross 524,288; the other ~55 are never pulled
    // a stream that dies part-way: a generic 500, nothing written, nothing of the body logged
    const dying = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(UTF8.encode(`{"expectedRevision":1,"config":{"note":"${MARKER}`));
        controller.error(new Error(`aborted ${MARKER}`));
      },
    });
    const aborted = await save(bot.id, { ...c, raw: dying });
    expect(aborted.status).toBe(500);
    expect(await aborted.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(await row(bot.id)).toEqual(before);

    // the other bot route with a body keeps the 16,384-byte default
    const createBody = (key: string, size: number) => {
      const json = `{"key":"${key}","name":"Sized"}`;
      return json + " ".repeat(size - json.length);
    };
    expect((await create({ ...c, raw: createBody("at_limit", 16_384) })).status).toBe(201);
    const tooBig = await create({ ...c, raw: createBody("over_limit", 16_385) });
    expect(tooBig.status).toBe(400);
    expect(await fields(tooBig)).toEqual(["body"]);
    expect(await botCount(admin.organizationId)).toBe(2);
  });

  // ------------------------------------------------------------------------------------------ validation
  it("validation reports on the stored draft and its exact revision, writes nothing, and never repeats configured text", async () => {
    const admin = await member(await newOrg(), "ADMIN");
    const staff = await member(admin.organizationId, "STAFF");
    const bot = await newBot(admin);
    const none = await validation(bot.id, { cookie: staff.cookie });
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({
      error: { code: "NO_DRAFT", message: "The bot has no draft to validate." },
    });
    await saved(admin, bot.id, 0, minimalFlow());
    expect(await (await validation(bot.id, { cookie: staff.cookie })).json()).toEqual({
      draftRevision: 1,
      ok: true,
      diagnostics: [],
    });
    // an invalid flow that carries a marker in many places
    const broken = minimalFlow() as { nodes: Record<string, Record<string, unknown>> } & Record<
      string,
      unknown
    >;
    broken.name = MARKER;
    broken.nodes.welcome!.text = `${MARKER} {{${MARKER}}}`;
    broken.nodes.welcome!.next = "missing_node";
    broken.nodes.done!.message = MARKER.repeat(60); // over the text limit
    broken.nodes.to_staff!.reason = MARKER;
    await saved(admin, bot.id, 1, broken);
    const before = await row(bot.id);
    const audited = adminActions();
    const res = await validation(bot.id, { cookie: staff.cookie });
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    const report = (await res.json()) as {
      draftRevision: number;
      ok: boolean;
      diagnostics: Array<Record<string, unknown>>;
    };
    expect(report.draftRevision).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.diagnostics.length).toBeGreaterThan(0);
    for (const d of report.diagnostics)
      expect(d).toMatchObject({
        severity: expect.stringMatching(/^(error|warning)$/),
        code: expect.any(String),
        path: expect.any(Array),
        message: expect.any(String),
      });
    expect(text).not.toContain(MARKER);
    expect(Object.keys(report).sort()).toEqual(["diagnostics", "draftRevision", "ok"]);
    expect(await row(bot.id)).toEqual(before);
    expect(adminActions()).toBe(audited);
    // the detail read still returns the tenant's own draft, exactly
    const got = (await (await detail(bot.id, { cookie: staff.cookie })).json()) as {
      draft: unknown;
    };
    expect(got.draft).toEqual(JSON.parse(canonicalJson(broken)));
  });

  // ------------------------------------------------------------------------------------------ no side effects
  it("editing a deployed bot's draft preserves other bot rows and version/deployment/session fingerprints, with unchanged counts for deployment events, triggers, session events, outbound requests and messages", async () => {
    const admin = await member(deployed.organizationId, "ADMIN");
    const bots = async () =>
      (
        await t.pool.query(
          "select md5(string_agg(to_jsonb(x)::text, '|' order by id)) m from bots x where id <> $1",
          [deployed.botId],
        )
      ).rows[0] as unknown;
    const others = await bots();
    const before = (await row(deployed.botId))!.r;
    expect(before.draft_revision).toBe(1);
    expect((await detail(deployed.botId, { cookie: admin.cookie })).status).toBe(200);
    expect((await validation(deployed.botId, { cookie: admin.cookie })).status).toBe(200);
    expect((await list({ cookie: admin.cookie })).status).toBe(200);
    const edited = { ...minimalFlow(), name: "Edited after publishing" };
    expect(await saved(admin, deployed.botId, 1, edited)).toMatchObject({
      draftRevision: 2,
      changed: true,
    });
    expect(
      (
        await save(deployed.botId, {
          cookie: admin.cookie,
          body: { expectedRevision: 1, config: {} },
        })
      ).status,
    ).toBe(409);
    const after = (await row(deployed.botId))!.r;
    // only the draft columns (and the row's own updated_at) moved
    const changed = Object.keys(after).filter(
      (k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]),
    );
    expect(changed.sort()).toEqual(
      [
        "draft_config_canonical",
        "draft_revision",
        "draft_updated_at",
        "draft_updated_by_membership_id",
        "updated_at",
      ].sort(),
    );
    expect(await bots()).toEqual(others);
    // the published version and the live deployment are exactly as they were
    expect(await effects()).toEqual(baseline);
    expect(
      (
        await t.pool.query("select version_id, status from bot_deployments where id = $1", [
          deployed.deploymentId,
        ])
      ).rows[0],
    ).toEqual({ version_id: deployed.versionId, status: "ACTIVE" });
  });

  it("after the requests: version/deployment/session fingerprints and deployment-event, trigger, session-event, outbound-request and message row counts are unchanged, with no external fetch", async () => {
    expect(await effects()).toEqual(baseline);
    expect(outbound.filter((u) => !u.startsWith(ORIGIN))).toEqual([]);
  });

  it("no response and no log line carries draft text, a database error or a secret", async () => {
    const everything = logs.join("\n");
    expect(everything).not.toContain(MARKER);
    expect(everything).not.toMatch(
      /half a flow|Edited after publishing|ආයුබෝවන්|draft_config_canonical/,
    );
    expect(everything).not.toMatch(
      /duplicate key|violates|syntax error|invalid input syntax|bots_org_key_unique/i,
    );
    expect(everything).not.toMatch(/correct-horse-battery|session_token=/);
    // the generic 500 of the aborted upload logged the error's name only
    expect(
      logs.some(
        (l) => l.includes('"message":"unhandled error"') && l.includes('"error_name":"Error"'),
      ),
    ).toBe(true);
    const errorBodies = responses.filter((r) => r.startsWith('{"error"'));
    expect(errorBodies.length).toBeGreaterThan(50);
    for (const body of errorBodies) {
      expect(body).not.toContain(MARKER);
      expect(body).not.toMatch(
        /duplicate key|violates|syntax error|invalid input syntax|constraint|stack|at .*\.ts/i,
      );
      expect(
        Object.keys((JSON.parse(body) as ErrorBody).error)
          .sort()
          .join(),
      ).toMatch(/^code,(fields,)?message$/);
    }
  });
});
