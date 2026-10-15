import type { ContactLabel } from "./types";

// Pure mapping from stored rows to what staff see. Everything that comes from WhatsApp or Meta (profile names, usernames, ad
// headlines, ad text, links, ids) is UNTRUSTED TEXT: it is only ever returned as plain bounded strings for React to render as
// text, stripped of control and bidirectional-override characters (which can reorder displayed text to impersonate someone
// else). Nothing here is interpreted as HTML, a URL to fetch or a command. These helpers deliberately repeat the small ones of the
// inbox module instead of importing them: the modules stay independent (ADR 0016), and Phase 06 is not refactored.

// Removed: C0/C1 control characters, bidi marks, embeddings/overrides/isolates (U+061C, U+200E-200F, U+202A-202E, U+2066-2069), the
// zero-width SPACE (U+200B), the line and paragraph separators (U+2028-2029) and the BOM (U+FEFF). NOT removed: the zero-width
// joiner and non-joiner (U+200D / U+200C), which Sinhala and Tamil need.
const UNSAFE = new RegExp(
  "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u061c\\u200b\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]",
  "g",
);

export function safeText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(UNSAFE, "").toWellFormed();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** One line: whitespace collapsed. */
export function safeLine(value: unknown, max: number): string {
  return safeText(value, max * 2)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * The last `count` characters of an identifier (a click id, a phone-based id, a BSUID) as DISPLAY text: it is cleaned of unsafe
 * characters and white space FIRST and cut afterwards, by whole user-perceived characters (a surrogate pair or an Indic conjunct
 * is never split). Cutting the raw
 * value first would let a trailing bidi override or control character through into the response. The stored value is not
 * changed. Null when the cleaned identifier is shorter than `minLength`.
 */
export function identifierTail(value: unknown, count: number, minLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(UNSAFE, "").replace(/\s+/g, "").toWellFormed();
  const characters = Array.from(GRAPHEMES.segment(cleaned), (g) => g.segment);
  return characters.length >= minLength ? `…${characters.slice(-count).join("")}` : null;
}

export function contactLabel(input: {
  profileName: string | null;
  username: string | null;
  waId: string | null;
  bsuid: string | null;
}): ContactLabel {
  const name = safeLine(input.profileName, 80) || safeLine(input.username, 80);
  const idHint = identifierTail(input.waId, 4, 4) ?? identifierTail(input.bsuid, 4, 4);
  return name
    ? { displayName: name, named: true, idHint }
    : { displayName: "Unnamed contact", named: false, idHint };
}

/**
 * A provider link as DISPLAY TEXT: origin and path only (a query string or fragment can carry tracking identifiers), http(s)
 * only, no credentials, bounded. Anything else is dropped rather than shown half-cleaned. The server never requests this URL.
 */
export function displayLink(value: unknown, max = 200): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const text = `${url.origin}${url.pathname}`;
  return text.length <= max ? text : null;
}

/** The click id is never returned in full: only its last four characters, and only when it is long enough that they say nothing. */
export function clickIdTail(value: unknown): string | null {
  return identifierTail(value, 4, 12);
}

export const SOURCE_LABELS: Record<string, string> = {
  META_AD: "Meta ad",
  FACEBOOK_AD: "Facebook ad",
  INSTAGRAM_AD: "Instagram ad",
  ORGANIC_WHATSAPP: "WhatsApp (organic)",
  WEBSITE: "Website",
  QR_CODE: "QR code",
  MANUAL: "Manual entry",
  REFERRAL: "Referral",
};

export const sourceLabel = (sourceType: string) => SOURCE_LABELS[sourceType] ?? "Referral";

export const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();
