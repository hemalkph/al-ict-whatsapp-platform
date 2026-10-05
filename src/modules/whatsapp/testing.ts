import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

// TEST-ONLY helpers (never imported by production code; excluded from the boundary scans). The signer here is the
// plain textbook HMAC over the given bytes, written independently of signature.ts so the tests do not verify the
// verifier with itself.

export const TEST_APP_SECRET = "test-meta-app-secret-0123456789abcdef";
export const TEST_VERIFY_TOKEN = "test-verify-token-0123456789abcdef-0123456789";
export const WEBHOOK_URL = "https://app.example.test/api/webhooks/whatsapp";

export const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));

export const sign = (body: Uint8Array, secret: string = TEST_APP_SECRET): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** A POST with the given exact bytes and, by default, a valid signature over exactly those bytes. */
export function webhookPost(
  body: Uint8Array | string,
  options: { signature?: string | null; secret?: string; headers?: Record<string, string> } = {},
): Request {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...options.headers,
  };
  const signature =
    options.signature === undefined ? sign(bytes, options.secret) : options.signature;
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  return new Request(WEBHOOK_URL, { method: "POST", headers, body: bytes as BodyInit });
}

export function webhookGet(query: Record<string, string>): Request {
  return new Request(`${WEBHOOK_URL}?${new URLSearchParams(query)}`);
}
