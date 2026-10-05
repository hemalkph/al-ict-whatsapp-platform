import { describe, expect, it } from "vitest";
import { parseDelivery } from "./parse";
import { fixture } from "./testing";

const text = (s: string) => new TextEncoder().encode(s);
const env = (extra = "") => `{"object":"whatsapp_business_account","entry":[]${extra}}`;

describe("parseDelivery (after the signature has been verified)", () => {
  it("accepts a normal delivery and every official-derived and synthetic envelope fixture", () => {
    for (const name of [
      "text-phone.json",
      "text-bsuid-only-username.json",
      "image.json",
      "reaction.json",
      "status-delivered-phone-bsuid.json",
      "referral-ctwa-text.json",
      "multi-event-request.json",
      "multi-sender-pairing.json",
      "unsupported-field-change.json",
      "user-id-update.json",
      "empty-entry.json",
      "unknown-type.json",
    ]) {
      expect(parseDelivery(fixture(name)).ok, name).toBe(true);
    }
  });

  it("decodes Sinhala and Tamil, literal or escaped, to the same value", () => {
    const a = parseDelivery(fixture("text-sinhala-raw-utf8.json"));
    const b = parseDelivery(fixture("text-sinhala-escaped.json"));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.envelope).toEqual(b.envelope);
    expect(parseDelivery(fixture("text-tamil-raw-utf8.json")).ok).toBe(true);
  });

  it("rejects invalid UTF-8 as UNPARSEABLE/invalid_utf8 (fatal decoding, never U+FFFD replacement)", () => {
    expect(parseDelivery(fixture("invalid-utf8.bin"))).toEqual({
      ok: false,
      status: "UNPARSEABLE",
      code: "invalid_utf8",
    });
    for (const bad of [
      [0xff],
      [0xc3, 0x28],
      [0xe2, 0x82],
      [0xf0, 0x28, 0x8c, 0xbc],
      [0xc0, 0xaf],
    ]) {
      const body = Uint8Array.from([...text('{"a":"'), ...bad, ...text('"}')]);
      expect(parseDelivery(body), String(bad)).toMatchObject({
        status: "UNPARSEABLE",
        code: "invalid_utf8",
      });
    }
  });

  it("accepts a literal U+FFFD that was really sent (valid UTF-8 is not an error)", () => {
    const body = text(`{"object":"whatsapp_business_account","entry":[],"x":"�"}`);
    expect(parseDelivery(body).ok).toBe(true);
  });

  it("rejects invalid JSON as UNPARSEABLE/invalid_json", () => {
    expect(parseDelivery(fixture("invalid-json.txt"))).toEqual({
      ok: false,
      status: "UNPARSEABLE",
      code: "invalid_json",
    });
    for (const bad of [
      "",
      " ",
      "{",
      "{'a':1}",
      "undefined",
      '{"a":1,}',
      "NaN",
      '{"a":1} trailing',
    ]) {
      expect(parseDelivery(text(bad)), JSON.stringify(bad)).toMatchObject({ code: "invalid_json" });
    }
  });

  it("keeps a byte-order mark visible so JSON.parse refuses it instead of silently stripping it", () => {
    const body = Uint8Array.from([0xef, 0xbb, 0xbf, ...text(env())]);
    expect(parseDelivery(body)).toMatchObject({ status: "UNPARSEABLE", code: "invalid_json" });
  });

  it.each([
    ["an array", "[]", "top_level_not_object"],
    ["a string", '"x"', "top_level_not_object"],
    ["null", "null", "top_level_not_object"],
    ["a number", "1", "top_level_not_object"],
    ["an unrelated object", '{"hello":"world"}', "unexpected_object"],
    ["another product's object", '{"object":"page","entry":[]}', "unexpected_object"],
    ["no entry", '{"object":"whatsapp_business_account"}', "entry_not_array"],
    ["a non-array entry", '{"object":"whatsapp_business_account","entry":{}}', "entry_not_array"],
    [
      "a non-object entry item",
      '{"object":"whatsapp_business_account","entry":[1]}',
      "entry_item_invalid",
    ],
    [
      "a null entry item",
      '{"object":"whatsapp_business_account","entry":[null]}',
      "entry_item_invalid",
    ],
  ])("reports %s as UNSUPPORTED_SHAPE/%s", (_name, json, code) => {
    expect(parseDelivery(text(json))).toEqual({ ok: false, status: "UNSUPPORTED_SHAPE", code });
  });

  it("is forward compatible: unknown top-level and entry properties do not cause rejection", () => {
    const result = parseDelivery(
      text(
        `{"object":"whatsapp_business_account","brand_new":{"x":1},"entry":[{"id":"1","time":1,"future":true,"changes":[]}]}`,
      ),
    );
    expect(result.ok).toBe(true);
  });

  it("never exposes parser exception text in a result", () => {
    const result = parseDelivery(text('{"secret-looking-token-abc": '));
    expect(JSON.stringify(result)).toBe(
      '{"ok":false,"status":"UNPARSEABLE","code":"invalid_json"}',
    );
  });
});
