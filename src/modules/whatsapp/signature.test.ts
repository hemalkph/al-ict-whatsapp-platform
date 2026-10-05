import { describe, expect, it } from "vitest";
import { classifySignatureHeader, verifyWebhookSignature } from "./signature";
import { TEST_APP_SECRET, fixture, sign } from "./testing";

const verify = (body: Uint8Array, header: string, secret = TEST_APP_SECRET) =>
  verifyWebhookSignature(body, header, secret);

describe("verifyWebhookSignature: HMAC-SHA256 over the exact received bytes", () => {
  it("accepts a signature computed over exactly these bytes", () => {
    const body = fixture("text-phone.json");
    expect(verify(body, sign(body))).toBe(true);
  });

  it("matches a known-answer vector (so the test signer and the verifier agree with the textbook HMAC)", () => {
    // HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog") is a standard published test vector.
    const body = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
    expect(
      verifyWebhookSignature(
        body,
        "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
        "key",
      ),
    ).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const body = fixture("text-phone.json");
    expect(verify(body, sign(body, "another-secret-0123456789"))).toBe(false);
  });

  it("rejects when a single byte is flipped, for every byte position sampled", () => {
    const body = fixture("text-phone.json");
    const header = sign(body);
    for (const index of [0, 1, 17, Math.floor(body.length / 2), body.length - 2, body.length - 1]) {
      const tampered = Uint8Array.from(body);
      tampered[index] = tampered[index]! ^ 0x01;
      expect(verify(tampered, header), `byte ${index}`).toBe(false);
    }
  });

  it("rejects a body with one byte appended or removed", () => {
    const body = fixture("text-phone.json");
    const header = sign(body);
    expect(verify(Buffer.concat([body, Buffer.from(" ")]), header)).toBe(false);
    expect(verify(body.subarray(0, body.length - 1), header)).toBe(false);
  });

  describe("a signature for one representation NEVER validates another (semantically identical JSON)", () => {
    const value = JSON.parse(fixture("text-phone.json").toString("utf8")) as {
      object: string;
      entry: unknown;
    };
    const forms: Array<[string, Buffer]> = [
      ["compact", Buffer.from(JSON.stringify(value))],
      ["pretty-printed", Buffer.from(JSON.stringify(value, null, 2))],
      [
        "pretty-printed with a trailing newline",
        Buffer.from(JSON.stringify(value, null, 2) + "\n"),
      ],
      ["CRLF line endings", Buffer.from(JSON.stringify(value, null, 2).replace(/\n/g, "\r\n"))],
      [
        "different key order",
        Buffer.from(JSON.stringify({ entry: value.entry, object: value.object })),
      ],
    ];

    it("has five forms of one JSON value with five different byte sequences", () => {
      const parsed = forms.map(([, b]) => JSON.parse(b.toString("utf8")));
      for (const p of parsed) expect(p).toEqual(parsed[0]);
      expect(new Set(forms.map(([, b]) => b.toString("hex"))).size).toBe(forms.length);
    });

    it.each(
      forms.flatMap(([a, ab]) =>
        forms.filter(([b]) => b !== a).map(([b, bb]) => [a, b, ab, bb] as const),
      ),
    )(
      "a signature over the %s form does not validate the %s form",
      (_a, _b, signedBytes, otherBytes) => {
        expect(verify(otherBytes, sign(signedBytes))).toBe(false);
        expect(verify(signedBytes, sign(signedBytes))).toBe(true);
      },
    );
  });

  describe("literal UTF-8 versus \\uXXXX-escaped Unicode are different bytes and different signatures", () => {
    const literal = fixture("text-sinhala-raw-utf8.json");
    const escaped = fixture("text-sinhala-escaped.json");

    it("are the same JSON value but different bytes", () => {
      expect(JSON.parse(literal.toString("utf8"))).toEqual(JSON.parse(escaped.toString("utf8")));
      expect(literal.equals(escaped)).toBe(false);
    });

    it("a signature over the literal UTF-8 body does NOT validate the escaped body", () => {
      expect(verify(escaped, sign(literal))).toBe(false);
    });

    it("a signature over the escaped body does NOT validate the literal UTF-8 body", () => {
      expect(verify(literal, sign(escaped))).toBe(false);
    });

    it("each validates only under its own bytes", () => {
      expect(verify(literal, sign(literal))).toBe(true);
      expect(verify(escaped, sign(escaped))).toBe(true);
    });

    it("no re-serialization of the parsed body can stand in for the received bytes", () => {
      const reserialized = Buffer.from(JSON.stringify(JSON.parse(literal.toString("utf8"))));
      expect(verify(literal, sign(reserialized))).toBe(false); // pretty fixture vs compact re-serialization
      // not even a transform that preserves meaning exactly: Unicode-escaping the literal body
      const reEscaped = Buffer.from(
        literal
          .toString("utf8")
          .replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")),
      );
      expect(reEscaped.equals(escaped)).toBe(true); // it IS the escaped form ...
      expect(verify(literal, sign(reEscaped))).toBe(false); // ... and still must not validate the literal bytes
      // Unicode normalization (NFC) of the text is also a different representation
      const normalized = Buffer.from(literal.toString("utf8").normalize("NFC"));
      if (!normalized.equals(literal)) expect(verify(literal, sign(normalized))).toBe(false);
    });
  });

  describe("only the documented header shape is accepted", () => {
    const body = fixture("text-phone.json");
    const hex = sign(body).slice("sha256=".length);
    it.each([
      ["no prefix", hex],
      ["uppercase prefix", `SHA256=${hex}`],
      ["sha1 prefix", `sha1=${hex}`],
      ["uppercase hex", `sha256=${hex.toUpperCase()}`],
      ["63 hex characters", `sha256=${hex.slice(1)}`],
      ["65 hex characters", `sha256=${hex}0`],
      ["non-hex characters", `sha256=${"g".repeat(64)}`],
      ["leading space", ` sha256=${hex}`],
      ["trailing space", `sha256=${hex} `],
      ["trailing newline", `sha256=${hex}\n`],
      ["empty", ""],
      ["prefix only", "sha256="],
      ["two signatures", `sha256=${hex},sha256=${hex}`],
    ])("rejects %s even though the digest itself is right", (_name, header) => {
      expect(verify(body, header)).toBe(false);
    });

    it("classifies a missing, malformed and well-formed header", () => {
      expect(classifySignatureHeader(null)).toBe("missing");
      expect(classifySignatureHeader("")).toBe("missing");
      expect(classifySignatureHeader("sha256=abc")).toBe("malformed");
      expect(classifySignatureHeader(`SHA256=${hex}`)).toBe("malformed");
      expect(classifySignatureHeader(`sha256=${hex}`)).toBe("well_formed");
    });
  });

  it("has exactly one algorithm: a function of bytes, a header and a secret (no overloads for text or objects)", () => {
    expect(verifyWebhookSignature.length).toBe(3);
    // Compile-time proof (checked by `npm run typecheck`): passing a string or a parsed object does not type-check.
    const neverCalled = () => {
      // @ts-expect-error a string is not accepted: the signature is over bytes only
      verifyWebhookSignature("{}", "sha256=00", TEST_APP_SECRET);
      // @ts-expect-error a parsed object is not accepted either
      verifyWebhookSignature({ a: 1 }, "sha256=00", TEST_APP_SECRET);
    };
    expect(typeof neverCalled).toBe("function");
  });
});
