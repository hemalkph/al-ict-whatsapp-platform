import { handleWebhookGet, handleWebhookPost } from "@/modules/whatsapp";

// Meta's webhook endpoint. NOT staff-authenticated: trust comes from the verification token (GET) and the HMAC
// signature over the exact body bytes (POST). src/proxy.ts excludes this path so the body is never buffered or truncated.
export function GET(request: Request) {
  return handleWebhookGet(request);
}

export function POST(request: Request) {
  return handleWebhookPost(request);
}
