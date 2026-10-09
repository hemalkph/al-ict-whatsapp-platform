import { emitWebhookLog } from "../logging";
import type { BatchSummary } from "../queue/process";
import type { QueueStats } from "../queue/stats";
import { classifyLoopError } from "./errors";
import { OUTAGE_GIVE_UP_MS, STATS_INTERVAL_MS, idleDelayMs, outageDelayMs } from "./policy";

// The polling loop. It decides ONLY when to poll again; every event decision (claim, account gate, handler, retry,
// dead-letter) is the queue's (../queue/process.ts). Three situations are told apart:
//   no work             -> the idle ladder (500 ms ... 5 s), reset as soon as work appears
//   database trouble    -> bounded exponential backoff (1 s ... 30 s); recovery is logged; fatal after 5 minutes
//   configuration error -> stop at once (waiting cannot fix a wrong password, a missing database or unapplied migrations)
// An event's own failure never reaches here: the queue records it on the event and the batch simply continues.

export type LoopDeps = {
  /** One bounded batch. Must stop claiming once the stop signal aborts. */
  processBatch: () => Promise<BatchSummary>;
  /** Runs before the first poll and again never; a thrown error is classified like any other. */
  preflight: () => Promise<void>;
  readStats: () => Promise<QueueStats>;
  /** Resolves after `ms`, or immediately once the signal aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  random: () => number;
};

export type LoopResult = {
  exit: "stopped" | "configuration" | "outage_limit";
  totals: BatchSummary;
};

const zero = (): BatchSummary => ({
  claimed: 0,
  processed: 0,
  failed: 0,
  dead: 0,
  held: 0,
  ignored: 0,
  leaseLost: 0,
  unrecorded: 0,
});

export async function runWorkerLoop(deps: LoopDeps, signal: AbortSignal): Promise<LoopResult> {
  const totals = zero();
  let ready = false;
  let emptyPolls = 0;
  let failures = 0;
  let outageStartedAt: number | null = null;
  let nextStatsAt = deps.now();

  const heartbeat = async () => {
    if (deps.now() < nextStatsAt) return;
    nextStatsAt = deps.now() + STATS_INTERVAL_MS;
    try {
      const s = await deps.readStats();
      emitWebhookLog({
        event: "worker.stats",
        outcome: "success",
        counts: {
          pending: s.byStatus.PENDING,
          processing: s.byStatus.PROCESSING,
          failed: s.byStatus.FAILED,
          dead: s.byStatus.DEAD,
          held: s.byStatus.UNROUTABLE,
          ignored: s.byStatus.IGNORED,
          expiredLeases: s.expiredLeases,
          oldestDueSeconds: s.oldestDueAgeSeconds ?? 0,
        },
      });
    } catch {
      // a gauge that cannot be read is not a failure of the loop: the next batch classifies database trouble
    }
  };

  while (!signal.aborted) {
    try {
      if (!ready) {
        await deps.preflight();
        ready = true;
      }
      await heartbeat();
      const summary = await deps.processBatch();
      for (const key of Object.keys(totals) as (keyof BatchSummary)[]) totals[key] += summary[key];
      // An outcome that could not be recorded means the database is struggling; the lease expiry recovers the event.
      if (summary.unrecorded > 0) throw new Error("outcome_unrecorded");
      if (failures > 0) {
        emitWebhookLog({
          event: "worker.database_recovered",
          outcome: "success",
          counts: { consecutiveFailures: failures },
        });
        failures = 0;
        outageStartedAt = null;
      }
      if (summary.claimed === 0) {
        emptyPolls++;
        await deps.sleep(idleDelayMs(emptyPolls, deps.random), signal);
      } else {
        emptyPolls = 0; // there may be more: poll again immediately (every poll that finds work is real work)
      }
    } catch (error) {
      const failure = classifyLoopError(error);
      if (failure.kind === "configuration") {
        emitWebhookLog({ event: "worker.fatal", outcome: "failure", reason: failure.code });
        return { exit: "configuration", totals };
      }
      failures++;
      outageStartedAt ??= deps.now();
      if (deps.now() - outageStartedAt >= OUTAGE_GIVE_UP_MS) {
        emitWebhookLog({
          event: "worker.fatal",
          outcome: "failure",
          reason: "outage_limit_reached",
          counts: { consecutiveFailures: failures },
        });
        return { exit: "outage_limit", totals };
      }
      emitWebhookLog({
        event: "worker.database_unavailable",
        outcome: "failure",
        reason: failure.code,
        counts: { consecutiveFailures: failures },
      });
      await deps.sleep(outageDelayMs(failures, deps.random), signal);
    }
  }
  return { exit: "stopped", totals };
}
