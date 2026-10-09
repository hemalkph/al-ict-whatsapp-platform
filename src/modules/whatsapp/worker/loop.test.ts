import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchSummary } from "../queue/process";
import type { QueueStats } from "../queue/stats";
import { SchemaNotReadyError } from "./errors";
import { runWorkerLoop, type LoopDeps } from "./loop";
import { OUTAGE_GIVE_UP_MS, STATS_INTERVAL_MS } from "./policy";

// The polling loop with a fake clock and fake batches: when it polls, waits, backs off, gives up and stops. No database.

const batch = (over: Partial<BatchSummary> = {}): BatchSummary => ({
  claimed: 0,
  processed: 0,
  failed: 0,
  dead: 0,
  held: 0,
  ignored: 0,
  leaseLost: 0,
  unrecorded: 0,
  ...over,
});
const STATS: QueueStats = {
  byStatus: {
    PENDING: 1,
    PROCESSING: 0,
    PROCESSED: 5,
    FAILED: 2,
    DEAD: 1,
    UNROUTABLE: 3,
    IGNORED: 4,
  },
  oldestDueAgeSeconds: 7,
  expiredLeases: 0,
};
const downError = () => Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });

describe("worker polling loop", () => {
  const logs: Record<string, unknown>[] = [];
  beforeEach(() => {
    logs.length = 0;
    for (const method of ["log", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation(
        (line: unknown) => void logs.push(JSON.parse(String(line)) as Record<string, unknown>),
      );
  });
  afterEach(() => vi.restoreAllMocks());
  const events = () => logs.map((l) => l.webhook_event);

  /** Scripted harness: each step is a batch, an error, or a function; the clock advances only through sleep(). */
  function harness(
    steps: Array<BatchSummary | Error | (() => BatchSummary | Error)>,
    opts: { stopAfter?: number } = {},
  ) {
    const controller = new AbortController();
    let clock = 1_000_000;
    const sleeps: number[] = [];
    let polls = 0;
    const deps: LoopDeps = {
      processBatch: async () => {
        polls++;
        const next = steps.shift();
        if (next === undefined || (opts.stopAfter !== undefined && polls > opts.stopAfter)) {
          controller.abort();
          return batch();
        }
        const step = typeof next === "function" ? next() : next;
        if (step instanceof Error) throw step;
        return step;
      },
      preflight: async () => undefined,
      readStats: async () => STATS,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      random: () => 0.5,
    };
    return { controller, deps, sleeps, polls: () => polls, advance: (ms: number) => (clock += ms) };
  }

  it("idle: waits 500 ms, 1 s, 2 s, 4 s, then 5 s while nothing is due", async () => {
    const h = harness(Array.from({ length: 7 }, () => batch()));
    const r = await runWorkerLoop(h.deps, h.controller.signal);
    expect(r.exit).toBe("stopped");
    expect(h.sleeps.slice(0, 7)).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000]);
  });

  it("work: polls again immediately and resets the idle ladder", async () => {
    const h = harness([
      batch(),
      batch(),
      batch({ claimed: 3, processed: 3 }),
      batch({ claimed: 2, processed: 2 }),
      batch(),
    ]);
    await runWorkerLoop(h.deps, h.controller.signal);
    // two empty polls (500, 1000), two busy polls (no wait), then idle restarts at 500
    expect(h.sleeps.slice(0, 3)).toEqual([500, 1000, 500]);
  });

  it("never spins: every poll that finds nothing is followed by a wait", async () => {
    const h = harness(Array.from({ length: 50 }, () => batch()));
    await runWorkerLoop(h.deps, h.controller.signal);
    expect(h.sleeps.length).toBe(51); // 50 scripted polls plus the final one that observed the stop
    expect(h.sleeps.every((ms) => ms >= 400)).toBe(true);
  });

  it("database trouble: backs off 1 s, 2 s, 4 s ..., then logs recovery and returns to normal polling", async () => {
    const h = harness([
      downError(),
      downError(),
      downError(),
      batch({ claimed: 1, processed: 1 }),
      batch(),
    ]);
    const r = await runWorkerLoop(h.deps, h.controller.signal);
    expect(h.sleeps.slice(0, 3)).toEqual([1000, 2000, 4000]);
    expect(events().filter((e) => e === "worker.database_unavailable")).toHaveLength(3);
    expect(events()).toContain("worker.database_recovered");
    expect(logs.find((l) => l.webhook_event === "worker.database_recovered")).toMatchObject({
      consecutive_failures: 3,
    });
    expect(r.totals.processed).toBe(1);
    expect(r.exit).toBe("stopped");
  });

  it("backoff is capped at 30 s", async () => {
    const h = harness(Array.from({ length: 9 }, () => downError()));
    await runWorkerLoop(h.deps, h.controller.signal);
    expect(Math.max(...h.sleeps)).toBeLessThanOrEqual(30_000);
    expect(h.sleeps.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("an outage that lasts past the give-up limit is fatal (non-recoverable exit), after bounded attempts", async () => {
    const h = harness(Array.from({ length: 200 }, () => downError()));
    const r = await runWorkerLoop(h.deps, h.controller.signal);
    expect(r.exit).toBe("outage_limit");
    expect(h.polls()).toBeLessThan(30); // 5 minutes at up to 30 s per wait: bounded, not endless
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(OUTAGE_GIVE_UP_MS - 30_000);
    expect(logs.at(-1)).toMatchObject({
      webhook_event: "worker.fatal",
      reason: "outage_limit_reached",
    });
  });

  it("a recovered outage restarts the give-up clock", async () => {
    const h = harness([
      ...Array.from({ length: 8 }, () => downError()),
      batch({ claimed: 1 }),
      ...Array.from({ length: 8 }, () => downError()),
      batch(),
    ]);
    const r = await runWorkerLoop(h.deps, h.controller.signal);
    expect(r.exit).toBe("stopped");
  });

  it("a configuration error stops at once, without retrying", async () => {
    const h = harness([
      Object.assign(new Error("password authentication failed"), { code: "28P01" }),
      batch(),
    ]);
    const r = await runWorkerLoop(h.deps, h.controller.signal);
    expect(r.exit).toBe("configuration");
    expect(h.polls()).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(logs.find((l) => l.webhook_event === "worker.fatal")).toMatchObject({
      reason: "pg_28p01",
    });
    expect(JSON.stringify(logs)).not.toContain("password authentication");
  });

  it("an unapplied schema found by the preflight stops the worker before it polls", async () => {
    const h = harness([batch({ claimed: 1 })]);
    h.deps.preflight = async () => {
      throw new SchemaNotReadyError();
    };
    const r = await runWorkerLoop(h.deps, h.controller.signal);
    expect(r.exit).toBe("configuration");
    expect(h.polls()).toBe(0);
    expect(logs.find((l) => l.webhook_event === "worker.fatal")).toMatchObject({
      reason: "schema_not_ready",
    });
  });

  it("a preflight that hits a database outage is retried with backoff, and polling starts only after it passes", async () => {
    const h = harness([batch()], { stopAfter: 1 });
    let attempts = 0;
    h.deps.preflight = async () => {
      if (++attempts < 3) throw downError();
    };
    await runWorkerLoop(h.deps, h.controller.signal);
    expect(attempts).toBe(3);
    expect(h.sleeps.slice(0, 2)).toEqual([1000, 2000]);
  });

  it("an unrecorded outcome is treated as database trouble (backoff), not as success", async () => {
    const h = harness([batch({ claimed: 1, unrecorded: 1 }), batch()]);
    await runWorkerLoop(h.deps, h.controller.signal);
    expect(h.sleeps[0]).toBe(1000);
    expect(events()).toContain("worker.database_unavailable");
  });

  it("totals add up every batch", async () => {
    const h = harness([
      batch({ claimed: 5, processed: 3, failed: 1, dead: 1 }),
      batch({ claimed: 2, held: 1, ignored: 1 }),
    ]);
    const r = await runWorkerLoop(h.deps, h.controller.signal);
    expect(r.totals).toMatchObject({
      claimed: 7,
      processed: 3,
      failed: 1,
      dead: 1,
      held: 1,
      ignored: 1,
    });
  });

  it("stops claiming once the signal is aborted: no batch starts afterwards", async () => {
    const h = harness([batch({ claimed: 1 }), batch({ claimed: 1 }), batch({ claimed: 1 })]);
    h.controller.abort();
    const r = await runWorkerLoop(h.deps, h.controller.signal);
    expect(r.exit).toBe("stopped");
    expect(h.polls()).toBe(0);
  });

  it("a signal during a batch lets that batch finish and starts no further one", async () => {
    const h = harness([
      () => {
        h.controller.abort();
        return batch({ claimed: 2, processed: 2 });
      },
      batch({ claimed: 9 }),
    ]);
    const r = await runWorkerLoop(h.deps, h.controller.signal);
    expect(h.polls()).toBe(1);
    expect(r.totals.processed).toBe(2);
  });

  it("logs a queue-depth heartbeat at start and then at most once per interval", async () => {
    const h = harness([batch(), batch(), batch(), batch()]);
    h.deps.sleep = async (ms) => {
      h.advance(ms + STATS_INTERVAL_MS / 2);
    };
    await runWorkerLoop(h.deps, h.controller.signal);
    const stats = logs.filter((l) => l.webhook_event === "worker.stats");
    expect(stats.length).toBeGreaterThanOrEqual(2);
    expect(stats.length).toBeLessThanOrEqual(3);
    expect(stats[0]).toMatchObject({
      count_pending: 1,
      count_failed: 2,
      count_dead: 1,
      count_held: 3,
      count_ignored: 4,
      count_expired_leases: 0,
      oldest_due_seconds: 7,
    });
  });

  it("a failing gauge read never fails the loop", async () => {
    const h = harness([batch()]);
    h.deps.readStats = async () => {
      throw new Error("stats broke");
    };
    const r = await runWorkerLoop(h.deps, h.controller.signal);
    expect(r.exit).toBe("stopped");
  });
});
