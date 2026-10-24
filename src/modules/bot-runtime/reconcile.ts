import {
  endSession,
  insertSessionEvent,
  listReconcileCandidates,
  readStepRequest,
  type ReconcileCandidate,
} from "@/db/ops/bot-session-store";
import {
  conversationLockKey,
  dbClock,
  lockConversation,
  lockDeploymentsShare,
  lockLiveSession,
  readDeployments,
  readStaffControlAfter,
  tryAdvisoryLock,
  withStepTransaction,
  type DeploymentRow,
  type LiveSessionRow,
} from "@/db/ops/bot-step";
import type { DbExecutor } from "@/db/ops/executor";
import {
  OUTPUT_SUPPRESSED_HOLD_CODE,
  SEND_DEADLINE_HOLD_CODE,
  suppressSessionQueuedRequests,
} from "@/modules/bot-control";
import { step, type RequestState } from "@/modules/bots";
import { applyEngineResult, SkewRollback, type ApplyContext, type LiveRef } from "./apply";
import { emitBotRuntimeLog } from "./log";
import type { StepDeps } from "./outbound";
import { queuedRequestOverdueFromMs, RUNTIME_POLICY } from "./policy";
import { sessionFromRow } from "./session-row";
import { classifyTakeover } from "./takeover";
import {
  auditOverdueTriggers,
  endConversationTriggers,
  listTerminalizationCandidates,
  terminalizeTrigger,
} from "./trigger-queue";

// The RECONCILER and the sweep (Phase 08E-6; plan sections I.3, J.1, J.3, J.4, J.4a, J.5, J.5a). Nothing calls it yet: the bot
// worker (08E-7) will; it is not exported from the module index. It never calls a transport, never re-queues, rewrites or
// recreates a request, and never touches a terminal session or its notice (only LIVE sessions are candidates).
//
// Per candidate, ONE transaction in the sweeper order: conversation advisory TRY-lock (busy: skip, retried on a later sweep) ->
// deployment FOR SHARE -> conversation FOR UPDATE -> session FOR UPDATE -> the decision clock -> PLAIN re-reads of the request
// and the session -> one transition. Request rows are never locked except through the session-scoped suppression primitive
// (SKIP LOCKED: a request a dispatcher holds is skipped, and the session is then left exactly as it was, for the next sweep).
//
//   latest request / state                      transition (through applyEngineResult when the engine decides)
//   deployment STOPPED or RETIRED               HANDED_OVER deployment_stopped (I.3 invariant, defensive)
//   WAITING_FOR_INPUT, expires_at <= clock      engine idle_expired (deliveryFailed = prompt message FAILED), silent
//   ACCEPTED                                    engine send_result ACCEPTED (next prompt/step; wake deferred triggers)
//   HELD / REJECTED / UNKNOWN_OUTCOME           engine send_result -> HANDED_OVER send_held/_rejected/_outcome_unknown
//   QUEUED, clock > dispatch_deadline + 30 s    hold it (bot_send_deadline); held -> engine send_result HELD; skipped -> nothing
//   SENDING, clock > send_wait_expires_at       HANDED_OVER send_outcome_unresolved; the request untouched
//   no request row for (session, step)          FAILED / error, ERROR event send_state_missing, operator log (J.5a)
//   anything else                               nothing (not due)

/** The two engine events the reconciler raises (structurally the engine's own `send_result` and `idle_expired`). */
type ReconcileEvent =
  | {
      readonly type: "send_result";
      readonly stepSeq: number;
      readonly state: Exclude<RequestState, "QUEUED" | "SENDING">;
    }
  | { readonly type: "idle_expired"; readonly deliveryFailed?: boolean };

export type ReconcileOutcome =
  | { readonly kind: "gates_off" }
  | {
      readonly kind: "skipped";
      readonly reason:
        "conversation_busy" | "not_live" | "not_due" | "request_locked" | "clock_skew";
    }
  | { readonly kind: "applied"; readonly action: string; readonly finalState: string };

const LIVE = new Set(["ACTIVE", "WAITING_FOR_SEND", "WAITING_FOR_INPUT"]);
const gatesOn = (deps: StepDeps) => deps.config.outboundEnabled && deps.config.botsRuntimeEnabled;

/** J.4 candidates (a plain read; every observation is re-checked under the locks). */
export function listCandidates(db: DbExecutor, limit = 50): Promise<ReconcileCandidate[]> {
  return listReconcileCandidates(db, {
    queuedGraceMs: RUNTIME_POLICY.queuedDeadlineGraceMs,
    limit,
  });
}

/** Reconciles ONE candidate in ONE transaction. A thrown error (unreadable state) changes nothing; the next sweep retries. */
export async function reconcileSession(
  db: DbExecutor,
  candidate: ReconcileCandidate,
  deps: StepDeps,
): Promise<ReconcileOutcome> {
  if (!gatesOn(deps)) return { kind: "gates_off" };
  try {
    return await withStepTransaction(db, RUNTIME_POLICY.lockTimeoutMs, (tx) =>
      reconcileTx(tx, candidate, deps),
    );
  } catch (error) {
    if (error instanceof SkewRollback) return { kind: "skipped", reason: "clock_skew" };
    throw error;
  }
}

async function reconcileTx(
  tx: DbExecutor,
  candidate: ReconcileCandidate,
  deps: StepDeps,
): Promise<ReconcileOutcome> {
  const org = candidate.organizationId;
  if (!(await tryAdvisoryLock(tx, conversationLockKey(org, candidate.conversationId))))
    return { kind: "skipped", reason: "conversation_busy" };
  await deps.hooks?.afterAdvisoryLocks?.(tx);
  await lockDeploymentsShare(tx, org, [candidate.deploymentId]);
  if ((await lockConversation(tx, org, candidate.conversationId)) === null)
    throw new Error("bot_state_unreadable");
  const live = await lockLiveSession(tx, org, candidate.conversationId);
  if (live === null || live.id !== candidate.sessionId)
    return { kind: "skipped", reason: "not_live" };
  if (live.deploymentId !== candidate.deploymentId) throw new Error("bot_state_unreadable");
  await deps.hooks?.afterRowLocks?.(tx);

  const nowDate = await (deps.readClock ?? dbClock)(tx);
  await deps.hooks?.afterDecisionClock?.(tx, nowDate);
  const deployment = (await readDeployments(tx, org, [live.deploymentId]))[0];
  if (!deployment || deployment.botId !== live.botId) throw new Error("bot_state_unreadable");
  const r = new Reconciliation(tx, deps, live, deployment, nowDate);

  if (deployment.status === "STOPPED" || deployment.status === "RETIRED")
    return r.runtimeEnd(
      "HANDED_OVER",
      "system_handover",
      "deployment_stopped",
      "deployment_stopped",
    );

  if (live.state === "WAITING_FOR_INPUT") {
    if (live.expiresAt === null || r.nowMs < live.expiresAt.getTime())
      return { kind: "skipped", reason: "not_due" };
    const prompt = await readStepRequest(tx, org, live.id, live.stepSeq);
    const deliveryFailed = prompt?.messageStatus === "FAILED";
    return r.engine({ type: "idle_expired", ...(deliveryFailed ? { deliveryFailed: true } : {}) });
  }
  if (live.state !== "WAITING_FOR_SEND") return { kind: "skipped", reason: "not_due" };

  const request = await readStepRequest(tx, org, live.id, live.stepSeq);
  if (request === null) return r.missingRequest();
  switch (request.state) {
    case "ACCEPTED":
    case "REJECTED":
    case "UNKNOWN_OUTCOME":
      return r.engine({ type: "send_result", stepSeq: live.stepSeq, state: request.state });
    case "HELD":
      return r.engine(
        { type: "send_result", stepSeq: live.stepSeq, state: "HELD" },
        request.holdReason ?? undefined,
      );
    case "QUEUED": {
      if (r.nowMs <= queuedRequestOverdueFromMs(request.dispatchDeadline.getTime()))
        return { kind: "skipped", reason: "not_due" };
      const { heldIds } = await suppressSessionQueuedRequests(
        tx,
        org,
        live.id,
        SEND_DEADLINE_HOLD_CODE,
      );
      // A request a dispatcher holds was skipped (never waited for): change nothing; the next sweep re-reads it.
      if (!heldIds.includes(request.id)) return { kind: "skipped", reason: "request_locked" };
      return r.engine(
        { type: "send_result", stepSeq: live.stepSeq, state: "HELD" },
        SEND_DEADLINE_HOLD_CODE,
      );
    }
    case "SENDING":
      if (live.sendWaitExpiresAt === null || r.nowMs <= live.sendWaitExpiresAt.getTime())
        return { kind: "skipped", reason: "not_due" };
      // The provider outcome is unknown: hand over without touching the request; no new request.
      return r.runtimeEnd(
        "HANDED_OVER",
        "system_handover",
        "send_outcome_unresolved",
        "send_outcome_unresolved",
      );
  }
}

class Reconciliation {
  readonly nowMs: number;
  constructor(
    readonly tx: DbExecutor,
    readonly deps: StepDeps,
    readonly live: LiveSessionRow,
    readonly deployment: DeploymentRow,
    readonly nowDate: Date,
  ) {
    this.nowMs = nowDate.getTime();
  }

  private get org() {
    return this.live.organizationId;
  }

  private async event(kind: "HANDED_OVER" | "ERROR", code: string) {
    await insertSessionEvent(this.tx, {
      organizationId: this.org,
      sessionId: this.live.id,
      conversationId: this.live.conversationId,
      kind,
      code,
    });
  }

  /** A runtime-decided end: QUEUED output held, session ended (suppressed, no notice), event, deferred triggers ended. */
  async runtimeEnd(
    state: "HANDED_OVER" | "FAILED" | "COMPLETED",
    endReason: "system_handover" | "error" | "conversation_resolved",
    handoverReason: string | null,
    code: string,
  ): Promise<ReconcileOutcome> {
    await suppressSessionQueuedRequests(
      this.tx,
      this.org,
      this.live.id,
      OUTPUT_SUPPRESSED_HOLD_CODE,
    );
    await endSession(this.tx, {
      organizationId: this.org,
      id: this.live.id,
      expectedRevision: this.live.revision,
      state,
      endReason,
      handoverReason,
    });
    // A resolution completes the session with no session event, as in continue.ts.
    if (state !== "COMPLETED")
      await this.event(state === "HANDED_OVER" ? "HANDED_OVER" : "ERROR", code);
    await endConversationTriggers(this.tx, {
      organizationId: this.org,
      conversationId: this.live.conversationId,
    });
    return { kind: "applied", action: code, finalState: state };
  }

  /** J.5a: WAITING_FOR_SEND with no request row for its step, observed under the locks. */
  async missingRequest(): Promise<ReconcileOutcome> {
    const outcome = await this.runtimeEnd("FAILED", "error", null, "send_state_missing");
    emitBotRuntimeLog({
      event: "bots.send_state_missing",
      outcome: "failure",
      organizationId: this.org,
      conversationId: this.live.conversationId,
      sessionId: this.live.id,
      reason: "send_state_missing",
    });
    return outcome;
  }

  /** Runs the pinned flow's engine on `event` and writes its result through the ONE apply path. */
  async engine(event: ReconcileEvent, handoverEventCode?: string): Promise<ReconcileOutcome> {
    const loaded = await this.deps.flows.load(
      this.tx,
      this.org,
      this.live.botId,
      this.live.botVersionId,
    );
    if (!loaded.ok) {
      await this.runtimeEnd("HANDED_OVER", "system_handover", "bot_error", "bot_error");
      await this.event("ERROR", loaded.reason === "missing" ? "flow_missing" : "flow_invalid");
      return { kind: "applied", action: "flow_invalid", finalState: "HANDED_OVER" };
    }
    const result = step(loaded.flow, sessionFromRow(this.live), event, {
      nowMs: this.nowMs,
      promptToken: this.deps.newPromptToken(),
    });
    if (!result.changed) return { kind: "skipped", reason: "not_due" };
    // I.1 / J.2 rules 4-7 (08E-8D1): an ACCEPTED MESSAGE moves the flow on (a next send, or a terminal transition with or
    // without a notice). Staff control sequenced after the session started decides its fate first, under these same locks and
    // with continue.ts's classifier: HANDED_OVER staff_* or COMPLETED conversation_resolved. Only a prompt's acceptance (now
    // WAITING_FOR_INPUT, no next send) keeps the deferred takeover of plan R-8.
    if (
      event.type === "send_result" &&
      event.state === "ACCEPTED" &&
      result.outcome !== "WAITING_FOR_INPUT"
    ) {
      const fate = classifyTakeover(
        await readStaffControlAfter(
          this.tx,
          this.org,
          this.live.conversationId,
          this.live.startedControlSeq,
        ),
      );
      if (fate !== null)
        return this.runtimeEnd(
          fate.state,
          fate.endReason,
          fate.handoverReason,
          fate.handoverReason ?? fate.endReason,
        );
    }
    const c: ApplyContext = {
      tx: this.tx,
      deps: this.deps,
      nowDate: this.nowDate,
      nowMs: this.nowMs,
      trigger: { organizationId: this.org },
    };
    const ref: LiveRef = {
      id: this.live.id,
      revision: this.live.revision,
      botId: this.live.botId,
      botVersionId: this.live.botVersionId,
      deploymentId: this.live.deploymentId,
      whatsappAccountId: this.live.whatsappAccountId,
      contactId: this.live.contactId,
      conversationId: this.live.conversationId,
      state: this.live.state,
    };
    const applied = await applyEngineResult({
      c,
      session: ref,
      sendEpoch: this.deployment.sendEpoch,
      result,
      input: null,
      ...(handoverEventCode === undefined ? {} : { handoverEventCode }),
      suppressOnEnd: true,
    });
    // A terminal result holds the session's queued output, EXCEPT when it has just authorized a terminal notice: that notice is
    // the session's one in-flight BOT request (outbound_requests_bot_inflight_uidx allows no other), so holding nothing here
    // exempts only it; the dispatcher's claim and final authorization still apply every Stop/epoch/staff/deadline rule.
    if (!LIVE.has(applied.finalState) && applied.noticeRequestId === null)
      await suppressSessionQueuedRequests(
        this.tx,
        this.org,
        this.live.id,
        OUTPUT_SUPPRESSED_HOLD_CODE,
      );
    return {
      kind: "applied",
      action:
        event.type === "idle_expired" ? "idle_expired" : `send_result_${event.state.toLowerCase()}`,
      finalState: applied.finalState,
    };
  }
}

export type SweepSummary = {
  readonly terminalized: number;
  readonly reconciled: number;
  readonly skipped: number;
  readonly failed: number;
  readonly overdueConversations: number;
};

/**
 * One sweep (J.1): terminalization -> reconciliation of every candidate -> the J.4a overdue audit. Each candidate is its own
 * transaction; a failure of one changes nothing and does not stop the others (the next sweep retries it). Starts no loop.
 */
export async function sweepOnce(db: DbExecutor, deps: StepDeps, limit = 50): Promise<SweepSummary> {
  if (!gatesOn(deps))
    return { terminalized: 0, reconciled: 0, skipped: 0, failed: 0, overdueConversations: 0 };
  let terminalized = 0;
  let reconciled = 0;
  let skipped = 0;
  let failed = 0;
  for (const c of await listTerminalizationCandidates(db, limit)) {
    try {
      if ((await terminalizeTrigger(db, c)).kind === "dead") terminalized++;
      else skipped++;
    } catch {
      failed++;
    }
  }
  for (const c of await listCandidates(db, limit)) {
    try {
      const outcome = await reconcileSession(db, c, deps);
      if (outcome.kind === "applied") reconciled++;
      else skipped++;
    } catch {
      failed++;
    }
  }
  const overdueConversations = await auditOverdueTriggers(db);
  return { terminalized, reconciled, skipped, failed, overdueConversations };
}
