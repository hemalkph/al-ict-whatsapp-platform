import { countRecentBotRequests, readStepRequest } from "@/db/ops/bot-session-store";
import type { DbExecutor } from "@/db/ops/executor";
import type { SendEffect } from "@/modules/bots";
import type { OutboundConfig } from "@/modules/messaging/config";
import { enqueueAutomatedMessage, type AutomationAuthority } from "@/modules/messaging/enqueue";
import { OutboundRefusedError } from "@/modules/messaging/errors";
import type { FlowCache } from "./flow-cache";
import { evaluateHourlyCap, RUNTIME_POLICY } from "./policy";

// The ONE production importer of enqueueAutomatedMessage (Phase 08E-4; plan section H, ADR 0020). Every BOT request the
// runtime creates goes through `enqueueEffect` below, inside the step transaction, after the session row exists and under the
// step locks. This file imports no transport, dispatcher or claim code; it never writes an outbound request's state.

/** What the step transaction needs besides the database: gates, the flow cache, token and randomness sources, test seams. */
export type StepDeps = {
  /** The gates enqueueAutomatedMessage checks. T1 does nothing at all while the outbound or runtime gate is off. */
  readonly config: OutboundConfig;
  readonly flows: FlowCache;
  /** A fresh prompt token (16 random bytes, base64url). Required: the core never reads randomness itself. */
  readonly newPromptToken: () => string;
  /** Jitter source for the claim-failure backoff (T2). */
  readonly random: () => number;
  /** TEST SEAM: the decision clock. Production passes none and the database clock_timestamp() is used. */
  readonly readClock?: (tx: DbExecutor) => Promise<Date>;
  /** TEST SEAM: barrier points inside T1 (production composition passes none). */
  readonly hooks?: StepHooks;
};

export type StepHooks = {
  readonly afterTriggerLock?: (tx: DbExecutor) => Promise<void>;
  readonly afterAdvisoryLocks?: (tx: DbExecutor) => Promise<void>;
  /** After step 7 (the last blocking lock), before the decision clock. */
  readonly afterRowLocks?: (tx: DbExecutor) => Promise<void>;
  readonly afterDecisionClock?: (tx: DbExecutor, decisionClock: Date) => Promise<void>;
  /** Start path only: the evaluator chose `start`; nothing has been written yet (TEST SEAM for the cap-race mutation). */
  readonly afterStartDecision?: (tx: DbExecutor) => Promise<void>;
  readonly afterEnqueue?: (tx: DbExecutor) => Promise<void>;
  readonly beforeCommit?: (tx: DbExecutor) => Promise<void>;
};

export type EnqueueOutcome =
  | { readonly ok: true; readonly requestId: string; readonly replayed: boolean }
  /** An ordinary refusal (policy, gate, state, hourly cap): not an integrity error. `reason` is a fixed snake_case code. */
  | { readonly ok: false; readonly reason: string };

const CODE = /^[a-z0-9_]{1,64}$/;

/**
 * Creates (or replays) the BOT request of one engine effect. H.5: before building a NEW request the rolling-hour cap is
 * checked; an existing request for this exact (session, step) skips the cap and is replayed by enqueue (neither counted again
 * nor refused). A refusal is returned, not thrown, so the caller can decide (hand over, or commit without a notice). A genuine
 * integrity error (IdempotencyConflictError, a unique/in-flight index violation, a database failure) is NOT caught: it rolls
 * the step back and the trigger records the failure.
 */
export async function enqueueEffect(
  tx: DbExecutor,
  deps: StepDeps,
  authority: AutomationAuthority,
  effect: SendEffect,
  decisionClock: Date,
): Promise<EnqueueOutcome> {
  const exists =
    (await readStepRequest(
      tx,
      authority.organizationId,
      authority.botSessionId,
      effect.stepSeq,
    )) !== null;
  const recentCount = exists
    ? 0
    : await countRecentBotRequests(
        tx,
        authority.organizationId,
        authority.conversationId,
        decisionClock,
        RUNTIME_POLICY.hourlyWindowMs,
      );
  const cap = evaluateHourlyCap({ recentCount, stepAlreadyHasRequest: exists });
  if (cap.decision === "refuse") return { ok: false, reason: cap.code };
  try {
    const r = await enqueueAutomatedMessage(
      tx,
      authority,
      { stepSeq: effect.stepSeq, message: effect.message },
      { config: deps.config, now: () => decisionClock },
    );
    return { ok: true, requestId: r.requestId, replayed: r.replayed };
  } catch (error) {
    if (error instanceof OutboundRefusedError)
      return { ok: false, reason: CODE.test(error.reason) ? error.reason : "send_refused" };
    throw error;
  }
}

export type { AutomationAuthority };
