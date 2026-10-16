import type { ContactLeads, CreateLeadResult, LeadItem } from "@/modules/leads";
import { ApiError } from "../leads/lead-api";
import { describeLeadError, type LeadErrorInfo } from "../leads/lead-errors";
import { isLeadStatus } from "../leads/lead-labels";
import { isRecord, isRevision, isUuid } from "../leads/[id]/lead-response";

// The Inbox's lead panel (Phase 07D-5): the selected contact's leads, read from GET /api/leads/for-contact/:contactId, and the one
// mutation of the panel, manual creation (POST /api/leads). Outside React so every race is testable (lead-panel-controller.test.ts).
//
// WHOSE DATA. The Inbox switches contacts quickly. A read is applied only if it is the newest read this controller started AND it
// is for the contact selected NOW (both: a generation alone would accept nothing wrong, but the contact check is the second lock;
// a contact alone would accept an old read of A after A -> B -> A). Selecting, refreshing, blocking and leaving all advance the
// generation, so every older read is dropped even if it arrives.
//
// CREATION. A creation is bound to the contact it was started for, and stays bound to it: switching conversations neither
// cancels it (the server may already have committed it) nor redirects it. Its outcome is recorded FOR THAT CONTACT and shown only
// while that contact is selected; it never touches another contact's panel. Nothing is ever retried: after any outcome but a 401
// the contact's leads are read again (a read, never a second POST), and creating is possible again only after that read
// succeeded (`needsRead`). An answer that is not the documented envelope, a lost answer and a server error are an UNKNOWN
// outcome. The panel never inserts a lead it was told about: what it lists always comes from a read.
//
// Repeating a creation can never make a second open lead: the server takes the contact's lock, returns the existing open lead
// (created: false), and a partial unique index is the backstop. The panel still never repeats one by itself.

export type CreateNotice =
  | { readonly kind: "created"; readonly leadId: string }
  | { readonly kind: "existing"; readonly leadId: string }
  | { readonly kind: "unknown" }
  | { readonly kind: "refused"; readonly info: LeadErrorInfo };

export type LeadPanelState = {
  /** The contact the panel is for (null: no conversation open). */
  readonly contactId: string | null;
  /** "loading": a read for this contact is on its way. */
  readonly phase: "idle" | "loading" | "ready";
  /** The last successful read for THIS contact (kept while a refresh runs or fails). */
  readonly data: ContactLeads | null;
  readonly readError: LeadErrorInfo | null;
  /** A creation for this contact is on its way (possibly started before switching away and back). */
  readonly creating: boolean;
  /** What the last creation for this contact did. */
  readonly notice: CreateNotice | null;
  /** The contact must be read again before another creation (an outcome was reported but not yet read). */
  readonly needsRead: boolean;
  readonly blocked: boolean;
};

export type LeadPanelController = {
  getState: () => LeadPanelState;
  subscribe: (listener: () => void) => () => void;
  /** The Inbox opened a conversation of this contact (null: none). A new selection is always read afresh. */
  select: (contactId: string | null) => void;
  /** Read the selected contact's leads again (Refresh, and Retry after a failed read). */
  refresh: () => void;
  /** Create a lead for the selected contact, if the last read allows it and nothing is pending. */
  create: () => void;
  /** The signed-in account changed (ACTOR_CHANGED): stop for good. */
  block: () => void;
  /**
   * Leaving the Inbox (unmount): whatever is in flight is abandoned and its answer is never applied. Not final: React may mount
   * the same controller again (StrictMode), and the next `select` starts afresh.
   */
  cancel: () => void;
};

// --------------------------------------------------------------------------------------------------------- validation
// The fields the panel reads, with the contract's types (src/modules/leads/types.ts). A body that fails is a failed read (or, for
// a creation, an unknown outcome), so a 200 can never put another contact's lead or a malformed one on screen.

const isString = (v: unknown): v is string => typeof v === "string";

/** A lead of THIS contact, with what the panel shows of it. */
function isLeadOf(l: unknown, contactId: string): l is LeadItem {
  return (
    isRecord(l) &&
    isUuid(l.id) &&
    isLeadStatus(l.status) &&
    isRevision(l.revision) &&
    typeof l.open === "boolean" &&
    typeof l.readOnly === "boolean" &&
    isString(l.createdAt) &&
    isString(l.statusChangedAt) &&
    isRecord(l.contact) &&
    l.contact.id === contactId &&
    isRecord(l.source) &&
    ["META_AD", "OTHER_REFERRAL", "NONE"].includes(l.source.kind as string)
  );
}

export function isContactLeads(r: unknown, contactId: string): r is ContactLeads {
  return (
    isRecord(r) &&
    isRecord(r.contact) &&
    r.contact.id === contactId &&
    typeof r.contact.archived === "boolean" &&
    (r.openLead === null || (isLeadOf(r.openLead, contactId) && r.openLead.open)) &&
    Array.isArray(r.leads) &&
    r.leads.every((l) => isLeadOf(l, contactId)) &&
    isRecord(r.can) &&
    typeof r.can.create === "boolean"
  );
}

/**
 * The answer to a creation, believed only if it is the documented envelope for THIS contact: `created: true` is a new lead as the
 * server makes it (NEW, revision 0, open); `created: false` is the contact's existing OPEN lead. Anything else proves nothing.
 */
export function acceptCreateResult(r: unknown, contactId: string): CreateLeadResult | null {
  if (!isRecord(r) || typeof r.created !== "boolean" || !isLeadOf(r.lead, contactId)) return null;
  const lead = r.lead;
  if (!lead.open) return null;
  if (r.created && (lead.status !== "NEW" || lead.revision !== 0)) return null;
  return r as CreateLeadResult;
}

// --------------------------------------------------------------------------------------------------------- controller

export function createLeadPanelController(init: {
  readonly fetchContactLeads: (
    contactId: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<ContactLeads>;
  readonly createLead: (
    contactId: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<CreateLeadResult>;
  /** The shared client's sticky "the account changed" flag. */
  readonly isActorChanged: () => boolean;
}): LeadPanelController {
  let contactId: string | null = null;
  let phase: LeadPanelState["phase"] = "idle";
  let data: ContactLeads | null = null;
  let readError: LeadErrorInfo | null = null;
  let blocked = false;
  /** Creations on their way, by contact. */
  const creating = new Set<string>();
  /** The last creation outcome, by contact, and whether it still has to be read. */
  const outcomes = new Map<string, { notice: CreateNotice; needsRead: boolean }>();

  let generation = 0;
  let reading: AbortController | null = null;
  /** One per mounting of the Inbox. Replaced (and aborted) only when the Inbox is left: a creation is never abandoned because
   * another contact was opened. A creation's answer is applied only within the mounting that sent it. */
  let lifetime = new AbortController();

  const listeners = new Set<() => void>();
  let state = snapshot();
  function snapshot(): LeadPanelState {
    const outcome = contactId ? outcomes.get(contactId) : undefined;
    return {
      contactId,
      phase,
      data,
      readError,
      creating: contactId !== null && creating.has(contactId),
      notice: outcome?.notice ?? null,
      needsRead: outcome?.needsRead ?? false,
      blocked,
    };
  }
  const publish = () => {
    state = snapshot();
    listeners.forEach((l) => l());
  };

  const supersedeRead = () => {
    generation++;
    reading?.abort();
    reading = null;
  };

  function block() {
    if (blocked) return;
    supersedeRead();
    blocked = true;
    // nothing of the previous account's view survives
    contactId = null;
    data = null;
    readError = null;
    phase = "idle";
    creating.clear();
    outcomes.clear();
    publish();
  }

  /** May a request start now? Refuses (and blocks) when the account changed. */
  function allowed() {
    if (blocked) return false;
    if (init.isActorChanged()) {
      block();
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------------------------------------------- reads
  function read() {
    const forContact = contactId;
    if (!forContact || !allowed()) return;
    supersedeRead();
    const mine = generation;
    reading = new AbortController();
    phase = "loading";
    readError = null;
    publish();
    const current = () => mine === generation && forContact === contactId && !blocked;
    init.fetchContactLeads(forContact, { signal: reading.signal }).then(
      (answer: unknown) => {
        if (!current()) return;
        // a 200 that is not this contact's leads is a failed read: it never reaches the screen
        if (!isContactLeads(answer, forContact))
          return failRead(mine, forContact, new ApiError(200, "BAD_RESPONSE"));
        reading = null;
        try {
          const outcome = outcomes.get(forContact);
          if (outcome) outcomes.set(forContact, { ...outcome, needsRead: false });
          data = answer;
          phase = "ready";
          publish();
        } catch (error) {
          // a defect (a subscriber threw), not a response problem: never leave the panel loading, and report it
          console.error("inbox lead panel: a read could not be applied", error);
          failRead(mine, forContact, new ApiError(200, "BAD_RESPONSE"));
        }
      },
      (error: unknown) => failRead(mine, forContact, error),
    );
  }

  function failRead(mine: number, forContact: string, error: unknown) {
    if (mine !== generation || forContact !== contactId || blocked) return;
    const info = describeLeadError(error, "read");
    if (info.kind === "aborted") return;
    if (info.kind === "actor_changed") return block();
    reading = null;
    phase = data ? "ready" : "idle";
    readError = info;
    publish();
  }

  // ---------------------------------------------------------------------------------------------------- creation
  function create() {
    const forContact = contactId;
    if (!forContact || phase !== "ready" || !data?.can.create) return;
    if (creating.has(forContact) || outcomes.get(forContact)?.needsRead) return;
    if (!allowed()) return;
    creating.add(forContact);
    outcomes.delete(forContact);
    publish();
    const life = lifetime;
    const live = () => life === lifetime && !blocked;
    init.createLead(forContact, { signal: life.signal }).then(
      (answer: unknown) => {
        if (!live()) return;
        const result = acceptCreateResult(answer, forContact);
        if (!result) return finish(forContact, { kind: "unknown" }, true);
        finish(
          forContact,
          result.created
            ? { kind: "created", leadId: result.lead.id }
            : { kind: "existing", leadId: result.lead.id },
          true,
        );
      },
      (error: unknown) => {
        if (!live()) return;
        const info = describeLeadError(error, "create");
        if (info.kind === "aborted") return; // only leaving the Inbox aborts a creation
        if (info.kind === "actor_changed") return block();
        if (info.kind === "unauthenticated")
          return finish(forContact, { kind: "refused", info }, false);
        if (info.next === "check-first") return finish(forContact, { kind: "unknown" }, true);
        // a refusal the server proved (archived, already open, forbidden, gone, invalid): nothing was created; read the truth
        finish(forContact, { kind: "refused", info }, true);
      },
    );
  }

  /** Records a creation's outcome for ITS contact; reads it again at once only if that contact is still the one shown. */
  function finish(forContact: string, notice: CreateNotice, mustRead: boolean) {
    creating.delete(forContact);
    outcomes.set(forContact, { notice, needsRead: mustRead });
    publish();
    if (mustRead && forContact === contactId) read();
  }

  // ------------------------------------------------------------------------------------------------------ public
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    select(next) {
      if (blocked || next === contactId) return;
      supersedeRead();
      contactId = next;
      data = null;
      readError = null;
      phase = "idle";
      publish();
      if (next) read();
    },
    refresh: read, // a read never interferes with a creation in flight
    create,
    block,
    cancel() {
      supersedeRead();
      lifetime.abort();
      lifetime = new AbortController();
      // nothing in flight belongs to the next mounting: it reads afresh and knows of no creation (the server keeps the truth)
      contactId = null;
      data = null;
      readError = null;
      phase = "idle";
      creating.clear();
      outcomes.clear();
      publish();
    },
  };
}
