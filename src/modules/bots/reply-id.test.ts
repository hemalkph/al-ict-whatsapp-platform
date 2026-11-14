import { describe, expect, it } from "vitest";
import {
  FLOW_LIMITS,
  ID_PATTERN,
  PROMPT_TOKEN_PATTERN,
  REPLY_ID_MAX_LENGTH,
  REPLY_ID_PATTERN,
  formatReplyId,
  isPromptToken,
  isReplyId,
  parseReplyId,
} from "./index";

// The interactive reply identifier contract: b1.<promptToken>.<optionKey>. Syntax and limits only: the validator never
// generates a token and the contract assumes no reply context.

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv"; // 22 base64url characters
const TOKEN_URL = "A-_dEfGhIjKlMnOpQrSt-_"; // with both base64url symbols

describe("reply identifier contract", () => {
  it("is exactly 58 characters at most, within our 64-character and Meta's 200 / 256 limits", () => {
    expect(REPLY_ID_MAX_LENGTH).toBe(58);
    expect(REPLY_ID_MAX_LENGTH).toBeLessThanOrEqual(64);
    expect(3 + 22 + 1 + FLOW_LIMITS.identifierMax).toBe(REPLY_ID_MAX_LENGTH);
  });

  it("accepts well-formed identifiers", () => {
    for (const id of [
      `b1.${TOKEN}.a`,
      `b1.${TOKEN_URL}.option_1`,
      `b1.${TOKEN}.${"k".repeat(32)}`,
    ]) {
      expect(isReplyId(id), id).toBe(true);
      expect(REPLY_ID_PATTERN.test(id)).toBe(true);
    }
    expect(`b1.${TOKEN}.${"k".repeat(32)}`).toHaveLength(58);
  });

  it("AD. rejects malformed identifiers", () => {
    const bad = [
      "",
      "b1",
      "b1..a",
      `b1.${TOKEN}.`,
      `b1.${TOKEN}`,
      `b2.${TOKEN}.a`,
      `B1.${TOKEN}.a`,
      `b1.${TOKEN.slice(1)}.a`, // 21-character token
      `b1.${TOKEN}A.a`, // 23-character token
      `b1.${TOKEN.slice(0, 21)}+.a`, // standard-base64 symbol
      `b1.${TOKEN.slice(0, 21)}/.a`,
      `b1.${TOKEN.slice(0, 21)}=.a`,
      `b1.${TOKEN}.A`, // uppercase option key
      `b1.${TOKEN}.1a`, // starts with a digit
      `b1.${TOKEN}._a`,
      `b1.${TOKEN}.${"k".repeat(33)}`, // 33-character key
      `b1.${TOKEN}.a.b`, // extra segment
      `b1.${TOKEN}.a-b`,
      ` b1.${TOKEN}.a`,
      `b1.${TOKEN}.a `,
      `b1.${TOKEN}.a\n`, // a trailing newline must not slip past `$`
      `b1.${TOKEN}.é`,
      `b1.${TOKEN.slice(0, 21)}é.a`,
      "x".repeat(300),
    ];
    for (const id of bad) {
      expect(isReplyId(id), JSON.stringify(id)).toBe(false);
      expect(parseReplyId(id), JSON.stringify(id)).toBeNull();
    }
  });

  it("is safe with non-string values", () => {
    for (const value of [null, undefined, 0, 1, true, {}, [], Symbol("x"), BigInt(10), () => 1]) {
      expect(isReplyId(value)).toBe(false);
      expect(parseReplyId(value)).toBeNull();
      expect(isPromptToken(value)).toBe(false);
    }
  });

  it("parses into token and option key", () => {
    expect(parseReplyId(`b1.${TOKEN_URL}.info`)).toEqual({
      promptToken: TOKEN_URL,
      optionKey: "info",
    });
  });

  it("formats a caller-supplied token and key, refusing malformed parts", () => {
    expect(formatReplyId(TOKEN, "info")).toBe(`b1.${TOKEN}.info`);
    expect(parseReplyId(formatReplyId(TOKEN, "info"))).toEqual({
      promptToken: TOKEN,
      optionKey: "info",
    });
    expect(formatReplyId("short", "info")).toBeNull();
    expect(formatReplyId(TOKEN, "Info")).toBeNull();
    expect(formatReplyId(TOKEN, "")).toBeNull();
    expect(formatReplyId(`${TOKEN}.`, "info")).toBeNull();
  });

  it("a prompt token is 22 base64url characters", () => {
    expect(PROMPT_TOKEN_PATTERN.test(TOKEN)).toBe(true);
    expect(isPromptToken(TOKEN)).toBe(true);
    expect(isPromptToken(`${TOKEN}\n`)).toBe(false);
    expect(isPromptToken("")).toBe(false);
  });

  it("every option key the flow contract accepts forms a valid reply identifier", () => {
    const keys = [
      "a",
      "z",
      "a0",
      "a_b",
      "option_1",
      "z".repeat(32),
      "a".repeat(32),
      "a_".repeat(16),
    ];
    for (const key of keys) {
      expect(ID_PATTERN.test(key)).toBe(true);
      const id = formatReplyId(TOKEN, key);
      expect(id, key).not.toBeNull();
      expect(id!.length).toBeLessThanOrEqual(REPLY_ID_MAX_LENGTH);
      expect(isReplyId(id)).toBe(true);
    }
  });
});
