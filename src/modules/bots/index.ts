// PUBLIC API of the bots module: the flow configuration contract and its validator (08A), and the pure execution engine and
// offline simulator (08B). Everything here is PURE: no database, no network, no clock, no randomness, no environment. It does
// not store sessions, send a message or touch the inbound pipeline (08C-08E). Pages, publishing services, the runtime and the
// future Bot Studio use ONLY these.
export { validateFlow } from "./validate";
export { evaluateCondition, evaluateReply, parseAnswer, step } from "./engine";
export type {
  EngineContext,
  EngineErrorCode,
  EngineEvent,
  InputOutcome,
  InvalidReason,
  OutboundMessage,
  ReplyEvaluation,
  RequestState,
  SendEffect,
  StepOutcome,
  StepResult,
  StudentInput,
  TraceEntry,
} from "./engine";
export { renderText } from "./render";
export type { RenderFailure, Rendered } from "./render";
export { SESSION_STATES, TERMINAL_SESSION_STATES, isTerminalState, variablesSize } from "./session";
export type { Awaiting, AwaitingKind, BotSession, EndReason, SessionState } from "./session";
export { SIMULATOR_MAX_CALLS, simulate, simulatorToken } from "./simulate";
export type { Scenario, ScenarioStep, SimulationResult, TranscriptEntry } from "./simulate";
export { canonicalFlowJson, canonicalSizeBytes, checkJsonShape } from "./canonical";
export {
  analyzeFlow,
  nodeEdges,
  isAutomaticNode,
  isInputWaitingNode,
  isTerminalNode,
} from "./graph";
export type { Edge, GraphAnalysis } from "./graph";
export { getNode, getVariable } from "./lookup";
export { DIAGNOSTIC_CODES, compareDiagnostics, severityOf, templateOf } from "./diagnostics";
export type { DiagnosticCode } from "./diagnostics";
export {
  REPLY_ID_MAX_LENGTH,
  REPLY_ID_PATTERN,
  REPLY_ID_PREFIX,
  PROMPT_TOKEN_PATTERN,
  formatReplyId,
  isPromptToken,
  isReplyId,
  parseReplyId,
} from "./reply-id";
export type { ParsedReplyId } from "./reply-id";
export {
  ANSWER_KINDS,
  DEFAULT_SETTINGS,
  ENGINE_BUDGETS,
  FLOW_LIMITS,
  HANDOVER_REASON_CODES,
  ID_PATTERN,
  INPUT_WAITING_NODE_TYPES,
  NODE_TYPES,
  SCHEMA_VERSION,
  SUPPLEMENTARY_LIMITS,
  SYSTEM_HANDOVER_REASONS,
  TERMINAL_NODE_TYPES,
  TRIGGER_KINDS,
  VARIABLE_TYPES,
} from "./limits";
export type { AnswerKind, HandoverReasonCode, NodeType, TriggerKind, VariableType } from "./limits";
export type {
  Answer,
  ButtonOption,
  ButtonsNode,
  Condition,
  ConditionNode,
  ConfigPath,
  Diagnostic,
  DiagnosticContext,
  EndNode,
  FlowConfig,
  FlowNode,
  FlowSettings,
  HandoverNode,
  ListNode,
  ListOption,
  Literal,
  MessageNode,
  QuestionNode,
  SetVariableNode,
  Trigger,
  ValidationResult,
  VariableDecl,
} from "./types";
