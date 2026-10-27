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
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import type { Role } from "@/modules/access";
import { addMessage, addConversation, minutesAgo, world } from "./testing";

// The inbox HTTP API: the REAL route handlers, real Better Auth sessions and real PostgreSQL. Every route authenticates and
// authorizes on its own (no layout, no hidden button), mutations are same-origin only, and another organization's ids are 404.

const ORIGIN = TEST_AUTH_ENV.origin;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

type Handlers = Record<
  string,
  (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
>;

describe("inbox HTTP API", () => {
  let t: TestDb;
  let a: RealAuth;
  let release: () => Promise<void>;
  const routes: Record<string, Handlers> = {};
  const logs: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    a = realAuth(t);
    release = useGlobalAuth(t);
    const load = async (key: string, loader: () => Promise<unknown>) =>
      (routes[key] = (await loader()) as Handlers);
    await load("list", () => import("../../app/api/inbox/conversations/route"));
    await load("detail", () => import("../../app/api/inbox/conversations/[conversationId]/route"));
    await load(
      "messages",
      () => import("../../app/api/inbox/conversations/[conversationId]/messages/route"),
    );
    await load(
      "seen",
      () => import("../../app/api/inbox/conversations/[conversationId]/seen/route"),
    );
    await load(
      "status",
      () => import("../../app/api/inbox/conversations/[conversationId]/status/route"),
    );
    await load(
      "assignment",
      () => import("../../app/api/inbox/conversations/[conversationId]/assignment/route"),
    );
    await load(
      "notes",
      () => import("../../app/api/inbox/conversations/[conversationId]/notes/route"),
    );
    await load("assignees", () => import("../../app/api/inbox/assignees/route"));
    await load("tags", () => import("../../app/api/inbox/tags/route"));
    await load("contactTags", () => import("../../app/api/inbox/contacts/[contactId]/tags/route"));
    await load(
      "contactTag",
      () => import("../../app/api/inbox/contacts/[contactId]/tags/[tagId]/route"),
    );
    await load("quick", () => import("../../app/api/inbox/quick-replies/route"));
    await load("quickOne", () => import("../../app/api/inbox/quick-replies/[id]/route"));
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(
        (...args: unknown[]) => void logs.push(args.map(String).join(" ")),
      );
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await release();
    await t.close();
  });

  async function staff(organizationId: string, role: Role = "STAFF") {
    const email = `${role.toLowerCase()}-${uniq()}@example.com`;
    const user = await provisionUser(a, t, email, { organizationId, role, status: "ACTIVE" });
    const [m] = await t.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.userId, user.id));
    return { cookie: await login(a, email), membershipId: m!.id, email };
  }

  type CallOptions = {
    cookie?: string;
    body?: unknown;
    raw?: string;
    origin?: string | null;
    type?: string | null;
    params?: Record<string, string>;
  };
  async function call(
    route: keyof typeof routes | string,
    method: string,
    path: string,
    o: CallOptions = {},
  ) {
    const headers: Record<string, string> = {};
    if (o.cookie) headers.cookie = o.cookie;
    const mutating = method !== "GET";
    if (mutating && o.origin !== null) headers.origin = o.origin ?? ORIGIN;
    const body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    if (body !== undefined && o.type !== null)
      headers["content-type"] = o.type ?? "application/json";
    const handler = routes[route]![method]!;
    return handler(new Request(`${ORIGIN}${path}`, { method, headers, body }), {
      params: Promise.resolve(o.params ?? {}),
    });
  }
  const w = () => world(t.db, { lastInboundAt: minutesAgo(10) });
  const code = async (res: Response) =>
    ((await res.clone().json()) as { error?: { code?: string } }).error?.code;

  it("without a session every route answers 401 (reads and writes) and nothing is written", async () => {
    const x = await w();
    const id = x.conversation.id;
    const cp = { conversationId: id };
    const attempts: Array<Promise<Response>> = [
      call("list", "GET", "/api/inbox/conversations"),
      call("detail", "GET", `/api/inbox/conversations/${id}`, { params: cp }),
      call("messages", "GET", `/api/inbox/conversations/${id}/messages`, { params: cp }),
      call("seen", "POST", `/api/inbox/conversations/${id}/seen`, {
        params: cp,
        body: { messageIds: [id] },
      }),
      call("status", "POST", `/api/inbox/conversations/${id}/status`, {
        params: cp,
        body: { to: "PENDING", expected: "OPEN" },
      }),
      call("assignment", "POST", `/api/inbox/conversations/${id}/assignment`, {
        params: cp,
        body: { assigneeMembershipId: null, expectedAssigneeMembershipId: null },
      }),
      call("notes", "GET", `/api/inbox/conversations/${id}/notes`, { params: cp }),
      call("notes", "POST", `/api/inbox/conversations/${id}/notes`, {
        params: cp,
        body: { body: "x" },
      }),
      call("assignees", "GET", "/api/inbox/assignees"),
      call("tags", "GET", "/api/inbox/tags"),
      call("tags", "POST", "/api/inbox/tags", { body: { name: "x" } }),
      call("contactTags", "POST", `/api/inbox/contacts/${x.contact.id}/tags`, {
        params: { contactId: x.contact.id },
        body: { tagId: id },
      }),
      call("contactTag", "DELETE", `/api/inbox/contacts/${x.contact.id}/tags/${id}`, {
        params: { contactId: x.contact.id, tagId: id },
      }),
      call("quick", "GET", "/api/inbox/quick-replies"),
      call("quick", "POST", "/api/inbox/quick-replies", { body: { title: "t", body: "b" } }),
      call("quickOne", "PATCH", `/api/inbox/quick-replies/${id}`, {
        params: { id },
        body: { archived: true },
      }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(401);
    expect((await t.pool.query("select count(*)::int n from conversation_events")).rows[0].n).toBe(
      0,
    );
    expect((await t.pool.query("select count(*)::int n from conversation_notes")).rows[0].n).toBe(
      0,
    );
  });

  it("a forged or garbage session cookie is rejected like no session", async () => {
    const x = await w();
    for (const cookie of [
      "better-auth.session_token=forged.value",
      "__Secure-better-auth.session_token=forged.value",
      "x=y",
    ]) {
      expect((await call("list", "GET", "/api/inbox/conversations", { cookie })).status).toBe(401);
      expect(
        (
          await call("status", "POST", "/x", {
            cookie,
            params: { conversationId: x.conversation.id },
            body: { to: "PENDING", expected: "OPEN" },
          })
        ).status,
      ).toBe(401);
    }
  });

  it("mutations are same-origin only: no Origin or a foreign Origin is 403 before anything else, and changes nothing", async () => {
    const x = await w();
    const s = await staff(x.org.id);
    const opts = {
      cookie: s.cookie,
      params: { conversationId: x.conversation.id },
      body: { to: "PENDING", expected: "OPEN" },
    };
    expect((await call("status", "POST", "/x", { ...opts, origin: null })).status).toBe(403);
    expect(
      (await call("status", "POST", "/x", { ...opts, origin: "https://evil.example" })).status,
    ).toBe(403);
    expect(
      (await t.pool.query("select status from conversations where id = $1", [x.conversation.id]))
        .rows[0].status,
    ).toBe("OPEN");
    expect((await call("status", "POST", "/x", opts)).status).toBe(200);
  });

  it("bodies must be JSON objects of the documented shape: wrong content type, malformed JSON, extra keys and wrong types are 400", async () => {
    const x = await w();
    const s = await staff(x.org.id);
    const base = { cookie: s.cookie, params: { conversationId: x.conversation.id } };
    expect(
      (
        await call("status", "POST", "/x", {
          ...base,
          raw: '{"to":"PENDING","expected":"OPEN"}',
          type: "text/plain",
        })
      ).status,
    ).toBe(400);
    expect((await call("status", "POST", "/x", { ...base, raw: "{not json" })).status).toBe(400);
    expect(
      (
        await call("status", "POST", "/x", {
          ...base,
          body: { to: "PENDING", expected: "OPEN", organizationId: x.org.id },
        })
      ).status,
    ).toBe(400);
    expect((await call("status", "POST", "/x", { ...base, body: [] })).status).toBe(400);
    expect((await call("notes", "POST", "/x", { ...base, body: { body: 5 } })).status).toBe(400);
    expect(
      (await call("list", "GET", "/api/inbox/conversations?organizationId=x", { cookie: s.cookie }))
        .status,
    ).toBe(400);
    expect(
      (await call("list", "GET", "/api/inbox/conversations?limit=500", { cookie: s.cookie }))
        .status,
    ).toBe(400);
  });

  it("the Bot Attention view needs bot.read: VIEWER gets 403 and no bot data, STAFF gets 200 (08F-2, D-3)", async () => {
    const x = await w();
    const viewer = await staff(x.org.id, "VIEWER");
    const member = await staff(x.org.id, "STAFF");
    const forbidden = await call("list", "GET", "/api/inbox/conversations?view=botAttention", {
      cookie: viewer.cookie,
    });
    expect(forbidden.status).toBe(403);
    expect(await code(forbidden)).toBe("FORBIDDEN");
    const plain = await call("list", "GET", "/api/inbox/conversations", { cookie: viewer.cookie });
    expect(plain.status).toBe(200);
    expect(JSON.stringify(await plain.json())).not.toMatch(/"bot"/);
    const ok = await call("list", "GET", "/api/inbox/conversations?view=botAttention", {
      cookie: member.cookie,
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("a STAFF member works a conversation end to end through the API: list, open, mark seen, status, assign, note, tag, quick reply", async () => {
    const x = await w();
    const s = await staff(x.org.id);
    const m1 = await addMessage(t.db, x, { direction: "INBOUND", body: "Hello sir" });
    const cp = { conversationId: x.conversation.id };

    const list = await call("list", "GET", "/api/inbox/conversations", { cookie: s.cookie });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const page = (await list.json()) as { items: Array<{ id: string; unreadCount: number }> };
    expect(page.items.find((i) => i.id === x.conversation.id)!.unreadCount).toBeGreaterThanOrEqual(
      0,
    );

    const detail = await call("detail", "GET", `/x`, { cookie: s.cookie, params: cp });
    const d = (
      (await detail.json()) as {
        conversation: { status: string; can: Record<string, boolean>; assignee: unknown };
      }
    ).conversation;
    expect(d).toMatchObject({ status: "OPEN", assignee: null, can: { reply: true, manage: true } });

    const messages = await call("messages", "GET", "/x", { cookie: s.cookie, params: cp });
    expect(
      ((await messages.json()) as { messages: Array<{ id: string; text: string }> }).messages.some(
        (m) => m.id === m1.id,
      ),
    ).toBe(true);

    const seen = await call("seen", "POST", "/x", {
      cookie: s.cookie,
      params: cp,
      body: { messageIds: [m1.id] },
    });
    expect(await seen.json()).toMatchObject({ marked: 1, unreadCount: 0 });

    const st = await call("status", "POST", "/x", {
      cookie: s.cookie,
      params: cp,
      body: { to: "PENDING", expected: "OPEN" },
    });
    expect(await st.json()).toEqual({ changed: true, status: "PENDING" });
    const stale = await call("status", "POST", "/x", {
      cookie: s.cookie,
      params: cp,
      body: { to: "RESOLVED", expected: "OPEN" },
    });
    expect(stale.status).toBe(409);
    expect(await code(stale)).toBe("STALE_STATE");

    const asg = await call("assignment", "POST", "/x", {
      cookie: s.cookie,
      params: cp,
      body: { assigneeMembershipId: s.membershipId, expectedAssigneeMembershipId: null },
    });
    expect(await asg.json()).toEqual({ changed: true, assigneeMembershipId: s.membershipId });
    const assignees = await call("assignees", "GET", "/x", { cookie: s.cookie });
    expect(
      ((await assignees.json()) as { assignees: Array<{ membershipId: string }> }).assignees.map(
        (a) => a.membershipId,
      ),
    ).toContain(s.membershipId);

    const note = await call("notes", "POST", "/x", {
      cookie: s.cookie,
      params: cp,
      body: { body: "Follow up on registration." },
    });
    expect(note.status).toBe(201);
    const notes = await call("notes", "GET", "/x", { cookie: s.cookie, params: cp });
    expect(((await notes.json()) as { notes: Array<{ body: string }> }).notes[0]!.body).toBe(
      "Follow up on registration.",
    );

    const tag = await call("tags", "POST", "/x", {
      cookie: s.cookie,
      body: { name: "Theory batch" },
    });
    expect(tag.status).toBe(201);
    const tagId = ((await tag.json()) as { tag: { id: string } }).tag.id;
    expect(
      (
        await call("contactTags", "POST", "/x", {
          cookie: s.cookie,
          params: { contactId: x.contact.id },
          body: { tagId },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call("contactTags", "POST", "/x", {
          cookie: s.cookie,
          params: { contactId: x.contact.id },
          body: { tagId },
        })
      ).status,
    ).toBe(200);
    expect(
      await (
        await call("contactTag", "DELETE", "/x", {
          cookie: s.cookie,
          params: { contactId: x.contact.id, tagId },
        })
      ).json(),
    ).toEqual({ removed: true });

    const qr = await call("quick", "POST", "/x", {
      cookie: s.cookie,
      body: { title: "Hello", body: "Hello! How can we help?" },
    });
    expect(qr.status).toBe(201);
    const qrId = ((await qr.json()) as { quickReply: { id: string } }).quickReply.id;
    expect(
      (
        await call("quick", "POST", "/x", {
          cookie: s.cookie,
          body: { title: "hello", body: "dup" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        (await (
          await call("quick", "GET", "/api/inbox/quick-replies?q=hello", { cookie: s.cookie })
        ).json()) as { quickReplies: unknown[] }
      ).quickReplies,
    ).toHaveLength(1);
    expect(
      (
        await call("quickOne", "PATCH", "/x", {
          cookie: s.cookie,
          params: { id: qrId },
          body: { archived: true },
        })
      ).status,
    ).toBe(200);

    // none of that touched the messaging timestamps or queued anything
    const conv = (
      await t.pool.query(
        "select last_inbound_at, last_outbound_at from conversations where id = $1",
        [x.conversation.id],
      )
    ).rows[0];
    expect(conv.last_outbound_at).toBeNull();
    expect(
      (
        await t.pool.query(
          "select count(*)::int n from outbound_requests where organization_id = $1",
          [x.org.id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(logs.join("\n")).not.toMatch(/Follow up on registration|Hello sir/);
  });

  it("a VIEWER can read and mark their own seen state but every mutation and every staff-only read is 403", async () => {
    const x = await w();
    const viewer = await staff(x.org.id, "VIEWER");
    const m = await addMessage(t.db, x, { direction: "INBOUND" });
    const cp = { conversationId: x.conversation.id };
    expect(
      (await call("list", "GET", "/api/inbox/conversations", { cookie: viewer.cookie })).status,
    ).toBe(200);
    expect((await call("detail", "GET", "/x", { cookie: viewer.cookie, params: cp })).status).toBe(
      200,
    );
    expect(
      (await call("messages", "GET", "/x", { cookie: viewer.cookie, params: cp })).status,
    ).toBe(200);
    expect(
      (
        await call("seen", "POST", "/x", {
          cookie: viewer.cookie,
          params: cp,
          body: { messageIds: [m.id] },
        })
      ).status,
    ).toBe(200);
    const denied = await Promise.all([
      call("status", "POST", "/x", {
        cookie: viewer.cookie,
        params: cp,
        body: { to: "PENDING", expected: "OPEN" },
      }),
      call("assignment", "POST", "/x", {
        cookie: viewer.cookie,
        params: cp,
        body: { assigneeMembershipId: null, expectedAssigneeMembershipId: null },
      }),
      call("notes", "GET", "/x", { cookie: viewer.cookie, params: cp }),
      call("notes", "POST", "/x", { cookie: viewer.cookie, params: cp, body: { body: "x" } }),
      call("assignees", "GET", "/x", { cookie: viewer.cookie }),
      call("tags", "GET", "/x", { cookie: viewer.cookie }),
      call("tags", "POST", "/x", { cookie: viewer.cookie, body: { name: "x" } }),
      call("contactTags", "POST", "/x", {
        cookie: viewer.cookie,
        params: { contactId: x.contact.id },
        body: { tagId: x.conversation.id },
      }),
      call("quick", "GET", "/x", { cookie: viewer.cookie }),
      call("quick", "POST", "/x", { cookie: viewer.cookie, body: { title: "t", body: "b" } }),
    ]);
    for (const res of denied) expect(res.status).toBe(403);
    expect(
      (await t.pool.query("select status from conversations where id = $1", [x.conversation.id]))
        .rows[0].status,
    ).toBe("OPEN");
  });

  it("another organization's ids are 404 on every route, the same as a missing id, and nothing leaks", async () => {
    const mine = await w();
    const theirs = await w();
    const s = await staff(mine.org.id);
    const m = await addMessage(t.db, theirs, { direction: "INBOUND", body: "THEIR SECRET" });
    const other = await addConversation(t.db, theirs, { profileName: "Their Student" });
    const cp = { conversationId: theirs.conversation.id };
    const responses = await Promise.all([
      call("detail", "GET", "/x", { cookie: s.cookie, params: cp }),
      call("messages", "GET", "/x", { cookie: s.cookie, params: cp }),
      call("seen", "POST", "/x", { cookie: s.cookie, params: cp, body: { messageIds: [m.id] } }),
      call("status", "POST", "/x", {
        cookie: s.cookie,
        params: cp,
        body: { to: "PENDING", expected: "OPEN" },
      }),
      call("assignment", "POST", "/x", {
        cookie: s.cookie,
        params: cp,
        body: { assigneeMembershipId: null, expectedAssigneeMembershipId: null },
      }),
      call("notes", "GET", "/x", { cookie: s.cookie, params: cp }),
      call("notes", "POST", "/x", { cookie: s.cookie, params: cp, body: { body: "x" } }),
      call("contactTags", "POST", "/x", {
        cookie: s.cookie,
        params: { contactId: theirs.contact.id },
        body: { tagId: theirs.conversation.id },
      }),
      call("quickOne", "PATCH", "/x", {
        cookie: s.cookie,
        params: { id: theirs.conversation.id },
        body: { archived: true },
      }),
    ]);
    const texts = await Promise.all(responses.map((r) => r.clone().text()));
    for (const [i, res] of responses.entries()) {
      expect([404, 400]).toContain(res.status);
      expect(texts[i]).not.toMatch(/THEIR SECRET|Their Student/);
    }
    expect(responses.slice(0, 7).map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    const list = JSON.stringify(
      await (
        await call("list", "GET", "/api/inbox/conversations?limit=50", { cookie: s.cookie })
      ).json(),
    );
    expect(list).not.toMatch(
      new RegExp(`${theirs.conversation.id}|${other.conversation.id}|Their Student|THEIR SECRET`),
    );
    const missing = await call("detail", "GET", "/x", {
      cookie: s.cookie,
      params: { conversationId: "00000000-0000-4000-8000-000000000099" },
    });
    expect(missing.status).toBe(404);
    expect(await code(missing)).toBe("NOT_FOUND");
    expect(await code(responses[0]!)).toBe("NOT_FOUND");
  });

  it("a member suspended after logging in is refused on the next request (no ACTIVE membership)", async () => {
    const x = await w();
    const s = await staff(x.org.id);
    expect(
      (await call("list", "GET", "/api/inbox/conversations", { cookie: s.cookie })).status,
    ).toBe(200);
    await t.pool.query("update organization_memberships set status = 'SUSPENDED' where id = $1", [
      s.membershipId,
    ]);
    expect(
      (await call("list", "GET", "/api/inbox/conversations", { cookie: s.cookie })).status,
    ).toBe(403);
    expect(
      (
        await call("status", "POST", "/x", {
          cookie: s.cookie,
          params: { conversationId: x.conversation.id },
          body: { to: "PENDING", expected: "OPEN" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await t.pool.query("select status from conversations where id = $1", [x.conversation.id]))
        .rows[0].status,
    ).toBe("OPEN");
  });
});
