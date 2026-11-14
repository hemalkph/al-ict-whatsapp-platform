import type { StudentInput } from "@/modules/bots";
import { isEligibleMessageType } from "./policy";

// A persisted inbound message as the engine's student input (Phase 08E-1; plan section G.1). PURE. This is the CONTINUATION
// mapping (an input to a live session). It is deliberately separate from trigger capture (which types create a trigger) and
// from session-start matching (which types may satisfy which trigger kind, in the bots module): a BUTTON message is captured,
// may START a session through first_message or referral_source, and is `other` once a session is live.

export type InboundMessageRow = {
  /** messages.type */
  readonly type: string;
  readonly body: string | null;
  /** messages.content (jsonb): for INTERACTIVE {subtype, id, title, description?}; for BUTTON {payload, text}. */
  readonly content: unknown;
  /** messages.reply_to_wamid: the wamid the customer replied to, when the provider supplied a context. */
  readonly replyToWamid: string | null;
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The engine input for a message, or null when the message type is not capturable (such a message never reaches the engine).
 *
 *  - TEXT -> text (a TEXT row without a body cannot answer anything: `other`);
 *  - INTERACTIVE button_reply / list_reply with a string id -> interactive; the id is passed through UNCHANGED, the engine
 *    owns the grammar, token and option checks (a missing or non-string id cannot be a reply: `other`);
 *  - BUTTON -> other.
 *
 * `promptWamid` is the wamid of the outbound message of the prompt the session is waiting on (its request at the session's
 * current step). `contextMismatch` is true only when the message HAS a reply context and it is not that wamid (an unknown
 * prompt wamid cannot match); a message without a context changes nothing.
 */
export function toStudentInput(
  message: InboundMessageRow,
  promptWamid: string | null,
): StudentInput | null {
  if (!isEligibleMessageType(message.type)) return null;
  if (message.type === "TEXT")
    return message.body === null ? { kind: "other" } : { kind: "text", text: message.body };
  if (message.type === "BUTTON") return { kind: "other" };
  const content = record(message.content);
  const subtype = content?.subtype;
  const id = content?.id;
  if (
    (subtype !== "button_reply" && subtype !== "list_reply") ||
    typeof id !== "string" ||
    id === ""
  )
    return { kind: "other" };
  return {
    kind: "interactive",
    subtype,
    replyId: id,
    contextMismatch: message.replyToWamid !== null && message.replyToWamid !== promptWamid,
  };
}
