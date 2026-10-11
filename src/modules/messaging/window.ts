import { SERVICE_WINDOW_MS, SERVICE_WINDOW_SAFETY_MARGIN_MS } from "./policy";

// The customer service window for FREE-FORM messages. The only evidence is conversations.last_inbound_at: the effective
// time of the customer's latest qualifying inbound message for THIS account and contact, written by the inbound handler
// (reactions never move it, a provider timestamp is capped at receipt + 5 minutes). Outbound sends, delivery receipts,
// status timestamps and Click-to-WhatsApp referrals are never evidence: nothing here reads them. A CTWA 72-hour free entry
// point is a PRICING window, not a free-form sending right: "if the customer service window closes, you will only be able
// to send template messages" (Meta pricing page).

export type WindowDecision =
  | { open: true; closesAt: Date }
  | { open: false; reason: "no_inbound" | "window_closed" | "inbound_timestamp_invalid" };

export function serviceWindow(lastInboundAt: Date | null, now: Date): WindowDecision {
  if (lastInboundAt === null || Number.isNaN(lastInboundAt.getTime()))
    return { open: false, reason: "no_inbound" };
  // Ingest caps a provider timestamp at receipt + 5 minutes, so a stored value further ahead than the safety margin cannot be
  // genuine: it is not trusted at all (conservative). A value slightly ahead (clock skew) counts as "now", never as more.
  if (lastInboundAt.getTime() > now.getTime() + SERVICE_WINDOW_SAFETY_MARGIN_MS)
    return { open: false, reason: "inbound_timestamp_invalid" };
  const start = Math.min(lastInboundAt.getTime(), now.getTime());
  const closesAt = new Date(start + SERVICE_WINDOW_MS - SERVICE_WINDOW_SAFETY_MARGIN_MS);
  return now.getTime() < closesAt.getTime()
    ? { open: true, closesAt }
    : { open: false, reason: "window_closed" };
}
