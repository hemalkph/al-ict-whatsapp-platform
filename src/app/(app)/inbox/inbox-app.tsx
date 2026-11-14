"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ConversationDetail,
  ConversationPage,
  InboxView,
  MessagePage,
  TimelineMessage,
} from "@/modules/inbox";
import { ContactAvatar } from "./contact-avatar";
import {
  ApiError,
  api,
  getActorChanged,
  isAbort,
  setPageActor,
  subscribeActorChanged,
} from "./api";
import { Composer } from "./composer";
import { ConversationList, type ListStatus } from "./conversation-list";
import { DetailsPanel } from "./details-panel";
import { createLane } from "./latest";
import { fetchContactLeads, createLead } from "../leads/lead-api";
import { LeadPanel } from "./lead-panel";
import { createLeadPanelController } from "./lead-panel-controller";
import { mergeFirstPage, mergeMessages } from "./merge";
import { MessageTimeline } from "./message-timeline";
import { STATUS_LABEL } from "./labels";
import { usePolling } from "./use-polling";

export type Query = { view: InboxView; q: string; accountId: string | null };
export type Initial = {
  query: Query;
  list: ConversationPage;
  accounts: Array<{ id: string; label: string }>;
  selectedId: string | null;
  selected: { detail: ConversationDetail; messages: MessagePage } | null;
  selectedMissing: boolean;
};
type Props = {
  initial: Initial;
  me: {
    userId: string;
    organizationId: string;
    membershipId: string;
    name: string;
    role: string;
    botRead: boolean;
  };
  polling: { listMs: number; chatMs: number };
};

const PAGE = 30;
const CHAT_PAGE = 40;

const useMedia = (query: string) =>
  useSyncExternalStore(
    (notify) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", notify);
      return () => m.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
const useOnline = () =>
  useSyncExternalStore(
    (notify) => {
      window.addEventListener("online", notify);
      window.addEventListener("offline", notify);
      return () => {
        window.removeEventListener("online", notify);
        window.removeEventListener("offline", notify);
      };
    },
    () => navigator.onLine,
    () => true,
  );

function listUrl(q: Query, cursor: string | null) {
  const sp = new URLSearchParams({ limit: String(PAGE) });
  if (q.view !== "all") sp.set("view", q.view);
  if (q.q) sp.set("q", q.q);
  if (q.accountId) sp.set("accountId", q.accountId);
  if (cursor) sp.set("cursor", cursor);
  return `/api/inbox/conversations?${sp}`;
}
function pageUrl(q: Query, id: string | null) {
  const sp = new URLSearchParams();
  if (q.view !== "all") sp.set("view", q.view);
  if (q.q) sp.set("q", q.q);
  if (q.accountId) sp.set("account", q.accountId);
  if (id) sp.set("c", id);
  const s = sp.toString();
  return s ? `/inbox?${s}` : "/inbox";
}
const sameQuery = (a: Query, b: Query) =>
  a.view === b.view && a.q === b.q && a.accountId === b.accountId;

const firstUnseen = (messages: TimelineMessage[]) => messages.find((m) => m.unseen)?.id ?? null;

export function InboxApp({ initial, me, polling }: Props) {
  const [query, setQuery] = useState<Query>(initial.query);
  const [searchText, setSearchText] = useState(initial.query.q);
  const [list, setList] = useState({
    items: initial.list.items,
    nextCursor: initial.list.nextCursor,
  });
  const { items, nextCursor } = list;
  const [reloadNonce, setReloadNonce] = useState(0);
  const [listStatus, setListStatus] = useState<ListStatus>({
    loading: false,
    loadingMore: false,
    error: null,
  });

  const [selectedId, setSelectedId] = useState(initial.selectedId);
  const [detail, setDetail] = useState<ConversationDetail | null>(initial.selected?.detail ?? null);
  const [messages, setMessages] = useState<TimelineMessage[]>(
    initial.selected?.messages.messages ?? [],
  );
  const [olderCursor, setOlderCursor] = useState<string | null>(
    initial.selected?.messages.olderCursor ?? null,
  );
  const [newFromId, setNewFromId] = useState<string | null>(
    initial.selected ? firstUnseen(initial.selected.messages.messages) : null,
  );
  const [chat, setChat] = useState({
    loading: initial.selectedId !== null && initial.selected === null && !initial.selectedMissing,
    notFound: initial.selectedMissing,
    error: null as string | null,
    loadingOlder: false,
  });
  const [replyTo, setReplyTo] = useState<{ id: string; preview: string } | null>(null);
  const [pane, setPane] = useState<"list" | "chat" | "details">(
    initial.selectedId ? "chat" : "list",
  );
  const [pollTick, setPollTick] = useState(0);

  // The server rendered this page for one actor. Every request states it (X-Expected-Actor) so the server can refuse when the
  // signed-in account has changed in another tab; the first such refusal stops this page (see below). A layout effect runs
  // before the children's first requests.
  useLayoutEffect(() => {
    setPageActor({
      userId: me.userId,
      organizationId: me.organizationId,
      membershipId: me.membershipId,
    });
    return () => setPageActor(null);
  }, [me.userId, me.organizationId, me.membershipId]);
  const actorChanged = useSyncExternalStore(subscribeActorChanged, getActorChanged, () => false);

  // The open contact's leads (07D-5). Same shared client, so the same actor assertion; the controller drops any answer that is not
  // for the contact shown now, and stops for good when the account changes.
  const [leads] = useState(() =>
    createLeadPanelController({
      fetchContactLeads: (contactId, { signal }) => fetchContactLeads(contactId, { signal }),
      createLead: (contactId, { signal }) => createLead(contactId, { signal }),
      isActorChanged: getActorChanged,
    }),
  );
  const leadState = useSyncExternalStore(leads.subscribe, leads.getState, leads.getState);
  const leadContactId = detail?.contact.id ?? null;
  useEffect(() => {
    if (actorChanged) leads.block();
  }, [actorChanged, leads]);
  useEffect(() => leads.select(leadContactId), [leadContactId, leads]);
  useEffect(() => () => leads.cancel(), [leads]);

  const desktop = useMedia("(min-width: 1024px)");
  const wide = useMedia("(min-width: 1280px)");
  const online = useOnline();

  const queryRef = useRef(query);
  const selectedRef = useRef(selectedId);
  const loadedId = useRef<string | null>(initial.selected ? initial.selectedId : null);
  const messagesRef = useRef(messages);
  const seenSent = useRef<Set<string>>(new Set());
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // One lane per kind of refresh: the latest started request wins (see latest.ts). The list has two more pieces of state:
  // `needsReplace` (the current query's first page has not landed yet, so the next first-page result REPLACES the list instead
  // of merging into rows that belong to another query) and `epoch` (bumped on every query change, so a "load more" that started
  // under an older query cannot append to the new one).
  const [listLane] = useState(createLane);
  const [chatLane] = useState(createLane);
  const needsReplace = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    queryRef.current = query;
    selectedRef.current = selectedId;
    messagesRef.current = messages;
  });
  useEffect(
    () => () => {
      clearTimeout(debounce.current);
      listLane.cancel();
      chatLane.cancel();
    },
    [listLane, chatLane],
  );

  // ---------------------------------------------------------------------------------------------- conversation list
  // The first page of the current query. Used by the query/Retry effect, by polling and by refreshes after a change; whichever
  // started last decides what is shown. While the current query's first page has not landed it replaces the list.
  const loadFirst = useCallback(
    async (signal?: AbortSignal) => {
      const q = queryRef.current;
      const replace = needsReplace.current;
      const req = listLane.begin(signal);
      try {
        const page = await api<ConversationPage>(listUrl(q, null), { signal: req.signal });
        if (!req.isCurrent() || !sameQuery(q, queryRef.current)) return;
        if (replace) {
          needsReplace.current = false;
          setList({ items: page.items, nextCursor: page.nextCursor });
          setListStatus({ loading: false, loadingMore: false, error: null });
        } else {
          setList((old) => mergeFirstPage(old.items, page, old.nextCursor));
        }
      } catch (e) {
        if (isAbort(e)) return;
        if (replace && req.isCurrent())
          setListStatus({
            loading: false,
            loadingMore: false,
            error: "The conversation list could not be loaded.",
          });
        else throw e; // a failed background refresh: the poller tries again on its next run
      }
    },
    [listLane],
  );
  usePolling(loadFirst, polling.listMs, !actorChanged);

  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    void loadFirst().catch(() => undefined);
  }, [query, reloadNonce, loadFirst]);

  const applyQuery = useCallback((next: Query) => {
    if (sameQuery(next, queryRef.current)) return;
    epoch.current++;
    needsReplace.current = true;
    setQuery(next);
    setListStatus({ loading: true, loadingMore: false, error: null });
    window.history.replaceState(null, "", pageUrl(next, selectedRef.current));
  }, []);

  /** Retry after a failed load: loads again even though the query is unchanged. */
  const retryList = useCallback(() => {
    epoch.current++;
    needsReplace.current = true;
    setListStatus({ loading: true, loadingMore: false, error: null });
    setReloadNonce((n) => n + 1);
  }, []);

  async function loadMore() {
    if (!nextCursor || listStatus.loadingMore) return;
    const q = query;
    const mine = epoch.current;
    setListStatus((st) => ({ ...st, loadingMore: true }));
    try {
      const page = await api<ConversationPage>(listUrl(q, nextCursor));
      if (mine !== epoch.current || !sameQuery(q, queryRef.current)) return;
      setList((old) => {
        const have = new Set(old.items.map((i) => i.id));
        return {
          items: [...old.items, ...page.items.filter((i) => !have.has(i.id))],
          nextCursor: page.nextCursor,
        };
      });
      setListStatus((st) => ({ ...st, loadingMore: false }));
    } catch {
      if (mine !== epoch.current) return;
      setListStatus((st) => ({
        ...st,
        loadingMore: false,
        error: "More conversations could not be loaded.",
      }));
    }
  }

  function onSearch(text: string) {
    setSearchText(text);
    clearTimeout(debounce.current);
    const trimmed = text.trim();
    if (trimmed.length === 1) return; // the hint is shown; nothing is searched until there are 2 characters
    debounce.current = setTimeout(() => applyQuery({ ...queryRef.current, q: trimmed }), 350);
  }

  // -------------------------------------------------------------------------------------- the open conversation
  const apply = useCallback((d: ConversationDetail, m: MessagePage, mode: "replace" | "merge") => {
    setDetail(d);
    setList((l) => ({
      ...l,
      items: l.items.map((i) =>
        i.id === d.id ? { ...i, status: d.status, assignee: d.assignee } : i,
      ),
    }));
    const merged = mode === "merge" ? mergeMessages(messagesRef.current, m.messages) : "reset";
    if (merged === "reset") {
      // first load, or more arrived than one page (no overlap): start from the newest page
      setMessages(m.messages);
      setOlderCursor(m.olderCursor);
    } else {
      setMessages(merged);
    }
  }, []);

  useEffect(() => {
    if (!selectedId || loadedId.current === selectedId) return;
    const req = chatLane.begin();
    Promise.all([
      api<{ conversation: ConversationDetail }>(`/api/inbox/conversations/${selectedId}`, {
        signal: req.signal,
      }),
      api<MessagePage>(`/api/inbox/conversations/${selectedId}/messages?limit=${CHAT_PAGE}`, {
        signal: req.signal,
      }),
    ])
      .then(([d, m]) => {
        if (!req.isCurrent()) return;
        loadedId.current = selectedId;
        apply(d.conversation, m, "replace");
        setNewFromId(firstUnseen(m.messages));
        setChat({ loading: false, notFound: false, error: null, loadingOlder: false });
      })
      .catch((e: unknown) => {
        if (isAbort(e) || !req.isCurrent()) return;
        const missing = e instanceof ApiError && e.status === 404;
        setChat({
          loading: false,
          notFound: missing,
          error: missing ? null : "This conversation could not be loaded.",
          loadingOlder: false,
        });
      });
    return () => chatLane.cancel();
  }, [selectedId, apply, chatLane]);

  const refreshChat = useCallback(
    async (signal?: AbortSignal) => {
      const id = selectedRef.current;
      if (!id || loadedId.current !== id) return;
      const req = chatLane.begin(signal);
      try {
        const [d, m] = await Promise.all([
          api<{ conversation: ConversationDetail }>(`/api/inbox/conversations/${id}`, {
            signal: req.signal,
          }),
          api<MessagePage>(`/api/inbox/conversations/${id}/messages?limit=${CHAT_PAGE}`, {
            signal: req.signal,
          }),
        ]);
        if (!req.isCurrent() || selectedRef.current !== id) return;
        apply(d.conversation, m, "merge");
        setPollTick((t) => t + 1);
        setChat((c) => (c.error ? { ...c, error: null } : c));
      } catch (e) {
        if (isAbort(e) || !req.isCurrent()) return;
        if (e instanceof ApiError && e.status === 404) setChat((c) => ({ ...c, notFound: true }));
        else
          setChat((c) => ({
            ...c,
            error: "Connection problem. Showing what was last loaded; retrying.",
          }));
      }
    },
    [apply, chatLane],
  );
  usePolling(refreshChat, polling.chatMs, selectedId !== null && !actorChanged);

  const afterChange = useCallback(() => {
    void refreshChat();
    void loadFirst().catch(() => undefined);
  }, [refreshChat, loadFirst]);

  async function loadOlder() {
    if (!selectedId || !olderCursor || chat.loadingOlder) return;
    const id = selectedId;
    setChat((c) => ({ ...c, loadingOlder: true }));
    try {
      const page = await api<MessagePage>(
        `/api/inbox/conversations/${id}/messages?limit=${CHAT_PAGE}&before=${encodeURIComponent(olderCursor)}`,
      );
      if (selectedRef.current !== id) return;
      setMessages((prev) => {
        const have = new Set(prev.map((m) => m.id));
        return [...page.messages.filter((m) => !have.has(m.id)), ...prev];
      });
      setOlderCursor(page.olderCursor);
    } catch {
      setChat((c) => ({ ...c, error: "Earlier messages could not be loaded." }));
    } finally {
      setChat((c) => ({ ...c, loadingOlder: false }));
    }
  }

  function select(id: string) {
    if (id === selectedId) {
      setPane("chat");
      return;
    }
    loadedId.current = null;
    chatLane.cancel(); // nothing in flight for the previous conversation may land on this one
    setSelectedId(id);
    setDetail(null);
    setMessages([]);
    setOlderCursor(null);
    setNewFromId(null);
    setReplyTo(null);
    setChat({ loading: true, notFound: false, error: null, loadingOlder: false });
    setPane("chat");
    window.history.replaceState(null, "", pageUrl(query, id));
  }

  function back() {
    loadedId.current = null;
    chatLane.cancel();
    setSelectedId(null);
    setDetail(null);
    setMessages([]);
    setPane("list");
    window.history.replaceState(null, "", pageUrl(query, null));
  }

  // Mark as seen only the messages the timeline reports as actually ON SCREEN (see MessageTimeline): not because a poll fetched
  // them, not while Details covers the chat, not in a hidden tab. Never a WhatsApp read receipt. A message that arrives later is
  // reported (and marked) by a later pass.
  const markSeen = useCallback((ids: string[]) => {
    const conversationId = selectedRef.current;
    if (!conversationId) return;
    const send = ids.filter((id) => !seenSent.current.has(id)).slice(0, 100);
    if (send.length === 0) return;
    send.forEach((id) => seenSent.current.add(id));
    api<{ unreadCount: number; unreadCapped: boolean }>(
      `/api/inbox/conversations/${conversationId}/seen`,
      { method: "POST", body: { messageIds: send } },
    )
      .then((r) => {
        const done = new Set(send);
        setMessages((ms) => ms.map((m) => (done.has(m.id) ? { ...m, unseen: false } : m)));
        setList((l) => ({
          ...l,
          items: l.items.map((i) =>
            i.id === conversationId
              ? { ...i, unreadCount: r.unreadCount, unreadCapped: r.unreadCapped }
              : i,
          ),
        }));
      })
      .catch(() => send.forEach((id) => seenSent.current.delete(id)));
  }, []);
  // The chat is on screen unless Details covers it (always side by side from 1280px) or the list is the only pane (phones).
  const chatVisible = wide || (desktop ? pane !== "details" : pane === "chat");

  // ----------------------------------------------------------------------------------------------------- rendering
  // The signed-in account is no longer the one this page was opened for. Its content belongs to the previous actor and nothing
  // here may act as the current one, so the page is replaced by this notice. Any message still being checked stays with the
  // previous account (it is not cancelled and not moved); reloading shows the current account's own inbox.
  if (actorChanged)
    return (
      <main aria-label="Inbox" className="flex h-full items-center justify-center p-6">
        <div
          role="alert"
          className="max-w-md rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p className="text-base font-semibold">Your signed-in account has changed.</p>
          <p className="mt-2">
            This page was opened for a previous session, so it has stopped using information from
            that session, and it sends nothing more. No new message was submitted after the change
            was detected. An operation submitted before the change, such as a message or a lead, may
            already have completed: this page cannot confirm its outcome. Reload to continue with
            your current account.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 rounded-md bg-amber-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-900"
          >
            Reload as the current account
          </button>
        </div>
      </main>
    );
  const quote = (m: TimelineMessage) =>
    setReplyTo({ id: m.id, preview: (m.text ?? m.placeholder ?? "Message").slice(0, 100) });

  return (
    <main
      aria-label="Inbox"
      className="relative grid h-full min-h-0 grid-cols-1 bg-zinc-100 lg:grid-cols-[20rem_minmax(0,1fr)] lg:gap-2 lg:p-2 xl:grid-cols-[20rem_minmax(0,1fr)_20rem] 2xl:grid-cols-[24rem_minmax(0,1fr)_22rem]"
    >
      <div
        className={`${pane === "list" ? "flex" : "hidden"} min-h-0 flex-col bg-white lg:flex lg:overflow-hidden lg:rounded-xl lg:border lg:border-zinc-200`}
      >
        <ConversationList
          items={items}
          selectedId={selectedId}
          view={query.view}
          botFilter={me.botRead}
          accountId={query.accountId}
          accounts={initial.accounts}
          searchText={searchText}
          searchHint={searchText.trim().length === 1}
          status={listStatus}
          hasMore={nextCursor !== null}
          offline={!online}
          onSelect={select}
          onView={(view) => applyQuery({ ...query, view })}
          onAccount={(accountId) => applyQuery({ ...query, accountId })}
          onSearch={onSearch}
          onLoadMore={loadMore}
          onRetry={retryList}
        />
      </div>

      <section
        aria-label="Conversation"
        className={`${pane === "chat" || pane === "details" ? "flex" : "hidden"} min-h-0 min-w-0 flex-col bg-white lg:flex lg:overflow-hidden lg:rounded-xl lg:border lg:border-zinc-200`}
      >
        {!selectedId ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-zinc-600">
            <div>
              <p className="text-base font-medium text-zinc-800">Select a conversation</p>
              <p className="mt-1">Choose one from the list to read it and reply.</p>
            </div>
          </div>
        ) : chat.notFound ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-zinc-700">
            <p className="text-base font-medium text-zinc-900">
              This conversation is not available
            </p>
            <p>It may have been removed, or you may not have access to it.</p>
            <button
              type="button"
              onClick={back}
              className="rounded-md px-3 py-1.5 text-sm ring-1 ring-zinc-300 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-emerald-700"
            >
              Back to the list
            </button>
          </div>
        ) : (
          <>
            <header className="flex items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2.5">
              <button
                type="button"
                onClick={back}
                className="rounded-md px-2 py-1 text-sm text-zinc-800 ring-1 ring-zinc-300 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-emerald-700 lg:hidden"
                aria-label="Back to conversations"
              >
                ← Back
              </button>
              {detail ? (
                <ContactAvatar
                  name={detail.contact.label.displayName}
                  named={detail.contact.label.named}
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-base font-semibold text-zinc-900">
                  {detail ? detail.contact.label.displayName : "Loading…"}
                </h1>
                {detail ? (
                  <p className="truncate text-xs text-zinc-600">
                    {STATUS_LABEL[detail.status]} ·{" "}
                    {detail.assignee ? detail.assignee.name : "Unassigned"} · {detail.account.label}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setPane(pane === "details" ? "chat" : "details")}
                aria-expanded={pane === "details"}
                className="rounded-md px-2.5 py-1 text-sm text-zinc-800 ring-1 ring-zinc-300 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-emerald-700 xl:hidden"
              >
                Details
              </button>
            </header>
            {!online ? (
              <p role="status" className="bg-amber-50 px-3 py-1.5 text-xs text-amber-950">
                You appear to be offline. Messages will refresh when the connection is back.
              </p>
            ) : null}
            {chat.error ? (
              <p role="alert" className="bg-amber-50 px-3 py-1.5 text-xs text-amber-950">
                {chat.error}
              </p>
            ) : null}
            {chat.loading || !detail ? (
              <p role="status" className="flex-1 p-6 text-sm text-zinc-600">
                Loading conversation…
              </p>
            ) : (
              <>
                <MessageTimeline
                  messages={messages}
                  hasOlder={olderCursor !== null}
                  loadingOlder={chat.loadingOlder}
                  newFromId={newFromId}
                  onLoadOlder={loadOlder}
                  onReply={quote}
                  canReply={detail.can.reply && detail.reply.canQueueText}
                  active={chatVisible}
                  onSeen={markSeen}
                />
                <Composer
                  key={detail.id}
                  conversationId={detail.id}
                  scope={{
                    userId: me.userId,
                    membershipId: me.membershipId,
                    organizationId: me.organizationId,
                  }}
                  can={detail.can}
                  reply={detail.reply}
                  replyTo={replyTo}
                  onClearReplyTo={() => setReplyTo(null)}
                  onChanged={afterChange}
                />
              </>
            )}
          </>
        )}
      </section>

      <div
        className={`${pane === "details" ? "flex" : "hidden"} z-20 min-h-0 flex-col bg-white max-xl:absolute max-xl:inset-0 max-xl:border-l max-xl:border-zinc-200 lg:max-xl:left-auto lg:max-xl:w-80 lg:max-xl:shadow-xl xl:flex xl:overflow-hidden xl:rounded-xl xl:border xl:border-zinc-200`}
      >
        {detail && selectedId ? (
          <DetailsPanel
            key={detail.id}
            detail={detail}
            meMembershipId={me.membershipId}
            pollTick={pollTick}
            onChanged={afterChange}
            onClose={() => setPane("chat")}
            leadPanel={<LeadPanel state={leadState} controller={leads} />}
          />
        ) : (
          <p className="p-6 text-sm text-zinc-600">
            Contact details appear here when you open a conversation.
          </p>
        )}
      </div>
    </main>
  );
}
