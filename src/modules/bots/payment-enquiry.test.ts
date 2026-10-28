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
  PAYMENT_ENQUIRY_KEYWORDS,
  botAuthoredText,
  classInfoFlow,
  enquiryFlow,
  generalInfoFlow,
  paymentClaimViolations,
  paymentEnquiryFlow,
  type Json,
} from "./testing";
import { scanUrls } from "./urls";

// Phase 08G-3: the Payment Enquiry golden flow (SYNTHETIC test content) through the real validator and simulator.
// Database-free. Nothing here is a real payment instruction, account, amount or date.

type Ok = Extract<SimulationResult, { ok: true }>;
function run(scenario: Scenario): Ok {
  const result = simulate(paymentEnquiryFlow(), scenario);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
}
const textOf = (e: SendEffect) => (e.message.kind === "text" ? e.message.text : e.message.body);
const tap = (optionKey: string) => ({ type: "tap", optionKey }) as const;
const nodes = () => paymentEnquiryFlow().nodes as Record<string, Json>;

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

describe("Payment Enquiry: schema and triggers", () => {
  it("validates with no error and no warning", () => {
    const result = validateFlow(paymentEnquiryFlow());
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("starts only on payment, payments and pay, with the approved settings", () => {
    const flow = validateFlow(paymentEnquiryFlow()).config!;
    expect(flow.triggers).toEqual([{ kind: "keyword", words: ["payment", "payments", "pay"] }]);
    expect(flow.settings).toEqual({ idleTimeoutMinutes: 30, maxInvalidAttempts: 2 });
    expect(flow.variables).toEqual({});
    expect(flow.errorNodeId).toBe("error_to_staff");
  });

  it("reuses the shared handover and END nodes unchanged; the two payment handovers are needs_staff", () => {
    const shared = generalInfoFlow().nodes as Record<string, Json>;
    for (const id of ["to_staff", "invalid_to_staff", "error_to_staff", "bye"])
      expect(nodes()[id]).toEqual(shared[id]);
    expect(nodes().verify_staff!.reason).toBe("needs_staff");
    expect(nodes().problem_staff!.reason).toBe("needs_staff");
  });

  it("has no bot-to-bot navigation: every transition stays inside this flow", () => {
    const ids = new Set(Object.keys(nodes()));
    for (const n of Object.values(nodes())) {
      const targets = [
        n.next,
        n.onInvalid,
        ...((n.options as Json[] | undefined) ?? []).map((o) => o.next),
      ].filter((t) => t !== undefined);
      for (const t of targets) expect(ids.has(t as string), String(t)).toBe(true);
    }
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

  it("the Payment flow carries exactly its approved set", () => {
    expect([...PAYMENT_ENQUIRY_KEYWORDS]).toEqual([...SETS.payment_enquiry]);
  });

  it("no keyword appears in two bots, and the real flows' triggers do not overlap", () => {
    const seen = new Map<string, string>();
    for (const [bot, words] of Object.entries(SETS))
      for (const word of words) {
        const key = comparisonKey(word);
        expect(seen.get(key), `"${word}" in ${bot} and ${seen.get(key)}`).toBeUndefined();
        seen.set(key, bot);
      }
    const keys = (flow: Json) =>
      (flow.triggers as { words?: string[] }[]).flatMap((t) => t.words ?? []).map(comparisonKey);
    const mine = new Set(keys(paymentEnquiryFlow()));
    for (const other of [generalInfoFlow(), classInfoFlow(), enquiryFlow()])
      for (const key of keys(other)) expect(mine.has(key)).toBe(false);
  });
});

describe("Payment Enquiry: journeys through the real engine", () => {
  it("welcome then the five payment options on start", () => {
    const r = run({ steps: [] });
    expect(r.outbound.map((e) => e.message.kind)).toEqual(["text", "list"]);
    const list = r.outbound[1]!.message;
    if (list.kind !== "list") throw new Error("expected list");
    expect(list.rows.map((row) => row.title)).toEqual([
      "How to pay",
      "Payment dates",
      "I have paid",
      "Payment problem",
      "Talk to staff",
    ]);
    expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "pay_menu" });
  });

  it.each([
    ["how", "[SYNTHETIC TEST PAYMENT INSTRUCTIONS]"],
    ["info", "[SYNTHETIC TEST PAYMENT DATES]"],
  ])("%s shows synthetic information then the more-options buttons", (key, marker) => {
    const r = run({ steps: [tap(key)] });
    const texts = r.outbound.map(textOf);
    expect(texts.at(-2)).toContain(marker);
    expect(texts.at(-1)).toBe("Is there anything else I can help with?");
    const more = r.outbound.at(-1)!.message;
    if (more.kind !== "buttons") throw new Error("expected buttons");
    expect(more.buttons.map((b) => b.title)).toEqual([
      "Ask another",
      "Talk to staff",
      "That's all",
    ]);
    expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "more" });
  });

  it.each([
    ["verify", "needs_staff", /^Thank you\. Only our staff can check a payment/],
    ["problem", "needs_staff", /^I'm sorry about the problem/],
    ["staff", "student_requested", /^Sure\. I've passed this chat/],
  ])("%s hands over as %s with one terminal notice", (key, reason, wording) => {
    const r = run({ steps: [tap(key)] });
    expect(r.session).toMatchObject({
      state: "HANDED_OVER",
      endReason: "flow_handover",
      handoverReason: reason,
    });
    expect(textOf(r.outbound.at(-1)!)).toMatch(wording);
    expect(r.outbound.filter((e) => e.terminalNotice)).toHaveLength(1);
    expect(r.outbound.at(-1)!.terminalNotice).toBe(true);
  });

  it("Talk to staff from the more-options buttons hands over as student_requested", () => {
    const r = run({ steps: [tap("how"), tap("staff")] });
    expect(r.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "student_requested" });
  });

  it("repeated enquiries, then done: the menu is re-sent per Ask another and one END notice", () => {
    const r = run({ steps: [tap("how"), tap("again"), tap("info"), tap("done")] });
    expect(r.outbound.filter((e) => e.message.kind === "list")).toHaveLength(2);
    expect(textOf(r.outbound.at(-1)!)).toBe("Thank you. This enquiry is complete.");
    expect(r.session).toMatchObject({
      state: "COMPLETED",
      endReason: "flow_end",
      handoverReason: null,
    });
    expect(r.outbound.filter((e) => e.terminalNotice)).toHaveLength(1);
  });

  it("an invalid selection re-prompts the same list, then a valid one continues", () => {
    const r = run({ steps: [{ type: "text", text: "I paid yesterday" }, tap("info")] });
    expect(r.outbound.filter((e) => e.message.kind === "list")).toHaveLength(2);
    expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "more" });
  });

  it("two invalid replies hand over as invalid_input, at the menu and at the buttons", () => {
    for (const prefix of [[], [tap("how")]]) {
      const r = run({
        steps: [...prefix, { type: "text", text: "hello" }, { type: "text", text: "hello again" }],
      });
      expect(r.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "invalid_input" });
      expect(textOf(r.outbound.at(-1)!)).toMatch(/^I couldn't understand your reply/);
    }
  });

  it("idle expiry completes the session silently, adding no send", () => {
    const r = run({
      steps: [tap("how"), { type: "wait", ms: 30 * 60_000 }, { type: "idle_expired" }],
    });
    expect(r.session).toMatchObject({ state: "COMPLETED", endReason: "idle_timeout" });
    expect(r.outbound.at(-1)!.terminalNotice).toBe(false);
    expect(r.transcript.at(-1)!.effects).toEqual([]);
    expect(r.outbound.map(textOf)).toEqual(run({ steps: [tap("how")] }).outbound.map(textOf));
  });

  it("an internal engine error ends as engine_error with no notice and no send (SEND_BUDGET)", () => {
    const cycle = [tap("how"), tap("again")];
    const r = run({ steps: Array.from({ length: 25 }, () => cycle).flat() });
    const failing = r.transcript.find((e) => e.error !== undefined)!;
    expect(failing.error).toBe("SEND_BUDGET");
    expect(failing.outcome).toBe("HANDED_OVER");
    expect(failing.effects).toEqual([]);
    expect(failing.noticeSkipped).toBe("ENGINE_ERROR");
    expect(r.session).toMatchObject({
      state: "HANDED_OVER",
      currentNodeId: "error_to_staff",
      endReason: "error",
      handoverReason: "engine_error",
      terminalNoticeStepSeq: null,
      awaiting: null,
      sendCount: 60,
    });
    expect(r.outbound.every((e) => !e.terminalNotice)).toBe(true);
    expect(r.outbound.map(textOf).join("\n")).not.toContain("something went wrong on our side");
  });
});

describe("Payment Enquiry: limits, safety and synthetic content", () => {
  it("every message obeys the text, list and button limits", () => {
    const r = run({ steps: [tap("how"), tap("again")] });
    for (const { message } of r.outbound) {
      if (message.kind === "text")
        expect(message.text.length).toBeLessThanOrEqual(FLOW_LIMITS.textMax);
      if (message.kind === "buttons") {
        expect(message.body.length).toBeLessThanOrEqual(FLOW_LIMITS.textMax);
        for (const b of message.buttons)
          expect(b.title.length).toBeLessThanOrEqual(FLOW_LIMITS.buttonTitleMax);
      }
      if (message.kind === "list") {
        expect(message.rows.length).toBeLessThanOrEqual(FLOW_LIMITS.listOptionsMax);
        expect(message.buttonLabel.length).toBeLessThanOrEqual(FLOW_LIMITS.listButtonLabelMax);
        for (const row of message.rows)
          expect(row.title.length).toBeLessThanOrEqual(FLOW_LIMITS.listRowTitleMax);
      }
    }
  });

  it("handover wording promises no time, availability or outcome", () => {
    for (const n of Object.values(nodes()).filter((x) => x.type === "HANDOVER")) {
      const message = String(n.message).replace("I can't say how soon.", "");
      expect(message).not.toMatch(
        /\b(soon|shortly|today|tomorrow|within|minutes?|hours?|immediately|right away|24\/7|available|online now)\b|\d/i,
      );
    }
  });

  it("makes no payment-status claim in any bot-authored text; the student's 'I have paid' option is not a bot claim", () => {
    const flow = paymentEnquiryFlow();
    for (const n of Object.values(nodes())) {
      const bot = [n.text, n.body, n.footer, n.buttonLabel, n.message].filter(
        (x): x is string => typeof x === "string",
      );
      for (const o of (n.options as Json[] | undefined) ?? [])
        if (typeof o.description === "string") bot.push(o.description);
      for (const text of bot) expect(paymentClaimViolations(text), text).toEqual([]);
    }
    expect(allText(flow)).toContain("I have paid"); // the option exists and is student-selectable
    expect(String(nodes().verify_staff!.message)).toContain("I can't confirm it");
    expect(String(nodes().welcome!.text)).toContain("I can't check or confirm payments");
  });

  it("scanner regressions: rejects status claims in context, allows negated and non-claim wording", () => {
    for (const bad of [
      "Your payment is complete.",
      "We have received your payment.",
      "Your payment has been confirmed.",
      "Your payment has been verified.",
      "Your payment was successful.",
      "Thank you for your payment.",
      "We confirm your payment.",
      "You have paid.",
    ])
      expect(paymentClaimViolations(bad), bad).not.toEqual([]);
    for (const ok of [
      "This payment is not confirmed.",
      "I can't confirm your payment.",
      "Our staff will check your payment.",
      "I can't check or confirm payments. Our staff do that.",
      "Registration is complete.", // a status word without a payment noun is not a payment claim
      "Payments are due on the first of the month.", // future dates/amounts are not claims
    ])
      expect(paymentClaimViolations(ok), ok).toEqual([]);
    // Claim after an innocent first sentence, and curly-apostrophe negation.
    expect(paymentClaimViolations("Hello. Your payment is complete.")).toHaveLength(1);
    expect(paymentClaimViolations("I can\u2019t confirm your payment.")).toEqual([]);
  });

  it("botAuthoredText reads text and interactive content but never option titles", () => {
    const list = {
      type: "interactive",
      payload: {
        kind: "list",
        body: "Body",
        footer: "Foot",
        buttonLabel: "Label",
        sections: [{ title: "Label", rows: [{ id: "a", title: "I have paid", description: "D" }] }],
      },
    };
    expect(botAuthoredText(list)).toEqual(["Body", "Foot", "Label", "Label", "D"]);
    expect(botAuthoredText({ type: "text", body: "Hi" })).toEqual(["Hi"]);
    const buttons = {
      type: "interactive",
      payload: { kind: "buttons", body: "B", buttons: [{ id: "x", title: "I have paid" }] },
    };
    expect(botAuthoredText(buttons)).toEqual(["B"]);
    // A claim inside an interactive body is caught; the same words as a student option title are not scanned.
    const claim = {
      type: "interactive",
      payload: { kind: "buttons", body: "Your payment is complete.", buttons: [] },
    };
    expect(botAuthoredText(claim).flatMap(paymentClaimViolations)).toHaveLength(1);
    expect(botAuthoredText(buttons).flatMap(paymentClaimViolations)).toEqual([]);
  });

  it("requests no credential, payment detail or document; sensitive words only appear in a 'never send' warning", () => {
    const warning = "Please never send card numbers, PINs, passwords or OTP codes in this chat.";
    for (const text of allText(paymentEnquiryFlow())) {
      const rest = text.replace(warning, "");
      expect(rest).not.toMatch(
        /\b(card|cvv|pin|otp|password|passcode|bank|account|iban|swift|national id|nic|login|upload|slip|receipt|screenshot|photo|send (us|me)|enter|share your)\b/i,
      );
    }
    expect(String(nodes().pay_how!.text)).toContain(warning);
    expect(Object.keys(paymentEnquiryFlow().variables as Json)).toEqual([]);
    expect(Object.values(nodes()).some((n) => n.type === "QUESTION")).toBe(false);
  });

  it("contains no real payment detail: no URL, amount, long number, date or merchant", () => {
    for (const text of allText(paymentEnquiryFlow())) {
      expect(scanUrls(text), text).toEqual([]);
      expect(text).not.toMatch(
        /https?:|www\.|@|\b(rs\.?|lkr|usd)\s?\d|\$\s?\d|\d|\b(fees?|price|cost|amount|due|deadline|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      );
    }
  });

  it("every information message is plainly synthetic and instructs no payment", () => {
    expect(paymentEnquiryFlow().name).toContain("SYNTHETIC TEST");
    expect(String(nodes().pay_how!.text)).toMatch(/^\[SYNTHETIC TEST PAYMENT INSTRUCTIONS\]/);
    expect(String(nodes().pay_how!.text)).toContain("It is not a real payment instruction.");
    expect(String(nodes().pay_how!.text)).toContain(
      "Do not make any payment because of this message.",
    );
    expect(String(nodes().pay_info!.text)).toMatch(/^\[SYNTHETIC TEST PAYMENT DATES\]/);
    expect(String(nodes().pay_info!.text)).toContain("It is not a real payment date.");
  });

  it("is deterministic: two runs of one scenario are identical", () => {
    const steps = [tap("how"), tap("again"), tap("verify")];
    expect(simulate(paymentEnquiryFlow(), { steps })).toEqual(
      simulate(paymentEnquiryFlow(), { steps }),
    );
  });
});
