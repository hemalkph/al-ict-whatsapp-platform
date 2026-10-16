import type { LeadStatus } from "@/modules/leads";
import {
  STATUS_CHANGE_NOTE,
  STATUS_LABEL,
  isStaffSettable,
  statusLabel,
  transitionDescription,
  transitionKind,
  type StaffSettableStatus,
} from "../lead-labels";

// The words of lead status management (Phase 07D-4), as pure data so they can be tested. Every sentence says only what the server
// recorded or refused. Changing a status is an internal record: nothing here ever says a message was sent, a registration or a
// payment happened, or that a change "will" succeed (the server may still refuse a reopening or a stale change).

export type StatusNotice =
  /** The server confirmed the change (`changed: true`). */
  | { readonly kind: "changed"; readonly to: LeadStatus }
  /** The server answered `changed: false`: the lead already had that status and nothing was written. */
  | { readonly kind: "unchanged" }
  /** 409 STALE_STATE: someone else changed the lead; nothing was written. */
  | { readonly kind: "stale" }
  /** 409 ALREADY_OPEN. `openLeadId`: the contact's open lead as the API reports it; null when none was found or it could not be read; undefined while not looked up yet. */
  | { readonly kind: "already_open"; readonly openLeadId?: string | null }
  | { readonly kind: "reserved" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "validation" }
  /** The request may or may not have been applied (timeout, dropped connection, 5xx, unreadable answer). `revision`: what the decision was made on. */
  | { readonly kind: "outcome_unknown"; readonly to: LeadStatus; readonly revision: number }
  /** A read replaced the lead with a different revision while a choice was pending: the choice was cleared. */
  | { readonly kind: "decision_invalidated" };

export type NoticeContent = {
  readonly tone: "success" | "info" | "error";
  readonly title: string;
  readonly body: string;
};

/** What a notice says. `current` is the revision of the lead the page holds now, and `verified` whether it has been read since. */
export function noticeContent(
  notice: StatusNotice,
  context: { readonly currentRevision: number; readonly verified: boolean },
): NoticeContent {
  switch (notice.kind) {
    // Both messages are about the REQUEST that was made, a fact about the past. What the lead is NOW is the status control and the
    // history, from the latest read: someone else may have changed it again since.
    case "changed":
      return {
        tone: "success",
        title: "Your change was saved",
        body: `Your change to ${statusLabel(notice.to)} was saved. This is an internal record: no WhatsApp message was sent. The lead's current status is shown in the status control.`,
      };
    case "unchanged":
      return {
        tone: "info",
        title: "No change was made",
        body: "When your request arrived the lead already had that status, so nothing was saved.",
      };
    case "stale":
      return {
        tone: "error",
        title: "The lead changed while you were editing",
        body: "Someone else updated this lead after you opened it, so your change was not saved. Check the current status and history, then choose again if you still want to change it.",
      };
    case "already_open":
      return {
        tone: "error",
        title: "The lead was not reopened",
        body: "This contact already has another open lead, so this lead stays closed. Nothing was saved.",
      };
    case "reserved":
      return {
        tone: "error",
        title: "This lead cannot be changed here",
        body: "It is in a status managed by the registration and payment workflow. Nothing was saved.",
      };
    case "forbidden":
      return {
        tone: "error",
        title: "You cannot change this lead",
        body: "Your account does not have permission to change lead status. Nothing was saved.",
      };
    case "unauthenticated":
      return {
        tone: "error",
        title: "Your session has ended",
        body: "Nothing was saved. Sign in again to continue.",
      };
    case "validation":
      return {
        tone: "error",
        title: "That change was not accepted",
        body: "Nothing was saved. Reload the page and try again.",
      };
    case "outcome_unknown":
      return {
        tone: "error",
        title: "We could not confirm whether the change was saved",
        body: !context.verified
          ? "The request may or may not have been applied, and it was not repeated. The current state has to be checked before you choose again."
          : context.currentRevision === notice.revision
            ? "The request may or may not have been applied, and it was not repeated. The latest reading shows the lead unchanged, but a slow request could still complete: use Refresh to check again before choosing."
            : "The request may or may not have been applied, and it was not repeated. The lead has changed since you opened it: check the status and the history below before choosing again.",
      };
    case "decision_invalidated":
      return {
        tone: "info",
        title: "The lead changed while you were choosing",
        body: "Your selection was cleared because the lead is no longer in the state you saw. Check the current status, then choose again.",
      };
  }
}

export type Confirmation = {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly action: string;
};

/**
 * What the dialog says before a closing or reopening. Reuses the approved transition sentence (lead-labels.ts) and adds what the
 * decision means. A reopening is never described as certain: the server refuses it while the contact has another open lead.
 */
export function confirmation(
  from: StaffSettableStatus,
  to: StaffSettableStatus,
): Confirmation | null {
  const kind = transitionKind(from, to);
  if (kind === "close")
    return {
      title: `Close this lead as ${statusLabel(to)}?`,
      paragraphs: [
        transitionDescription(from, to),
        "The current lead cycle will end.",
        STATUS_CHANGE_NOTE,
        "No WhatsApp message will be sent.",
      ],
      action: `Close as ${statusLabel(to)}`,
    };
  if (kind === "reopen")
    return {
      title: `Reopen this lead as ${statusLabel(to)}?`,
      paragraphs: [
        transitionDescription(from, to),
        STATUS_CHANGE_NOTE,
        "No WhatsApp message will be sent.",
      ],
      action: `Reopen as ${statusLabel(to)}`,
    };
  return null;
}

/** The one line shown under the status control for the chosen target (nothing for no change). */
export function choiceHint(from: string, to: StaffSettableStatus | null): string | null {
  if (!to || !isStaffSettable(from)) return null;
  const kind = transitionKind(from, to);
  return kind === "none" ? null : transitionDescription(from, to);
}

export const statusOptionLabel = (value: StaffSettableStatus, current: boolean) =>
  current ? `${STATUS_LABEL[value]} (current)` : STATUS_LABEL[value];
