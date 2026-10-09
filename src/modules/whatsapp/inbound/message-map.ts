import { PermanentWebhookError } from "../queue/errors";
import { IDENTIFIER_LIMITS, isIntactIdentifier } from "../identifiers";
import { isRecord } from "../parse";
import { sanitizeJson, sanitizeString } from "../sanitize";
import { parseProviderTimestamp } from "../time";

export { parseProviderTimestamp };

// Turns the stored, normalized MESSAGE event into what the database needs: validated, sanitized and bounded. Pure (no
// database, no clock). Only documented provider fields are read, each into a whitelist, so nothing unbounded or
// unrecognized is ever persisted, and nothing is invented: a missing optional field stays missing.
//
// Size policy (fixed codes, applied everywhere): a text-like field longer than its limit is cut to the limit by code
// points (the exact bytes always remain in webhook_requests.raw_body); one longer than 4x its limit is not something
// WhatsApp sends, so the event fails permanently with `content_too_large`. A message without a usable id or type fails
// with `invalid_message`, an unusable timestamp with `invalid_timestamp`.

export const LIMITS = {
  wamid: IDENTIFIER_LIMITS.wamid,
  text: 4096,
  caption: 2048,
  filename: 255,
  mimeType: 127,
  mediaId: IDENTIFIER_LIMITS.mediaRef,
  sha256: 128,
  title: 256,
  description: 1024,
  buttonId: IDENTIFIER_LIMITS.buttonId,
  buttonPayload: 512,
  locationName: 512,
  locationAddress: 1024,
  emoji: 32,
  rawType: 64,
  contactName: 200,
  contactField: 200,
  phone: 64,
  flowText: 8192,
  referralShort: 512,
  referralBody: 2048,
  url: 2048,
  providerKey: 64,
  providerValue: 512,
  errorTitle: 256,
} as const;
const HARD_FAIL_FACTOR = 4;
const MAX_SHARED_CONTACTS = 10;
const MAX_CONTACT_ENTRIES = 5;
const MAX_ERRORS = 3;
const MAX_PROVIDER_KEYS = 20;
const MAX_CONTENT_JSON = 32 * 1024;

export type MessageType =
  | "TEXT"
  | "IMAGE"
  | "VIDEO"
  | "AUDIO"
  | "DOCUMENT"
  | "STICKER"
  | "LOCATION"
  | "CONTACT"
  | "INTERACTIVE"
  | "BUTTON"
  | "FLOW"
  | "REACTION"
  | "UNKNOWN";

export type MediaMetadata = {
  metaMediaId: string;
  mimeType: string | null;
  filename: string | null;
  sha256: string | null;
};

export type Referral = {
  sourceType: "META_AD" | "REFERRAL";
  sourceId: string | null;
  sourceUrl: string | null;
  headline: string | null;
  body: string | null;
  mediaType: string | null;
  mediaUrl: string | null;
  ctwaClid: string | null;
  providerData: Record<string, string | number | boolean> | null;
};

export type InboundMessage = {
  wamid: string;
  /** The provider's own timestamp, unchanged. */
  occurredAt: Date;
  type: MessageType;
  body: string | null;
  content: Record<string, unknown> | null;
  media: MediaMetadata | null;
  replyToWamid: string | null;
  referral: Referral | null;
};

const fail = (code: string): never => {
  throw new PermanentWebhookError(code);
};

/** Text-like provider value -> sanitized and bounded string (see the size policy above), or null when absent/empty. */
function bounded(
  value: unknown,
  max: number,
  options: { keepEmpty?: boolean } = {},
): string | null {
  if (typeof value !== "string") return null;
  if (value.length > max * HARD_FAIL_FACTOR) return fail("content_too_large");
  const clean = sanitizeString(value);
  if (clean === "" && !options.keepEmpty) return null;
  const cut = clean.length > max ? Array.from(clean).slice(0, max).join("") : clean;
  return cut === "" && !options.keepEmpty ? null : cut;
}

/**
 * A provider identifier (an opaque key), accepted EXACTLY as sent or rejected: absent -> null; present but over its bound,
 * empty, not a string, containing a NUL / control character or malformed Unicode -> a permanent failure. Unlike `bounded`
 * it never cleans or cuts, because a cut identifier is another identifier (a different parent message, media or contact).
 */
function identifier(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (!isIntactIdentifier(value, max)) return fail("invalid_provider_identifier");
  return value as string;
}

/** Drops keys whose value is null/undefined so stored JSON only holds what the provider actually supplied. */
function defined<T extends Record<string, unknown>>(object: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(object).filter(([, v]) => v !== null && v !== undefined),
  );
}

const finiteNumber = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;

function readMedia(
  kind: "image" | "video" | "audio" | "document" | "sticker",
  message: Record<string, unknown>,
) {
  const raw = message[kind];
  if (!isRecord(raw)) return { media: null, content: null, caption: null };
  const id = identifier(raw.id, LIMITS.mediaId);
  const mimeType = bounded(raw.mime_type, LIMITS.mimeType);
  const filename = bounded(raw.filename, LIMITS.filename);
  const sha256 = bounded(raw.sha256, LIMITS.sha256);
  const caption =
    kind === "audio" || kind === "sticker" ? null : bounded(raw.caption, LIMITS.caption);
  const mediaContent = defined({
    id,
    mime_type: mimeType,
    sha256,
    filename,
    caption,
    animated: kind === "sticker" && typeof raw.animated === "boolean" ? raw.animated : null,
    voice: kind === "audio" && typeof raw.voice === "boolean" ? raw.voice : null,
  });
  return {
    // The provider's temporary download url is deliberately not kept: it expires within minutes, is access-controlled,
    // and no column exists for it. A later downloader asks Meta for a fresh one by media id.
    media:
      id === null
        ? null
        : ({ metaMediaId: id, mimeType, filename, sha256 } satisfies MediaMetadata),
    content: { media: mediaContent },
    caption,
  };
}

function readSharedContacts(raw: unknown) {
  if (!Array.isArray(raw)) return null;
  const contacts = raw
    .filter(isRecord)
    .slice(0, MAX_SHARED_CONTACTS)
    .map((c) => {
      const name = isRecord(c.name) ? c.name : {};
      const phones = (Array.isArray(c.phones) ? c.phones.filter(isRecord) : []).slice(
        0,
        MAX_CONTACT_ENTRIES,
      );
      const emails = (Array.isArray(c.emails) ? c.emails.filter(isRecord) : []).slice(
        0,
        MAX_CONTACT_ENTRIES,
      );
      const org = isRecord(c.org) ? c.org : {};
      return defined({
        name: defined({
          formatted_name: bounded(name.formatted_name, LIMITS.contactName),
          first_name: bounded(name.first_name, LIMITS.contactName),
          last_name: bounded(name.last_name, LIMITS.contactName),
        }),
        phones: phones.map((p) =>
          defined({
            phone: bounded(p.phone, LIMITS.phone),
            wa_id: bounded(p.wa_id, LIMITS.phone),
            type: bounded(p.type, 32),
          }),
        ),
        emails: emails.map((e) =>
          defined({ email: bounded(e.email, LIMITS.contactField), type: bounded(e.type, 32) }),
        ),
        org: defined({ company: bounded(org.company, LIMITS.contactField) }),
      });
    });
  return contacts;
}

/** The documented `context` object: reply target plus a few small flags. Anything else in it is not kept. */
function readContext(message: Record<string, unknown>) {
  const context = isRecord(message.context) ? message.context : null;
  if (!context) return { replyToWamid: null, extra: null };
  const product = isRecord(context.referred_product) ? context.referred_product : null;
  const extra = defined({
    forwarded: typeof context.forwarded === "boolean" ? context.forwarded : null,
    frequently_forwarded:
      typeof context.frequently_forwarded === "boolean" ? context.frequently_forwarded : null,
    referred_product: product
      ? defined({
          catalog_id: identifier(product.catalog_id, LIMITS.mediaId),
          product_retailer_id: identifier(product.product_retailer_id, LIMITS.mediaId),
        })
      : null,
  });
  return {
    replyToWamid: identifier(context.id, LIMITS.wamid),
    extra: Object.keys(extra).length > 0 ? extra : null,
  };
}

/**
 * A Click-to-WhatsApp referral. Documented fields only (G0): source_url, source_id, source_type, body, headline,
 * media_type, image_url, video_url, thumbnail_url, ctwa_clid, welcome_message{text}. `ad` is the only documented
 * source_type; it maps to META_AD (Facebook versus Instagram is NOT guessed). Anything else, or none, is stored as
 * REFERRAL with the original value kept in provider_data. ctwa_clid is kept exactly as sent (it is omitted by Meta for
 * some ads), and a referral with nothing but source_url is stored with nulls elsewhere. Nothing is invented.
 */
export function readReferral(raw: unknown): Referral | null {
  if (!isRecord(raw)) return null;
  const sourceTypeRaw = bounded(raw.source_type, 64);
  const known = new Set([
    "source_url",
    "source_id",
    "source_type",
    "body",
    "headline",
    "media_type",
    "image_url",
    "video_url",
    "thumbnail_url",
    "ctwa_clid",
    "welcome_message",
  ]);
  const providerData: Record<string, string | number | boolean> = {};
  if (sourceTypeRaw !== null && sourceTypeRaw !== "ad") providerData.source_type = sourceTypeRaw;
  const thumbnail = bounded(raw.thumbnail_url, LIMITS.url);
  if (thumbnail !== null) providerData.thumbnail_url = thumbnail;
  const welcome = isRecord(raw.welcome_message)
    ? bounded(raw.welcome_message.text, LIMITS.referralBody)
    : null;
  if (welcome !== null) providerData.welcome_message_text = welcome;
  for (const [key, value] of Object.entries(raw)) {
    if (known.has(key) || Object.keys(providerData).length >= MAX_PROVIDER_KEYS) continue;
    const safeKey = bounded(key, LIMITS.providerKey);
    if (safeKey === null) continue;
    if (typeof value === "string") {
      const text = bounded(value, LIMITS.providerValue);
      if (text !== null) providerData[safeKey] = text;
    } else if (typeof value === "number" && Number.isFinite(value)) providerData[safeKey] = value;
    else if (typeof value === "boolean") providerData[safeKey] = value;
    // nested or null values from the provider are dropped: provider_data is a small flat record
  }
  const image = bounded(raw.image_url, LIMITS.url);
  const video = bounded(raw.video_url, LIMITS.url);
  return {
    sourceType: sourceTypeRaw === "ad" ? "META_AD" : "REFERRAL",
    sourceId: identifier(raw.source_id, IDENTIFIER_LIMITS.referralSourceId),
    sourceUrl: bounded(raw.source_url, LIMITS.url),
    headline: bounded(raw.headline, LIMITS.referralShort),
    body: bounded(raw.body, LIMITS.referralBody),
    mediaType: bounded(raw.media_type, 32),
    mediaUrl: image ?? video,
    ctwaClid: identifier(raw.ctwa_clid, IDENTIFIER_LIMITS.ctwaClid),
    providerData: Object.keys(providerData).length > 0 ? providerData : null,
  };
}

function mapType(message: Record<string, unknown>, rawType: string) {
  switch (rawType) {
    case "text": {
      const text = isRecord(message.text) ? message.text : {};
      return {
        type: "TEXT" as const,
        body: bounded(text.body, LIMITS.text),
        content: null,
        media: null,
      };
    }
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const { media, content, caption } = readMedia(rawType, message);
      const type = rawType.toUpperCase() as "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "STICKER";
      return { type, body: caption, content, media };
    }
    case "location": {
      const location = isRecord(message.location) ? message.location : {};
      const name = bounded(location.name, LIMITS.locationName);
      return {
        type: "LOCATION" as const,
        body: name,
        content: defined({
          latitude: finiteNumber(location.latitude, -90, 90),
          longitude: finiteNumber(location.longitude, -180, 180),
          name,
          address: bounded(location.address, LIMITS.locationAddress),
        }),
        media: null,
      };
    }
    case "contacts":
      return {
        type: "CONTACT" as const,
        body: null,
        content: { contacts: readSharedContacts(message.contacts) ?? [] },
        media: null,
      };
    case "button": {
      const button = isRecord(message.button) ? message.button : {};
      const text = bounded(button.text, LIMITS.title);
      return {
        type: "BUTTON" as const,
        body: text,
        content: defined({ payload: bounded(button.payload, LIMITS.buttonPayload), text }),
        media: null,
      };
    }
    case "interactive": {
      const interactive = isRecord(message.interactive) ? message.interactive : {};
      const subtype = bounded(interactive.type, LIMITS.rawType);
      if (subtype === "button_reply" || subtype === "list_reply") {
        const reply = isRecord(interactive[subtype])
          ? (interactive[subtype] as Record<string, unknown>)
          : {};
        const title = bounded(reply.title, LIMITS.title);
        return {
          type: "INTERACTIVE" as const,
          body: title,
          content: defined({
            subtype,
            id: identifier(reply.id, LIMITS.buttonId),
            title,
            description:
              subtype === "list_reply" ? bounded(reply.description, LIMITS.description) : null,
          }),
          media: null,
        };
      }
      if (subtype === "nfm_reply") {
        // The exact shape of a Flow reply is unresolved in the evidence register (G0): keep only the scalar fields that
        // are actually present, as bounded opaque strings, and do not parse or interpret the response.
        const reply = isRecord(interactive.nfm_reply) ? interactive.nfm_reply : {};
        return {
          type: "FLOW" as const,
          body: null,
          content: defined({
            subtype,
            name: bounded(reply.name, LIMITS.rawType),
            body: bounded(reply.body, LIMITS.title),
            response_json: bounded(reply.response_json, LIMITS.flowText),
          }),
          media: null,
        };
      }
      return {
        type: "UNKNOWN" as const,
        body: null,
        content: defined({ rawType: "interactive", subtype }),
        media: null,
      };
    }
    case "reaction": {
      const reaction = isRecord(message.reaction) ? message.reaction : {};
      return {
        type: "REACTION" as const,
        body: null,
        // an absent emoji is a removed reaction (documented): it is stored as absent, not as an empty string
        content: defined({
          emoji: bounded(reaction.emoji, LIMITS.emoji),
          target_wamid: identifier(reaction.message_id, LIMITS.wamid),
        }),
        media: null,
      };
    }
    default: {
      const unsupported = isRecord(message.unsupported) ? message.unsupported : null;
      const errors = (Array.isArray(message.errors) ? message.errors.filter(isRecord) : [])
        .slice(0, MAX_ERRORS)
        .map((e) =>
          defined({
            code: typeof e.code === "number" && Number.isFinite(e.code) ? e.code : null,
            title: bounded(e.title, LIMITS.errorTitle),
          }),
        );
      return {
        type: "UNKNOWN" as const,
        body: null,
        content: defined({
          rawType: bounded(rawType, LIMITS.rawType),
          unsupported_type: unsupported ? bounded(unsupported.type, LIMITS.rawType) : null,
          errors: errors.length > 0 ? errors : null,
        }),
        media: null,
      };
    }
  }
}

export function mapInboundMessage(payload: unknown): InboundMessage {
  if (!isRecord(payload) || !isRecord(payload.message)) return fail("invalid_event_payload");
  const message = payload.message;
  // an absent or empty id is "no usable id" (invalid_message); a present id is accepted exactly or rejected
  const wamid = message.id === "" ? null : identifier(message.id, LIMITS.wamid);
  const rawType = typeof message.type === "string" ? message.type : null;
  if (wamid === null || rawType === null || rawType === "") return fail("invalid_message");
  // System notifications (identity changes among them) are never ordinary chat messages and are not interpreted here.
  if (rawType === "system") return fail("system_message_unsupported");
  const occurredAt = parseProviderTimestamp(message.timestamp);
  if (!occurredAt) return fail("invalid_timestamp");

  const mapped = mapType(message, rawType);
  const context = readContext(message);
  let content: Record<string, unknown> | null = mapped.content;
  if (context.extra) content = { ...(content ?? {}), context: context.extra };
  if (content !== null) {
    content = sanitizeJson(content);
    if (JSON.stringify(content).length > MAX_CONTENT_JSON) return fail("content_too_large");
  }
  return {
    wamid,
    occurredAt,
    type: mapped.type,
    body: mapped.body,
    content,
    media: mapped.media,
    replyToWamid: context.replyToWamid,
    referral: readReferral(message.referral),
  };
}
