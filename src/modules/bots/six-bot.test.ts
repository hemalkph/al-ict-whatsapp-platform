import { describe, expect, it } from "vitest";
import { routingConflicts, validateFlow, type FlowConfig } from "./index";
import { comparisonKey } from "./text";
import {
  classInfoFlow,
  enquiryFlow,
  generalInfoFlow,
  paymentEnquiryFlow,
  registrationEnquiryFlow,
  staffRoutingFlow,
  type Json,
} from "./testing";

// Phase 08G-6 SIX-CL-3 (database-free part): the six SYNTHETIC flows as one set. Pairwise uniqueness of the five new sets is
// already pinned by each 08G golden suite; this checks the six together, with Student Enquiry, against the approved priority
// order (08G-0 section 4, owner decision OD-1). Since 08G-7A the activation, resume and version-change services enforce the
// order with `routingConflicts`; the last block runs that production rule over the six fixtures.

/** The approved deployment order, lowest priority number first; Student Enquiry is last. */
const APPROVED_ORDER: ReadonlyArray<readonly [string, () => Json]> = [
  ["staff_routing", staffRoutingFlow],
  ["payment_enquiry", paymentEnquiryFlow],
  ["registration_enquiry", registrationEnquiryFlow],
  ["class_info", classInfoFlow],
  ["general_info", generalInfoFlow],
  ["student_enquiry", enquiryFlow],
];

type Trigger = { kind: string; words?: string[] };
const triggersOf = (flow: Json) => flow.triggers as Trigger[];

describe("six-bot set (SIX-CL-3, database-free)", () => {
  it("no keyword is shared by two of the six flows; only Student Enquiry (last in the approved order) has first_message or referral_source", () => {
    const seen = new Map<string, string>();
    for (const [bot, flow] of APPROVED_ORDER)
      for (const trigger of triggersOf(flow()))
        for (const word of trigger.words ?? []) {
          const key = comparisonKey(word);
          expect(seen.get(key), `"${word}" in ${bot} and ${seen.get(key)}`).toBeUndefined();
          seen.set(key, bot);
        }
    expect(seen.size).toBe(2 + 2 + 3 + 3 + 3 + 4);

    const implicit = APPROVED_ORDER.filter(([, flow]) =>
      triggersOf(flow()).some((t) => t.kind !== "keyword"),
    ).map(([bot]) => bot);
    expect(implicit).toEqual(["student_enquiry"]);
    expect(APPROVED_ORDER.at(-1)![0]).toBe("student_enquiry");
  });
});

describe("the six-bot set under the production routing rule (08G-7A)", () => {
  const routed = (order: ReadonlyArray<readonly [string, () => Json]>) =>
    order.map(([key, flow], i) => ({
      key,
      priority: i + 1,
      triggers: (validateFlow(flow()).config as FlowConfig).triggers,
    }));

  it("the approved order has no routing conflict", () => {
    expect(routingConflicts(routed(APPROVED_ORDER))).toEqual([]);
  });

  it("Student Enquiry first conflicts with each of the five keyword bots, and with nothing else", () => {
    const inverted = [APPROVED_ORDER.at(-1)!, ...APPROVED_ORDER.slice(0, 5)];
    expect(routingConflicts(routed(inverted))).toEqual(
      APPROVED_ORDER.slice(0, 5).map(([key]) => ({
        kind: "catch_all_first",
        first: "student_enquiry",
        then: key,
      })),
    );
  });

  it("a version of a keyword bot that adds another bot's keyword (or a first_message trigger) is a conflict", () => {
    const withExtra = (extra: Json[]) =>
      routed(APPROVED_ORDER).map((d) =>
        d.key === "general_info"
          ? { ...d, triggers: [...d.triggers, ...(extra as unknown as FlowConfig["triggers"])] }
          : d,
      );
    expect(routingConflicts(withExtra([{ kind: "keyword", words: ["Pay"] }]))).toEqual([
      { kind: "shared_keyword", first: "payment_enquiry", then: "general_info" },
    ]);
    expect(routingConflicts(withExtra([{ kind: "first_message" }]))).toEqual([
      { kind: "catch_all_first", first: "general_info", then: "student_enquiry" },
    ]);
  });
});
