import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { dispatchBatch } from "./dispatch";
import { submitOutboundMessage } from "./submit";
import { FakeTransport, ON, minutesAgo, textInput, world } from "./testing";
import {
  EXIT_FATAL,
  EXIT_REFUSED,
  EXIT_STOPPED,
  idleDelay,
  outageDelay,
  readWorkerConfig,
  runOutboundWorker,
} from "./worker";

// The outbound worker loop, in-process, on real PostgreSQL, with a FAKE transport. Nothing here can reach Meta.

const BOTH = { WHATSAPP_OUTBOUND_ENABLED: "true", WHATSAPP_LIVE_SEND_ENABLED: "true" };

describe("outbound worker", () => {
  let t: TestDb;
  const running: Array<{ controller: AbortController; done: Promise<number> }> = [];
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await t.pool.query("delete from outbound_requests"); // the worker drains the WHOLE queue: start every test from an empty one
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    for (const r of running.splice(0)) {
      r.controller.abort();
      await r.done;
    }
    vi.restoreAllMocks();
  });

  const until = async (check: () => Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error("condition not reached in time");
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  const queue = async (x: Awaited<ReturnType<typeof world>>, body = "hi", key?: string) =>
    submitOutboundMessage(x.actor.ctx, textInput(x.conversation.id, body, key), {
      db: t.db as never,
      config: ON,
    });
  const state = async (id: string) =>
    (await t.pool.query("select state, attempt_count from outbound_requests where id = $1", [id]))
      .rows[0];

  function start(
    transport: FakeTransport,
    o: { env?: Record<string, string | undefined>; shutdownGraceMs?: number } = {},
  ) {
    const controller = new AbortController();
    const printed: string[] = [];
    const done = runOutboundWorker({
      env: { DATABASE_URL: t.url, ...BOTH, ...o.env },
      signal: controller.signal,
      transport,
      injectedTransport: true,
      print: (m) => void printed.push(m),
      createDatabase: () => ({ db: t.db as never, close: async () => undefined }),
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(ms, 20));
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }),
      shutdownGraceMs: o.shutdownGraceMs,
    });
    const handle = { controller, done, printed, stop: () => (controller.abort(), done) };
    running.push(handle);
    return handle;
  }

  describe("disabled by default", () => {
    it.each([
      ["nothing set", {}],
      ["only the outbound gate", { WHATSAPP_OUTBOUND_ENABLED: "true" }],
      ["only the live gate", { WHATSAPP_LIVE_SEND_ENABLED: "true" }],
      [
        "gates not exactly 'true'",
        { WHATSAPP_OUTBOUND_ENABLED: "TRUE", WHATSAPP_LIVE_SEND_ENABLED: "1" },
      ],
    ])(
      "%s: the real worker refuses to start, opens no database and claims nothing",
      async (_n, env) => {
        const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
        const r = await queue(x);
        const createDatabase = vi.fn();
        const printed: string[] = [];
        const code = await runOutboundWorker({
          env: { DATABASE_URL: t.url, ...env },
          signal: new AbortController().signal,
          transport: new FakeTransport(),
          createDatabase,
          print: (m) => void printed.push(m),
        });
        expect(code).toBe(EXIT_REFUSED);
        expect(createDatabase).not.toHaveBeenCalled();
        expect(printed.join(" ")).toMatch(/did not start/);
        expect(await state(r.requestId)).toEqual({ state: "QUEUED", attempt_count: 0 });
      },
    );

    it("configuration problems name keys, never values", () => {
      const r = readWorkerConfig(
        {
          DATABASE_URL: "postgresql://u:SECRETPW@h/db",
          WHATSAPP_OUTBOUND_ENABLED: "true",
          WHATSAPP_OUTBOUND_BATCH_SIZE: "SECRETVALUE",
        },
        true,
      );
      expect(r.kind).toBe("refused");
      expect(JSON.stringify(r)).not.toMatch(/SECRETPW|SECRETVALUE/);
    });

    it("a bad connection string or limits are refused", () => {
      for (const env of [
        { DATABASE_URL: "mysql://x/y" },
        { DATABASE_URL: "postgresql://h/db", WHATSAPP_OUTBOUND_CONCURRENCY: "9" },
        { DATABASE_URL: "postgresql://h/db", WHATSAPP_OUTBOUND_BATCH_SIZE: "0" },
      ])
        expect(readWorkerConfig({ ...BOTH, ...env }, true).kind).toBe("refused");
      expect(readWorkerConfig({ ...BOTH, DATABASE_URL: "postgresql://h/db" }, true).kind).toBe(
        "ready",
      );
    });

    it("dispatching with the outbound gate off claims nothing even if called directly", async () => {
      const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
      const r = await queue(x);
      const transport = new FakeTransport();
      await dispatchBatch(
        { db: t.db as never, transport, config: { ...ON, outboundEnabled: false } },
        {},
      );
      expect(transport.calls).toHaveLength(0);
      expect((await state(r.requestId)).state).toBe("QUEUED");
    });
  });

  describe("running", () => {
    it("sends queued requests once, then stops cleanly on the signal", async () => {
      const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
      const ids = await Promise.all([
        queue(x, "a", "worker-key-0001"),
        queue(x, "b", "worker-key-0002"),
        queue(x, "c", "worker-key-0003"),
      ]);
      const transport = new FakeTransport().acceptAll();
      // the default pacing of 1 request per second per account applies: relax it through the database clock
      const w = start(transport);
      await until(
        async () =>
          (await t.pool.query("select 1 from outbound_requests where state = 'ACCEPTED'"))
            .rowCount === 3,
        15_000,
      );
      expect(await w.stop()).toBe(EXIT_STOPPED);
      expect(transport.calls).toHaveLength(3);
      for (const id of ids) expect((await state(id.requestId)).attempt_count).toBe(1);
    }, 30_000);

    it("a request in flight when the stop signal arrives finishes; nothing further is claimed", async () => {
      const x = await w2();
      async function w2() {
        const y = await world(t.db, { lastInboundAt: minutesAgo(5) });
        return y;
      }
      const a = await queue(x, "first", "stop-key-00001");
      const b = await queue(x, "second", "stop-key-00002");
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inFlight = new Promise<void>((resolve) => (entered = resolve));
      const transport = new FakeTransport().next(async () => {
        entered();
        await held;
        return { kind: "accepted", wamid: "wamid.SLOWONE", providerStatus: null, httpStatus: 200 };
      });
      transport.acceptAll();
      const w = start(transport, { env: { WHATSAPP_OUTBOUND_CONCURRENCY: "1" } });
      await inFlight;
      w.controller.abort();
      await new Promise((r) => setTimeout(r, 100));
      release();
      expect(await w.done).toBe(EXIT_STOPPED);
      const states = [await state(a.requestId), await state(b.requestId)]
        .map((s) => s.state)
        .sort();
      expect(states).toEqual(["ACCEPTED", "QUEUED"]);
      expect(transport.calls).toHaveLength(1);
    });

    it("past the shutdown grace period the worker gives up (non-zero); the stuck send stays SENDING and is NEVER re-sent", async () => {
      const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
      const r = await queue(x);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inFlight = new Promise<void>((resolve) => (entered = resolve));
      const transport = new FakeTransport().next(async () => {
        entered();
        await held;
        return { kind: "unknown", reason: "send_deadline", httpStatus: null };
      });
      const w = start(transport, { shutdownGraceMs: 100 });
      await inFlight;
      w.controller.abort();
      expect(await w.done).toBe(EXIT_FATAL);
      expect((await state(r.requestId)).state).toBe("SENDING");
      release();
      await until(async () => (await state(r.requestId)).state === "UNKNOWN_OUTCOME");
      // a fresh worker run does not send it again
      const second = new FakeTransport().acceptAll();
      const w2h = start(second);
      await new Promise((res) => setTimeout(res, 200));
      await w2h.stop();
      expect(second.calls).toHaveLength(0);
    });

    it("never runs more sends at once than the configured concurrency", async () => {
      // six accounts, so the per-account pacing does not serialize them: concurrency is what limits the sends
      const worlds = await Promise.all(
        Array.from({ length: 6 }, () => world(t.db, { lastInboundAt: minutesAgo(5) })),
      );
      for (const [i, x] of worlds.entries()) await queue(x, "x", `acct-key-0000${i}`);
      let live = 0;
      let peak = 0;
      let n = 0;
      const transport = new FakeTransport();
      transport.fallback = async () => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 60));
        live--;
        return {
          kind: "accepted",
          wamid: `wamid.CONC${++n}`,
          providerStatus: null,
          httpStatus: 200,
        };
      };
      const w = start(transport, { env: { WHATSAPP_OUTBOUND_CONCURRENCY: "2" } });
      await until(
        async () =>
          (await t.pool.query("select 1 from outbound_requests where state = 'ACCEPTED'"))
            .rowCount === 6,
        20_000,
      );
      await w.stop();
      expect(peak).toBe(2);
    }, 30_000);
  });

  it("an unmigrated database makes the worker stop with a configuration exit and send nothing", async () => {
    const bare = await createTestDatabase({ migrate: false });
    try {
      const transport = new FakeTransport().acceptAll();
      const controller = new AbortController();
      const code = await runOutboundWorker({
        env: { DATABASE_URL: bare.url, ...BOTH },
        signal: controller.signal,
        transport,
        injectedTransport: true,
        createDatabase: () => ({ db: bare.db as never, close: async () => undefined }),
        sleep: async () => undefined,
      });
      expect(code).toBe(EXIT_REFUSED);
      expect(transport.calls).toHaveLength(0);
      expect(
        (
          await bare.pool.query(
            "select count(*)::int n from information_schema.tables where table_schema = 'public'",
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await bare.close();
    }
  });

  it("idle and outage waits are bounded ladders", () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 9].map((n) => idleDelay(n, mid))).toEqual([
      500, 1000, 2000, 4000, 5000, 5000,
    ]);
    expect([1, 2, 6, 20].map((n) => outageDelay(n, mid))).toEqual([1000, 2000, 30000, 30000]);
  });
});
