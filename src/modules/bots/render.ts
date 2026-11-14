import { severityOf } from "./diagnostics";
import { textProblem } from "./text";
import type { Literal } from "./types";
import { scanUrls } from "./urls";

// Rendering of configured text with variable values (Phase 08B), and the MANDATORY check of the fully rendered result
// (ADR 0017 section 8, ADR 0018). Static validation cannot know what a placeholder will hold, so every rendered text passes
// the same rules as configured text: sendable Unicode, no bidirectional overrides, not blank, within its limit, and the
// same URL policy (any finding the validator treats as an error refuses the text). Text is never truncated or repaired.

export type RenderFailure = "VARIABLE_MISSING" | "TEXT_INVALID" | "TEXT_TOO_LONG" | "URL_POLICY";

export type Rendered =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: RenderFailure };

/** The same placeholder grammar the validator accepts; substitution is single-pass, so a value is never re-expanded. */
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g;

/** The text form of a value: a string as is, an integer in decimal, a boolean as `true` / `false`. Nothing else renders. */
function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Number.isSafeInteger(value)) return String(value);
  return undefined;
}

/**
 * Substitutes `{{name}}` placeholders and checks the result. A variable that is not set (or holds anything but a literal) is
 * a failure, never empty text, `undefined` or `[object Object]` (owner decision: strict missing variables).
 */
export function renderText(
  template: string,
  variables: Readonly<Record<string, Literal>>,
  max: number,
): Rendered {
  let missing = false;
  const text = template.replace(PLACEHOLDER, (_all, name: string) => {
    const value = Object.hasOwn(variables, name) ? textOf(variables[name]) : undefined;
    if (value === undefined) missing = true;
    return value ?? "";
  });
  if (missing) return { ok: false, reason: "VARIABLE_MISSING" };
  if (textProblem(text) !== null) return { ok: false, reason: "TEXT_INVALID" };
  if (text.length > max) return { ok: false, reason: "TEXT_TOO_LONG" };
  if (scanUrls(text).some((finding) => severityOf(finding.code) === "error"))
    return { ok: false, reason: "URL_POLICY" };
  return { ok: true, text };
}
