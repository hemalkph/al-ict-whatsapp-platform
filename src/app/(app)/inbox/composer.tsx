"use client";

import { useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import type { ConversationDetail } from "@/modules/inbox";
import { ApiError } from "./api";
import { acceptedNotice, refusalReason, replyBlockedText } from "./labels";
import {
  acknowledgeExpired,
  capacityProblem,
  dismissPending,
  snapshotFor,
  startSend,
  submitPending,
  subscribe,
  type CapacityProblem,
  type ExpiredView,
  type OpView,
  type PendingOp,
  type Scope,
  type SendOutcome,
} from "./pending-send";
import { ConfirmDialog } from "./confirm-dialog";
import { QuickReplyPicker } from "./quick-replies";

type Props = {
  conversationId: string;
  scope: Scope;
  can: ConversationDetail["can"];
  reply: ConversationDetail["reply"];
  replyTo: { id: string; preview: string } | null;
  onClearReplyTo: () => void;
  /** Called after the server answered (or the answer is unknown), so the timeline refreshes. */
  onChanged: () => void;
};

const MAX = 4096;

type Notice = { kind: "ok" | "warning" | "error"; text: string } | null;

/**
 * Staff reply composer. It talks ONLY to the Phase 05 send endpoint, and only through pending-send.ts: there is no other send
 * path, the browser never contacts Meta, and "Queued" is never described as sent or delivered.
 *
 * Pressing Send FREEZES the message (text, reply target, a fresh idempotency key) into a pending operation (pending-send.ts) and
 * empties the draft. From then on the operation, not the textarea, is the source of truth: whatever the staff member types next
 * is a new draft that no result can erase. If the answer cannot be established (network failure, timeout, 5xx, a success whose
 * body cannot be read or does not match the contract) the operation stays on screen, survives navigation and reload, and can only
 * be re-submitted unchanged (same key, same text) by an explicit click; the server's idempotency returns the existing request.
 */
export function Composer({
  conversationId,
  scope,
  can,
  reply,
  replyTo,
  onClearReplyTo,
  onChanged,
}: Props) {
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [picker, setPicker] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const draft = useRef("");
  const view = useSyncExternalStore(
    subscribe,
    () => snapshotFor(scope, conversationId),
    () => null,
  );

  // New messages are refused (before anything is sent) when the device's record of unconfirmed messages is full or cannot be
  // verified; nothing is ever evicted to make room, so the person is told, not silently let through.
  const problem = useSyncExternalStore(
    subscribe,
    () => capacityProblem(scope),
    () => null,
  );

  const typed = text.trim();
  const blocked = !can.reply || !reply.outboundEnabled;
  const canSend =
    !blocked &&
    reply.canQueueText &&
    typed.length > 0 &&
    typed.length <= MAX &&
    view === null &&
    problem === null;

  function changeDraft(value: string) {
    draft.current = value;
    setText(value);
  }

  async function run(op: PendingOp) {
    setNotice(null);
    finish(op, await submitPending(op));
  }

  function finish(op: PendingOp, outcome: SendOutcome) {
    onChanged();
    if (outcome.kind === "accepted") {
      setNotice(acceptedNotice(outcome.state, outcome.replayed));
    } else if (outcome.kind === "uncertain" || outcome.kind === "actor_changed") {
      setNotice(null); // the pending panel explains it (and, after a change of account, the whole page stops: see InboxApp)
    } else if (outcome.kind === "inconclusive") {
      setNotice({
        kind: "warning",
        text: `${inconclusiveText(outcome.error)} Your earlier message may still have been queued; it was not cancelled.`,
      });
    } else if (draft.current.trim() === "") {
      changeDraft(op.body); // nothing newer was typed: give the text back
      setNotice({ kind: "error", text: errorText(outcome.error) });
    } else {
      // The staff member already started something new: it is left alone, and the refused text is shown so it is not lost.
      setNotice({
        kind: "error",
        text: `${errorText(outcome.error)} The message was: “${op.body}”`,
      });
    }
  }

  function send(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend) return;
    const started = startSend(scope, conversationId, typed, replyTo?.id ?? null);
    if (started.kind === "blocked") {
      // nothing was created or sent: the draft stays exactly as typed
      if (started.reason === "capacity")
        setNotice({ kind: "error", text: capacityText(started.problem) });
      return; // "existing": an operation is already unresolved (double click)
    }
    changeDraft("");
    onClearReplyTo();
    void run(started.view.op);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
  }

  function insert(snippet: string) {
    changeDraft(
      draft.current.trim() ? `${draft.current.replace(/\s+$/, "")}\n${snippet}` : snippet,
    );
    setPicker(false);
    requestAnimationFrame(() => area.current?.focus());
  }

  if (!can.reply) {
    return (
      <div className="border-t border-zinc-200 bg-white p-3 text-sm text-zinc-700">
        You have read-only access, so you cannot send replies.
      </div>
    );
  }

  return (
    <div className="relative border-t border-zinc-200 bg-white p-3">
      {view && view.expired ? (
        <ExpiredPanel view={view} onAllow={() => setConfirm(true)} />
      ) : view ? (
        <PendingPanel
          view={view}
          onCheck={() => void run(view.op)}
          onDismiss={() => setConfirm(true)}
        />
      ) : null}
      {confirm && view && !view.expired ? (
        <ConfirmDialog
          title="Stop tracking this message?"
          keepLabel="Keep tracking this message"
          confirmLabel="Stop tracking anyway"
          onKeep={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            dismissPending(view.op);
          }}
        >
          <p>
            <strong>This does not cancel the message.</strong> It may already have been queued or
            sent to the customer.
          </p>
          <p>
            Once you stop tracking it, this page forgets the reference that stops a repeat from
            creating a second copy.
          </p>
          <p>Sending the same or similar text again may create a duplicate message.</p>
        </ConfirmDialog>
      ) : null}
      {confirm && view && view.expired ? (
        <ConfirmDialog
          title="Allow a new message?"
          keepLabel="Keep the warning"
          confirmLabel="Allow a new message"
          onKeep={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            acknowledgeExpired(scope, conversationId);
          }}
        >
          <p>
            <strong>
              {view.conflict
                ? "This record does not cancel the earlier request."
                : "Expiry does not cancel the earlier request."}
            </strong>{" "}
            It may still exist and the message may already have been sent.
          </p>
          <p>
            {view.conflict
              ? "Conflicting local records were found, so it cannot be reconciled from this browser record. A supervisor or operator may need to investigate."
              : "The original text is no longer available on this device."}
          </p>
          <p>A new message could be a duplicate. Check the conversation first.</p>
        </ConfirmDialog>
      ) : null}
      {problem && !view ? (
        <p role="alert" className="mb-2 rounded-md bg-amber-50 p-2 text-sm text-amber-950">
          {capacityText(problem)}
        </p>
      ) : null}
      <form onSubmit={send}>
        {!reply.outboundEnabled ? (
          <p role="note" className="mb-2 rounded-md bg-amber-50 p-2 text-sm text-amber-950">
            {replyBlockedText("outbound_disabled")}
          </p>
        ) : !reply.canQueueText ? (
          <p role="note" className="mb-2 rounded-md bg-amber-50 p-2 text-sm text-amber-950">
            {replyBlockedText(reply.reason)}
          </p>
        ) : reply.windowClosesAt ? (
          <p className="mb-2 text-xs text-zinc-600">
            You can reply until{" "}
            <time dateTime={reply.windowClosesAt} suppressHydrationWarning>
              {new Date(reply.windowClosesAt).toLocaleString([], {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </time>
            . A reply is queued first, then sent; its status shows under the message.
          </p>
        ) : null}

        {replyTo ? (
          <div className="mb-2 flex items-start justify-between gap-2 rounded-md border-l-4 border-emerald-600 bg-zinc-100 px-2 py-1 text-xs text-zinc-700">
            <span className="min-w-0 truncate">Replying to: {replyTo.preview}</span>
            <button
              type="button"
              onClick={onClearReplyTo}
              className="shrink-0 rounded px-1 underline focus-visible:outline-2 focus-visible:outline-emerald-700"
              aria-label="Cancel reply to this message"
            >
              Cancel
            </button>
          </div>
        ) : null}

        <label htmlFor="composer-text" className="sr-only">
          Message to the customer
        </label>
        <textarea
          id="composer-text"
          ref={area}
          value={text}
          onChange={(e) => changeDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!reply.outboundEnabled}
          maxLength={MAX}
          rows={3}
          placeholder={
            reply.outboundEnabled
              ? "Type a reply (Ctrl/⌘ + Enter to queue)"
              : "Sending is switched off"
          }
          className="w-full resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm placeholder:text-zinc-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-700 disabled:bg-zinc-100"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="relative flex items-center gap-2">
            <button
              type="button"
              aria-expanded={picker}
              onClick={() => setPicker((v) => !v)}
              disabled={!reply.outboundEnabled}
              className="rounded-md px-3 py-1.5 text-sm text-zinc-800 ring-1 ring-zinc-300 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-50"
            >
              Quick replies
            </button>
            {typed.length > MAX - 300 ? (
              <span className="text-xs text-zinc-600">
                {typed.length}/{MAX}
              </span>
            ) : null}
          </div>
          <button
            type="submit"
            disabled={!canSend}
            className="rounded-md bg-emerald-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-700"
          >
            {view && !view.expired && view.inFlight ? "Queuing…" : "Send reply"}
          </button>
        </div>
        <div aria-live="polite" className="mt-2 min-h-5">
          {notice ? (
            <p
              role={notice.kind === "ok" ? "status" : "alert"}
              className={`text-sm break-words whitespace-pre-wrap ${notice.kind === "ok" ? "text-emerald-900" : notice.kind === "warning" ? "text-amber-950" : "text-red-800"}`}
            >
              {notice.text}
            </p>
          ) : null}
        </div>
      </form>
      {/* Outside the form on purpose: the picker has forms of its own, and forms cannot be nested. */}
      {picker ? (
        <QuickReplyPicker
          canManage={can.manage}
          onInsert={insert}
          onClose={() => setPicker(false)}
        />
      ) : null}
    </div>
  );
}

function capacityText(problem: CapacityProblem): string {
  switch (problem) {
    case "full":
      return "This browser tab is already tracking 200 messages whose result could not be confirmed, which is the most it can keep safe. New messages cannot be sent from it until some are resolved (open those conversations and use Check again, or confirm you have checked them). Nothing was sent and nothing was deleted.";
    case "overfull":
      return "This browser tab holds more unconfirmed messages than the 200 it is built to track. Every record has been kept, but new messages cannot be sent from this tab until some are resolved (open those conversations and use Check again, or confirm you have checked them). Nothing was sent and nothing was deleted.";
    default:
      return "The record of unconfirmed messages on this device could not be fully inspected, so new messages cannot be sent from this tab: a repeat could create a duplicate. Close this tab and open the inbox again. Nothing was sent.";
  }
}

function ExpiredPanel({ view, onAllow }: { view: ExpiredView; onAllow: () => void }) {
  return (
    <section
      aria-label="Earlier message submission that could not be confirmed"
      role="alert"
      className="mb-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950"
    >
      {view.conflict ? (
        <>
          <p className="font-semibold">
            Conflicting local records were found for an earlier message submission. The original
            submission cannot be safely reconciled from this browser record.
          </p>
          <p className="mt-1">
            The newest of them dates from{" "}
            <time dateTime={new Date(view.createdAt).toISOString()} suppressHydrationWarning>
              {new Date(view.createdAt).toLocaleString([], {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </time>
            . A message may already have been queued or sent, and a new submission could produce a
            duplicate. This record does not cancel anything, and no text is kept. Check the
            conversation before sending anything similar; a supervisor or operator may need to
            investigate.
          </p>
        </>
      ) : (
        <>
          <p className="font-semibold">
            An earlier message submission could not be confirmed.{" "}
            {view.unreadable
              ? "This device's record of it could not be read, but the original request may still exist."
              : "Its local details have expired, but the original request may still exist."}
          </p>
          <p className="mt-1">
            Submitted{" "}
            <time dateTime={new Date(view.createdAt).toISOString()} suppressHydrationWarning>
              {new Date(view.createdAt).toLocaleString([], {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </time>
            . Expiry does not cancel it: the message may already have been sent, and a new
            submission could produce a duplicate. The original text is no longer available here.
            Check the conversation before sending anything similar.
          </p>
        </>
      )}
      {!view.persisted ? (
        <p className="mt-1 text-xs">
          This browser could not keep a record of this warning, so a reload will remove it.
        </p>
      ) : null}
      <div className="mt-2">
        <button
          type="button"
          onClick={onAllow}
          className="rounded-md px-3 py-1.5 text-sm ring-1 ring-amber-700 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-amber-900"
        >
          I have checked the conversation…
        </button>
      </div>
    </section>
  );
}

function PendingPanel({
  view,
  onCheck,
  onDismiss,
}: {
  view: OpView;
  onCheck: () => void;
  onDismiss: () => void;
}) {
  const quoted = (
    <blockquote className="mt-1 max-h-28 overflow-y-auto rounded border-l-4 border-amber-500 bg-white/70 px-2 py-1 text-sm break-words whitespace-pre-wrap text-zinc-900">
      {view.op.body}
    </blockquote>
  );
  const unsaved = !view.persisted ? (
    <p className="mt-1 text-xs">
      This browser could not keep a record of this message, so if you reload or close this page it
      can no longer be checked from here. Check the conversation yourself before sending anything
      similar.
    </p>
  ) : null;
  if (view.inFlight)
    return (
      <section
        aria-label="Message being queued"
        role="status"
        className="mb-2 rounded-md border border-zinc-300 bg-zinc-50 p-2 text-sm text-zinc-800"
      >
        <p className="font-medium">Queuing your message…</p>
        {quoted}
        {unsaved}
      </section>
    );
  return (
    <section
      aria-label="Message with an unconfirmed result"
      role="alert"
      className="mb-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950"
    >
      <p className="font-semibold">
        Your previous message may have been queued. Its result could not be confirmed.
      </p>
      {quoted}
      <p className="mt-1">
        If it was queued, it will appear in the conversation with its status. “Check again” submits
        this same message once more under its original reference: if the platform already has it, no
        second copy is created.
      </p>
      {unsaved}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onCheck}
          className="rounded-md bg-amber-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-900"
        >
          Check again
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md px-3 py-1.5 text-sm ring-1 ring-amber-700 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-amber-900"
        >
          Stop tracking this message…
        </button>
      </div>
    </section>
  );
}

/** Why a re-check was refused. It says nothing about the earlier attempt, so it never claims the message was not queued. */
function inconclusiveText(error: ApiError): string {
  if (error.status === 401)
    return "The check could not be completed: your session has ended. Please sign in again.";
  if (error.status === 403)
    return "The check could not be completed: you do not have permission to send replies.";
  if (error.status === 404)
    return "The check could not be completed: this conversation is no longer available.";
  if (error.code === "OUTBOUND_REFUSED")
    return "The check could not be completed: sending is switched off for this platform right now.";
  return "The check could not be completed.";
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "OUTBOUND_REFUSED")
      return `Not queued. ${replyBlockedText(refusalReason(error.detail))}`;
    if (error.code === "VALIDATION_ERROR")
      return "That message cannot be queued as typed. Check its length (up to 4096 characters) and that it has no unusual control characters.";
    if (error.status === 401) return "Your session has ended. Please sign in again.";
    if (error.status === 403) return "You do not have permission to send replies.";
    if (error.status === 404) return "This conversation is no longer available.";
    if (error.code === "IDEMPOTENCY_KEY_REUSED")
      return "That send conflicted with an earlier one. Please try again.";
  }
  return "The message was not queued. Please try again.";
}
