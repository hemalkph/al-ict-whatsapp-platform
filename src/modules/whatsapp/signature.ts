import { createHmac, timingSafeEqual } from "node:crypto";

// THE signature rule (ADR 0013, non-negotiable): HMAC-SHA256(META_APP_SECRET, the exact received request-body bytes),
// compared with the hex digest after "sha256=" in X-Hub-Signature-256. This is the ONLY accepted algorithm.
//
// The function takes BYTES: there is deliberately no overload for a string or a parsed object, so a re-serialized,
// decoded/re-encoded, Unicode-normalized, re-escaped or canonicalized representation cannot be passed in. There is no
// second candidate and no fallback. If a real delivery ever fails on its exact received bytes, that is a transport
// investigation, never a reason to loosen this check.

const HEADER = /^sha256=([0-9a-f]{64})$/; // lowercase hex only: that is the documented shape

export type SignatureHeaderState = "missing" | "malformed" | "well_formed";

export function classifySignatureHeader(header: string | null): SignatureHeaderState {
  if (header === null || header === "") return "missing";
  return HEADER.test(header) ? "well_formed" : "malformed";
}

export function verifyWebhookSignature(
  body: Uint8Array,
  signatureHeader: string,
  secret: string,
): boolean {
  const match = HEADER.exec(signatureHeader);
  if (!match) return false;
  const provided = Buffer.from(match[1]!, "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
