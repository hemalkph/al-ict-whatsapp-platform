import { describe, expect, it } from "vitest";
import { sanitizeJson, sanitizeString } from "./sanitize";
import { fixture } from "./testing";

describe("sanitizers (PostgreSQL cannot store U+0000 and rejects lone surrogates in jsonb)", () => {
  it("removes NUL from strings", () => {
    expect(sanitizeString("a\u0000b\u0000")).toBe("ab");
    expect(sanitizeString("")).toBe("");
  });

  it("replaces a lone surrogate with U+FFFD but keeps valid pairs and ordinary Unicode", () => {
    expect(sanitizeString("a\ud800b")).toBe("a�b");
    expect(sanitizeString("\u{1F44D}")).toBe("\u{1F44D}");
    expect(sanitizeString("පරී")).toBe("පරී");
  });

  it("cleans nested values, array items and object KEYS, leaving other types alone", () => {
    const dirty = {
      "k\u0000ey": ["a\u0000", { n: 1, b: true, z: null, s: "x\u0000y" }],
      plain: "ok",
    };
    expect(sanitizeJson(dirty)).toEqual({
      key: ["a", { n: 1, b: true, z: null, s: "xy" }],
      plain: "ok",
    });
  });

  it("turns the NUL fixture into text PostgreSQL can store", () => {
    const parsed = JSON.parse(fixture("text-with-nul-escape.json").toString("utf8"));
    expect(JSON.stringify(parsed)).toContain("\\u0000");
    expect(JSON.stringify(sanitizeJson(parsed))).not.toContain("\\u0000");
  });

  it("does not mutate its input", () => {
    const input = { a: "x\u0000" };
    sanitizeJson(input);
    expect(input.a).toBe("x\u0000");
  });
});
