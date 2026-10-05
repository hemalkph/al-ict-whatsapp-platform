import { createHash } from "node:crypto";
import { canonicalJson } from "@/shared/canonical-json";

// Namespaced, versioned idempotency keys (global UNIQUE webhook_events.idempotency_key). Every key is scoped by the
// receiving phone_number_id (or, when absent, the WABA id, or an explicit "none"), so the identical element delivered
// for two different numbers can never collide. wamids are opaque bounded text and are never parsed.

export const sha256Hex = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

/** A short, non-reversible-in-practice tag for correlating log lines about the same provider id. */
export const shortHash = (value: string): string => sha256Hex(value).slice(0, 12);

export function scopeOf(phoneNumberId: string | null, wabaId: string | null): string {
  if (phoneNumberId) return phoneNumberId;
  if (wabaId) return `waba:${wabaId}`;
  return "none";
}

export const messageKey = (scope: string, wamid: string): string => `wa:msg:v1:${scope}:${wamid}`;

export const statusKey = (
  scope: string,
  wamid: string,
  status: string,
  timestamp: string,
): string => `wa:status:v1:${scope}:${wamid}:${status}:${timestamp}`;

/** Items without a stable provider id: the RFC 8785 canonical form of the element, hashed. */
export const otherKey = (scope: string, element: unknown): string =>
  `wa:other:v1:${scope}:${sha256Hex(canonicalJson(element))}`;

/** An element too malformed to key by provider id (kept as DEAD so it can be inspected). */
export const malformedKey = (scope: string, element: unknown): string =>
  `wa:malformed:v1:${scope}:${sha256Hex(canonicalJson(element))}`;
