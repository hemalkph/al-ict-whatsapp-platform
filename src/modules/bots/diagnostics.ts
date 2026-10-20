import { SUPPLEMENTARY_LIMITS } from "./limits";
import type { ConfigPath, Diagnostic, DiagnosticContext } from "./types";

// Structured, editor-friendly validation results. A code is stable: severity and meaning never change for a code, so the
// future Bot Studio can attach behaviour to it. Messages are FIXED templates filled only from the safe `context` (identifiers,
// limits, counts, scheme and host names). Configured text is never copied into a diagnostic.

type Entry = readonly [severity: "error" | "warning", template: string];

const TABLE = {
  // The configuration as a whole
  CONFIG_NOT_JSON: [
    "error",
    "The configuration must be plain JSON data (objects, arrays, strings, finite numbers, booleans, null).",
  ],
  CONFIG_TOO_DEEP: ["error", "The configuration is nested deeper than {max} levels."],
  CONFIG_TOO_LARGE: ["error", "The configuration is larger than the limit of {max} bytes."],
  TOO_MANY_DIAGNOSTICS: [
    "error",
    "More than {max} problems were found; only the first {max} are reported.",
  ],
  VALIDATOR_INTERNAL_ERROR: [
    "error",
    "The validator could not complete. This is a defect in the validator, not in the flow.",
  ],
  // Shape
  FIELD_REQUIRED: ["error", "This field is required."],
  FIELD_UNKNOWN: ["error", "Unknown field '{field}'. Unknown fields are not accepted."],
  FIELD_TYPE_INVALID: ["error", "This field has the wrong type; expected {expected}."],
  FIELD_INVALID: ["error", "This value is not valid."],
  VALUE_NOT_ALLOWED: ["error", "This value is not one of the allowed values."],
  TEXT_TOO_SHORT: ["error", "This text is shorter than the minimum of {min}."],
  TEXT_TOO_LONG: ["error", "This text is longer than the maximum of {max} characters."],
  LIST_TOO_SHORT: ["error", "This list needs at least {min} item(s)."],
  LIST_TOO_LONG: ["error", "This list allows at most {max} item(s)."],
  NUMBER_TOO_SMALL: ["error", "This number is below the minimum of {min}."],
  NUMBER_TOO_LARGE: ["error", "This number is above the maximum of {max}."],
  NUMBER_NOT_INTEGER: [
    "error",
    "This number must be a whole number within the safe integer range.",
  ],
  TEXT_BLANK: ["error", "This text must not be blank."],
  TEXT_INVALID_CHARACTERS: ["error", "This text contains control characters or malformed Unicode."],
  TEXT_BIDI_OVERRIDE: [
    "error",
    "This text contains a bidirectional override character, which can disguise links.",
  ],
  TEXT_UNTRIMMED: ["error", "This text must not start or end with whitespace."],
  IDENTIFIER_INVALID: [
    "error",
    "Identifiers start with a lowercase letter and contain only lowercase letters, digits and underscores (at most 32 characters).",
  ],
  SCHEMA_VERSION_UNSUPPORTED: [
    "error",
    "Schema version {found} is not supported; this validator supports version {supported}.",
  ],
  NODE_COUNT_EXCEEDED: ["error", "A flow may have at most {max} nodes."],
  VARIABLE_COUNT_EXCEEDED: ["error", "A flow may declare at most {max} variables."],
  NODE_TYPE_UNSUPPORTED: ["error", "Node type '{found}' is not supported."],
  TRIGGER_KIND_UNSUPPORTED: ["error", "Trigger kind '{found}' is not supported."],
  TRIGGER_DUPLICATE: ["error", "This trigger kind appears more than once."],
  KEYWORD_DUPLICATE: ["error", "This keyword appears more than once in the trigger."],
  TERMINAL_NODE_HAS_TRANSITION: [
    "error",
    "A {type} node ends the session and must not have an outgoing transition ('{field}').",
  ],
  OPTION_KEY_DUPLICATE: ["error", "Option key '{key}' is used more than once in this node."],
  OPTION_TITLE_DUPLICATE: ["error", "Two options in this node have the same title."],
  HANDOVER_REASON_UNSUPPORTED: ["error", "This handover reason is not on the allowed list."],
  // References
  START_NODE_MISSING: ["error", "The start node '{target}' does not exist."],
  ERROR_NODE_MISSING: ["error", "The error node '{target}' does not exist."],
  ERROR_NODE_NOT_TERMINAL: [
    "error",
    "The error node must be a HANDOVER or END node; '{target}' is a {type} node.",
  ],
  REFERENCE_MISSING: ["error", "The destination node '{target}' does not exist."],
  // Variables
  VARIABLE_UNDECLARED: ["error", "Variable '{variable}' is not declared in 'variables'."],
  VARIABLE_TYPE_MISMATCH: [
    "error",
    "This does not fit variable '{variable}', which is a {variableType}.",
  ],
  VARIABLE_MAXLENGTH_NOT_ALLOWED: ["error", "'maxLength' applies to string variables only."],
  VALUE_EXCEEDS_VARIABLE: [
    "error",
    "This value is longer than variable '{variable}' allows ({max}).",
  ],
  ANSWER_FIELD_NOT_ALLOWED: ["error", "Field '{field}' is not valid for a {kind} answer."],
  ANSWER_RANGE_INVALID: ["error", "The minimum must not be greater than the maximum."],
  ANSWER_EXCEEDS_VARIABLE: [
    "error",
    "The answer may be longer than variable '{variable}' can hold ({max}).",
  ],
  VARIABLE_UNUSED: ["warning", "Variable '{variable}' is declared but never used."],
  VARIABLE_NEVER_ASSIGNED: [
    "warning",
    "Variable '{variable}' is read but no node ever assigns it.",
  ],
  VARIABLES_MAY_EXCEED_TOTAL: [
    "warning",
    "The declared variables could together hold more than {max} characters; the runtime enforces this limit.",
  ],
  // Conditions
  CONDITION_TOO_DEEP: ["error", "Conditions may nest 'all' / 'any' at most {max} levels deep."],
  CONDITION_OPERATOR_UNSUPPORTED: ["error", "Operator '{found}' is not supported."],
  // Interpolation
  INTERPOLATION_MALFORMED: [
    "error",
    "A '{{' or '}}' here is not part of a well-formed {{variable}} placeholder.",
  ],
  INTERPOLATION_UNDECLARED: [
    "error",
    "Placeholder '{variable}' refers to a variable that is not declared.",
  ],
  INTERPOLATION_NOT_ALLOWED: [
    "error",
    "Placeholders are allowed in message text only, not in titles, labels, keys or descriptions.",
  ],
  INTERPOLATION_TOO_MANY: ["error", "A text may contain at most {max} placeholders."],
  INTERPOLATED_TEXT_MAY_EXCEED_LIMIT: [
    "warning",
    "With the longest allowed variable values this text could exceed {max} characters; the run would end in the error node.",
  ],
  // URLs
  URL_SCHEME_UNSUPPORTED: [
    "error",
    "URL scheme '{scheme}' is not supported; only https links are allowed.",
  ],
  URL_MALFORMED: ["error", "This does not parse as an https URL."],
  URL_CREDENTIALS_NOT_ALLOWED: ["error", "URLs must not contain a user name or password."],
  URL_INTERPOLATION_NOT_ALLOWED: ["error", "A URL must not contain a {{variable}} placeholder."],
  URL_REVIEW_RECOMMENDED: [
    "warning",
    "This text links to {host}. Check that the link is correct and trusted before publishing.",
  ],
  URL_HOST_UNUSUAL: [
    "warning",
    "The link host {host} is an IP address, a local name, an internationalised name or uses a custom port; check it carefully.",
  ],
  URL_SCHEME_MISSING: [
    "warning",
    "A link written as 'www.' without 'https://' may be shown as a link; write the full https:// address.",
  ],
  // Graph and flow
  AUTOMATIC_CYCLE: [
    "error",
    "These nodes run one after another without waiting for the student, forever: {nodes}.",
  ],
  NODE_UNREACHABLE: [
    "warning",
    "This node can never be reached from the start node or the error node.",
  ],
  NODE_CANNOT_REACH_TERMINAL: ["error", "From this node no path leads to a HANDOVER or END node."],
  START_NODE_END_WITHOUT_MESSAGE: [
    "warning",
    "The start node is an END without a message, so this bot ends at once and sends nothing.",
  ],
  TRIGGERS_EMPTY: [
    "warning",
    "No triggers are configured, so no incoming message can start this bot.",
  ],
  LAYOUT_UNKNOWN_NODE: ["warning", "This layout entry names a node that does not exist."],
} as const satisfies Record<string, Entry>;

export type DiagnosticCode = keyof typeof TABLE;
export const DIAGNOSTIC_CODES = Object.keys(TABLE) as readonly DiagnosticCode[];

export const severityOf = (code: DiagnosticCode): "error" | "warning" => TABLE[code][0];

/** The fixed message template of a code (`{name}` marks a value taken from the diagnostic's context). */
export const templateOf = (code: DiagnosticCode): string => TABLE[code][1];

function render(template: string, context: DiagnosticContext | undefined): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = context?.[key];
    if (value === undefined) return whole;
    return Array.isArray(value) ? value.join(", ") : String(value);
  });
}

export function isDiagnosticCode(value: unknown): value is DiagnosticCode {
  return typeof value === "string" && Object.hasOwn(TABLE, value);
}

const pathKey = (path: ConfigPath) =>
  path.map((p) => (typeof p === "number" ? `#${String(p).padStart(6, "0")}` : p)).join("\u0000");

/** Errors before warnings, then by path, then by code. Total order, so the same input always yields the same list. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
  const byPath = pathKey(a.path) < pathKey(b.path) ? -1 : pathKey(a.path) > pathKey(b.path) ? 1 : 0;
  if (byPath !== 0) return byPath;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  const ma = a.message;
  const mb = b.message;
  return ma < mb ? -1 : ma > mb ? 1 : 0;
}

/** Collects diagnostics during one validation run. */
export class Collector {
  private readonly items: Diagnostic[] = [];
  private readonly seen = new Set<string>();

  add(code: DiagnosticCode, path: ConfigPath, context?: DiagnosticContext): void {
    const severity = severityOf(code);
    const message = render(TABLE[code][1], context);
    const key = `${code}\u0001${pathKey(path)}\u0001${message}`;
    if (this.seen.has(key)) return; // the same finding is reported once
    this.seen.add(key);
    const nodeId = path[0] === "nodes" && typeof path[1] === "string" ? path[1] : undefined;
    this.items.push({
      severity,
      code,
      path: [...path],
      ...(nodeId === undefined ? {} : { nodeId }),
      message,
      ...(context === undefined ? {} : { context }),
    });
  }

  get errorCount(): number {
    return this.items.filter((d) => d.severity === "error").length;
  }

  /** Sorted, and capped at `diagnosticsMax`. */
  finish(): Diagnostic[] {
    const sorted = [...this.items].sort(compareDiagnostics);
    const max = SUPPLEMENTARY_LIMITS.diagnosticsMax;
    if (sorted.length <= max) return sorted;
    const kept = sorted.slice(0, max - 1);
    const overflow = new Collector();
    overflow.add("TOO_MANY_DIAGNOSTICS", [], { max: max - 1 });
    return [...overflow.items, ...kept].sort(compareDiagnostics);
  }
}
