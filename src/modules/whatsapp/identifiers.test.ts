import { describe, expect, it } from "vitest";
import { IDENTIFIER_LIMITS, isIntactIdentifier } from "./identifiers";

const NUL = String.fromCharCode(0);
const LONE = String.fromCharCode(0xd800);
const GRIN = String.fromCodePoint(0x1f600);

describe("isIntactIdentifier", () => {
  it("absent is fine; a present identifier must be a non-empty string within its bound", () => {
    expect(isIntactIdentifier(undefined, 10)).toBe(true);
    expect(isIntactIdentifier(null, 10)).toBe(true);
    for (const bad of ["", 5, true, {}, []])
      expect(isIntactIdentifier(bad, 10), String(bad)).toBe(false);
  });

  it.each([
    ["wamid", IDENTIFIER_LIMITS.wamid],
    ["media reference", IDENTIFIER_LIMITS.mediaRef],
    ["sender", IDENTIFIER_LIMITS.sender],
  ])("%s: bound minus one, the bound, and bound plus one", (_n, max) => {
    expect(isIntactIdentifier("a".repeat(max - 1), max)).toBe(true);
    expect(isIntactIdentifier("a".repeat(max), max)).toBe(true);
    expect(isIntactIdentifier("a".repeat(max + 1), max)).toBe(false);
  });

  it("the documented bounds are the ones the mapper and the database already support", () => {
    expect(IDENTIFIER_LIMITS).toMatchObject({ wamid: 512, mediaRef: 255, sender: 255 });
  });

  it("rejects what cleaning would change: NUL, lone surrogates, control characters", () => {
    for (const bad of [`a${NUL}b`, `a${LONE}b`, "a\nb", "a\tb", "a\u007fb", "a\u0085b"])
      expect(isIntactIdentifier(bad, 50), JSON.stringify(bad)).toBe(false);
  });

  it("keeps valid Unicode exactly (astral pairs count as two code units)", () => {
    expect(isIntactIdentifier(`LK.${GRIN}9`, 50)).toBe(true);
    expect(isIntactIdentifier(GRIN.repeat(256), 512)).toBe(true);
    expect(isIntactIdentifier(GRIN.repeat(256) + "x", 512)).toBe(false);
  });

  it("does not trim or normalize: whitespace and non-NFC forms are the provider's own bytes", () => {
    expect(isIntactIdentifier(" abc ", 10)).toBe(true);
    expect(isIntactIdentifier("é", 10)).toBe(true);
  });
});
