import { describe, expect, it } from "vitest";
import { mapInboundMessage } from "./message-map";

// The mapper is the second line of defense: it must never cut or clean a provider identifier, whatever reaches it (the
// ingest-time check could be bypassed by an older stored event or another caller).

const NUL = String.fromCharCode(0);
const LONE = String.fromCharCode(0xd800);
const GRIN = String.fromCodePoint(0x1f600);
const withMessage = (message: Record<string, unknown>) => ({
  v: 1,
  message: {
    id: "wamid.X",
    timestamp: "1790000000",
    type: "text",
    text: { body: "hi" },
    ...message,
  },
});
const codeOf = (payload: unknown) => {
  try {
    mapInboundMessage(payload);
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};
const id = (n: number) => "w".repeat(n);

describe("identifiers are accepted exactly or rejected, never cut", () => {
  describe.each([
    [
      "reply target",
      512,
      (v: string) => withMessage({ context: { id: v } }),
      (m: ReturnType<typeof mapInboundMessage>) => m.replyToWamid,
    ],
    [
      "reaction target",
      512,
      (v: string) =>
        withMessage({
          type: "reaction",
          text: undefined,
          reaction: { message_id: v, emoji: GRIN },
        }),
      (m: ReturnType<typeof mapInboundMessage>) =>
        (m.content as { target_wamid: string }).target_wamid,
    ],
    [
      "media id",
      255,
      (v: string) =>
        withMessage({ type: "image", text: undefined, image: { id: v, mime_type: "image/jpeg" } }),
      (m: ReturnType<typeof mapInboundMessage>) => m.media?.metaMediaId,
    ],
  ])("%s (bound %i)", (_name, max, build, read) => {
    it("bound minus one and the bound are kept byte for byte", () => {
      for (const n of [max - 1, max])
        expect(read(mapInboundMessage(build(id(n)))), String(n)).toBe(id(n));
    });

    it("bound plus one is a permanent failure (invalid_provider_identifier), not a cut identifier", () => {
      expect(codeOf(build(id(max + 1)))).toBe("invalid_provider_identifier");
      expect(codeOf(build(id(max * 4 + 1)))).toBe("invalid_provider_identifier");
    });

    it("NUL, lone surrogate and control characters are rejected, not cleaned", () => {
      for (const bad of [`a${NUL}b`, `a${LONE}b`, "a\nb"])
        expect(codeOf(build(bad)), JSON.stringify(bad)).toBe("invalid_provider_identifier");
    });

    it("an identifier that only fits AFTER cleaning is still rejected", () => {
      expect(codeOf(build(id(max) + NUL))).toBe("invalid_provider_identifier"); // max + 1 raw, max after cleaning
    });

    it("valid Unicode is preserved exactly", () => {
      const v = `${GRIN}${id(10)}ස`;
      expect(read(mapInboundMessage(build(v)))).toBe(v);
    });
  });

  it("the other identifier-like references behave the same way", () => {
    const button = (v: string) =>
      withMessage({
        type: "interactive",
        text: undefined,
        interactive: { type: "button_reply", button_reply: { id: v, title: "T" } },
      });
    expect(codeOf(button(id(512)))).toBeUndefined();
    expect(codeOf(button(id(513)))).toBe("invalid_provider_identifier");
    const product = (v: string) =>
      withMessage({ context: { referred_product: { catalog_id: v, product_retailer_id: "p" } } });
    expect(codeOf(product(id(255)))).toBeUndefined();
    expect(codeOf(product(id(256)))).toBe("invalid_provider_identifier");
    const referral = (extra: Record<string, unknown>) =>
      withMessage({
        referral: { source_url: "https://example.test/a", source_type: "ad", ...extra },
      });
    expect(codeOf(referral({ ctwa_clid: id(512), source_id: id(255) }))).toBeUndefined();
    expect(codeOf(referral({ ctwa_clid: id(513) }))).toBe("invalid_provider_identifier");
    expect(codeOf(referral({ source_id: id(256) }))).toBe("invalid_provider_identifier");
  });

  it("the message's own id is exact too; an absent or empty id is still invalid_message", () => {
    expect(mapInboundMessage(withMessage({ id: id(512) })).wamid).toBe(id(512));
    expect(codeOf(withMessage({ id: id(513) }))).toBe("invalid_provider_identifier");
    expect(codeOf(withMessage({ id: "" }))).toBe("invalid_message");
    expect(codeOf(withMessage({ id: undefined }))).toBe("invalid_message");
  });

  it("ordinary text keeps its policy: cut to the limit, rejected only far beyond it", () => {
    const m = mapInboundMessage(withMessage({ text: { body: "x".repeat(4096 + 10) } }));
    expect(m.body).toHaveLength(4096); // text is still cut (the exact bytes stay in webhook_requests.raw_body)
    expect(codeOf(withMessage({ text: { body: "x".repeat(4096 * 4 + 1) } }))).toBe(
      "content_too_large",
    );
    const caption = mapInboundMessage(
      withMessage({ type: "image", text: undefined, image: { id: "m1", caption: `a${NUL}b` } }),
    );
    expect(caption.body).toBe("ab"); // captions are text: cleaned, never rejected
  });
});
