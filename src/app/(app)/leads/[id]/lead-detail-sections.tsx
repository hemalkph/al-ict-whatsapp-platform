"use client";

import { LockIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type {
  ConversationRef,
  LeadDetail,
  LeadEventView,
  OtherEvidenceView,
  TouchView,
} from "@/modules/leads";
import { fullTime } from "../../inbox/format";
import {
  RESERVED_STATUS_NOTE,
  SOURCE_EXPLANATION,
  eventText,
  isOpenStatus,
  originLabel,
  otherEvidenceLabel,
  sourceLabel,
  stateLabel,
  statusLabel,
} from "../lead-labels";
import {
  conversationStatusLabel,
  editNote,
  eventKindLabel,
  inboxConversationPath,
  latestOutsideList,
  lifecycleRows,
  linkedCountText,
  otherCountText,
  touchFacts,
} from "./lead-detail";

// The sections of the lead page. Presentation only: nothing here requests, changes or decides anything. Every text comes from
// the server's view (already cleaned and bounded) or from lead-labels.ts, and React renders all of it as text. Provider-controlled
// text (ad headline and body, ids, link text) is shown in a box labelled as unverified and is NEVER turned into a link, an image
// or markup. The only links on this page are to the lead list and to conversations in the Inbox, built from ids this page holds.

const CARD = "rounded-lg border border-zinc-200 bg-white p-4";
const H2 = "text-base font-semibold text-zinc-900";

function Time({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-zinc-600">Not recorded</span>;
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {fullTime(iso)}
    </time>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-zinc-600">{label}</dt>
      <dd className="min-w-0 break-words text-zinc-900">{children}</dd>
    </div>
  );
}

export function StatusBadge({ lead }: { lead: { status: string; readOnly: boolean } }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant={isOpenStatus(lead.status) ? "secondary" : "outline"}>
        {statusLabel(lead.status)}
      </Badge>
      {lead.readOnly ? (
        <span className="inline-flex items-center gap-1 text-xs text-zinc-700">
          <LockIcon aria-hidden="true" className="size-3" />
          Read-only
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------------------- summary
export function SummarySection({
  detail,
  className,
  statusControl,
}: {
  detail: LeadDetail;
  className?: string;
  /** The staff status control (07D-4); rendered under the status, where the read-only notes are. */
  statusControl?: ReactNode;
}) {
  const { lead } = detail;
  const note = editNote(lead, detail.can.edit);
  return (
    <section aria-labelledby="lead-summary" className={`${CARD} ${className ?? ""}`}>
      <h2 id="lead-summary" className={H2}>
        Lead summary
      </h2>
      <dl className="mt-3 flex flex-col gap-2 text-sm">
        <Row label="Status">
          <StatusBadge lead={lead} />
          {lead.readOnly ? (
            <p className="mt-1 text-xs text-zinc-700">{RESERVED_STATUS_NOTE}</p>
          ) : null}
          {note ? <p className="mt-1 text-xs text-zinc-700">{note}</p> : null}
          {statusControl}
        </Row>
        <Row label="State">{stateLabel(lead.open)}</Row>
        <Row label="How it started">{originLabel(lead.origin)}</Row>
        {lifecycleRows(lead).map((r) => (
          <Row key={r.label} label={r.label}>
            <Time iso={r.at} />
          </Row>
        ))}
        <Row label="Referral">
          <p>{sourceLabel(detail.attribution.source)}</p>
          <p className="mt-0.5 text-xs text-zinc-700">
            {SOURCE_EXPLANATION[detail.attribution.source.kind] ??
              "The referral information for this lead could not be interpreted."}
          </p>
        </Row>
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------- contact
export function ContactSection({ detail }: { detail: LeadDetail }) {
  const { contact } = detail;
  return (
    <section aria-labelledby="lead-contact" className={CARD}>
      <h2 id="lead-contact" className={H2}>
        Contact
      </h2>
      <dl className="mt-3 flex flex-col gap-2 text-sm">
        <Row label={contact.label.named ? "WhatsApp profile name" : "Name"}>
          {contact.label.displayName}
        </Row>
        <Row label="Last observed number">
          {contact.identity.lastObservedPhone ?? (
            <span className="text-zinc-600">Not recorded</span>
          )}
        </Row>
        <Row label="WhatsApp user ID">
          {contact.identity.bsuidTail ?? <span className="text-zinc-600">Not recorded</span>}
        </Row>
        <Row label="First seen">
          <Time iso={contact.firstSeenAt} />
        </Row>
        <Row label="Last seen">
          <Time iso={contact.lastSeenAt} />
        </Row>
        {contact.archived ? (
          <Row label="Contact">
            <Badge variant="outline">Archived</Badge>
          </Row>
        ) : null}
      </dl>
      <p className="mt-3 text-xs text-zinc-700">
        The name and number come from WhatsApp. They are not verified as a student&apos;s identity,
        and the number is the last one observed, not a confirmed current number.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------- conversations
export function ConversationsSection({
  conversations,
}: {
  conversations: readonly ConversationRef[];
}) {
  return (
    <section aria-labelledby="lead-conversations" className={CARD}>
      <h2 id="lead-conversations" className={H2}>
        Related conversations
      </h2>
      {conversations.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-700">
          No WhatsApp conversation is recorded for this contact.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2 text-sm">
          {conversations.map((c) => (
            <li key={c.id} className="rounded-md border border-zinc-200 p-2.5">
              <Link
                href={inboxConversationPath(c.id)}
                className="font-medium break-words text-emerald-800 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:outline-none"
              >
                Open in Inbox
                <span className="sr-only"> · conversation on {c.accountLabel}</span>
              </Link>
              <p className="mt-1 text-xs text-zinc-700">
                <span className="break-words">Business number {c.accountLabel}</span> ·{" "}
                {conversationStatusLabel(c.status)} · last message <Time iso={c.lastMessageAt} />
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------- evidence
function TouchCard({
  touch,
  note,
  tone = "linked",
}: {
  touch: TouchView;
  note?: string;
  tone?: "linked" | "other";
}) {
  const facts = touchFacts(touch);
  return (
    <li
      className={`rounded-md border p-3 text-sm ${tone === "other" ? "border-dashed border-zinc-300" : "border-zinc-200"}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant="secondary">{touch.label}</Badge>
        {touch.initiating ? <Badge variant="outline">Started this lead</Badge> : null}
        <span className="text-xs text-zinc-700">
          Received <Time iso={touch.receivedAt} />
        </span>
      </div>
      {note ? <p className="mt-1.5 text-xs font-medium text-zinc-800">{note}</p> : null}
      {touch.headline || touch.body ? (
        <div className="mt-2 rounded-md bg-zinc-50 p-2.5">
          <p className="text-xs text-zinc-700">Ad text as provided by Meta (not verified)</p>
          {touch.headline ? (
            <p dir="auto" className="mt-1 font-medium break-words text-zinc-900">
              {touch.headline}
            </p>
          ) : null}
          {touch.body ? (
            <p dir="auto" className="mt-1 break-words whitespace-pre-line text-zinc-800">
              {touch.body}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 text-xs text-zinc-700">No ad text was recorded for this referral.</p>
      )}
      {facts.length > 0 ? (
        <dl className="mt-2 flex flex-col gap-1 text-xs">
          {facts.map((f) => (
            <div key={f.label} className="grid gap-0.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
              <dt className="text-zinc-700">{f.label}</dt>
              <dd dir="auto" className="min-w-0 break-all text-zinc-900">
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

export function EvidenceSection({ detail, className }: { detail: LeadDetail; className?: string }) {
  const a = detail.attribution;
  const extraLatest = latestOutsideList(a.linked, a.linkedTotal, a.latest);
  return (
    <section aria-labelledby="lead-evidence" className={`${CARD} ${className ?? ""}`}>
      <h2 id="lead-evidence" className={H2}>
        Referral evidence
      </h2>
      <p className="mt-1 text-xs text-zinc-700">
        A recorded referral shows that WhatsApp reported an ad or link as the start of a chat. It
        does not confirm a registration, payment or marketing consent. Links are shown as text and
        are never opened from this page.
      </p>

      <h3 className="mt-4 text-sm font-semibold text-zinc-900">Evidence linked to this lead</h3>
      <p className="mt-1 text-sm text-zinc-700">
        {linkedCountText(a.linkedTotal, a.linked.length)}
      </p>
      {a.linked.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2" aria-label="Evidence linked to this lead">
          {a.linked.map((t) => (
            <TouchCard key={t.id} touch={t} />
          ))}
        </ul>
      ) : null}
      {extraLatest ? (
        <>
          <p className="mt-3 text-sm text-zinc-700">Most recent linked record:</p>
          <ul className="mt-2" aria-label="Most recent linked evidence">
            <TouchCard touch={extraLatest} />
          </ul>
        </>
      ) : null}

      <h3 className="mt-5 text-sm font-semibold text-zinc-900">
        Other evidence for this contact — not linked to this lead
      </h3>
      <p className="mt-1 text-sm text-zinc-700">
        {otherCountText(a.otherTotal, a.otherForContact.length)}
        {a.otherTotal > 0 ? " This is not evidence for this lead." : ""}
      </p>
      {a.otherForContact.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2" aria-label="Other evidence for this contact">
          {a.otherForContact.map((t: OtherEvidenceView) => (
            <TouchCard key={t.id} touch={t} tone="other" note={otherEvidenceLabel(t)} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ----------------------------------------------------------------------------------------------------------------- history
export function HistoryEvent({ event }: { event: LeadEventView }) {
  return (
    <li className="relative border-l border-zinc-300 pb-4 pl-4 last:border-l-transparent last:pb-0">
      <span
        aria-hidden="true"
        className="absolute top-1.5 -left-[4.5px] size-2 rounded-full bg-emerald-700"
      />
      <p className="text-sm break-words text-zinc-900">{eventText(event)}</p>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-700">
        <Badge variant="outline">{eventKindLabel(event.kind)}</Badge>
        <Time iso={event.at} />
      </p>
    </li>
  );
}
