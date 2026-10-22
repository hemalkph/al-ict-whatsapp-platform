import type { DbExecutor } from "@/db/ops/executor";
import {
  claimTriggers as claimTriggersOp,
  deferTrigger as deferTriggerOp,
  endConversationTriggers as endConversationTriggersOp,
  finishTrigger as finishTriggerOp,
  listTerminalizationCandidates as listCandidatesOp,
  recordTriggerFailure as recordTriggerFailureOp,
  terminalizeTrigger as terminalizeTriggerOp,
  wakeConversationTriggers as wakeConversationTriggersOp,
  type ClaimedTrigger,
  type DeferResult,
  type TerminalizationCandidate,
  type TerminalizationResult,
} from "@/db/ops/bot-trigger-queue";
import { claimFailureBackoffMs } from "./backoff";
import { emitBotRuntimeLog } from "./log";
import { RUNTIME_POLICY } from "./policy";

// The trigger queue with the approved runtime policy bound in (Phase 08E-3; plan sections D.3, G.3, J.2, J.3, K.1a). This is
// the ONLY file of the module that touches the database, and only through the SQL primitives of db/ops/bot-trigger-queue.ts
// (no SQL text here). It is NOT exported from the module index: the webhook worker imports that index, and nothing in the
// inbound path may reach the queue. Nothing calls this file yet; the step transaction (08E-4) and the bot worker (08E-7) will.
// It starts no loop, creates no session or request, and calls no transport.
//
// Randomness is a REQUIRED parameter (the core never reads Math.random); the database clock is used for every time value.

export type { ClaimedTrigger, DeferResult, TerminalizationCandidate, TerminalizationResult };

/** How many triggers one claim statement takes (the plan's batch size is a worker setting; this is only the default). */
export const DEFAULT_CLAIM_BATCH = 10;

/** T0. Run it as its own short committed transaction. */
export function claimTriggers(
  db: DbExecutor,
  limit: number = DEFAULT_CLAIM_BATCH,
): Promise<ClaimedTrigger[]> {
  return claimTriggersOp(db, {
    limit,
    leaseMs: RUNTIME_POLICY.claimLeaseMs,
    maxClaims: RUNTIME_POLICY.triggerMaxClaims,
  });
}

type PgError = { code?: unknown; cause?: unknown };

/** Every SQLSTATE in an error's cause chain, outermost first (Drizzle wraps the driver error). */
function sqlStates(error: unknown): string[] {
  const states: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const code = (current as PgError).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) states.push(code);
    current = (current as PgError).cause;
  }
  return states;
}

/**
 * A FIXED, content-free code for a failed step, from the SQLSTATE alone. Exception text, names, stacks and messages are never
 * read, so nothing a student wrote (a constraint detail can quote a value) can reach last_error_code or a log.
 */
export function triggerErrorCode(error: unknown): string {
  const [state] = sqlStates(error);
  if (state === undefined) return "internal_error";
  switch (state) {
    case "55P03":
      return "lock_timeout";
    case "57014":
      return "statement_timeout";
    case "40P01":
      return "deadlock_detected";
    case "40001":
      return "serialization_failure";
    case "25P03":
      return "idle_in_transaction_timeout";
    case "25P04":
      return "transaction_timeout";
    case "57P01":
    case "57P02":
    case "57P03":
      return "connection_lost";
  }
  if (state.startsWith("08")) return "connection_lost";
  if (state.startsWith("23")) return "constraint_violation";
  if (state.startsWith("22")) return "data_exception";
  return `db_${state.toLowerCase()}`;
}

/**
 * T2, on a fresh transaction after T1 rolled back. The retry delay is the approved claim backoff for the claim number
 * (5 s, 15 s, 45 s, 2 min, 5 min, +-20 %); after the sixth claim there is none and the trigger waits for terminalization.
 * Fenced on the claim: false means the claim was lost (nothing changed).
 */
export function recordTriggerFailure(
  db: DbExecutor,
  claim: ClaimedTrigger,
  error: unknown,
  random: () => number,
): Promise<boolean> {
  return recordTriggerFailureOp(db, {
    organizationId: claim.organizationId,
    id: claim.id,
    claimToken: claim.claimToken,
    errorCode: triggerErrorCode(error),
    backoffMs: claimFailureBackoffMs(claim.attempts, random),
  });
}

/**
 * Defers a FRESH trigger: refunds the claim-time attempt once, counts the deferral and applies the 2/4/8/15 s ladder from the
 * database clock (or the freshness clock the step already read). A stale trigger must be finished, not deferred (K.1a): that
 * decision belongs to the step transaction, which owns the clock read; this function never decides staleness.
 */
export function deferTrigger(
  db: DbExecutor,
  claim: ClaimedTrigger,
  at?: Date,
): Promise<DeferResult | null> {
  return deferTriggerOp(db, {
    organizationId: claim.organizationId,
    id: claim.id,
    claimToken: claim.claimToken,
    ladderMs: RUNTIME_POLICY.deferralLadderMs,
    maxDeferrals: RUNTIME_POLICY.maxDeferrals,
    ...(at === undefined ? {} : { at }),
  });
}

export function finishTrigger(
  db: DbExecutor,
  claim: ClaimedTrigger,
  result: {
    readonly status: "PROCESSED" | "IGNORED";
    readonly outcomeCode: string;
    readonly sessionId?: string;
    readonly at?: Date;
  },
): Promise<boolean> {
  return finishTriggerOp(db, {
    organizationId: claim.organizationId,
    id: claim.id,
    claimToken: claim.claimToken,
    ...result,
  });
}

/** Makes the conversation's later-scheduled PENDING triggers due now (never waits on a held row). */
export function wakeConversationTriggers(
  db: DbExecutor,
  conversation: { organizationId: string; conversationId: string; exceptId?: string },
): Promise<number> {
  return wakeConversationTriggersOp(db, conversation);
}

/** Ends the conversation's PENDING triggers as IGNORED session_ended (never waits on a held row). */
export function endConversationTriggers(
  db: DbExecutor,
  conversation: { organizationId: string; conversationId: string; exceptId?: string },
): Promise<number> {
  return endConversationTriggersOp(db, conversation);
}

const TERMINALIZATION = Object.freeze({
  maxClaims: RUNTIME_POLICY.triggerMaxClaims,
  leaseMs: RUNTIME_POLICY.claimLeaseMs,
});

export function listTerminalizationCandidates(
  db: DbExecutor,
  limit: number = DEFAULT_CLAIM_BATCH,
): Promise<TerminalizationCandidate[]> {
  return listCandidatesOp(db, TERMINALIZATION, limit);
}

/** Terminalizes one exhausted trigger (J.3) and logs `bots.trigger_dead` (ids and codes only) when it is marked DEAD. */
export async function terminalizeTrigger(
  db: DbExecutor,
  candidate: TerminalizationCandidate,
): Promise<TerminalizationResult> {
  const result = await terminalizeTriggerOp(db, candidate, {
    ...TERMINALIZATION,
    lockTimeoutMs: RUNTIME_POLICY.lockTimeoutMs,
  });
  if (result.kind === "dead")
    emitBotRuntimeLog({
      event: "bots.trigger_dead",
      outcome: "failure",
      organizationId: candidate.organizationId,
      conversationId: candidate.conversationId,
      triggerId: candidate.id,
      ...(result.handedOverSessionId === null ? {} : { sessionId: result.handedOverSessionId }),
      reason: "attempts_exhausted",
      count: result.endedTriggers,
    });
  return result;
}
