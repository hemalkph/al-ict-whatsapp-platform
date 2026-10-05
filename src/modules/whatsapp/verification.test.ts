import { describe, expect, it } from "vitest";
import { checkVerification, constantTimeEqual } from "./verification";
import { TEST_VERIFY_TOKEN } from "./testing";

const params = (o: Record<string, string>) => new URLSearchParams(o);
const ok = {
  "hub.mode": "subscribe",
  "hub.verify_token": TEST_VERIFY_TOKEN,
  "hub.challenge": "1158201444",
};

describe("checkVerification (GET handshake)", () => {
  it("accepts the right mode and token and returns the challenge unchanged", () => {
    expect(checkVerification(params(ok), TEST_VERIFY_TOKEN)).toEqual({
      ok: true,
      challenge: "1158201444",
    });
  });

  it("echoes a string challenge exactly (Meta's pages call it both an integer and a random string)", () => {
    const challenge = "AbC-123_xyz.~ok";
    expect(
      checkVerification(params({ ...ok, "hub.challenge": challenge }), TEST_VERIFY_TOKEN),
    ).toEqual({
      ok: true,
      challenge,
    });
  });

  it.each([
    ["a wrong mode", { ...ok, "hub.mode": "unsubscribe" }, "wrong_mode"],
    [
      "a missing mode",
      { "hub.verify_token": TEST_VERIFY_TOKEN, "hub.challenge": "1" },
      "wrong_mode",
    ],
    ["an uppercase mode", { ...ok, "hub.mode": "SUBSCRIBE" }, "wrong_mode"],
    ["a missing token", { "hub.mode": "subscribe", "hub.challenge": "1" }, "missing_token"],
    ["an empty token", { ...ok, "hub.verify_token": "" }, "missing_token"],
    [
      "a wrong token",
      { ...ok, "hub.verify_token": "x".repeat(TEST_VERIFY_TOKEN.length) },
      "token_mismatch",
    ],
    [
      "a token with one extra character",
      { ...ok, "hub.verify_token": `${TEST_VERIFY_TOKEN}x` },
      "token_mismatch",
    ],
    [
      "a token that is a prefix",
      { ...ok, "hub.verify_token": TEST_VERIFY_TOKEN.slice(0, -1) },
      "token_mismatch",
    ],
    [
      "a missing challenge",
      { "hub.mode": "subscribe", "hub.verify_token": TEST_VERIFY_TOKEN },
      "missing_challenge",
    ],
    ["an empty challenge", { ...ok, "hub.challenge": "" }, "missing_challenge"],
    ["a challenge with a newline", { ...ok, "hub.challenge": "a\nb" }, "invalid_challenge"],
    ["a non-ASCII challenge", { ...ok, "hub.challenge": "පර" }, "invalid_challenge"],
    ["an over-long challenge", { ...ok, "hub.challenge": "1".repeat(257) }, "invalid_challenge"],
  ])("refuses %s", (_name, query, reason) => {
    expect(checkVerification(params(query), TEST_VERIFY_TOKEN)).toEqual({ ok: false, reason });
  });

  it("echoes markup-looking printable text unchanged: it is only ever returned as text/plain with nosniff, and only to a caller holding the token", () => {
    const challenge = "<script>alert(1)</script>";
    expect(
      checkVerification(params({ ...ok, "hub.challenge": challenge }), TEST_VERIFY_TOKEN),
    ).toEqual({
      ok: true,
      challenge,
    });
  });

  it("checks the token before the challenge, so a wrong token never reveals challenge validation", () => {
    expect(
      checkVerification(
        params({ ...ok, "hub.verify_token": "nope", "hub.challenge": "<b>" }),
        TEST_VERIFY_TOKEN,
      ),
    ).toEqual({ ok: false, reason: "token_mismatch" });
  });

  it("the result never contains the expected token", () => {
    const result = checkVerification(
      params({ ...ok, "hub.verify_token": "wrong" }),
      TEST_VERIFY_TOKEN,
    );
    expect(JSON.stringify(result)).not.toContain(TEST_VERIFY_TOKEN);
  });
});

describe("constantTimeEqual", () => {
  it("compares equal and different strings of equal and unequal length without throwing", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("ප", "ප")).toBe(true);
  });
});
