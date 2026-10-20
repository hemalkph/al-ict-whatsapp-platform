import { FLOW_LIMITS, ID_PATTERN } from "./limits";

// Pure text rules for configured, student-facing strings. No clock, no randomness, no I/O.

/**
 * Exact text: well-formed Unicode and no NUL or control characters other than newline, carriage return and tab. This is the
 * same predicate as `isSendableText` in the messaging module (a unit test pins that they agree); it is repeated here so a
 * pure configuration module does not import the messaging module and, through it, the database and the transport.
 */
export function isSendableText(value: string): boolean {
  return value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

/** Bidirectional overrides and isolates (U+202A-U+202E, U+2066-U+2069): they can disguise link text. ZWJ / ZWNJ stay allowed. */
const BIDI_OVERRIDE = new RegExp(String.raw`[\u202a-\u202e\u2066-\u2069]`);

export type TextProblem =
  "TEXT_INVALID_CHARACTERS" | "TEXT_BIDI_OVERRIDE" | "TEXT_BLANK" | "TEXT_UNTRIMMED";

/** The first problem with a configured string, or null. `trimmed`: leading and trailing whitespace is refused (titles, labels). */
export function textProblem(
  value: string,
  options: { readonly blankAllowed?: boolean; readonly trimmed?: boolean } = {},
): TextProblem | null {
  if (!isSendableText(value)) return "TEXT_INVALID_CHARACTERS";
  if (BIDI_OVERRIDE.test(value)) return "TEXT_BIDI_OVERRIDE";
  if (!options.blankAllowed && value.trim().length === 0) return "TEXT_BLANK";
  if (options.trimmed && value !== value.trim()) return "TEXT_UNTRIMMED";
  return null;
}

/** A comparison key for "the same title / word": NFC, trimmed, lower-cased (locale-independent). */
export function comparisonKey(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

// ----------------------------------------------------------------------------------------------------- interpolation

export type Interpolation = {
  /** Placeholder names in order of appearance (duplicates kept). */
  readonly names: readonly string[];
  /** A `{{` or `}}` that is not part of a well-formed `{{name}}` placeholder. */
  readonly malformed: boolean;
  /** The text with every well-formed placeholder removed (what the literal parts weigh). */
  readonly literal: string;
};

const WELL_FORMED = /\{\{([^{}]*)\}\}/g;

/** Finds `{{name}}` placeholders. A placeholder whose inside is not an identifier (spaces, empty, symbols) is malformed. */
export function analyzeInterpolation(value: string): Interpolation {
  const names: string[] = [];
  let malformed = false;
  const literal = value.replace(WELL_FORMED, (_all, inner: string) => {
    if (ID_PATTERN.test(inner)) names.push(inner);
    else malformed = true;
    return "";
  });
  if (literal.includes("{{") || literal.includes("}}")) malformed = true;
  return { names, malformed, literal };
}

/** The most characters one substituted value can add (V3.2: the interpolated result is re-validated, never truncated). */
export function placeholderWidth(
  variable: { type: string; maxLength?: number } | undefined,
): number {
  if (!variable) return 0;
  if (variable.type === "string") return variable.maxLength ?? FLOW_LIMITS.variableValueMax;
  if (variable.type === "integer") return 17; // a safe integer: sign and 16 digits
  return 5; // "false"
}
