import { RUNTIME_POLICY } from "./policy";

// Trigger retry arithmetic (Phase 08E-1; V3.2 H.3 and H.5, plan sections G.3, J.2, K.1a). PURE: randomness is injected
// (`random` returns a number in [0, 1]); no clock is read (the caller passes the database clock it read).

const clamp01 = (n: number): number => Math.min(Math.max(Number.isFinite(n) ? n : 0.5, 0), 1);

/**
 * The delay before a trigger whose claim number `claim` just failed (1..5) may be claimed again: 5 s, 15 s, 45 s, 2 min,
 * 5 min, each with +-20 % jitter. After the sixth claim there is no further claim (terminalization takes over): null.
 */
export function claimFailureBackoffMs(claim: number, random: () => number): number | null {
  if (!Number.isInteger(claim) || claim < 1) return null;
  const base = RUNTIME_POLICY.claimBackoffMs[claim - 1];
  if (base === undefined) return null;
  const j = RUNTIME_POLICY.backoffJitter;
  return Math.round(base * (1 - j + 2 * j * clamp01(random())));
}

/** The deferral delay selected by the deferrals already recorded: 2 s, 4 s, 8 s, then 15 s every time. */
export function deferralDelayMs(deferralsSoFar: number): number {
  const ladder = RUNTIME_POLICY.deferralLadderMs;
  const i = Math.max(0, Math.min(Math.trunc(deferralsSoFar), ladder.length - 1));
  return ladder[i]!;
}

/** Whether a trigger with this many recorded claims may be claimed again (never a seventh). */
export function isClaimable(attempts: number): boolean {
  return attempts < RUNTIME_POLICY.triggerMaxClaims;
}

/** A terminalization candidate by attempts alone (the caller also requires PENDING and no live claim). */
export function isTerminalizationCandidate(attempts: number): boolean {
  return attempts === RUNTIME_POLICY.triggerMaxClaims;
}

export type DeferralPlan =
  | {
      readonly ok: true;
      /** attempts - 1: the claim-time attempt is refunded exactly once. */
      readonly attempts: number;
      readonly deferrals: number;
      readonly nextAttemptAtMs: number;
    }
  | { readonly ok: false; readonly reason: "no_charged_attempt" | "deferral_limit" };

/**
 * The fenced deferral update's new values for a FRESH trigger (a stale one is finished, never deferred: K.1a). `freshnessMs`
 * is the database clock read on the still-locked trigger. A trigger with no charged attempt cannot be refunded, and one at
 * the database's deferral ceiling cannot be deferred again (staleness ends it long before in practice).
 */
export function planDeferral(
  trigger: { readonly attempts: number; readonly deferrals: number },
  freshnessMs: number,
): DeferralPlan {
  if (trigger.attempts < 1) return { ok: false, reason: "no_charged_attempt" };
  if (trigger.deferrals >= RUNTIME_POLICY.maxDeferrals)
    return { ok: false, reason: "deferral_limit" };
  return {
    ok: true,
    attempts: trigger.attempts - 1,
    deferrals: trigger.deferrals + 1,
    nextAttemptAtMs: freshnessMs + deferralDelayMs(trigger.deferrals),
  };
}
