import { schema } from "@/db";

// The pure rules of the automatic lead reconciler (ADR 0016, decisions 4, 5 and 7). Everything here is a function of plain facts,
// so it can be tested without a database; the facts themselves are read under the locks by process.ts.

export const MAX_ATTEMPTS: number = schema.LEAD_RECONCILE_MAX_ATTEMPTS; // five failed attempts, then PARKED

/**
 * How long an earlier touch that is waiting for its RETRY may hold back a LATER touch of a contact that has no open lead (the
 * later one would otherwise initiate the lead). Measured from the earlier touch's trusted first-consideration time (the
 * `created_at` of its RETRY row, read from the database clock). It is a policy hold, NOT a guaranteed latency: nothing schedules
 * the reconciler, and receipt order is not proof of the order of the ad clicks.
 */
export const FIRST_TOUCH_HOLD_MINUTES = 15;

/**
 * Seconds to wait after the Nth failed attempt (N = 1..4): 1 minute, 5 minutes, 30 minutes, 2 hours. The fifth failure is
 * PARKED and has no next attempt.
 */
export const BACKOFF_SECONDS = [60, 300, 1_800, 7_200] as const;

export type FailureStep =
  | { readonly decision: "RETRY"; readonly attempts: number; readonly delaySeconds: number }
  | { readonly decision: "PARKED"; readonly attempts: number };

/** What a failed attempt becomes, given how many attempts had already failed. */
export function stepAfterFailure(previousAttempts: number): FailureStep {
  const attempts = Math.max(0, Math.floor(previousAttempts)) + 1;
  if (attempts >= MAX_ATTEMPTS) return { decision: "PARKED", attempts: MAX_ATTEMPTS };
  return { decision: "RETRY", attempts, delaySeconds: BACKOFF_SECONDS[attempts - 1]! };
}

export type SkipDecision =
  "SKIPPED_STALE" | "SKIPPED_BEFORE_CYCLE" | "SKIPPED_CONVERTED" | "SKIPPED_ARCHIVED";

/**
 * What is true about one touch and its contact, read AFTER the contact lock, the open lead's row lock and the touch's row lock
 * were obtained. Every comparison of times is made by PostgreSQL on the exact microsecond values (see process.ts).
 */
export type Facts = {
  /** The contact is archived. */
  readonly archived: boolean;
  /** The touch's evidence time (the earlier of its receipt time and its message's provider time) is older than the freshness window, measured from when it was first considered. */
  readonly stale: boolean;
  /** The contact's open lead (at most one exists), if any. */
  readonly openLead: { readonly id: string; readonly touchPredatesCycle: boolean } | null;
  /** The touch is not later than the latest closure of any of the contact's leads. */
  readonly atOrBeforeLatestClosure: boolean;
  /** The contact has a CONVERTED lead. */
  readonly converted: boolean;
  /**
   * An EARLIER touch of the same contact (a confirmed Meta ad touch of an INBOUND message) has an actual RETRY decision whose
   * first consideration was less than the hold ago: a later touch that would INITIATE a lead waits for it. Never true when the
   * contact has an open lead (nothing waits then), and never true for a touch that was never considered or that belongs to an
   * outbound message.
   */
  readonly earlierTouchHolding: boolean;
};

export type Verdict =
  | { readonly action: "skip"; readonly decision: SkipDecision }
  | { readonly action: "link"; readonly leadId: string }
  | { readonly action: "create" }
  /** Nothing is written: an earlier touch of the contact is in its retry back-off and still holds this one (new lead only). */
  | { readonly action: "wait" };

/**
 * The reconciliation policy, in order:
 *  1. an archived contact gets no automatic handling;
 *  2. a stale touch (older than the freshness window when first considered) is skipped for good;
 *  3. a contact WITH an open lead: a touch that predates the lead's current cycle is skipped (the database refuses such a link
 *     too), any other touch is linked to that lead IMMEDIATELY (it never waits for an earlier touch);
 *  4. a contact WITHOUT an open lead: a touch that is not later than the latest closure of any of its leads belongs to a cycle
 *     that has ended and is skipped; otherwise converted history suppresses AUTOMATIC creation; otherwise exactly one new lead
 *     is created from it.
 * Skips are terminal. CREATING a lead waits (at most the policy hold) for an earlier touch of the contact that is in its RETRY
 * back-off, so a transient fault on the earlier touch does not at once hand the lead to a later one; once the hold has passed a
 * later touch may initiate the lead, and the earlier one is then judged by the normal cycle rule (it is not forced onto the lead).
 */
export function decide(facts: Facts): Verdict {
  if (facts.archived) return { action: "skip", decision: "SKIPPED_ARCHIVED" };
  if (facts.stale) return { action: "skip", decision: "SKIPPED_STALE" };
  if (facts.openLead) {
    if (facts.openLead.touchPredatesCycle)
      return { action: "skip", decision: "SKIPPED_BEFORE_CYCLE" };
    return { action: "link", leadId: facts.openLead.id };
  }
  if (facts.atOrBeforeLatestClosure) return { action: "skip", decision: "SKIPPED_BEFORE_CYCLE" };
  if (facts.converted) return { action: "skip", decision: "SKIPPED_CONVERTED" };
  if (facts.earlierTouchHolding) return { action: "wait" };
  return { action: "create" };
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** A fixed, content-free code for a failure: a SQLSTATE or "internal_error". Never a message, never a value. */
export function failureCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && SQLSTATE.test(code)) return `pg_${code.toLowerCase()}`;
    current = (current as { cause?: unknown }).cause;
  }
  return "internal_error";
}
