import { describe, expect, it } from "vitest";
import {
  BodyTooLargeError,
  MAX_WEBHOOK_BODY_BYTES,
  declaredContentLength,
  readBoundedBody,
} from "./body";

function streamOf(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill);

describe("readBoundedBody", () => {
  it("returns exactly the bytes received, unchanged, from a single chunk", async () => {
    const input = Uint8Array.from([0x7b, 0x00, 0xff, 0xfe, 0x80, 0x7d]); // NUL and invalid UTF-8 are preserved
    expect([...(await readBoundedBody(streamOf([input])))]).toEqual([...input]);
  });

  it("reassembles many chunks in order without altering a byte", async () => {
    const input = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
    const chunks = [
      input.slice(0, 1),
      input.slice(1, 300),
      input.slice(300, 301),
      input.slice(301),
    ];
    const out = await readBoundedBody(streamOf(chunks));
    expect(Buffer.compare(out, input)).toBe(0);
  });

  it("treats an empty or absent body as zero bytes", async () => {
    expect((await readBoundedBody(null)).byteLength).toBe(0);
    expect((await readBoundedBody(streamOf([]))).byteLength).toBe(0);
  });

  it("accepts a body of exactly the limit", async () => {
    const out = await readBoundedBody(streamOf([bytes(100), bytes(100)]), 200);
    expect(out.byteLength).toBe(200);
  });

  it("rejects limit + 1 bytes, spread over several chunks, and stops reading the stream", async () => {
    let cancelled = false;
    await expect(
      readBoundedBody(
        streamOf([bytes(100), bytes(100), bytes(1), bytes(5000)], () => (cancelled = true)),
        200,
      ),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelled).toBe(true);
  });

  it("rejects a single oversized chunk", async () => {
    await expect(readBoundedBody(streamOf([bytes(201)]), 200)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it("uses a 4 MiB hard limit by default", async () => {
    expect(MAX_WEBHOOK_BODY_BYTES).toBe(4 * 1024 * 1024);
    const exactly = await readBoundedBody(streamOf([bytes(MAX_WEBHOOK_BODY_BYTES)]));
    expect(exactly.byteLength).toBe(MAX_WEBHOOK_BODY_BYTES);
    await expect(
      readBoundedBody(streamOf([bytes(MAX_WEBHOOK_BODY_BYTES), bytes(1)])),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("propagates a stream failure instead of returning a partial body", async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(10));
        controller.error(new Error("socket reset"));
      },
    });
    await expect(readBoundedBody(failing)).rejects.toThrow("socket reset");
  });
});

describe("declaredContentLength (only a hint, never the protection)", () => {
  it("reads a plain integer and ignores anything else", () => {
    expect(declaredContentLength(new Headers({ "content-length": "1234" }))).toBe(1234);
    expect(declaredContentLength(new Headers({ "content-length": "0" }))).toBe(0);
    for (const bad of ["", "-1", "12.5", "1e3", "abc", "1 2", "0x10", "9".repeat(20)]) {
      expect(declaredContentLength(new Headers({ "content-length": bad })), bad).toBeNull();
    }
    expect(declaredContentLength(new Headers())).toBeNull();
  });
});
