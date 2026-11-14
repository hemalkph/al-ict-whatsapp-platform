import type { LockedConversation, StepTrigger } from "@/db/ops/bot-step";
import type { DbExecutor } from "@/db/ops/executor";
import type { StepDeps } from "./outbound";
import { deferTrigger, finishTrigger, type ClaimedTrigger } from "./trigger-queue";

// What every part of the step transaction shares (Phase 08E-4; plan section K.1): the transaction, the claimed trigger and the
// ONE decision clock read after the last blocking lock (K.1 step 8), plus the three ways a step ends its trigger. Every write
// to the trigger is fenced by the claim token inside trigger-queue; zero rows mean the claim was lost, and because this
// transaction holds the trigger row that cannot happen, so it is treated as a defect and rolls the step back.

export type StepContext = {
  readonly tx: DbExecutor;
  readonly deps: StepDeps;
  readonly claim: ClaimedTrigger;
  readonly trigger: StepTrigger;
  readonly conversation: LockedConversation;
  /** The decision clock (database clock_timestamp(), K.1 step 8). */
  readonly nowDate: Date;
  readonly nowMs: number;
};

export type StepSummary =
  /** No effect: the claim was finished, re-claimed or too old (K.1 step 0). */
  | { readonly kind: "lost_claim" }
  /** A gate is off: nothing was read or written. */
  | { readonly kind: "gates_off" }
  | {
      readonly kind: "finished";
      readonly status: "PROCESSED" | "IGNORED";
      readonly outcome: string;
      readonly sessionId: string | null;
    }
  /** The trigger was deferred (refund + ladder) and stays PENDING. */
  | { readonly kind: "deferred"; readonly reason: string }
  /** The step rolled back; T2 recorded the failure (recorded=false: the record itself failed, the lease will expire). */
  | { readonly kind: "failed"; readonly errorCode: string; readonly recorded: boolean };

/** Ends the claim: PROCESSED or IGNORED with a fixed outcome code, at the decision clock. */
export async function finishStep(
  c: Pick<StepContext, "tx" | "claim" | "nowDate">,
  status: "PROCESSED" | "IGNORED",
  outcome: string,
  sessionId: string | null = null,
): Promise<StepSummary> {
  const ok = await finishTrigger(c.tx, c.claim, {
    status,
    outcomeCode: outcome,
    ...(sessionId === null ? {} : { sessionId }),
    at: c.nowDate,
  });
  if (!ok) throw new Error("claim_lost_in_step");
  return { kind: "finished", status, outcome, sessionId };
}

/** Defers a FRESH trigger (the caller has established it is not stale): clears the claim, refunds once, walks the ladder. */
export async function deferStep(
  c: Pick<StepContext, "tx" | "claim" | "nowDate">,
  reason: string,
): Promise<StepSummary> {
  const r = await deferTrigger(c.tx, c.claim, c.nowDate);
  if (r === null) throw new Error("defer_refused");
  return { kind: "deferred", reason };
}
