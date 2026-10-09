import { HANDLER_TIMEOUT_MS, JITTER_RATIO } from "../queue/policy";

// Worker-PROCESS timing. Per-event retry/backoff, leases and budgets belong to the queue (../queue/policy.ts) and are not
// repeated or changed here. Pure: no clock reads, no timers.

/** Idle polling: the first empty poll waits 500 ms, doubling to a 5 s ceiling. Work resets it; a busy worker never waits. */
export const IDLE_BASE_MS = 500;
export const IDLE_MAX_MS = 5_000;
/** Database trouble (the worker's own connectivity, not an event's failure): 1 s doubling to 30 s. */
export const OUTAGE_BASE_MS = 1_000;
export const OUTAGE_MAX_MS = 30_000;
/** An outage lasting this long is fatal: the process exits non-zero and its supervisor decides. */
export const OUTAGE_GIVE_UP_MS = 5 * 60_000;
/** A queue-depth heartbeat is logged this often, busy or idle. */
export const STATS_INTERVAL_MS = 60_000;
/**
 * After SIGTERM/SIGINT in-flight handlers get their normal budget plus this margin (rolling back and recording the outcome)
 * before the process gives up and exits non-zero. The lease then expires and another worker reclaims the event.
 */
export const SHUTDOWN_GRACE_MS = HANDLER_TIMEOUT_MS + 10_000;

const jittered = (ms: number, random: () => number) =>
  Math.round(ms * (1 - JITTER_RATIO + 2 * JITTER_RATIO * Math.min(Math.max(random(), 0), 1)));

/** Delay after the n-th consecutive empty poll (1-based). */
export function idleDelayMs(emptyPolls: number, random: () => number): number {
  const nominal = Math.min(IDLE_BASE_MS * 2 ** Math.max(emptyPolls - 1, 0), IDLE_MAX_MS);
  return Math.min(jittered(nominal, random), IDLE_MAX_MS);
}

/** Delay after the n-th consecutive failed poll (1-based). */
export function outageDelayMs(failures: number, random: () => number): number {
  const nominal = Math.min(OUTAGE_BASE_MS * 2 ** Math.max(failures - 1, 0), OUTAGE_MAX_MS);
  return Math.min(jittered(nominal, random), OUTAGE_MAX_MS);
}
