import { afterEach, describe, expect, it, vi } from "vitest";
import {
  simulate,
  simulatorToken,
  type Scenario,
  type SendEffect,
  type SimulationResult,
} from "./index";
import { enquiryFlow, flowWith, minimalFlow, type Json } from "./testing";

// Offline simulations (Phase 08B, ADR 0018) of the approved 08A enquiry fixture and small flows: multilingual journeys, menu
// loops, invalid answers, send acceptance, idle expiry, determinism and the transcript a Bot Studio preview reads.

type Ok = Extract<SimulationResult, { ok: true }>;
function run(flow: Json, scenario: Scenario): Ok {
  const result = simulate(flow, scenario);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
}
const textOf = (e: SendEffect) => (e.message.kind === "text" ? e.message.text : e.message.body);
const texts = (r: Ok) => r.outbound.map(textOf);

afterEach(() => vi.unstubAllGlobals());

describe("simulate: the multilingual enquiry flow", () => {
  it("Sinhala: language, menu, registration, a numeric branch and completion", () => {
    const r = run(enquiryFlow(), {
      steps: [
        { type: "tap", optionKey: "si" },
        { type: "tap", optionKey: "register" },
        { type: "text", text: "නිමල් පෙරේරා" },
        { type: "text", text: "12" },
      ],
    });
    expect(texts(r)).toEqual([
      "Choose your language / භාෂාව තෝරන්න / மொழியைத் தேர்ந்தெடுக்கவும் 🙂",
      "ආයුබෝවන්! ශ්‍රී ලංකාවේ A/L ICT පන්තියට සාදරයෙන් පිළිගනිමු.",
      "What would you like to know?",
      "What is your name?",
      "Which grade are you in?",
      "Thank you, නිමල් පෙරේරා. We will contact you.",
      "Goodbye!",
    ]);
    expect(r.outbound.map((e) => e.terminalNotice)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(r.session).toMatchObject({
      state: "COMPLETED",
      endReason: "flow_end",
      variables: { student_name: "නිමල් පෙරේරා", grade: 12, wants_call: true },
    });
    expect(r.outbound[2]!.message.kind).toBe("list");
  });

  it("Tamil: a student-driven menu loop through information messages, then a handover", () => {
    const r = run(enquiryFlow(), {
      steps: [
        { type: "tap", optionKey: "ta" },
        { type: "tap", optionKey: "classes" },
        { type: "tap", optionKey: "fees" },
        { type: "tap", optionKey: "classes" },
        { type: "tap", optionKey: "staff" },
      ],
    });
    expect(texts(r)).toEqual([
      expect.any(String),
      "வணக்கம்! A/L ICT வகுப்புக்கு உங்களை வரவேற்கிறோம்.",
      "What would you like to know?",
      "Details are on our page: https://example.org/classes",
      "What would you like to know?",
      "Our fee list is shared by staff.",
      "What would you like to know?",
      "Details are on our page: https://example.org/classes",
      "What would you like to know?",
      "A member of staff will reply soon.",
    ]);
    expect(r.transcript.some((e) => e.error)).toBe(false); // a menu loop is not an automatic loop
    expect(r.session).toMatchObject({
      state: "HANDED_OVER",
      endReason: "flow_handover",
      handoverReason: "student_requested",
    });
  });

  it("English with emoji: invalid numeric answers re-ask, then the flow follows onInvalid", () => {
    const r = run(enquiryFlow(), {
      steps: [
        { type: "tap", optionKey: "en" },
        { type: "tap", optionKey: "register" },
        { type: "text", text: "Kasun 🙂" },
        { type: "text", text: "abc" },
        { type: "text", text: "20" },
      ],
    });
    const inputs = r.transcript.filter((e) => e.input).map((e) => e.input);
    expect(inputs.slice(-2)).toEqual([
      { result: "invalid", reason: "answer_invalid", attempts: 1 },
      { result: "invalid", reason: "answer_invalid", attempts: 2 },
    ]);
    expect(texts(r).slice(-3)).toEqual([
      "Which grade are you in?",
      "Which grade are you in?",
      "A member of staff will reply soon.",
    ]);
    expect(r.session!.variables).toEqual({ student_name: "Kasun 🙂" });
  });

  it("a grade in the second branch skips the variable update", () => {
    const r = run(enquiryFlow(), {
      steps: [
        { type: "tap", optionKey: "en" },
        { type: "tap", optionKey: "register" },
        { type: "text", text: "Ama" },
        { type: "text", text: "10" },
      ],
    });
    expect(r.session!.variables).toEqual({ student_name: "Ama", grade: 10 });
    const lastStep = r.transcript.filter((e) => e.trace.length).at(-2)!;
    expect(lastStep.trace.map((t) => t.nodeId)).toEqual(["check_grade", "confirm"]);
  });

  it("replies carry the injected token, and stale or duplicate taps are told apart", () => {
    const r = run(enquiryFlow(), {
      steps: [
        { type: "tap", optionKey: "en" },
        { type: "reply", replyId: `b1.${simulatorToken(1)}.en`, subtype: "button_reply" }, // the consumed language prompt
        { type: "reply", replyId: `b1.${simulatorToken(9)}.fees`, subtype: "list_reply" }, // a prompt that never existed
      ],
    });
    const ids = (
      r.outbound[0]!.message as { readonly buttons: readonly { id: string }[] }
    ).buttons.map((b) => b.id);
    expect(ids).toEqual(["si", "ta", "en"].map((k) => `b1.${simulatorToken(1)}.${k}`));
    const inputs = r.transcript.filter((e) => e.input).map((e) => e.input);
    expect(inputs).toEqual([
      { result: "accepted" },
      { result: "duplicate" },
      { result: "invalid", reason: "stale_prompt", attempts: 1 },
    ]);
  });
});

describe("simulate: sends, time and limits", () => {
  it("without automatic acceptance, a reply waits (deferred) until the prompt's send is accepted", () => {
    const r = run(enquiryFlow(), {
      autoAccept: false,
      steps: [
        { type: "tap", optionKey: "en" },
        { type: "accept" },
        { type: "tap", optionKey: "en" },
      ],
    });
    expect(r.transcript.map((e) => [e.outcome, e.input?.result])).toEqual([
      ["WAITING_FOR_SEND", undefined],
      ["DEFERRED", "deferred"],
      ["WAITING_FOR_INPUT", undefined],
      ["WAITING_FOR_SEND", "accepted"],
    ]);
    expect(r.transcript[1]!.input).toEqual({ result: "deferred", promptInteraction: true });
  });

  it("a held send hands the session over", () => {
    const r = run(enquiryFlow(), {
      autoAccept: false,
      steps: [{ type: "send_result", state: "HELD" }],
    });
    expect(r.session).toMatchObject({ state: "HANDED_OVER", handoverReason: "send_held" });
  });

  it("idle time passes only through wait steps; a late reply finds the session expired", () => {
    const r = run(enquiryFlow(), {
      startMs: 1_000,
      steps: [
        { type: "wait", ms: 30 * 60_000 },
        { type: "tap", optionKey: "en" },
      ],
    });
    expect(r.transcript.at(-1)).toMatchObject({
      outcome: "COMPLETED",
      input: { result: "expired" },
      nowMs: 1_000 + 30 * 60_000,
    });
    expect(r.session!.endReason).toBe("idle_timeout");
  });

  it("the per-step budget stops a long automatic chain at the error node", () => {
    const nodes: Record<string, Json> = {};
    for (let i = 0; i < 25; i++)
      nodes[`s${i}`] = {
        type: "SET_VARIABLE",
        variable: "x",
        value: i,
        next: i < 24 ? `s${i + 1}` : "done",
      };
    const r = run(
      { ...flowWith(nodes, "s0"), variables: { x: { type: "integer" } } },
      { steps: [] },
    );
    expect(r.transcript[0]).toMatchObject({
      error: "STEP_TRANSITION_BUDGET",
      state: "HANDED_OVER",
      noticeSkipped: "ENGINE_ERROR",
    });
    expect(r.session).toMatchObject({ endReason: "error", terminalNoticeStepSeq: null });
    expect(texts(r)).toEqual([]);
  });

  it("a rendered prohibited link produces no outbound message (the session ends at the error node)", () => {
    const flow = {
      ...flowWith(
        {
          ask: {
            type: "QUESTION",
            text: "Link?",
            variable: "l",
            answer: { kind: "text", max: 100 },
            next: "show",
            onInvalid: "to_staff",
          },
          show: { type: "MESSAGE", text: "Visit {{l}}", next: "done" },
        },
        "ask",
      ),
      variables: { l: { type: "string", maxLength: 100 } },
    };
    const bad = run(flow, { steps: [{ type: "text", text: "http://example.org" }] });
    expect(texts(bad)).toEqual(["Link?"]);
    expect(bad.session).toMatchObject({ currentNodeId: "to_staff", endReason: "error" });
    expect(JSON.stringify(bad.outbound)).not.toContain("http://");
    const good = run(flow, { steps: [{ type: "text", text: "https://example.org" }] });
    expect(texts(good)).toEqual(["Link?", "Visit https://example.org", "Bye"]);
  });

  it("an invalid flow is not run: its diagnostics are returned", () => {
    const result = simulate({ ...minimalFlow(), startNodeId: "nowhere" }, { steps: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toContain("START_NODE_MISSING");
  });

  it("a tap with nothing to tap is reported, not guessed", () => {
    const r = run(minimalFlow(), { steps: [{ type: "tap", optionKey: "x" }] });
    expect(r.transcript.at(-1)).toMatchObject({
      outcome: "SCENARIO_ERROR",
      reason: "no_pending_prompt",
    });
  });

  it("uses the scenario's own tokens when given", () => {
    const tokens = ["A".repeat(22), "B".repeat(22)];
    const r = run(enquiryFlow(), { tokens, steps: [{ type: "tap", optionKey: "en" }] });
    expect(
      (r.outbound[0]!.message as { readonly buttons: readonly { id: string }[] }).buttons[0]!.id,
    ).toBe(`b1.${tokens[0]}.si`);
    expect(
      (r.outbound.at(-1)!.message as { readonly rows: readonly { id: string }[] }).rows[0]!.id,
    ).toBe(`b1.${tokens[1]}.classes`);
  });
});

describe("simulate: determinism and the preview transcript", () => {
  const scenario: Scenario = {
    steps: [
      { type: "tap", optionKey: "si" },
      { type: "tap", optionKey: "classes" },
      { type: "tap", optionKey: "register" },
      { type: "text", text: "සුනිල්" },
      { type: "text", text: "13" },
    ],
  };

  it("the same flow and scenario give the same transcript every time", () => {
    const a = run(enquiryFlow(), scenario);
    const b = run(enquiryFlow(), scenario);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("every entry exposes the state a preview needs: event, outcome, effects, nodes, variables and the pending prompt", () => {
    const r = run(enquiryFlow(), scenario);
    expect(r.transcript[0]).toMatchObject({
      index: 0,
      source: "auto",
      event: { type: "start" },
      outcome: "WAITING_FOR_SEND",
      state: "WAITING_FOR_SEND",
      nodeId: "language_menu",
      awaiting: { kind: "BUTTONS", phase: "QUEUED", optionKeys: ["si", "ta", "en"] },
      trace: [{ nodeId: "language_menu", type: "BUTTONS" }],
    });
    expect(r.transcript[1]).toMatchObject({
      source: "auto",
      event: { type: "send_result", state: "ACCEPTED" },
      state: "WAITING_FOR_INPUT",
    });
    expect(r.transcript.map((e) => e.index)).toEqual(r.transcript.map((_e, i) => i));
    expect(r.truncated).toBe(false);
    expect(r.outbound).toEqual(r.transcript.flatMap((e) => e.effects));
  });

  it("makes no network call and reads no clock", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock read");
    });
    try {
      run(enquiryFlow(), scenario);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
