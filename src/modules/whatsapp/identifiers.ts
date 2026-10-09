import { sanitizeString } from "./sanitize";

// Provider identifiers (wamids, BSUIDs, phone-based ids, media ids, button ids, referral ids) are OPAQUE KEYS, not text.
// Text is cleaned and, when long, cut to a limit; an identifier must never be: a cut or cleaned identifier is a DIFFERENT
// identifier, possibly one that belongs to someone else. So an identifier is either accepted EXACTLY as sent or rejected.
// This is the single definition of "intact", used by the normalizer (before the lossy payload cleaning) and by the message
// mapper (the second line of defense). No identifier grammar is imposed: Meta's formats are not documented as fixed.

/** Upper bounds (UTF-16 code units, as `String.length`) that storage and the existing tests support. */
export const IDENTIFIER_LIMITS = {
  /** wamids, reply targets, reaction targets: the bound already enforced for a message's own id. */
  wamid: 512,
  /** media ids (the existing mapper bound; `message_attachments.meta_media_id` is plain text with no database bound). */
  mediaRef: 255,
  /** sender ids (messages[].from / from_user_id, contacts[].wa_id / user_id): contact_bsuids_bsuid_check allows 1..255. */
  sender: 255,
  buttonId: 512,
  referralSourceId: 255,
  ctwaClid: 512,
} as const;

const CONTROL = /\p{Cc}/u;

/**
 * Absent (undefined / null) is fine. Anything else must be a non-empty string of at most `max` code units that the lossy
 * cleaning of stored payloads (NUL removal, lone-surrogate replacement) would leave unchanged and that holds no control
 * character. Never normalizes, trims or truncates.
 */
export function isIntactIdentifier(value: unknown, max: number): boolean {
  if (value === undefined || value === null) return true;
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    sanitizeString(value) === value &&
    !CONTROL.test(value)
  );
}
