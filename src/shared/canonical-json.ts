// RFC 8785 (JSON Canonicalization Scheme) for values produced by JSON.parse. Used ONLY to derive deterministic
// idempotency keys for webhook items that have no stable provider id. It must never be used for signature verification
// (those are computed over the exact received bytes and nothing else).
//
// This is the RFC's own sample canonicalizer (Appendix A): primitives are serialized with JSON.stringify (whose number
// output is ECMAScript Number::toString, exactly what RFC 8785 section 3.2.2 requires, and whose string escaping
// matches it) and object properties are sorted by their UTF-16 code units (the default string sort). NaN, Infinity,
// undefined and non-JSON values are refused instead of being silently dropped or coerced.

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value))
        throw new TypeError("canonicalJson: NaN and Infinity are not JSON");
      return JSON.stringify(value); // -0 becomes "0", as RFC 8785 requires
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const object = value as Record<string, unknown>;
      const members = Object.keys(object)
        .sort() // UTF-16 code unit order, independent of locale
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
      return `{${members.join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: ${typeof value} is not a JSON value`);
  }
}
