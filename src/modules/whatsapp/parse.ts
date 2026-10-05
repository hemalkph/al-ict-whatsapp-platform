// After the signature has been verified: decode the bytes as UTF-8 (FATAL: invalid bytes are rejected, never replaced
// with U+FFFD, and a BOM is kept so JSON.parse refuses it rather than silently altering the body), parse the JSON, and
// check only as much structure as safe normalization needs. Forward compatible: unknown properties are ignored.

export const WHATSAPP_OBJECT = "whatsapp_business_account";

export type Envelope = {
  readonly object: string;
  readonly entry: ReadonlyArray<Record<string, unknown>>;
};

export type ParsedDelivery =
  | { ok: true; envelope: Envelope }
  | { ok: false; status: "UNPARSEABLE" | "UNSUPPORTED_SHAPE"; code: string };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseDelivery(body: Uint8Array): ParsedDelivery {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return { ok: false, status: "UNPARSEABLE", code: "invalid_utf8" };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: "UNPARSEABLE", code: "invalid_json" };
  }
  if (!isRecord(json))
    return { ok: false, status: "UNSUPPORTED_SHAPE", code: "top_level_not_object" };
  if (json.object !== WHATSAPP_OBJECT) {
    return { ok: false, status: "UNSUPPORTED_SHAPE", code: "unexpected_object" };
  }
  if (!Array.isArray(json.entry))
    return { ok: false, status: "UNSUPPORTED_SHAPE", code: "entry_not_array" };
  if (!json.entry.every(isRecord)) {
    return { ok: false, status: "UNSUPPORTED_SHAPE", code: "entry_item_invalid" };
  }
  return { ok: true, envelope: { object: json.object, entry: json.entry } };
}
