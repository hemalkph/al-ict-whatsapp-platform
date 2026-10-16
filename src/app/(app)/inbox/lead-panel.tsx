"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { LeadItem } from "@/modules/leads";
import { leadPath } from "../leads/[id]/lead-detail";
import { DEFAULT_FILTERS } from "../leads/lead-filters";
import { isOpenStatus, sourceLabel, stateLabel, statusLabel } from "../leads/lead-labels";
import { fullTime } from "./format";
import type { CreateNotice, LeadPanelController, LeadPanelState } from "./lead-panel-controller";

// The Inbox's compact "Lead information" section (Phase 07D-5), under Contact in the details panel. It SHOWS the contact's leads
// and offers one action, "Create lead". Status changes stay on the lead page (07D-4): this panel has no status control, so there
// is only one place that applies those rules. Every lead link is built from an id the server returned for this contact.
// Busy buttons are aria-disabled (not disabled) so keyboard focus stays where it was.

const focus =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-700";
const heading = "text-xs font-semibold uppercase tracking-wide text-zinc-600";
const link = `rounded-sm font-medium text-emerald-800 underline underline-offset-2 ${focus}`;
/** GET /api/leads/for-contact returns at most this many leads, newest first (src/modules/leads/for-contact.ts). */
const LISTED_AT_MOST = 10;

const leadHref = (id: string) => leadPath(id, DEFAULT_FILTERS);
const when = (iso: string) => (
  <time dateTime={iso} suppressHydrationWarning>
    {fullTime(iso)}
  </time>
);

function LeadSummary({ lead }: { lead: LeadItem }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={isOpenStatus(lead.status) ? "secondary" : "outline"}>
          {statusLabel(lead.status)}
        </Badge>
        <span className="text-xs text-zinc-700">{stateLabel(lead.open)}</span>
        {lead.readOnly ? <span className="text-xs text-zinc-700">· Read-only</span> : null}
      </div>
      <p className="text-xs text-zinc-700">
        Created {when(lead.createdAt)} · {sourceLabel(lead.source)}
      </p>
    </div>
  );
}

function NoticeText({ notice, needsRead }: { notice: CreateNotice; needsRead: boolean }) {
  switch (notice.kind) {
    case "created":
      return (
        <>
          A new lead was created for this contact. It is an internal record only: no WhatsApp
          message was sent.{" "}
          <Link className={link} href={leadHref(notice.leadId)}>
            Open the new lead
          </Link>
        </>
      );
    case "existing":
      return (
        <>
          An open lead already exists for this contact, so no new lead was created.{" "}
          <Link className={link} href={leadHref(notice.leadId)}>
            Open the existing lead
          </Link>
        </>
      );
    case "unknown":
      return (
        <>
          We could not confirm whether the lead was created. The request was not repeated.{" "}
          {needsRead
            ? "Checking this contact's leads…"
            : "The leads below were read again. If no new lead is shown, the request may still be completing; creating again cannot make a second open lead."}
        </>
      );
    case "refused":
      return <>{notice.info.message}</>;
  }
}

export function LeadPanel({
  state,
  controller,
}: {
  state: LeadPanelState;
  controller: LeadPanelController;
}) {
  const { data, phase, readError, creating, notice, needsRead } = state;
  const loading = phase === "loading";
  const noticeRef = useRef<HTMLDivElement>(null);
  const fromButton = useRef(false);
  // The Create button disappears once the contact has an open lead: focus moves to the outcome instead of being lost.
  useEffect(() => {
    if (notice && fromButton.current) {
      fromButton.current = false;
      noticeRef.current?.focus();
    }
  }, [notice]);

  const open = data?.openLead ?? null;
  const previous = data?.leads.filter((l) => l.id !== open?.id) ?? [];
  const blockedCreate = creating || needsRead || loading;

  return (
    <section
      aria-labelledby="inbox-lead-heading"
      aria-busy={loading}
      className="border-b border-zinc-200 px-4 py-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id="inbox-lead-heading" className={heading}>
          Lead information
        </h3>
        <button
          type="button"
          onClick={() => !loading && controller.refresh()}
          aria-disabled={loading}
          className={`rounded-md px-2 py-1 text-xs text-zinc-800 ring-1 ring-zinc-300 hover:bg-zinc-50 aria-disabled:opacity-60 ${focus}`}
        >
          Refresh<span className="sr-only"> lead information</span>
        </button>
      </div>
      <div className="mt-2 flex flex-col gap-2 text-sm text-zinc-800">
        <p role="status" aria-live="polite" className="text-xs text-zinc-600 empty:hidden">
          {loading ? "Loading lead information…" : creating ? "Creating a lead…" : ""}
        </p>

        {notice ? (
          <div
            ref={noticeRef}
            tabIndex={-1}
            role={notice.kind === "created" || notice.kind === "existing" ? "status" : "alert"}
            className={`rounded-md p-2 text-xs ${notice.kind === "created" || notice.kind === "existing" ? "bg-emerald-50 text-emerald-950" : "bg-amber-50 text-amber-950"} ${focus}`}
          >
            <NoticeText notice={notice} needsRead={needsRead} />
          </div>
        ) : null}

        {readError ? (
          <div role="alert" className="rounded-md bg-amber-50 p-2 text-xs text-amber-950">
            <p className="font-medium">Lead information could not be loaded.</p>
            <p className="mt-0.5">
              {readError.kind === "not_found"
                ? "Lead information is not available for this contact."
                : readError.message}
              {data ? " What is shown below may be out of date." : ""}
            </p>
            {readError.next === "retry" ? (
              <button
                type="button"
                onClick={() => controller.refresh()}
                className={`mt-1.5 rounded-md px-2 py-1 ring-1 ring-amber-400 hover:bg-amber-100 ${focus}`}
              >
                Try again
              </button>
            ) : readError.next === "sign-in" ? (
              <Link className={`mt-1.5 inline-block ${link}`} href="/login?next=%2Finbox">
                Sign in again
              </Link>
            ) : null}
          </div>
        ) : null}

        {data ? (
          <>
            {open ? (
              <div className="rounded-md p-2.5 ring-1 ring-zinc-200">
                <p className="mb-1 text-xs font-medium text-zinc-700">Open lead</p>
                <LeadSummary lead={open} />
                <Link
                  className={`mt-0.5 inline-block py-1 text-xs ${link}`}
                  href={leadHref(open.id)}
                  aria-label={`View lead (open, ${statusLabel(open.status)})`}
                >
                  View lead
                </Link>
              </div>
            ) : (
              <p className="text-zinc-700">
                {data.leads.length === 0
                  ? "No lead has been recorded for this contact."
                  : "This contact has no open lead."}
              </p>
            )}

            {previous.length > 0 ? (
              <div>
                <p className="text-xs font-medium text-zinc-700">Previous leads</p>
                <ul className="mt-1 flex flex-col gap-1.5" aria-label="Previous leads">
                  {previous.map((l) => (
                    <li key={l.id} className="rounded-md p-2 ring-1 ring-zinc-200">
                      <LeadSummary lead={l} />
                      <Link
                        className={`inline-block py-1 text-xs ${link}`}
                        href={leadHref(l.id)}
                        aria-label={`View lead (${statusLabel(l.status)}, created ${fullTime(l.createdAt)})`}
                      >
                        View lead
                      </Link>
                    </li>
                  ))}
                </ul>
                {data.leads.length >= LISTED_AT_MOST ? (
                  <p className="mt-1 text-xs text-zinc-600">
                    Only the {LISTED_AT_MOST} most recent leads are listed here. The Leads page
                    lists all of them.
                  </p>
                ) : null}
              </div>
            ) : null}

            {data.can.create ? (
              <div className="flex flex-col gap-1.5">
                <Button
                  size="sm"
                  className="self-start aria-disabled:pointer-events-none aria-disabled:opacity-50"
                  aria-disabled={blockedCreate}
                  onClick={() => {
                    if (blockedCreate) return;
                    fromButton.current = true;
                    controller.create();
                  }}
                >
                  {creating ? "Creating lead…" : "Create lead"}
                </Button>
                <p className="text-xs text-zinc-600">
                  Creates an internal lead record. It does not message the customer, register a
                  student, or record a payment or marketing consent.
                </p>
              </div>
            ) : open ? null : data.contact.archived ? (
              <p className="text-xs text-zinc-700">
                This contact is archived, so a lead cannot be created for it.
              </p>
            ) : (
              <p className="text-xs text-zinc-700">
                Your role can view leads but cannot create them.
              </p>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}
