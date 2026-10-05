import { createHash, timingSafeEqual } from "node:crypto";

// GET verification (Meta "create a webhook endpoint"): hub.mode=subscribe, hub.verify_token, hub.challenge. Answer 200
// with the challenge only when the mode and token are right; anything else is refused.

const CHALLENGE = /^[\x20-\x7e]{1,256}$/; // printable ASCII; echoed as text/plain, so it can never become markup

/** Constant-time string comparison: both sides are hashed to a fixed length first, so lengths cannot leak. */
export function constantTimeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

export type VerificationFailure =
  "wrong_mode" | "missing_token" | "token_mismatch" | "missing_challenge" | "invalid_challenge";

export type VerificationResult =
  { ok: true; challenge: string } | { ok: false; reason: VerificationFailure };

export function checkVerification(
  params: URLSearchParams,
  expectedToken: string,
): VerificationResult {
  if (params.get("hub.mode") !== "subscribe") return { ok: false, reason: "wrong_mode" };
  const token = params.get("hub.verify_token");
  if (token === null || token === "") return { ok: false, reason: "missing_token" };
  if (!constantTimeEqual(token, expectedToken)) return { ok: false, reason: "token_mismatch" };
  const challenge = params.get("hub.challenge");
  if (challenge === null || challenge === "") return { ok: false, reason: "missing_challenge" };
  if (!CHALLENGE.test(challenge)) return { ok: false, reason: "invalid_challenge" };
  return { ok: true, challenge };
}
