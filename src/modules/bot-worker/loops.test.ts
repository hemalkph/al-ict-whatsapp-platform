import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepSummary } from "@/modules/bot-runtime/context";
import type { ClaimedTrigger } from "@/modules/bot-runtime/trigger-queue";
import { runSweepLoop, runTriggerLoop, type LoopTiming } from "./loops";
import { IDLE_MAX_MS, OUTAGE_GIVE_UP_MS, OUTAGE_MAX_MS, SWEEP_INTERVAL_MS } from "./policy";

// The loops with fake work and a fake clock: they decide only WHEN to run again (no database).

const claim = (n: number): ClaimedTrigger =>
  ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` }) as ClaimedTrigger;
const done: StepSummary = {
  kind: "finished",
  status: "PROCESSED",
  outcome: "processed",
  sessionId: null,
};
const pgError = (code: string) => Object.assign(new Error("db"), { code });

describe("bot worker loops", () => {
  let logs: Array<Record<string, unknown>>;
  beforeEach(() => {
    logs = [];
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(
        (line: unknown) => void logs.push(JSON.parse(String(line))),
      );
  });
  afterEach(() => vi.restoreAllMocks());

  /** A timing double: sleep advances a fake clock and aborts after `maxSleeps` sleeps. */
  function timing(stop: AbortController, maxSleeps = 50) {
    let now = 0;
    const sleeps: number[] = [];
    const t: LoopTiming = {
      now: () => now,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
        if (sleeps.length >= maxSleeps) stop.abort();
      },
    };
    return { t, sleeps, advance: (ms: number) => (now += ms) };
  }

  it("claims at most `concurrency` per batch and never runs more T1s in parallel; claims again at once after work", async () => {
    const stop = new AbortController();
    const { t, sleeps } = timing(stop, 3);
    let running = 0;
    let peak = 0;
    let batches = 0;
    const limits: number[] = [];
    const r = await runTriggerLoop(
      {
        ...t,
        concurrency: 3,
        preflight: async () => undefined,
        claim: async (limit) => {
          limits.push(limit);
          return ++batches <= 2
            ? Array.from({ length: limit }, (_, i) => claim(batches * 10 + i))
            : [];
        },
        process: async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((res) => setTimeout(res, 5));
          running--;
          return done;
        },
      },
      stop.signal,
    );
    expect(limits.every((l) => l === 3)).toBe(true);
    expect(peak).toBe(3);
    expect(r.totals).toMatchObject({ claimed: 6, finished: 6 });
    expect(sleeps[0]).toBe(500); // the first EMPTY poll waits; the two working batches did not
    expect(r.exit).toBe("stopped");
  });

  it("idle ladder: 500 ms doubling to the 5 s ceiling", async () => {
    const stop = new AbortController();
    const { t, sleeps } = timing(stop, 7);
    await runTriggerLoop(
      {
        ...t,
        concurrency: 1,
        preflight: async () => undefined,
        claim: async () => [],
        process: async () => done,
      },
      stop.signal,
    );
    expect(sleeps).toEqual([500, 1000, 2000, 4000, IDLE_MAX_MS, IDLE_MAX_MS, IDLE_MAX_MS]);
  });

  it("database trouble backs off (1 s ... 30 s), logs a fixed code, recovers and logs the recovery", async () => {
    const stop = new AbortController();
    const { t, sleeps } = timing(stop, 8);
    let calls = 0;
    await runTriggerLoop(
      {
        ...t,
        concurrency: 1,
        preflight: async () => undefined,
        claim: async () => {
          if (++calls <= 6) throw pgError("ECONNREFUSED");
          return [];
        },
        process: async () => done,
      },
      stop.signal,
    );
    expect(sleeps.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, OUTAGE_MAX_MS]);
    expect(
      logs.filter((l) => l.bots_event === "bots.database_unavailable").map((l) => l.reason),
    ).toEqual(Array(6).fill("econnrefused"));
    expect(logs.find((l) => l.bots_event === "bots.database_recovered")).toMatchObject({
      count: 6,
    });
    // fixed fields only: the log line's message is its event name; no error text, code chain or stack
    for (const l of logs) expect(l.message).toBe(l.bots_event);
    expect(JSON.stringify(logs)).not.toMatch(/stack|"error"|"db"/);
  });

  it("a continuous outage of five minutes is fatal (outage_limit); shorter ones are not", async () => {
    const stop = new AbortController();
    const { t } = timing(stop, 1_000);
    const r = await runTriggerLoop(
      {
        ...t,
        concurrency: 1,
        preflight: async () => undefined,
        claim: async () => Promise.reject(pgError("57P01")),
        process: async () => done,
      },
      stop.signal,
    );
    expect(r.exit).toBe("outage_limit");
    expect(logs.at(-1)).toMatchObject({
      bots_event: "bots.worker_fatal",
      reason: "outage_limit_reached",
    });
    expect(OUTAGE_GIVE_UP_MS).toBe(300_000);
  });

  it("a configuration error stops at once (no retry); a failed preflight is retried, not skipped", async () => {
    const stop = new AbortController();
    const { t } = timing(stop);
    const claimSpy = vi.fn(async () => []);
    const r = await runTriggerLoop(
      {
        ...t,
        concurrency: 1,
        preflight: async () => Promise.reject(pgError("42P01")),
        claim: claimSpy,
        process: async () => done,
      },
      stop.signal,
    );
    expect(r.exit).toBe("configuration");
    expect(claimSpy).not.toHaveBeenCalled(); // nothing is claimed before the preflight passes
    const stop2 = new AbortController();
    const t2 = timing(stop2, 2);
    let n = 0;
    const r2 = await runTriggerLoop(
      {
        ...t2.t,
        concurrency: 1,
        preflight: async () => {
          if (++n === 1) throw pgError("ECONNRESET");
        },
        claim: claimSpy,
        process: async () => done,
      },
      stop2.signal,
    );
    expect(r2.exit).toBe("stopped");
    expect(claimSpy).toHaveBeenCalledTimes(1);
  });

  it("an UNRECORDED T1 failure (T2 failed too) is database trouble; a recorded one is not (T2 is processTrigger's, never repeated here)", async () => {
    const stop = new AbortController();
    const { t } = timing(stop, 2);
    let batch = 0;
    const r = await runTriggerLoop(
      {
        ...t,
        concurrency: 2,
        preflight: async () => undefined,
        claim: async () => (++batch === 1 ? [claim(1), claim(2)] : []),
        process: async (c) =>
          c.id.endsWith("1")
            ? { kind: "failed", errorCode: "serialization_failure", recorded: true }
            : { kind: "failed", errorCode: "connection_lost", recorded: false },
      },
      stop.signal,
    );
    expect(r.totals).toMatchObject({ claimed: 2, failed: 2 });
    expect(logs.find((l) => l.bots_event === "bots.database_unavailable")).toMatchObject({
      reason: "outcome_unrecorded",
    });
  });

  it("a stop during a batch lets the already-claimed triggers finish, then claims nothing more", async () => {
    const stop = new AbortController();
    const { t } = timing(stop);
    const claimed: number[] = [];
    let processed = 0;
    const r = await runTriggerLoop(
      {
        ...t,
        concurrency: 2,
        preflight: async () => undefined,
        claim: async () => {
          claimed.push(1);
          return [claim(1), claim(2)];
        },
        process: async () => {
          stop.abort(); // arrives while T1s are running
          await new Promise((res) => setTimeout(res, 5));
          processed++;
          return done;
        },
      },
      stop.signal,
    );
    expect(claimed).toHaveLength(1);
    expect(processed).toBe(2);
    expect(r.exit).toBe("stopped");
  });

  it("the sweeper never overlaps itself and waits a jittered interval between sweeps", async () => {
    const stop = new AbortController();
    const { t, sleeps } = timing(stop, 4);
    let running = 0;
    let peak = 0;
    const r = await runSweepLoop(
      {
        ...t,
        preflight: async () => undefined,
        sweep: async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((res) => setTimeout(res, 2));
          running--;
          return { terminalized: 1, reconciled: 2, skipped: 0, failed: 0, overdueConversations: 0 };
        },
      },
      stop.signal,
    );
    expect(peak).toBe(1);
    expect(sleeps).toEqual(Array(4).fill(SWEEP_INTERVAL_MS)); // random 0.5 = no jitter
    expect(r.totals).toEqual({ sweeps: 4, terminalized: 4, reconciled: 8, failed: 0, overdue: 0 });
  });
});
