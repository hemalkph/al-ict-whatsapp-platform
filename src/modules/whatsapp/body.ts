// Reads the EXACT request-body bytes with a hard cap. The bytes are never decoded, parsed or re-encoded here: they are
// what the signature is computed over. Meta documents a 3 MB maximum; 4 MiB leaves slack without accepting unbounded
// bodies. Content-Length is only a hint (it can lie or be absent), so the streamed byte count is the real limit.

export const MAX_WEBHOOK_BODY_BYTES = 4 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super("The request body exceeds the webhook size limit.");
    this.name = "BodyTooLargeError";
  }
}

/** The declared Content-Length when it is a plain non-negative integer, otherwise null. */
export function declaredContentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (value === null || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

export async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  limit: number = MAX_WEBHOOK_BODY_BYTES,
): Promise<Uint8Array> {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined); // stop reading: the oversized body is never kept
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
