// Outbound messaging policy constants. Pure. Everything here is a decision of THIS application, not a number Meta
// documents (the official pages checked in Phase 05 state no throughput figure, no Retry-After header and no text length
// limit that this code relies on; see docs/WHATSAPP_OUTBOUND_EVIDENCE.md).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The ordinary customer service window: 24 hours from the customer's last qualifying inbound message. */
export const SERVICE_WINDOW_MS = 24 * HOUR;
/**
 * Free-form eligibility ends this much BEFORE the window would close. It absorbs clock skew and the up-to-5-minute
 * future cap that inbound ingest applies to provider timestamps (effectiveActivityTime), so a message never goes out in
 * the last minutes of the window, and never because a provider timestamp was dated in the future.
 */
export const SERVICE_WINDOW_SAFETY_MARGIN_MS = 10 * MINUTE;

/** Application limit for a text body (UTF-16 code units). */
export const TEXT_BODY_MAX = 4096;
export const TEMPLATE_PARAMETER_MAX = 1024;
export const TEMPLATE_PARAMETER_COUNT_MAX = 20;

/** A request that has not been dispatched within this time is HELD (deadline_passed): staff must send again deliberately. */
export const DISPATCH_DEADLINE_MS = 15 * MINUTE;
/** A BOT request (Phase 08D, V3.2 I.2) that has not been dispatched within 120 s is HELD (deadline_passed): the bot is no longer timely. */
export const BOT_DISPATCH_DEADLINE_MS = 120_000;

/** Per-request HTTP budget, and how long a SENDING row may exist before it is declared UNKNOWN_OUTCOME (never retried). */
export const HTTP_TIMEOUT_MS = 15_000;
export const SENDING_RECOVERY_AFTER_MS = 5 * MINUTE;
/**
 * A claim must START its HTTP request within this long of send_started_at. It is far shorter than SENDING_RECOVERY_AFTER_MS, so
 * a worker that was paused (or whose connection stalled) cannot begin a request on a claim that recovery is about to give up on.
 */
export const SEND_START_BUDGET_MS = 60_000;
/** Longest the claim transaction waits for any database lock; a request it could not examine in time stays QUEUED. */
export const CLAIM_LOCK_TIMEOUT_MS = 5_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Whether a Meta throttling answer (HTTP 429 with a documented rate code) may be retried automatically. It may NOT: Meta's error
 * table recommends retrying those codes but does not state that no message was created, and a duplicate customer message is
 * worse than a delayed one. Until that contract is independently verified, such an answer is UNKNOWN_OUTCOME like any other
 * response that may have been accepted. The backoff machinery below is kept for the day this is verified; it is a code
 * constant on purpose (not an environment variable), so a deployment cannot switch it on.
 */
export const THROTTLE_RETRY_VERIFIED = false;
/** Refusals that came before any HTTP attempt began (or, once THROTTLE_RETRY_VERIFIED, throttles) before the request is HELD. */
export const MAX_NOT_SENT_ATTEMPTS = 5;
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 15 * MINUTE;
export const RETRY_AFTER_CAP_MS = HOUR;

/** Application-side spacing (not a Meta figure): minimum gap between sends from one WhatsApp account / to one conversation. */
export const DEFAULT_ACCOUNT_MIN_INTERVAL_MS = 1_000;
export const DEFAULT_CONVERSATION_MIN_INTERVAL_MS = 1_000;

export const DEFAULT_BATCH_SIZE = 10;
export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 4;

/** Delay before the next try of a request refused before any HTTP attempt (or, once verified, throttled), attempt number 1-based. */
export function retryDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  random: () => number,
): number {
  const exp = Math.min(RETRY_BASE_MS * 2 ** Math.max(attempt - 1, 0), RETRY_MAX_MS);
  const jittered = Math.round(exp * (0.8 + 0.4 * Math.min(Math.max(random(), 0), 1)));
  const hint = retryAfterMs === null ? 0 : Math.min(Math.max(retryAfterMs, 0), RETRY_AFTER_CAP_MS);
  return Math.max(jittered, hint);
}
