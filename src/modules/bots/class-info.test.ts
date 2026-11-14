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
  CLASS_INFO_CLASS_KEYS,
  CLASS_INFO_KEYWORDS,
  classInfoFlow,
  codesOf,
  enquiryFlow,
  generalInfoFlow,
  type Json,
} from "./testing";
import { scanUrls } from "./urls";

// Phase 08G-2: the Class Information golden flow (SYNTHETIC test content) run through the real validator and simulator.
// Database-free. Nothing here is a real A/L ICT class (PHASE_08G-1_APPROVAL_ADDENDUM.md).

type Ok = Extract<SimulationResult, { ok: true }>;
function run(scenario: Scenario): Ok {
  const result = simulate(classInfoFlow(), scenario);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
}
const textOf = (e: SendEffect) => (e.message.kind === "text" ? e.message.text : e.message.body);
const tap = (optionKey: string) => ({ type: "tap", optionKey }) as const;
const nodes = () => classInfoFlow().nodes as Record<string, Json>;

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

describe("Class Information: schema and triggers", () => {
  it("validates with no error and no warning", () => {
    const result = validateFlow(classInfoFlow());
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("starts only on the keywords classes and class, with the approved settings", () => {
    const flow = validateFlow(classInfoFlow()).config!;
    expect(flow.triggers).toEqual([{ kind: "keyword", words: ["classes", "class"] }]);
    expect(flow.settings).toEqual({ idleTimeoutMinutes: 30, maxInvalidAttempts: 2 });
    expect(flow.variables).toEqual({});
    expect(flow.errorNodeId).toBe("error_to_staff");
  });

  it("reuses General Information's shared handover and END nodes unchanged", () => {
    const shared = generalInfoFlow().nodes as Record<string, Json>;
    for (const id of ["to_staff", "needs_staff", "invalid_to_staff", "error_to_staff", "bye"])
      expect(nodes()[id]).toEqual(shared[id]);
    const reasons = Object.values(nodes())
      .filter((n) => n.type === "HANDOVER")
      .map((n) => n.reason);
    expect(reasons.sort()).toEqual([
      "error_fallback",
      "invalid_input",
      "needs_staff",
      "student_requested",
    ]);
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

  it("fails validation if a handover reason is invented", () => {
    const flow = classInfoFlow();
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

  it("the Class Information flow carries exactly its approved set", () => {
    expect([...CLASS_INFO_KEYWORDS]).toEqual([...SETS.class_info]);
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

  it("the real flows' triggers do not overlap: Class vs General Information and Student Enquiry", () => {
    const keys = (flow: Json) =>
      new Set(
        (flow.triggers as { kind: string; words?: string[] }[])
          .flatMap((t) => t.words ?? [])
          .map(comparisonKey),
      );
    const mine = keys(classInfoFlow());
    for (const other of [generalInfoFlow(), enquiryFlow()])
      for (const key of keys(other)) expect(mine.has(key)).toBe(false);
  });
});

describe("Class Information: journeys through the real engine", () => {
  it("welcome then the class list on start", () => {
    const r = run({ steps: [] });
    expect(r.outbound.map((e) => e.message.kind)).toEqual(["text", "list"]);
    const list = r.outbound[1]!.message;
    if (list.kind !== "list") throw new Error("expected list");
    expect(list.rows.map((row) => row.title)).toEqual([
      "[TEST] Class one",
      "[TEST] Class two",
      "[TEST] Class three",
      "Class not listed",
      "Talk to staff",
    ]);
    expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "class_list" });
  });

  it.each(CLASS_INFO_CLASS_KEYS.map((key, i) => [key, i + 1] as const))(
    "class %s shows its own details and then the more-options buttons",
    (key, n) => {
      const r = run({ steps: [tap(key)] });
      const texts = r.outbound.map(textOf);
      expect(texts.at(-2)).toContain(`[SYNTHETIC TEST CLASS ${n}]`);
      expect(texts.at(-1)).toBe("Is there anything else I can help with?");
      const more = r.outbound.at(-1)!.message;
      if (more.kind !== "buttons") throw new Error("expected buttons");
      expect(more.buttons.map((b) => b.title)).toEqual([
        "Another class",
        "Talk to staff",
        "That's all",
      ]);
      expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "more" });
    },
  );

  it("one class then done: five sends, exactly one END notice, COMPLETED", () => {
    const r = run({ steps: [tap("c1"), tap("done")] });
    expect(r.outbound.map((e) => e.message.kind)).toEqual([
      "text", // welcome
      "list", // class list
      "text", // details
      "buttons", // more
      "text", // END notice
    ]);
    expect(r.outbound.map((e) => e.terminalNotice)).toEqual([false, false, false, false, true]);
    expect(textOf(r.outbound.at(-1)!)).toBe("Thank you. This enquiry is complete.");
    expect(r.session).toMatchObject({
      state: "COMPLETED",
      endReason: "flow_end",
      handoverReason: null,
    });
  });

  it("several classes in one session, then completion with one terminal notice", () => {
    const r = run({
      steps: [tap("c1"), tap("again"), tap("c3"), tap("again"), tap("c2"), tap("done")],
    });
    const details = r.outbound.map(textOf).filter((t) => t.startsWith("[SYNTHETIC TEST CLASS"));
    expect(details.map((t) => t.slice(0, 23))).toEqual([
      "[SYNTHETIC TEST CLASS 1",
      "[SYNTHETIC TEST CLASS 3",
      "[SYNTHETIC TEST CLASS 2",
    ]);
    expect(r.outbound.filter((e) => e.message.kind === "list")).toHaveLength(3); // the list is re-sent per "Another class"
    expect(r.session).toMatchObject({ state: "COMPLETED", endReason: "flow_end" });
    expect(r.outbound.filter((e) => e.terminalNotice)).toHaveLength(1);
  });

  it("Class not listed hands over as needs_staff with its terminal notice", () => {
    const r = run({ steps: [tap("other")] });
    expect(r.session).toMatchObject({
      state: "HANDED_OVER",
      endReason: "flow_handover",
      handoverReason: "needs_staff",
    });
    expect(textOf(r.outbound.at(-1)!)).toMatch(/^I can't help with that here/);
    expect(r.outbound.at(-1)!.terminalNotice).toBe(true);
  });

  it("Talk to staff from the class list hands over as student_requested", () => {
    const r = run({ steps: [tap("staff")] });
    expect(r.session).toMatchObject({
      state: "HANDED_OVER",
      endReason: "flow_handover",
      handoverReason: "student_requested",
    });
    expect(r.outbound.at(-1)!.terminalNotice).toBe(true);
  });

  it("Talk to staff from the more-options buttons hands over as student_requested", () => {
    const r = run({ steps: [tap("c2"), tap("staff")] });
    expect(r.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "student_requested" });
  });

  it("an invalid selection is re-prompted with the same list, then a valid one continues", () => {
    const r = run({ steps: [{ type: "text", text: "when is the class?" }, tap("c2")] });
    expect(r.outbound.filter((e) => e.message.kind === "list")).toHaveLength(2);
    expect(r.outbound.map(textOf).at(-2)).toContain("[SYNTHETIC TEST CLASS 2]");
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
      steps: [tap("c1"), { type: "text", text: "yes" }, { type: "text", text: "yes please" }],
    });
    expect(r.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "invalid_input" });
  });

  it("idle expiry completes the session silently, adding no send", () => {
    const r = run({
      steps: [tap("c1"), { type: "wait", ms: 30 * 60_000 }, { type: "idle_expired" }],
    });
    expect(r.session).toMatchObject({ state: "COMPLETED", endReason: "idle_timeout" });
    expect(r.outbound.at(-1)!.terminalNotice).toBe(false);
    expect(r.transcript.at(-1)!.effects).toEqual([]);
    expect(r.outbound.map(textOf)).toEqual(run({ steps: [tap("c1")] }).outbound.map(textOf));
  });

  it("an internal engine error ends as engine_error with no notice and no send (SEND_BUDGET)", () => {
    // 2 sends to start, then 3 per "class, details, more, another class" cycle: the 60-send session budget is reached.
    const cycle = [tap("c1"), tap("again")];
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
    expect(r.outbound).toHaveLength(60);
    expect(r.outbound.every((e) => !e.terminalNotice)).toBe(true);
    expect(r.outbound.map(textOf).join("\n")).not.toContain("something went wrong on our side");
  });
});

describe("Class Information: limits, wording and synthetic content", () => {
  it("every message obeys the text, list and button limits", () => {
    const r = run({ steps: [tap("c1"), tap("again")] });
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

  it("the END message is exactly the approved wording", () => {
    expect(nodes().bye!.message).toBe("Thank you. This enquiry is complete.");
  });

  it("handover wording promises no time, availability or outcome", () => {
    for (const n of Object.values(nodes()).filter((x) => x.type === "HANDOVER")) {
      const message = String(n.message).replace("I can't say how soon.", "");
      expect(message).not.toMatch(
        /\b(soon|shortly|today|tomorrow|within|minutes?|hours?|immediately|right away|24\/7|available|online now)\b|\d/i,
      );
    }
  });

  it("makes no joining, fee, enrolment or payment claim and offers no link", () => {
    for (const text of allText(classInfoFlow())) {
      expect(scanUrls(text), text).toEqual([]);
      expect(text).not.toMatch(
        /https?:|www\.|@|\b(rs\.?|lkr|usd)\s?\d|\$\s?\d|\d{7,}|\b(fees?|price|cost|free|discount|scholarship)\b|\b(zoom|meet|teams)\b|\b(teacher|sir|miss)\b|\b(enrolled|registered|confirmed|guaranteed|seat)\b/i,
      );
      expect(text).not.toMatch(/\b(card number|cvv|pin|otp|password|national id|nic)\b/i);
    }
  });

  it("every class detail says it is example text and is plainly synthetic", () => {
    const flow = classInfoFlow();
    expect(flow.name).toContain("SYNTHETIC TEST");
    for (const key of CLASS_INFO_CLASS_KEYS) {
      const title = (nodes().class_list!.options as Json[]).find((o) => o.key === key)!.title;
      expect(String(title)).toMatch(/^\[TEST\]/);
      const detail = String(nodes()[`cls_${key}`]!.text);
      expect(detail).toMatch(/^\[SYNTHETIC TEST CLASS \d\]/);
      expect(detail).toContain("This is not a real class.");
      expect(detail).toContain("(test only)");
    }
  });

  it("is deterministic: two runs of one scenario are identical", () => {
    const steps = [tap("c1"), tap("again"), tap("other")];
    expect(simulate(classInfoFlow(), { steps })).toEqual(simulate(classInfoFlow(), { steps }));
  });
});
