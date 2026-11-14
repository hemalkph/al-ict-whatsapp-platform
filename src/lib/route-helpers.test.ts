import { describe, expect, it } from "vitest";
import { ValidationError } from "@/shared/errors/http-errors";
import { MAX_BODY_BYTES, pageQuery, readJsonBody, withTarget } from "./route-helpers";

// The shared HTTP body reader (DEV-1): limits are RAW BYTES as received, enforced while reading, with the decoding of
// request.text(). No database: only Request objects.

const UTF8 = new TextEncoder();
const bytes = (s: string) => UTF8.encode(s).byteLength;
const DRAFT_MAX = 512 * 1024;
const JSON_TYPE = { "content-type": "application/json" };

/** A request whose body arrives as the given chunks, with no Content-Length unless one is stated. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = JSON_TYPE) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[state.pulled];
        if (chunk === undefined) return controller.close();
        state.pulled++;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request("http://localhost/x", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
  return { request, state };
}
const plain = (text: string, headers: Record<string, string> = JSON_TYPE) =>
  new Request("http://localhost/x", { method: "POST", headers, body: text });
/** `{"pad":"…"}` of exactly `size` raw bytes, padded with `unit` (which must divide the remainder). */
function sized(size: number, unit = "x") {
  const envelope = bytes('{"pad":""}');
  const count = (size - envelope) / bytes(unit);
  if (!Number.isInteger(count)) throw new RangeError("size not reachable with this unit");
  const text = `{"pad":"${unit.repeat(count)}"}`;
  if (bytes(text) !== size) throw new RangeError("size mismatch");
  return text;
}
const refused = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(ValidationError);

describe("readJsonBody: the default limit is 16,384 raw bytes", () => {
  it("accepts exactly 16,384 bytes and refuses 16,385, for ASCII", async () => {
    expect(MAX_BODY_BYTES).toBe(16_384);
    expect(await readJsonBody(plain(sized(16_384)), false)).toMatchObject({
      pad: expect.any(String),
    });
    await refused(readJsonBody(plain(sized(16_385)), false));
  });

  it("counts bytes, not characters: a Sinhala body under 16,384 characters but over 16,384 bytes is refused (DEV-1 change)", async () => {
    // 3 bytes per letter: 5,458 letters + the 10-byte envelope = 16,384 bytes; one more letter = 16,387.
    const at = sized(16_384, "අ");
    expect(at.length).toBe(5_468);
    expect(await readJsonBody(plain(at), false)).toEqual({ pad: "අ".repeat(5_458) });
    const over = sized(16_387, "අ");
    expect(over.length).toBeLessThan(16_384); // the old character count would have let it through
    await refused(readJsonBody(plain(over), false));
    // a 4-byte emoji is two UTF-16 units: 4,093 fit (16,382 bytes), 4,094 do not (16,386 bytes, 8,198 characters)
    expect(await readJsonBody(plain(sized(16_382, "😀")), false)).toBeTruthy();
    await refused(readJsonBody(plain(sized(16_386, "😀")), false));
  });

  it("whitespace and escaping count: the same parsed value fits compact and is refused padded or \\u-escaped", async () => {
    const value = { pad: "අ".repeat(4_000) };
    const compact = JSON.stringify(value);
    expect(bytes(compact)).toBe(12_010);
    expect(await readJsonBody(plain(compact), false)).toEqual(value);
    const padded = `${" ".repeat(5_000)}${compact}`;
    const escaped = `{"pad":"${"\\u0d85".repeat(4_000)}"}`;
    expect(JSON.parse(padded)).toEqual(value);
    expect(JSON.parse(escaped)).toEqual(value);
    await refused(readJsonBody(plain(padded), false));
    await refused(readJsonBody(plain(escaped), false));
  });

  it("a declared Content-Length over the limit is refused without reading the body", async () => {
    const { request, state } = streamed([UTF8.encode("{}")], {
      ...JSON_TYPE,
      "content-length": "16385",
    });
    await refused(readJsonBody(request, false));
    expect(state.pulled).toBe(0);
  });

  it("an absent or understated Content-Length does not help: the stream is cancelled at the chunk that crosses the limit", async () => {
    const chunk = UTF8.encode("x".repeat(4_096));
    for (const headers of [JSON_TYPE, { ...JSON_TYPE, "content-length": "10" }]) {
      const { request, state } = streamed(
        Array.from({ length: 50 }, () => chunk),
        headers,
      );
      await refused(readJsonBody(request, false));
      expect(state.pulled).toBe(5); // 5 x 4,096 = 20,480 > 16,384: the other 45 chunks are never read
      expect(state.cancelled).toBe(true);
    }
  });

  it("an overstated but in-limit Content-Length changes nothing", async () => {
    const { request } = streamed([UTF8.encode('{"a":1}')], {
      ...JSON_TYPE,
      "content-length": "9000",
    });
    expect(await readJsonBody(request, false)).toEqual({ a: 1 });
  });

  it("a stream that fails part-way rejects with that failure and returns nothing", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(UTF8.encode('{"a":'));
        controller.error(new Error("client went away"));
      },
    });
    const request = new Request("http://localhost/x", {
      method: "POST",
      headers: JSON_TYPE,
      body,
      duplex: "half",
    } as RequestInit);
    await expect(readJsonBody(request, false)).rejects.toThrow("client went away");
  });
});

describe("readJsonBody: decoding is request.text()'s", () => {
  it("a multibyte character split across chunks is decoded whole", async () => {
    const raw = UTF8.encode('{"t":"ආයුබෝවන් வணக்கம் 😀"}');
    for (let cut = 1; cut < raw.byteLength; cut++) {
      const { request } = streamed([raw.slice(0, cut), raw.slice(cut)]);
      expect(await readJsonBody(request, false), `cut ${cut}`).toEqual({
        t: "ආයුබෝවන් வணக்கம் 😀",
      });
    }
  });

  it("malformed UTF-8 is replaced, never refused, and a BOM is dropped: identical to request.text()", async () => {
    const cases = [
      Uint8Array.of(0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xc3, 0x22, 0x7d), // {"a":"<FF><C3>"}
      Uint8Array.of(0xef, 0xbb, 0xbf, ...UTF8.encode('{"a":1}')), // BOM
      Uint8Array.of(0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe0, 0xb6), // truncated sequence at the end: not JSON either way
    ];
    for (const raw of cases) {
      const viaText = await new Request("http://localhost/x", { method: "POST", body: raw })
        .text()
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => "INVALID");
      const viaReader = await readJsonBody(streamed([raw]).request, false).catch((e: unknown) =>
        e instanceof ValidationError ? "INVALID" : Promise.reject(e),
      );
      expect(viaReader).toEqual(viaText);
    }
    expect(await readJsonBody(streamed([cases[0]!]).request, false)).toEqual({ a: "��" });
  });
});

describe("readJsonBody: empty bodies, content type and JSON", () => {
  it("keeps the existing answers and their order", async () => {
    expect(await readJsonBody(plain("", {}), true)).toEqual({});
    expect(await readJsonBody(new Request("http://localhost/x", { method: "POST" }), true)).toEqual(
      {},
    );
    await refused(readJsonBody(plain("", JSON_TYPE), false));
    for (const type of ["text/plain", "application/jsonx", ""])
      await refused(readJsonBody(plain("{}", type ? { "content-type": type } : {}), false));
    expect(
      await readJsonBody(plain("{}", { "content-type": "application/json; charset=utf-8" }), false),
    ).toEqual({});
    await refused(readJsonBody(plain("{not json"), false));
    const fields = async (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => (e as ValidationError).fields,
      );
    expect(
      await fields(readJsonBody(plain(sized(16_385), { "content-type": "text/plain" }), false)),
    ).toEqual(["body"]);
    expect(
      await fields(readJsonBody(plain("{}", { "content-type": "text/plain" }), false)),
    ).toEqual(["content-type"]);
  });
});

describe("readJsonBody: an explicit allowance (bot drafts, 524,288 bytes)", () => {
  it("accepts a body far above the default and exactly at the allowance; one byte more is refused", async () => {
    expect(await readJsonBody(plain(sized(300_000)), false, DRAFT_MAX)).toBeTruthy();
    expect(await readJsonBody(plain(sized(DRAFT_MAX)), false, DRAFT_MAX)).toBeTruthy();
    await refused(readJsonBody(plain(sized(DRAFT_MAX + 1)), false, DRAFT_MAX));
    await refused(readJsonBody(plain(sized(300_000)), false)); // the default is untouched
  });

  it("the reader does not judge depth: parseable nesting is returned, and extreme nesting inside the allowance stays bounded", async () => {
    const nested = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;
    let value = await readJsonBody(plain(nested(40)), false, DRAFT_MAX);
    let depth = 0;
    while (Array.isArray(value)) {
      depth++;
      value = value[0];
    }
    expect(depth).toBe(40);
    // 500,000 bytes of brackets: whatever the parser does with it, the outcome is a value or the ordinary 400, never a crash
    const extreme = await readJsonBody(plain(nested(250_000)), false, DRAFT_MAX).then(
      () => "parsed",
      (e: unknown) => (e instanceof ValidationError ? "refused" : Promise.reject(e)),
    );
    expect(["parsed", "refused"]).toContain(extreme);
  });
});

describe("withTarget", () => {
  it("merges the URL id under membershipId by default and under a named key on request; a body that supplies it is refused", () => {
    expect(withTarget({ role: "STAFF" }, "m1")).toEqual({ role: "STAFF", membershipId: "m1" });
    expect(withTarget({ expectedRevision: 0 }, "b1", "botId")).toEqual({
      expectedRevision: 0,
      botId: "b1",
    });
    expect(() => withTarget({ membershipId: "x" }, "m1")).toThrow(ValidationError);
    expect(() => withTarget({ botId: "x" }, "b1", "botId")).toThrow(ValidationError);
    expect(withTarget({ membershipId: "x" }, "b1", "botId")).toEqual({
      membershipId: "x",
      botId: "b1",
    });
    for (const body of [null, [], "x", 5]) expect(withTarget(body, "b1", "botId")).toBe(body);
  });
});

describe("pageQuery", () => {
  const q = (search: string) => pageQuery(`http://localhost/api/bots${search}`);
  const fields = (search: string) => {
    try {
      q(search);
    } catch (e) {
      return (e as ValidationError).fields;
    }
    return null;
  };

  it("passes single keys on as text and converts a plain-digit limit to a number", () => {
    expect(q("")).toEqual({});
    expect(q("?limit=50&cursor=abc")).toEqual({ limit: 50, cursor: "abc" });
    expect(q("?limit=999")).toEqual({ limit: 999 }); // the range is the service's rule
    expect(q("?organizationId=x")).toEqual({ organizationId: "x" }); // refused by the service's strict schema
  });

  it("refuses a repeated key and any limit that is not plain digits", () => {
    expect(fields("?limit=1&limit=2")).toEqual(["limit"]);
    expect(fields("?cursor=a&cursor=a")).toEqual(["cursor"]);
    expect(fields("?a%20b=1&a%20b=2")).toEqual(["query"]);
    expect(fields("?__proto__=1&__proto__=2")).toEqual(["__proto__"]);
    for (const bad of [
      "0",
      "05",
      "1e1",
      "",
      "%205",
      "5%20",
      "+5",
      "-1",
      "5.0",
      "1000",
      "0x10",
      "NaN",
    ])
      expect(fields(`?limit=${bad}`), bad).toEqual(["limit"]);
    expect(Object.getPrototypeOf(q("?__proto__=1"))).toBe(Object.prototype);
  });
});
