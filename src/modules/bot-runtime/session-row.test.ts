import { describe, expect, it } from "vitest";
import { step, validateFlow, type BotSession } from "@/modules/bots";
import { enquiryFlow } from "@/modules/bots/testing";
import {
  ENGINE_SESSION_COLUMNS,
  sessionFromRow,
  sessionToColumns,
  type BotSessionRow,
} from "./session-row";

// bot_sessions row <-> the engine's BotSession (plan F.2). The mapper never repairs; the real engine decides what is valid.

const flowResult = validateFlow(enquiryFlow());
if (!flowResult.ok || flowResult.config === null) throw new Error("fixture flow must be valid");
const flow = flowResult.config;
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const NOW = 1_700_000_000_000;

/** A real, engine-produced live session (the engine's own invariants hold for it). */
const started = step(flow, null, { type: "start" }, { nowMs: NOW, promptToken: TOKEN });
const live = started.session as BotSession;

const toRow = (s: BotSession): BotSessionRow => ({
  state: s.state,
  currentNodeId: s.currentNodeId,
  variables: s.variables,
  awaiting: s.awaiting,
  awaitingToken: s.awaitingToken,
  lastConsumedToken: s.lastConsumedToken,
  stepSeq: s.stepSeq,
  transitionCount: s.transitionCount,
  sendCount: s.sendCount,
  invalidAttempts: s.invalidAttempts,
  expiresAt: s.expiresAt === null ? null : new Date(s.expiresAt),
  endReason: s.endReason,
  handoverReason: s.handoverReason,
  terminalNoticeStepSeq: s.terminalNoticeStepSeq,
});

/** Every state an engine run actually produces, to round-trip them all. */
function engineSessions(): BotSession[] {
  const out: BotSession[] = [live];
  const accepted = step(
    flow,
    live,
    { type: "send_result", stepSeq: live.stepSeq, state: "ACCEPTED" },
    { nowMs: NOW + 1_000, promptToken: "ZyXwVuTsRqPoNmLkJiHgFe" },
  );
  if (accepted.session) out.push(accepted.session);
  return out;
}

describe("the engine's own sessions round-trip exactly", () => {
  it("row -> session -> columns -> session is the identity for every state the engine produces", () => {
    const sessions = engineSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    for (const s of sessions) {
      expect(sessionFromRow(toRow(s))).toEqual(s);
      const columns = sessionToColumns(s);
      expect(sessionFromRow({ ...columns } as BotSessionRow)).toEqual(s);
    }
  });

  it("covers a waiting session with a prompt, a token and an expiry, and a terminal session", () => {
    const waiting = engineSessions().find((s) => s.state === "WAITING_FOR_INPUT");
    expect(waiting?.awaitingToken).not.toBeNull();
    expect(waiting?.expiresAt).not.toBeNull();
    const terminal: BotSession = {
      ...live,
      state: "HANDED_OVER",
      awaiting: null,
      awaitingToken: null,
      expiresAt: null,
      endReason: "flow_handover",
      handoverReason: "needs_staff",
      terminalNoticeStepSeq: live.stepSeq,
    };
    expect(sessionFromRow(toRow(terminal))).toEqual(terminal);
    expect(sessionToColumns(terminal)).toMatchObject({
      state: "HANDED_OVER",
      awaiting: null,
      awaitingToken: null,
      expiresAt: null,
      endReason: "flow_handover",
      handoverReason: "needs_staff",
      terminalNoticeStepSeq: live.stepSeq,
    });
  });
});

describe("columns to write", () => {
  it("are exactly the engine-owned columns: never revision, control sequences, timestamps the database stamps, or ownership", () => {
    expect(Object.keys(sessionToColumns(live)).sort()).toEqual([...ENGINE_SESSION_COLUMNS].sort());
    for (const owned of [
      "revision",
      "startedControlSeq",
      "handoverControlSeq",
      "startedAt",
      "endedAt",
      "organizationId",
      "conversationId",
      "deploymentId",
      "botVersionId",
      "outputSuppressedAt",
      "redactedAt",
    ])
      expect(Object.keys(sessionToColumns(live)), owned).not.toContain(owned);
  });

  it("awaiting is SQL NULL (the value null) or a plain object: never JSON text 'null', never an empty object stand-in", () => {
    const none = sessionToColumns({ ...live, awaiting: null });
    expect(none.awaiting).toBeNull();
    const some = sessionToColumns(live);
    expect(typeof some.awaiting).toBe("object");
    expect(some.awaiting).not.toBeNull();
    expect(Array.isArray(some.awaiting)).toBe(false);
  });

  it("variables are copied, not shared, and the expiry becomes a Date", () => {
    const columns = sessionToColumns({ ...live, variables: { a: "x" }, expiresAt: NOW });
    expect(columns.variables).toEqual({ a: "x" });
    expect(columns.variables).not.toBe(live.variables);
    expect(columns.expiresAt).toEqual(new Date(NOW));
  });
});

describe("an inconsistent row is never repaired: the real engine reaches SESSION_INVALID", () => {
  const input = {
    type: "student_input" as const,
    input: { kind: "text" as const, text: "x" },
    latestRequestState: "ACCEPTED" as const,
  };
  const run = (row: BotSessionRow) =>
    step(flow, sessionFromRow(row), input, {
      nowMs: NOW + 5_000,
      promptToken: "QwErTyUiOpAsDfGhJkLzXc",
    });

  const base = toRow(engineSessions().find((s) => s.state === "WAITING_FOR_INPUT") ?? live);

  it("a consistent row is accepted by the engine (the control case)", () => {
    expect(run(base).error).not.toBe("SESSION_INVALID");
  });

  it.each([
    ["an unknown state", { state: "BANANA" }],
    ["the engine-internal ACTIVE state", { state: "ACTIVE" }],
    ["awaiting that is not an object", { awaiting: "oops" }],
    ["awaiting that is an array", { awaiting: ["a"] }],
    ["variables that are not an object", { variables: "oops" }],
    ["a variable the flow does not declare", { variables: { ghost: "x" } }],
    ["a node the flow does not have", { currentNodeId: "nowhere" }],
    ["a malformed token", { awaitingToken: "short" }],
    ["a negative counter", { stepSeq: -1 }],
    ["a non-integer counter", { sendCount: 1.5 }],
    ["an invalid expiry date", { expiresAt: new Date("not a date") }],
    ["an end reason on a live session", { endReason: "error" }],
  ] as Array<[string, Partial<BotSessionRow>]>)("%s", (_name, patch) => {
    const result = run({ ...base, ...patch });
    expect(result.error).toBe("SESSION_INVALID");
    expect(result.session?.variables).toEqual({}); // the engine discards the values it cannot trust
  });

  it("the mapper passes unfitting values through unchanged (no coercion, no default)", () => {
    const mapped = sessionFromRow({
      ...base,
      awaiting: "oops",
      variables: 7,
    } as unknown as BotSessionRow);
    expect((mapped as unknown as { awaiting: unknown }).awaiting).toBe("oops");
    expect((mapped as unknown as { variables: unknown }).variables).toBe(7);
  });
});
