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
  STAFF_ROUTING_KEYWORDS,
  classInfoFlow,
  enquiryFlow,
  generalInfoFlow,
  paymentEnquiryFlow,
  staffRoutingFlow,
  type Json,
} from "./testing";
import { scanUrls } from "./urls";

// Phase 08G-4: the Staff Routing golden flow (SYNTHETIC test content) through the real validator and simulator.
// Database-free. Approved decisions D-12 (generic categories) and D-13 (category reaches staff via handover wording).

type Ok = Extract<SimulationResult, { ok: true }>;
function run(scenario: Scenario): Ok {
  const result = simulate(staffRoutingFlow(), scenario);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
}
const textOf = (e: SendEffect) => (e.message.kind === "text" ? e.message.text : e.message.body);
const tap = (optionKey: string) => ({ type: "tap", optionKey }) as const;
const nodes = () => staffRoutingFlow().nodes as Record<string, Json>;

const CATEGORIES = [
  ["classes", "Class question", "student_requested", "class question"],
  ["payment", "Payment question", "student_requested", "payment question"],
  ["register", "Registration", "student_requested", "registration question"],
  ["technical", "Problem joining class", "student_requested", "problem joining class"],
  ["other", "Something else", "other", "other question"],
] as const;

describe("Staff Routing: schema and triggers", () => {
  it("validates with no error and no warning", () => {
    const result = validateFlow(staffRoutingFlow());
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("starts only on staff, agent and human, with the approved settings and no variables", () => {
    const flow = validateFlow(staffRoutingFlow()).config!;
    expect(flow.triggers).toEqual([{ kind: "keyword", words: ["staff", "agent", "human"] }]);
    expect(flow.settings).toEqual({ idleTimeoutMinutes: 30, maxInvalidAttempts: 2 });
    expect(flow.variables).toEqual({});
    expect(flow.errorNodeId).toBe("error_to_staff");
  });

  it("is only MESSAGE, LIST and HANDOVER: no question, variable, condition or end node", () => {
    expect(new Set(Object.values(nodes()).map((n) => n.type))).toEqual(
      new Set(["MESSAGE", "LIST", "HANDOVER"]),
    );
  });

  it("reuses the shared invalid and error handovers unchanged", () => {
    const shared = generalInfoFlow().nodes as Record<string, Json>;
    for (const id of ["invalid_to_staff", "error_to_staff"])
      expect(nodes()[id]).toEqual(shared[id]);
  });

  it("has no bot-to-bot navigation and no loop: every transition stays inside the flow", () => {
    const ids = new Set(Object.keys(nodes()));
    for (const n of Object.values(nodes())) {
      const targets = [
        n.next,
        n.onInvalid,
        ...((n.options as Json[] | undefined) ?? []).map((o) => o.next),
      ];
      for (const t of targets.filter((x) => x !== undefined))
        expect(ids.has(t as string)).toBe(true);
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

  it("the Staff flow carries exactly its approved set", () => {
    expect([...STAFF_ROUTING_KEYWORDS]).toEqual([...SETS.staff_routing]);
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
    const mine = new Set(keys(staffRoutingFlow()));
    for (const other of [generalInfoFlow(), classInfoFlow(), paymentEnquiryFlow(), enquiryFlow()])
      for (const key of keys(other)) expect(mine.has(key)).toBe(false);
  });
});

describe("Staff Routing: journeys through the real engine", () => {
  it("welcome then the five categories on start", () => {
    const r = run({ steps: [] });
    expect(r.outbound.map((e) => e.message.kind)).toEqual(["text", "list"]);
    expect(textOf(r.outbound[0]!)).toBe(
      "Hello. I'll help you reach our staff. First, what is your enquiry about?",
    );
    const list = r.outbound[1]!.message;
    if (list.kind !== "list") throw new Error("expected list");
    expect(list.rows.map((row) => row.title)).toEqual(CATEGORIES.map((c) => c[1]));
    expect(r.session).toMatchObject({ state: "WAITING_FOR_INPUT", currentNodeId: "reason_menu" });
  });

  it.each(CATEGORIES)(
    "%s (%s) hands over as %s with one category-specific notice",
    (key, _t, reason, what) => {
      const r = run({ steps: [tap(key)] });
      expect(r.session).toMatchObject({
        state: "HANDED_OVER",
        endReason: "flow_handover",
        handoverReason: reason,
      });
      expect(textOf(r.outbound.at(-1)!)).toBe(
        `Thank you. I've passed your ${what} to our staff. Please wait here for their reply. I can't say how soon.`,
      );
      expect(r.outbound.filter((e) => e.terminalNotice)).toHaveLength(1);
      expect(r.outbound.at(-1)!.terminalNotice).toBe(true);
      expect(r.outbound).toHaveLength(3); // welcome, list, handover: nothing else
    },
  );

  it("each category is identifiable from its handover message alone (D-13), and the five are distinct", () => {
    const notices = CATEGORIES.map(([key]) => textOf(run({ steps: [tap(key)] }).outbound.at(-1)!));
    expect(new Set(notices).size).toBe(5);
    CATEGORIES.forEach(([, , , what], i) =>
      expect(notices[i]).toContain(`your ${what} to our staff`),
    );
    expect(notices[4]).toBe(
      "Thank you. I've passed your other question to our staff. Please wait here for their reply. I can't say how soon.",
    );
  });

  it("'other' is a valid reason under the validator and the engine", () => {
    expect(nodes().h_other!.reason).toBe("other");
    expect(validateFlow(staffRoutingFlow()).ok).toBe(true);
    expect(run({ steps: [tap("other")] }).session?.handoverReason).toBe("other");
  });

  it("an invalid selection re-prompts the same list, then a valid one hands over", () => {
    const r = run({ steps: [{ type: "text", text: "my fees" }, tap("payment")] });
    expect(r.outbound.filter((e) => e.message.kind === "list")).toHaveLength(2);
    expect(r.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "student_requested" });
    expect(textOf(r.outbound.at(-1)!)).toContain("payment question");
  });

  it("two invalid replies hand over as invalid_input", () => {
    const r = run({
      steps: [
        { type: "text", text: "hello" },
        { type: "text", text: "hello again" },
      ],
    });
    expect(r.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "invalid_input" });
    expect(textOf(r.outbound.at(-1)!)).toMatch(/^I couldn't understand your reply/);
    expect(r.outbound.filter((e) => e.terminalNotice)).toHaveLength(1);
  });

  it("idle expiry completes the session silently, adding no send", () => {
    const r = run({ steps: [{ type: "wait", ms: 30 * 60_000 }, { type: "idle_expired" }] });
    expect(r.session).toMatchObject({ state: "COMPLETED", endReason: "idle_timeout" });
    expect(r.transcript.at(-1)!.effects).toEqual([]);
    expect(r.outbound.some((e) => e.terminalNotice)).toBe(false);
    expect(r.outbound.map(textOf)).toEqual(run({ steps: [] }).outbound.map(textOf));
  });

  it("the flow has no cycle, so SEND_BUDGET is unreachable; the shared engine_error contract is covered by the Payment suite", () => {
    // Longest path is welcome -> menu -> handover (3 sends) against a budget of 60. Invalid replies re-send at most once.
    const worst = run({
      steps: [
        { type: "text", text: "x" },
        { type: "text", text: "y" },
      ],
    });
    expect(worst.outbound.length).toBeLessThan(10);
    expect(worst.transcript.every((e) => e.error === undefined)).toBe(true);
  });
});

describe("Staff Routing: limits, safety and synthetic content", () => {
  it("every message obeys the text, list and button limits", () => {
    const r = run({ steps: [] });
    for (const { message } of r.outbound) {
      if (message.kind === "text")
        expect(message.text.length).toBeLessThanOrEqual(FLOW_LIMITS.textMax);
      if (message.kind === "list") {
        expect(message.rows.length).toBeLessThanOrEqual(FLOW_LIMITS.listOptionsMax);
        expect(message.buttonLabel.length).toBeLessThanOrEqual(FLOW_LIMITS.listButtonLabelMax);
        for (const row of message.rows)
          expect(row.title.length).toBeLessThanOrEqual(FLOW_LIMITS.listRowTitleMax);
      }
    }
  });

  it("handover wording promises no time, availability, assignment, department or outcome", () => {
    for (const n of Object.values(nodes()).filter((x) => x.type === "HANDOVER")) {
      const message = String(n.message).replace("I can't say how soon.", "");
      expect(message).not.toMatch(
        /\b(soon|shortly|today|tomorrow|within|minutes?|hours?|immediately|right away|24\/7|available|online|department|team|manager|assigned|processed|registered|confirmed|received)\b|\d/i,
      );
    }
  });

  it("collects nothing: no variable, no question, no URL, no number", () => {
    expect(Object.keys(staffRoutingFlow().variables as Json)).toEqual([]);
    const text = JSON.stringify(Object.values(nodes()).map((n) => [n.text, n.body, n.message]));
    expect(scanUrls(text)).toEqual([]);
    expect(text).not.toMatch(/https?:|www\.|@|\d/);
  });

  it("is plainly a synthetic test flow", () => {
    expect(staffRoutingFlow().name).toContain("SYNTHETIC TEST");
  });

  it("is deterministic: two runs of one scenario are identical", () => {
    const steps = [{ type: "text", text: "x" }, tap("other")] as const;
    expect(simulate(staffRoutingFlow(), { steps: [...steps] })).toEqual(
      simulate(staffRoutingFlow(), { steps: [...steps] }),
    );
  });
});
