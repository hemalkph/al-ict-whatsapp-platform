import { RUNTIME_POLICY } from "@/modules/bot-runtime";

// Bot worker PROCESS timing and pool settings (Phase 08E-7; plan J.1, J.6). Pure: no clock, no timers, no randomness of its own.
// Leases, guards, budgets and retry ladders of the trigger queue are the runtime's (RUNTIME_POLICY) and are only referenced.
// The loop pattern (idle ladder, outage backoff, fatal after five minutes) is the WhatsApp worker's, copied rather than
// imported: that worker's policy is bound to its webhook queue (plan J.1 allowed either).

/** Idle polling of the trigger loop: 500 ms doubling to a 5 s ceiling; reset by any claimed trigger. */
export const IDLE_BASE_MS = 500;
export const IDLE_MAX_MS = 5_000;
/** The worker's own database trouble: 1 s doubling to 30 s. */
export const OUTAGE_BASE_MS = 1_000;
export const OUTAGE_MAX_MS = 30_000;
/** A continuous outage this long is fatal: the process exits non-zero and its supervisor decides. */
export const OUTAGE_GIVE_UP_MS = 5 * 60_000;
/** The sweeper runs every few seconds with jitter (J.1). */
export const SWEEP_INTERVAL_MS = 5_000;
export const JITTER_RATIO = 0.2;

/** Trigger lanes (parallel T1s). One claim batch never exceeds the free lanes, so every claim starts T1 at once (J.6 guard). */
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;
/** Pool: one connection per lane, one for claims and T2 records, one for the sweeper, one spare for preflight. */
export const poolSize = (concurrency: number) => concurrency + 3;

/**
 * Server settings of EVERY worker connection, sent at connection start (J.6): the transaction bound is enforced by PostgreSQL 17's
 * transaction_timeout (the session is terminated, the server rolls back and releases every lock), not by the application.
 * lock_timeout is set per transaction by the runtime (SET LOCAL 5 s) and is not a session setting here.
 */
export const SESSION_SETTINGS = Object.freeze({
  transaction_timeout: `${RUNTIME_POLICY.transactionTimeoutMs / 1000}s`,
  idle_in_transaction_session_timeout: `${RUNTIME_POLICY.idleInTransactionTimeoutMs / 1000}s`,
  statement_timeout: `${RUNTIME_POLICY.statementTimeoutMs / 1000}s`,
});
/** transaction_timeout exists from PostgreSQL 17: the worker refuses an older server (J.6 preflight). */
export const MIN_SERVER_VERSION_NUM = 170_000;

/**
 * After SIGTERM/SIGINT, in-flight transactions get the server's own bound (transaction_timeout) plus a margin to roll back and
 * record T2, before the process gives up and exits non-zero; claims it did not finish then wait for their lease.
 */
export const SHUTDOWN_GRACE_MS = RUNTIME_POLICY.transactionTimeoutMs + 10_000;

const jittered = (ms: number, random: () => number) =>
  Math.round(ms * (1 - JITTER_RATIO + 2 * JITTER_RATIO * Math.min(Math.max(random(), 0), 1)));

/** Delay after the n-th consecutive empty poll (1-based). */
export function idleDelayMs(emptyPolls: number, random: () => number): number {
  const nominal = Math.min(IDLE_BASE_MS * 2 ** Math.max(emptyPolls - 1, 0), IDLE_MAX_MS);
  return Math.min(jittered(nominal, random), IDLE_MAX_MS);
}

/** Delay after the n-th consecutive failure (1-based). */
export function outageDelayMs(failures: number, random: () => number): number {
  const nominal = Math.min(OUTAGE_BASE_MS * 2 ** Math.max(failures - 1, 0), OUTAGE_MAX_MS);
  return Math.min(jittered(nominal, random), OUTAGE_MAX_MS);
}

/** Delay between two sweeps (never overlapping: the next starts only after this delay from the end of the last). */
export function sweepDelayMs(random: () => number): number {
  return jittered(SWEEP_INTERVAL_MS, random);
}
