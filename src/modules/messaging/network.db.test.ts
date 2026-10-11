import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { dispatchBatch, recoverStuck, type DispatchDeps } from "./dispatch";
import { MetaTransport, singleAttemptPost } from "./meta-transport";
import { SENDING_RECOVERY_AFTER_MS } from "./policy";
import { submitOutboundMessage } from "./submit";
import { ON, minutesAgo, textInput, world } from "./testing";

// The dispatcher on real PostgreSQL with the REAL single-attempt HTTP implementation talking to a REAL local socket (loopback;
// Meta is never contacted). Includes the reproduced defect: a server that receives the whole POST, answers 421 and then
// stops listening. Whatever the server does, one logical request produces one POST, an uncertain result is UNKNOWN_OUTCOME,
// and neither time nor a restarted dispatcher can send it again.

describe("outbound dispatch over real sockets", () => {
  let t: TestDb;
  let clock: Date;
  const T0 = new Date("2026-06-01T12:00:00Z");
  const servers: http.Server[] = [];
  const sockets = new Set<Socket>();
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await t.pool.query("delete from outbound_requests");
    clock = T0;
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const s of sockets) s.destroy();
    sockets.clear();
    for (const s of servers.splice(0)) s.close();
  });

  type Handler = (
    req: IncomingMessage,
    res: ServerResponse,
    server: http.Server,
  ) => void | Promise<void>;
  async function serve(handler: Handler) {
    const seen = { posts: 0, connections: 0 };
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        seen.posts++;
        void handler(req, res, server);
      });
    });
    server.on("connection", (s) => {
      seen.connections++;
      sockets.add(s);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { seen, port: (server.address() as AddressInfo).port, server };
  }
  const live = {
    WHATSAPP_OUTBOUND_ENABLED: "true",
    WHATSAPP_LIVE_SEND_ENABLED: "true",
    WHATSAPP_GRAPH_API_VERSION: "v25.0",
    WA_TOKEN_TEST: "t".repeat(32),
  };
  const transportTo = (port: number, timeoutMs = 2_000) =>
    new MetaTransport({
      env: () => live,
      post: singleAttemptPost(
        http.request,
        { protocol: "http:", hostname: "127.0.0.1", port },
        { timeoutMs, maxBytes: 64 * 1024 },
      ),
    });
  const deps = (transport: MetaTransport, over: Partial<DispatchDeps> = {}): DispatchDeps => ({
    db: t.db as never,
    transport,
    config: ON,
    now: () => clock,
    random: () => 0.5,
    accountMinIntervalMs: 0,
    conversationMinIntervalMs: 0,
    ...over,
  });
  const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
  const run = (transport: MetaTransport, over: Partial<DispatchDeps> = {}) =>
    dispatchBatch(deps(transport, over), { batchSize: 10, concurrency: 1 });
  const row = async (id: string) =>
    (await t.pool.query("select * from outbound_requests where id = $1", [id])).rows[0];
  const setup = async () => {
    const x = await world(t.db, { lastInboundAt: minutesAgo(30, T0) });
    const r = await submitOutboundMessage(x.actor.ctx, textInput(x.conversation.id, "Hello"), {
      db: t.db as never,
      config: ON,
      now: () => clock,
    });
    advance(5_000);
    return { x, r };
  };
  const noDuplicates = async (x: Awaited<ReturnType<typeof setup>>["x"], requestId: string) => {
    expect(
      (
        await t.pool.query("select 1 from outbound_requests where conversation_id = $1", [
          x.conversation.id,
        ])
      ).rowCount,
    ).toBe(1);
    const messages = await t.pool.query(
      "select wamid from messages where conversation_id = $1 and direction = 'OUTBOUND'",
      [x.conversation.id],
    );
    expect(messages.rows).toEqual([{ wamid: null }]); // one logical message, no provider id invented
    expect((await row(requestId)).message_id).toBeTruthy();
  };
  const restartAndWait = async (
    port: number,
    requestId: string,
    server: { seen: { posts: number; connections: number } },
    posts: number,
  ) => {
    for (let i = 0; i < 3; i++) {
      advance(60 * 60_000);
      await run(transportTo(port), { newOwner: () => randomUUID() }); // a brand-new dispatcher and transport each time
    }
    advance(SENDING_RECOVERY_AFTER_MS + 1);
    expect(await recoverStuck(deps(transportTo(port)))).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.seen.posts).toBe(posts);
    expect(server.seen.connections).toBe(posts);
    expect((await row(requestId)).state).toBe("UNKNOWN_OUTCOME");
  };

  it("THE REPRODUCED DEFECT: 421 after a complete POST, listener gone: one POST, UNKNOWN_OUTCOME, SENDING was committed before the HTTP request, nothing is resent after a restart", async () => {
    const { x, r } = await setup();
    let duringHttp:
      { state: string; send_started_at: Date | null; claimed_by: string | null } | undefined;
    const server = await serve(async (_req, res, s) => {
      duringHttp = (
        await t.pool.query(
          "select state, send_started_at, claimed_by from outbound_requests where id = $1",
          [r.requestId],
        )
      ).rows[0];
      res.writeHead(421, { "content-type": "application/json" });
      res.end("{}");
      s.close();
    });
    const summary = await run(transportTo(server.port));
    expect(summary).toMatchObject({ claimed: 1, unknown: 1, accepted: 0, retryScheduled: 0 });
    // SENDING (with its start time and owner) was already durable while the request was in flight
    expect(duringHttp).toMatchObject({ state: "SENDING", claimed_by: expect.any(String) });
    expect(duringHttp!.send_started_at).toEqual(clock);
    expect(server.seen).toEqual({ posts: 1, connections: 1 });
    expect(await row(r.requestId)).toMatchObject({
      state: "UNKNOWN_OUTCOME",
      attempt_count: 1,
      provider_http_status: 421,
      failure_code: "unrecognized_client_error",
    });
    await restartAndWait(server.port, r.requestId, server, 1);
    await noDuplicates(x, r.requestId);
  });

  it.each([
    [
      "a connection reset after the request was received",
      (_req: IncomingMessage, res: ServerResponse) => void res.socket?.destroy(),
      2_000,
    ],
    ["no answer before the deadline", () => undefined, 300],
    [
      "an HTTP 500",
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(500);
        res.end("{}");
      },
      2_000,
    ],
    [
      "an HTTP 307 redirect",
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(307, { location: "/x" });
        res.end();
      },
      2_000,
    ],
    [
      "an HTTP 308 redirect",
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(308, { location: "/x" });
        res.end();
      },
      2_000,
    ],
    [
      "an HTTP 429 (documented rate code)",
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(429, { "content-type": "application/json" });
        res.end('{"error":{"code":130429}}');
      },
      2_000,
    ],
    [
      "a malformed success response",
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200);
        res.end("<html>");
      },
      2_000,
    ],
  ])(
    "%s: one POST, UNKNOWN_OUTCOME, no later transition, no resend after a restart",
    async (_name, handler, timeoutMs) => {
      const { x, r } = await setup();
      const server = await serve(handler);
      const summary = await run(transportTo(server.port, timeoutMs));
      expect(summary).toMatchObject({ claimed: 1, unknown: 1, retryScheduled: 0, accepted: 0 });
      expect(server.seen.posts).toBe(1);
      await restartAndWait(server.port, r.requestId, server, 1);
      await noDuplicates(x, r.requestId);
    },
  );

  it("connection refused: UNKNOWN_OUTCOME after one attempt, and no later attempt after a restart", async () => {
    const { x, r } = await setup();
    const server = await serve(() => undefined);
    await new Promise<void>((resolve) => server.server.close(() => resolve()));
    const summary = await run(transportTo(server.port));
    expect(summary).toMatchObject({ claimed: 1, unknown: 1, retryScheduled: 0 });
    expect(await row(r.requestId)).toMatchObject({
      state: "UNKNOWN_OUTCOME",
      failure_code: "transport_network",
      attempt_count: 1,
    });
    for (let i = 0; i < 3; i++) {
      advance(60 * 60_000);
      await run(transportTo(server.port));
    }
    expect((await row(r.requestId)).state).toBe("UNKNOWN_OUTCOME");
    expect((await row(r.requestId)).attempt_count).toBe(1);
    await noDuplicates(x, r.requestId);
  });

  it("a fake transport that claims 'not sent' after its HTTP attempt began cannot cause a retry", async () => {
    const { r } = await setup();
    let calls = 0;
    const lying = {
      send: async (_req: unknown, _signal: AbortSignal, hooks?: { httpStarted(): void }) => {
        calls++;
        hooks?.httpStarted(); // the attempt began...
        return { kind: "not_sent", reason: "connect_failed_econnrefused" } as const; // ...and the transport claims it proved nothing was sent
      },
    };
    await dispatchBatch(
      { ...deps(transportTo(1)), transport: lying },
      { batchSize: 5, concurrency: 1 },
    );
    advance(60 * 60_000);
    await dispatchBatch(
      { ...deps(transportTo(1)), transport: lying },
      { batchSize: 5, concurrency: 1 },
    );
    expect(calls).toBe(1);
    expect(await row(r.requestId)).toMatchObject({
      state: "UNKNOWN_OUTCOME",
      failure_code: "result_after_http_started",
    });
  });

  it("a genuine pre-flight refusal (the transport never began an HTTP attempt) still takes the bounded retry path", async () => {
    const { r } = await setup();
    const server = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"messages":[{"id":"wamid.PREFLIGHT"}]}');
    });
    const env: Record<string, string | undefined> = { ...live, WA_TOKEN_TEST: undefined };
    const transport = new MetaTransport({
      env: () => env,
      post: singleAttemptPost(http.request, {
        protocol: "http:",
        hostname: "127.0.0.1",
        port: server.port,
      }),
    });
    await run(transport);
    expect(server.seen.posts).toBe(0);
    expect((await row(r.requestId)).state).toBe("QUEUED");
    env.WA_TOKEN_TEST = "t".repeat(32);
    advance(10 * 60_000);
    await run(transport);
    expect(server.seen.posts).toBe(1);
    expect(await row(r.requestId)).toMatchObject({ state: "ACCEPTED", attempt_count: 2 });
  });
});
