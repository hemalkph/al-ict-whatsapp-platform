import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";

// Vectors copied from RFC 8785: section 3.2.3 (sorting example) and Appendix B (number serialization samples).

const fromBits = (hex: string): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
};

describe("canonicalJson (RFC 8785)", () => {
  it("canonicalizes the RFC 8785 section 3.2.3 example", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    );
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  // [IEEE 754 hex, expected text] from Appendix B
  it.each([
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ])("serializes IEEE 754 %s as %s", (bits, expected) => {
    expect(canonicalJson(fromBits(bits))).toBe(expected);
  });

  it.each([
    ["7fffffffffffffff", "NaN"],
    ["7ff0000000000000", "Infinity"],
  ])("refuses %s (%s), which RFC 8785 forbids", (bits) => {
    expect(() => canonicalJson(fromBits(bits))).toThrow(TypeError);
  });

  it("is independent of object key order, at every depth", () => {
    const a = { b: 1, a: { y: [1, { z: 1, a: 2 }], x: null }, c: "x" };
    const b = { c: "x", a: { x: null, y: [1, { a: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":null,"y":[1,{"a":2,"z":1}]},"b":1,"c":"x"}');
  });

  it("keeps array order (arrays are ordered data)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it("sorts keys by UTF-16 code units, not by locale or code point", () => {
    // U+1F600 is the surrogate pair D83D DE00; U+FF5E (fullwidth tilde) is a single unit FF5E > D83D.
    const keys = ["～", "\u{1F600}", "a", "B", "é", "e"];
    const canonical = canonicalJson(Object.fromEntries(keys.map((k) => [k, 1])));
    const order = [...canonical.matchAll(/"([^"]+)":1/g)].map((m) => m[1]);
    expect(order).toEqual(["B", "a", "e", "é", "\u{1F600}", "～"]);
  });

  it("does not escape non-ASCII (Sinhala stays literal) and escapes only what RFC 8785 requires", () => {
    expect(canonicalJson("පරී")).toBe('"පරී"');
    expect(canonicalJson("a\u0000b\u001f\u007f/")).toBe('"a\\u0000b\\u001f\u007f/"');
    expect(canonicalJson('q"b\\')).toBe('"q\\"b\\\\"');
  });

  it("is the same for a value and its re-parsed pretty-printed form", () => {
    const value = { z: [1.5, "x"], a: { b: true } };
    expect(canonicalJson(JSON.parse(JSON.stringify(value, null, 4)))).toBe(canonicalJson(value));
  });

  it("refuses values that are not JSON instead of dropping or coercing them", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson(BigInt(10))).toThrow(TypeError);
    expect(() => canonicalJson(Symbol("x"))).toThrow(TypeError);
  });
});
