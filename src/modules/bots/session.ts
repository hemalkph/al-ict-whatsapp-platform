import { ENGINE_BUDGETS, FLOW_LIMITS } from "./limits";
import { getNode, getVariable } from "./lookup";
import { isPromptToken } from "./reply-id";
import { isSendableText } from "./text";
import type { FlowConfig, Literal } from "./types";

// The engine's session model (Phase 08B, V3.2 G.1 / G.5). Plain JSON-compatible data, so 08C can store it as columns and
// 08E can hand it back unchanged. Only the fields the PURE engine needs: identifiers of the organization, conversation,
// deployment, request and control sequence are the runtime's.

export const SESSION_STATES = [
  "WAITING_FOR_SEND",
  "WAITING_FOR_INPUT",
  "COMPLETED",
  "HANDED_OVER",
  "FAILED",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const TERMINAL_SESSION_STATES = ["COMPLETED", "HANDED_OVER", "FAILED"] as const;

export type EndReason = "flow_end" | "flow_handover" | "idle_timeout" | "system_handover" | "error";

/** A node whose outbound message the session is waiting on. */
export type AwaitingKind = "MESSAGE" | "BUTTONS" | "LIST" | "QUESTION";

export type Awaiting = {
  readonly nodeId: string;
  readonly kind: AwaitingKind;
  /** QUEUED: the request is not yet ACCEPTED (WAITING_FOR_SEND). SENT: accepted, waiting for the student (prompts only). */
  readonly phase: "QUEUED" | "SENT";
  /** The option keys a reply may carry (BUTTONS / LIST); empty otherwise. */
  readonly optionKeys: readonly string[];
};

export type BotSession = {
  readonly state: SessionState;
  readonly currentNodeId: string;
  readonly variables: Readonly<Record<string, Literal>>;
  readonly awaiting: Awaiting | null;
  /** The token of the pending prompt (every BUTTONS, LIST and QUESTION prompt has one; a MESSAGE has none). */
  readonly awaitingToken: string | null;
  readonly lastConsumedToken: string | null;
  /** Incremented by every step that runs nodes or ends the session; a send effect carries the value of its step. */
  readonly stepSeq: number;
  readonly transitionCount: number;
  readonly sendCount: number;
  readonly invalidAttempts: number;
  /** Idle expiry (epoch milliseconds), set while waiting for input. */
  readonly expiresAt: number | null;
  readonly endReason: EndReason | null;
  /** The HANDOVER node's configured reason, or a system reason (SYSTEM_HANDOVER_REASONS). */
  readonly handoverReason: string | null;
  /** The step whose send effect is the terminal notice (V3.2 I.5); null when none was produced. */
  readonly terminalNoticeStepSeq: number | null;
};

const SESSION_KEYS = [
  "awaiting",
  "awaitingToken",
  "currentNodeId",
  "endReason",
  "expiresAt",
  "handoverReason",
  "invalidAttempts",
  "lastConsumedToken",
  "sendCount",
  "state",
  "stepSeq",
  "terminalNoticeStepSeq",
  "transitionCount",
  "variables",
].join(",");

export const isTerminalState = (state: SessionState): boolean =>
  (TERMINAL_SESSION_STATES as readonly string[]).includes(state);

/** Total size of the variable values, in UTF-16 code units of their text form (the 4 KiB budget). */
export function variablesSize(variables: Readonly<Record<string, Literal>>): number {
  let total = 0;
  for (const value of Object.values(variables)) total += String(value).length;
  return total;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const isTokenOrNull = (value: unknown) => value === null || isPromptToken(value);

/** True when a stored value has exactly the declared type and fits its limits. No coercion: "5" is not an integer. */
export function fitsVariable(flow: FlowConfig, name: string, value: unknown): value is Literal {
  const decl = getVariable(flow, name);
  if (!decl) return false;
  if (decl.type === "integer") return Number.isSafeInteger(value);
  if (decl.type === "boolean") return typeof value === "boolean";
  return (
    typeof value === "string" &&
    value.length <= (decl.maxLength ?? FLOW_LIMITS.variableValueMax) &&
    isSendableText(value)
  );
}

/**
 * Checks a LIVE session handed back by the runtime against the flow it runs. Returns null when it is consistent, otherwise a
 * short reason. The engine never repairs a session: an inconsistent one goes to the error node (or is ignored when terminal).
 */
export function checkLiveSession(flow: FlowConfig, s: BotSession): string | null {
  const raw: unknown = s;
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== SESSION_KEYS) return "shape";
  if (!(SESSION_STATES as readonly unknown[]).includes(raw.state)) return "state";
  if (typeof raw.currentNodeId !== "string" || !getNode(flow, raw.currentNodeId)) return "node";
  for (const field of ["stepSeq", "transitionCount", "sendCount", "invalidAttempts"] as const)
    if (!isCount(raw[field])) return field;
  if (!isTokenOrNull(raw.awaitingToken) || !isTokenOrNull(raw.lastConsumedToken)) return "token";
  if (raw.awaitingToken !== null && raw.awaitingToken === raw.lastConsumedToken) return "token";
  if (raw.expiresAt !== null && !isCount(raw.expiresAt)) return "expiresAt";
  if (raw.endReason !== null || raw.handoverReason !== null || raw.terminalNoticeStepSeq !== null)
    return "ended";

  if (!isRecord(raw.variables)) return "variables";
  for (const [name, value] of Object.entries(raw.variables))
    if (!fitsVariable(flow, name, value)) return "variables";
  if (variablesSize(raw.variables as Record<string, Literal>) > ENGINE_BUDGETS.variablesTotalMax)
    return "variables";

  const awaiting = raw.awaiting;
  if (!isRecord(awaiting) || awaiting.nodeId !== raw.currentNodeId) return "awaiting";
  const node = getNode(flow, raw.currentNodeId);
  if (!node || node.type !== awaiting.kind) return "awaiting";
  const expectedKeys =
    node.type === "BUTTONS" || node.type === "LIST" ? node.options.map((o) => o.key) : [];
  if (
    !Array.isArray(awaiting.optionKeys) ||
    awaiting.optionKeys.join(",") !== expectedKeys.join(",")
  )
    return "awaiting";
  const phase = raw.state === "WAITING_FOR_SEND" ? "QUEUED" : "SENT";
  if (awaiting.phase !== phase) return "awaiting";
  const isMessage = node.type === "MESSAGE";
  if (isMessage ? raw.awaitingToken !== null : raw.awaitingToken === null) return "token";
  if (raw.state === "WAITING_FOR_INPUT" && (isMessage || raw.expiresAt === null)) return "awaiting";
  return null;
}
