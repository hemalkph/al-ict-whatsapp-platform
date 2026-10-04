import { ForbiddenError } from "@/shared/errors/http-errors";
import { emitSecurityEvent } from "./events";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null; // includes the literal "null" origin
  }
}

/**
 * True if a state-changing request provably comes from one of our own origins. Safe methods pass.
 * For other methods the `Origin` header must exactly match an allowed origin; if it is absent,
 * `Sec-Fetch-Site: same-origin` is required. Anything else (missing/opaque/foreign) is rejected, because the
 * session cookie is ambient credentials. This complements SameSite=Lax, it does not replace server-side authorization.
 */
export function isSameOriginRequest(
  request: { method: string; headers: Headers },
  allowedOrigins: readonly string[],
): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  const allowed = new Set(
    allowedOrigins.map(normalizeOrigin).filter((o): o is string => o !== null),
  );
  const origin = request.headers.get("origin");
  if (origin !== null) {
    const normalized = normalizeOrigin(origin);
    return normalized !== null && allowed.has(normalized);
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

export function assertSameOrigin(
  request: { method: string; headers: Headers },
  allowedOrigins: readonly string[],
): void {
  if (isSameOriginRequest(request, allowedOrigins)) return;
  emitSecurityEvent({
    event: "access.cross_origin_rejected",
    outcome: "denied",
    reason: "origin_mismatch",
  });
  throw new ForbiddenError("cross_origin_request");
}
