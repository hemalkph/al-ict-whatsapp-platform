import { emitBotRuntimeLog } from "@/modules/bot-runtime";
import type { StepSummary } from "@/modules/bot-runtime/context";
import type { SweepSummary } from "@/modules/bot-runtime/reconcile";
import type { ClaimedTrigger } from "@/modules/bot-runtime/trigger-queue";
import { classifyLoopError, UnrecordedOutcomeError } from "./errors";
import { idleDelayMs, OUTAGE_GIVE_UP_MS, outageDelayMs, sweepDelayMs } from "./policy";

// The bot worker's two loops (Phase 08E-7; plan J.1, J.2). They decide ONLY when to run again; every trigger, session and
// request decision belongs to the approved runtime services (T0 claim, T1 processTrigger with its own fenced T2, sweepOnce).
//   no work            -> trigger loop: idle ladder 500 ms ... 5 s (reset by work); sweeper: its jittered interval
//   database trouble   -> backoff 1 s ... 30 s; recovery logged; fatal after five minutes of continuous failure
//   configuration      -> stop at once (waiting cannot fix it)
// A trigger's own failure never reaches here: T1 rolls back and T2 records it. Only an UNRECORDED failure (T2 failed too) is
// treated as database trouble; the claim's lease then recovers the trigger. Nothing here retries a trigger or touches a fence.

export type LoopTiming = {
  /** Resolves after `ms`, or at once when the signal aborts. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
  readonly random: () => number;
};

export type LoopExit = "stopped" | "configuration" | "outage_limit";

/** Runs `iterate` until aborted. `iterate` returns the delay before the next run (0: at once). */
async function pollLoop(
  name: "triggers" | "sweeper",
  iterate: () => Promise<number>,
  t: LoopTiming,
  signal: AbortSignal,
): Promise<LoopExit> {
  let failures = 0;
  let outageStartedAt: number | null = null;
  while (!signal.aborted) {
    let delay: number;
    try {
      delay = await iterate();
      if (failures > 0) {
        emitBotRuntimeLog({
          event: "bots.database_recovered",
          outcome: "success",
          reason: name,
          count: failures,
        });
        failures = 0;
        outageStartedAt = null;
      }
    } catch (error) {
      const failure = classifyLoopError(error);
      if (failure.kind === "configuration") {
        emitBotRuntimeLog({ event: "bots.worker_fatal", outcome: "failure", reason: failure.code });
        return "configuration";
      }
      failures++;
      outageStartedAt ??= t.now();
      if (t.now() - outageStartedAt >= OUTAGE_GIVE_UP_MS) {
        emitBotRuntimeLog({
          event: "bots.worker_fatal",
          outcome: "failure",
          reason: "outage_limit_reached",
          count: failures,
        });
        return "outage_limit";
      }
      emitBotRuntimeLog({
        event: "bots.database_unavailable",
        outcome: "failure",
        reason: failure.code,
        count: failures,
      });
      delay = outageDelayMs(failures, t.random);
    }
    if (delay > 0) await t.sleep(delay, signal);
  }
  return "stopped";
}

export type TriggerTotals = {
  claimed: number;
  finished: number;
  deferred: number;
  failed: number;
  lostClaims: number;
};

export type TriggerLoopDeps = LoopTiming & {
  /** Runs before the first claim; memoized by the caller (a failure is classified and retried). */
  readonly preflight: () => Promise<void>;
  /** T0: claims at most `limit` triggers in its own committed transaction. */
  readonly claim: (limit: number) => Promise<ClaimedTrigger[]>;
  /** T1 (+ its own fenced T2 on failure). Never throws. */
  readonly process: (claim: ClaimedTrigger) => Promise<StepSummary>;
  /** Parallel T1 lanes; a claim batch never exceeds it, so every claim starts T1 at once (the 20 s start guard). */
  readonly concurrency: number;
};

export async function runTriggerLoop(
  deps: TriggerLoopDeps,
  signal: AbortSignal,
): Promise<{ exit: LoopExit; totals: TriggerTotals }> {
  const totals: TriggerTotals = { claimed: 0, finished: 0, deferred: 0, failed: 0, lostClaims: 0 };
  let emptyPolls = 0;
  const exit = await pollLoop(
    "triggers",
    async () => {
      await deps.preflight();
      if (signal.aborted) return 0; // stopped while preflighting: claim nothing
      const claims = await deps.claim(deps.concurrency);
      totals.claimed += claims.length;
      // every claimed trigger runs to its end even if a stop arrives meanwhile: they are already charged and leased
      const results = await Promise.all(claims.map((c) => deps.process(c)));
      let unrecorded = false;
      for (const r of results) {
        if (r.kind === "finished") totals.finished++;
        else if (r.kind === "deferred") totals.deferred++;
        else if (r.kind === "lost_claim") totals.lostClaims++;
        else if (r.kind === "failed") {
          totals.failed++;
          if (!r.recorded) unrecorded = true;
        }
      }
      if (unrecorded) throw new UnrecordedOutcomeError();
      if (claims.length === 0) return idleDelayMs(++emptyPolls, deps.random);
      emptyPolls = 0;
      return 0; // there may be more: claim again at once
    },
    deps,
    signal,
  );
  return { exit, totals };
}

export type SweepTotals = {
  sweeps: number;
  terminalized: number;
  reconciled: number;
  failed: number;
  overdue: number;
};

export type SweepLoopDeps = LoopTiming & {
  readonly preflight: () => Promise<void>;
  /** One sweepOnce: terminalization -> reconciliation -> audit. Each candidate is its own transaction. */
  readonly sweep: () => Promise<SweepSummary>;
};

export async function runSweepLoop(
  deps: SweepLoopDeps,
  signal: AbortSignal,
): Promise<{ exit: LoopExit; totals: SweepTotals }> {
  const totals: SweepTotals = { sweeps: 0, terminalized: 0, reconciled: 0, failed: 0, overdue: 0 };
  const exit = await pollLoop(
    "sweeper",
    async () => {
      await deps.preflight();
      if (signal.aborted) return 0;
      const s = await deps.sweep(); // sequential: a sweep never overlaps the previous one
      totals.sweeps++;
      totals.terminalized += s.terminalized;
      totals.reconciled += s.reconciled;
      totals.failed += s.failed;
      totals.overdue += s.overdueConversations;
      return sweepDelayMs(deps.random);
    },
    deps,
    signal,
  );
  return { exit, totals };
}
