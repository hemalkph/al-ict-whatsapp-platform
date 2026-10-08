import { describe, expect, it } from "vitest";
import { normalizeEnvelope } from "../normalize";
import { parseDelivery } from "../parse";
import { fixture } from "../testing";
import {
  PROFILE_NAME_MAX,
  USERNAME_MAX,
  readInboundIdentity,
  sanitizeDisplayText,
} from "./profile";

const payloads = (name: string) => {
  const parsed = parseDelivery(fixture(name));
  if (!parsed.ok) throw new Error("fixture does not parse");
  return normalizeEnvelope(parsed.envelope)
    .filter((e) => e.eventType === "MESSAGE")
    .map((e) => e.payload);
};

describe("sanitizeDisplayText", () => {
  it("keeps ordinary text, including Sinhala and Tamil (zero-width joiners survive)", () => {
    expect(sanitizeDisplayText("Test Student", 50)).toBe("Test Student");
    const sinhala = "\u{DC1}\u{DCA}\u{200D}\u{DBB}\u{DD3} \u{DBD}\u{D82}\u{D9A}\u{DCF}";
    expect(sanitizeDisplayText(sinhala, 50)).toBe(sinhala);
    const tamil = "\u{BA4}\u{BAE}\u{BBF}\u{BB4}\u{BCD}";
    expect(sanitizeDisplayText(tamil, 50)).toBe(tamil);
  });

  it("removes NUL and control characters, bidi controls and line breaks, and collapses whitespace", () => {
    expect(sanitizeDisplayText("A\u0000B\u0007C", 50)).toBe("ABC");
    expect(sanitizeDisplayText("  a \n\t b   c  ", 50)).toBe("a b c");
    expect(
      sanitizeDisplayText(`x${String.fromCodePoint(0x202e)}y${String.fromCodePoint(0x2066)}z`, 50),
    ).toBe("xyz");
    expect(sanitizeDisplayText(`a${String.fromCodePoint(0x2028)}b`, 50)).toBe("a b");
  });

  it("replaces a lone surrogate, NFC-normalizes, and cuts to the limit in code points", () => {
    expect(sanitizeDisplayText("ok\ud800", 50)).toBe("ok\u{FFFD}");
    expect(sanitizeDisplayText("e\u{301}", 50)).toBe("\u{E9}");
    const long = "\u{1F600}".repeat(300);
    expect(Array.from(sanitizeDisplayText(long, PROFILE_NAME_MAX)!)).toHaveLength(PROFILE_NAME_MAX);
    expect(Array.from(sanitizeDisplayText(long, USERNAME_MAX)!)).toHaveLength(USERNAME_MAX);
  });

  it("returns null for anything that is not usable text", () => {
    for (const v of [
      undefined,
      null,
      7,
      {},
      [],
      "",
      "   ",
      "\u0000\u0001",
      `${String.fromCodePoint(0x202e)}`,
    ])
      expect(sanitizeDisplayText(v, 50)).toBeNull();
  });
});

describe("readInboundIdentity on the sanitized G0 fixtures", () => {
  it("phone + BSUID", () => {
    expect(readInboundIdentity(payloads("text-phone-and-bsuid.json")[0])).toEqual({
      bsuid: "LK.100000000000000001",
      waId: "15550100123",
      profileName: "Test Student",
      username: null,
    });
  });

  it("BSUID only, with a username and a parent id that is NOT an identity", () => {
    const who = readInboundIdentity(payloads("text-bsuid-only-username.json")[0]);
    expect(who).toEqual({
      bsuid: "LK.100000000000000001",
      waId: null,
      profileName: "Test Student",
      username: "test.student",
    });
    expect(JSON.stringify(who)).not.toContain("ENT");
  });

  it("legacy phone only", () => {
    expect(readInboundIdentity(payloads("text-phone.json")[0])).toEqual({
      bsuid: null,
      waId: "15550100123",
      profileName: "Test Student",
      username: null,
    });
  });

  it("multi-sender delivery: each message gets only its own contacts[] element, a sender without one gets no profile", () => {
    const [first, second, third] = payloads("multi-sender-pairing.json").map(readInboundIdentity);
    expect(first).toMatchObject({
      bsuid: "LK.100000000000000001",
      waId: "15550100123",
      profileName: "First Sender",
    });
    expect(second).toMatchObject({
      bsuid: "LK.100000000000000002",
      waId: "15550100124",
      profileName: "Second Sender",
    });
    expect(third).toEqual({
      bsuid: "LK.100000000000000003",
      waId: null,
      profileName: null,
      username: null,
    });
  });

  it("uses the paired contact's wa_id only when the message itself omits `from`", () => {
    const payload = {
      pairing: "user_id",
      contact: { user_id: "LK.A", wa_id: "15550100999", profile: { name: "N" } },
      message: { from_user_id: "LK.A" },
    };
    expect(readInboundIdentity(payload)).toMatchObject({ bsuid: "LK.A", waId: "15550100999" });
  });

  it("ignores a contacts[] element that contradicts the message or was not paired", () => {
    const base = { message: { from_user_id: "LK.A", from: "111" } };
    const cases = [
      {
        ...base,
        pairing: "none",
        contact: { user_id: "LK.A", wa_id: "111", profile: { name: "X" } },
      },
      { ...base, pairing: "user_id", contact: { user_id: "LK.B", profile: { name: "X" } } },
      {
        ...base,
        pairing: "user_id",
        contact: { user_id: "LK.A", wa_id: "222", profile: { name: "X" } },
      },
      {
        ...base,
        pairing: "wa_id",
        contact: { wa_id: "111", user_id: "LK.Z", profile: { name: "X" } },
      },
      { ...base, pairing: "conflict", contact: { user_id: "LK.A", profile: { name: "X" } } },
      { ...base, contact: "not an object" },
    ];
    for (const payload of cases) expect(readInboundIdentity(payload).profileName).toBeNull();
  });

  it("fails permanently, with a fixed code, on a missing, malformed or oversized identifier", () => {
    const code = (payload: unknown) => {
      try {
        readInboundIdentity(payload);
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    expect(code({ message: { id: "x" } })).toBe("missing_sender_identity");
    expect(code(null)).toBe("invalid_event_payload");
    expect(code({ message: "x" })).toBe("invalid_event_payload");
    expect(code({ message: { from_user_id: "" } })).toBe("invalid_sender_identity");
    expect(code({ message: { from_user_id: 12345 } })).toBe("invalid_sender_identity");
    expect(code({ message: { from: "a\nb" } })).toBe("invalid_sender_identity");
    expect(code({ message: { from_user_id: "x".repeat(256) } })).toBe("invalid_sender_identity");
    expect(code({ message: { from_user_id: "x".repeat(255) } })).toBeUndefined();
  });
});
