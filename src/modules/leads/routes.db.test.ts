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
import { addContact, addTouch, linkTouch, minutesAgo, seedLead } from "./testing";

// The leads HTTP API: the REAL route handlers, real Better Auth sessions and real PostgreSQL. Every route authenticates and
// authorizes on its own (no layout, no hidden button), mutations are same-origin only, another organization's ids are an
// ordinary 404, and nothing can be written through the API except a manual lead and a status change.

const ORIGIN = TEST_AUTH_ENV.origin;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

type Handlers = Record<
  string,
  (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
>;

describe("leads HTTP API", () => {
  let t: TestDb;
  let a: RealAuth;
  let release: () => Promise<void>;
  const routes: Record<string, Handlers> = {};
  const logs: string[] = [];
  const outbound: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    a = realAuth(t);
    release = useGlobalAuth(t);
    const load = async (key: string, loader: () => Promise<unknown>) =>
      (routes[key] = (await loader()) as Handlers);
    await load("leads", () => import("../../app/api/leads/route"));
    await load("detail", () => import("../../app/api/leads/[id]/route"));
    await load("events", () => import("../../app/api/leads/[id]/events/route"));
    await load("status", () => import("../../app/api/leads/[id]/status/route"));
    await load("forContact", () => import("../../app/api/leads/for-contact/[contactId]/route"));
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(
        (...args: unknown[]) => void logs.push(args.map(String).join(" ")),
      );
    // nothing in the leads API may reach another host: record every fetch and let it through unchanged
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

  const orgWithContact = async () => {
    const org = await seedOrg(t.db);
    const [account] = await t.db
      .insert(schema.whatsappAccounts)
      .values({
        organizationId: org.id,
        wabaId: `2${Math.floor(Math.random() * 1e14)}`,
        phoneNumberId: `1${Math.floor(Math.random() * 1e14)}`,
        displayPhoneNumber: "+94 77 000 0000",
        status: "ACTIVE",
      })
      .returning();
    const contact = await addContact(t.db, org.id, { profileName: "Student" });
    return { org, account: account!, contact };
  };

  async function staff(
    organizationId: string,
    role: Role = "STAFF",
    status: "ACTIVE" | "SUSPENDED" = "ACTIVE",
  ) {
    const email = `${role.toLowerCase()}-${uniq()}@example.com`;
    const user = await provisionUser(a, t, email, { organizationId, role, status });
    const [m] = await t.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.userId, user.id));
    return { cookie: await login(a, email), membershipId: m!.id, userId: user.id, organizationId };
  }

  type CallOptions = {
    cookie?: string;
    body?: unknown;
    raw?: string;
    origin?: string | null;
    type?: string | null;
    params?: Record<string, string>;
    headers?: Record<string, string>;
  };
  async function call(route: string, method: string, path: string, o: CallOptions = {}) {
    const headers: Record<string, string> = { ...o.headers };
    if (o.cookie) headers.cookie = o.cookie;
    if (method !== "GET" && o.origin !== null) headers.origin = o.origin ?? ORIGIN;
    const body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    if (body !== undefined && o.type !== null)
      headers["content-type"] = o.type ?? "application/json";
    const handler = routes[route]![method];
    if (!handler) throw new Error(`no ${method} handler on ${route}`);
    return handler(new Request(`${ORIGIN}${path}`, { method, headers, body }), {
      params: Promise.resolve(o.params ?? {}),
    });
  }
  const code = async (res: Response) =>
    ((await res.clone().json()) as { error?: { code?: string } }).error?.code;
  const count = async (table: string) =>
    ((await t.pool.query(`select count(*)::int n from ${table}`)).rows[0] as { n: number }).n;
  const actorHeader = (s: { userId: string; organizationId: string; membershipId: string }) => ({
    "x-expected-actor": encodeURIComponent(
      JSON.stringify({
        userId: s.userId,
        organizationId: s.organizationId,
        membershipId: s.membershipId,
      }),
    ),
  });

  it("without a session every route answers 401 (reads and writes) and nothing is written", async () => {
    const x = await orgWithContact();
    const lead = await seedLead(t.db, x, x.contact.id);
    const id = lead.id;
    const before = { leads: await count("leads"), events: await count("lead_events") };
    const attempts = [
      call("leads", "GET", "/api/leads"),
      call("leads", "POST", "/api/leads", { body: { contactId: x.contact.id } }),
      call("detail", "GET", `/api/leads/${id}`, { params: { id } }),
      call("events", "GET", `/api/leads/${id}/events`, { params: { id } }),
      call("status", "POST", `/api/leads/${id}/status`, {
        params: { id },
        body: { to: "QUALIFIED", expectedRevision: 0 },
      }),
      call("forContact", "GET", `/api/leads/for-contact/${x.contact.id}`, {
        params: { contactId: x.contact.id },
      }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await count("leads")).toBe(before.leads);
    expect(await count("lead_events")).toBe(before.events);
    // a forged or garbage cookie is rejected the same way
    for (const cookie of ["better-auth.session_token=forged.value", "x=y"])
      expect((await call("leads", "GET", "/api/leads", { cookie })).status).toBe(401);
  });

  it("mutations are same-origin only: no Origin or a foreign Origin is 403 before anything else, and changes nothing", async () => {
    const x = await orgWithContact();
    const s = await staff(x.org.id);
    const lead = await seedLead(t.db, x, x.contact.id);
    const other = await addContact(t.db, x.org.id);
    for (const origin of [null, "https://evil.example"]) {
      expect(
        (
          await call("leads", "POST", "/api/leads", {
            cookie: s.cookie,
            origin,
            body: { contactId: other.id },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call("status", "POST", "/x", {
            cookie: s.cookie,
            origin,
            params: { id: lead.id },
            body: { to: "QUALIFIED", expectedRevision: 0 },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (await t.pool.query("select count(*)::int n from leads where contact_id = $1", [other.id]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (await t.pool.query("select status from leads where id = $1", [lead.id])).rows[0].status,
    ).toBe("NEW");
    expect(
      (
        await call("leads", "POST", "/api/leads", {
          cookie: s.cookie,
          body: { contactId: other.id },
        })
      ).status,
    ).toBe(201);
  });

  it("bodies and queries are validated: wrong content type, malformed JSON, extra keys, wrong types and bad bounds are 400", async () => {
    const x = await orgWithContact();
    const s = await staff(x.org.id);
    const lead = await seedLead(t.db, x, x.contact.id);
    const post = (body: CallOptions) =>
      call("status", "POST", "/x", { cookie: s.cookie, params: { id: lead.id }, ...body });
    expect(
      (await post({ raw: '{"to":"QUALIFIED","expectedRevision":0}', type: "text/plain" })).status,
    ).toBe(400);
    expect((await post({ raw: "{not json" })).status).toBe(400);
    expect((await post({ body: [] })).status).toBe(400);
    expect((await post({ body: { to: "QUALIFIED" } })).status).toBe(400);
    expect((await post({ body: { to: "QUALIFIED", expectedRevision: "0" } })).status).toBe(400);
    for (const to of schema.RESERVED_LEAD_STATUSES) {
      const res = await post({ body: { to, expectedRevision: 0 } });
      expect(res.status, to).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "VALIDATION_ERROR", fields: ["to"] },
      });
    }
    const create = (body: unknown) =>
      call("leads", "POST", "/api/leads", { cookie: s.cookie, body });
    expect((await create({})).status).toBe(400);
    expect((await create({ contactId: "nope" })).status).toBe(400);
    for (const get of [
      "?organizationId=x",
      "?limit=500",
      "?limit=0",
      "?q=a",
      "?state=all",
      "?attribution=organic",
      "?cursor=zzz",
    ])
      expect(
        (await call("leads", "GET", `/api/leads${get}`, { cookie: s.cookie })).status,
        get,
      ).toBe(400);
    expect(
      (await call("events", "GET", "/x?limit=500", { cookie: s.cookie, params: { id: lead.id } }))
        .status,
    ).toBe(400);
    // a cursor with the right shape but an impossible date is a controlled 400 (not a database error and not a 500)
    for (const impossible of [
      "2026-99-99T25:61:61.000000Z",
      "2026-02-29T10:00:00.000000Z",
      "2026-01-01T24:00:00.000000Z",
    ]) {
      const cursor = Buffer.from(
        JSON.stringify({ t: impossible, id: "6f1c4d0a-8b5e-4a57-9d34-0c2d9a1b7e11" }),
      ).toString("base64url");
      const list = await call("leads", "GET", `/api/leads?cursor=${cursor}`, { cookie: s.cookie });
      expect(list.status, impossible).toBe(400);
      expect(await list.json()).toMatchObject({
        error: { code: "VALIDATION_ERROR", fields: ["cursor"] },
      });
      const history = await call("events", "GET", `/x?cursor=${cursor}`, {
        cookie: s.cookie,
        params: { id: lead.id },
      });
      expect(history.status, impossible).toBe(400);
      expect(await history.json()).toMatchObject({
        error: { code: "VALIDATION_ERROR", fields: ["cursor"] },
      });
    }
    expect(
      (await t.pool.query("select status, revision from leads where id = $1", [lead.id])).rows[0],
    ).toEqual({ status: "NEW", revision: 0 });
  });

  it("lifecycle values, history rows and attribution cannot be written through the API: the client sends a contact, or a target and a revision", async () => {
    const x = await orgWithContact();
    const s = await staff(x.org.id);
    const lead = await seedLead(t.db, x, x.contact.id);
    const touch = await addTouch(t.db, x, x.contact.id);
    const other = await addContact(t.db, x.org.id);
    const before = { leads: await count("leads"), events: await count("lead_events") };
    const forged = [
      { cycleStartedAt: "2020-01-01T00:00:00Z" },
      { closedAt: "2020-01-01T00:00:00Z" },
      { statusChangedAt: "2020-01-01T00:00:00Z" },
      { createdAt: "2020-01-01T00:00:00Z" },
      { revision: 9 },
      { origin: "AD_REFERRAL" },
      { attributionId: touch.id },
      { initiatingAttributionId: touch.id },
      { organizationId: x.org.id },
      { events: [{ kind: "STATUS", fromStatus: "NEW", toStatus: "INVALID", revision: 1 }] },
    ];
    for (const extra of forged) {
      const created = await call("leads", "POST", "/api/leads", {
        cookie: s.cookie,
        body: { contactId: other.id, ...extra },
      });
      expect(created.status, JSON.stringify(extra)).toBe(400);
      const key = Object.keys(extra)[0]!;
      expect(((await created.json()) as { error: { fields: string[] } }).error.fields).toContain(
        key,
      );
      const changed = await call("status", "POST", "/x", {
        cookie: s.cookie,
        params: { id: lead.id },
        body: { to: "QUALIFIED", expectedRevision: 0, ...extra },
      });
      expect(changed.status, JSON.stringify(extra)).toBe(400);
    }
    // there is no way to POST, PUT, PATCH or DELETE history or attribution: the handlers do not exist
    expect(Object.keys(routes.events!).sort()).toEqual(["GET"]);
    expect(Object.keys(routes.detail!).sort()).toEqual(["GET"]);
    expect(Object.keys(routes.forContact!).sort()).toEqual(["GET"]);
    expect(Object.keys(routes.status!).sort()).toEqual(["POST"]);
    expect(Object.keys(routes.leads!).sort()).toEqual(["GET", "POST"]);
    expect(await count("leads")).toBe(before.leads);
    expect(await count("lead_events")).toBe(before.events);
    expect(
      (await t.pool.query("select lead_id from lead_attributions where id = $1", [touch.id]))
        .rows[0].lead_id,
    ).toBeNull();
  });

  it("a STAFF member works leads end to end: create, list, open, history, change, stale, reopen refusal, the contact's card", async () => {
    const x = await orgWithContact();
    const s = await staff(x.org.id);
    const ok = { cookie: s.cookie };

    const created = await call("leads", "POST", "/api/leads", {
      ...ok,
      body: { contactId: x.contact.id },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const createdBody = (await created.json()) as {
      created: boolean;
      lead: { id: string; status: string; revision: number };
    };
    expect(createdBody).toMatchObject({ created: true, lead: { status: "NEW", revision: 0 } });
    const id = createdBody.lead.id;

    const again = await call("leads", "POST", "/api/leads", {
      ...ok,
      body: { contactId: x.contact.id },
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, lead: { id } });
    expect(
      (await t.pool.query("select count(*)::int n from lead_events where lead_id = $1", [id]))
        .rows[0].n,
    ).toBe(1);

    const list = await call("leads", "GET", "/api/leads?state=open&attribution=none", ok);
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id),
    ).toContain(id);

    const detail = await call("detail", "GET", "/x", { ...ok, params: { id } });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      lead: { id, origin: "MANUAL" },
      attribution: { source: { kind: "NONE", label: "No advertisement referral recorded" } },
      can: { edit: true },
    });

    const changed = await call("status", "POST", "/x", {
      ...ok,
      params: { id },
      body: { to: "NO_RESPONSE", expectedRevision: 0 },
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      changed: true,
      lead: { status: "NO_RESPONSE", revision: 1, open: false },
    });
    const stale = await call("status", "POST", "/x", {
      ...ok,
      params: { id },
      body: { to: "QUALIFIED", expectedRevision: 0 },
    });
    expect(stale.status).toBe(409);
    expect(await code(stale)).toBe("STALE_STATE");

    // a newer open lead of the contact blocks the reopening
    const second = await call("leads", "POST", "/api/leads", {
      ...ok,
      body: { contactId: x.contact.id },
    });
    expect(second.status).toBe(201);
    const blocked = await call("status", "POST", "/x", {
      ...ok,
      params: { id },
      body: { to: "NEW", expectedRevision: 1 },
    });
    expect(blocked.status).toBe(409);
    expect(await code(blocked)).toBe("ALREADY_OPEN");

    const events = await call("events", "GET", "/x?limit=1", { ...ok, params: { id } });
    const page = (await events.json()) as {
      events: Array<{ kind: string }>;
      nextCursor: string | null;
    };
    expect(page.events.map((e) => e.kind)).toEqual(["STATUS"]);
    expect(page.nextCursor).toBeTruthy();
    const next = await call("events", "GET", `/x?limit=5&cursor=${page.nextCursor}`, {
      ...ok,
      params: { id },
    });
    expect(
      ((await next.json()) as { events: Array<{ kind: string }> }).events.map((e) => e.kind),
    ).toEqual(["CREATED"]);

    const card = await call("forContact", "GET", "/x", {
      ...ok,
      params: { contactId: x.contact.id },
    });
    expect(card.status).toBe(200);
    expect(await card.json()).toMatchObject({
      contact: { id: x.contact.id },
      openLead: { status: "NEW" },
      can: { create: false },
    });
    expect(outbound.filter((u) => /facebook|whatsapp|graph\./i.test(u))).toEqual([]);
  });

  it("a VIEWER reads everything and writes nothing", async () => {
    const x = await orgWithContact();
    const v = await staff(x.org.id, "VIEWER");
    const lead = await seedLead(t.db, x, x.contact.id);
    const other = await addContact(t.db, x.org.id);
    const ok = { cookie: v.cookie };
    expect((await call("leads", "GET", "/api/leads", ok)).status).toBe(200);
    expect((await call("detail", "GET", "/x", { ...ok, params: { id: lead.id } })).status).toBe(
      200,
    );
    expect((await call("events", "GET", "/x", { ...ok, params: { id: lead.id } })).status).toBe(
      200,
    );
    expect(
      (await call("forContact", "GET", "/x", { ...ok, params: { contactId: x.contact.id } }))
        .status,
    ).toBe(200);
    const write = await call("leads", "POST", "/api/leads", {
      ...ok,
      body: { contactId: other.id },
    });
    expect(write.status).toBe(403);
    expect(await code(write)).toBe("FORBIDDEN");
    expect(
      (
        await call("status", "POST", "/x", {
          ...ok,
          params: { id: lead.id },
          body: { to: "QUALIFIED", expectedRevision: 0 },
        })
      ).status,
    ).toBe(403);
    expect(
      (await t.pool.query("select count(*)::int n from leads where contact_id = $1", [other.id]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (await t.pool.query("select status from leads where id = $1", [lead.id])).rows[0].status,
    ).toBe("NEW");
  });

  it("another organization's ids are the same 404 as a missing one, byte for byte, on every route", async () => {
    const x = await orgWithContact();
    const y = await orgWithContact();
    const s = await staff(x.org.id, "ADMIN");
    const theirs = await seedLead(t.db, y, y.contact.id);
    const missing = "00000000-0000-4000-8000-000000000001";
    const compare = async (mk: (id: string) => Promise<Response>, theirId: string) => {
      const foreign = await mk(theirId);
      const none = await mk(missing);
      expect(foreign.status).toBe(404);
      expect(none.status).toBe(404);
      expect(await foreign.text()).toBe(await none.text());
    };
    await compare(
      (id) => call("detail", "GET", "/x", { cookie: s.cookie, params: { id } }),
      theirs.id,
    );
    await compare(
      (id) => call("events", "GET", "/x", { cookie: s.cookie, params: { id } }),
      theirs.id,
    );
    await compare(
      (id) =>
        call("status", "POST", "/x", {
          cookie: s.cookie,
          params: { id },
          body: { to: "QUALIFIED", expectedRevision: 0 },
        }),
      theirs.id,
    );
    await compare(
      (contactId) => call("forContact", "GET", "/x", { cookie: s.cookie, params: { contactId } }),
      y.contact.id,
    );
    await compare(
      (contactId) => call("leads", "POST", "/api/leads", { cookie: s.cookie, body: { contactId } }),
      y.contact.id,
    );
    // the list never shows another organization's leads
    const list = (await (
      await call("leads", "GET", "/api/leads?limit=50", { cookie: s.cookie })
    ).json()) as { items: Array<{ id: string }> };
    expect(list.items.map((i) => i.id)).not.toContain(theirs.id);
    expect(
      (await t.pool.query("select status, revision from leads where id = $1", [theirs.id])).rows[0],
    ).toEqual({ status: "NEW", revision: 0 });
  });

  it("the expected-actor assertion is enforced: a different actor is 409 before anything runs, a malformed one is 400, the right one is accepted", async () => {
    const x = await orgWithContact();
    const s = await staff(x.org.id);
    const other = await staff(x.org.id);
    const contact = await addContact(t.db, x.org.id);
    const before = await count("leads");
    const wrong = await call("leads", "POST", "/api/leads", {
      cookie: s.cookie,
      body: { contactId: contact.id },
      headers: actorHeader(other),
    });
    expect(wrong.status).toBe(409);
    expect(await code(wrong)).toBe("ACTOR_CHANGED");
    expect(await count("leads")).toBe(before);
    const lead = await seedLead(t.db, x, x.contact.id);
    const wrongStatus = await call("status", "POST", "/x", {
      cookie: s.cookie,
      params: { id: lead.id },
      body: { to: "QUALIFIED", expectedRevision: 0 },
      headers: actorHeader(other),
    });
    expect(wrongStatus.status).toBe(409);
    expect(
      (await t.pool.query("select status from leads where id = $1", [lead.id])).rows[0].status,
    ).toBe("NEW");
    for (const header of ["%7Bnot", encodeURIComponent('{"userId":"x"}')])
      expect(
        (
          await call("leads", "GET", "/api/leads", {
            cookie: s.cookie,
            headers: { "x-expected-actor": header },
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await call("leads", "POST", "/api/leads", {
          cookie: s.cookie,
          body: { contactId: contact.id },
          headers: actorHeader(s),
        })
      ).status,
    ).toBe(201);
  });

  it("a suspended or demoted member loses access on the very next request", async () => {
    const x = await orgWithContact();
    const s = await staff(x.org.id);
    const d = await staff(x.org.id);
    const contact = await addContact(t.db, x.org.id);
    expect((await call("leads", "GET", "/api/leads", { cookie: s.cookie })).status).toBe(200);
    await t.db
      .update(schema.organizationMemberships)
      .set({ status: "SUSPENDED" })
      .where(eq(schema.organizationMemberships.id, s.membershipId));
    await t.db
      .update(schema.organizationMemberships)
      .set({ role: "VIEWER" })
      .where(eq(schema.organizationMemberships.id, d.membershipId));
    expect((await call("leads", "GET", "/api/leads", { cookie: s.cookie })).status).toBe(403);
    expect(
      (
        await call("leads", "POST", "/api/leads", {
          cookie: s.cookie,
          body: { contactId: contact.id },
        })
      ).status,
    ).toBe(403);
    expect((await call("leads", "GET", "/api/leads", { cookie: d.cookie })).status).toBe(200);
    expect(
      (
        await call("leads", "POST", "/api/leads", {
          cookie: d.cookie,
          body: { contactId: contact.id },
        })
      ).status,
    ).toBe(403);
    expect(
      (await t.pool.query("select count(*)::int n from leads where contact_id = $1", [contact.id]))
        .rows[0].n,
    ).toBe(0);
  });

  it("no response carries a provider payload, a full click id or a secret, and the API made no outbound request", async () => {
    const x = await orgWithContact();
    const s = await staff(x.org.id);
    const lead = await seedLead(t.db, x, x.contact.id, { cycleStartedAt: minutesAgo(60) });
    const touch = await addTouch(t.db, x, x.contact.id, {
      receivedAt: minutesAgo(5),
      ctwaClid: "CLICKID-0123456789-ABCDEFGHIJKLMN",
    });
    await linkTouch(t.db, x, { id: lead.id, contactId: x.contact.id }, touch.id);
    const res = await call("detail", "GET", "/x", { cookie: s.cookie, params: { id: lead.id } });
    const text = await res.text();
    expect(text).toContain("…KLMN");
    for (const secret of [
      "CLICKID-0123456789",
      "provider-only",
      "thumbnail_url",
      "utm=secret",
      "sig=x",
    ])
      expect(text).not.toContain(secret);
    expect(outbound.filter((u) => !u.startsWith(ORIGIN))).toEqual([]);
    expect(logs.join("\n")).not.toMatch(/CLICKID|Student|wa_id|9477/);
  });
});
