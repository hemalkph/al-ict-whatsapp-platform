import { describe, expect, it } from "vitest";
import { normalizeEnvelope } from "../normalize";
import { parseDelivery } from "../parse";
import { fixture } from "../testing";
import { LIMITS, mapInboundMessage, parseProviderTimestamp, readReferral } from "./message-map";

// Pure mapping/validation/sanitization of the stored MESSAGE envelope, driven by the sanitized G0 fixtures.

const payloadOf = (name: string) => {
  const parsed = parseDelivery(fixture(name));
  if (!parsed.ok) throw new Error("fixture does not parse");
  const event = normalizeEnvelope(parsed.envelope).find((e) => e.eventType === "MESSAGE");
  if (!event) throw new Error(`${name} has no MESSAGE event`);
  return event.payload;
};
const map = (name: string) => mapInboundMessage(payloadOf(name));
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

describe("provider timestamps", () => {
  it("accepts positive integer epoch seconds (string or number) and keeps the exact instant", () => {
    expect(parseProviderTimestamp("1790000000")?.toISOString()).toBe("2026-09-21T14:13:20.000Z");
    expect(parseProviderTimestamp(1790000000)?.getTime()).toBe(1790000000000);
    expect(parseProviderTimestamp("1")?.getTime()).toBe(1000);
  });
  it("rejects everything else", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "0",
      "-5",
      0,
      -1,
      "12.5",
      1.5,
      "abc",
      "1e9",
      " 1790000000",
      "99999999999999",
      Number.NaN,
      {},
      [],
    ])
      expect(parseProviderTimestamp(bad), String(bad)).toBeNull();
  });
});

describe("message types (sanitized G0 fixtures)", () => {
  it("text", () => {
    expect(map("text-phone.json")).toMatchObject({
      type: "TEXT",
      body: "Does the ICT class start in January?",
      content: null,
      media: null,
      replyToWamid: null,
      referral: null,
      wamid: "wamid.FAKE00000000000000000001",
    });
  });
  it("Sinhala and Tamil text are preserved exactly", () => {
    expect(map("text-sinhala-raw-utf8.json").body).toBe(
      "\u{D86}\u{DBA}\u{DD4}\u{DB6}\u{DDD}\u{DC0}\u{DB1}\u{DCA}, ICT \u{DB4}\u{DB1}\u{DCA}\u{DAD}\u{DD2}\u{DBA} \u{D9C}\u{DD0}\u{DB1} \u{DAF}\u{DD0}\u{DB1}\u{D9C}\u{DB1}\u{DCA}\u{DB1} \u{D95}\u{DB1}\u{DDA} \u{1F44D}",
    );
    const tamil = map("text-tamil-raw-utf8.json").body!;
    expect(/[\u{B80}-\u{BFF}]/u.test(tamil)).toBe(true);
  });
  it("image: caption as body, media metadata kept, the temporary download url is NOT kept", () => {
    const m = map("image.json");
    expect(m).toMatchObject({
      type: "IMAGE",
      body: "Payment slip",
      media: { metaMediaId: "900000000000001", mimeType: "image/jpeg", filename: null },
    });
    expect(JSON.stringify(m)).not.toContain("lookaside");
    expect(m.content).toEqual({
      media: {
        id: "900000000000001",
        mime_type: "image/jpeg",
        sha256: "ZmFrZS1zaGEyNTYtZm9yLXRlc3Rpbmctb25seS0wMDE=",
        caption: "Payment slip",
      },
    });
  });
  it("document keeps its filename; audio keeps the voice flag; sticker keeps animated and has no body", () => {
    expect(map("document.json")).toMatchObject({
      type: "DOCUMENT",
      body: "my receipt",
      media: { filename: "receipt.pdf", mimeType: "application/pdf" },
    });
    const audio = map("audio-voice.json");
    expect(audio).toMatchObject({ type: "AUDIO", body: null });
    expect(audio.content).toMatchObject({
      media: { voice: true, mime_type: "audio/ogg; codecs=opus" },
    });
    const sticker = map("sticker.json");
    expect(sticker).toMatchObject({ type: "STICKER", body: null });
    expect(sticker.content).toMatchObject({ media: { animated: true } });
  });
  it("location, shared contacts", () => {
    expect(map("location.json")).toMatchObject({
      type: "LOCATION",
      body: "Test Institute",
      content: {
        latitude: 6.9,
        longitude: 79.85,
        name: "Test Institute",
        address: "1 Example Road, Colombo",
      },
    });
    const contact = map("contacts-shared.json");
    expect(contact).toMatchObject({ type: "CONTACT", body: null });
    expect(contact.content).toMatchObject({
      contacts: [
        {
          name: { formatted_name: "Test Parent" },
          phones: [{ wa_id: "15550100199", type: "MOBILE" }],
        },
      ],
    });
  });
  it("interactive replies, template quick reply, reply context", () => {
    expect(map("interactive-button-reply.json")).toMatchObject({
      type: "INTERACTIVE",
      body: "Enroll",
      content: { subtype: "button_reply", id: "enroll-button", title: "Enroll" },
      replyToWamid: "wamid.FAKE00000000000000000100",
    });
    expect(map("interactive-list-reply.json")).toMatchObject({
      type: "INTERACTIVE",
      body: "Evening batch",
      content: { subtype: "list_reply", id: "batch_evening", description: "6pm to 8pm" },
    });
    expect(map("button-quick-reply.json")).toMatchObject({
      type: "BUTTON",
      body: "Unsubscribe",
      content: { payload: "Unsubscribe", text: "Unsubscribe" },
    });
    expect(map("text-reply-context.json").replyToWamid).toBe("wamid.FAKE00000000000000000104");
    expect(map("reply-context-product.json").content).toEqual({
      context: {
        referred_product: { catalog_id: "300000000000001", product_retailer_id: "fake-product-1" },
      },
    });
  });
  it("reactions: the emoji is kept, a removal has no emoji, neither has a body", () => {
    expect(map("reaction.json")).toMatchObject({
      type: "REACTION",
      body: null,
      content: { emoji: "\u{1F44D}", target_wamid: "wamid.FAKE00000000000000000100" },
    });
    const removed = map("reaction-removed.json");
    expect(removed.type).toBe("REACTION");
    expect(removed.content).toEqual({ target_wamid: "wamid.FAKE00000000000000000100" });
  });
  it("an unknown or unsupported type is preserved as UNKNOWN without fabricated fields", () => {
    expect(map("unknown-type.json")).toMatchObject({
      type: "UNKNOWN",
      body: null,
      content: { rawType: "future_message_type" },
    });
    expect(JSON.stringify(map("unknown-type.json").content)).not.toContain("anything");
    expect(map("unsupported-edit.json")).toMatchObject({
      type: "UNKNOWN",
      content: {
        rawType: "unsupported",
        unsupported_type: "edit",
        errors: [{ code: 131051, title: "Message type unknown" }],
      },
    });
  });
  it("a Flow reply keeps only bounded scalar fields that are present (its shape is unresolved)", () => {
    const m = mapInboundMessage(
      withMessage({
        type: "interactive",
        interactive: {
          type: "nfm_reply",
          nfm_reply: {
            name: "flow",
            body: "Sent",
            response_json: '{"a":1}',
            surprise: { nested: true },
          },
        },
      }),
    );
    expect(m).toMatchObject({
      type: "FLOW",
      body: null,
      content: { subtype: "nfm_reply", name: "flow", body: "Sent", response_json: '{"a":1}' },
    });
    expect(JSON.stringify(m.content)).not.toContain("surprise");
  });
  it("video maps like the other media; an unknown interactive subtype is UNKNOWN", () => {
    const video = mapInboundMessage(
      withMessage({ type: "video", video: { id: "9", mime_type: "video/mp4", caption: "clip" } }),
    );
    expect(video).toMatchObject({ type: "VIDEO", body: "clip", media: { metaMediaId: "9" } });
    expect(
      mapInboundMessage(withMessage({ type: "interactive", interactive: { type: "mystery" } }))
        .type,
    ).toBe("UNKNOWN");
  });
  it("media without an id keeps its metadata in content but produces no attachment", () => {
    const m = mapInboundMessage(withMessage({ type: "image", image: { mime_type: "image/png" } }));
    expect(m.media).toBeNull();
    expect(m.content).toEqual({ media: { mime_type: "image/png" } });
  });
});

describe("validation and failure codes", () => {
  it("fails permanently with fixed codes", () => {
    expect(codeOf(null)).toBe("invalid_event_payload");
    expect(codeOf({ v: 1 })).toBe("invalid_event_payload");
    expect(codeOf(withMessage({ id: undefined }))).toBe("invalid_message");
    expect(codeOf(withMessage({ id: "" }))).toBe("invalid_message");
    expect(codeOf(withMessage({ type: undefined }))).toBe("invalid_message");
    expect(codeOf(withMessage({ type: "" }))).toBe("invalid_message");
    expect(codeOf(withMessage({ type: "system", system: { body: "x" } }))).toBe(
      "system_message_unsupported",
    );
    for (const timestamp of [undefined, "abc", "0", "-1", "12.5", "99999999999999", {}])
      expect(codeOf(withMessage({ timestamp })), String(timestamp)).toBe("invalid_timestamp");
  });
  it("a text longer than its limit is cut; more than four times the limit is not a WhatsApp message", () => {
    const long = mapInboundMessage(withMessage({ text: { body: "x".repeat(LIMITS.text + 100) } }));
    expect(Array.from(long.body!)).toHaveLength(LIMITS.text);
    expect(codeOf(withMessage({ text: { body: "x".repeat(LIMITS.text * 4 + 1) } }))).toBe(
      "content_too_large",
    );
    expect(
      mapInboundMessage(withMessage({ text: { body: "x".repeat(LIMITS.text * 4) } })).body,
    ).toHaveLength(LIMITS.text);
  });
  it("cuts by code points, never in the middle of a surrogate pair", () => {
    const body = mapInboundMessage(
      withMessage({ text: { body: "\u{1F600}".repeat(LIMITS.text + 5) } }),
    ).body!;
    expect(Array.from(body)).toHaveLength(LIMITS.text);
    expect(body.endsWith("\u{1F600}")).toBe(true);
  });
  it("NUL and lone surrogates are removed, normal and control whitespace is kept", () => {
    const m = mapInboundMessage(withMessage({ text: { body: "a\u0000b\ud800c\nd\te" } }));
    expect(m.body).toBe("ab\u{FFFD}c\nd\te");
  });
  it("shared contacts and errors are capped", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: { formatted_name: `P${i}` },
      phones: Array.from({ length: 20 }, () => ({ phone: "1" })),
    }));
    const m = mapInboundMessage(withMessage({ type: "contacts", contacts: many }));
    const contacts = (m.content as { contacts: { phones: unknown[] }[] }).contacts;
    expect(contacts).toHaveLength(10);
    expect(contacts[0]!.phones).toHaveLength(5);
    const errors = Array.from({ length: 9 }, (_, i) => ({ code: i, title: "t" }));
    expect(
      (
        mapInboundMessage(withMessage({ type: "unsupported", errors })).content as {
          errors: unknown[];
        }
      ).errors,
    ).toHaveLength(3);
  });
  it("location coordinates outside the valid range are dropped, not stored", () => {
    const m = mapInboundMessage(
      withMessage({ type: "location", location: { latitude: 123, longitude: 400, name: "x" } }),
    );
    expect(m.content).toEqual({ name: "x" });
  });
  it("unknown extra properties on a message are never stored", () => {
    const m = mapInboundMessage(
      withMessage({ secret_extra: { deep: [1, 2, 3] }, text: { body: "x", extra: "y" } }),
    );
    expect(JSON.stringify(m)).not.toContain("secret_extra");
    expect(m.content).toBeNull();
  });
  it("the provider timestamp is returned unchanged (never clamped)", () => {
    const m = mapInboundMessage(withMessage({ timestamp: "4102444800" }));
    expect(m.occurredAt.toISOString()).toBe("2100-01-01T00:00:00.000Z");
  });
});

describe("Click-to-WhatsApp referral", () => {
  it("official-shape referral: exact ctwa_clid, META_AD, image url as media_url, welcome text and thumbnail kept in provider_data", () => {
    const m = map("referral-ctwa-text.json");
    expect(m.referral).toEqual({
      sourceType: "META_AD",
      sourceId: "400000000000001",
      sourceUrl: "https://fb.me/FAKE0000",
      headline: "Chat with us",
      body: "Join the A/L ICT class",
      mediaType: "image",
      mediaUrl: "https://scontent.xx.fbcdn.net/v/FAKE",
      ctwaClid: "FAKE-ctwa-clid-0000000000000000000000000000000000000001",
      providerData: { welcome_message_text: "Hi! How can we help?" },
    });
    expect(m.type).toBe("TEXT"); // the message itself is an ordinary text message
  });
  it("a referral with only source_url is kept with nulls (no guessing)", () => {
    expect(readReferral({ source_url: "https://fb.me/x" })).toEqual({
      sourceType: "REFERRAL",
      sourceId: null,
      sourceUrl: "https://fb.me/x",
      headline: null,
      body: null,
      mediaType: null,
      mediaUrl: null,
      ctwaClid: null,
      providerData: null,
    });
  });
  it("a source_type other than `ad` is REFERRAL with the original kept; Facebook versus Instagram is never guessed", () => {
    for (const type of ["post", "facebook", "instagram", "story"])
      expect(readReferral({ source_type: type })).toMatchObject({
        sourceType: "REFERRAL",
        providerData: { source_type: type },
      });
    expect(readReferral({ source_type: "ad" })?.sourceType).toBe("META_AD");
  });
  it("ctwa_clid is preserved exactly and may be absent", () => {
    const clid = "AbC_123-xyz.0987654321";
    expect(readReferral({ ctwa_clid: clid })?.ctwaClid).toBe(clid);
    expect(readReferral({ source_type: "ad" })?.ctwaClid).toBeNull();
  });
  it("unknown referral properties are kept only as a small flat record; nested values are dropped; text is sanitized", () => {
    const r = readReferral({
      source_url: "https://fb.me/x",
      future_flag: true,
      future_number: 7,
      future_text: "a\u0000b",
      future_nested: { a: 1 },
      future_list: [1, 2],
      future_null: null,
    });
    expect(r?.providerData).toEqual({ future_flag: true, future_number: 7, future_text: "ab" });
  });
  it("caps the number of unknown properties and the length of their values", () => {
    const raw: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) raw[`k${i}`] = "v".repeat(100);
    expect(Object.keys(readReferral(raw)!.providerData!).length).toBeLessThanOrEqual(20);
    expect(Object.values(readReferral({ x: "y".repeat(2000) })!.providerData!)[0]).toHaveLength(
      LIMITS.providerValue,
    );
  });
  it("is null for anything that is not an object", () => {
    for (const v of [undefined, null, "x", 3, [], true]) expect(readReferral(v)).toBeNull();
  });
});
