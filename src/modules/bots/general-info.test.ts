import { describe, expect, it } from "vitest";
import {
  simulate,
  validateFlow,
  type Scenario,
  type SendEffect,
  type SimulationResult,
} from "./index";
import { FLOW_LIMITS } from "./limits";
import { comparisonKey } from "./text";
import {
  GENERAL_INFO_KEYWORDS,
  GENERAL_INFO_TOPIC_KEYS,
  codesOf,
  enquiryFlow,
  generalInfoFlow,
  type Json,
} from "./testing";
import { scanUrls } from "./urls";

// Phase 08G-1: the General Information golden flow (SYNTHETIC test content) run through the real validator and simulator.
// Database-free. Nothing here is real A/L ICT information (PHASE_08G-1_APPROVAL_ADDENDUM.md).

type Ok = Extract<SimulationResult, { ok: true }>;
function run(scenario: Scenario): Ok {
  const result = simulate(generalInfoFlow(), scenario);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
}
const textOf = (e: SendEffect) => (e.message.kind === "text" ? e.message.text : e.message.body);
const tap = (optionKey: string) => ({ type: "tap", optionKey }) as const;
const nodes = () => generalInfoFlow().nodes as Record<string, Json>;

/** Every student-facing string of the flow (bodies, labels, titles, descriptions, messages). */
function allText(flow: Json): string[] {
  const out: string[] = [];
  for (const n of Object.values(flow.nodes as Record<string, Json>)) {
    for (const k of ["text", "body", "footer", "buttonLabel", "message"]) {
      if (typeof n[k] === "string") out.push(n[k] as string);
    }
    for (const o of (n.options as Json[] | undefined) ?? []) {
      out.push(o.title as string);
      if (typeof o.description === "string") out.push(o.description);
    }
  }
  return out;
}

/**
 * Claim scan (owner correction 4): a forbidden claim is flagged only in a sentence that has no negation. "This is not a
 * confirmed registration" is a safe negation; "Your registration is confirmed" is a false claim.
 */
const CLAIM =
  /\b(payment (has been |was |is )?(received|confirmed|verified)|(registration|enrolment|enrollment) (is |has been |was )?(confirmed|complete|successful)|you are (now )?(registered|enrolled)|(registered|enrolled) successfully)\b/i;
const NEGATION = /\b(not|no|never|can't|cannot|can not|isn't|haven't|hasn't|don't|won't)\b/i;
export function falseClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+/)
    .filter((sentence) => CLAIM.test(sentence) && !NEGATION.test(sentence));
}

describe("claim scan distinguishes false claims from safe negations", () => {
  it("flags unnegated claims", () => {
    expect(falseClaims("Your payment has been received.")).toHaveLength(1);
    expect(falseClaims("Thanks. Your registration is confirmed.")).toHaveLength(1);
    expect(falseClaims("You are now registered.")).toHaveLength(1);
  });
  it("accepts negations", () => {
    expect(falseClaims("This is not a confirmed registration.")).toEqual([]);
    expect(falseClaims("I can't confirm payments myself.")).toEqual([]);
    expect(falseClaims("Your registration is not confirmed.")).toEqual([]);
  });
  it("judges each sentence on its own", () => {
    expect(falseClaims("I do not know. Your payment is confirmed.")).toHaveLength(1);
  });
});

describe("General Information: schema and triggers", () => {
  it("validates with no error and no warning", () => {
    const result = validateFlow(generalInfoFlow());
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("starts only on the keywords info and faq", () => {
    const flow = validateFlow(generalInfoFlow()).config!;
    expect(flow.triggers).toEqual([{ kind: "keyword", words: ["info", "faq"] }]);
    expect(flow.settings).toEqual({ idleTimeoutMinutes: 30, maxInvalidAttempts: 2 });
  });

  it("keeps the approved settings if the flow omits them (defaults are 30 minutes and 2 attempts)", () => {
    const flow = generalInfoFlow();
    delete flow.settings;
    expect(validateFlow(flow).config!.settings).toEqual({
      idleTimeoutMinutes: 30,
      maxInvalidAttempts: 2,
    });
  });

  it("uses only reason codes that already exist", () => {
    const reasons = Object.values(nodes())
      .filter((n) => n.type === "HANDOVER")
      .map((n) => n.reason);
    expect(reasons.sort()).toEqual([
      "error_fallback",
      "invalid_input",
      "needs_staff",
      "student_requested",
    ]);
    expect(validateFlow(generalInfoFlow()).config!.errorNodeId).toBe("error_to_staff");
  });

  it("an internal engine error ends as engine_error with no notice and no send (not the configured apology)", () => {
    // 2 sends to start, then 3 per "topic, answer, more, ask another" cycle: the 60-send session budget is reached by the loop.
    const cycle = [tap("t1"), tap("again")];
    const r = run({ steps: Array.from({ length: 25 }, () => cycle).flat() });
    const failing = r.transcript.find((e) => e.error !== undefined)!;
    expect(failing.error).toBe("SEND_BUDGET");
    expect(failing.outcome).toBe("HANDED_OVER");
    expect(failing.effects).toEqual([]); // the failing step itself generates no send
    expect(failing.noticeSkipped).toBe("ENGINE_ERROR");
    expect(failing.state).toBe("HANDED_OVER");
    expect(failing.nodeId).toBe("error_to_staff");
    expect(r.session).toMatchObject({
      state: "HANDED_OVER",
      currentNodeId: "error_to_staff",
      endReason: "error",
      handoverReason: "engine_error",
      terminalNoticeStepSeq: null,
      awaiting: null,
      sendCount: 60,
    });
    // Earlier sends are untouched, none is a terminal notice, and the configured apology was never emitted.
    expect(r.outbound).toHaveLength(60);
    expect(r.outbound.every((e) => !e.terminalNotice)).toBe(true);
    expect(r.outbound.map(textOf).join("\n")).not.toContain("something went wrong on our side");
    // The configured node still carries error_fallback (previous test); the engine overrides it on error termination only.
    expect(nodes().error_to_staff!.reason).toBe("error_fallback");
  });

  it("declares no variable and collects nothing", () => {
    expect(validateFlow(generalInfoFlow()).config!.variables).toEqual({});
  });

  it("fails validation if a handover reason is invented", () => {
    const flow = generalInfoFlow();
    (flow.nodes as Record<string, Json>).to_staff!.reason = "payment_problem";
    expect(codesOf(validateFlow(flow))).toContain("HANDOVER_REASON_UNSUPPORTED");
  });
});

describe("cross-bot keyword uniqueness (the 08G-0 keyword sets)", () => {
  const SETS = {
    general_info: ["info", "faq"],
    class_info: ["classes", "class"],
    payment_enquiry: ["payment", "payments", "pay"],
    staff_routing: ["staff", "agent", "human"],
    registration_enquiry: ["register", "registration", "join"],
  } as const;

  it("the General Information flow carries exactly its approved set", () => {
    expect([...GENERAL_INFO_KEYWORDS]).toEqual([...SETS.general_info]);
  });

  it("no keyword appears in two bots, compared with the runtime's own key", () => {
    const seen = new Map<string, string>();
    for (const [bot, words] of Object.entries(SETS)) {
      for (const word of words) {
        const key = comparisonKey(word);
        expect(seen.get(key), `"${word}" in ${bot} and ${seen.get(key)}`).toBeUndefined();
        seen.set(key, bot);
      }
    }
  });

  it("none of them is a keyword of Student Enquiry", () => {
    const enquiry = enquiryFlow().triggers as { kind: string; words?: string[] }[];
    const taken = new Set(enquiry.flatMap((t) => t.words ?? []).map(comparisonKey));
    for (const words of Object.values(SETS))
      for (const word of words) expect(taken.has(comparisonKey(word))).toBe(false);
  });
});

describe("General Information: journeys through the real engine", () => {
  it("welcome then the topic list on start", () => {
    const r = run({ steps: [] });
    expect(r.outbound.map((e) => e.message.kind)).toEqual(["text", "list"]);
    const list = r.outbound[1]!.message;
    if (list.kind !== "list") throw new Error("expected list");
    expect(list.rows.map((row) => row.title)).toEqual([
      "[TEST] Topic one",
      "[TEST] Topic two",
      "[TEST] Topic three",
      "[TEST] Topic four",
      "Other question",
      "Talk to staff",
    ]);
    expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "topics" });
  });

  it.each(GENERAL_INFO_TOPIC_KEYS.map((key, i) => [key, i + 1] as const))(
    "topic %s shows its own answer and then the more-options buttons",
    (key, n) => {
      const r = run({ steps: [tap(key)] });
      const texts = r.outbound.map(textOf);
      expect(texts.at(-2)).toContain(`[SYNTHETIC TEST ANSWER ${n}]`);
      expect(texts.at(-1)).toBe("Is there anything else I can help with?");
      expect(r.outbound.at(-1)!.message.kind).toBe("buttons");
      expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "more" });
    },
  );

  it("the GI-CL-1 journey sends exactly eight messages, ending with one END notice", () => {
    const r = run({ steps: [tap("t1"), tap("again"), tap("t2"), tap("done")] });
    expect(r.outbound.map((e) => e.message.kind)).toEqual([
      "text", // welcome
      "list", // topics
      "text", // answer 1
      "buttons", // more
      "list", // topics again
      "text", // answer 2
      "buttons", // more
      "text", // END notice
    ]);
    expect(r.outbound.map((e) => e.terminalNotice)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("several questions in one session, then completion", () => {
    const r = run({
      steps: [tap("t1"), tap("again"), tap("t3"), tap("again"), tap("t2"), tap("done")],
    });
    const answers = r.outbound.map(textOf).filter((t) => t.startsWith("[SYNTHETIC TEST ANSWER"));
    expect(answers.map((t) => t.slice(0, 25))).toEqual([
      "[SYNTHETIC TEST ANSWER 1]",
      "[SYNTHETIC TEST ANSWER 3]",
      "[SYNTHETIC TEST ANSWER 2]",
    ]);
    expect(r.session).toMatchObject({ state: "COMPLETED", endReason: "flow_end" });
    const last = r.outbound.at(-1)!;
    expect(textOf(last)).toBe("Thank you. This enquiry is complete.");
    expect(last.terminalNotice).toBe(true);
    expect(r.outbound.filter((e) => e.terminalNotice)).toHaveLength(1);
  });

  it("Talk to staff from the topic list hands over as student_requested", () => {
    const r = run({ steps: [tap("staff")] });
    expect(r.session).toMatchObject({
      state: "HANDED_OVER",
      endReason: "flow_handover",
      handoverReason: "student_requested",
    });
    expect(r.outbound.at(-1)!.terminalNotice).toBe(true);
  });

  it("Talk to staff from the more-options buttons hands over as student_requested", () => {
    const r = run({ steps: [tap("t4"), tap("staff")] });
    expect(r.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "student_requested" });
  });

  it("Other question (an unknown topic) hands over as needs_staff", () => {
    const r = run({ steps: [tap("other")] });
    expect(r.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "needs_staff" });
    expect(textOf(r.outbound.at(-1)!)).toMatch(/^I can't help with that here/);
  });

  it("an invalid selection is re-prompted, then a valid one continues", () => {
    const r = run({ steps: [{ type: "text", text: "what is the fee?" }, tap("t2")] });
    const kinds = r.outbound.map((e) => e.message.kind);
    expect(kinds.filter((k) => k === "list")).toHaveLength(2); // the prompt, then the identical re-prompt
    expect(r.outbound.map(textOf)).toContain(
      "[SYNTHETIC TEST ANSWER 2] This is placeholder text for automated tests. It is not real A/L ICT information.",
    );
    expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "more" });
  });

  it("two invalid selections hand over as invalid_input", () => {
    const r = run({
      steps: [
        { type: "text", text: "hello" },
        { type: "text", text: "hello again" },
      ],
    });
    expect(r.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "invalid_input" });
    expect(textOf(r.outbound.at(-1)!)).toMatch(/^I couldn't understand your reply/);
  });

  it("two invalid answers at the more-options buttons hand over as invalid_input", () => {
    const r = run({
      steps: [tap("t1"), { type: "text", text: "yes" }, { type: "text", text: "yes please" }],
    });
    expect(r.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "invalid_input" });
  });

  it("the simulator's `other` input (not a real IMAGE) counts as one invalid attempt and re-prompts", () => {
    // Real IMAGE messages never reach the engine: trigger capture admits only TEXT, INTERACTIVE and BUTTON (ADR 0021 section 2).
    // `other` is the engine's input for "neither text nor a reply"; here it is only an invalid input.
    const r = run({ steps: [{ type: "other" }] });
    expect(r.session).toMatchObject({
      state: "WAITING_FOR_INPUT",
      currentNodeId: "topics",
      invalidAttempts: 1,
    });
    expect(r.outbound.map((e) => e.message.kind)).toEqual(["text", "list", "list"]);
  });

  it("idle expiry completes the session silently", () => {
    const r = run({
      steps: [tap("t1"), { type: "wait", ms: 30 * 60_000 }, { type: "idle_expired" }],
    });
    expect(r.session).toMatchObject({ state: "COMPLETED", endReason: "idle_timeout" });
    expect(r.outbound.at(-1)!.terminalNotice).toBe(false);
    const expiry = r.transcript.at(-1)!;
    expect(expiry.effects).toEqual([]); // the expiry itself sends nothing
    expect(r.outbound).toHaveLength(r.transcript.reduce((n, e) => n + e.effects.length, 0));
    expect(r.outbound.map(textOf)).toEqual(run({ steps: [tap("t1")] }).outbound.map(textOf));
  });
});

describe("General Information: limits and wording", () => {
  it("every message obeys the text, list and button limits", () => {
    const r = run({ steps: [tap("t1"), tap("again")] });
    for (const { message } of r.outbound) {
      if (message.kind === "text")
        expect(message.text.length).toBeLessThanOrEqual(FLOW_LIMITS.textMax);
      if (message.kind === "buttons") {
        expect(message.body.length).toBeLessThanOrEqual(FLOW_LIMITS.textMax);
        expect(message.buttons.length).toBeLessThanOrEqual(FLOW_LIMITS.buttonOptionsMax);
        for (const b of message.buttons)
          expect(b.title.length).toBeLessThanOrEqual(FLOW_LIMITS.buttonTitleMax);
      }
      if (message.kind === "list") {
        expect(message.rows.length).toBeLessThanOrEqual(FLOW_LIMITS.listOptionsMax);
        expect(message.buttonLabel.length).toBeLessThanOrEqual(FLOW_LIMITS.listButtonLabelMax);
        for (const row of message.rows) {
          expect(row.title.length).toBeLessThanOrEqual(FLOW_LIMITS.listRowTitleMax);
          expect((row.description ?? "").length).toBeLessThanOrEqual(
            FLOW_LIMITS.listRowDescriptionMax,
          );
        }
      }
    }
  });

  it("the END message is exactly the approved wording and promises no immediate new interaction", () => {
    const bye = nodes().bye!;
    expect(bye.message).toBe("Thank you. This enquiry is complete.");
    expect(String(bye.message)).not.toMatch(/again|any time|anytime|immediately|right away|now/i);
  });

  it("handover wording promises no time, availability or outcome", () => {
    for (const n of Object.values(nodes()).filter((x) => x.type === "HANDOVER")) {
      const message = String(n.message).replace("I can't say how soon.", "");
      expect(message).not.toMatch(
        /\b(soon|shortly|today|tomorrow|within|minutes?|hours?|immediately|right away|24\/7|available|online now)\b|\d/i,
      );
    }
  });

  it("makes no payment or registration claim, and asks for nothing sensitive", () => {
    for (const text of allText(generalInfoFlow())) {
      expect(falseClaims(text), text).toEqual([]);
      expect(text).not.toMatch(/\b(card number|cvv|pin|otp|password|national id|nic)\b/i);
    }
  });

  it("contains no URL, link-like text, phone number, price or e-mail", () => {
    for (const text of allText(generalInfoFlow())) {
      expect(scanUrls(text)).toEqual([]);
      expect(text).not.toMatch(/https?:|www\.|@|\b(rs\.?|lkr|usd)\s?\d|\$\s?\d|\d{7,}/i);
    }
  });

  it("is plainly synthetic: no topic or answer can be mistaken for real content", () => {
    const flow = generalInfoFlow();
    expect(flow.name).toContain("SYNTHETIC TEST");
    const n = nodes();
    for (const key of GENERAL_INFO_TOPIC_KEYS) {
      expect(
        String(
          n.topics!.options && (n.topics!.options as Json[]).find((o) => o.key === key)!.title,
        ),
      ).toMatch(/^\[TEST\]/);
      expect(String(n[`ans_${key}`]!.text)).toMatch(/^\[SYNTHETIC TEST ANSWER \d\]/);
      expect(String(n[`ans_${key}`]!.text)).toContain("not real A/L ICT information");
    }
  });

  it("is deterministic: two runs of one scenario are identical", () => {
    const steps = [tap("t1"), tap("again"), tap("other")];
    expect(simulate(generalInfoFlow(), { steps })).toEqual(simulate(generalInfoFlow(), { steps }));
  });
});
