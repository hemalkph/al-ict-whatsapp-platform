import { matchTrigger, type Trigger, type TriggerKind } from "@/modules/bots";
import { isEligibleMessageType, isStaleInput, RUNTIME_POLICY } from "./policy";

// Whether a trigger may START a session (Phase 08E-1; V3.2 H.2 as corrected, plan sections D.4, D.4a, E.3). PURE: the runtime
// gathers a `StartFacts` struct once, in the step transaction, after the locks and after the database decision clock
// (K.1 step 8), and this function applies the rules in V3.2's order. It reads no clock, no database, no environment.
//
// Order of evaluation (the first failure is the outcome): 1, 2, 3, 4, 7a (staleness, before rule 5 may defer), 5, 6, 7b, 8, 9, 10.
// A conversation that already has a live session is a CONTINUATION: the start rules do not apply to it, and the result says
// so without evaluating them (the caller routes by the live session; staleness for a continuation is the caller's first
// content check, G.4).

export type DeploymentStatus = "ACTIVE" | "PAUSED" | "STOPPED" | "RETIRED";

export type DeploymentFact = {
  readonly id: string;
  /** Lower first; unique per account among non-retired deployments. */
  readonly priority: number;
  readonly status: DeploymentStatus;
  /** The database clock at the latest activation or resume (epoch ms). */
  readonly startEligibleFromMs: number;
  /** The triggers of the deployment's PINNED version. */
  readonly triggers: readonly Trigger[];
};

export type StartFacts = {
  readonly trigger: {
    /** The conversation's control_seq as the inbound transaction saw it (t). */
    readonly observedControlSeq: number;
    /** The message's effective activity time (epoch ms). */
    readonly inputOccurredAtMs: number;
    /** When the trigger row was enqueued (epoch ms, database clock). */
    readonly enqueuedAtMs: number;
  };
  /** The persisted trigger message, re-read under the locks (never the webhook payload). */
  readonly message: { readonly type: string; readonly body: string | null };
  /** The database decision clock (epoch ms). */
  readonly nowMs: number;
  /** A live session of this conversation exists: the input is a continuation, not a start. */
  readonly hasLiveSession: boolean;

  // ---- staff control (rules 1 to 4); sequences are per-conversation control_seq values
  /** The largest control_seq of any staff control event (conversation event or STAFF request); null when none has a sequence. */
  readonly maxStaffControlSeq: number | null;
  /** The largest handover_control_seq of a HANDED_OVER session of the conversation. */
  readonly latestHandoverSeq: number | null;
  /** The largest control_seq of a staff control event that is NOT a resolution (reply, assignment, OPEN/PENDING status). */
  readonly latestNonResolutionStaffSeq: number | null;
  /** A pre-0008 non-resolution staff row (NULL control_seq) exists: it counts as sequence 0 for O and is ignored for L. */
  readonly hasLegacyNonResolutionStaffRow: boolean;
  /** The LATEST resolution only (largest control_seq of a STATUS event to RESOLVED); an earlier one is never used. */
  readonly latestResolution: { readonly seq: number; readonly createdAtMs: number } | null;
  readonly conversationStatus: "OPEN" | "PENDING" | "RESOLVED";
  readonly assignedMembershipId: string | null;

  // ---- rate and history (rules 5 to 7)
  /** A BOT request of the conversation is QUEUED or SENDING (for example a previous session's terminal notice). */
  readonly botRequestInFlight: boolean;
  /** When the conversation's latest session ended (epoch ms); null when it has none. */
  readonly lastSessionEndedAtMs: number | null;
  /** started_at of every session of THIS CONTACT in the organization (any account, any conversation, any state). */
  readonly contactSessionStartsMs: readonly number[];
  /** The effective time of the latest input already consumed in the conversation; null when none. */
  readonly lastConsumedInputAtMs: number | null;

  // ---- deployments, tenancy (rules 8 and 9)
  readonly deployments: readonly DeploymentFact[];
  readonly accountActive: boolean;
  readonly contactArchived: boolean;
  /** The trigger's organization owns the conversation, the account and the contact. */
  readonly organizationAgrees: boolean;

  // ---- trigger matching (rule 10), derived by deriveFirstEligibleFact and isValidAttribution
  readonly firstEligible: boolean;
  readonly hasAttribution: boolean;
};

export type IgnoreCode =
  | "superseded_by_staff"
  | "handover_unresolved"
  | "staff_engaged"
  | "input_before_resolution"
  | "conversation_resolved"
  | "conversation_assigned"
  | "stale_trigger"
  | "cooldown"
  | "session_cap"
  | "late_input"
  | "deployment_not_active"
  | "before_activation"
  | "account_inactive"
  | "contact_archived"
  | "organization_mismatch"
  | "no_trigger_match";

export type StartDecision =
  /** A live session exists: handle the input as a continuation. No start rule was evaluated. */
  | { readonly outcome: "continuation" }
  /** Not stale, but a BOT request is still in flight: defer through the fenced protocol (K.1a). */
  | { readonly outcome: "defer"; readonly code: "bot_request_in_flight" }
  | { readonly outcome: "ignore"; readonly code: IgnoreCode }
  | {
      readonly outcome: "start";
      readonly deployment: DeploymentFact;
      readonly trigger: { readonly index: number; readonly kind: TriggerKind };
    };

const ignore = (code: IgnoreCode): StartDecision => ({ outcome: "ignore", code });

export function evaluateStartEligibility(facts: StartFacts): StartDecision {
  if (facts.hasLiveSession) return { outcome: "continuation" };
  const { trigger, nowMs } = facts;
  const t = trigger.observedControlSeq;

  // Rule 1: not superseded by staff. Any staff control event sequenced after the input was observed means staff acted since.
  if (facts.maxStaffControlSeq !== null && facts.maxStaffControlSeq > t)
    return ignore("superseded_by_staff");

  // Rule 2: no open handover or staff engagement. O = the latest open-ownership mark; L = the latest resolution only.
  const marks: number[] = [];
  if (facts.latestHandoverSeq !== null) marks.push(facts.latestHandoverSeq);
  if (facts.latestNonResolutionStaffSeq !== null) marks.push(facts.latestNonResolutionStaffSeq);
  if (facts.hasLegacyNonResolutionStaffRow) marks.push(0);
  const O = marks.length === 0 ? null : Math.max(...marks);
  const L = facts.latestResolution;
  if (O !== null && !(L !== null && L.seq > O))
    return ignore(
      facts.latestHandoverSeq !== null && facts.latestHandoverSeq === O
        ? "handover_unresolved"
        : "staff_engaged",
    );

  // Rule 3: fresh relative to the latest resolution, in sequence and in content time (a content-freshness filter only).
  if (L !== null && (t < L.seq || trigger.inputOccurredAtMs <= L.createdAtMs))
    return ignore("input_before_resolution");

  // Rule 4: the conversation is not resolved and not assigned now.
  if (facts.conversationStatus === "RESOLVED") return ignore("conversation_resolved");
  if (facts.assignedMembershipId !== null) return ignore("conversation_assigned");

  // Rule 7a: staleness is evaluated before rule 5 can defer (V3.2 H.2 ordering exception).
  if (isStaleInput(nowMs, trigger.inputOccurredAtMs)) return ignore("stale_trigger");

  // Rule 5: a BOT request still in flight defers the start (a previous session's terminal notice, say).
  if (facts.botRequestInFlight) return { outcome: "defer", code: "bot_request_in_flight" };

  // Rule 6: cooldown, then the per-contact session cap.
  const quietFrom = Math.max(facts.lastSessionEndedAtMs ?? -Infinity, L?.createdAtMs ?? -Infinity);
  if (quietFrom !== -Infinity && nowMs < quietFrom + RUNTIME_POLICY.cooldownMs)
    return ignore("cooldown");
  const windowStart = nowMs - RUNTIME_POLICY.contactSessionWindowMs;
  const recentSessions = facts.contactSessionStartsMs.filter((s) => s > windowStart).length;
  if (recentSessions >= RUNTIME_POLICY.contactSessionCap) return ignore("session_cap");

  // Rule 7b: not older than the last input already consumed.
  if (
    facts.lastConsumedInputAtMs !== null &&
    trigger.inputOccurredAtMs < facts.lastConsumedInputAtMs
  )
    return ignore("late_input");

  // Rule 8: an ACTIVE deployment whose activation preceded the trigger's enqueue.
  const active = facts.deployments.filter((d) => d.status === "ACTIVE");
  if (active.length === 0) return ignore("deployment_not_active");
  const activated = active.filter((d) => trigger.enqueuedAtMs >= d.startEligibleFromMs);
  if (activated.length === 0) return ignore("before_activation");

  // Rule 9: organization, account and contact.
  if (!facts.organizationAgrees) return ignore("organization_mismatch");
  if (!facts.accountActive) return ignore("account_inactive");
  if (facts.contactArchived) return ignore("contact_archived");

  // Rule 10: the first matching explicit trigger of a deployment's pinned version, deployments in ascending priority.
  const ordered = [...activated].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
  for (const deployment of ordered) {
    const match = matchTrigger(deployment.triggers, facts.message, {
      firstEligible: facts.firstEligible,
      hasAttribution: facts.hasAttribution,
    });
    if (match) return { outcome: "start", deployment, trigger: match };
  }
  return ignore("no_trigger_match");
}

// ------------------------------------------------------------------------------------------------ first_message (D.4a)

/** A message header as the first-message check sees it (no body, no content: headers are what must be retained). */
export type MessageHeader = {
  readonly id: string;
  /** messages.created_at, as an integer in any consistent unit (microseconds in the SQL; the model does not care). */
  readonly createdAt: number;
  readonly direction: "INBOUND" | "OUTBOUND";
  readonly type: string;
};

export type PriorSessionStart = {
  /** The message that started the session; null when it cannot be found (a defect). */
  readonly startMessage: {
    readonly direction: "INBOUND" | "OUTBOUND";
    readonly type: string;
  } | null;
};

export const isEligibleInbound = (m: { direction: string; type: string }): boolean =>
  m.direction === "INBOUND" && isEligibleMessageType(m.type);

/** (created_at, id) < (created_at, id), ids compared as canonical lower-case UUID text (PostgreSQL's uuid order). */
export function recordOrderBefore(
  a: Pick<MessageHeader, "createdAt" | "id">,
  b: Pick<MessageHeader, "createdAt" | "id">,
): boolean {
  return a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
}

export type FirstEligibleFact = {
  readonly candidateEligible: boolean;
  readonly firstInRecordHistory: boolean;
  readonly noPreviousSessionStart: boolean;
  /** A previous session's start message is missing or not an eligible inbound message: a state defect, handled fail-closed. */
  readonly evidenceDefect: boolean;
  /** candidateEligible AND firstInRecordHistory AND noPreviousSessionStart AND no defect. */
  readonly firstEligible: boolean;
};

/**
 * The pure model of D.4a's two locked history checks (the SQL runs them under the conversation FOR UPDATE, in a fresh READ
 * COMMITTED statement): the candidate must be an eligible INBOUND message, no earlier eligible INBOUND header may exist by
 * (created_at, id) (provider timestamps are never consulted), and the conversation must have NO previous session of any
 * state. Session history is evidence whatever its state, redaction or trigger kind; a start message that is missing or not an
 * eligible inbound message is a defect and makes the fact false (fail closed).
 */
export function deriveFirstEligibleFact(input: {
  readonly candidate: MessageHeader;
  /** Every retained message header of the conversation (the candidate may be included). */
  readonly history: readonly MessageHeader[];
  readonly priorSessionStarts: readonly PriorSessionStart[];
}): FirstEligibleFact {
  const candidateEligible = isEligibleInbound(input.candidate);
  const firstInRecordHistory = !input.history.some(
    (h) =>
      h.id !== input.candidate.id && isEligibleInbound(h) && recordOrderBefore(h, input.candidate),
  );
  return combineFirstEligibleFact({
    candidateEligible,
    firstInRecordHistory,
    noPreviousSessionStart: input.priorSessionStarts.length === 0,
    evidenceDefect: input.priorSessionStarts.some(
      (s) => s.startMessage === null || !isEligibleInbound(s.startMessage),
    ),
  });
}

/**
 * The same fact from the four booleans the step transaction's database statement computes under the conversation lock
 * (record order is compared inside the database at full precision; see readFirstEligibleRows). One rule, two inputs.
 */
export function combineFirstEligibleFact(
  parts: Omit<FirstEligibleFact, "firstEligible">,
): FirstEligibleFact {
  return {
    ...parts,
    firstEligible:
      parts.candidateEligible &&
      parts.firstInRecordHistory &&
      parts.noPreviousSessionStart &&
      !parts.evidenceDefect,
  };
}

// ---------------------------------------------------------------------------------------------------- referral (C-3)

/**
 * C-3: a valid recorded attribution is a lead_attributions row linked to the EXACT inbound message, in the SAME organization,
 * for the SAME contact as the locked conversation. No source id, URL or source-type filter.
 */
export function isValidAttribution(
  attribution: {
    readonly organizationId: string;
    readonly messageId: string;
    readonly contactId: string;
  } | null,
  expected: {
    readonly organizationId: string;
    readonly messageId: string;
    readonly contactId: string;
  },
): boolean {
  return (
    attribution !== null &&
    attribution.organizationId === expected.organizationId &&
    attribution.messageId === expected.messageId &&
    attribution.contactId === expected.contactId
  );
}
