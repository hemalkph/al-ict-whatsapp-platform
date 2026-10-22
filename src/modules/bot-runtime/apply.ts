import {
  endSession,
  insertSessionEvent,
  writeSession,
  type SessionEventWrite,
} from "@/db/ops/bot-session-store";
import { dbClock } from "@/db/ops/bot-step";
import type { StepResult } from "@/modules/bots";
import type { StepContext } from "./context";
import { enqueueEffect, type AutomationAuthority } from "./outbound";
import { RUNTIME_POLICY, sendWaitExpiresAtMs } from "./policy";
import { sessionToColumns } from "./session-row";
import { endConversationTriggers, wakeConversationTriggers } from "./trigger-queue";

// applyEngineResult (Phase 08E-4; plan section F.3): the ONE path that turns an engine StepResult into rows. It is used for a
// start, a student input and (08E-6) a send result or idle expiry. Everything it writes is on the step transaction, so the
// session change, its events, the outbound request and (in the caller) the trigger outcome commit together or not at all.
//
// Order (E.2 rule 4): the live session row already exists (a start inserts it first) -> the request is enqueued -> the session
// is updated to the engine's final state -> events -> wake/end of the conversation's other triggers. The caller finishes or
// defers the trigger afterwards.

/** Thrown inside T1 when more than postEnqueueSkewMs passed since the decision clock; the whole step rolls back (K.1). */
export class SkewRollback extends Error {
  constructor() {
    super("post_enqueue_clock_skew");
    this.name = "SkewRollback";
  }
}

export type LiveRef = {
  readonly id: string;
  readonly revision: number;
  readonly botId: string;
  readonly botVersionId: string;
  readonly deploymentId: string;
  readonly whatsappAccountId: string;
  readonly contactId: string;
  readonly conversationId: string;
  /** The state before this step (WAITING_FOR_SEND decides the wake). */
  readonly state: string;
};

export type ApplyInput = {
  readonly c: StepContext;
  readonly session: LiveRef;
  /** The deployment's send_epoch read under its FOR SHARE lock. */
  readonly sendEpoch: number;
  readonly result: StepResult;
  /** The student message this step consumes or defers (an input step); null for a start. */
  readonly input: { readonly messageId: string; readonly occurredAt: Date } | null;
  /** The fixed code recorded on a HANDED_OVER event when it differs from the handover reason (send_held_<hold code>). */
  readonly handoverEventCode?: string;
};

export type ApplyOutcome = {
  /** The session row was written. */
  readonly committed: boolean;
  readonly finalState: string;
  /** The enqueue refusal (ordinary refusal or hourly cap), if there was one. */
  readonly refusal: string | null;
  /** True when a refused non-notice send handed the session over (the engine's result was discarded). */
  readonly sendRefusedHandover: boolean;
  readonly requestId: string | null;
  readonly replayed: boolean;
};

const CODE = /^[a-z0-9_]{1,64}$/;
const code = (s: string): string =>
  CODE.test(s)
    ? s
    : s
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .slice(0, 64) || "unknown";
const LIVE_AFTER = new Set(["ACTIVE", "WAITING_FOR_SEND", "WAITING_FOR_INPUT"]);

export async function applyEngineResult(a: ApplyInput): Promise<ApplyOutcome> {
  const { c, result, session, input } = a;
  const org = c.trigger.organizationId;
  const base = {
    organizationId: org,
    sessionId: session.id,
    conversationId: session.conversationId,
  };
  const ev = (e: Omit<SessionEventWrite, keyof typeof base>): SessionEventWrite => ({
    ...base,
    ...e,
  });
  const next = result.session;
  const events: SessionEventWrite[] = [];

  // Input events (INPUT_ACCEPTED / INPUT_REJECTED / PROMPT_INTERACTION): unique per (session, message).
  const inputResult = result.input;
  if (input !== null && inputResult !== undefined) {
    if (inputResult.result === "accepted")
      events.push(
        ev({ kind: "INPUT_ACCEPTED", messageId: input.messageId, stepSeq: next?.stepSeq }),
      );
    else if (inputResult.result === "invalid")
      events.push(
        ev({
          kind: "INPUT_REJECTED",
          messageId: input.messageId,
          stepSeq: next?.stepSeq,
          code: code(inputResult.reason),
        }),
      );
    else if (inputResult.result === "deferred" && inputResult.promptInteraction)
      events.push(ev({ kind: "PROMPT_INTERACTION", messageId: input.messageId }));
  }

  if (!result.changed || next === null) {
    for (const e of events) await insertSessionEvent(c.tx, e);
    return {
      committed: false,
      finalState: session.state,
      refusal: null,
      sendRefusedHandover: false,
      requestId: null,
      replayed: false,
    };
  }

  // The outbound effect, if any: through the BOT enqueue adapter only, under the step locks.
  const effect = result.effects[0];
  let refusal: string | null = null;
  let requestId: string | null = null;
  let replayed = false;
  if (effect) {
    const authority: AutomationAuthority = {
      kind: "BOT",
      organizationId: org,
      botSessionId: session.id,
      deploymentId: session.deploymentId,
      botVersionId: session.botVersionId,
      whatsappAccountId: session.whatsappAccountId,
      conversationId: session.conversationId,
      contactId: session.contactId,
      sendEpoch: a.sendEpoch,
    };
    const out = await enqueueEffect(c.tx, c.deps, authority, effect, c.nowDate);
    if (out.ok) {
      requestId = out.requestId;
      replayed = out.replayed;
    } else refusal = out.reason;
    await c.deps.hooks?.afterEnqueue?.(c.tx);
    // K.1: a time-dependent value computed from a stale clock is never committed.
    const after = await (c.deps.readClock ?? dbClock)(c.tx);
    if (after.getTime() - c.nowMs > RUNTIME_POLICY.postEnqueueSkewMs) throw new SkewRollback();
  }

  if (refusal !== null && effect && !effect.terminalNotice) {
    // A refused ordinary send: discard the engine's result and hand the session over (the input is not consumed).
    await endSession(c.tx, {
      organizationId: org,
      id: session.id,
      expectedRevision: session.revision,
      state: "HANDED_OVER",
      endReason: "system_handover",
      handoverReason: "send_refused",
    });
    await insertSessionEvent(c.tx, ev({ kind: "HANDED_OVER", code: code(refusal) }));
    await endConversationTriggers(c.tx, {
      organizationId: org,
      conversationId: session.conversationId,
      exceptId: c.trigger.id,
    });
    return {
      committed: true,
      finalState: "HANDED_OVER",
      refusal,
      sendRefusedHandover: true,
      requestId: null,
      replayed: false,
    };
  }

  // A refused terminal notice: the engine's terminal state is committed WITHOUT terminal_notice_step_seq (I.5).
  let final = next;
  if (refusal !== null) {
    final = { ...next, terminalNoticeStepSeq: null };
    events.push(
      ev({ kind: "TERMINAL_NOTICE_NOT_QUEUED", stepSeq: next.stepSeq, code: code(refusal) }),
    );
  }

  const consumed =
    input !== null &&
    (inputResult?.result === "accepted" ||
      inputResult?.result === "invalid" ||
      inputResult?.result === "expired");
  await writeSession(c.tx, {
    organizationId: org,
    id: session.id,
    expectedRevision: session.revision,
    ...sessionToColumns(final),
    sendWaitExpiresAt:
      final.state === "WAITING_FOR_SEND" ? new Date(sendWaitExpiresAtMs(c.nowMs)) : null,
    lastInput: consumed ? input : null,
    suppressOutput: false,
  });

  if (final.state === "HANDED_OVER" && final.handoverReason !== null)
    events.push(
      ev({
        kind: "HANDED_OVER",
        stepSeq: final.stepSeq,
        code: code(a.handoverEventCode ?? final.handoverReason),
      }),
    );
  if (result.error !== undefined || final.state === "FAILED")
    events.push(
      ev({ kind: "ERROR", stepSeq: final.stepSeq, code: code(result.error ?? "engine_internal") }),
    );
  for (const e of events) await insertSessionEvent(c.tx, e);

  // Wake the conversation's deferred triggers when the session stopped waiting for a send; end them with the session.
  const conv = {
    organizationId: org,
    conversationId: session.conversationId,
    exceptId: c.trigger.id,
  };
  if (!LIVE_AFTER.has(final.state)) await endConversationTriggers(c.tx, conv);
  else if (session.state === "WAITING_FOR_SEND" && final.state !== "WAITING_FOR_SEND")
    await wakeConversationTriggers(c.tx, conv);

  return {
    committed: true,
    finalState: final.state,
    refusal,
    sendRefusedHandover: false,
    requestId,
    replayed,
  };
}
