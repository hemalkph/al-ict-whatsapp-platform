import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENGINE_BUDGETS,
  evaluateCondition,
  formatReplyId,
  isReplyId,
  parseAnswer,
  renderText,
  simulatorToken,
  step,
  validateFlow,
  type BotSession,
  type Condition,
  type FlowConfig,
  type RequestState,
  type StepResult,
  type StudentInput,
} from "./index";
import { deepFreeze, flowWith, minimalFlow, type Json } from "./testing";

// Unit tests of the pure engine (Phase 08B, ADR 0018): every node type, replies, conditions, rendering, budgets, determinism.

const T = simulatorToken;
const MINUTE = 60_000;

function cfg(flow: Json): FlowConfig {
  const result = validateFlow(flow);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.config!;
}
const withVars = (flow: Json, variables: Json): Json => ({ ...flow, variables });

const start = (flow: FlowConfig, token: string | null = T(1), nowMs = 1_000) =>
  step(flow, null, { type: "start" }, { nowMs, ...(token ? { promptToken: token } : {}) });
const sendResult = (
  flow: FlowConfig,
  s: BotSession,
  state: RequestState,
  opts: { nowMs?: number; token?: string; stepSeq?: number } = {},
) =>
  step(
    flow,
    s,
    { type: "send_result", stepSeq: opts.stepSeq ?? s.stepSeq, state },
    { nowMs: opts.nowMs ?? 2_000, ...(opts.token ? { promptToken: opts.token } : {}) },
  );
const accept = (flow: FlowConfig, s: BotSession, token?: string) =>
  sendResult(flow, s, "ACCEPTED", token ? { token } : {});
const send = (
  flow: FlowConfig,
  s: BotSession,
  input: StudentInput,
  opts: { nowMs?: number; token?: string; latest?: RequestState } = {},
) =>
  step(
    flow,
    s,
    { type: "student_input", input, latestRequestState: opts.latest ?? "ACCEPTED" },
    { nowMs: opts.nowMs ?? 3_000, ...(opts.token ? { promptToken: opts.token } : {}) },
  );
const text = (value: string): StudentInput => ({ kind: "text", text: value });
const tap = (s: BotSession, key: string, subtype: "button_reply" | "list_reply" = "button_reply") =>
  ({
    kind: "interactive",
    subtype,
    replyId: formatReplyId(s.awaitingToken!, key)!,
  }) as StudentInput;
const textsOf = (r: StepResult) =>
  r.effects.map((e) => (e.message.kind === "text" ? e.message.text : e.message.body));

/** BUTTONS menu -> MESSAGE -> END; minimalFlow's to_staff HANDOVER is the error node. */
const buttonsFlow = () =>
  cfg(
    flowWith(
      {
        menu: {
          type: "BUTTONS",
          body: "Pick one",
          footer: "Foot",
          options: [
            { key: "yes", title: "Yes", next: "thanks" },
            { key: "no", title: "No", next: "done" },
          ],
          onInvalid: "to_staff",
        },
        thanks: { type: "MESSAGE", text: "Thanks", next: "done" },
      },
      "menu",
    ),
  );

/** A session waiting for input at the buttons menu (token T(1)). */
function atMenu(flow = buttonsFlow()): BotSession {
  return accept(flow, start(flow).session!).session!;
}

afterEach(() => vi.restoreAllMocks());

describe("MESSAGE", () => {
  it("renders its configured text as one send effect and waits for that send to be accepted", () => {
    const flow = cfg(minimalFlow());
    const r = start(flow, null);
    expect(r.outcome).toBe("WAITING_FOR_SEND");
    expect(r.effects).toEqual([
      {
        type: "SEND",
        stepSeq: 1,
        nodeId: "welcome",
        terminalNotice: false,
        message: { kind: "text", text: "Hello" },
      },
    ]);
    expect(r.session).toMatchObject({
      state: "WAITING_FOR_SEND",
      currentNodeId: "welcome",
      awaiting: { nodeId: "welcome", kind: "MESSAGE", phase: "QUEUED", optionKeys: [] },
      awaitingToken: null,
      stepSeq: 1,
      sendCount: 1,
      transitionCount: 1,
    });
  });

  it("continues to the next node only after the runtime reports ACCEPTED", () => {
    const flow = cfg(minimalFlow());
    const s = start(flow).session!;
    for (const state of ["QUEUED", "SENDING"] as const) {
      const r = sendResult(flow, s, state);
      expect(r).toMatchObject({
        outcome: "IGNORED",
        changed: false,
        reason: "request_in_flight",
        effects: [],
      });
      expect(r.session).toBe(s);
    }
    expect(sendResult(flow, s, "ACCEPTED", { stepSeq: 0 })).toMatchObject({
      outcome: "IGNORED",
      reason: "stale_send_result",
    });
    const done = accept(flow, s);
    expect(done.outcome).toBe("COMPLETED");
    expect(done.effects).toEqual([
      {
        type: "SEND",
        stepSeq: 2,
        nodeId: "done",
        terminalNotice: true,
        message: { kind: "text", text: "Bye" },
      },
    ]);
    expect(done.session).toMatchObject({
      endReason: "flow_end",
      terminalNoticeStepSeq: 2,
      stepSeq: 2,
    });
  });

  it("a send that is HELD, REJECTED or of unknown outcome hands over, without touching the request", () => {
    const flow = cfg(minimalFlow());
    const s = start(flow).session!;
    const reasons = {
      HELD: "send_held",
      REJECTED: "send_rejected",
      UNKNOWN_OUTCOME: "send_outcome_unknown",
    };
    for (const [state, reason] of Object.entries(reasons)) {
      const r = sendResult(flow, s, state as RequestState);
      expect(r.outcome).toBe("HANDED_OVER");
      expect(r.effects).toEqual([]);
      expect(r.session).toMatchObject({
        endReason: "system_handover",
        handoverReason: reason,
        terminalNoticeStepSeq: null,
      });
    }
  });
});

describe("BUTTONS and LIST", () => {
  it("renders the prompt with reply ids built from the injected token, then waits for input", () => {
    const flow = buttonsFlow();
    const r = start(flow, T(7));
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0]!.message).toEqual({
      kind: "buttons",
      body: "Pick one",
      footer: "Foot",
      buttons: [
        { id: `b1.${T(7)}.yes`, title: "Yes" },
        { id: `b1.${T(7)}.no`, title: "No" },
      ],
    });
    for (const b of (r.effects[0]!.message as { readonly buttons: readonly { id: string }[] })
      .buttons)
      expect(isReplyId(b.id)).toBe(true);
    expect(r.session).toMatchObject({
      awaiting: { kind: "BUTTONS", phase: "QUEUED", optionKeys: ["yes", "no"] },
      awaitingToken: T(7),
    });
    const waiting = accept(flow, r.session!);
    expect(waiting).toMatchObject({ outcome: "WAITING_FOR_INPUT", changed: true, effects: [] });
    expect(waiting.session).toMatchObject({
      awaiting: { phase: "SENT" },
      expiresAt: 2_000 + 30 * MINUTE,
      stepSeq: 1,
    });
  });

  it("a tap on a valid option follows that option and consumes the token once", () => {
    const flow = buttonsFlow();
    const s = atMenu(flow);
    const r = send(flow, s, tap(s, "yes"));
    expect(r.input).toEqual({ result: "accepted" });
    expect(textsOf(r)).toEqual(["Thanks"]);
    expect(r.session).toMatchObject({ lastConsumedToken: T(1), awaitingToken: null, stepSeq: 2 });
    const viaNo = send(flow, s, tap(s, "no"));
    expect(viaNo.outcome).toBe("COMPLETED");
    expect(viaNo.trace.map((t) => t.nodeId)).toEqual(["done"]);
  });

  it("a LIST prompt has rows with descriptions and accepts only a list reply", () => {
    const flow = cfg(
      flowWith(
        {
          list: {
            type: "LIST",
            body: "Choose",
            buttonLabel: "Open",
            options: [
              { key: "a", title: "A", description: "About A", next: "done" },
              { key: "b", title: "B", next: "to_staff" },
            ],
            onInvalid: "to_staff",
          },
        },
        "list",
      ),
    );
    const r = start(flow, T(2));
    expect(r.effects[0]!.message).toEqual({
      kind: "list",
      body: "Choose",
      buttonLabel: "Open",
      rows: [
        { id: `b1.${T(2)}.a`, title: "A", description: "About A" },
        { id: `b1.${T(2)}.b`, title: "B" },
      ],
    });
    const s = accept(flow, r.session!).session!;
    expect(send(flow, s, tap(s, "b", "button_reply"), { token: T(3) }).input).toMatchObject({
      result: "invalid",
      reason: "wrong_kind",
    });
    const viaB = send(flow, s, tap(s, "b", "list_reply"));
    expect(viaB.outcome).toBe("HANDED_OVER");
    expect(viaB.session!.handoverReason).toBe("needs_staff");
  });

  it("a prompt without a valid, fresh injected token goes to the error node and sends no prompt", () => {
    const flow = buttonsFlow();
    for (const token of [undefined, "short", "x".repeat(22) + "!"]) {
      const r = step(
        flow,
        null,
        { type: "start" },
        { nowMs: 1, ...(token ? { promptToken: token } : {}) },
      );
      expect(r.error).toBe("PROMPT_TOKEN_INVALID");
      expect(r.effects).toEqual([]);
      expect(r.session).toMatchObject({
        currentNodeId: "to_staff",
        endReason: "error",
        terminalNoticeStepSeq: null,
      });
    }
    const s = atMenu(flow);
    // re-prompting with the token of the pending prompt, or the last consumed one, is refused
    expect(send(flow, s, text("?"), { token: T(1) }).error).toBe("PROMPT_TOKEN_INVALID");
  });
});

describe("reply evaluation", () => {
  it("a duplicate tap of the last consumed prompt is ignored and not counted", () => {
    const flow = cfg(
      flowWith(
        {
          m1: {
            type: "BUTTONS",
            body: "First",
            options: [{ key: "go", title: "Go", next: "m2" }],
            onInvalid: "to_staff",
          },
          m2: {
            type: "BUTTONS",
            body: "Second",
            options: [{ key: "go", title: "Go", next: "done" }],
            onInvalid: "to_staff",
          },
        },
        "m1",
      ),
    );
    const s1 = accept(flow, start(flow, T(1)).session!).session!;
    const firstTap = tap(s1, "go");
    const s2 = accept(flow, send(flow, s1, firstTap, { token: T(2) }).session!).session!;
    const dup = send(flow, s2, firstTap, { token: T(3) });
    expect(dup).toMatchObject({
      outcome: "WAITING_FOR_INPUT",
      changed: false,
      input: { result: "duplicate" },
    });
    expect(dup.session).toBe(s2);
  });

  it("a tap of any other prompt is stale: invalid, counted, and re-prompted with a new token", () => {
    const flow = buttonsFlow();
    const s = atMenu(flow);
    const stale: StudentInput = {
      kind: "interactive",
      subtype: "button_reply",
      replyId: `b1.${T(99)}.yes`,
    };
    const r = send(flow, s, stale, { token: T(2) });
    expect(r.input).toEqual({ result: "invalid", reason: "stale_prompt", attempts: 1 });
    expect(r.outcome).toBe("WAITING_FOR_SEND");
    expect(r.trace).toEqual([{ nodeId: "menu", type: "BUTTONS", reprompt: true }]);
    expect(
      (r.effects[0]!.message as { readonly buttons: readonly { id: string }[] }).buttons[0]!.id,
    ).toBe(`b1.${T(2)}.yes`);
    expect(r.session).toMatchObject({
      invalidAttempts: 1,
      awaitingToken: T(2),
      lastConsumedToken: null,
    });
  });

  it.each<[string, StudentInput | ((s: BotSession) => StudentInput), string]>([
    [
      "a malformed reply id",
      { kind: "interactive", subtype: "button_reply", replyId: "b1.bad" },
      "malformed_reply",
    ],
    ["an unknown option", (s) => tap(s, "maybe"), "unknown_option"],
    [
      "a mismatched context",
      (s) => ({ ...(tap(s, "yes") as object), contextMismatch: true }) as StudentInput,
      "context_mismatch",
    ],
    ["typed text", text("yes"), "wrong_kind"],
    ["an image", { kind: "other" }, "wrong_kind"],
  ])("%s is invalid input", (_name, make, reason) => {
    const flow = buttonsFlow();
    const s = atMenu(flow);
    const input = typeof make === "function" ? make(s) : make;
    expect(send(flow, s, input, { token: T(2) }).input).toMatchObject({
      result: "invalid",
      reason,
    });
  });

  it("after maxInvalidAttempts invalid inputs the flow follows onInvalid", () => {
    const flow = buttonsFlow(); // default maxInvalidAttempts: 2
    const s = atMenu(flow);
    const first = send(flow, s, text("?"), { token: T(2) });
    const again = accept(flow, first.session!).session!;
    const second = send(flow, again, text("??"), { token: T(3) });
    expect(second.input).toEqual({ result: "invalid", reason: "wrong_kind", attempts: 2 });
    expect(second.outcome).toBe("HANDED_OVER");
    expect(second.trace.map((t) => t.nodeId)).toEqual(["to_staff"]);
    expect(second.session).toMatchObject({ invalidAttempts: 0, handoverReason: "needs_staff" });
  });

  it("never advances while the latest request is QUEUED or SENDING: the input is deferred, uncounted", () => {
    const flow = buttonsFlow();
    const s = start(flow, T(1)).session!;
    for (const latest of ["QUEUED", "SENDING"] as const) {
      const pendingTap = send(flow, s, tap(s, "yes"), { latest });
      expect(pendingTap).toMatchObject({
        outcome: "DEFERRED",
        changed: false,
        effects: [],
        input: { result: "deferred", promptInteraction: true },
      });
      expect(pendingTap.session).toBe(s);
      expect(send(flow, s, text("hi"), { latest }).input).toEqual({
        result: "deferred",
        promptInteraction: false,
      });
    }
    // a student tap is never taken as proof that Meta accepted the request
    expect(s.awaiting!.phase).toBe("QUEUED");
  });

  it("an input that finds the latest request ACCEPTED first records the acceptance, then is evaluated", () => {
    const flow = buttonsFlow();
    const s = start(flow, T(1)).session!;
    const r = send(flow, s, tap(s, "yes"), { latest: "ACCEPTED" });
    expect(r.input).toEqual({ result: "accepted" });
    expect(textsOf(r)).toEqual(["Thanks"]);
  });

  it("an input that finds the latest request HELD, REJECTED or UNKNOWN hands over", () => {
    const flow = buttonsFlow();
    const s = start(flow, T(1)).session!;
    expect(send(flow, s, text("hi"), { latest: "UNKNOWN_OUTCOME" }).session).toMatchObject({
      state: "HANDED_OVER",
      handoverReason: "send_outcome_unknown",
    });
  });

  it("an input while the bot is sending a MESSAGE answers nothing: the flow continues, the input is not counted", () => {
    const flow = cfg(minimalFlow());
    const s = start(flow).session!;
    const r = send(flow, s, text("hello?"), { latest: "ACCEPTED" });
    expect(r.input).toEqual({ result: "not_awaited" });
    expect(r.outcome).toBe("COMPLETED");
  });

  it("refuses an input without the latest request state while waiting for a send", () => {
    const flow = cfg(minimalFlow());
    const s = start(flow).session!;
    const r = step(flow, s, { type: "student_input", input: text("x") }, { nowMs: 5 });
    expect(r).toMatchObject({ outcome: "IGNORED", changed: false, error: "CONTEXT_INVALID" });
  });

  it("an ended session ignores everything", () => {
    const flow = cfg(minimalFlow());
    const ended = accept(flow, start(flow).session!).session!;
    expect(send(flow, ended, text("hi"))).toMatchObject({
      outcome: "IGNORED",
      changed: false,
      reason: "session_ended",
      input: { result: "not_awaited" },
    });
    expect(accept(flow, ended)).toMatchObject({ outcome: "IGNORED", reason: "session_ended" });
  });

  it("idle expiry ends a waiting session silently, or hands over when the prompt's delivery failed", () => {
    const flow = buttonsFlow();
    const s = atMenu(flow);
    const expiry = s.expiresAt!;
    expect(step(flow, s, { type: "idle_expired" }, { nowMs: expiry - 1 })).toMatchObject({
      outcome: "IGNORED",
      reason: "not_expired",
    });
    const idle = step(flow, s, { type: "idle_expired" }, { nowMs: expiry });
    expect(idle).toMatchObject({ outcome: "COMPLETED", effects: [] });
    expect(idle.session).toMatchObject({ endReason: "idle_timeout", terminalNoticeStepSeq: null });
    const failed = step(flow, s, { type: "idle_expired", deliveryFailed: true }, { nowMs: expiry });
    expect(failed.session).toMatchObject({
      state: "HANDED_OVER",
      handoverReason: "delivery_failed",
    });
    // a reply that arrives after the expiry is not evaluated
    expect(send(flow, s, tap(s, "yes"), { nowMs: expiry })).toMatchObject({
      outcome: "COMPLETED",
      input: { result: "expired" },
    });
  });
});

describe("QUESTION", () => {
  const questionFlow = (answer: Json, type: string, extra: Json = {}) =>
    cfg(
      withVars(
        flowWith(
          {
            q: {
              type: "QUESTION",
              text: "Your answer?",
              variable: "v",
              answer,
              next: "show",
              onInvalid: "to_staff",
            },
            show: { type: "MESSAGE", text: "Got {{v}}", next: "done" },
          },
          "q",
        ),
        { v: { type, ...extra } },
      ),
    );
  const answer = (flow: FlowConfig, value: string) => {
    const s = accept(flow, start(flow, T(1)).session!).session!;
    return send(flow, s, text(value), { token: T(2) });
  };

  it("asks with a plain text message and stores a trimmed, NFC text answer", () => {
    const flow = questionFlow({ kind: "text", min: 2, max: 10 }, "string");
    expect(start(flow).effects[0]!.message).toEqual({ kind: "text", text: "Your answer?" });
    const r = answer(flow, "  Café  ");
    expect(r.session!.variables).toEqual({ v: "Café" });
    expect(textsOf(r)).toEqual(["Got Café"]);
    expect(answer(flow, "a").input).toMatchObject({ result: "invalid", reason: "answer_invalid" });
    expect(answer(flow, "12345678901").input).toMatchObject({ result: "invalid" });
    // an emoji outside the BMP is two UTF-16 units
    expect(answer(flow, "\u{1F642}").session!.variables).toEqual({ v: "\u{1F642}" });
  });

  it("integer answers: ASCII whole numbers within the range", () => {
    const flow = questionFlow({ kind: "integer", min: 1, max: 13 }, "integer");
    expect(answer(flow, " 12 ").session!.variables).toEqual({ v: 12 });
    for (const bad of ["0", "14", "12.5", "1e1", "abc", "", "+5", "١٢", "99999999999999999"])
      expect(answer(flow, bad).input, bad).toMatchObject({
        result: "invalid",
        reason: "answer_invalid",
      });
  });

  it("yes/no answers store a boolean and render as true / false", () => {
    const flow = questionFlow({ kind: "yes_no" }, "boolean");
    expect(textsOf(answer(flow, "Yes"))).toEqual(["Got true"]);
    expect(answer(flow, "n").session!.variables).toEqual({ v: false });
    expect(answer(flow, "maybe").input).toMatchObject({ result: "invalid" });
  });

  it("an invalid answer re-asks the question with a new token; an interactive reply is never an answer", () => {
    const flow = questionFlow({ kind: "integer" }, "integer");
    const s = accept(flow, start(flow, T(1)).session!).session!;
    const r = send(flow, s, text("ten"), { token: T(2) });
    expect(r.effects[0]!.message).toEqual({ kind: "text", text: "Your answer?" });
    expect(r.session).toMatchObject({ awaitingToken: T(2), invalidAttempts: 1 });
    const replyToQuestion: StudentInput = {
      kind: "interactive",
      subtype: "button_reply",
      replyId: `b1.${T(1)}.x`,
    };
    expect(send(flow, s, replyToQuestion, { token: T(2) }).input).toMatchObject({
      reason: "wrong_kind",
    });
  });

  it("parseAnswer is exact about its constraints", () => {
    expect(parseAnswer({ kind: "integer" }, "-0")).toBe(0);
    expect(Object.is(parseAnswer({ kind: "integer" }, "-0"), -0)).toBe(false);
    expect(parseAnswer({ kind: "integer", min: -5 }, "-5")).toBe(-5);
    expect(parseAnswer({ kind: "text", max: 3 }, "   ")).toBeUndefined();
    expect(parseAnswer({ kind: "text", max: 9 }, "a‮b")).toBeUndefined();
    expect(parseAnswer({ kind: "text", max: 9 }, "a\u0000b")).toBeUndefined();
    expect(parseAnswer({ kind: "yes_no" }, " NO ")).toBe(false);
  });
});

describe("conditions", () => {
  const vars = { name: "Nimal", grade: 12, paid: false };
  const is = (c: Condition, v: Record<string, string | number | boolean> = vars) =>
    evaluateCondition(c, v);

  it("a variable that is not set is seen only by is_set", () => {
    expect(is({ op: "is_set", variable: "missing" })).toBe(false);
    expect(is({ op: "equals", variable: "missing", value: "x" })).toBe(false);
    expect(is({ op: "not_equals", variable: "missing", value: "x" })).toBe(false);
    expect(is({ op: "in", variable: "missing", values: ["x"] })).toBe(false);
    expect(is({ op: "lt", variable: "missing", value: 1 })).toBe(false);
    expect(is({ op: "gt", variable: "missing", value: 1 })).toBe(false);
    expect(is({ op: "is_set", variable: "paid" })).toBe(true); // false is a value
  });

  it("compares like with like, never coercing", () => {
    expect(is({ op: "equals", variable: "grade", value: 12 })).toBe(true);
    expect(is({ op: "equals", variable: "grade", value: "12" })).toBe(false);
    expect(is({ op: "not_equals", variable: "grade", value: "12" })).toBe(false);
    expect(is({ op: "not_equals", variable: "grade", value: 11 })).toBe(true);
    expect(is({ op: "in", variable: "grade", values: ["12", 13] })).toBe(false);
    expect(is({ op: "in", variable: "grade", values: [11, 12] })).toBe(true);
    expect(is({ op: "lt", variable: "name", value: 5 })).toBe(false);
    expect(is({ op: "gt", variable: "grade", value: 11 })).toBe(true);
    expect(is({ op: "lt", variable: "grade", value: 12 })).toBe(false);
    expect(is({ op: "equals", variable: "paid", value: false })).toBe(true);
    expect(is({ op: "equals", variable: "name", value: "nimal" })).toBe(false); // exact, case-sensitive
    expect(is({ op: "equals", variable: "s", value: "Café" }, { s: "Café" })).toBe(true); // NFC
  });

  it("all / any combine nested conditions", () => {
    const c: Condition = {
      op: "all",
      conditions: [
        { op: "gt", variable: "grade", value: 10 },
        {
          op: "any",
          conditions: [
            { op: "is_set", variable: "missing" },
            { op: "equals", variable: "paid", value: false },
          ],
        },
      ],
    };
    expect(is(c)).toBe(true);
    expect(is(c, { grade: 9, paid: false })).toBe(false);
    expect(is(c, { grade: 11 })).toBe(false);
  });

  it("a CONDITION node takes the first true branch, else its fallback", () => {
    const flow = cfg(
      withVars(
        flowWith(
          {
            q: {
              type: "QUESTION",
              text: "Grade?",
              variable: "g",
              answer: { kind: "integer" },
              next: "c",
              onInvalid: "to_staff",
            },
            c: {
              type: "CONDITION",
              branches: [
                { when: { op: "gt", variable: "g", value: 11 }, next: "senior" },
                { when: { op: "gt", variable: "g", value: 5 }, next: "middle" },
              ],
              else: "done",
            },
            senior: { type: "MESSAGE", text: "Senior", next: "done" },
            middle: { type: "MESSAGE", text: "Middle", next: "done" },
          },
          "q",
        ),
        { g: { type: "integer" } },
      ),
    );
    const s = accept(flow, start(flow).session!).session!;
    expect(textsOf(send(flow, s, text("12")))).toEqual(["Senior"]);
    expect(textsOf(send(flow, s, text("12"))).length).toBe(1);
    expect(textsOf(send(flow, s, text("6")))).toEqual(["Middle"]);
    const low = send(flow, s, text("3"));
    expect(low.trace.map((t) => t.nodeId)).toEqual(["c", "done"]);
    expect(low.outcome).toBe("COMPLETED");
  });
});

describe("SET_VARIABLE and interpolation", () => {
  it("stores typed literals and renders integers and booleans exactly", () => {
    const flow = cfg(
      withVars(
        flowWith(
          {
            s1: { type: "SET_VARIABLE", variable: "g", value: 12, next: "s2" },
            s2: { type: "SET_VARIABLE", variable: "c", value: true, next: "s3" },
            s3: { type: "SET_VARIABLE", variable: "n", value: "VIP", next: "m" },
            m: { type: "MESSAGE", text: "{{n}}: grade {{g}}, call {{c}}", next: "done" },
          },
          "s1",
        ),
        { g: { type: "integer" }, c: { type: "boolean" }, n: { type: "string" } },
      ),
    );
    const r = start(flow);
    expect(textsOf(r)).toEqual(["VIP: grade 12, call true"]);
    expect(r.session!.variables).toEqual({ g: 12, c: true, n: "VIP" });
    expect(r.trace.map((t) => t.type)).toEqual([
      "SET_VARIABLE",
      "SET_VARIABLE",
      "SET_VARIABLE",
      "MESSAGE",
    ]);
  });

  it("a placeholder for an unset variable never renders: the step goes to the error node", () => {
    const flow = cfg(
      withVars(flowWith({ m: { type: "MESSAGE", text: "Hi {{name}}", next: "done" } }, "m"), {
        name: { type: "string" },
      }),
    );
    const r = start(flow);
    expect(r.error).toBe("RENDER_REJECTED");
    expect(r.renderFailures).toEqual([{ nodeId: "m", field: "text", reason: "VARIABLE_MISSING" }]);
    expect(r.outcome).toBe("HANDED_OVER");
    expect(JSON.stringify(r)).not.toMatch(/undefined|object Object|Hi /);
  });

  it("renderText substitutes once, never re-expanding a value, and renders only literals", () => {
    expect(renderText("A {{x}} B", { x: "{{y}}" }, 100)).toEqual({ ok: true, text: "A {{y}} B" });
    expect(renderText("{{x}}", { x: { toString: () => "boom" } } as never, 100)).toEqual({
      ok: false,
      reason: "VARIABLE_MISSING",
    });
    expect(renderText("{{constructor}}", {}, 100)).toEqual({
      ok: false,
      reason: "VARIABLE_MISSING",
    });
    expect(renderText("{{x}}", { x: "   " }, 100)).toEqual({ ok: false, reason: "TEXT_INVALID" });
    expect(renderText("{{x}}", { x: "a‮b" }, 100)).toEqual({ ok: false, reason: "TEXT_INVALID" });
    expect(renderText("{{x}}", { x: "abcd" }, 3)).toEqual({ ok: false, reason: "TEXT_TOO_LONG" });
  });

  it("a session variable of the wrong type is never coerced: the session goes to the error node", () => {
    const flow = cfg(
      withVars(
        flowWith(
          {
            q: {
              type: "QUESTION",
              text: "Grade?",
              variable: "g",
              answer: { kind: "integer" },
              next: "done",
              onInvalid: "to_staff",
            },
          },
          "q",
        ),
        { g: { type: "integer" } },
      ),
    );
    const s = accept(flow, start(flow).session!).session!;
    for (const corrupt of [{ g: "5" }, { g: 1.5 }, { other: 1 }]) {
      const r = send(flow, { ...s, variables: corrupt as never }, text("5"));
      expect(r.error).toBe("SESSION_INVALID");
      expect(r.outcome).toBe("HANDED_OVER");
      expect(r.session!.variables).toEqual({});
    }
  });
});

describe("rendered-text security (ADR 0017 section 8)", () => {
  const linkFlow = (template = "Visit {{student_link}}", max = 200) =>
    cfg(
      withVars(
        flowWith(
          {
            ask: {
              type: "QUESTION",
              text: "Your link?",
              variable: "student_link",
              answer: { kind: "text", max },
              next: "show",
              onInvalid: "to_staff",
            },
            show: { type: "MESSAGE", text: template, next: "done" },
          },
          "ask",
        ),
        { student_link: { type: "string", maxLength: max } },
      ),
    );
  const answerWith = (flow: FlowConfig, value: string) =>
    send(flow, accept(flow, start(flow).session!).session!, text(value));

  it.each([
    "http://example.org",
    "javascript:alert(1)",
    "tel:+94110000000",
    "https://user:pw@example.org",
    "ftp://x.org",
  ])(
    "a student value %j that would put a prohibited link in a message produces no such send effect",
    (value) => {
      const r = answerWith(linkFlow(), value);
      expect(r.error).toBe("RENDER_REJECTED");
      expect(r.renderFailures).toEqual([{ nodeId: "show", field: "text", reason: "URL_POLICY" }]);
      expect(r.effects).toEqual([]);
      expect(r.session).toMatchObject({
        state: "HANDED_OVER",
        currentNodeId: "to_staff",
        endReason: "error",
        handoverReason: "engine_error",
        terminalNoticeStepSeq: null,
      });
    },
  );

  it("a valid https link from a variable is preserved", () => {
    const r = answerWith(linkFlow(), "https://example.org/classes?year=2026");
    expect(r.error).toBeUndefined();
    expect(textsOf(r)).toEqual(["Visit https://example.org/classes?year=2026"]);
  });

  it("an interpolated text that outgrows its limit is refused, never truncated", () => {
    const template = `${"x".repeat(1000)} {{student_link}}`;
    expect(textsOf(answerWith(linkFlow(template), "y".repeat(23)))[0]).toHaveLength(1024);
    const over = answerWith(linkFlow(template), "y".repeat(24));
    expect(over.renderFailures).toEqual([
      { nodeId: "show", field: "text", reason: "TEXT_TOO_LONG" },
    ]);
    expect(over).toMatchObject({ error: "RENDER_REJECTED", effects: [] });
    expect(over.session!.currentNodeId).toBe("to_staff");
  });

  it("a footer is held to its own limit after interpolation", () => {
    const flow = cfg(
      withVars(
        flowWith(
          {
            ask: {
              type: "QUESTION",
              text: "Name?",
              variable: "n",
              answer: { kind: "text", max: 100 },
              next: "menu",
              onInvalid: "to_staff",
            },
            menu: {
              type: "BUTTONS",
              body: "Hi",
              footer: "For {{n}}",
              options: [{ key: "ok", title: "OK", next: "done" }],
              onInvalid: "to_staff",
            },
          },
          "ask",
        ),
        { n: { type: "string", maxLength: 100 } },
      ),
    );
    const s = accept(flow, start(flow).session!).session!;
    expect(send(flow, s, text("a".repeat(56)), { token: T(2) }).effects[0]!.message).toMatchObject({
      footer: `For ${"a".repeat(56)}`,
    });
    expect(send(flow, s, text("a".repeat(57)), { token: T(2) }).renderFailures).toEqual([
      { nodeId: "menu", field: "footer", reason: "TEXT_TOO_LONG" },
    ]);
  });

  it("an error termination never renders the error node's message, so it cannot fail again or recurse", () => {
    const flow = cfg(
      withVars(
        {
          ...minimalFlow(),
          startNodeId: "m",
          nodes: {
            m: { type: "MESSAGE", text: "Hi {{n}}", next: "done" },
            done: { type: "END" },
            to_staff: { type: "HANDOVER", reason: "error_fallback", message: "Sorry {{n}}" },
          },
        },
        { n: { type: "string" } },
      ),
    );
    const r = start(flow);
    expect(r).toMatchObject({
      outcome: "HANDED_OVER",
      error: "RENDER_REJECTED",
      noticeSkipped: "ENGINE_ERROR",
      effects: [],
    });
    expect(r.renderFailures.map((f) => f.nodeId)).toEqual(["m"]);
    expect(r.session).toMatchObject({
      endReason: "error",
      handoverReason: "engine_error",
      terminalNoticeStepSeq: null,
    });
  });
});

describe("END and HANDOVER", () => {
  it.each([
    [
      "END with a message",
      { type: "END", message: "Closed." },
      "COMPLETED",
      "flow_end",
      null,
      ["Closed."],
    ],
    ["END without a message", { type: "END" }, "COMPLETED", "flow_end", null, []],
    [
      "HANDOVER with a message",
      { type: "HANDOVER", reason: "student_requested", message: "Hold on." },
      "HANDED_OVER",
      "flow_handover",
      "student_requested",
      ["Hold on."],
    ],
    [
      "HANDOVER without a message",
      { type: "HANDOVER", reason: "other" },
      "HANDED_OVER",
      "flow_handover",
      "other",
      [],
    ],
  ] as const)(
    "%s as the first node ends the session in the first step",
    (_n, node, state, endReason, reason, texts) => {
      const flow = cfg(flowWith({ first: node as unknown as Json }, "first"));
      const r = start(flow, null);
      expect(r.outcome).toBe(state);
      expect(textsOf(r)).toEqual(texts);
      expect(r.effects.every((e) => e.terminalNotice)).toBe(true);
      expect(r.session).toMatchObject({
        endReason,
        handoverReason: reason,
        stepSeq: 1,
        terminalNoticeStepSeq: texts.length ? 1 : null,
        awaiting: null,
      });
    },
  );

  it("only the final message of END / HANDOVER is marked as the terminal notice", () => {
    const flow = buttonsFlow();
    const s = atMenu(flow);
    const thanks = send(flow, s, tap(s, "yes"));
    expect(thanks.effects[0]!.terminalNotice).toBe(false);
    const end = accept(flow, thanks.session!);
    expect(end.effects[0]).toMatchObject({
      terminalNotice: true,
      stepSeq: end.session!.terminalNoticeStepSeq,
    });
  });
});

describe("review corrections: deferred input across a MESSAGE acceptance", () => {
  /** MESSAGE -> QUESTION -> END: the student writes while the welcome MESSAGE is still being sent. */
  const welcomeThenAsk = () =>
    cfg(
      withVars(
        flowWith(
          {
            welcome: { type: "MESSAGE", text: "Welcome", next: "ask" },
            ask: {
              type: "QUESTION",
              text: "Your name?",
              variable: "name",
              answer: { kind: "text", max: 50 },
              next: "done",
              onInvalid: "to_staff",
            },
          },
          "welcome",
        ),
        { name: { type: "string", maxLength: 50 } },
      ),
    );
  const nimal = text("Nimal");

  it("both reconciliation orders keep the same input and end in the same state", () => {
    const flow = welcomeThenAsk();
    const s0 = start(flow).session!;
    // the input first arrives while the MESSAGE request is in flight
    expect(send(flow, s0, nimal, { latest: "SENDING" })).toMatchObject({
      outcome: "DEFERRED",
      changed: false,
      input: { result: "deferred", promptInteraction: false },
    });

    // Order A: the input handler finds the MESSAGE ACCEPTED and applies the acceptance itself
    const a1 = send(flow, s0, nimal, { latest: "ACCEPTED", token: T(2) });
    expect(a1).toMatchObject({
      outcome: "WAITING_FOR_SEND",
      changed: true,
      input: { result: "deferred", promptInteraction: false },
    });
    expect(textsOf(a1)).toEqual(["Your name?"]);
    expect(send(flow, a1.session!, nimal, { latest: "QUEUED" })).toMatchObject({
      outcome: "DEFERRED",
      changed: false,
    });
    const a2 = accept(flow, a1.session!);
    expect(a2.effects).toEqual([]);
    const a3 = send(flow, a2.session!, nimal);

    // Order B: reconciliation records the MESSAGE acceptance before the input is processed
    const b1 = accept(flow, s0, T(2));
    expect(textsOf(b1)).toEqual(["Your name?"]);
    expect(send(flow, b1.session!, nimal, { latest: "QUEUED" })).toMatchObject({
      outcome: "DEFERRED",
      changed: false,
    });
    const b2 = accept(flow, b1.session!);
    const b3 = send(flow, b2.session!, nimal);

    for (const final of [a3, b3]) {
      expect(final.input).toEqual({ result: "accepted" });
      expect(final.session).toMatchObject({
        variables: { name: "Nimal" },
        invalidAttempts: 0,
        state: "COMPLETED",
        endReason: "flow_end",
      });
      expect(textsOf(final)).toEqual(["Bye"]);
    }
    expect(a1.effects).toEqual(b1.effects);
    expect(a3).toEqual(b3);
    for (const r of [a1, a2, a3, b1, b2, b3]) expect(r.effects.length).toBeLessThanOrEqual(1);
  });

  it("a MESSAGE followed by another MESSAGE keeps the input deferred until a prompt can answer it", () => {
    const flow = cfg(
      withVars(
        flowWith(
          {
            welcome: { type: "MESSAGE", text: "Welcome", next: "info" },
            info: { type: "MESSAGE", text: "Info", next: "ask" },
            ask: {
              type: "QUESTION",
              text: "Your name?",
              variable: "name",
              answer: { kind: "text", max: 50 },
              next: "done",
              onInvalid: "to_staff",
            },
          },
          "welcome",
        ),
        { name: { type: "string", maxLength: 50 } },
      ),
    );
    const r1 = send(flow, start(flow).session!, nimal, { latest: "ACCEPTED" });
    expect(r1).toMatchObject({ input: { result: "deferred" }, effects: [{ nodeId: "info" }] });
    const r2 = send(flow, r1.session!, nimal, { latest: "ACCEPTED", token: T(2) });
    expect(r2).toMatchObject({ input: { result: "deferred" }, effects: [{ nodeId: "ask" }] });
    const r3 = send(flow, accept(flow, r2.session!).session!, nimal);
    expect(r3.input).toEqual({ result: "accepted" });
    expect(r3.session!.variables).toEqual({ name: "Nimal" });
  });

  it("when the MESSAGE was the last send, both orders end the input's processing as not awaited", () => {
    const flow = cfg(minimalFlow());
    const s0 = start(flow).session!;
    const viaInput = send(flow, s0, text("hello?"), { latest: "ACCEPTED" });
    const viaReconcile = send(flow, accept(flow, s0).session!, text("hello?"));
    expect(viaInput).toMatchObject({ outcome: "COMPLETED", input: { result: "not_awaited" } });
    expect(viaReconcile).toMatchObject({
      outcome: "IGNORED",
      reason: "session_ended",
      input: { result: "not_awaited" },
    });
    expect(viaInput.session).toEqual(accept(flow, s0).session);
  });
});

describe("review corrections: error terminations carry no terminal notice", () => {
  const ended = (r: StepResult, error: string) => {
    expect(r.error).toBe(error);
    expect(r.effects).toEqual([]);
    expect(r.trace.at(-1)!.nodeId).toBe("to_staff");
    expect(r.session).toMatchObject({
      state: "HANDED_OVER",
      currentNodeId: "to_staff",
      endReason: "error",
      handoverReason: "engine_error",
      terminalNoticeStepSeq: null,
    });
    // the error node has a message, which an error termination must not send
    expect(r.noticeSkipped).toBe("ENGINE_ERROR");
  };

  it("rendering failure", () => {
    const flow = cfg(
      withVars(flowWith({ m: { type: "MESSAGE", text: "Hi {{n}}", next: "done" } }, "m"), {
        n: { type: "string" },
      }),
    );
    ended(start(flow), "RENDER_REJECTED");
  });

  it("prompt-token failure", () => {
    ended(start(buttonsFlow(), null), "PROMPT_TOKEN_INVALID");
  });

  it("session-consistency failure", () => {
    const flow = buttonsFlow();
    const s = atMenu(flow);
    ended(send(flow, { ...s, variables: { x: 1 } }, tap(s, "yes")), "SESSION_INVALID");
  });

  it.each([
    ["SESSION_TRANSITION_BUDGET", { transitionCount: ENGINE_BUDGETS.transitionsPerSession }],
    ["SEND_BUDGET", { sendCount: ENGINE_BUDGETS.sendsPerSession }],
  ] as const)("budget failure %s", (code, patch) => {
    const flow = buttonsFlow();
    const s = atMenu(flow);
    ended(send(flow, { ...s, ...patch }, tap(s, "yes")), code);
  });

  it("the error node reached through an ordinary edge is a flow transition and keeps its notice", () => {
    const r = start(cfg(flowWith({}, "to_staff")), null);
    expect(r.error).toBeUndefined();
    expect(r.effects).toEqual([
      {
        type: "SEND",
        stepSeq: 1,
        nodeId: "to_staff",
        terminalNotice: true,
        message: { kind: "text", text: "A person will reply." },
      },
    ]);
    expect(r.session).toMatchObject({
      endReason: "flow_handover",
      handoverReason: "needs_staff",
      terminalNoticeStepSeq: 1,
    });
  });
});

describe("review corrections: END / HANDOVER render failures follow errorNodeId", () => {
  /** QUESTION (n) -> fin, where fin is an END or HANDOVER whose final message interpolates {{n}}. */
  const finFlow = (fin: Json, startAt: "ask" | "fin") =>
    cfg(
      withVars(
        flowWith(
          {
            ask: {
              type: "QUESTION",
              text: "Value?",
              variable: "n",
              answer: { kind: "text", max: 500 },
              next: "fin",
              onInvalid: "to_staff",
            },
            fin,
          },
          startAt,
        ),
        { n: { type: "string", maxLength: 500 } },
      ),
    );
  const terminals = [
    ["END", (message: string) => ({ type: "END", message })],
    ["HANDOVER", (message: string) => ({ type: "HANDOVER", reason: "other", message })],
  ] as const;
  const routedToError = (r: StepResult, reason: string, rejected?: string) => {
    expect(r).toMatchObject({
      outcome: "HANDED_OVER",
      error: "RENDER_REJECTED",
      effects: [],
      renderFailures: [{ nodeId: "fin", field: "message", reason }],
    });
    expect(r.trace.map((t) => t.nodeId).slice(-2)).toEqual(["fin", "to_staff"]);
    expect(r.session).toMatchObject({
      currentNodeId: "to_staff",
      endReason: "error",
      handoverReason: "engine_error",
      terminalNoticeStepSeq: null,
    });
    // neither a send effect nor a diagnostic carries the refused content
    if (rejected) {
      const { effects, renderFailures, trace, error } = r;
      expect(JSON.stringify({ effects, renderFailures, trace, error })).not.toContain(rejected);
    }
  };
  const answered = (flow: FlowConfig, value: string) =>
    send(flow, accept(flow, start(flow).session!).session!, text(value));

  it.each(terminals)("%s with a missing variable (as the first node)", (_t, make) => {
    routedToError(start(finFlow(make("Bye {{n}}"), "fin"), null), "VARIABLE_MISSING");
  });

  it.each(terminals)("%s with a prohibited rendered URL", (_t, make) => {
    const flow = finFlow(make("Go to {{n}}"), "ask");
    routedToError(answered(flow, "http://example.org"), "URL_POLICY", "http://example.org");
  });

  it.each(terminals)("%s with an oversized rendered message", (_t, make) => {
    const flow = finFlow(make(`${"x".repeat(1000)} {{n}}`), "ask");
    routedToError(answered(flow, "y".repeat(24)), "TEXT_TOO_LONG");
    // one character less fits and is the ordinary terminal notice
    const fits = answered(flow, "y".repeat(23));
    expect(fits.effects).toMatchObject([{ nodeId: "fin", terminalNotice: true }]);
    expect(fits.session!.terminalNoticeStepSeq).toBe(fits.session!.stepSeq);
  });

  it("a failing message on the error node itself, reached by an ordinary edge, ends there once without a notice", () => {
    const flow = cfg(
      withVars(
        {
          ...minimalFlow(),
          startNodeId: "to_staff",
          nodes: {
            welcome: { type: "MESSAGE", text: "Hello", next: "done" },
            done: { type: "END" },
            to_staff: { type: "HANDOVER", reason: "needs_staff", message: "Sorry {{n}}" },
          },
        },
        { n: { type: "string" } },
      ),
    );
    const r = start(flow, null);
    expect(r).toMatchObject({
      outcome: "HANDED_OVER",
      error: "RENDER_REJECTED",
      effects: [],
      noticeSkipped: "ENGINE_ERROR",
      renderFailures: [{ nodeId: "to_staff", field: "message", reason: "VARIABLE_MISSING" }],
    });
    expect(r.trace.map((t) => t.nodeId)).toEqual(["to_staff", "to_staff"]);
    expect(r.session).toMatchObject({ endReason: "error", terminalNoticeStepSeq: null });
  });
});

describe("execution budgets", () => {
  const chain = (count: number) => {
    const nodes: Record<string, Json> = {};
    for (let i = 0; i < count; i++)
      nodes[`s${i}`] = {
        type: "SET_VARIABLE",
        variable: "x",
        value: i,
        next: i + 1 < count ? `s${i + 1}` : "done",
      };
    return cfg(withVars(flowWith(nodes, "s0"), { x: { type: "integer" } }));
  };

  it(`at most ${ENGINE_BUDGETS.transitionsPerStep} nodes are entered in one step`, () => {
    const fits = start(chain(19), null); // 19 + END = 20
    expect(fits).toMatchObject({ outcome: "COMPLETED" });
    expect(fits.error).toBeUndefined();
    const over = start(chain(20), null); // 21
    expect(over).toMatchObject({ outcome: "HANDED_OVER", error: "STEP_TRANSITION_BUDGET" });
    expect(over.trace.at(-1)).toEqual({ nodeId: "to_staff", type: "HANDOVER" });
  });

  it("an automatic loop (impossible in a validated flow) still terminates at the step budget", () => {
    const base = cfg(withVars(minimalFlow(), { x: { type: "integer" } }));
    const looping: FlowConfig = {
      ...base,
      startNodeId: "a",
      nodes: {
        ...base.nodes,
        a: { type: "SET_VARIABLE", variable: "x", value: 1, next: "b" },
        b: { type: "SET_VARIABLE", variable: "x", value: 2, next: "a" },
      },
    };
    const r = start(looping, null);
    expect(r.error).toBe("STEP_TRANSITION_BUDGET");
    expect(r.trace).toHaveLength(ENGINE_BUDGETS.transitionsPerStep + 1);
    expect(r.session!.transitionCount).toBe(ENGINE_BUDGETS.transitionsPerStep);
  });

  it(`at most ${ENGINE_BUDGETS.transitionsPerSession} nodes over the session`, () => {
    const flow = buttonsFlow();
    const s = atMenu(flow);
    const at = (transitionCount: number) => send(flow, { ...s, transitionCount }, tap(s, "yes"));
    expect(at(ENGINE_BUDGETS.transitionsPerSession - 1)).toMatchObject({
      outcome: "WAITING_FOR_SEND",
    });
    expect(at(ENGINE_BUDGETS.transitionsPerSession)).toMatchObject({
      error: "SESSION_TRANSITION_BUDGET",
      outcome: "HANDED_OVER",
    });
  });

  it(`at most ${ENGINE_BUDGETS.sendsPerSession} sends over the session; the notice is skipped when none is left`, () => {
    const flow = buttonsFlow();
    const s = atMenu(flow);
    const at = (sendCount: number) => send(flow, { ...s, sendCount }, tap(s, "yes"));
    expect(at(ENGINE_BUDGETS.sendsPerSession - 1).session!.sendCount).toBe(
      ENGINE_BUDGETS.sendsPerSession,
    );
    const over = at(ENGINE_BUDGETS.sendsPerSession);
    expect(over).toMatchObject({
      error: "SEND_BUDGET",
      noticeSkipped: "ENGINE_ERROR",
      effects: [],
      outcome: "HANDED_OVER",
    });
    expect(over.session).toMatchObject({ endReason: "error", terminalNoticeStepSeq: null });
    // an ordinary END reached with no send left still ends as a flow transition, only without its notice
    const end = send(flow, { ...s, sendCount: ENGINE_BUDGETS.sendsPerSession }, tap(s, "no"));
    expect(end).toMatchObject({ outcome: "COMPLETED", noticeSkipped: "SEND_BUDGET", effects: [] });
    expect(end.session).toMatchObject({ endReason: "flow_end", terminalNoticeStepSeq: null });
  });

  it("variable values together stay within 4 KiB", () => {
    const vars: Json = { last: { type: "string", maxLength: 500 } };
    for (let i = 0; i < 8; i++) vars[`v${i}`] = { type: "string", maxLength: 500 };
    const flow = cfg(
      withVars(
        flowWith(
          {
            q: {
              type: "QUESTION",
              text: "?",
              variable: "last",
              answer: { kind: "text", max: 500 },
              next: "done",
              onInvalid: "to_staff",
            },
          },
          "q",
        ),
        vars,
      ),
    );
    const filled: Record<string, string> = {};
    for (let i = 0; i < 8; i++) filled[`v${i}`] = "a".repeat(500); // 4,000
    const s = { ...accept(flow, start(flow).session!).session!, variables: filled };
    expect(send(flow, s, text("b".repeat(96))).outcome).toBe("COMPLETED"); // exactly 4,096
    expect(send(flow, s, text("b".repeat(97)))).toMatchObject({
      error: "VARIABLE_STORAGE_BUDGET",
      outcome: "HANDED_OVER",
    });
  });
});

describe("determinism and safety", () => {
  it("equal arguments give equal results, input is never mutated, and no ambient state is read", () => {
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock read");
    });
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("randomness read");
    });
    const flow = deepFreeze(buttonsFlow());
    const s = deepFreeze(atMenu(flow));
    const a = send(flow, s, tap(s, "yes"));
    const b = send(flow, s, tap(s, "yes"));
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.session).not.toBe(s);
  });

  it("never throws: a hostile session fails closed with no effect", () => {
    const flow = buttonsFlow();
    const s = atMenu(flow);
    const hostile: unknown[] = [
      { ...s, state: "BOGUS" },
      { ...s, currentNodeId: "nowhere" },
      { ...s, awaiting: null },
      { ...s, stepSeq: -1 },
      { ...s, awaitingToken: s.lastConsumedToken ?? "bad" },
      { ...s, extra: 1 },
      { ...s, variables: null },
      42,
      "session",
    ];
    for (const session of hostile) {
      let r: StepResult | undefined;
      expect(() => (r = send(flow, session as BotSession, text("x")))).not.toThrow();
      expect(
        r!.effects.every((e) => e.terminalNotice),
        JSON.stringify(session),
      ).toBe(true);
      expect(["HANDED_OVER", "FAILED", "IGNORED"]).toContain(r!.outcome);
    }
  });

  it("refuses an invalid clock and a broken flow without changing anything", () => {
    const flow = buttonsFlow();
    for (const nowMs of [-1, 1.5, Number.NaN])
      expect(step(flow, null, { type: "start" }, { nowMs })).toMatchObject({
        changed: false,
        error: "CONTEXT_INVALID",
      });
    const broken = { ...flow, errorNodeId: "menu" };
    expect(start(broken)).toMatchObject({ changed: false, error: "FLOW_INVALID" });
    expect(step(flow, atMenu(flow), { type: "start" }, { nowMs: 1 })).toMatchObject({
      reason: "session_exists",
    });
    expect(
      step(flow, null, { type: "send_result", stepSeq: 1, state: "ACCEPTED" }, { nowMs: 1 }),
    ).toMatchObject({ reason: "no_session" });
  });

  it("performs no I/O: no fetch, no timers", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const flow = buttonsFlow();
      const s = atMenu(flow);
      send(flow, s, tap(s, "yes"));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
