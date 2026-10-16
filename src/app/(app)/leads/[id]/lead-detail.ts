import type { ConversationRef, LeadDetail, LeadEventView, TouchView } from "@/modules/leads";
import { leadFiltersToSearch, type LeadFilters } from "../lead-filters";

// Pure presentation logic of the lead page (Phase 07D-3): paths, counts and the facts shown for one piece of evidence. No React,
// no environment, no requests. Every string that came from Meta or WhatsApp is returned unchanged as TEXT; nothing here builds a
// link from it.

// ------------------------------------------------------------------------------------------------------------------ paths
// Every path is built from a validated filter set or an id this page already holds, never from a URL the browser supplied.

/** The Leads list with the given filters (the canonical query string; "" for the defaults). */
export const leadsListPath = (filters: LeadFilters) => `/leads${leadFiltersToSearch(filters)}`;

/** A lead's page. The filters ride along only so "Back to leads" can return to the same list. */
export const leadPath = (leadId: string, filters: LeadFilters) =>
  `/leads/${encodeURIComponent(leadId)}${leadFiltersToSearch(filters)}`;

/** The Inbox with this conversation open: the inbox page reads `c` (a UUID) from its query (src/app/(app)/inbox/page.tsx). */
export const inboxConversationPath = (conversationId: string) =>
  `/inbox?c=${encodeURIComponent(conversationId)}`;

// ------------------------------------------------------------------------------------------------------------- lifecycle

export type LifecycleRow = { readonly label: string; readonly at: string };

/** The lifecycle times the server returned, in reading order. "Closed" appears only while the lead is closed. */
export function lifecycleRows(lead: LeadDetail["lead"]): LifecycleRow[] {
  return [
    { label: "Created", at: lead.createdAt },
    { label: "Current cycle started", at: lead.cycleStartedAt },
    { label: "Last status change", at: lead.statusChangedAt },
    ...(lead.closedAt ? [{ label: "Closed", at: lead.closedAt }] : []),
  ];
}

/** What staff can do with the status on this page, in words (no control exists yet: status changes arrive in a later version). */
export function editNote(lead: { readonly readOnly: boolean }, canEdit: boolean): string | null {
  if (lead.readOnly) return null; // the reserved-status note says it
  return canEdit ? null : "Your role can view this lead but cannot change it.";
}

// ---------------------------------------------------------------------------------------------------------- conversations

const CONVERSATION_STATUS: Record<ConversationRef["status"], string> = {
  OPEN: "Open",
  PENDING: "Pending",
  RESOLVED: "Resolved",
};

export const conversationStatusLabel = (status: string) =>
  Object.hasOwn(CONVERSATION_STATUS, status)
    ? CONVERSATION_STATUS[status as ConversationRef["status"]]
    : "Unknown";

// -------------------------------------------------------------------------------------------------------------- evidence

export type Fact = { readonly label: string; readonly value: string };

/** The recorded details of one piece of evidence, only those present. Values are untrusted text for the page to render as text. */
export function touchFacts(t: TouchView): Fact[] {
  const facts: Fact[] = [];
  if (t.sourceId) facts.push({ label: "Source ID", value: t.sourceId });
  if (t.sourceLink) facts.push({ label: "Source link", value: t.sourceLink });
  if (t.mediaType) facts.push({ label: "Media type", value: t.mediaType });
  if (t.mediaLink) facts.push({ label: "Media link", value: t.mediaLink });
  if (t.clickIdTail) facts.push({ label: "Click ID ends with", value: t.clickIdTail });
  return facts;
}

/** How many pieces of evidence are linked to the lead, and how many of them the page holds. The total is the server's exact count. */
export function linkedCountText(total: number, shown: number): string {
  if (total === 0) return "No referral evidence is linked to this lead.";
  const noun = total === 1 ? "referral record is" : "referral records are";
  return shown < total
    ? `${total} ${noun} linked to this lead. Showing the earliest ${shown}.`
    : `${total} ${noun} linked to this lead.`;
}

export function otherCountText(total: number, shown: number): string {
  if (total === 0) return "No other referral evidence is recorded for this contact.";
  const noun = total === 1 ? "record" : "records";
  return shown < total
    ? `${total} other ${noun} for this contact. Showing the newest ${shown}.`
    : `${total} other ${noun} for this contact.`;
}

/** The latest linked touch is shown on its own only when the earliest-first list was cut short and does not contain it. */
export function latestOutsideList(
  linked: readonly TouchView[],
  total: number,
  latest: TouchView | null,
): TouchView | null {
  if (!latest || total <= linked.length) return null;
  return linked.some((t) => t.id === latest.id) ? null : latest;
}

// ---------------------------------------------------------------------------------------------------------------- history

const EVENT_KIND_LABEL: Record<LeadEventView["kind"], string> = {
  CREATED: "Created",
  STATUS: "Status change",
  TOUCH_LINKED: "Evidence linked",
};

/** A short label for the kind of event, so a row never relies on colour or position alone. Unknown kinds are shown as such. */
export const eventKindLabel = (kind: string) =>
  Object.hasOwn(EVENT_KIND_LABEL, kind) ? EVENT_KIND_LABEL[kind as LeadEventView["kind"]] : "Event";

/** The history lines for the screen reader: how many are shown and whether older ones can be loaded. Never a total. */
export function historyStatusText(shown: number, more: boolean): string {
  if (shown === 0) return "No history is recorded for this lead.";
  const n = `${shown} ${shown === 1 ? "event" : "events"} shown`;
  return more
    ? `${n}. Older events can be loaded.`
    : `${n}. This is the start of the recorded history.`;
}
