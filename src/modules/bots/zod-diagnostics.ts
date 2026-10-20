import type { z } from "zod";
import { Collector, isDiagnosticCode, type DiagnosticCode } from "./diagnostics";
import type { ConfigPath } from "./types";

// Maps a zod failure to structured diagnostics. Zod's own messages are never used: they can repeat the offending value.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A name that is safe to put in a message: short identifier-like text, else a placeholder. */
export function safeName(value: unknown): string {
  if (typeof value === "string")
    return /^[A-Za-z0-9_.-]{1,40}$/.test(value) ? value : "(not shown)";
  return `a ${value === null ? "null" : typeof value}`;
}

/** The value at a path of the original input, following own properties only. */
export function valueAt(root: unknown, path: ConfigPath): unknown {
  let current = root;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === "number") current = current[key];
    else if (isRecord(current) && Object.hasOwn(current, key)) current = current[key];
    else return undefined;
  }
  return current;
}

const SIZE_CODES: Record<string, { small: DiagnosticCode; big: DiagnosticCode }> = {
  string: { small: "TEXT_TOO_SHORT", big: "TEXT_TOO_LONG" },
  array: { small: "LIST_TOO_SHORT", big: "LIST_TOO_LONG" },
  number: { small: "NUMBER_TOO_SMALL", big: "NUMBER_TOO_LARGE" },
  int: { small: "NUMBER_TOO_SMALL", big: "NUMBER_TOO_LARGE" },
};

/**
 * Reports every issue of a failed parse. `base` is where the parsed value sits in the whole configuration; `root` is the
 * whole input (to tell a missing field from a wrong type).
 */
export function reportZodIssues(
  error: z.ZodError,
  base: ConfigPath,
  root: unknown,
  c: Collector,
): void {
  for (const issue of error.issues) {
    const path: (string | number)[] = [
      ...base,
      ...issue.path.map((key) => (typeof key === "symbol" ? String(key) : key)),
    ];
    switch (issue.code) {
      case "unrecognized_keys":
        for (const key of issue.keys)
          c.add("FIELD_UNKNOWN", [...path, key], { field: safeName(key) });
        break;
      case "invalid_type":
        if (valueAt(root, path) === undefined) c.add("FIELD_REQUIRED", path);
        else c.add("FIELD_TYPE_INVALID", path, { expected: String(issue.expected) });
        break;
      case "too_small":
      case "too_big": {
        const codes = SIZE_CODES[String(issue.origin)];
        if (!codes) {
          c.add("FIELD_INVALID", path);
          break;
        }
        if (issue.code === "too_small") c.add(codes.small, path, { min: Number(issue.minimum) });
        else c.add(codes.big, path, { max: Number(issue.maximum) });
        break;
      }
      case "invalid_value":
        // a missing enum / literal field arrives here too: required, not "not allowed"
        if (valueAt(root, path) === undefined) c.add("FIELD_REQUIRED", path);
        else c.add("VALUE_NOT_ALLOWED", path, { allowed: issue.values.map((v) => String(v)) });
        break;
      case "custom": {
        const params = (issue.params ?? {}) as { code?: unknown; min?: unknown; max?: unknown };
        const context: Record<string, number> = {};
        if (typeof params.min === "number") context.min = params.min;
        if (typeof params.max === "number") context.max = params.max;
        c.add(
          isDiagnosticCode(params.code) ? params.code : "FIELD_INVALID",
          path,
          Object.keys(context).length > 0 ? context : undefined,
        );
        break;
      }
      default:
        c.add("FIELD_INVALID", path);
    }
  }
}

/** Parses `value` with `schema`; returns the data, or reports the problems and returns undefined. */
export function parseWith<S extends z.ZodType>(
  schema: S,
  value: unknown,
  base: ConfigPath,
  root: unknown,
  c: Collector,
): z.infer<S> | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  reportZodIssues(result.error, base, root, c);
  return undefined;
}
