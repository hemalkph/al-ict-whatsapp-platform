"use client";

import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { LeadDetail } from "@/modules/leads";
import {
  changeLeadStatus,
  fetchContactLeads,
  fetchLeadDetail,
  fetchLeadEvents,
  getActorChanged,
  setPageActor,
  subscribeActorChanged,
} from "../lead-api";
import { canLoadMore } from "../lead-list";
import { createDetailController } from "./lead-detail-controller";
import { historyStatusText, leadPath } from "./lead-detail";
import { DEFAULT_FILTERS } from "../lead-filters";
import { LeadStatusControl } from "./lead-status-control";
import {
  ContactSection,
  ConversationsSection,
  EvidenceSection,
  HistoryEvent,
  StatusBadge,
  SummarySection,
} from "./lead-detail-sections";

// The interactive part of the lead page. The server rendered the lead for ONE actor; that actor is declared to the shared client
// before any request (a layout effect runs before every effect), so every request carries X-Expected-Actor, and the first refusal
// (409 ACTOR_CHANGED, seen by any request of this tab) blocks the controller and replaces the page with a notice. The controller
// (lead-detail-controller.ts) owns the request lifecycle: one current request, stale answers dropped, nothing retried by itself.
// A busy button is aria-disabled, not disabled, so a keyboard user's focus stays where it was while the request runs.
// There is no mutation on this page. The component is keyed by the lead's id by the server page, so a different lead never
// inherits this lead's state.

type Actor = { userId: string; organizationId: string; membershipId: string };
const OLDER_PAGE_SIZE = 20;

export function LeadDetailApp({
  initial,
  me,
  backHref,
}: {
  initial: LeadDetail;
  me: Actor;
  backHref: string;
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
    createDetailController({
      detail: initial,
      fetchDetail: (leadId, { signal }) => fetchLeadDetail(leadId, { signal }),
      fetchEvents: (leadId, { cursor, signal }) =>
        fetchLeadEvents(leadId, { cursor, limit: OLDER_PAGE_SIZE, signal }),
      changeStatus: (leadId, change, { signal }) => changeLeadStatus(leadId, change, { signal }),
      fetchContactLeads: (contactId, { signal }) => fetchContactLeads(contactId, { signal }),
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

  // The "Load older events" button disappears with the last page, and a keyboard user's focus would fall back to the top of the
  // page. When that happens, focus moves into the history instead (only if focus really was lost).
  const more = canLoadMore(state.history);
  const historyRef = useRef<HTMLOListElement>(null);
  const hadMore = useRef(more);
  useEffect(() => {
    if (hadMore.current && !more && document.activeElement === document.body)
      historyRef.current?.focus();
    hadMore.current = more;
  }, [more]);

  const back = (
    <Link
      href={backHref}
      className="inline-flex w-fit items-center gap-1 rounded-sm text-sm font-medium text-emerald-800 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:outline-none"
    >
      <ArrowLeftIcon aria-hidden="true" className="size-4" />
      Back to leads
    </Link>
  );

  if (state.blocked)
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <div
          role="alert"
          className="max-w-md rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p className="text-base font-semibold">Your signed-in account has changed.</p>
          <p className="mt-2">
            This page was opened for a previous session, so it has stopped and the lead is no longer
            shown. A change you submitted just before this may already have been saved: this page
            cannot tell. Reload to see what your current account can access.
          </p>
          <Button className="mt-3" onClick={() => window.location.reload()}>
            Reload as the current account
          </Button>
        </div>
      </main>
    );

  if (state.unavailable)
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4 sm:p-6">
        {back}
        <h1 className="text-xl font-semibold text-zinc-900">Lead not available</h1>
        <p role="alert" className="text-sm text-zinc-700">
          This lead or contact is not available.
        </p>
      </main>
    );

  const { detail, history, phase, error } = state;
  const { lead } = detail;
  const busy = phase !== "ready";
  const signInHref = `/login?next=${encodeURIComponent(`/leads/${lead.id}`)}`;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold break-words text-zinc-900">
            {lead.contact.label.displayName}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge lead={lead} />
            {lead.contact.label.idHint ? (
              <span className="text-xs text-zinc-700">{lead.contact.label.idHint}</span>
            ) : null}
          </div>
          <p className="mt-1.5 max-w-2xl text-sm text-zinc-700">
            {lead.contact.label.named
              ? "The name comes from the customer's WhatsApp profile and is not verified."
              : "This customer has no WhatsApp profile name."}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => !busy && controller.refresh()}
          aria-disabled={busy}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          <RefreshCwIcon aria-hidden="true" />
          Refresh
        </Button>
      </header>

      <p role="status" aria-live="polite" className="min-h-5 text-sm text-zinc-700">
        {phase === "refreshing" ? "Refreshing lead…" : ""}
      </p>

      {error?.during === "refresh" && !state.status.needsRead ? (
        <Alert variant={error.info.next === "retry" ? "default" : "destructive"}>
          <AlertTitle>The lead could not be refreshed</AlertTitle>
          <AlertDescription>
            <p>{error.info.message} What is shown below may be out of date.</p>
            <ErrorAction
              info={error.info}
              onRetry={() => controller.retry()}
              signInHref={signInHref}
            />
          </AlertDescription>
        </Alert>
      ) : null}

      {/* One explicit minmax(0,1fr) column on phones: an implicit column is sized by its widest content (it grew to 363px at
          320px wide), so long provider text pushed the cards past the viewport instead of wrapping. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
        <SummarySection
          detail={detail}
          className="lg:col-start-1"
          statusControl={
            <LeadStatusControl
              state={state}
              controller={controller}
              signInHref={signInHref}
              openLeadHref={(id) => leadPath(id, DEFAULT_FILTERS)}
            />
          }
        />
        <aside
          aria-label="Contact and conversations"
          className="flex flex-col gap-4 lg:col-start-2 lg:row-span-3 lg:row-start-1"
        >
          <ContactSection detail={detail} />
          <ConversationsSection conversations={detail.conversations} />
        </aside>
        <EvidenceSection detail={detail} className="lg:col-start-1" />

        <section
          aria-labelledby="lead-history"
          aria-busy={phase === "loading-older"}
          className="rounded-lg border border-zinc-200 bg-white p-4 lg:col-start-1"
        >
          <h2 id="lead-history" className="text-base font-semibold text-zinc-900">
            Lead history
          </h2>
          <p className="mt-1 text-xs text-zinc-700">Newest first, as recorded.</p>
          <p role="status" aria-live="polite" className="mt-2 text-sm text-zinc-700">
            {phase === "loading-older"
              ? "Loading older events…"
              : error?.during === "older"
                ? ""
                : historyStatusText(history.items.length, more)}
          </p>
          {history.items.length > 0 ? (
            <ol
              ref={historyRef}
              tabIndex={-1}
              className="mt-3 ml-1 rounded-sm focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:outline-none"
              aria-label="Lead history, newest first"
            >
              {history.items.map((e) => (
                <HistoryEvent key={e.id} event={e} />
              ))}
            </ol>
          ) : null}
          {error?.during === "older" ? (
            <Alert
              className="mt-3"
              variant={error.info.next === "retry" ? "default" : "destructive"}
            >
              <AlertTitle>Older events could not be loaded</AlertTitle>
              <AlertDescription>
                <p>{error.info.message}</p>
                <ErrorAction
                  info={error.info}
                  onRetry={() => controller.retry()}
                  signInHref={signInHref}
                />
              </AlertDescription>
            </Alert>
          ) : null}
          {more ? (
            <Button
              variant="outline"
              className="mt-3 aria-disabled:pointer-events-none aria-disabled:opacity-50"
              onClick={() => !busy && controller.loadOlder()}
              aria-disabled={busy}
            >
              {phase === "loading-older" ? "Loading…" : "Load older events"}
            </Button>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function ErrorAction({
  info,
  onRetry,
  signInHref,
}: {
  info: { next: string };
  onRetry: () => void;
  signInHref: string;
}) {
  if (info.next === "retry")
    return (
      <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
        Try again
      </Button>
    );
  if (info.next === "sign-in")
    return (
      <Link className="mt-2 inline-block font-medium underline" href={signInHref}>
        Sign in again
      </Link>
    );
  if (info.next === "reload-page")
    return (
      <Button variant="outline" size="sm" className="mt-2" onClick={() => window.location.reload()}>
        Reload the page
      </Button>
    );
  return null;
}
