// Queue policy constants and retry timing. Pure: no database, no timers, no clock reads (callers inject both the clock
// and the randomness).

/** Claims per event, and therefore handler runs per event, are capped here. attempts = number of claims. */
export const MAX_ATTEMPTS = 8;
/** An event stays reserved this long after its claim. There is no heartbeat; the per-event budget below is shorter. */
export const LEASE_SECONDS = 120;
export const HANDLER_TIMEOUT_MS = 60_000;
export const STATEMENT_TIMEOUT_MS = 15_000;
export const DEFAULT_BATCH_SIZE = 20;
export const DEFAULT_CONCURRENCY = 2;
export const MAX_BATCH_SIZE = 100;
export const MAX_CONCURRENCY = 8;
/** Automatic requeue (account activation) only releases events received within this window. */
export const REQUEUE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const JITTER_RATIO = 0.2;

/** Nominal delay before the next run after failed attempt n (index n-1). Attempt 8 has no retry: it is DEAD. */
const RETRY_DELAY_SECONDS = [30, 60, 120, 240, 480, 960, 1920] as const;

/** Seconds to wait after transient failure number `attempt` (1-based), or null when no retry remains. */
export function retryDelaySeconds(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("attempt must be >= 1");
  return attempt >= MAX_ATTEMPTS ? null : (RETRY_DELAY_SECONDS[attempt - 1] ?? null);
}

/** The nominal delay with uniform +/-20% jitter. `random` returns a value in [0, 1). */
export function retryDelayMs(attempt: number, random: () => number): number | null {
  const seconds = retryDelaySeconds(attempt);
  if (seconds === null) return null;
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(seconds * 1000 * (1 - JITTER_RATIO + 2 * JITTER_RATIO * r));
}
