import type {
  ContactLeads,
  LeadDetail,
  LeadEventPage,
  LeadEventView,
  StatusChangeResult,
} from "@/modules/leads";
import { ApiError } from "../lead-api";
import { describeLeadError, type LeadErrorInfo } from "../lead-errors";
import {
  isLeadStatus,
  isStaffSettable,
  needsConfirmation,
  statusOptions,
  transitionKind,
  type StaffSettableStatus,
} from "../lead-labels";
import { appendPage, canLoadMore, firstPage, type ListState } from "../lead-list";
import type { StatusNotice } from "./lead-status";
import { isEventPage, isLeadDetail, isRecord, isRevision, isUuid } from "./lead-response";

// The lead page's request lifecycle, outside React so every race can be tested deterministically (lead-detail-controller.test.ts).
// It follows the rule of the Leads list controller (lead-page-controller.ts): a response may change the screen only if it belongs
// to the request that is current NOW. Every request (a refresh, "Load older events", a status change, a retry) takes a new sequence
// number; starting one, blocking the page (the signed-in account changed) and leaving the page (cancel) all advance the sequence,
// so every older request is stale from that moment and its response is dropped even if it arrives. Aborting saves work; the
// sequence check is what guarantees correctness. (Aborting a status change does NOT mean it was not applied: the server may have
// committed it. That is why an aborted or lost change is never assumed to have failed.)
//
// The page shows ONE lead. A response is also dropped unless it is for that lead (its id is checked), so an answer for another lead
// can never be mixed in. Only one request runs at a time: a refresh supersedes Load older, a refresh and Load older are refused
// while a status change runs, and a status change is refused while anything runs. Nothing retries by itself, and a status change is
// never repeated: not after an error, not after an unknown outcome, not after a conflict.
//
// STATUS MANAGEMENT (Phase 07D-4). The server decides everything; this only sequences what the person sees and does:
//  - A decision (a chosen target, and the confirmation dialog for a close or a reopening) is bound to the REVISION of the lead the
//    person was looking at. The revision sent with the change is that one: never read again at send time, never incremented here.
//  - A read that brings a different revision (or a change by this page) clears the decision and says so. A cleared decision is never
//    sent with a newer revision.
//  - After every outcome except a 401 the page reads the lead again (a read, never a repeat of the change), and the status control
//    stays unavailable until that read succeeds (`needsRead`): a new decision is made only on a state that has been read.
//  - `changed: true` is a confirmed success; `changed: false` is shown as "no change"; an unreadable or unexpected answer, a timeout
//    and a dropped connection are an UNKNOWN outcome. The history is never extended in the browser: it only changes with a read.
// A failed request never removes what is already shown, with one exception: an answer that says the lead is gone or no longer
// permitted (404 / 403 on a READ) replaces the page with a notice, because that data must no longer be shown.

export type DetailPhase = "ready" | "refreshing" | "loading-older" | "changing";

export type StatusState = {
  /** The target the person chose and the revision it was chosen on. */
  readonly draft: { readonly to: StaffSettableStatus; readonly revision: number } | null;
  /** The confirmation dialog (close or reopen) is open for this decision. */
  readonly confirm: { readonly to: StaffSettableStatus; readonly revision: number } | null;
  /** What happened last, for the person to read. Cleared by the next decision or a manual refresh. */
  readonly notice: StatusNotice | null;
  /** The lead has to be read again before another decision: the outcome is unknown, or the page has not yet read what the change did. */
  readonly needsRead: boolean;
};

const NO_STATUS: StatusState = { draft: null, confirm: null, notice: null, needsRead: false };

export type DetailViewState = {
  readonly detail: LeadDetail;
  /** The lead's history, newest first: the first page, then the older pages loaded so far. */
  readonly history: ListState<LeadEventView>;
  readonly phase: DetailPhase;
  /** The last failure of a READ, and which request failed (what Retry repeats). */
  readonly error: { readonly info: LeadErrorInfo; readonly during: "refresh" | "older" } | null;
  readonly status: StatusState;
  /** The lead can no longer be read by this account (gone, or permission removed): nothing of it is shown. */
  readonly unavailable: boolean;
  /** The signed-in account changed: nothing is requested or applied any more; the page must be reloaded. */
  readonly blocked: boolean;
};

export type DetailController = {
  getState: () => DetailViewState;
  subscribe: (listener: () => void) => () => void;
  /** Read the lead again; what is shown stays until the answer replaces it. Replaces the history with its first page. */
  refresh: () => void;
  loadOlder: () => void;
  retry: () => void;
  /** Choose a target status (null clears the choice). Bound to the revision currently shown. */
  choose: (to: StaffSettableStatus | null) => void;
  /** Act on the chosen target: ask for confirmation (close, reopen) or send it (a move between statuses of the same kind). */
  requestChange: () => void;
  /** The person confirmed the dialog. */
  confirm: () => void;
  /** The person dismissed the dialog (ignored while the change is being sent: it cannot be taken back). */
  cancelConfirm: () => void;
  /** The signed-in account changed (ACTOR_CHANGED): stop for good. */
  block: () => void;
  /** Leaving the page: whatever is in flight is abandoned. */
  cancel: () => void;
};

const historyOf = (detail: LeadDetail) =>
  firstPage(detail.lead.id, {
    items: detail.history.events,
    nextCursor: detail.history.nextCursor,
  });

/**
 * What the page needs from the answer to a status change, taken only from an answer that can be trusted. The shared client checks
 * that a 2xx body is JSON, not that it is the documented envelope, so a 200 can still be `{ "changed": true }` with no lead. Such an
 * answer proves nothing: the server may well have committed the change. It is therefore NOT a failure and NOT a success: the caller
 * treats it as an UNKNOWN outcome (never repeated, read first). Checked, and why: `changed` is a boolean; `lead` is an object for
 * THIS lead; its status is the status that was asked for (the server answers with the target, also when nothing changed); its
 * revision is a valid `integer` revision that is EXACTLY the decision's + 1 when the change was made (the server writes revision + 1
 * under the row lock, src/modules/leads/workflow.ts) and equal to it when nothing was written (the compare-and-set). Any other
 * revision is impossible and is refused here, before it can be held: a held 101 would make every later true read (revision 1)
 * look "older" and be refused, so the control could never be used again. And the fields the page copies from it have the right type. Nothing else of the answer is used: the
 * contact, the source and the other display fields keep what the last read said, so a malformed copy of them can never reach the
 * screen.
 */
export type ConfirmedLead = Pick<
  LeadDetail["lead"],
  "status" | "revision" | "open" | "readOnly" | "statusChangedAt" | "cycleStartedAt"
>;
export function acceptStatusResult(
  result: unknown,
  leadId: string,
  decision: { readonly to: StaffSettableStatus; readonly revision: number },
): { readonly changed: boolean; readonly lead: ConfirmedLead } | null {
  if (!isRecord(result) || typeof result.changed !== "boolean") return null;
  const lead = result.lead;
  if (!isRecord(lead) || lead.id !== leadId) return null;
  if (!isLeadStatus(lead.status) || lead.status !== decision.to) return null;
  const revision = lead.revision;
  if (!isRevision(revision) || revision !== decision.revision + (result.changed ? 1 : 0))
    return null;
  if (typeof lead.open !== "boolean" || typeof lead.readOnly !== "boolean") return null;
  if (typeof lead.statusChangedAt !== "string" || typeof lead.cycleStartedAt !== "string")
    return null;
  return {
    changed: result.changed,
    lead: {
      status: lead.status,
      revision,
      open: lead.open,
      readOnly: lead.readOnly,
      statusChangedAt: lead.statusChangedAt,
      cycleStartedAt: lead.cycleStartedAt,
    },
  };
}

export function createDetailController(init: {
  /** What the server rendered. */
  readonly detail: LeadDetail;
  readonly fetchDetail: (
    leadId: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<LeadDetail>;
  readonly fetchEvents: (
    leadId: string,
    options: { readonly cursor: string; readonly signal: AbortSignal },
  ) => Promise<LeadEventPage>;
  /** POST /api/leads/:id/status. */
  readonly changeStatus: (
    leadId: string,
    change: { readonly to: StaffSettableStatus; readonly expectedRevision: number },
    options: { readonly signal: AbortSignal },
  ) => Promise<StatusChangeResult>;
  /** GET /api/leads/for-contact/:contactId: only to find the contact's open lead after ALREADY_OPEN. */
  readonly fetchContactLeads: (
    contactId: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<ContactLeads>;
  /** The shared client's sticky "the account changed" flag. */
  readonly isActorChanged: () => boolean;
}): DetailController {
  const leadId = init.detail.lead.id;
  let state: DetailViewState = {
    detail: init.detail,
    history: historyOf(init.detail),
    phase: "ready",
    error: null,
    status: NO_STATUS,
    unavailable: false,
    blocked: false,
  };
  let sequence = 0;
  let running: AbortController | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Partial<DetailViewState>) => {
    state = { ...state, ...next };
    listeners.forEach((l) => l());
  };
  const setStatus = (next: Partial<StatusState>) => set({ status: { ...state.status, ...next } });

  /** Supersedes everything in flight. */
  const supersede = () => {
    sequence++;
    running?.abort();
    running = null;
  };

  const block = () => {
    if (state.blocked) return;
    supersede();
    // nothing of the old actor's decision survives: the page is replaced by the notice
    set({ blocked: true, phase: "ready", error: null, status: NO_STATUS });
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

  // ------------------------------------------------------------------------------------------------------------- reads
  function failRead(mine: number, error: unknown, during: "refresh" | "older") {
    if (!isCurrent(mine)) return;
    const info = describeLeadError(error, "read");
    if (info.kind === "aborted") return;
    if (info.kind === "actor_changed") return block();
    running = null;
    if (info.kind === "not_found" || info.kind === "forbidden")
      return set({ phase: "ready", error: null, unavailable: true, status: NO_STATUS });
    set({ phase: "ready", error: { info, during } });
  }

  /**
   * Applies a read that passed its checks. A throw here is a defect, not a response problem (a subscriber failed, say): the read
   * ends as a failed, retryable read instead of leaving the page busy for good, and the defect is reported, never swallowed.
   */
  function applyRead(mine: number, during: "refresh" | "older", apply: () => void) {
    try {
      apply();
    } catch (error) {
      console.error(`lead page: a ${during} answer could not be applied`, error);
      failRead(mine, new ApiError(200, "BAD_RESPONSE"), during);
    }
  }

  /**
   * The lead was read: replace what is shown. A pending decision survives only if the lead is still at the revision it was made
   * on; otherwise it is cleared and the person is told (it is never sent with the newer revision).
   */
  function applyDetail(detail: LeadDetail, openLeadId: string | null | undefined) {
    const s = state.status;
    const stillValid =
      (!s.draft || s.draft.revision === detail.lead.revision) &&
      (!s.confirm || s.confirm.revision === detail.lead.revision);
    let notice = s.notice;
    if (notice?.kind === "already_open" && openLeadId !== undefined)
      notice = { kind: "already_open", openLeadId };
    set({
      detail,
      history: historyOf(detail),
      phase: "ready",
      error: null,
      status: stillValid
        ? { ...s, notice, needsRead: false }
        : {
            draft: null,
            confirm: null,
            notice: { kind: "decision_invalidated" },
            needsRead: false,
          },
    });
  }

  function refresh() {
    if (state.phase === "changing") return; // a change in flight is never superseded: its outcome must be read, not abandoned
    const req = begin();
    if (!req) return;
    // a manual refresh clears the last message; a read that is owed (after a change or a failure) keeps it
    if (!state.status.needsRead && state.status.notice) setStatus({ notice: null });
    // after ALREADY_OPEN the contact's open lead is looked up in the same step (best effort: a failure only means no link)
    const lookUp =
      state.status.notice?.kind === "already_open" && state.status.notice.openLeadId === undefined;
    set({ phase: "refreshing", error: null });
    const lead = init.fetchDetail(leadId, { signal: req.signal });
    const open: Promise<string | null> | null = lookUp
      ? init
          .fetchContactLeads(state.detail.contact.id, { signal: req.signal })
          .then((r: unknown) => {
            const id = isRecord(r) && isRecord(r.openLead) ? r.openLead.id : null;
            return isUuid(id) && id !== leadId ? id : null;
          })
          .catch(() => null)
      : null;
    lead.then(
      async (detail) => {
        const openLeadId = open ? await open : undefined;
        if (!isCurrent(req.mine)) return;
        // a 200 that is not a lead read, down to the nested parts this page reads, is a failed read: it is never held (it would
        // throw later, while rendering, or leave the page "refreshing" for good); what is shown stays
        if (!isLeadDetail(detail))
          return failRead(req.mine, new ApiError(200, "BAD_RESPONSE"), "refresh");
        // an answer for another lead is never applied (the server answers for the id it was asked for; this is the second check)
        if (detail.lead.id !== leadId)
          return failRead(req.mine, new TypeError("wrong lead"), "refresh");
        // revisions only grow: an older reading than what this page already holds is not a newer state
        if (detail.lead.revision < state.detail.lead.revision)
          return failRead(req.mine, new TypeError("older revision"), "refresh");
        running = null;
        applyRead(req.mine, "refresh", () => applyDetail(detail, openLeadId));
      },
      (error: unknown) => failRead(req.mine, error, "refresh"),
    );
  }

  function loadOlder() {
    if (state.phase !== "ready" || state.unavailable || !canLoadMore(state.history)) return;
    const from = state.history.nextCursor!;
    const req = begin();
    if (!req) return;
    set({ phase: "loading-older", error: null });
    init.fetchEvents(leadId, { cursor: from, signal: req.signal }).then(
      (page) => {
        if (!isCurrent(req.mine)) return;
        // the whole page is refused if any event or the cursor is malformed: nothing of it is appended, the cursor stays for Retry
        if (!isEventPage(page))
          return failRead(req.mine, new ApiError(200, "BAD_RESPONSE"), "older");
        running = null;
        applyRead(req.mine, "older", () =>
          set({
            history: appendPage(state.history, leadId, from, {
              items: page.events,
              nextCursor: page.nextCursor,
            }),
            phase: "ready",
            error: null,
          }),
        );
      },
      (error: unknown) => failRead(req.mine, error, "older"),
    );
  }

  // ------------------------------------------------------------------------------------------------------ status change
  /** May a decision be made now? Only on a lead that was read, that this person may change, with nothing running. */
  function editable() {
    const lead = state.detail.lead;
    return (
      !state.blocked &&
      !state.unavailable &&
      state.phase === "ready" &&
      !state.status.needsRead &&
      statusOptions({
        status: lead.status,
        readOnly: lead.readOnly,
        canEdit: state.detail.can.edit,
      }).length > 0
    );
  }

  function send(decision: { readonly to: StaffSettableStatus; readonly revision: number }) {
    // the decision must be for the state shown right now (a read that changed it would have cleared the decision)
    if (decision.revision !== state.detail.lead.revision) return;
    const req = begin();
    if (!req) return;
    // (an open confirmation dialog stays open and stable until the outcome is known)
    set({ phase: "changing", error: null, status: { ...state.status, notice: null } });
    init
      .changeStatus(
        leadId,
        { to: decision.to, expectedRevision: decision.revision },
        { signal: req.signal },
      )
      .then(
        (answer) => {
          if (!isCurrent(req.mine)) return;
          running = null;
          // An answer that is not the documented envelope (a 200 the shared client cannot tell from the real one) is NOT trusted:
          // the change may have been committed. It is an unknown outcome, handled exactly like a lost answer: never repeated, the
          // lead is read, the control waits for that read.
          const result = acceptStatusResult(answer, leadId, decision);
          if (!result) return failChange(req.mine, new ApiError(200, "BAD_RESPONSE"), decision);
          try {
            // The server confirmed (changed: true) or said nothing was written (changed: false). The status and revision it
            // returned are the authoritative ones; the closing time, the history and the rest are read next, and until then the
            // control stays unavailable. Only the validated fields are copied.
            set({
              detail: { ...state.detail, lead: { ...state.detail.lead, ...result.lead } },
              phase: "ready",
              status: {
                draft: null,
                confirm: null,
                notice: result.changed
                  ? { kind: "changed", to: result.lead.status }
                  : { kind: "unchanged" },
                needsRead: true,
              },
            });
            refresh();
          } catch (error) {
            // Not a response problem but a defect (a subscriber threw, say). The page must not stay pending with a change that may
            // have been committed: recover as for an unknown outcome, and report the defect (never swallowed).
            failChange(req.mine, new ApiError(0, "NETWORK"), decision);
            console.error("lead status: the answer to a status change could not be applied", error);
          }
        },
        (error: unknown) => failChange(req.mine, error, decision),
      );
  }

  function failChange(
    mine: number,
    error: unknown,
    decision: { readonly to: StaffSettableStatus; readonly revision: number },
  ) {
    if (!isCurrent(mine)) return;
    const info = describeLeadError(error, "status");
    if (info.kind === "aborted") return; // only the page itself aborts (leaving it); nothing to show and nothing to assume
    if (info.kind === "actor_changed") return block();
    running = null;
    const done = (notice: StatusNotice, read: boolean) => {
      set({
        phase: "ready",
        status: { draft: null, confirm: null, notice, needsRead: read },
      });
      if (read) refresh();
    };
    switch (info.kind) {
      case "unauthenticated":
        return done({ kind: "unauthenticated" }, false); // a read would be refused too
      case "password_change_required":
      case "organization_selection_required":
        return done({ kind: "unauthenticated" }, false);
      case "not_found":
        return set({ phase: "ready", unavailable: true, status: NO_STATUS });
      case "forbidden":
        return done({ kind: "forbidden" }, true);
      case "validation":
        return done({ kind: "validation" }, true);
      case "stale":
        return done({ kind: "stale" }, true);
      case "already_open":
        return done({ kind: "already_open" }, true);
      case "reserved_status":
        return done({ kind: "reserved" }, true);
      default:
        // outcome_unknown, unexpected, contact_archived, ...: the request may have been applied (or not): say so and read
        return done(
          { kind: "outcome_unknown", to: decision.to, revision: decision.revision },
          true,
        );
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh,
    loadOlder,
    retry() {
      if (state.error?.during === "older") {
        set({ error: null });
        loadOlder();
      } else refresh();
    },
    choose(to) {
      if (!editable()) return;
      const from = state.detail.lead.status;
      if (to === null || !isStaffSettable(from) || transitionKind(from, to) === "none")
        return setStatus({ draft: null, confirm: null, notice: null });
      setStatus({
        draft: { to, revision: state.detail.lead.revision },
        confirm: null,
        notice: null,
      });
    },
    requestChange() {
      const draft = state.status.draft;
      if (!draft || !editable()) return;
      const from = state.detail.lead.status;
      if (!isStaffSettable(from) || transitionKind(from, draft.to) === "none")
        return setStatus({ draft: null });
      if (needsConfirmation(transitionKind(from, draft.to))) return setStatus({ confirm: draft });
      send(draft);
    },
    confirm() {
      const decision = state.status.confirm;
      if (!decision || state.phase !== "ready" || state.blocked) return;
      send(decision);
    },
    cancelConfirm() {
      if (state.phase === "changing") return; // sent: it cannot be taken back
      if (state.status.confirm) setStatus({ confirm: null });
    },
    block,
    cancel: supersede,
  };
}
