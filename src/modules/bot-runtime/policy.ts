// The bot runtime's constants and the small pure rules built on them (Phase 08E-1; plan sections E.3, G.3, G.4, H, J.6, K.1).
// PURE: no database, clock, randomness or environment. Every time value is epoch milliseconds supplied by the caller, who
// reads it from the database clock AFTER the last blocking lock (K.1 step 8); nothing here reads a clock.
//
// The product limits are OWNER APPROVED (O-3, 2026-10-20). The technical deadlines, leases, retry limits and margins are the
// reviewed ones of V3.2 and the plan and are not reopened here; a test pins the ones that duplicate a messaging constant.

import { TRIGGER_ELIGIBLE_TYPES, isTriggerEligibleType } from "@/modules/bots";

/** Message types that can create a trigger (V3.2 H.1). One definition: the pure matcher's, re-exposed here. */
export const ELIGIBLE_MESSAGE_TYPES = TRIGGER_ELIGIBLE_TYPES;
export const isEligibleMessageType = isTriggerEligibleType;

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const RUNTIME_POLICY = Object.freeze({
  // ---- owner-approved product limits (O-3)
  /** Quiet period after a conversation's latest session ended (and after the latest staff resolution). */
  cooldownMs: 30 * MINUTE,
  /** Sessions per contact in the rolling window, across all WhatsApp accounts and conversations of the organization. */
  contactSessionCap: 3,
  contactSessionWindowMs: 24 * HOUR,
  /** An input older than this when the runtime reaches it is stale (strictly older). */
  maxInputAgeMs: 10 * MINUTE,
  /** BOT outbound requests created per conversation in the rolling window, whatever their final state (C-4). */
  hourlyBotRequestCap: 30,
  hourlyWindowMs: HOUR,
  // ---- reviewed technical values (V3.2 H.5, I.2, J.6, N.1, K.1)
  pendingTriggerCap: 20,
  /** A trigger is claimed at most this many times (attempts 0..6); the sixth failure is terminalized, never re-claimed. */
  triggerMaxClaims: 6,
  maxDeferrals: 1_000,
  claimLeaseMs: 60 * SECOND,
  /** T1 must begin within this long of the claim, else it stops with no effects (J.6). */
  t1StartGuardMs: 20 * SECOND,
  /** Enforced by transaction_timeout on the dedicated worker pool (J.6). */
  transactionTimeoutMs: 25 * SECOND,
  idleInTransactionTimeoutMs: 10 * SECOND,
  statementTimeoutMs: 15 * SECOND,
  lockTimeoutMs: 5 * SECOND,
  /** More than this between the decision clock and the end of enqueue rolls T1 back (K.1). */
  postEnqueueSkewMs: 2 * SECOND,
  /** The BOT dispatch deadline (messaging policy, ADR 0020) and the reconciler's grace after it (N.1). */
  botDispatchDeadlineMs: 120 * SECOND,
  queuedDeadlineGraceMs: 30 * SECOND,
  /** How long the dispatcher's recovery waits before declaring a SENDING row unknown (messaging policy), plus a margin. */
  sendingRecoveryMs: 5 * MINUTE,
  sendWaitMarginMs: 30 * SECOND,
  /** Claim failure backoff after claims 1..5 (T2) and the deferral ladder (G.3). Jitter is a fraction either side. */
  claimBackoffMs: Object.freeze([5 * SECOND, 15 * SECOND, 45 * SECOND, 120 * SECOND, 300 * SECOND]),
  backoffJitter: 0.2,
  deferralLadderMs: Object.freeze([2 * SECOND, 4 * SECOND, 8 * SECOND, 15 * SECOND]),
});

/** True when an input is stale: STRICTLY older than maxInputAge at `nowMs` (exactly the limit is still processed). */
export function isStaleInput(
  nowMs: number,
  inputOccurredAtMs: number,
  maxInputAgeMs: number = RUNTIME_POLICY.maxInputAgeMs,
): boolean {
  return nowMs - inputOccurredAtMs > maxInputAgeMs;
}

/** When a session waiting for its latest request to resolve is given up on (V3.2 G.5, N.1): recovery age plus a margin. */
export function sendWaitExpiresAtMs(nowMs: number): number {
  return nowMs + RUNTIME_POLICY.sendingRecoveryMs + RUNTIME_POLICY.sendWaitMarginMs;
}

/** From when a still-QUEUED request is overdue for the reconciler: its dispatch deadline plus the grace. */
export function queuedRequestOverdueFromMs(dispatchDeadlineMs: number): number {
  return dispatchDeadlineMs + RUNTIME_POLICY.queuedDeadlineGraceMs;
}

/** K.1 step 0 / J.6: T1 may begin only while the claim is at most t1StartGuardMs old (inclusive). */
export function t1MayStart(claimedAtMs: number, nowMs: number): boolean {
  return claimedAtMs >= nowMs - RUNTIME_POLICY.t1StartGuardMs;
}

/** The latest moment a T1 that passed the start guard can still be running; below the lease with a margin (J.6). */
export function latestT1EndMs(claimedAtMs: number): number {
  return claimedAtMs + RUNTIME_POLICY.t1StartGuardMs + RUNTIME_POLICY.transactionTimeoutMs;
}

/** True once a claim no longer excludes other workers (the lease is strictly over). */
export function claimLeaseExpired(claimedAtMs: number, nowMs: number): boolean {
  return claimedAtMs < nowMs - RUNTIME_POLICY.claimLeaseMs;
}

export type HourlyCapDecision =
  | { readonly decision: "replay" }
  | { readonly decision: "allow" }
  | { readonly decision: "refuse"; readonly code: "bot_hourly_cap" };

/**
 * The rolling-hour cap (owner decision C-4). `recentCount` is the number of BOT requests created for the conversation in the
 * preceding hour, in ANY state (a rolled-back creation leaves no row). `stepAlreadyHasRequest` is true when a request for this
 * exact (session, step) already exists: an idempotent replay is neither counted again nor refused.
 */
export function evaluateHourlyCap(input: {
  readonly recentCount: number;
  readonly stepAlreadyHasRequest: boolean;
}): HourlyCapDecision {
  if (input.stepAlreadyHasRequest) return { decision: "replay" };
  if (input.recentCount >= RUNTIME_POLICY.hourlyBotRequestCap)
    return { decision: "refuse", code: "bot_hourly_cap" };
  return { decision: "allow" };
}

/** The start of the hourly window for a decision clock. A request created exactly at this instant is NOT counted. */
export function hourlyWindowStartMs(nowMs: number): number {
  return nowMs - RUNTIME_POLICY.hourlyWindowMs;
}
