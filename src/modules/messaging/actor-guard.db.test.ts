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
import { minutesAgo, world } from "./testing";

// The expected-actor guard on the REAL send route with real Better Auth sessions and real PostgreSQL.
//
// The failure it prevents: staff A sends message M with key K, the server commits, A's tab loses the answer. Another tab signs A
// out and staff B in. A's tab then re-checks with K; the browser's cookie is now B's. Idempotency is scoped to the MEMBERSHIP, so
// without the guard the server would create a second request owned by B. The browser's stated actor is an assertion only: the
// server compares it with the authenticated session before anything can be written.

const ORIGIN = TEST_AUTH_ENV.origin;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const HEADER = "x-expected-actor";
const actorHeader = (a: { userId: string; organizationId: string; membershipId: string }) =>
  encodeURIComponent(
    JSON.stringify({
      userId: a.userId,
      organizationId: a.organizationId,
      membershipId: a.membershipId,
    }),
  );

describe("expected-actor guard on the send route", () => {
  let t: TestDb;
  let auth: RealAuth;
  let release: () => Promise<void>;
  let post: typeof import("../../app/api/conversations/[conversationId]/messages/route");
  let status: typeof import("../../app/api/inbox/conversations/[conversationId]/status/route");
  let detail: typeof import("../../app/api/inbox/conversations/[conversationId]/route");
  let metaCalls = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
    auth = realAuth(t);
    release = useGlobalAuth(t);
    post = await import("../../app/api/conversations/[conversationId]/messages/route");
    status = await import("../../app/api/inbox/conversations/[conversationId]/status/route");
    detail = await import("../../app/api/inbox/conversations/[conversationId]/route");
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(() => {});
    vi.stubEnv("WHATSAPP_OUTBOUND_ENABLED", "true");
    vi.stubGlobal("fetch", async () => {
      metaCalls++;
      throw new Error("no network in these tests");
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await release();
    await t.close();
  });

  async function member(organizationId: string, role: Role = "STAFF") {
    const email = `${role.toLowerCase()}-${uniq()}@example.com`;
    const user = await provisionUser(auth, t, email, { organizationId, role, status: "ACTIVE" });
    const [m] = await t.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.userId, user.id));
    return {
      cookie: await login(auth, email),
      userId: user.id,
      organizationId,
      membershipId: m!.id,
    };
  }
  const w = () => world(t.db, { lastInboundAt: minutesAgo(10) });
  const send = (
    conversationId: string,
    as: { cookie?: string },
    key: string,
    o: { text?: string; expected?: string | null; raw?: string } = {},
  ) => {
    const headers: Record<string, string> = {
      origin: ORIGIN,
      "content-type": "application/json",
    };
    if (as.cookie) headers.cookie = as.cookie;
    if (o.expected !== null && o.expected !== undefined) headers[HEADER] = o.expected;
    return post.POST(
      new Request(`${ORIGIN}/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          idempotencyKey: key,
          message: { type: "text", body: o.text ?? "Message M" },
        }),
      }),
      { params: Promise.resolve({ conversationId }) },
    );
  };
  const code = async (res: Response) =>
    ((await res.clone().json()) as { error?: { code?: string } }).error?.code;
  const rows = async (conversationId: string) =>
    (
      await t.pool.query(
        "select requested_by_membership_id, idempotency_key from outbound_requests where conversation_id = $1 order by created_at",
        [conversationId],
      )
    ).rows;
  const messages = async (conversationId: string) =>
    (
      await t.pool.query(
        "select count(*)::int n from messages where conversation_id = $1 and direction = 'OUTBOUND'",
        [conversationId],
      )
    ).rows[0].n as number;

  it("why it exists: without an assertion the same key under another member's session creates a SECOND request owned by that member", async () => {
    const x = await w();
    const a = await member(x.org.id);
    const b = await member(x.org.id);
    expect((await send(x.conversation.id, a, "baseline-key-0001")).status).toBe(201);
    const second = await send(x.conversation.id, b, "baseline-key-0001"); // no header: the old behaviour
    expect(second.status).toBe(201);
    expect((await rows(x.conversation.id)).map((r) => r.requested_by_membership_id)).toEqual([
      a.membershipId,
      b.membershipId,
    ]);
  });

  it("A and B in the same organization: A's tab re-checks K under B's cookie and is refused; nothing is created, no Meta request", async () => {
    const x = await w();
    const a = await member(x.org.id);
    const b = await member(x.org.id);
    expect(
      (await send(x.conversation.id, a, "race-key-0001", { expected: actorHeader(a) })).status,
    ).toBe(201);
    const before = {
      requests: await rows(x.conversation.id),
      messages: await messages(x.conversation.id),
    };

    const res = await send(x.conversation.id, b, "race-key-0001", { expected: actorHeader(a) });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("ACTOR_CHANGED");
    expect(JSON.stringify(await res.json())).not.toContain(a.membershipId); // no identity in the answer
    expect(await rows(x.conversation.id)).toEqual(before.requests); // exactly the original logical request
    expect(await messages(x.conversation.id)).toBe(before.messages);
    expect(metaCalls).toBe(0);

    // the original actor signing back in: the same key is a replay of the original request, not a new one
    const again = await send(x.conversation.id, a, "race-key-0001", { expected: actorHeader(a) });
    expect(again.status).toBe(200);
    expect(await rows(x.conversation.id)).toHaveLength(1);
  });

  it("A and B in different organizations: refused before any lookup, no write in either organization", async () => {
    const x = await w();
    const y = await w();
    const a = await member(x.org.id);
    const b = await member(y.org.id);
    expect(
      (await send(x.conversation.id, a, "race-key-0002", { expected: actorHeader(a) })).status,
    ).toBe(201);
    for (const conversation of [x.conversation.id, y.conversation.id]) {
      const res = await send(conversation, b, "race-key-0002", { expected: actorHeader(a) });
      expect(res.status).toBe(409);
      expect(await code(res)).toBe("ACTOR_CHANGED");
    }
    expect(await rows(x.conversation.id)).toHaveLength(1);
    expect(await rows(y.conversation.id)).toHaveLength(0);
  });

  it("a FRESH send (new key) from the old tab is refused too", async () => {
    const x = await w();
    const a = await member(x.org.id);
    const b = await member(x.org.id);
    const res = await send(x.conversation.id, b, "fresh-key-0001", { expected: actorHeader(a) });
    expect(res.status).toBe(409);
    expect(await rows(x.conversation.id)).toHaveLength(0);
    expect(await messages(x.conversation.id)).toBe(0);
  });

  it("every identifier counts: a wrong user, organization or membership alone is enough to refuse", async () => {
    const x = await w();
    const a = await member(x.org.id);
    const other = await member(x.org.id);
    for (const wrong of [
      { ...a, userId: other.userId },
      { ...a, organizationId: "00000000-0000-4000-8000-000000000000" },
      { ...a, membershipId: other.membershipId }, // a membership change: same person, different membership
    ]) {
      const res = await send(x.conversation.id, a, "partial-key-0001", {
        expected: actorHeader(wrong),
      });
      expect(res.status).toBe(409);
    }
    expect(await rows(x.conversation.id)).toHaveLength(0);
  });

  it("a matching assertion changes nothing: the first send is 201, a replay is 200, and the actor is the session's", async () => {
    const x = await w();
    const a = await member(x.org.id);
    const first = await send(x.conversation.id, a, "match-key-0001", { expected: actorHeader(a) });
    const second = await send(x.conversation.id, a, "match-key-0001", { expected: actorHeader(a) });
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(await rows(x.conversation.id)).toHaveLength(1);
  });

  it("the assertion grants nothing: the right identifiers do not help a viewer, a stranger or an unauthenticated caller", async () => {
    const x = await w();
    const viewer = await member(x.org.id, "VIEWER");
    const foreign = await member((await w()).org.id);
    expect(
      (await send(x.conversation.id, viewer, "grant-key-0001", { expected: actorHeader(viewer) }))
        .status,
    ).toBe(403);
    expect(
      (await send(x.conversation.id, foreign, "grant-key-0002", { expected: actorHeader(foreign) }))
        .status,
    ).toBe(404);
    expect(
      (await send(x.conversation.id, {}, "grant-key-0003", { expected: actorHeader(viewer) }))
        .status,
    ).toBe(401);
    expect(await rows(x.conversation.id)).toHaveLength(0);
  });

  it("a present but malformed, incomplete, oversized or duplicated assertion fails closed", async () => {
    const x = await w();
    const a = await member(x.org.id);
    const good = actorHeader(a);
    const bad = [
      "not json",
      encodeURIComponent("{}"),
      encodeURIComponent(JSON.stringify({ userId: a.userId })),
      encodeURIComponent(JSON.stringify({ ...a, cookie: "extra" })),
      encodeURIComponent(JSON.stringify({ userId: 1, organizationId: 2, membershipId: 3 })),
      encodeURIComponent(
        JSON.stringify({
          userId: "",
          organizationId: a.organizationId,
          membershipId: a.membershipId,
        }),
      ),
      "%E0%A4%A", // invalid percent-encoding
      "x".repeat(2000),
      `${good}, ${good}`, // a repeated header is combined by the platform
      "",
    ];
    for (const expected of bad) {
      const res = await send(x.conversation.id, a, "malformed-key-0001", { expected });
      expect(res.status, expected.slice(0, 40)).toBe(400);
    }
    expect(await rows(x.conversation.id)).toHaveLength(0);
  });

  it("the guard covers the inbox API too: a stale tab cannot read or change anything as the new member", async () => {
    const x = await w();
    const a = await member(x.org.id);
    const b = await member(x.org.id);
    const id = x.conversation.id;
    const stale = { [HEADER]: actorHeader(a) };
    const read = await detail.GET(
      new Request(`${ORIGIN}/api/inbox/conversations/${id}`, {
        headers: { cookie: b.cookie, ...stale },
      }),
      { params: Promise.resolve({ conversationId: id }) },
    );
    expect(read.status).toBe(409);
    const change = await status.POST(
      new Request(`${ORIGIN}/api/inbox/conversations/${id}/status`, {
        method: "POST",
        headers: { cookie: b.cookie, origin: ORIGIN, "content-type": "application/json", ...stale },
        body: JSON.stringify({ to: "RESOLVED", expected: "OPEN" }),
      }),
      { params: Promise.resolve({ conversationId: id }) },
    );
    expect(change.status).toBe(409);
    const [row] = (await t.pool.query("select status from conversations where id = $1", [id])).rows;
    expect(row.status).toBe("OPEN");
    // and the same call with the matching assertion works
    const ok = await detail.GET(
      new Request(`${ORIGIN}/api/inbox/conversations/${id}`, {
        headers: { cookie: b.cookie, [HEADER]: actorHeader(b) },
      }),
      { params: Promise.resolve({ conversationId: id }) },
    );
    expect(ok.status).toBe(200);
  });

  it("no Meta request was made by any of this", () => {
    expect(metaCalls).toBe(0);
  });
});
