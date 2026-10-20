import type { DiagnosticCode } from "./diagnostics";
import type { AnswerKind, HandoverReasonCode, NodeType, TriggerKind, VariableType } from "./limits";

// The validated, normalized flow configuration (V3.2 section E). Plain JSON-compatible data. A published version stores
// exactly this, canonicalised (canonical.ts). Look nodes, variables and layout entries up with `getNode` / `getVariable`
// (own properties only): an identifier such as "constructor" is a legal node id.

export type Literal = string | number | boolean;

export type Trigger =
  | { readonly kind: "keyword"; readonly words: readonly string[] }
  | { readonly kind: "first_message" }
  | { readonly kind: "referral_source" };

export type FlowSettings = {
  readonly idleTimeoutMinutes: number;
  readonly maxInvalidAttempts: number;
};

export type VariableDecl = {
  readonly type: VariableType;
  readonly sensitive: boolean;
  /** Strings only (default 500). */
  readonly maxLength?: number;
};

export type ButtonOption = { readonly key: string; readonly title: string; readonly next: string };
export type ListOption = ButtonOption & { readonly description?: string };

export type Answer =
  | { readonly kind: "text"; readonly min?: number; readonly max: number }
  | { readonly kind: "integer"; readonly min?: number; readonly max?: number }
  | { readonly kind: "yes_no" };

export type Condition =
  | { readonly op: "all" | "any"; readonly conditions: readonly Condition[] }
  | { readonly op: "equals" | "not_equals"; readonly variable: string; readonly value: Literal }
  | { readonly op: "in"; readonly variable: string; readonly values: readonly Literal[] }
  | { readonly op: "is_set"; readonly variable: string }
  | { readonly op: "lt" | "gt"; readonly variable: string; readonly value: number };

export type MessageNode = {
  readonly type: "MESSAGE";
  readonly text: string;
  readonly next: string;
};
export type ButtonsNode = {
  readonly type: "BUTTONS";
  readonly body: string;
  readonly footer?: string;
  readonly options: readonly ButtonOption[];
  readonly onInvalid: string;
};
export type ListNode = {
  readonly type: "LIST";
  readonly body: string;
  readonly buttonLabel: string;
  readonly footer?: string;
  readonly options: readonly ListOption[];
  readonly onInvalid: string;
};
export type QuestionNode = {
  readonly type: "QUESTION";
  readonly text: string;
  readonly variable: string;
  readonly answer: Answer;
  readonly next: string;
  readonly onInvalid: string;
};
export type ConditionNode = {
  readonly type: "CONDITION";
  readonly branches: readonly { readonly when: Condition; readonly next: string }[];
  readonly else: string;
};
export type SetVariableNode = {
  readonly type: "SET_VARIABLE";
  readonly variable: string;
  readonly value: Literal;
  readonly next: string;
};
export type HandoverNode = {
  readonly type: "HANDOVER";
  readonly message?: string;
  readonly reason: HandoverReasonCode;
};
export type EndNode = { readonly type: "END"; readonly message?: string };

export type FlowNode =
  | MessageNode
  | ButtonsNode
  | ListNode
  | QuestionNode
  | ConditionNode
  | SetVariableNode
  | HandoverNode
  | EndNode;

export type FlowConfig = {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly startNodeId: string;
  readonly errorNodeId: string;
  readonly triggers: readonly Trigger[];
  readonly settings: FlowSettings;
  readonly variables: Readonly<Record<string, VariableDecl>>;
  readonly nodes: Readonly<Record<string, FlowNode>>;
  /** Ignored by the runtime; for the visual editor. */
  readonly layout: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
};

export type { AnswerKind, HandoverReasonCode, NodeType, TriggerKind, VariableType };

/** A configuration path: object keys and array indexes from the root, e.g. ["nodes", "welcome", "options", 0, "next"]. */
export type ConfigPath = readonly (string | number)[];

/** Only short, safe facts: identifiers, limits, counts, scheme and host names. Never configured text and never student data. */
export type DiagnosticContext = Readonly<
  Record<string, string | number | boolean | readonly string[] | readonly number[]>
>;

export type Diagnostic = {
  readonly severity: "error" | "warning";
  /** Stable machine-readable code (diagnostics.ts). Editors key their behaviour on this, not on the message. */
  readonly code: DiagnosticCode;
  /** The invalid field or connection. An empty path is the configuration as a whole. */
  readonly path: ConfigPath;
  /** The node this belongs to, when the path is inside `nodes.<id>`. */
  readonly nodeId?: string;
  /** Fixed English explanation for developers and administrators. */
  readonly message: string;
  readonly context?: DiagnosticContext;
};

export type ValidationResult = {
  /** True when there is no error (warnings do not block). */
  readonly ok: boolean;
  /** The normalized configuration; null when `ok` is false. */
  readonly config: FlowConfig | null;
  /** Errors first, then warnings; each group ordered by path then code (deterministic). */
  readonly diagnostics: readonly Diagnostic[];
  readonly errorCount: number;
  readonly warningCount: number;
};
