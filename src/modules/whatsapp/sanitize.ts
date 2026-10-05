// PostgreSQL cannot store U+0000 in text/jsonb, and rejects lone UTF-16 surrogates in jsonb. A signed delivery may
// legitimately contain either (for example a JSON "\u0000" escape), so strings are cleaned BEFORE they reach jsonb:
// NUL is removed and a lone surrogate becomes U+FFFD. This is applied only to the parsed copy stored per event; the
// exact bytes in webhook_requests.raw_body are never touched.

export function sanitizeString(value: string): string {
  return value.replaceAll("\u0000", "").toWellFormed();
}

export function sanitizeJson<T>(value: T): T {
  if (typeof value === "string") return sanitizeString(value) as T;
  if (Array.isArray(value)) return value.map(sanitizeJson) as T;
  if (value !== null && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      clean[sanitizeString(key)] = sanitizeJson(item);
    }
    return clean as T;
  }
  return value;
}
