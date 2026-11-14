import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import {
  PASSWORD,
  TEST_AUTH_ENV,
  login,
  provisionUser,
  realAuth,
  useGlobalAuth,
  type RealAuth,
} from "@/db/__tests__/real-auth";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import type { Role } from "@/modules/access";
import { addTemplate, minutesAgo, world } from "./testing";

// The two HTTP entry points of outbound messaging: the REAL route handlers, real Better Auth sessions and real PostgreSQL.
// A request QUEUES a message; no transport exists in this process, so nothing here can send.

const ORIGIN = TEST_AUTH_ENV.origin;
void PASSWORD;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

describe("outbound messaging HTTP API", () => {
  let t: TestDb;
  let a: RealAuth;
  let release: () => Promise<void>;
  let post: typeof import("../../app/api/conversations/[conversationId]/messages/route");
  let status: typeof import("../../app/api/outbound-requests/[requestId]/route");
  const logs: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    a = realAuth(t);
    release = useGlobalAuth(t);
    post = await import("../../app/api/conversations/[conversationId]/messages/route");
    status = await import("../../app/api/outbound-requests/[requestId]/route");
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(
        (...args: unknown[]) => void logs.push(args.map(String).join(" ")),
      );
    vi.stubEnv("WHATSAPP_OUTBOUND_ENABLED", "true");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
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
    return { cookie: await login(a, email), membershipId: m!.id };
  }
  const w = () => world(t.db, { lastInboundAt: minutesAgo(10) });
  const send = (
    conversationId: string,
    o: {
      cookie?: string;
      body?: unknown;
      raw?: string;
      origin?: string | null;
      type?: string | null;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const headers: Record<string, string> = { ...o.headers };
    if (o.cookie) headers.cookie = o.cookie;
    if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
    const body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    if (body !== undefined && o.type !== null)
      headers["content-type"] = o.type ?? "application/json";
    return post.POST(
      new Request(`${ORIGIN}/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers,
        body,
      }),
      { params: Promise.resolve({ conversationId }) },
    );
  };
  const get = (requestId: string, cookie?: string) =>
    status.GET(
      new Request(`${ORIGIN}/api/outbound-requests/${requestId}`, {
        headers: cookie ? { cookie } : {},
      }),
      { params: Promise.resolve({ requestId }) },
    );
  const body = (text = "Hello", key = `route-key-${uniq()}-abc`) => ({
    idempotencyKey: key,
    message: { type: "text", body: text },
  });
  const code = async (res: Response) =>
    ((await res.clone().json()) as { error?: { code?: string } }).error?.code;
  const requests = async (conversationId: string) =>
    (
      await t.pool.query("select * from outbound_requests where conversation_id = $1", [
        conversationId,
      ])
    ).rows;

  it("no public sending: without a session both routes answer 401 and nothing is written", async () => {
    const x = await w();
    expect((await send(x.conversation.id, { body: body() })).status).toBe(401);
    expect((await get("00000000-0000-4000-8000-000000000001")).status).toBe(401);
    expect(await requests(x.conversation.id)).toHaveLength(0);
  });

  it("a STAFF member queues a message: 201 with ids and state only, never the recipient or the text", async () => {
    const x = await w();
    const s = await staff(x.org.id);
    const res = await send(x.conversation.id, { cookie: s.cookie, body: body("PRIVATE TEXT") });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["messageId", "replayed", "requestId", "state"]);
    expect(json).toMatchObject({ state: "QUEUED", replayed: false });
    const [row] = await requests(x.conversation.id);
    expect(row).toMatchObject({
      requested_by_membership_id: s.membershipId,
      organization_id: x.org.id,
      whatsapp_account_id: x.account.id,
      state: "QUEUED",
    });
    expect(logs.join("\n")).not.toContain("PRIVATE TEXT");
    expect(logs.join("\n")).not.toContain(x.contact.waId!);
  });

  it("an identical retry answers 200 with the same ids (a double click, a timeout and a retry); a changed body under the same key is 409", async () => {
    const x = await w();
    const s = await staff(x.org.id);
    const b = body("Same", "route-key-idem-001");
    const first = await send(x.conversation.id, { cookie: s.cookie, body: b });
    const second = await send(x.conversation.id, { cookie: s.cookie, body: b });
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(await second.json()).toMatchObject({ ...(await first.json()), replayed: true });
    const conflict = await send(x.conversation.id, {
      cookie: s.cookie,
      body: body("Different", "route-key-idem-001"),
    });
    expect(conflict.status).toBe(409);
    expect(await code(conflict)).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await requests(x.conversation.id)).toHaveLength(1);
  });

  it("concurrent identical HTTP requests create one request", async () => {
    const x = await w();
    const s = await staff(x.org.id);
    const b = body("Burst", "route-key-burst-001");
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => send(x.conversation.id, { cookie: s.cookie, body: b })),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(5);
    expect(await requests(x.conversation.id)).toHaveLength(1);
  });

  it("a VIEWER may not send (403) but may read a request's status", async () => {
    const x = await w();
    const viewer = await staff(x.org.id, "VIEWER");
    expect((await send(x.conversation.id, { cookie: viewer.cookie, body: body() })).status).toBe(
      403,
    );
    expect(await requests(x.conversation.id)).toHaveLength(0);
    const s = await staff(x.org.id);
    const created = (await (
      await send(x.conversation.id, { cookie: s.cookie, body: body() })
    ).json()) as { requestId: string };
    const view = await get(created.requestId, viewer.cookie);
    expect(view.status).toBe(200);
    const json = JSON.stringify(await view.json());
    expect(json).not.toContain(x.contact.waId!);
    expect(JSON.parse(json).request).toMatchObject({ state: "QUEUED", wamid: null });
  });

  it("another organization's staff gets 404 for the conversation and for the request status, exactly like a missing one", async () => {
    const a1 = await w();
    const b1 = await w();
    const sa = await staff(a1.org.id);
    const sb = await staff(b1.org.id);
    const created = (await (
      await send(a1.conversation.id, { cookie: sa.cookie, body: body() })
    ).json()) as { requestId: string };
    expect((await send(a1.conversation.id, { cookie: sb.cookie, body: body() })).status).toBe(404);
    expect((await get(created.requestId, sb.cookie)).status).toBe(404);
    expect(
      (await send("00000000-0000-4000-8000-000000000002", { cookie: sb.cookie, body: body() }))
        .status,
    ).toBe(404);
    expect((await get("not-a-uuid", sb.cookie)).status).toBe(404);
    expect(await requests(b1.conversation.id)).toHaveLength(0);
  });

  it("forged organization / role headers and body fields change nothing", async () => {
    const x = await w();
    const y = await w();
    const s = await staff(x.org.id);
    const res = await send(x.conversation.id, {
      cookie: s.cookie,
      body: body(),
      headers: { "x-organization-id": y.org.id, "x-role": "ADMIN" },
    });
    expect(res.status).toBe(201);
    expect((await requests(x.conversation.id))[0]!.organization_id).toBe(x.org.id);
    for (const extra of [
      { conversationId: y.conversation.id },
      { organizationId: y.org.id },
      { whatsappAccountId: y.account.id },
      { to: "94770000001" },
    ]) {
      const bad = await send(x.conversation.id, {
        cookie: s.cookie,
        body: { ...body(), ...extra },
      });
      expect(bad.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await requests(y.conversation.id)).toHaveLength(0);
  });

  it("same-origin and content-type protections apply", async () => {
    const x = await w();
    const s = await staff(x.org.id);
    expect(
      (
        await send(x.conversation.id, {
          cookie: s.cookie,
          body: body(),
          origin: "https://evil.example",
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await send(x.conversation.id, { cookie: s.cookie, body: body(), origin: null })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await send(x.conversation.id, {
          cookie: s.cookie,
          raw: JSON.stringify(body()),
          type: "text/plain",
        })
      ).status,
    ).toBe(400);
    expect((await send(x.conversation.id, { cookie: s.cookie, raw: "{not json" })).status).toBe(
      400,
    );
    expect((await send(x.conversation.id, { cookie: s.cookie })).status).toBe(400);
    expect(await requests(x.conversation.id)).toHaveLength(0);
  });

  // DEV-1 (shared body reader): the 16,384 limit of this route is now RAW BYTES as received, not characters.
  it("the body limit is 16,384 raw bytes: full-length Sinhala, Tamil and emoji texts still queue; multilingual template parameters are refused once the request passes it", async () => {
    const x = await w();
    const s = await staff(x.org.id);
    const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
    const post = (raw: string) => send(x.conversation.id, { cookie: s.cookie, raw });
    // texts at the application limit of 4,096 UTF-16 units
    for (const [text, size] of [
      ["අ".repeat(4096), 12_288],
      ["வ".repeat(4096), 12_288],
      ["😀".repeat(2048), 8_192],
    ] as const) {
      expect(text.length).toBe(4096);
      const raw = JSON.stringify(body(text));
      expect(bytes(raw)).toBeLessThan(16_384);
      expect(bytes(raw)).toBeGreaterThan(size);
      expect((await post(raw)).status).toBe(201);
    }
    // The schema's .max(4096) counts code points, so 4,096 four-byte emoji pass it; that text alone is 16,384 bytes, and with
    // its envelope the request is now over the transport limit (under the old character count it was 8,2xx and accepted).
    const emojiMax = JSON.stringify(body("😀".repeat(4096)));
    expect(emojiMax.length).toBeLessThan(16_384);
    expect(bytes(emojiMax)).toBeGreaterThan(16_384);
    const refusedEmoji = await post(emojiMax);
    expect(refusedEmoji.status).toBe(400);
    expect(await refusedEmoji.json()).toMatchObject({ error: { fields: ["body"] } });
    // the same value with every character \u-escaped is 6 bytes a unit: over the limit (it was before, too)
    const escaped = `{"idempotencyKey":"route-key-${uniq()}-abc","message":{"type":"text","body":"${"\\u0d85".repeat(4096)}"}}`;
    const refusedEscaped = await post(escaped);
    expect(refusedEscaped.status).toBe(400);
    expect(await refusedEscaped.json()).toMatchObject({ error: { fields: ["body"] } });

    // template parameters: the schema allows 20 x 1,024 units, the transport 16,384 bytes of request
    const template = await addTemplate(t.db, x, { category: "UTILITY", params: 20 });
    let seq = 0;
    const request = (letters: number, pad = 0) =>
      JSON.stringify({
        idempotencyKey: `dev1-key-${String(seq++).padStart(8, "0")}`, // fixed width: every request has the same envelope
        message: {
          type: "template",
          templateId: template.id,
          parameters: Array.from({ length: 20 }, () => "අ".repeat(letters)),
        },
      }) + " ".repeat(pad);
    const base = bytes(request(265)); // 20 x 265 Sinhala letters = 15,900 bytes of text, plus the envelope
    expect(base).toBeLessThan(16_384);
    const atLimit = request(265, 16_384 - base);
    expect(bytes(atLimit)).toBe(16_384);
    expect((await post(atLimit)).status).toBe(201);
    const before = (await requests(x.conversation.id)).length;
    // one byte more, and a compact request that is valid by its schema and UNDER 16,384 characters (so the old character
    // count let it through when Content-Length was absent or understated): both are now refused at the transport
    const oneOver = request(265, 16_385 - base);
    const compactOver = request(280);
    expect(bytes(oneOver)).toBe(16_385);
    expect(compactOver.length).toBeLessThan(16_384);
    expect(bytes(compactOver)).toBeGreaterThan(16_384);
    for (const raw of [oneOver, compactOver]) {
      const res = await post(raw);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: "VALIDATION_ERROR", message: "Invalid input", fields: ["body"] },
      });
    }
    expect(await requests(x.conversation.id)).toHaveLength(before);
  });

  it("policy refusals are 422 with a fixed reason and write nothing", async () => {
    const closed = await world(t.db, { lastInboundAt: minutesAgo(30 * 60) });
    const s = await staff(closed.org.id);
    const res = await send(closed.conversation.id, { cookie: s.cookie, body: body() });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { code: "OUTBOUND_REFUSED", message: "This message cannot be sent: window_closed" },
    });
    expect(await requests(closed.conversation.id)).toHaveLength(0);
  });

  it("with outbound disabled (the default) the route refuses with outbound_disabled", async () => {
    vi.stubEnv("WHATSAPP_OUTBOUND_ENABLED", "TRUE");
    try {
      const x = await w();
      const s = await staff(x.org.id);
      const res = await send(x.conversation.id, { cookie: s.cookie, body: body() });
      expect(res.status).toBe(422);
      expect(JSON.stringify(await res.json())).toContain("outbound_disabled");
    } finally {
      vi.stubEnv("WHATSAPP_OUTBOUND_ENABLED", "true");
    }
  });

  it("the route files are thin: only the messaging public API and the shared route helper", () => {
    for (const file of [
      "../../app/api/conversations/[conversationId]/messages/route.ts",
      "../../app/api/outbound-requests/[requestId]/route.ts",
    ]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      const imports = [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
      for (const i of imports)
        expect(
          ["@/modules/messaging", "@/lib/route-helpers", "@/shared/errors/http-errors"],
          i,
        ).toContain(i);
      expect(text).not.toMatch(/fetch\(|@\/db|process\.env|transport/);
    }
  });
});
