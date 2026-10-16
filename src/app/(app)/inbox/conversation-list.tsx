"use client";

import type { ConversationListItem, InboxView } from "@/modules/inbox";
import { ContactAvatar } from "./contact-avatar";
import { shortTime } from "./format";
import { STATUS_LABEL, VIEW_LABEL } from "./labels";

const VIEWS: readonly InboxView[] = [
  "all",
  "OPEN",
  "PENDING",
  "RESOLVED",
  "mine",
  "unassigned",
  "unread",
];

export type ListStatus = { loading: boolean; loadingMore: boolean; error: string | null };

type Props = {
  items: ConversationListItem[];
  selectedId: string | null;
  view: InboxView;
  accountId: string | null;
  accounts: Array<{ id: string; label: string }>;
  searchText: string;
  searchHint: boolean;
  status: ListStatus;
  hasMore: boolean;
  offline: boolean;
  onSelect: (id: string) => void;
  onView: (view: InboxView) => void;
  onAccount: (id: string | null) => void;
  onSearch: (text: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
};

const statusStyle = {
  OPEN: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  PENDING: "bg-amber-50 text-amber-900 ring-amber-200",
  RESOLVED: "bg-zinc-100 text-zinc-700 ring-zinc-200",
} as const;

export function ConversationList(p: Props) {
  return (
    <section aria-label="Conversations" className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex flex-col gap-2 border-b border-zinc-200 p-3">
        <h2 className="px-0.5 text-base font-semibold text-zinc-900">Chats</h2>
        <label className="sr-only" htmlFor="inbox-search">
          Search conversations
        </label>
        <input
          id="inbox-search"
          type="search"
          value={p.searchText}
          onChange={(e) => p.onSearch(e.target.value)}
          placeholder="Search name, username or number"
          maxLength={64}
          autoComplete="off"
          className="w-full rounded-lg border border-transparent bg-zinc-100 px-3 py-2 text-sm placeholder:text-zinc-500 focus-visible:bg-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-700"
        />
        {p.searchHint ? (
          <p className="text-xs text-zinc-600">Type at least 2 characters to search.</p>
        ) : null}
        <div role="group" aria-label="Filter conversations" className="flex flex-wrap gap-1.5">
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={p.view === v}
              onClick={() => p.onView(v)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-700 ${
                p.view === v
                  ? "bg-emerald-700 text-white ring-emerald-700"
                  : "bg-white text-zinc-700 ring-zinc-300 hover:bg-zinc-50"
              }`}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        {p.accounts.length > 1 ? (
          <>
            <label className="sr-only" htmlFor="inbox-account">
              WhatsApp number
            </label>
            <select
              id="inbox-account"
              value={p.accountId ?? ""}
              onChange={(e) => p.onAccount(e.target.value || null)}
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-700"
            >
              <option value="">All WhatsApp numbers</option>
              {p.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      {p.offline ? (
        <p role="status" className="bg-amber-50 px-3 py-2 text-xs text-amber-900">
          You appear to be offline. The list will refresh when the connection is back.
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={p.status.loading}>
        {p.status.error ? (
          <div role="alert" className="m-3 rounded-md bg-red-50 p-3 text-sm text-red-800">
            <p>{p.status.error}</p>
            <button
              type="button"
              onClick={p.onRetry}
              className="mt-2 rounded-md bg-white px-2.5 py-1 text-xs font-medium text-red-800 ring-1 ring-red-300 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-red-700"
            >
              Try again
            </button>
          </div>
        ) : null}

        {p.status.loading && p.items.length === 0 ? (
          <p role="status" className="p-4 text-sm text-zinc-600">
            Loading conversations…
          </p>
        ) : null}

        {!p.status.loading && !p.status.error && p.items.length === 0 ? (
          <div className="p-6 text-center text-sm text-zinc-600">
            <p className="font-medium text-zinc-800">No conversations here</p>
            <p className="mt-1">
              {p.view === "all" && !p.searchText
                ? "When a student messages one of your WhatsApp numbers, the conversation will appear here."
                : "Nothing matches these filters. Try a different filter or search."}
            </p>
          </div>
        ) : null}

        <ul>
          {p.items.map((c) => {
            const selected = c.id === p.selectedId;
            const unread = c.unreadCount > 0;
            return (
              <li key={c.id} className="border-b border-zinc-100 last:border-b-0">
                <button
                  type="button"
                  onClick={() => p.onSelect(c.id)}
                  aria-current={selected ? "true" : undefined}
                  className={`flex w-full items-start gap-3 px-3 py-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-700 ${
                    selected ? "bg-emerald-50" : "hover:bg-zinc-50"
                  }`}
                >
                  <ContactAvatar name={c.contact.displayName} named={c.contact.named} />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={`min-w-0 truncate text-sm ${unread ? "font-semibold text-zinc-900" : "font-medium text-zinc-800"}`}
                      >
                        {c.contact.displayName}
                        {c.contact.idHint ? (
                          <span className="ml-1.5 text-xs font-normal text-zinc-600">
                            {c.contact.idHint}
                          </span>
                        ) : null}
                      </span>
                      <time
                        dateTime={c.lastMessageAt}
                        suppressHydrationWarning
                        className={`shrink-0 text-xs ${unread ? "font-medium text-emerald-800" : "text-zinc-600"}`}
                      >
                        {shortTime(c.lastMessageAt)}
                      </time>
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <span
                        className={`min-w-0 truncate text-sm ${unread ? "text-zinc-900" : "text-zinc-600"}`}
                      >
                        {c.preview
                          ? `${c.preview.direction === "OUTBOUND" ? "You: " : ""}${c.preview.text}`
                          : "No messages yet"}
                      </span>
                      {unread ? (
                        <span
                          aria-label={`${c.unreadCount}${c.unreadCapped ? " or more" : ""} unread`}
                          className="shrink-0 rounded-full bg-emerald-700 px-1.5 py-0.5 text-xs font-semibold text-white"
                        >
                          {c.unreadCapped ? `${c.unreadCount}+` : c.unreadCount}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-600">
                      <span
                        className={`rounded px-1.5 py-0.5 font-medium ring-1 ring-inset ${statusStyle[c.status]}`}
                      >
                        {STATUS_LABEL[c.status]}
                      </span>
                      {c.assignee ? (
                        <span className={c.assignee.suspended ? "text-amber-800" : ""}>
                          {c.assignee.name}
                          {c.assignee.suspended ? " (inactive)" : ""}
                        </span>
                      ) : (
                        <span>Unassigned</span>
                      )}
                      {p.accounts.length > 1 ? <span>· {c.account.label}</span> : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {p.hasMore ? (
          <div className="p-3">
            <button
              type="button"
              onClick={p.onLoadMore}
              disabled={p.status.loadingMore}
              className="w-full rounded-md bg-white px-3 py-2 text-sm font-medium text-zinc-800 ring-1 ring-zinc-300 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-60"
            >
              {p.status.loadingMore ? "Loading…" : "Load more conversations"}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
