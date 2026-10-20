import { canonicalJson } from "@/shared/canonical-json";
import { FLOW_LIMITS, SUPPLEMENTARY_LIMITS } from "./limits";
import type { FlowConfig } from "./types";

// The canonical form of a flow and the guard that runs before anything else reads untrusted input. The canonicalization is
// the project's one RFC 8785 implementation (src/shared/canonical-json.ts); no second mechanism is introduced. Hashing the
// canonical form is the publishing service's job (08C).

export type JsonShape = "ok" | "CONFIG_NOT_JSON" | "CONFIG_TOO_DEEP" | "CONFIG_TOO_LARGE";

/**
 * Walks the input once, iteratively (a hostile nesting cannot overflow the stack), and refuses anything that is not plain JSON
 * data or is unreasonably large or deep, BEFORE any recursive code or the canonicalizer sees it. Priority when several
 * apply: too large, then not JSON, then too deep.
 *
 * Work is bounded by `jsonValuesMax`: every value (the root included) is counted when it is queued, and an array or object
 * whose width exceeds the remaining budget is refused from its `length` / key count before any element is read, so a dense
 * or sparse array of any length costs one step.
 */
export function checkJsonShape(root: unknown): JsonShape {
  const limit = SUPPLEMENTARY_LIMITS.jsonValuesMax;
  const unitsMax = FLOW_LIMITS.configBytesMax; // UTF-8 bytes are never fewer than UTF-16 code units
  let values = 1; // the root
  let units = 0;
  let notJson = false;
  let tooDeep = false;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];

  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) notJson = true;
      continue;
    }
    if (typeof value === "string") {
      units += value.length;
      if (units > unitsMax) return "CONFIG_TOO_LARGE";
      continue;
    }
    if (typeof value !== "object") {
      notJson = true; // undefined, function, symbol, bigint
      continue;
    }
    if (depth >= SUPPLEMENTARY_LIMITS.jsonDepthMax) {
      tooDeep = true;
      continue;
    }
    if (Array.isArray(value)) {
      values += value.length;
      if (values > limit) return "CONFIG_TOO_LARGE";
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) {
          notJson = true; // a hole
          continue;
        }
        stack.push({ value: value[i], depth: depth + 1 });
      }
      continue;
    }
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      notJson = true; // a Date, Map, class instance, ...
      continue;
    }
    const keys = Object.keys(value);
    values += keys.length;
    if (values > limit) return "CONFIG_TOO_LARGE";
    for (const key of keys) {
      units += key.length;
      if (units > unitsMax) return "CONFIG_TOO_LARGE";
      stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
  return notJson ? "CONFIG_NOT_JSON" : tooDeep ? "CONFIG_TOO_DEEP" : "ok";
}

/** UTF-8 size of the canonical JSON of a value that passed `checkJsonShape`. */
export function canonicalSizeBytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

/** The canonical (RFC 8785) JSON text of a validated flow: what a published version stores and hashes. */
export function canonicalFlowJson(config: FlowConfig): string {
  return canonicalJson(config);
}
