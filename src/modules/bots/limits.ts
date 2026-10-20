// The published limits of the bot flow contract (Phase 08-0 V3.2 section E, ADR 0017). Pure constants.
//
// Text lengths are UTF-16 code units, the same unit the outbound messaging policy uses (policy.ts): an emoji outside the
// Basic Multilingual Plane counts as 2, a Sinhala or Tamil letter or vowel sign as 1. The unit is conservative against
// Meta's character-based limits and is what zod's string length checks measure.

export const SCHEMA_VERSION = 1 as const;

/** Limits taken from V3.2 section E. Changing one is a contract change (new schema version or an approved amendment). */
export const FLOW_LIMITS = {
  nameMax: 80,
  nodesMax: 200,
  /** Size of the CANONICAL JSON (RFC 8785) of the configuration in UTF-8 bytes. */
  configBytesMax: 64 * 1024,
  variablesMax: 50,
  /** One variable value, in UTF-16 code units. */
  variableValueMax: 500,
  /** All variable values together; enforced at run time (08B). The validator warns when declarations could exceed it. */
  variablesTotalMax: 4 * 1024,
  /** MESSAGE text, bodies, QUESTION text and the final message of HANDOVER / END. */
  textMax: 1024,
  footerMax: 60,
  buttonTitleMax: 20,
  buttonOptionsMax: 3,
  listOptionsMax: 10,
  listButtonLabelMax: 20,
  listRowTitleMax: 24,
  listRowDescriptionMax: 72,
  placeholdersPerTextMax: 10,
  /** Nesting of `all` / `any` combinators. */
  conditionDepthMax: 2,
  identifierMax: 32,
} as const;

/**
 * Bounds the V3.2 section E leaves unstated but a bounded contract needs (the configuration is also capped by
 * `configBytesMax`). They are Phase 08A proposals, listed in ADR 0017 for owner confirmation; none is a Meta limit.
 */
export const SUPPLEMENTARY_LIMITS = {
  triggersMax: 10,
  keywordWordsMax: 50,
  keywordWordMax: 40,
  conditionBranchesMax: 20,
  conditionChildrenMax: 10,
  conditionInValuesMax: 50,
  idleTimeoutMinutesMin: 1,
  idleTimeoutMinutesMax: 1440,
  maxInvalidAttemptsMin: 1,
  maxInvalidAttemptsMax: 5,
  integerAbsMax: Number.MAX_SAFE_INTEGER,
  layoutCoordinateAbsMax: 1_000_000,
  /** Deepest JSON nesting accepted before any other check (a legitimate configuration nests about 14 levels). */
  jsonDepthMax: 32,
  /** Most JSON values (and most string code units) examined before the configuration is declared too large. */
  jsonValuesMax: 100_000,
  /** The validator returns at most this many diagnostics (then one TOO_MANY_DIAGNOSTICS error). */
  diagnosticsMax: 200,
} as const;

export const DEFAULT_SETTINGS = { idleTimeoutMinutes: 30, maxInvalidAttempts: 2 } as const;

/**
 * Execution budgets of the engine (V3.2 section E, Phase 08B). Exceeding one routes the session to the error node. The
 * hourly per-conversation cap (30 bot messages) needs shared state and belongs to the runtime (08D/08E), not here.
 */
export const ENGINE_BUDGETS = {
  /** Nodes entered within one step (the error node itself is not counted). */
  transitionsPerStep: 20,
  /** Nodes entered over the whole session. */
  transitionsPerSession: 200,
  /** Outbound messages (prompts, messages, re-prompts and the terminal notice) over the whole session. */
  sendsPerSession: 60,
  /** One step produces at most one outbound message: at most one request per session is ever in flight. */
  sendsPerStep: 1,
  /** All variable values together, in UTF-16 code units of their text form. */
  variablesTotalMax: FLOW_LIMITS.variablesTotalMax,
} as const;

/** Node, option and variable identifiers. */
export const ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export const NODE_TYPES = [
  "MESSAGE",
  "BUTTONS",
  "LIST",
  "QUESTION",
  "CONDITION",
  "SET_VARIABLE",
  "HANDOVER",
  "END",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Nodes that end the session. They have no outgoing transition. */
export const TERMINAL_NODE_TYPES = ["HANDOVER", "END"] as const;
/** Nodes that stop and wait for the student's next message. Every other non-terminal node runs automatically. */
export const INPUT_WAITING_NODE_TYPES = ["BUTTONS", "LIST", "QUESTION"] as const;

export const TRIGGER_KINDS = ["keyword", "first_message", "referral_source"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const VARIABLE_TYPES = ["string", "integer", "boolean"] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const ANSWER_KINDS = ["text", "integer", "yes_no"] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

export const CONDITION_COMBINATORS = ["all", "any"] as const;
export const CONDITION_LEAF_OPERATORS = [
  "equals",
  "not_equals",
  "in",
  "is_set",
  "lt",
  "gt",
] as const;

/**
 * Reason codes a HANDOVER node may carry. A fixed, content-free list: no business wording. It is disjoint from the system
 * reasons the runtime writes (SYSTEM_HANDOVER_REASONS), so the staff indicator can always tell "the flow asked for a human"
 * from "the system handed over".
 */
export const HANDOVER_REASON_CODES = [
  "student_requested",
  "needs_staff",
  "out_of_scope",
  "invalid_input",
  "error_fallback",
  "other",
] as const;
export type HandoverReasonCode = (typeof HANDOVER_REASON_CODES)[number];

/** Reasons the runtime itself uses for `handover_reason` (V3.2 G, H, J, N). Exact codes or prefixes (ending in `_`). */
export const SYSTEM_HANDOVER_REASONS = [
  "staff_assigned",
  "staff_replied",
  "staff_status_changed",
  "conversation_resolved",
  "operator_stop",
  "deployment_stopped",
  "bot_error",
  "engine_error",
  "delivery_failed",
  "idle_timeout",
  "flow_handover",
  "send_",
] as const;
