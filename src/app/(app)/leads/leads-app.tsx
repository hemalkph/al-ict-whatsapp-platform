"use client";

import { RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { LeadPage } from "@/modules/leads";
import { fetchLeadPage, getActorChanged, setPageActor, subscribeActorChanged } from "./lead-api";
import { LeadFilterToolbar } from "./lead-filter-toolbar";
import {
  DEFAULT_FILTERS,
  checkSearch,
  filtersKey,
  leadFiltersToSearch,
  parseLeadFilters,
  type LeadFilters,
} from "./lead-filters";
import { SOURCE_EXPLANATION } from "./lead-labels";
import { canLoadMore } from "./lead-list";
import { createLeadsController } from "./lead-page-controller";
import { LeadTable, LeadTableSkeleton } from "./lead-table";

// The interactive part of the Leads page. The URL is the single source of truth for the filters: every choice is pushed as a new
// history entry (so Back and Forward restore it), useSearchParams reports the change, and the controller fetches. The controller
// (lead-page-controller.ts) owns the request lifecycle: one current request, stale answers dropped, nothing retried by itself.
//
// The page acts for ONE actor, the one the server rendered it for. That actor is declared to the shared client before any request
// (a layout effect runs before every effect), so every request carries X-Expected-Actor; the first refusal (409 ACTOR_CHANGED,
// seen by any request of this tab) blocks the controller and replaces the page with a notice. Nothing of the old view stays.

type Actor = { userId: string; organizationId: string; membershipId: string };
const SEARCH_DEBOUNCE_MS = 350;

export function LeadsApp({
  initial,
  me,
}: {
  initial: { filters: LeadFilters; page: LeadPage };
  me: Actor;
}) {
  useLayoutEffect(() => {
    setPageActor({
      userId: me.userId,
      organizationId: me.organizationId,
      membershipId: me.membershipId,
    });
    return () => setPageActor(null);
  }, [me.userId, me.organizationId, me.membershipId]);

  const [controller] = useState(() =>
    createLeadsController({
      filters: initial.filters,
      page: initial.page,
      fetchPage: (filters, { cursor, signal }) => fetchLeadPage(filters, { cursor, signal }),
      isActorChanged: getActorChanged,
    }),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const actorChanged = useSyncExternalStore(subscribeActorChanged, getActorChanged, () => false);
  useEffect(() => {
    if (actorChanged) controller.block();
  }, [actorChanged, controller]);
  useEffect(() => () => controller.cancel(), [controller]); // leaving the page abandons whatever is in flight

  // ------------------------------------------------------------------------------------------------- URL <-> filters
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const urlFilters = useMemo(() => parseLeadFilters(new URLSearchParams(search)), [search]);
  useEffect(() => controller.setFilters(urlFilters), [urlFilters, controller]);
  useEffect(() => {
    // a messy URL (unknown or unsupported values, repeats) is shown in its canonical form once
    const canonical = leadFiltersToSearch(urlFilters);
    if (window.location.search !== canonical)
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${canonical}`,
      );
  }, [urlFilters]);

  const filtersRef = useRef(urlFilters);
  useEffect(() => {
    filtersRef.current = urlFilters;
  });
  const go = (next: LeadFilters) => {
    const target = leadFiltersToSearch(next);
    if (target === leadFiltersToSearch(filtersRef.current)) return; // the same canonical URL: no new history entry
    window.history.pushState(null, "", `${window.location.pathname}${target}`);
  };

  // ------------------------------------------------------------------------------------------------------- search
  // The box shows what is typed; the URL holds what is searched. A too-short draft stays visible but is not searched (the hint
  // says so). Back/Forward put the searched text back into the box.
  const [draft, setDraft] = useState(urlFilters.q);
  useEffect(() => {
    const onPop = () => setDraft(parseLeadFilters(new URLSearchParams(window.location.search)).q);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      const q = checkSearch(draft).value;
      if (q !== filtersRef.current.q) go({ ...filtersRef.current, q });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t); // `go` reads the filters from a ref: only the draft starts a new wait
  }, [draft]);

  // ----------------------------------------------------------------------------------------------------- rendering
  if (state.blocked)
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <div
          role="alert"
          className="max-w-md rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p className="text-base font-semibold">Your signed-in account has changed.</p>
          <p className="mt-2">
            This page was opened for a previous session, so it has stopped and its leads are no
            longer shown. Nothing was changed.
          </p>
          <Button className="mt-3" onClick={() => window.location.reload()}>
            Reload as the current account
          </Button>
        </div>
      </main>
    );

  const { list, phase, error } = state;
  const filtered = filtersKey(state.filters) !== filtersKey(DEFAULT_FILTERS);
  const busy = phase !== "ready";
  const status =
    phase === "loading"
      ? "Loading leads…"
      : phase === "refreshing"
        ? "Refreshing leads…"
        : phase === "loading-more"
          ? "Loading more leads…"
          : error
            ? ""
            : list.loaded
              ? list.items.length === 0
                ? "No leads to show."
                : `${list.items.length} ${list.items.length === 1 ? "lead" : "leads"} shown${canLoadMore(list) ? ", more can be loaded" : ""}.`
              : "";

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-zinc-900">Leads</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-600">
            Your organization&apos;s leads, newest first. Names come from customers&apos; WhatsApp
            profiles and are not verified.
          </p>
        </div>
        <Button variant="outline" onClick={() => controller.refresh()} disabled={busy}>
          <RefreshCwIcon aria-hidden="true" />
          Refresh
        </Button>
      </header>

      <LeadFilterToolbar
        filters={state.filters}
        draft={draft}
        disabled={false}
        onDraftChange={setDraft}
        onChange={(next) => {
          if (next.q !== state.filters.q) setDraft(next.q);
          go(next);
        }}
      />

      <p role="status" aria-live="polite" className="text-sm text-zinc-600">
        {status}
      </p>

      {error ? (
        <Alert variant={error.info.next === "retry" ? "default" : "destructive"}>
          <AlertTitle>
            {error.during === "more"
              ? "More leads could not be loaded"
              : "Leads could not be loaded"}
          </AlertTitle>
          <AlertDescription>
            <p>{error.info.message}</p>
            {error.info.next === "retry" ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => controller.retry()}
              >
                Try again
              </Button>
            ) : error.info.next === "sign-in" ? (
              <Link className="mt-2 inline-block font-medium underline" href="/login?next=/leads">
                Sign in again
              </Link>
            ) : error.info.next === "reload-page" ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => window.location.reload()}
              >
                Reload the page
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {!list.loaded ? (
        phase === "loading" ? (
          <LeadTableSkeleton />
        ) : null
      ) : list.items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center">
          {filtered ? (
            <>
              <p className="font-medium text-zinc-900">No leads match these filters.</p>
              <Button
                variant="outline"
                className="mt-3"
                onClick={() => {
                  setDraft("");
                  go(DEFAULT_FILTERS);
                }}
              >
                Reset filters
              </Button>
            </>
          ) : (
            <>
              <p className="font-medium text-zinc-900">No leads yet.</p>
              <p className="mt-1 text-sm text-zinc-600">
                Leads appear here when staff create them or when a Meta ad referral is matched to a
                contact.
              </p>
            </>
          )}
        </div>
      ) : (
        <LeadTable items={list.items} busy={busy} filters={state.filters} />
      )}

      {list.loaded && canLoadMore(list) ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => controller.loadMore()} disabled={busy}>
            {phase === "loading-more" ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}

      <p className="text-xs text-zinc-600">
        <span className="font-medium">About the source column.</span> {SOURCE_EXPLANATION.META_AD}{" "}
        {SOURCE_EXPLANATION.NONE}
      </p>
    </main>
  );
}
