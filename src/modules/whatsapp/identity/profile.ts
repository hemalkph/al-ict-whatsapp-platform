import { PermanentWebhookError } from "../queue/errors";
import { isRecord } from "../parse";
import { sanitizeString } from "../sanitize";

// Reading the sender's identity out of a stored, normalized MESSAGE event, and cleaning the untrusted display text that
// comes with it. Only documented fields are read: messages[].from_user_id (BSUID), messages[].from (phone-based id),
// and the contacts[] element the normalizer already paired with THIS message (profile.name, profile.username). Nothing
// here looks at system messages, user_id_update, previous identifiers or parent ids.

export const PROFILE_NAME_MAX = 200;
export const USERNAME_MAX = 100;
const IDENTIFIER_MAX = 255; // contact_bsuids_bsuid_check allows 1..255

export type InboundIdentity = {
  /** messages[].from_user_id: the business-scoped user id, an opaque string. */
  bsuid: string | null;
  /** messages[].from (or the paired contact's wa_id when the message omits it): an opaque string, NOT necessarily a phone. */
  waId: string | null;
  profileName: string | null;
  username: string | null;
};

const CONTROL = /\p{Cc}/u;
const WHITESPACE_RUN = /\s+/gu;
// Bidirectional embedding/override/isolate controls (U+202A-202E, U+2066-2069): invisible, and used to make one string
// render as another. Built from code points so no invisible character sits in this source file.
const range = (from: number, to: number) =>
  `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`;
const BIDI_CONTROLS = new RegExp(`[${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}]`, "gu");
const CONTROLS = /\p{Cc}/gu;

/**
 * Untrusted display text -> a short, plain, single-line string, or null. NUL and lone surrogates are removed, text is
 * NFC-normalized, control characters and bidi controls are dropped, whitespace runs collapse to one space, and the
 * result is cut to `max` code points. Zero-width joiners are deliberately kept: Sinhala, Tamil and emoji sequences need
 * them. The result is for display only and is never an identity key.
 */
export function sanitizeDisplayText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = sanitizeString(value)
    .normalize("NFC")
    .replace(BIDI_CONTROLS, "")
    .replace(WHITESPACE_RUN, " ")
    .replace(CONTROLS, "")
    .trim();
  const bounded = Array.from(clean).slice(0, max).join("").trim();
  return bounded === "" ? null : bounded;
}

/** An opaque provider identifier: absent -> null; present but unusable -> a permanent failure (never guessed at). */
function identifier(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > IDENTIFIER_MAX ||
    CONTROL.test(value)
  )
    throw new PermanentWebhookError("invalid_sender_identity");
  return value;
}

/**
 * The contacts[] element is used only if it provably belongs to THIS message: paired by the normalizer through the BSUID
 * or the phone-based id, and consistent with the message's own identifiers. Anything else is ignored (no enrichment),
 * never contacts[0] and never a guess.
 */
function pairedContact(
  payload: Record<string, unknown>,
  bsuid: string | null,
  from: string | null,
): Record<string, unknown> | null {
  const contact = payload.contact;
  if (!isRecord(contact)) return null;
  const via = payload.pairing;
  const contactUserId = typeof contact.user_id === "string" ? contact.user_id : null;
  const contactWaId = typeof contact.wa_id === "string" ? contact.wa_id : null;
  if (via === "user_id") {
    if (bsuid === null || contactUserId !== bsuid) return null;
    if (from !== null && contactWaId !== null && contactWaId !== from) return null;
    return contact;
  }
  if (via === "wa_id") {
    if (from === null || contactWaId !== from) return null;
    if (bsuid !== null && contactUserId !== null && contactUserId !== bsuid) return null;
    return contact;
  }
  return null;
}

export function readInboundIdentity(payload: unknown): InboundIdentity {
  if (!isRecord(payload) || !isRecord(payload.message))
    throw new PermanentWebhookError("invalid_event_payload");
  const message = payload.message;
  const bsuid = identifier(message.from_user_id);
  const from = identifier(message.from);
  const contact = pairedContact(payload, bsuid, from);
  const contactWaId = contact ? identifier(contact.wa_id) : null;
  const waId = from ?? contactWaId;
  if (bsuid === null && waId === null) throw new PermanentWebhookError("missing_sender_identity");

  const profile = contact && isRecord(contact.profile) ? contact.profile : null;
  return {
    bsuid,
    waId,
    profileName: sanitizeDisplayText(profile?.name, PROFILE_NAME_MAX),
    username: sanitizeDisplayText(profile?.username, USERNAME_MAX),
  };
}
