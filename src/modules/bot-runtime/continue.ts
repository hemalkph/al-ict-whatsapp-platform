import { endSession, insertSessionEvent, readStepRequest } from "@/db/ops/bot-session-store";
import {
  readDeployments,
  readStaffControlAfter,
  type LiveSessionRow,
  type TriggerMessageRow,
} from "@/db/ops/bot-step";
import { step, type RequestState } from "@/modules/bots";
import { applyEngineResult } from "./apply";
import { deferStep, finishStep, type StepContext, type StepSummary } from "./context";
import { toStudentInput } from "./input";
import { isStaleInput } from "./policy";
import { sessionFromRow } from "./session-row";
import { classifyTakeover } from "./takeover";
import { endConversationTriggers } from "./trigger-queue";

// The CONTINUATION path of T1 (Phase 08E-4; plan sections G, I.1): the conversation has a live session, re-read under the
// session lock. Order is fixed: staleness FIRST (G.4: before duplicate detection, takeover, deferral or the engine), then the
// deployment and staff-takeover checks, then the pinned flow, then the engine with the latest request state.

export async function continuationPath(
  c: StepContext,
  live: LiveSessionRow,
  message: TriggerMessageRow,
): Promise<StepSummary> {
  const { tx, trigger, conversation } = c;
  const org = trigger.organizationId;

  // Tenant and ownership agree with the locked conversation, or the state is unreadable (T2), never repaired.
  if (
    live.organizationId !== org ||
    live.whatsappAccountId !== trigger.whatsappAccountId ||
    live.contactId !== conversation.contactId
  )
    throw new Error("bot_state_unreadable");

  // G.4: an input older than maxInputAge is ignored before anything else; it writes nothing to the session.
  if (isStaleInput(c.nowMs, trigger.inputOccurredAt.getTime()))
    return finishStep(c, "IGNORED", "stale_trigger");

  const deployment = (await readDeployments(tx, org, [live.deploymentId]))[0];
  if (!deployment || deployment.botId !== live.botId) throw new Error("bot_state_unreadable");
  // Stop hands live sessions over in its own transaction; a live session of a stopped deployment is the sweeper's (08E-6).
  if (deployment.status === "STOPPED" || deployment.status === "RETIRED")
    return finishStep(c, "IGNORED", "session_ended");

  const ref = {
    id: live.id,
    revision: live.revision,
    botId: live.botId,
    botVersionId: live.botVersionId,
    deploymentId: live.deploymentId,
    whatsappAccountId: live.whatsappAccountId,
    contactId: live.contactId,
    conversationId: live.conversationId,
    state: live.state,
  };

  // I.1: staff control sequenced after the session started ends it now. The queued request (if any) is held by the
  // dispatcher because output_suppressed_at is set in this transaction; session-scoped suppression is 08E-5.
  const fate = classifyTakeover(
    await readStaffControlAfter(tx, org, live.conversationId, live.startedControlSeq),
  );
  if (fate !== null) {
    await endSession(tx, {
      organizationId: org,
      id: live.id,
      expectedRevision: live.revision,
      state: fate.state,
      endReason: fate.endReason,
      handoverReason: fate.handoverReason,
    });
    if (fate.state === "HANDED_OVER")
      await insertSessionEvent(tx, {
        organizationId: org,
        sessionId: live.id,
        conversationId: live.conversationId,
        kind: "HANDED_OVER",
        code: fate.handoverReason,
      });
    await endConversationTriggers(tx, {
      organizationId: org,
      conversationId: live.conversationId,
      exceptId: trigger.id,
    });
    return finishStep(c, "IGNORED", "session_ended", live.id);
  }

  // The pinned flow. Missing or invalid: a defect an immutable version cannot cure; hand over, do not retry.
  const loaded = await c.deps.flows.load(tx, org, live.botId, live.botVersionId);
  if (!loaded.ok) {
    await endSession(tx, {
      organizationId: org,
      id: live.id,
      expectedRevision: live.revision,
      state: "HANDED_OVER",
      endReason: "system_handover",
      handoverReason: "bot_error",
    });
    await insertSessionEvent(tx, {
      organizationId: org,
      sessionId: live.id,
      conversationId: live.conversationId,
      kind: "HANDED_OVER",
      code: "bot_error",
    });
    await insertSessionEvent(tx, {
      organizationId: org,
      sessionId: live.id,
      conversationId: live.conversationId,
      kind: "ERROR",
      code: loaded.reason === "missing" ? "flow_missing" : "flow_invalid",
    });
    await endConversationTriggers(tx, {
      organizationId: org,
      conversationId: live.conversationId,
      exceptId: trigger.id,
    });
    return finishStep(c, "PROCESSED", "flow_invalid", live.id);
  }

  // The request of the session's current step: the state a WAITING_FOR_SEND input depends on, and the prompt's wamid.
  const request = await readStepRequest(tx, org, live.id, live.stepSeq);
  if (live.state === "WAITING_FOR_SEND" && request === null)
    // No request to wait on: the reconciler (08E-6) fails such a session; until then the input is deferred, then stale.
    return deferStep(c, "send_state_missing");

  const input = toStudentInput(message, request?.wamid ?? null);
  if (input === null) return finishStep(c, "IGNORED", "message_invalid");

  const result = step(
    loaded.flow,
    sessionFromRow(live),
    {
      type: "student_input",
      input,
      ...(live.state === "WAITING_FOR_SEND"
        ? { latestRequestState: request!.state as RequestState }
        : {}),
    },
    { nowMs: c.nowMs, promptToken: c.deps.newPromptToken() },
  );
  if (!result.changed && result.input === undefined)
    // The engine refused the event outright (context/flow invalid, unexpected state): a defect, rolled back and recorded.
    throw new Error(`engine_ignored_${result.reason ?? "unknown"}`);

  const applied = await applyEngineResult({
    c,
    session: ref,
    sendEpoch: deployment.sendEpoch,
    result,
    input: { messageId: trigger.messageId, occurredAt: trigger.inputOccurredAt },
    ...(request?.state === "HELD" && request.holdReason
      ? { handoverEventCode: `send_held_${request.holdReason}`.slice(0, 64) }
      : {}),
  });

  if (applied.sendRefusedHandover) return finishStep(c, "PROCESSED", "send_refused", live.id);
  switch (result.input?.result) {
    case "deferred":
      return deferStep(c, "request_in_flight");
    case "duplicate":
      return finishStep(c, "IGNORED", "duplicate_reply", live.id);
    case "not_awaited":
      return finishStep(c, "IGNORED", "session_ended", live.id);
    case "accepted":
      return finishStep(c, "PROCESSED", "input_accepted", live.id);
    case "invalid":
      return finishStep(c, "PROCESSED", "input_rejected", live.id);
    case "expired":
      return finishStep(c, "PROCESSED", "idle_expired", live.id);
    default:
      return finishStep(c, "PROCESSED", result.error ? "engine_error" : "processed", live.id);
  }
}
