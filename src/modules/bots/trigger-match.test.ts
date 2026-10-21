import { describe, expect, it } from "vitest";
import {
  TRIGGER_ELIGIBLE_TYPES,
  isTriggerEligibleType,
  matchTrigger,
  triggerKey,
  type Trigger,
} from "./index";
import { comparisonKey } from "./text";

// Run-time trigger matching (Phase 08E-1; owner decisions O-1, O-1b, C-1 to C-3; plan D.4). Pure.

const NO = { firstEligible: false, hasAttribution: false } as const;
const kw = (...words: string[]): Trigger => ({ kind: "keyword", words });
const first: Trigger = { kind: "first_message" };
const referral: Trigger = { kind: "referral_source" };
const text = (body: string | null) => ({ type: "TEXT", body });

describe("triggerKey is the validator's comparison key", () => {
  it("is the same function, so a duplicate the validator rejects is the same word at run time", () => {
    expect(triggerKey).toBe(comparisonKey);
    expect(triggerKey("  Hello  ")).toBe("hello");
  });
});

describe("keyword: whole-message equality of the TEXT body", () => {
  it("matches the whole trimmed body, ignoring case, and never a substring", () => {
    expect(matchTrigger([kw("menu")], text("menu"), NO)).toEqual({ index: 0, kind: "keyword" });
    expect(matchTrigger([kw("menu")], text("  MeNu \n"), NO)).toEqual({
      index: 0,
      kind: "keyword",
    });
    expect(matchTrigger([kw("menu")], text("show menu"), NO)).toBeNull();
    expect(matchTrigger([kw("menu")], text("menus"), NO)).toBeNull();
    expect(matchTrigger([kw("menu")], text("me nu"), NO)).toBeNull(); // internal whitespace is not collapsed
  });

  it("any configured word may match, and each word is normalised the same way", () => {
    const t = kw("Fees", "  TIMETABLE ");
    expect(matchTrigger([t], text("timetable"), NO)).toEqual({ index: 0, kind: "keyword" });
    expect(matchTrigger([t], text("FEES"), NO)).toEqual({ index: 0, kind: "keyword" });
  });

  it("compares after NFC normalisation", () => {
    const composed = "café";
    const decomposed = "café";
    expect(composed).not.toBe(decomposed);
    expect(matchTrigger([kw(composed)], text(decomposed), NO)).not.toBeNull();
    expect(matchTrigger([kw(decomposed)], text(composed), NO)).not.toBeNull();
  });

  it("lower-casing is Unicode, not ASCII-only", () => {
    expect(matchTrigger([kw("äb")], text("ÄB"), NO)).not.toBeNull(); // a-umlaut b
    expect(matchTrigger([kw("да")], text("ДА"), NO)).not.toBeNull(); // Cyrillic
  });

  it("is not full case folding, and does not strip accents, normalise widths or remove joiners (documented limits)", () => {
    // sharp s is unchanged by lower-casing, so it does not equal "ss"
    expect(matchTrigger([kw("straße")], text("STRASSE"), NO)).toBeNull();
    // accents are significant
    expect(matchTrigger([kw("cafe")], text("café"), NO)).toBeNull();
    // full-width letters are not folded to ASCII
    expect(matchTrigger([kw("hi")], text("ｈｉ"), NO)).toBeNull();
    // the zero-width joiner Sinhala spelling needs is significant
    const withZwj = "ශ්‍රී";
    const withoutZwj = "ශ්රී";
    expect(matchTrigger([kw(withZwj)], text(withZwj), NO)).not.toBeNull();
    expect(matchTrigger([kw(withZwj)], text(withoutZwj), NO)).toBeNull();
  });

  it("pins two known consequences of the locale-independent lower-case mapping", () => {
    // the Greek final-sigma rule: a capitalised word-final sigma becomes the final form, a typed medial sigma does not match it
    expect(triggerKey("ΟΔΟΣ")).toBe("οδος");
    expect(matchTrigger([kw("οδοσ")], text("ΟΔΟΣ"), NO)).toBeNull();
    // capital I with dot above becomes i plus a combining dot, not a plain i
    expect(triggerKey("İ")).toBe("i̇");
    expect(matchTrigger([kw("i")], text("İ"), NO)).toBeNull();
  });

  it("uncased scripts (Sinhala, Tamil) match exactly after NFC", () => {
    expect(matchTrigger([kw("කවුද")], text("  කවුද "), NO)).not.toBeNull();
    expect(matchTrigger([kw("கல்வி")], text("கல்வி"), NO)).not.toBeNull();
  });

  it("only a TEXT message with a body can match a keyword, even when another type carries the same words", () => {
    for (const type of ["BUTTON", "INTERACTIVE", "IMAGE", "REACTION", "FLOW", "UNKNOWN"])
      expect(matchTrigger([kw("menu")], { type, body: "menu" }, NO), type).toBeNull();
    expect(matchTrigger([kw("menu")], text(null), NO)).toBeNull();
    expect(matchTrigger([kw("menu")], text(""), NO)).toBeNull();
  });
});

describe("first_message and referral_source (C-1, C-2, C-3)", () => {
  it("first_message matches a TEXT, INTERACTIVE or BUTTON message while the first-eligible fact holds, and only then", () => {
    for (const type of ["TEXT", "INTERACTIVE", "BUTTON"]) {
      expect(
        matchTrigger([first], { type, body: null }, { ...NO, firstEligible: true }),
        type,
      ).toEqual({
        index: 0,
        kind: "first_message",
      });
      expect(matchTrigger([first], { type, body: null }, NO), type).toBeNull();
    }
  });

  it("referral_source matches the same three types while a valid attribution is recorded, and only then", () => {
    for (const type of ["TEXT", "INTERACTIVE", "BUTTON"]) {
      expect(
        matchTrigger([referral], { type, body: null }, { ...NO, hasAttribution: true }),
        type,
      ).toEqual({
        index: 0,
        kind: "referral_source",
      });
      expect(matchTrigger([referral], { type, body: null }, NO), type).toBeNull();
    }
  });

  it("no other message type ever matches first_message or referral_source, whatever the facts say", () => {
    const facts = { firstEligible: true, hasAttribution: true };
    for (const type of [
      "IMAGE",
      "VIDEO",
      "AUDIO",
      "DOCUMENT",
      "STICKER",
      "LOCATION",
      "CONTACT",
      "FLOW",
      "TEMPLATE",
      "SYSTEM",
      "REACTION",
      "UNKNOWN",
      "SOMETHING_NEW",
    ])
      expect(matchTrigger([first, referral], { type, body: "x" }, facts), type).toBeNull();
  });

  it("the eligible type set is exactly TEXT, INTERACTIVE, BUTTON", () => {
    expect([...TRIGGER_ELIGIBLE_TYPES]).toEqual(["TEXT", "INTERACTIVE", "BUTTON"]);
    expect(isTriggerEligibleType("BUTTON")).toBe(true);
    expect(isTriggerEligibleType("button")).toBe(false);
    expect(isTriggerEligibleType("IMAGE")).toBe(false);
  });
});

describe("trigger order", () => {
  it("the first matching trigger in array order wins, whatever its kind", () => {
    const facts = { firstEligible: true, hasAttribution: true };
    expect(matchTrigger([kw("menu"), first, referral], text("menu"), facts)).toEqual({
      index: 0,
      kind: "keyword",
    });
    expect(matchTrigger([kw("menu"), first, referral], text("hello"), facts)).toEqual({
      index: 1,
      kind: "first_message",
    });
    expect(matchTrigger([referral, first], text("hello"), facts)).toEqual({
      index: 0,
      kind: "referral_source",
    });
    expect(matchTrigger([kw("a"), kw("b")], text("b"), NO)).toEqual({ index: 1, kind: "keyword" });
  });

  it("no triggers, or none satisfied, is no match", () => {
    expect(
      matchTrigger([], text("menu"), { firstEligible: true, hasAttribution: true }),
    ).toBeNull();
    expect(
      matchTrigger([kw("menu")], text("hello"), { firstEligible: true, hasAttribution: true }),
    ).toBeNull();
  });
});
