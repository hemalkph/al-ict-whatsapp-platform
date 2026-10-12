// Plain-language text for states and reasons. Pure strings, safe to ship to the browser.

export const STATUS_LABEL = { OPEN: "Open", PENDING: "Pending", RESOLVED: "Resolved" } as const;
export const STATUS_ORDER = ["OPEN", "PENDING", "RESOLVED"] as const;

export const VIEW_LABEL = {
  all: "All",
  OPEN: "Open",
  PENDING: "Pending",
  RESOLVED: "Resolved",
  mine: "Assigned to me",
  unassigned: "Unassigned",
  unread: "Unread",
} as const;

/** Why a free-form reply cannot be queued right now (the Phase 05 policy decides; this only explains it). */
export function replyBlockedText(reason: string | null): string {
  switch (reason) {
    case "outbound_disabled":
      return "Sending is switched off for this platform, so replies cannot be queued. Nothing you type here will be sent.";
    case "window_closed":
      return "The 24-hour reply window has closed. WhatsApp lets us send a free-form reply only for 24 hours after the customer's last message, and this platform does not send anything else yet. You can reply once the customer writes again.";
    case "no_inbound":
      return "This customer has not written to this number, so a reply cannot be sent.";
    case "inbound_timestamp_invalid":
      return "The time of the customer's last message could not be trusted, so a reply cannot be sent.";
    case "account_inactive":
      return "This WhatsApp number is not active.";
    case "contact_archived":
      return "This contact is archived.";
    case "bsuid_send_unavailable":
      return "This contact can only be reached by an identifier that this platform cannot send to yet, so a reply cannot be sent. Their old phone number is not used because it may belong to someone else now.";
    case "no_identity":
    case "identity_ambiguous":
      return "There is no safe WhatsApp identity stored for this contact, so a reply cannot be sent.";
    default:
      return "A reply cannot be sent right now.";
  }
}

/** The refusal reason inside an API error message ("This message cannot be sent: window_closed"). */
export function refusalReason(detail: string | null): string | null {
  const match = detail ? /: ([a-z_]+)$/.exec(detail) : null;
  return match ? match[1]! : null;
}

export type SendNotice = { kind: "ok" | "warning"; text: string };

/**
 * What to tell the sender once the server has answered a submission. The wording follows the REAL state of the request: an
 * existing request is described by what it is now, never as "queued" unless it is, and an uncertain outcome is never described
 * as unsent. (Nothing here is a delivery report: that comes from WhatsApp and shows under the message.)
 */
export function acceptedNotice(state: string, replayed: boolean): SendNotice {
  const found = replayed ? "Existing request found. " : "";
  switch (state) {
    case "QUEUED":
      return {
        kind: "ok",
        text: replayed
          ? "Existing request found: that message is queued. It has not been sent to WhatsApp yet; watch its status under the message."
          : "Queued. It has not been sent to WhatsApp yet; watch its status under the message.",
      };
    case "SENDING":
      return {
        kind: "ok",
        text: `${found}It is being sent to WhatsApp right now. Its result is not known yet; watch its status under the message.`,
      };
    case "ACCEPTED":
      return {
        kind: "ok",
        text: `${found}WhatsApp has accepted it. That does not mean it was delivered; watch its status under the message.`,
      };
    case "REJECTED":
      return {
        kind: "warning",
        text: `${found}WhatsApp rejected it, so it was not delivered. The reason is shown under the message.`,
      };
    case "HELD":
      return {
        kind: "warning",
        text: `${found}It was not sent: it is on hold. The reason is shown under the message.`,
      };
    case "UNKNOWN_OUTCOME":
      return {
        kind: "warning",
        text: `${found}It may or may not have been sent to WhatsApp. Do not send it again until a supervisor has checked.`,
      };
    default:
      return {
        kind: "warning",
        text: "Existing request found. Check its current status in the conversation.",
      };
  }
}
