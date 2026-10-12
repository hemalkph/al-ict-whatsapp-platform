import type { ConversationListItem, ConversationPage, TimelineMessage } from "@/modules/inbox";

// Pure helpers for refreshing what is already on screen. Polling must never duplicate rows, drop pages the reader already
// loaded, or reorder what they are looking at.

// The server orders conversations by (last_message_at DESC, id DESC) with PostgreSQL's microsecond timestamps. The browser must
// compare the SAME tuple: activityKey is that timestamp as fixed-width UTC text (lexicographic order = time order), and ids are
// lowercase uuids (byte order = text order). lastMessageAt (milliseconds) is for display only: equal there does not mean equal.
const after = (a: ConversationListItem, b: ConversationListItem) =>
  a.activityKey < b.activityKey || (a.activityKey === b.activityKey && a.id < b.id);
const byActivity = (a: ConversationListItem, b: ConversationListItem) =>
  a.id === b.id ? 0 : after(a, b) ? 1 : -1;

/**
 * Applies a freshly fetched FIRST page to the list on screen. Rows of the fresh page replace their old versions; rows the user
 * loaded from later pages (strictly after the refreshed range in the server's order) are kept; a row inside the refreshed range
 * that the fresh page does not contain no longer matches the filter (or moved) and is dropped.
 *
 * Returns the cursor to continue from: the old one while loaded rows beyond the refreshed range are kept (it still points past the
 * last of them), otherwise the fresh page's own.
 */
export function mergeFirstPage(
  old: ConversationListItem[],
  fresh: ConversationPage,
  oldCursor: string | null,
): { items: ConversationListItem[]; nextCursor: string | null } {
  const freshIds = new Set(fresh.items.map((i) => i.id));
  const boundary = fresh.nextCursor ? fresh.items[fresh.items.length - 1] : undefined;
  const kept = boundary ? old.filter((i) => !freshIds.has(i.id) && after(i, boundary)) : [];
  return {
    items: [...fresh.items, ...kept].sort(byActivity),
    nextCursor: kept.length > 0 ? oldCursor : fresh.nextCursor,
  };
}

/**
 * Applies the newest page of messages to the ones on screen. Known messages are updated in place (delivery states change), new
 * ones are inserted by time, and nothing is duplicated. "reset" means the fresh page does not overlap what is shown (more than a
 * page arrived), so the caller starts again from the newest page.
 */
export function mergeMessages(
  existing: TimelineMessage[],
  fresh: TimelineMessage[],
): TimelineMessage[] | "reset" {
  if (existing.length === 0) return fresh;
  const known = new Set(existing.map((m) => m.id));
  if (fresh.length > 0 && !fresh.some((m) => known.has(m.id))) return "reset";
  const byId = new Map(fresh.map((m) => [m.id, m]));
  const merged = existing.map((m) => byId.get(m.id) ?? m);
  const added = fresh.filter((m) => !known.has(m.id));
  return added.length === 0
    ? merged
    : [...merged, ...added].sort((a, b) =>
        a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0,
      );
}
