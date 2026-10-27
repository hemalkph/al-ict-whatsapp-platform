import type { ContactLabel, DeliveryView, MediaView } from "./types";

// Pure mapping from stored rows to what staff see. Everything that comes from WhatsApp (profile names, usernames, message
// bodies, captions, filenames, template parameters) is UNTRUSTED TEXT: it is only ever returned as plain strings for React to
// render as text, truncated, and stripped of control and bidirectional-override characters (which can reorder displayed text
// to impersonate someone else). Nothing is interpreted as HTML, a URL or a command.

// Removed from provider text: C0/C1 control characters, bidi embeddings/overrides/isolates (U+202A-202E, U+2066-2069), the
// zero-width SPACE (U+200B) and the BOM (U+FEFF). Deliberately NOT removed: the zero-width joiner and non-joiner
// (U+200D / U+200C), which Sinhala, Tamil and other Indic scripts need to spell ordinary words (for example the conjunct in
// the Sinhala word for "student"). Written as an escaped string so no invisible character lives in this source file.
const UNSAFE = new RegExp(
  "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b\\u202a-\\u202e\\u2066-\\u2069\\ufeff]",
  "g",
);

export function safeText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(UNSAFE, "").toWellFormed();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** One line: whitespace collapsed (profile names, previews). */
export function safeLine(value: unknown, max: number): string {
  return safeText(value, max * 2)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function contactLabel(input: {
  profileName: string | null;
  username: string | null;
  waId: string | null;
  bsuid: string | null;
}): ContactLabel {
  const name = safeLine(input.profileName, 80) || safeLine(input.username, 80);
  const tail = (id: string | null) => (id && id.length >= 4 ? `…${id.slice(-4)}` : null);
  const idHint = tail(input.waId) ?? tail(input.bsuid);
  return name
    ? { displayName: name, named: true, idHint }
    : { displayName: "Unnamed contact", named: false, idHint };
}

const PLACEHOLDERS: Record<string, string> = {
  IMAGE: "Photo",
  VIDEO: "Video",
  AUDIO: "Voice or audio message",
  DOCUMENT: "Document",
  STICKER: "Sticker",
  LOCATION: "Location",
  CONTACT: "Shared contact card",
  INTERACTIVE: "Interactive reply",
  BUTTON: "Button reply",
  FLOW: "Form response",
  TEMPLATE: "Template message",
  SYSTEM: "System notice",
  REACTION: "Reaction",
  UNKNOWN: "Unsupported message",
};

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** What to show for a message: its text, or a safe placeholder naming the type. Never raw JSON, never a URL. */
export function describeMessage(input: {
  direction: "INBOUND" | "OUTBOUND";
  type: string;
  body: string | null;
  content: unknown;
}): {
  text: string | null;
  placeholder: string | null;
} {
  const content = record(input.content);
  const body = input.body ? safeText(input.body, 4096) : "";
  switch (input.type) {
    case "TEXT":
      return { text: body || null, placeholder: body ? null : "Empty message" };
    case "IMAGE":
    case "VIDEO":
    case "DOCUMENT":
    case "STICKER":
    case "AUDIO":
      return { text: body || null, placeholder: PLACEHOLDERS[input.type] ?? null };
    case "LOCATION": {
      const where = [safeLine(body, 120), safeLine(content?.address, 160)]
        .filter(Boolean)
        .join(" · ");
      return { text: where || null, placeholder: "Location" };
    }
    case "INTERACTIVE":
    case "BUTTON": {
      // The label comes from the stored direction (Phase 08F-3), never from the shape of `content`. The organization can only
      // send INTERACTIVE messages; a BUTTON message is always a customer's template quick-reply.
      if (input.direction === "OUTBOUND") {
        if (input.type === "BUTTON") return { text: null, placeholder: "Unsupported message" };
        // A message SENT by a bot (Phase 08D) stores its payload under content.interactive: show its body and the option
        // titles it offered, never ids. A damaged payload still reads as a sent message, with whatever body survives.
        const sent = record(content?.interactive);
        const rows = Array.isArray(sent?.buttons)
          ? sent.buttons
          : Array.isArray(sent?.sections)
            ? sent.sections.flatMap((s) => {
                const rows = record(s)?.rows;
                return Array.isArray(rows) ? rows : [];
              })
            : [];
        const options = rows
          .map((o) => safeLine(record(o)?.title, 24))
          .filter(Boolean)
          .join(" / ");
        return {
          text: [body, safeLine(options, 240)].filter(Boolean).join(" · ") || null,
          placeholder: "Interactive message",
        };
      }
      return {
        text: body || safeLine(content?.text ?? content?.title, 200) || null,
        placeholder: PLACEHOLDERS[input.type] ?? null,
      };
    }
    case "REACTION":
      return { text: safeLine(content?.emoji, 16) || null, placeholder: "Reaction" };
    case "TEMPLATE": {
      const template = record(content?.template);
      const name = safeLine(template?.name, 80);
      return { text: null, placeholder: name ? `Template: ${name}` : "Template message" };
    }
    default:
      return { text: null, placeholder: PLACEHOLDERS[input.type] ?? "Unsupported message" };
  }
}

export function mediaViews(
  rows: Array<{
    mimeType: string | null;
    filename: string | null;
    sizeBytes: number | null;
    storageStatus: string;
  }>,
): MediaView[] {
  return rows.map((r) => ({
    mimeType: r.mimeType ? safeLine(r.mimeType, 80) : null,
    filename: r.filename ? safeLine(r.filename, 120) : null,
    sizeBytes: typeof r.sizeBytes === "number" && r.sizeBytes >= 0 ? r.sizeBytes : null,
    state: (["PENDING", "STORED", "FAILED", "EXPIRED"].includes(r.storageStatus)
      ? r.storageStatus
      : "PENDING") as MediaView["state"],
  }));
}

export const HOLD_REASONS: Record<string, string> = {
  window_closed: "the 24-hour reply window had closed",
  no_inbound: "the customer has not written to this number",
  inbound_timestamp_invalid: "the customer's last message time could not be trusted",
  account_inactive: "the WhatsApp number is not active",
  contact_archived: "the contact is archived",
  no_identity: "no usable WhatsApp identity is stored for this contact",
  identity_ambiguous: "the contact's WhatsApp identity is ambiguous",
  bsuid_send_unavailable:
    "this contact can only be reached by an identifier that cannot be used yet",
  recipient_changed: "the contact's WhatsApp identity changed after you sent it",
  deadline_passed: "it was not sent in time",
  template_not_found: "the template was not found",
  template_not_approved: "the template is not approved",
  marketing_consent_missing: "marketing consent is not recorded",
  no_prior_contact: "the customer has not written before",
  outbound_disabled: "sending is switched off",
  rate_limited_exhausted: "WhatsApp kept asking to slow down",
  send_failed_before_dispatch: "it could not be started",
  // BOT requests (Phase 08F-3). Staff-visible states first: a person or an operator ended the bot's turn.
  staff_took_over: "a staff member took over this conversation",
  conversation_resolved: "the conversation was resolved",
  bot_stopped: "an operator stopped the bot",
  // Internal bot processing: the bot moved on, stopped or could not read its own state before this message went out.
  bot_deployment_inactive: "the bot is no longer running",
  bot_archived: "the bot is no longer running",
  bot_epoch_superseded: "this message belongs to an earlier bot run",
  bot_step_superseded: "the bot had already moved on",
  bot_session_ended: "the bot conversation had already ended",
  bot_output_suppressed: "the bot's messages were switched off for this chat",
  bot_send_deadline: "the bot did not send it in time",
  bot_state_unreadable: "the bot's records could not be read",
  bots_runtime_disabled: "the bot is switched off",
  account_inactive_before_dispatch: "the WhatsApp number is not active",
  claim_expired_before_dispatch: "it was not sent in time",
  deadline_passed_before_dispatch: "it was not sent in time",
  payload_invalid: "the message content could not be used",
  rate_limited: "WhatsApp asked to slow down",
};

const reason = (code: string | null) =>
  code ? (HOLD_REASONS[code] ?? code.replace(/_/g, " ")) : null;

/**
 * The delivery state of one OUTBOUND message, from the outbound request (our side) and the cached provider status (Meta's).
 * Acceptance is not delivery. "READ" appears only when WhatsApp reported it; opening a conversation never creates it.
 * A message with no request and no status shows no indicator rather than an invented one.
 */
export function deliveryView(input: {
  requestState: string | null;
  holdReason: string | null;
  failureCode: string | null;
  providerStatus: string | null;
  providerErrorCode: string | null;
}): DeliveryView {
  const v = (
    phase: DeliveryView["phase"],
    label: string,
    severity: DeliveryView["severity"],
    detail: string | null = null,
  ): DeliveryView => ({ phase, label, severity, detail });

  // Provider-confirmed states win once the request was accepted (or the request row is gone for old messages).
  const accepted = input.requestState === null || input.requestState === "ACCEPTED";
  if (accepted) {
    switch (input.providerStatus) {
      case "READ":
        return v("READ", "Read", "good", "WhatsApp reported the customer read it");
      case "DELIVERED":
        return v("DELIVERED", "Delivered", "good", "Delivered to the customer's phone");
      case "FAILED":
        return v(
          "FAILED",
          "Delivery failed",
          "error",
          input.providerErrorCode
            ? `WhatsApp error ${safeLine(input.providerErrorCode, 16)}`
            : "WhatsApp reported a delivery failure",
        );
      case "SENT":
        return v("SENT", "Sent", "neutral", "WhatsApp sent it; not yet delivered");
    }
  }
  switch (input.requestState) {
    case "QUEUED":
      return v(
        "QUEUED",
        "Queued",
        "neutral",
        "Waiting to be sent. It has not been sent to WhatsApp yet.",
      );
    case "SENDING":
      return v("SENDING", "Sending…", "neutral", "Being handed to WhatsApp now.");
    case "ACCEPTED":
      return v(
        "ACCEPTED",
        "Accepted by WhatsApp",
        "neutral",
        "Accepted, not yet reported as sent or delivered.",
      );
    case "REJECTED":
      return v(
        "REJECTED",
        "Rejected by WhatsApp",
        "error",
        reason(input.failureCode) ?? "WhatsApp refused the message.",
      );
    case "HELD":
      return v(
        "HELD",
        "Not sent",
        "warning",
        reason(input.holdReason) ? `Not sent: ${reason(input.holdReason)}.` : "Not sent.",
      );
    case "UNKNOWN_OUTCOME":
      return v(
        "UNKNOWN_OUTCOME",
        "Outcome unknown",
        "warning",
        "It may or may not have been sent. Do not send it again until a supervisor has checked WhatsApp Business Manager.",
      );
  }
  return v("NONE", "", "neutral");
}
