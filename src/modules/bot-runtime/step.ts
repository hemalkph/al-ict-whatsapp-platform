import {
  activeDeploymentIds,
  contactLockKey,
  conversationLockKey,
  dbClock,
  lockAccountShare,
  lockConversation,
  lockDeploymentsShare,
  lockLiveSession,
  lockStepTrigger,
  readConversationRef,
  readLiveSessionRef,
  readTriggerMessage,
  tryAdvisoryLock,
  withStepTransaction,
} from "@/db/ops/bot-step";
import type { DbExecutor } from "@/db/ops/executor";
import { SkewRollback } from "./apply";
import { continuationPath } from "./continue";
import { deferStep, finishStep, type StepContext, type StepSummary } from "./context";
import type { StepDeps } from "./outbound";
import { isEligibleMessageType, isStaleInput, RUNTIME_POLICY } from "./policy";
import { startPath } from "./start";
import { recordTriggerFailure, triggerErrorCode, type ClaimedTrigger } from "./trigger-queue";

// T1, the bot STEP transaction (Phase 08E-4; plan sections E, G, K.1, K.1a): connects ONE claimed trigger to the pure engine.
// Nothing calls it yet (the bot worker is 08E-7); it is not exported from the module index. It never calls a transport.
//
// Lock order (K.1), every step inside ONE transaction with lock_timeout set:
//   trigger row FOR UPDATE (fenced by the exact claim token and the 20 s start guard) -> conversation advisory TRY-lock ->
//   contact advisory TRY-lock (only when no live session was seen) -> deployment(s) FOR SHARE in id order -> conversation FOR
//   UPDATE -> live session FOR UPDATE (re-read) -> account FOR SHARE -> the DECISION CLOCK (database clock_timestamp()).
// A busy try-lock never waits: the trigger is finished (stale) or deferred (fresh) under the claim fence (K.1a). Any thrown
// error rolls everything back and T2 records the failure on a fresh connection; a post-enqueue clock skew rolls back and
// re-decides the trigger alone.

export async function processTrigger(
  db: DbExecutor,
  claim: ClaimedTrigger,
  deps: StepDeps,
): Promise<StepSummary> {
  // Default-off: with either gate off, T1 reads and writes nothing (enqueue would refuse every send).
  if (!deps.config.outboundEnabled || !deps.config.botsRuntimeEnabled) return { kind: "gates_off" };
  try {
    return await withStepTransaction(db, RUNTIME_POLICY.lockTimeoutMs, (tx) =>
      stepTransaction(tx, claim, deps),
    );
  } catch (error) {
    try {
      if (error instanceof SkewRollback) return await recoverAfterSkew(db, claim, deps);
    } catch (recoveryError) {
      return recordFailure(db, claim, recoveryError, deps);
    }
    return recordFailure(db, claim, error, deps);
  }
}

/** T2, on a fresh transaction after T1 rolled back. */
async function recordFailure(
  db: DbExecutor,
  claim: ClaimedTrigger,
  error: unknown,
  deps: StepDeps,
): Promise<StepSummary> {
  const errorCode = triggerErrorCode(error);
  let recorded = false;
  try {
    recorded = await recordTriggerFailure(db, claim, error, deps.random);
  } catch {
    recorded = false; // the claim persists until its lease expires
  }
  return { kind: "failed", errorCode, recorded };
}

const clockOf = (deps: StepDeps) => deps.readClock ?? dbClock;

/**
 * K.1a. Called while the trigger row is locked and `at` is a fresh database clock: a stale input is finished
 * (IGNORED stale_trigger, no refund, no counter change) so it stops blocking later triggers; a fresh one is deferred
 * (refund once, deferrals + 1, ladder). Neither touches a session, event, message or request.
 */
async function staleOrDefer(
  tx: DbExecutor,
  claim: ClaimedTrigger,
  trigger: { inputOccurredAt: Date },
  at: Date,
  reason: string,
): Promise<StepSummary> {
  const c = { tx, claim, nowDate: at };
  if (isStaleInput(at.getTime(), trigger.inputOccurredAt.getTime()))
    return finishStep(c, "IGNORED", "stale_trigger");
  return deferStep(c, reason);
}

async function stepTransaction(
  tx: DbExecutor,
  claim: ClaimedTrigger,
  deps: StepDeps,
): Promise<StepSummary> {
  const org = claim.organizationId;
  const trigger = await lockStepTrigger(
    tx,
    { organizationId: org, id: claim.id, claimToken: claim.claimToken },
    RUNTIME_POLICY.t1StartGuardMs,
  );
  if (trigger === null) return { kind: "lost_claim" };
  await deps.hooks?.afterTriggerLock?.(tx);

  const ref = await readConversationRef(tx, org, trigger.conversationId);
  if (ref === null || ref.whatsappAccountId !== trigger.whatsappAccountId)
    throw new Error("bot_state_unreadable");
  const liveRef = await readLiveSessionRef(tx, org, trigger.conversationId);

  // Steps 2 and 3: try-locks only. Busy: decide the trigger with a fresh clock and stop; never wait.
  if (!(await tryAdvisoryLock(tx, conversationLockKey(org, trigger.conversationId))))
    return staleOrDefer(tx, claim, trigger, await clockOf(deps)(tx), "conversation_busy");
  if (liveRef === null && !(await tryAdvisoryLock(tx, contactLockKey(org, ref.contactId))))
    return staleOrDefer(tx, claim, trigger, await clockOf(deps)(tx), "contact_busy");
  await deps.hooks?.afterAdvisoryLocks?.(tx);

  // Steps 4 to 7.
  const deploymentIds =
    liveRef !== null
      ? [liveRef.deploymentId]
      : await activeDeploymentIds(tx, org, trigger.whatsappAccountId);
  await lockDeploymentsShare(tx, org, deploymentIds);
  const conversation = await lockConversation(tx, org, trigger.conversationId);
  if (conversation === null) throw new Error("bot_state_unreadable");
  const live = await lockLiveSession(tx, org, trigger.conversationId);
  const account = await lockAccountShare(tx, org, trigger.whatsappAccountId);
  if (account === null) throw new Error("bot_state_unreadable");
  await deps.hooks?.afterRowLocks?.(tx);

  // Step 8: the DECISION clock, the first statement after the last potentially blocking lock.
  const nowDate = await clockOf(deps)(tx);
  const c: StepContext = {
    tx,
    deps,
    claim,
    trigger,
    conversation,
    nowDate,
    nowMs: nowDate.getTime(),
  };
  await deps.hooks?.afterDecisionClock?.(tx, nowDate);

  // The plain read and the locked read disagree (a live session ended in between): re-decide on a later claim, where the
  // start path takes the contact lock. A stale trigger is finished instead.
  if ((liveRef?.id ?? null) !== (live?.id ?? null))
    return staleOrDefer(tx, claim, trigger, nowDate, "session_changed");

  const message = await readTriggerMessage(tx, trigger);
  const summary =
    message === null || message.direction !== "INBOUND" || !isEligibleMessageType(message.type)
      ? await finishStep(c, "IGNORED", "message_invalid")
      : live !== null
        ? await continuationPath(c, live, message)
        : await startPath(c, message, deploymentIds, account);
  await deps.hooks?.beforeCommit?.(tx);
  return summary;
}

/**
 * K.1 / K.1a: after a post-enqueue clock skew rolled the whole step back, re-lock the trigger alone under the same claim
 * fence, read a fresh clock and finish it (stale) or defer it (fresh). No session or request effect of the failed step survives.
 */
async function recoverAfterSkew(
  db: DbExecutor,
  claim: ClaimedTrigger,
  deps: StepDeps,
): Promise<StepSummary> {
  return withStepTransaction(db, RUNTIME_POLICY.lockTimeoutMs, async (tx) => {
    const trigger = await lockStepTrigger(
      tx,
      { organizationId: claim.organizationId, id: claim.id, claimToken: claim.claimToken },
      RUNTIME_POLICY.claimLeaseMs,
    );
    if (trigger === null) return { kind: "lost_claim" } as const;
    return staleOrDefer(tx, claim, trigger, await clockOf(deps)(tx), "clock_skew");
  });
}
