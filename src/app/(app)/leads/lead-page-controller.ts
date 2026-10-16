import type { LeadItem, LeadPage } from "@/modules/leads";
import { isLeadPage } from "./[id]/lead-response";
import { ApiError } from "./lead-api";
import { describeLeadError, type LeadErrorInfo } from "./lead-errors";
import { filtersKey, type LeadFilters } from "./lead-filters";
import { appendPage, canLoadMore, emptyList, firstPage, type ListState } from "./lead-list";

// The Leads page's request lifecycle, outside React so every race can be tested deterministically (lead-page-controller.test.ts).
//
// ONE RULE: a response may change the screen only if it belongs to the request that is current NOW. Every request (a filter or
// search change, a refresh, a retry, "Load more") takes a new sequence number; starting a request, blocking the page (the
// signed-in account changed) and leaving the page (cancel) all advance the sequence, so every older request is stale from that
// moment. Its response is dropped even if it arrives (an aborted fetch can still resolve, and A -> B -> A gives the late first A
// the same filters as the current one). Aborting saves the work; the sequence check is what guarantees correctness. The 07D-1
// list guards still apply on top: a first page is applied for its own filter key, a next page only from the cursor it continued.
//
// Only one request is in flight at a time: a new filter, refresh or retry supersedes whatever is running (including a "Load
// more"), and "Load more" is refused while anything is running. Nothing retries by itself.

export type Phase = "ready" | "loading" | "refreshing" | "loading-more";

export type LeadsViewState = {
  readonly filters: LeadFilters;
  readonly list: ListState<LeadItem>;
  readonly phase: Phase;
  /** The last failure, and whether the first page or a next page failed (what Retry repeats). */
  readonly error: { readonly info: LeadErrorInfo; readonly during: "first" | "more" } | null;
  /** The signed-in account changed: nothing is requested or applied any more; the page must be reloaded. */
  readonly blocked: boolean;
};

export type FetchLeadPage = (
  filters: LeadFilters,
  options: { readonly cursor: string | null; readonly signal: AbortSignal },
) => Promise<LeadPage>;

export type LeadsController = {
  getState: () => LeadsViewState;
  subscribe: (listener: () => void) => () => void;
  /** Show another filter set: starts from its first page (no request if it asks the same question as now). */
  setFilters: (filters: LeadFilters) => void;
  /** Reload the first page of the current filters; the rows stay visible until the answer replaces them. */
  refresh: () => void;
  loadMore: () => void;
  retry: () => void;
  /** The signed-in account changed (ACTOR_CHANGED): stop for good. */
  block: () => void;
  /** Leaving the page: whatever is in flight is abandoned. */
  cancel: () => void;
};

export function createLeadsController(init: {
  readonly filters: LeadFilters;
  /** The first page the server rendered for these filters. */
  readonly page: LeadPage;
  readonly fetchPage: FetchLeadPage;
  /** The shared client's sticky "the account changed" flag. */
  readonly isActorChanged: () => boolean;
}): LeadsController {
  let state: LeadsViewState = {
    filters: init.filters,
    list: firstPage(filtersKey(init.filters), init.page),
    phase: "ready",
    error: null,
    blocked: false,
  };
  let sequence = 0;
  let running: AbortController | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Partial<LeadsViewState>) => {
    state = { ...state, ...next };
    listeners.forEach((l) => l());
  };

  /** Supersedes everything in flight. */
  const supersede = () => {
    sequence++;
    running?.abort();
    running = null;
  };

  const block = () => {
    if (state.blocked) return;
    supersede();
    set({ blocked: true, phase: "ready", error: null });
  };

  /** Starts a request: null when the page may not request anything (blocked, or the account changed meanwhile). */
  function begin(): { readonly mine: number; readonly signal: AbortSignal } | null {
    if (state.blocked) return null;
    if (init.isActorChanged()) {
      block();
      return null;
    }
    supersede();
    running = new AbortController();
    return { mine: sequence, signal: running.signal };
  }
  const isCurrent = (mine: number) => mine === sequence && !state.blocked;

  function fail(mine: number, error: unknown, during: "first" | "more") {
    if (!isCurrent(mine)) return;
    const info = describeLeadError(error, "read");
    if (info.kind === "aborted") return;
    if (info.kind === "actor_changed") return block();
    running = null;
    set({ phase: "ready", error: { info, during } });
  }

  function loadFirst(phase: "loading" | "refreshing") {
    const req = begin();
    if (!req) return;
    const filters = state.filters;
    const key = filtersKey(filters);
    set({ phase, error: null });
    init.fetchPage(filters, { cursor: null, signal: req.signal }).then(
      (page) => {
        if (!isCurrent(req.mine) || filtersKey(state.filters) !== key) return;
        // a 200 that is not a page of leads is a failed read (retryable); nothing of it is held
        if (!isLeadPage(page)) return fail(req.mine, new ApiError(200, "BAD_RESPONSE"), "first");
        running = null;
        set({ list: firstPage(key, page), phase: "ready", error: null });
      },
      (error: unknown) => fail(req.mine, error, "first"),
    );
  }

  function loadMore() {
    if (state.phase !== "ready" || !canLoadMore(state.list)) return;
    const from = state.list.nextCursor;
    const req = begin();
    if (!req) return;
    const key = state.list.key;
    set({ phase: "loading-more", error: null });
    init.fetchPage(state.filters, { cursor: from, signal: req.signal }).then(
      (page) => {
        if (!isCurrent(req.mine)) return;
        if (!isLeadPage(page)) return fail(req.mine, new ApiError(200, "BAD_RESPONSE"), "more");
        running = null;
        set({ list: appendPage(state.list, key, from, page), phase: "ready", error: null });
      },
      (error: unknown) => fail(req.mine, error, "more"),
    );
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setFilters(filters) {
      if (state.blocked) return;
      const key = filtersKey(filters);
      if (key === filtersKey(state.filters) && state.list.loaded && state.list.key === key) {
        set({ filters }); // the same question (e.g. a search that is still too short): nothing to fetch
        return;
      }
      set({ filters, list: emptyList(key) });
      loadFirst("loading");
    },
    refresh: () => loadFirst(state.list.loaded ? "refreshing" : "loading"),
    loadMore,
    retry() {
      if (state.error?.during === "more") {
        set({ error: null });
        loadMore();
      } else loadFirst(state.list.loaded ? "refreshing" : "loading");
    },
    block,
    cancel: supersede,
  };
}
