"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  STATUS_CHANGE_NOTE,
  isStaffSettable,
  statusOptions,
  type StaffSettableStatus,
} from "../lead-labels";
import type { DetailController, DetailViewState } from "./lead-detail-controller";
import { choiceHint, confirmation, noticeContent, statusOptionLabel } from "./lead-status";

// The staff status control of the lead page (Phase 07D-4): a Select of the six statuses staff may set, an "Update status" button,
// a confirmation dialog for a close or a reopening, and the message about what happened. Presentation only: every decision, every
// request and every rule lives in lead-detail-controller.ts, and the server enforces all of it again (permission, revision, the
// reserved statuses, the one-open-lead rule). Nothing here is the security boundary: hiding the control authorizes nothing.
//
// A reserved status can never be chosen (it is not in the list), a lead that is read-only, in a reserved status, or that this role
// may not change gets no control at all, and the control is unavailable while a request runs or a read is owed.
//
// Focus: a busy button is aria-disabled (focus stays where it was). After a confirmed change focus returns to the Select; after a
// conflict, an error or an unknown outcome it moves to the message; cancelling the dialog returns it to the Select. The dialog is
// controlled: it opens when the controller holds a confirmation and closes only when the controller drops it (the base AlertDialog
// action does not close it by itself), so it stays put, with its buttons inert, while the change is on its way.

export function LeadStatusControl({
  state,
  controller,
  signInHref,
  openLeadHref,
}: {
  state: DetailViewState;
  controller: DetailController;
  signInHref: string;
  openLeadHref: (leadId: string) => string;
}) {
  const { detail, phase, status } = state;
  const { lead } = detail;
  const options = statusOptions({
    status: lead.status,
    readOnly: lead.readOnly,
    canEdit: detail.can.edit,
  });
  const changing = phase === "changing";
  const interactive = phase === "ready" && !status.needsRead;
  const chosen = status.draft?.to ?? null;
  const canSubmit = interactive && chosen !== null;
  const hint = choiceHint(lead.status, chosen);
  const confirm =
    status.confirm && isStaffSettable(lead.status)
      ? confirmation(lead.status, status.confirm.to)
      : null;

  const selectRef = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const wantSelectFocus = useRef(false);
  const hadConfirm = useRef(false);

  // After an outcome: success returns to the control (once it is usable again), anything else is read at the message.
  const notice = status.notice;
  useEffect(() => {
    if (!notice) return;
    if (notice.kind === "changed" || notice.kind === "unchanged") wantSelectFocus.current = true;
    else {
      wantSelectFocus.current = false;
      noticeRef.current?.focus();
    }
  }, [notice]);
  // Cancelling the dialog (no message) returns focus to the control as well.
  const confirmOpen = status.confirm !== null;
  useEffect(() => {
    if (hadConfirm.current && !confirmOpen && !notice) wantSelectFocus.current = true;
    hadConfirm.current = confirmOpen;
  }, [confirmOpen, notice]);
  useEffect(() => {
    if (interactive && wantSelectFocus.current && options.length > 0) {
      wantSelectFocus.current = false;
      selectRef.current?.focus();
      // the Select may still be marked disabled in this very commit (it was inert while the lead was being read): try once more
      // on the next frame if the first attempt did not take
      if (document.activeElement !== selectRef.current)
        requestAnimationFrame(() => selectRef.current?.focus());
    }
  });

  const items = Object.fromEntries(
    options.map((o) => [o.value, statusOptionLabel(o.value, o.current)]),
  );
  const content = notice
    ? noticeContent(notice, { currentRevision: lead.revision, verified: !status.needsRead })
    : null;

  return (
    <div className="mt-2 flex flex-col gap-3">
      {options.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <Label id="lead-status-edit-label">Change status</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              items={items}
              value={chosen ?? lead.status}
              disabled={!interactive}
              onValueChange={(value) => {
                if (value !== null)
                  controller.choose(value === lead.status ? null : (value as StaffSettableStatus));
              }}
            >
              <SelectTrigger
                ref={selectRef}
                aria-labelledby="lead-status-edit-label"
                aria-describedby="lead-status-edit-hint"
                className="w-full sm:w-56"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {statusOptionLabel(o.value, o.current)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => canSubmit && controller.requestChange()}
              aria-disabled={!canSubmit}
              aria-describedby="lead-status-edit-hint"
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            >
              Update status
            </Button>
          </div>
          <p id="lead-status-edit-hint" className="text-xs text-zinc-700">
            {hint ?? STATUS_CHANGE_NOTE}
          </p>
        </div>
      ) : null}

      {content && notice ? (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role={content.tone === "error" ? "alert" : "status"}
          className={`rounded-md border p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 ${
            content.tone === "error"
              ? "border-red-300 bg-red-50 text-red-950"
              : content.tone === "success"
                ? "border-emerald-300 bg-emerald-50 text-emerald-950"
                : "border-zinc-300 bg-zinc-50 text-zinc-900"
          }`}
        >
          <p className="font-medium">{content.title}</p>
          <p className="mt-1">{content.body}</p>
          {status.needsRead ? (
            phase === "refreshing" ? (
              <p className="mt-1">Checking the current state…</p>
            ) : state.error?.during === "refresh" ? (
              <>
                <p className="mt-1">
                  {notice.kind === "changed"
                    ? "Your change was saved, but the latest details could not be loaded, so what is shown may be out of date (the lead may have been changed again since)."
                    : "The current state could not be loaded yet, so the status may be out of date and cannot be changed."}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => controller.retry()}
                >
                  Check the current state
                </Button>
              </>
            ) : null
          ) : null}
          {notice.kind === "already_open" && notice.openLeadId ? (
            <Link
              href={openLeadHref(notice.openLeadId)}
              className="mt-2 inline-block font-medium text-emerald-900 underline underline-offset-2"
            >
              Open this contact&apos;s current lead
            </Link>
          ) : null}
          {notice.kind === "unauthenticated" ? (
            <Link href={signInHref} className="mt-2 inline-block font-medium underline">
              Sign in again
            </Link>
          ) : null}
        </div>
      ) : null}

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) controller.cancelConfirm(); // refused while the change is being sent
        }}
      >
        <AlertDialogContent finalFocus={false}>
          {confirm ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
                <AlertDialogDescription render={<div />}>
                  {confirm.paragraphs.map((p) => (
                    <p key={p} className="mt-1 first:mt-0">
                      {p}
                    </p>
                  ))}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={changing}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => controller.confirm()}
                  aria-disabled={changing}
                  className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                >
                  {changing ? "Saving…" : confirm.action}
                </AlertDialogAction>
              </AlertDialogFooter>
              <p role="status" aria-live="polite" className="sr-only">
                {changing ? "Saving the change…" : ""}
              </p>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
