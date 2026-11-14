import { describe, expect, it } from "vitest";
import type { Trigger } from "@/modules/bots";
import {
  deriveFirstEligibleFact,
  evaluateStartEligibility,
  isValidAttribution,
  recordOrderBefore,
  type DeploymentFact,
  type MessageHeader,
  type StartFacts,
} from "./eligibility";
import { RUNTIME_POLICY } from "./policy";

// H.2 start eligibility (V3.2, plan E.3, D.4a) as a pure function. Time is epoch milliseconds; nothing here reads a clock.

const S = 1_000;
const M = 60 * S;
const H = 60 * M;
const NOW = 1_000 * H; // the decision clock
const kw = (...words: string[]): Trigger => ({ kind: "keyword", words });
const deployment = (over: Partial<DeploymentFact> = {}): DeploymentFact => ({
  id: "d-1",
  priority: 1,
  status: "ACTIVE",
  startEligibleFromMs: NOW - 5 * H,
  triggers: [kw("hi")],
  ...over,
});

/** A start that passes every rule: a fresh TEXT "Hi" in a quiet, unassigned conversation with one ACTIVE keyword deployment. */
function facts(over: Partial<StartFacts> = {}): StartFacts {
  return {
    trigger: { observedControlSeq: 0, inputOccurredAtMs: NOW - 5 * S, enqueuedAtMs: NOW - 4 * S },
    message: { type: "TEXT", body: "Hi" },
    nowMs: NOW,
    hasLiveSession: false,
    maxStaffControlSeq: null,
    latestHandoverSeq: null,
    latestNonResolutionStaffSeq: null,
    hasLegacyNonResolutionStaffRow: false,
    latestResolution: null,
    conversationStatus: "OPEN",
    assignedMembershipId: null,
    botRequestInFlight: false,
    lastSessionEndedAtMs: null,
    contactSessionStartsMs: [],
    lastConsumedInputAtMs: null,
    deployments: [deployment()],
    accountActive: true,
    contactArchived: false,
    organizationAgrees: true,
    firstEligible: false,
    hasAttribution: false,
    ...over,
  };
}
const outcome = (over: Partial<StartFacts>) => evaluateStartEligibility(facts(over));
const ignored = (code: string) => ({ outcome: "ignore", code });

describe("the baseline start", () => {
  it("a fresh keyword message in a quiet conversation starts a session through the deployment", () => {
    const d = outcome({});
    expect(d).toMatchObject({ outcome: "start", trigger: { index: 0, kind: "keyword" } });
    if (d.outcome === "start") expect(d.deployment.id).toBe("d-1");
  });
});

describe("rule 5 first half: a live session is a continuation, and no start rule applies", () => {
  it("returns continuation without evaluating anything else", () => {
    // every start rule would fail here, yet the answer is a continuation
    expect(
      outcome({
        hasLiveSession: true,
        maxStaffControlSeq: 99,
        conversationStatus: "RESOLVED",
        assignedMembershipId: "m",
        deployments: [],
        accountActive: false,
      }),
    ).toEqual({ outcome: "continuation" });
  });
});

describe("rule 1: superseded by staff", () => {
  it("any staff control event sequenced after the observation ends the start", () => {
    expect(outcome({ maxStaffControlSeq: 1 })).toEqual(ignored("superseded_by_staff"));
    expect(
      outcome({ maxStaffControlSeq: 5, trigger: { ...facts().trigger, observedControlSeq: 4 } }),
    ).toEqual(ignored("superseded_by_staff"));
  });
  it("an event at or before the observation does not (sequence, not time)", () => {
    expect(outcome({ maxStaffControlSeq: 0 })).toMatchObject({ outcome: "start" });
    expect(
      outcome({ maxStaffControlSeq: 3, trigger: { ...facts().trigger, observedControlSeq: 3 } }),
    ).toMatchObject({
      outcome: "start",
    });
    expect(outcome({ maxStaffControlSeq: null })).toMatchObject({ outcome: "start" });
  });
});

describe("rule 2: no open handover or staff engagement", () => {
  const t = (n: number) => ({ ...facts().trigger, observedControlSeq: n });
  it("an unresolved handover blocks; the code says it was a handover", () => {
    expect(outcome({ latestHandoverSeq: 10, maxStaffControlSeq: 10, trigger: t(10) })).toEqual(
      ignored("handover_unresolved"),
    );
  });
  it("an unresolved staff reply or assignment blocks as staff_engaged", () => {
    expect(
      outcome({ latestNonResolutionStaffSeq: 4, maxStaffControlSeq: 4, trigger: t(4) }),
    ).toEqual(ignored("staff_engaged"));
  });
  it("whichever mark is the latest names the outcome", () => {
    expect(
      outcome({
        latestHandoverSeq: 10,
        latestNonResolutionStaffSeq: 12,
        maxStaffControlSeq: 12,
        trigger: t(12),
      }),
    ).toEqual(ignored("staff_engaged"));
    expect(
      outcome({
        latestHandoverSeq: 12,
        latestNonResolutionStaffSeq: 10,
        maxStaffControlSeq: 12,
        trigger: t(12),
      }),
    ).toEqual(ignored("handover_unresolved"));
  });
  it("a LATER resolution closes it", () => {
    const resolution = { seq: 11, createdAtMs: NOW - H };
    expect(
      outcome({
        latestHandoverSeq: 10,
        latestResolution: resolution,
        maxStaffControlSeq: 11,
        trigger: t(11),
        lastSessionEndedAtMs: NOW - 2 * H,
      }),
    ).toMatchObject({ outcome: "start" });
  });
  it("a resolution BEFORE the mark does not (the latest resolution must follow every mark)", () => {
    expect(
      outcome({
        latestHandoverSeq: 12,
        latestResolution: { seq: 11, createdAtMs: NOW - H },
        maxStaffControlSeq: 12,
        trigger: t(12),
      }),
    ).toEqual(ignored("handover_unresolved"));
  });
  it("a resolution must be strictly LATER than the mark (sequences are unique, so a tie is impossible; the boundary is pinned anyway)", () => {
    expect(
      outcome({
        latestHandoverSeq: 7,
        latestResolution: { seq: 7, createdAtMs: NOW - H },
        maxStaffControlSeq: 7,
        trigger: t(7),
      }),
    ).toEqual(ignored("handover_unresolved"));
  });
  it("a pre-0008 staff row (NULL sequence) counts as sequence 0: open until a resolution with a sequence", () => {
    expect(outcome({ hasLegacyNonResolutionStaffRow: true })).toEqual(ignored("staff_engaged"));
    expect(
      outcome({
        hasLegacyNonResolutionStaffRow: true,
        latestResolution: { seq: 1, createdAtMs: NOW - H },
        maxStaffControlSeq: 1,
        trigger: t(1),
        lastSessionEndedAtMs: NOW - 2 * H,
      }),
    ).toMatchObject({ outcome: "start" });
  });
  it("a legacy row is ignored for the latest-resolution test: no resolution means none", () => {
    expect(
      outcome({ hasLegacyNonResolutionStaffRow: false, latestResolution: null }),
    ).toMatchObject({
      outcome: "start",
    });
  });
});

describe("rule 3: fresh relative to the latest resolution (sequence and content time)", () => {
  const resolution = { seq: 5, createdAtMs: NOW - 40 * M }; // cooldown is over, so only rule 3 is in play
  const t = (inputAt: number, observed = 5) => ({
    observedControlSeq: observed,
    inputOccurredAtMs: inputAt,
    enqueuedAtMs: NOW - S,
  });
  const base = {
    latestResolution: resolution,
    maxStaffControlSeq: 5,
    lastSessionEndedAtMs: NOW - 3 * H,
  };
  it("an input written before the resolution but delivered after is refused", () => {
    expect(outcome({ ...base, trigger: t(NOW - 45 * M) })).toEqual(
      ignored("input_before_resolution"),
    );
    expect(outcome({ ...base, trigger: t(resolution.createdAtMs) })).toEqual(
      ignored("input_before_resolution"),
    );
  });
  it("an input strictly after it, observed at or after the resolution, passes", () => {
    expect(outcome({ ...base, trigger: t(NOW - 5 * S) })).toMatchObject({
      outcome: "start",
    });
  });
});

describe("rule 4: the conversation is open and unassigned now", () => {
  it("resolved and assigned conversations are refused", () => {
    expect(outcome({ conversationStatus: "RESOLVED" })).toEqual(ignored("conversation_resolved"));
    expect(outcome({ assignedMembershipId: "m-1" })).toEqual(ignored("conversation_assigned"));
    expect(outcome({ conversationStatus: "PENDING" })).toMatchObject({ outcome: "start" });
  });
});

describe("rule 7a before rule 5: staleness is decided before a deferral", () => {
  const tr = (ageMs: number) => ({ ...facts().trigger, inputOccurredAtMs: NOW - ageMs });
  it("a stale input ends even when a BOT request is in flight", () => {
    expect(outcome({ botRequestInFlight: true, trigger: tr(10 * M + 1) })).toEqual(
      ignored("stale_trigger"),
    );
  });
  it("a fresh input behind an in-flight request is deferred, not ignored", () => {
    expect(outcome({ botRequestInFlight: true, trigger: tr(5 * S) })).toEqual({
      outcome: "defer",
      code: "bot_request_in_flight",
    });
  });
  it("exactly ten minutes old is still processed; one millisecond more is stale", () => {
    expect(outcome({ trigger: tr(10 * M) })).toMatchObject({ outcome: "start" });
    expect(outcome({ trigger: tr(10 * M + 1) })).toEqual(ignored("stale_trigger"));
  });
  it("rules 1 to 4 still win the outcome code over staleness for a start that could not happen anyway", () => {
    expect(outcome({ maxStaffControlSeq: 1, trigger: tr(11 * M) })).toEqual(
      ignored("superseded_by_staff"),
    );
    expect(outcome({ conversationStatus: "RESOLVED", trigger: tr(11 * M) })).toEqual(
      ignored("conversation_resolved"),
    );
  });
});

describe("rule 6: cooldown, then the per-contact session cap", () => {
  const cooldown = RUNTIME_POLICY.cooldownMs;
  it("cooldown runs 30 minutes from the conversation's latest session end", () => {
    expect(outcome({ lastSessionEndedAtMs: NOW - cooldown + 1 })).toEqual(ignored("cooldown"));
    expect(outcome({ lastSessionEndedAtMs: NOW - cooldown })).toMatchObject({ outcome: "start" });
    expect(outcome({ lastSessionEndedAtMs: NOW - cooldown - 1 })).toMatchObject({
      outcome: "start",
    });
  });
  it("it also runs from the latest resolution's time", () => {
    const resolution = { seq: 3, createdAtMs: NOW - 10 * M };
    expect(
      outcome({
        latestResolution: resolution,
        maxStaffControlSeq: 3,
        trigger: { ...facts().trigger, observedControlSeq: 3 },
        lastSessionEndedAtMs: NOW - 5 * H,
      }),
    ).toEqual(ignored("cooldown"));
  });
  it("two sessions in the last 24 hours allow a third; three do not (any account, any conversation of the contact)", () => {
    const within = (n: number) => Array.from({ length: n }, (_, i) => NOW - (i + 1) * H);
    expect(outcome({ contactSessionStartsMs: within(2) })).toMatchObject({ outcome: "start" });
    expect(outcome({ contactSessionStartsMs: within(3) })).toEqual(ignored("session_cap"));
    expect(outcome({ contactSessionStartsMs: within(9) })).toEqual(ignored("session_cap"));
  });
  it("the window is strictly the 24 hours before the decision clock", () => {
    const edge = NOW - 24 * H;
    expect(outcome({ contactSessionStartsMs: [edge + 1, edge + 2, edge + 3] })).toEqual(
      ignored("session_cap"),
    );
    expect(outcome({ contactSessionStartsMs: [edge, edge, edge] })).toMatchObject({
      outcome: "start",
    }); // exactly 24 h old: out
    expect(outcome({ contactSessionStartsMs: [edge - 1, edge + 1, edge + 2] })).toMatchObject({
      outcome: "start",
    });
  });
  it("cooldown is reported before the cap when both apply", () => {
    expect(
      outcome({
        lastSessionEndedAtMs: NOW - M,
        contactSessionStartsMs: [NOW - H, NOW - 2 * H, NOW - 3 * H],
      }),
    ).toEqual(ignored("cooldown"));
  });
});

describe("rule 7b: not older than the last input already consumed", () => {
  it("an out-of-order older input is late", () => {
    expect(outcome({ lastConsumedInputAtMs: NOW - 2 * S })).toEqual(ignored("late_input"));
    expect(outcome({ lastConsumedInputAtMs: NOW - 5 * S })).toMatchObject({ outcome: "start" }); // equal is not older
    expect(outcome({ lastConsumedInputAtMs: NOW - 10 * S })).toMatchObject({ outcome: "start" });
  });
});

describe("rule 8: deployments", () => {
  it("only an ACTIVE deployment can start a session", () => {
    expect(outcome({ deployments: [] })).toEqual(ignored("deployment_not_active"));
    for (const status of ["PAUSED", "STOPPED", "RETIRED"] as const)
      expect(outcome({ deployments: [deployment({ status })] }), status).toEqual(
        ignored("deployment_not_active"),
      );
  });
  it("a trigger enqueued before the deployment was (re)activated never starts a session", () => {
    expect(outcome({ deployments: [deployment({ startEligibleFromMs: NOW - 2 * S })] })).toEqual(
      ignored("before_activation"),
    );
    expect(
      outcome({ deployments: [deployment({ startEligibleFromMs: NOW - 4 * S })] }),
    ).toMatchObject({ outcome: "start" }); // enqueued exactly at activation counts
  });
  it("a pre-activation deployment is skipped in favour of an activated one", () => {
    const stale = deployment({ id: "d-old", priority: 1, startEligibleFromMs: NOW });
    const ok = deployment({ id: "d-ok", priority: 2 });
    const d = outcome({ deployments: [stale, ok] });
    expect(d.outcome === "start" && d.deployment.id).toBe("d-ok");
  });
});

describe("rule 9: organization, account and contact", () => {
  it("each failure is its own code, in this order, after rule 8", () => {
    expect(
      outcome({ organizationAgrees: false, accountActive: false, contactArchived: true }),
    ).toEqual(ignored("organization_mismatch"));
    expect(outcome({ accountActive: false, contactArchived: true })).toEqual(
      ignored("account_inactive"),
    );
    expect(outcome({ contactArchived: true })).toEqual(ignored("contact_archived"));
    expect(outcome({ organizationAgrees: false, deployments: [] })).toEqual(
      ignored("deployment_not_active"),
    );
  });
});

describe("rule 10: explicit trigger match", () => {
  it("no matching trigger is no_trigger_match", () => {
    expect(outcome({ message: { type: "TEXT", body: "something else" } })).toEqual(
      ignored("no_trigger_match"),
    );
  });
  it("deployments are tried in ascending priority, and within one the first trigger in array order wins", () => {
    const low = deployment({ id: "d-low", priority: 9, triggers: [kw("hi")] });
    const high = deployment({ id: "d-high", priority: 2, triggers: [kw("nope"), kw("hi")] });
    const d = outcome({ deployments: [low, high] });
    expect(d).toMatchObject({ outcome: "start", trigger: { index: 1, kind: "keyword" } });
    expect(d.outcome === "start" && d.deployment.id).toBe("d-high");
  });
  it("the first deployment with no match falls through to the next", () => {
    const a = deployment({ id: "d-a", priority: 1, triggers: [kw("zzz")] });
    const b = deployment({ id: "d-b", priority: 2, triggers: [kw("hi")] });
    const d = outcome({ deployments: [a, b] });
    expect(d.outcome === "start" && d.deployment.id).toBe("d-b");
  });
  it("equal priorities (impossible in the database) are ordered by id so the result is deterministic", () => {
    const x = deployment({ id: "d-y", priority: 1 });
    const y = deployment({ id: "d-x", priority: 1 });
    const d = outcome({ deployments: [x, y] });
    expect(d.outcome === "start" && d.deployment.id).toBe("d-x");
  });
  it("first_message starts from a TEXT, INTERACTIVE or BUTTON message when the first-eligible fact holds", () => {
    const first = deployment({ triggers: [{ kind: "first_message" }] });
    for (const type of ["TEXT", "INTERACTIVE", "BUTTON"]) {
      expect(
        outcome({ deployments: [first], message: { type, body: null }, firstEligible: true }),
        type,
      ).toMatchObject({ outcome: "start", trigger: { kind: "first_message" } });
      expect(
        outcome({ deployments: [first], message: { type, body: null }, firstEligible: false }),
        type,
      ).toEqual(ignored("no_trigger_match"));
    }
  });
  it("a non-eligible type never starts, even with every fact true", () => {
    const all = deployment({
      triggers: [{ kind: "first_message" }, { kind: "referral_source" }, kw("hi")],
    });
    expect(
      outcome({
        deployments: [all],
        message: { type: "IMAGE", body: "hi" },
        firstEligible: true,
        hasAttribution: true,
      }),
    ).toEqual(ignored("no_trigger_match"));
  });
  it("referral_source starts from a BUTTON message with a valid attribution (C-1, C-3), keyword never from a BUTTON", () => {
    const d = deployment({ triggers: [kw("hi"), { kind: "referral_source" }] });
    expect(
      outcome({ deployments: [d], message: { type: "BUTTON", body: "hi" }, hasAttribution: false }),
    ).toEqual(ignored("no_trigger_match"));
    expect(
      outcome({ deployments: [d], message: { type: "BUTTON", body: "hi" }, hasAttribution: true }),
    ).toMatchObject({
      outcome: "start",
      trigger: { index: 1, kind: "referral_source" },
    });
  });
});

describe("the order of evaluation: the first failure is the outcome", () => {
  it("with several rules failing at once, the earliest in V3.2's order is reported", () => {
    const failing = facts({
      maxStaffControlSeq: 3,
      conversationStatus: "RESOLVED",
      botRequestInFlight: true,
      lastSessionEndedAtMs: NOW - M,
      contactSessionStartsMs: [NOW - H, NOW - 2 * H, NOW - 3 * H],
      lastConsumedInputAtMs: NOW,
      deployments: [],
      accountActive: false,
    });
    expect(evaluateStartEligibility(failing)).toEqual(ignored("superseded_by_staff"));
    const steps: Array<[Partial<StartFacts>, string]> = [
      [{ maxStaffControlSeq: null }, "conversation_resolved"],
      [{ conversationStatus: "OPEN" }, "defer"],
      [{ botRequestInFlight: false }, "cooldown"],
      [{ lastSessionEndedAtMs: null }, "session_cap"],
      [{ contactSessionStartsMs: [] }, "late_input"],
      [{ lastConsumedInputAtMs: null }, "deployment_not_active"],
      [{ deployments: [deployment()] }, "account_inactive"],
    ];
    let current = failing;
    for (const [patch, expected] of steps) {
      current = { ...current, ...patch };
      const d = evaluateStartEligibility(current);
      expect(
        d.outcome === "defer" ? "defer" : d.outcome === "ignore" ? d.code : d.outcome,
        expected,
      ).toBe(expected);
    }
  });
});

describe("plan R4 (restart after handover) as a table", () => {
  const resolution = { seq: 11, createdAtMs: NOW - 2 * H };
  const after = (n = 11) => ({ ...facts().trigger, observedControlSeq: n });
  it("A: a new conversation with no history starts", () => {
    expect(outcome({})).toMatchObject({ outcome: "start" });
  });
  it("B: handed over, not resolved: handover_unresolved", () => {
    expect(outcome({ latestHandoverSeq: 10, maxStaffControlSeq: 10, trigger: after(10) })).toEqual(
      ignored("handover_unresolved"),
    );
  });
  it("C: handed over, resolved, cooldown over, fresh input after the resolution: a new session", () => {
    expect(
      outcome({
        latestHandoverSeq: 10,
        latestResolution: resolution,
        maxStaffControlSeq: 11,
        trigger: after(),
        lastSessionEndedAtMs: NOW - 3 * H,
      }),
    ).toMatchObject({ outcome: "start" });
  });
  it("D: an old message delivered late, written before the resolution: input_before_resolution", () => {
    expect(
      outcome({
        latestHandoverSeq: 10,
        latestResolution: resolution,
        maxStaffControlSeq: 11,
        trigger: { ...after(), inputOccurredAtMs: resolution.createdAtMs - M },
        lastSessionEndedAtMs: NOW - 3 * H,
      }),
    ).toEqual(ignored("input_before_resolution"));
  });
  it("E: resolved but still assigned: conversation_assigned", () => {
    expect(
      outcome({
        latestHandoverSeq: 10,
        latestResolution: resolution,
        maxStaffControlSeq: 11,
        trigger: after(),
        assignedMembershipId: "m",
        lastSessionEndedAtMs: NOW - 3 * H,
      }),
    ).toEqual(ignored("conversation_assigned"));
  });
  it("F: a deployment activated after the resolution: an input enqueued earlier is before_activation", () => {
    expect(
      outcome({
        latestHandoverSeq: 10,
        latestResolution: resolution,
        maxStaffControlSeq: 11,
        trigger: after(),
        lastSessionEndedAtMs: NOW - 3 * H,
        deployments: [deployment({ startEligibleFromMs: NOW })],
      }),
    ).toEqual(ignored("before_activation"));
  });
  it("G: a stale message after the resolution: stale_trigger", () => {
    expect(
      outcome({
        latestHandoverSeq: 10,
        latestResolution: resolution,
        maxStaffControlSeq: 11,
        trigger: { ...after(), inputOccurredAtMs: NOW - 11 * M },
        lastSessionEndedAtMs: NOW - 3 * H,
      }),
    ).toEqual(ignored("stale_trigger"));
  });
});

describe("plan R7 (staff intervention before the bot starts) as a table", () => {
  const t = (n: number) => ({ ...facts().trigger, observedControlSeq: n });
  it("A: a staff reply after the inbound (seq 1, t 0): superseded_by_staff", () => {
    expect(
      outcome({ maxStaffControlSeq: 1, latestNonResolutionStaffSeq: 1, trigger: t(0) }),
    ).toEqual(ignored("superseded_by_staff"));
  });
  it("B: a resolution after the inbound: superseded_by_staff (rule 1 before the status rule)", () => {
    expect(
      outcome({
        maxStaffControlSeq: 1,
        latestResolution: { seq: 1, createdAtMs: NOW - M },
        conversationStatus: "RESOLVED",
        trigger: t(0),
      }),
    ).toEqual(ignored("superseded_by_staff"));
  });
  it("C: handover 10, resolution 11, reopen, resolution 12: t=11 is superseded; a fresh t=12 after cooldown starts", () => {
    const latest = { seq: 12, createdAtMs: NOW - 2 * H };
    const base = {
      latestHandoverSeq: 10,
      latestResolution: latest,
      maxStaffControlSeq: 12,
      lastSessionEndedAtMs: NOW - 5 * H,
    };
    expect(outcome({ ...base, trigger: t(11) })).toEqual(ignored("superseded_by_staff"));
    expect(outcome({ ...base, trigger: t(12) })).toMatchObject({ outcome: "start" });
    // only resolution 11 exists and the input observed it: starts
    expect(
      outcome({
        latestHandoverSeq: 10,
        latestResolution: { seq: 11, createdAtMs: NOW - 2 * H },
        maxStaffControlSeq: 11,
        trigger: t(11),
        lastSessionEndedAtMs: NOW - 5 * H,
      }),
    ).toMatchObject({ outcome: "start" });
    // provider time before resolution 12: input_before_resolution
    expect(
      outcome({ ...base, trigger: { ...t(12), inputOccurredAtMs: latest.createdAtMs - M } }),
    ).toEqual(ignored("input_before_resolution"));
  });
  it("D: a fresh enquiry after the latest resolution and cooldown starts", () => {
    expect(
      outcome({
        latestHandoverSeq: 4,
        latestResolution: { seq: 7, createdAtMs: NOW - 3 * H },
        maxStaffControlSeq: 7,
        trigger: t(7),
        lastSessionEndedAtMs: NOW - 4 * H,
      }),
    ).toMatchObject({ outcome: "start" });
  });
  it("E: assign (1) then unassign (2): the first input is superseded, a later one is staff_engaged until staff resolve", () => {
    expect(
      outcome({ maxStaffControlSeq: 2, latestNonResolutionStaffSeq: 2, trigger: t(0) }),
    ).toEqual(ignored("superseded_by_staff"));
    expect(
      outcome({ maxStaffControlSeq: 2, latestNonResolutionStaffSeq: 2, trigger: t(2) }),
    ).toEqual(ignored("staff_engaged"));
  });
  it("G: a message older than maxInputAge is stale, and a conversation that did not reopen is conversation_resolved", () => {
    expect(outcome({ trigger: { ...t(0), inputOccurredAtMs: NOW - 11 * M } })).toEqual(
      ignored("stale_trigger"),
    );
    expect(outcome({ conversationStatus: "RESOLVED" })).toEqual(ignored("conversation_resolved"));
  });
});

// ------------------------------------------------------------------------------------------------ first_message (D.4a)

describe("deriveFirstEligibleFact: the pure model of the two locked history checks", () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const msg = (
    n: number,
    createdAt: number,
    type = "TEXT",
    direction: "INBOUND" | "OUTBOUND" = "INBOUND",
  ): MessageHeader => ({
    id: id(n),
    createdAt,
    type,
    direction,
  });
  const derive = (
    candidate: MessageHeader,
    history: MessageHeader[],
    priorSessionStarts: Array<{
      startMessage: { direction: "INBOUND" | "OUTBOUND"; type: string } | null;
    }> = [],
  ) => deriveFirstEligibleFact({ candidate, history, priorSessionStarts });
  const eligibleStart = { startMessage: { direction: "INBOUND" as const, type: "TEXT" } };

  it("the earliest eligible inbound message with no session is first", () => {
    const a = msg(1, 100);
    expect(derive(a, [a])).toMatchObject({ firstEligible: true, candidateEligible: true });
    expect(derive(a, [])).toMatchObject({ firstEligible: true }); // the candidate need not be listed
  });

  it("a later eligible message is not first (F2/F3 shape)", () => {
    const a = msg(1, 100);
    const b = msg(2, 200);
    expect(derive(b, [a, b])).toMatchObject({ firstEligible: false, firstInRecordHistory: false });
    expect(derive(a, [a, b])).toMatchObject({ firstEligible: true });
  });

  it("the type matrix: TEXT, INTERACTIVE and BUTTON are eligible; nothing else is, in either role", () => {
    for (const type of ["TEXT", "INTERACTIVE", "BUTTON"]) {
      const c = msg(2, 200, type);
      expect(derive(c, [c]).firstEligible, type).toBe(true);
      // an earlier eligible message of any of the three types takes the opportunity
      expect(derive(msg(3, 300), [msg(1, 100, type), msg(3, 300)]).firstEligible, type).toBe(false);
    }
    for (const type of [
      "IMAGE",
      "VIDEO",
      "AUDIO",
      "DOCUMENT",
      "STICKER",
      "LOCATION",
      "CONTACT",
      "FLOW",
      "TEMPLATE",
      "SYSTEM",
      "REACTION",
      "UNKNOWN",
    ]) {
      // a non-eligible candidate is never first
      expect(derive(msg(2, 200, type), [msg(2, 200, type)]).firstEligible, type).toBe(false);
      // a non-eligible earlier message does not consume the opportunity
      expect(derive(msg(3, 300), [msg(1, 100, type), msg(3, 300)]).firstEligible, type).toBe(true);
    }
  });

  it("an outbound message is never a prior eligible message, and an outbound candidate is never eligible", () => {
    expect(derive(msg(2, 200), [msg(1, 100, "TEXT", "OUTBOUND"), msg(2, 200)]).firstEligible).toBe(
      true,
    );
    expect(derive(msg(2, 200, "TEXT", "OUTBOUND"), []).firstEligible).toBe(false);
  });

  it("messages from before any deployment existed count as history (they are simply retained headers)", () => {
    expect(derive(msg(9, 900), [msg(1, 1), msg(9, 900)]).firstEligible).toBe(false);
  });

  it("order is by (created_at, id), never by provider time: equal created_at is broken by id, deterministically", () => {
    const a = msg(1, 500);
    const b = msg(2, 500);
    expect(recordOrderBefore(a, b)).toBe(true);
    expect(recordOrderBefore(b, a)).toBe(false);
    expect(recordOrderBefore(a, a)).toBe(false);
    expect(derive(a, [a, b]).firstEligible).toBe(true);
    expect(derive(b, [a, b]).firstEligible).toBe(false);
    expect(recordOrderBefore(msg(2, 499), msg(1, 500))).toBe(true); // the timestamp dominates the id
  });

  it("the durable session fence: any previous session of the conversation, in any state, ends the opportunity (requirement A)", () => {
    const a = msg(1, 100);
    expect(derive(a, [a], [eligibleStart])).toMatchObject({
      firstEligible: false,
      noPreviousSessionStart: false,
    });
    // even when the candidate sorts before everything else by record order (a delayed transaction)
    expect(derive(msg(0, 1), [msg(0, 1), a], [eligibleStart]).firstEligible).toBe(false);
  });

  it("the record-order check holds without any session: an earlier eligible message that never started a bot still counts (requirement B)", () => {
    const earlier = msg(1, 100); // never started a session (no trigger, gates off, failed capture ...)
    const later = msg(2, 200);
    expect(derive(later, [earlier, later], []).firstEligible).toBe(false);
  });

  it("a previous session whose start message is missing or not an eligible inbound message is a defect and fails closed", () => {
    const a = msg(1, 100);
    const missing = derive(a, [a], [{ startMessage: null }]);
    expect(missing).toMatchObject({ evidenceDefect: true, firstEligible: false });
    const outbound = derive(a, [a], [{ startMessage: { direction: "OUTBOUND", type: "TEXT" } }]);
    expect(outbound).toMatchObject({ evidenceDefect: true, firstEligible: false });
    const image = derive(a, [a], [{ startMessage: { direction: "INBOUND", type: "IMAGE" } }]);
    expect(image).toMatchObject({ evidenceDefect: true, firstEligible: false });
    expect(derive(a, [a], [eligibleStart]).evidenceDefect).toBe(false);
  });

  it("neither a resolution, a completed session nor redaction resets it: only the presence of a session matters", () => {
    const a = msg(1, 100);
    for (let sessions = 1; sessions <= 3; sessions++)
      expect(
        derive(
          a,
          [a],
          Array.from({ length: sessions }, () => eligibleStart),
        ).firstEligible,
      ).toBe(false);
  });
});

describe("isValidAttribution (C-3)", () => {
  const expected = { organizationId: "o-1", messageId: "m-1", contactId: "c-1" };
  it("needs the same organization, the exact message and the same contact", () => {
    expect(isValidAttribution({ ...expected }, expected)).toBe(true);
    expect(isValidAttribution({ ...expected, organizationId: "o-2" }, expected)).toBe(false);
    expect(isValidAttribution({ ...expected, messageId: "m-2" }, expected)).toBe(false);
    expect(isValidAttribution({ ...expected, contactId: "c-2" }, expected)).toBe(false);
    expect(isValidAttribution(null, expected)).toBe(false);
  });
});
