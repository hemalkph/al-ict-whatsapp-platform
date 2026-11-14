import { insertLiveSession } from "@/db/ops/bot-session-store";
import {
  readAttributions,
  readDeployments,
  readFirstEligibleRows,
  readStartFacts,
  type LockedAccount,
  type TriggerMessageRow,
} from "@/db/ops/bot-step";
import { step, type FlowConfig } from "@/modules/bots";
import { applyEngineResult } from "./apply";
import { deferStep, finishStep, type StepContext, type StepSummary } from "./context";
import {
  combineFirstEligibleFact,
  evaluateStartEligibility,
  isEligibleInbound,
  isValidAttribution,
  type DeploymentFact,
  type StartFacts,
} from "./eligibility";
import { RUNTIME_POLICY } from "./policy";

// The START path of T1 (Phase 08E-4; plan sections D.4, D.4a, E.2, E.3): the conversation has no live session, so the
// trigger may create one. All facts are read under the step locks and the decision clock; the pure evaluator applies the
// reviewed rules in their reviewed order; the engine's `start` event runs; the triggering message is NEVER replayed to the
// engine as input (it becomes started_by_message_id and last_input_message_id).

export async function startPath(
  c: StepContext,
  message: TriggerMessageRow,
  deploymentIds: readonly string[],
  account: LockedAccount,
): Promise<StepSummary> {
  const { tx, trigger, conversation } = c;
  const org = trigger.organizationId;
  const deployments = await readDeployments(tx, org, deploymentIds);

  // Pinned versions of the ACTIVE deployments. An invalid or missing one has no triggers (it can never match).
  const flows = new Map<string, FlowConfig>();
  const deploymentFacts: DeploymentFact[] = [];
  for (const d of deployments) {
    let triggers: FlowConfig["triggers"] = [];
    if (d.status === "ACTIVE") {
      const loaded = await c.deps.flows.load(tx, org, d.botId, d.versionId);
      if (loaded.ok) {
        flows.set(d.id, loaded.flow);
        triggers = loaded.flow.triggers;
      }
    }
    deploymentFacts.push({
      id: d.id,
      priority: d.priority,
      status: d.status,
      startEligibleFromMs: d.startEligibleFrom.getTime(),
      triggers,
    });
  }

  const rows = await readStartFacts(tx, {
    organizationId: org,
    conversationId: trigger.conversationId,
    contactId: conversation.contactId,
    decisionClock: c.nowDate,
    contactWindowMs: RUNTIME_POLICY.contactSessionWindowMs,
  });
  const history = await readFirstEligibleRows(tx, {
    organizationId: org,
    conversationId: trigger.conversationId,
    messageId: trigger.messageId,
  });
  const firstEligible = combineFirstEligibleFact({
    candidateEligible: isEligibleInbound({ direction: message.direction, type: message.type }),
    ...history,
  });
  const attributions = await readAttributions(tx, org, trigger.messageId);
  const hasAttribution = attributions.some((a) =>
    isValidAttribution(a, {
      organizationId: org,
      messageId: trigger.messageId,
      contactId: conversation.contactId,
    }),
  );

  const facts: StartFacts = {
    trigger: {
      observedControlSeq: trigger.observedControlSeq,
      inputOccurredAtMs: trigger.inputOccurredAt.getTime(),
      enqueuedAtMs: trigger.enqueuedAt.getTime(),
    },
    message: { type: message.type, body: message.body },
    nowMs: c.nowMs,
    hasLiveSession: false,
    maxStaffControlSeq: rows.maxStaffControlSeq,
    latestHandoverSeq: rows.latestHandoverSeq,
    latestNonResolutionStaffSeq: rows.latestNonResolutionStaffSeq,
    hasLegacyNonResolutionStaffRow: rows.hasLegacyNonResolutionStaffRow,
    latestResolution: rows.latestResolution
      ? { seq: rows.latestResolution.seq, createdAtMs: rows.latestResolution.createdAt.getTime() }
      : null,
    conversationStatus: conversation.status,
    assignedMembershipId: conversation.assignedMembershipId,
    botRequestInFlight: rows.botRequestInFlight,
    lastSessionEndedAtMs: rows.lastSessionEndedAt?.getTime() ?? null,
    contactSessionStartsMs: rows.contactSessionStarts.map((d) => d.getTime()),
    lastConsumedInputAtMs: rows.lastConsumedInputAt?.getTime() ?? null,
    deployments: deploymentFacts,
    accountActive: account.active,
    contactArchived: rows.contactArchived,
    organizationAgrees: conversation.whatsappAccountId === trigger.whatsappAccountId,
    firstEligible: firstEligible.firstEligible,
    hasAttribution,
  };

  const decision = evaluateStartEligibility(facts);
  switch (decision.outcome) {
    case "continuation":
      // Impossible here (hasLiveSession is false); fail closed rather than guess.
      throw new Error("start_path_continuation");
    case "defer":
      return deferStep(c, decision.code);
    case "ignore":
      return finishStep(c, "IGNORED", decision.code);
    case "start":
      break;
  }

  await c.deps.hooks?.afterStartDecision?.(tx);
  const deployment = deployments.find((d) => d.id === decision.deployment.id)!;
  const flow = flows.get(deployment.id)!;
  // The engine runs BEFORE the session row is inserted: a start that changes nothing (broken flow) leaves no session behind.
  const result = step(
    flow,
    null,
    { type: "start" },
    { nowMs: c.nowMs, promptToken: c.deps.newPromptToken() },
  );
  if (!result.changed || result.session === null) return finishStep(c, "IGNORED", "flow_invalid");

  // E.2: insert LIVE first (the request references it), then enqueue, then update to the engine's final state.
  const created = await insertLiveSession(tx, {
    organizationId: org,
    botId: deployment.botId,
    botVersionId: deployment.versionId,
    deploymentId: deployment.id,
    whatsappAccountId: trigger.whatsappAccountId,
    contactId: conversation.contactId,
    conversationId: trigger.conversationId,
    startedByMessageId: trigger.messageId,
    startNodeId: flow.startNodeId,
    inputOccurredAt: trigger.inputOccurredAt,
  });
  const applied = await applyEngineResult({
    c,
    session: {
      id: created.id,
      revision: created.revision,
      botId: deployment.botId,
      botVersionId: deployment.versionId,
      deploymentId: deployment.id,
      whatsappAccountId: trigger.whatsappAccountId,
      contactId: conversation.contactId,
      conversationId: trigger.conversationId,
      state: "ACTIVE",
    },
    sendEpoch: deployment.sendEpoch,
    result,
    input: null,
  });
  return finishStep(
    c,
    "PROCESSED",
    applied.sendRefusedHandover ? "send_refused" : "session_started",
    created.id,
  );
}
