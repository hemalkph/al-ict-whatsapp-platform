import { describe, expect, it } from "vitest";
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
// order (08G-0 section 4, owner decision OD-1). A test, not an activation guard: nothing enforces the order at deployment.

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
