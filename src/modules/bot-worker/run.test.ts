import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerDatabase } from "@/db";
import { classifyLoopError, WorkerPreflightError } from "./errors";
import { EXPECTED, type SchemaFacts } from "./schema";
import { EXIT_FATAL, EXIT_REFUSED, EXIT_STOPPED, preflight, runBotWorker } from "./run";

// runBotWorker without a database: refusal happens before any connection; configuration failures stop; a stuck shutdown
// exits non-zero after the grace period. (The real pool and loops are exercised in worker.db.test.ts.)

const goodFacts = (): SchemaFacts => ({
  columns: EXPECTED.columns.map((c) => ({ ...c })),
  triggers: EXPECTED.triggers.map((t) => ({
    name: t.name,
    table: t.table,
    enabled: "O",
    tgtype: 7,
    fnSchema: "public",
    fn: t.fn,
    fnArgs: "",
  })),
  indexes: EXPECTED.indexes.map((i) => ({
    name: i.name,
    table: "outbound_requests",
    unique: true,
    valid: true,
    ready: true,
    expressions: false,
    columns: [...i.columns],
    truth: { ...i.truth },
  })),
  constraints: [
    {
      name: EXPECTED.constraint.name,
      table: "outbound_requests",
      type: "c",
      validated: true,
      truth: { ...EXPECTED.constraint.truth },
    },
  ],
  functions: EXPECTED.functions.map((f) => ({ ...f })),
});
const facts = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./schema", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./schema")>();
  return { ...orig, readSchemaFacts: async () => facts.current as SchemaFacts };
});

const URL_ = "postgres://worker:SECRETPW@127.0.0.1:55432/al_ict_test_x";
const ON = { BOTS_RUNTIME_ENABLED: "true", WHATSAPP_OUTBOUND_ENABLED: "true", DATABASE_URL: URL_ };

describe("runBotWorker", () => {
  beforeEach(() => {
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("refuses before creating a database for every non-exact gate value; the message names keys, never values", async () => {
    for (const env of [
      {},
      { ...ON, BOTS_RUNTIME_ENABLED: "TRUE" },
      { ...ON, WHATSAPP_OUTBOUND_ENABLED: "1" },
      { ...ON, BOTS_RUNTIME_ENABLED: "yes", WHATSAPP_OUTBOUND_ENABLED: "on" },
      { ...ON, BOTS_RUNTIME_ENABLED: "" },
      { ...ON, DATABASE_URL: "nope" },
      { ...ON, BOTS_WORKER_CONCURRENCY: "99" },
    ]) {
      const createDatabase = vi.fn();
      const printed: string[] = [];
      const code = await runBotWorker({
        env,
        signal: new AbortController().signal,
        print: (m) => void printed.push(m),
        createDatabase,
      });
      expect(code).toBe(EXIT_REFUSED);
      expect(createDatabase).not.toHaveBeenCalled();
      expect(printed.join(" ")).toMatch(/Nothing was claimed or changed/);
      expect(printed.join(" ")).not.toContain("SECRETPW");
    }
  });

  /** A database double whose every statement fails with `error` (or never answers). */
  function fakeDb(behaviour: "configuration" | "hang") {
    const close = vi.fn(async () => undefined);
    const execute = vi.fn(() =>
      behaviour === "configuration"
        ? Promise.reject(Object.assign(new Error("relation does not exist"), { code: "42P01" }))
        : new Promise(() => undefined),
    );
    const db = { execute, transaction: execute } as unknown as WorkerDatabase["db"];
    return { database: { db, close }, close, execute };
  }

  it("a configuration failure at preflight stops both loops at once (exit refused) and closes the pool; nothing is claimed", async () => {
    const f = fakeDb("configuration");
    const code = await runBotWorker({
      env: ON,
      signal: new AbortController().signal,
      createDatabase: () => f.database,
      shutdownGraceMs: 2_000,
    });
    expect(code).toBe(EXIT_REFUSED);
    expect(f.close).toHaveBeenCalledTimes(1);
    // only preflight SELECTs were attempted
    for (const [q] of f.execute.mock.calls as unknown as Array<[{ queryChunks?: unknown }]>)
      expect(JSON.stringify(q)).not.toMatch(/bot_triggers t\s+SET|UPDATE/);
  });

  it("a shutdown that cannot complete within the grace period exits non-zero (the server rolls back; leases recover claims)", async () => {
    const f = fakeDb("hang");
    const stop = new AbortController();
    const running = runBotWorker({
      env: ON,
      signal: stop.signal,
      createDatabase: () => f.database,
      shutdownGraceMs: 50,
    });
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    expect(await running).toBe(EXIT_FATAL);
    expect(f.close).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------------------- shutdown (review P2)
  /**
   * A database double: every statement fails as "database unavailable" (after `workMs`), so the loops stay in their outage
   * backoff and settle as soon as they are stopped; `close` behaves as asked.
   */
  function unavailableDb(close: "ok" | "reject" | "hang", workMs = 0) {
    const calls: number[] = [];
    const execute = vi.fn(async () => {
      calls.push(Date.now());
      if (workMs) await new Promise((r) => setTimeout(r, workMs));
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    const closeFn = vi.fn(() =>
      close === "ok"
        ? Promise.resolve()
        : close === "reject"
          ? Promise.reject(new Error("close failed"))
          : new Promise<void>(() => undefined),
    );
    const db = { execute, transaction: execute } as unknown as WorkerDatabase["db"];
    return { database: { db, close: closeFn }, close: closeFn, calls };
  }
  const logEvents = () =>
    (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .concat((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls)
      .concat((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls)
      .concat((console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls)
      .map((c) => {
        try {
          return JSON.parse(String(c[0])) as {
            bots_event?: string;
            reason?: string;
            outcome?: string;
          };
        } catch {
          return {};
        }
      });
  const stopAfter = (ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  };

  it("A: the loops settle and the pool closes: exit 0 and a successful stop", async () => {
    const f = unavailableDb("ok");
    expect(
      await runBotWorker({
        env: ON,
        signal: stopAfter(30),
        createDatabase: () => f.database,
        shutdownGraceMs: 2_000,
      }),
    ).toBe(EXIT_STOPPED);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(logEvents().find((e) => e.bots_event === "bots.worker_stopped")).toMatchObject({
      outcome: "success",
    });
  });

  it("B: the pool close REJECTS: a non-zero exit and no successful-stop log", async () => {
    const f = unavailableDb("reject");
    expect(
      await runBotWorker({
        env: ON,
        signal: stopAfter(30),
        createDatabase: () => f.database,
        shutdownGraceMs: 2_000,
      }),
    ).toBe(EXIT_FATAL);
    expect(logEvents().find((e) => e.bots_event === "bots.worker_fatal")).toMatchObject({
      reason: "pool_close_failed",
    });
    expect(logEvents().filter((e) => e.bots_event === "bots.worker_stopped")).toEqual([]);
  });

  it("C: the pool close NEVER settles: the one shutdown deadline still ends the run non-zero, on time", async () => {
    const f = unavailableDb("hang");
    const started = Date.now();
    expect(
      await runBotWorker({
        env: ON,
        signal: stopAfter(30),
        createDatabase: () => f.database,
        shutdownGraceMs: 150,
      }),
    ).toBe(EXIT_FATAL);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(logEvents().find((e) => e.bots_event === "bots.worker_fatal")).toMatchObject({
      reason: "shutdown_deadline",
    });
    expect(f.close).toHaveBeenCalledTimes(1); // started once, never a second end() on the same pool
  });

  it("D: a stop while work is in flight: the started work settles, NO new work starts after the stop, then a clean exit", async () => {
    const f = unavailableDb("ok", 60);
    const c = new AbortController();
    const running = runBotWorker({
      env: ON,
      signal: c.signal,
      createDatabase: () => f.database,
      shutdownGraceMs: 2_000,
    });
    await new Promise((r) => setTimeout(r, 20)); // both loops are inside a 60 ms statement
    const stoppedAt = Date.now();
    c.abort();
    expect(await running).toBe(EXIT_STOPPED);
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.calls.filter((at) => at > stoppedAt)).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------- preflight branches
  /** A double that answers the preflight's statements in order with the given rows. */
  const sequenced = (...answers: unknown[][]) => {
    let i = 0;
    return { execute: vi.fn(async () => ({ rows: answers[i++] ?? [] })) } as unknown as Parameters<
      typeof preflight
    >[0];
  };
  const SETTINGS = [
    {
      transaction_timeout: "25s",
      idle_in_transaction_session_timeout: "10s",
      statement_timeout: "15s",
    },
  ];

  it("preflight: PostgreSQL below 17, settings not in force, missing tables, incompatible 0008 objects each refuse; all present passes", async () => {
    await expect(preflight(sequenced([{ v: 160_004 }]))).rejects.toMatchObject({
      code: "server_version_unsupported",
    });
    await expect(
      preflight(sequenced([{ v: 170_002 }], [{ ...SETTINGS[0], transaction_timeout: "0" }])),
    ).rejects.toMatchObject({ code: "session_settings_not_applied" });
    await expect(
      preflight(sequenced([{ v: 170_002 }], SETTINGS, [{ missing: 2 }])),
    ).rejects.toMatchObject({
      code: "schema_not_ready",
    });
    // the 0008 objects come from the catalog (stubbed here; judged by the real schemaProblems)
    facts.current = { ...goodFacts(), triggers: goodFacts().triggers.slice(1) };
    await expect(
      preflight(sequenced([{ v: 170_002 }], SETTINGS, [{ missing: 0 }])),
    ).rejects.toBeInstanceOf(WorkerPreflightError);
    facts.current = goodFacts();
    await expect(
      preflight(sequenced([{ v: 170_002 }], SETTINGS, [{ missing: 0 }])),
    ).resolves.toBeUndefined();
  });

  it("a startup setting the server does not know (42704, e.g. transaction_timeout below 17) is a configuration error, not an outage", () => {
    expect(
      classifyLoopError(
        Object.assign(new Error("unrecognized configuration parameter"), { code: "42704" }),
      ),
    ).toEqual({
      kind: "configuration",
      code: "db_42704",
    });
  });
});
