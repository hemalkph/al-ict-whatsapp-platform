import type { LeadEventView, LeadStatus, OtherEvidenceView, SourceSummary } from "@/modules/leads";

// Plain-language text for leads, safe to ship to the browser (pure strings and pure functions: no server code, no environment).
// The values are copied from the database enums because the leads module's runtime exports carry server code; a unit test
// (lead-labels.test.ts) pins them to the module's own lists, so they cannot drift.
//
// Honesty rules (ADR 0016): a recorded Meta ad referral is evidence that WhatsApp reported an ad as the start of the chat. It is
// not a confirmed registration, payment, purchase or marketing consent. "No referral recorded" never means "organic". A reserved
// status (registration, payment, conversion) is shown when the server returns it, but staff can never choose one.

export const LEAD_STATUSES = [
  "NEW",
  "QUALIFIED",
  "INTERESTED",
  "REGISTRATION_STARTED",
  "REGISTERED",
  "PAID",
  "CONVERTED",
  "NOT_INTERESTED",
  "NO_RESPONSE",
  "INVALID",
] as const satisfies readonly LeadStatus[];

export const OPEN_LEAD_STATUSES = [
  "NEW",
  "QUALIFIED",
  "INTERESTED",
  "REGISTRATION_STARTED",
  "REGISTERED",
  "PAID",
] as const satisfies readonly LeadStatus[];

/** The only statuses staff may set (POST /api/leads/:id/status refuses every other value). */
export const STAFF_SETTABLE_STATUSES = [
  "NEW",
  "QUALIFIED",
  "INTERESTED",
  "NOT_INTERESTED",
  "NO_RESPONSE",
  "INVALID",
] as const satisfies readonly LeadStatus[];
export type StaffSettableStatus = (typeof STAFF_SETTABLE_STATUSES)[number];

/** Reserved for the later registration and payment workflow: displayable, never selectable, and a lead in one is read-only. */
export const RESERVED_STATUSES = [
  "REGISTRATION_STARTED",
  "REGISTERED",
  "PAID",
  "CONVERTED",
] as const satisfies readonly LeadStatus[];

export const STATUS_LABEL: Record<LeadStatus, string> = {
  NEW: "New",
  QUALIFIED: "Qualified",
  INTERESTED: "Interested",
  REGISTRATION_STARTED: "Registration started",
  REGISTERED: "Registered",
  PAID: "Paid",
  CONVERTED: "Converted",
  NOT_INTERESTED: "Not interested",
  NO_RESPONSE: "No response",
  INVALID: "Invalid",
};

const has = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

export const isLeadStatus = (value: unknown): value is LeadStatus =>
  typeof value === "string" && has(LEAD_STATUSES, value);
export const isStaffSettable = (value: unknown): value is StaffSettableStatus =>
  typeof value === "string" && has(STAFF_SETTABLE_STATUSES, value);
export const isReservedStatus = (value: unknown) =>
  typeof value === "string" && has(RESERVED_STATUSES, value);
export const isOpenStatus = (value: unknown) =>
  typeof value === "string" && has(OPEN_LEAD_STATUSES, value);

/** A label for any value the server returns; an unknown value (a newer server) is shown as such, never guessed. */
export function statusLabel(value: string): string {
  return isLeadStatus(value) ? STATUS_LABEL[value] : "Unknown status";
}

/** Shown next to a reserved status, so a "Paid" or "Registered" lead is not read as something staff confirmed here. */
export const RESERVED_STATUS_NOTE =
  "This status belongs to the registration and payment workflow, which is not part of this version. It cannot be changed here.";

export const stateLabel = (open: boolean) => (open ? "Open" : "Closed");

export type StatusOption = {
  readonly value: StaffSettableStatus;
  readonly label: string;
  readonly current: boolean;
};

/**
 * The statuses a staff member may pick for a lead. Empty when the lead cannot be changed: it is read-only, its status is reserved
 * or unknown, or the viewer may not edit (the server decides `can.edit`; this only avoids offering what it would refuse).
 */
export function statusOptions(lead: {
  readonly status: string;
  readonly readOnly: boolean;
  readonly canEdit: boolean;
}): StatusOption[] {
  if (!lead.canEdit || lead.readOnly || !isStaffSettable(lead.status)) return [];
  return STAFF_SETTABLE_STATUSES.map((value) => ({
    value,
    label: STATUS_LABEL[value],
    current: value === lead.status,
  }));
}

/**
 * What a change from one staff-settable status to another does (the same rule as the server's planTransition):
 * close = open -> closed (the lead's cycle ends), reopen = closed -> open (a new cycle starts; refused if the contact has
 * another open lead), move = within open or within closed, none = same status.
 */
export type TransitionKind = "none" | "move" | "close" | "reopen";

export function transitionKind(from: StaffSettableStatus, to: StaffSettableStatus): TransitionKind {
  if (from === to) return "none";
  const wasOpen = isOpenStatus(from);
  const willBeOpen = isOpenStatus(to);
  if (wasOpen && !willBeOpen) return "close";
  if (!wasOpen && willBeOpen) return "reopen";
  return "move";
}

/** Closing and reopening change the lead's lifecycle, so the UI asks before doing them. */
export const needsConfirmation = (kind: TransitionKind) => kind === "close" || kind === "reopen";

export function transitionDescription(from: StaffSettableStatus, to: StaffSettableStatus): string {
  const target = STATUS_LABEL[to];
  switch (transitionKind(from, to)) {
    case "none":
      return `The lead is already ${target}.`;
    case "close":
      return `This closes the lead as ${target}. It stays in the history and can be reopened later.`;
    case "reopen":
      return `This reopens the lead as ${target} and starts a new lead cycle. It is refused if the contact already has another open lead.`;
    case "move":
      return `The status changes to ${target}.`;
  }
}

/** Changing a status is internal: it never messages the customer and never changes consent. */
export const STATUS_CHANGE_NOTE =
  "Changing the status is internal. It does not message the customer or change their marketing consent.";

// ------------------------------------------------------------------------------------------------ attribution and evidence

export const SOURCE_LABEL: Record<SourceSummary["kind"], string> = {
  META_AD: "Meta ad referral recorded",
  OTHER_REFERRAL: "Other referral recorded (not a confirmed Meta ad)",
  NONE: "No referral recorded",
};

/** A one-line explanation for each kind of source. None of them asserts registration, payment, purchase or consent. */
export const SOURCE_EXPLANATION: Record<SourceSummary["kind"], string> = {
  META_AD:
    "WhatsApp reported that the customer started this chat from a Meta ad. This is not a confirmed registration, payment or marketing consent.",
  OTHER_REFERRAL:
    "A referral other than a confirmed Meta ad is recorded for this lead. It is not a confirmed Meta ad, registration, payment or consent.",
  NONE: "No referral is recorded for this lead. That does not mean the customer found the class without an ad.",
};

/** Unknown kinds (a newer server) are labelled as unknown rather than folded into one of the known kinds. */
export function sourceLabel(source: Pick<SourceSummary, "kind">): string {
  return Object.hasOwn(SOURCE_LABEL, source.kind)
    ? SOURCE_LABEL[source.kind]
    : "Unknown referral information";
}

/** How a lead came to exist, from its history (null: the lead predates lead history). */
export function originLabel(origin: "MANUAL" | "AD_REFERRAL" | null): string {
  if (origin === "MANUAL") return "Created by staff";
  if (origin === "AD_REFERRAL") return "Created automatically from a Meta ad referral";
  return "Not recorded (this lead predates lead history)";
}

const DECISION_LABEL: Record<string, string> = {
  SKIPPED_STALE: "Not linked: too old when it was first checked",
  // The reconciler dates evidence by the EARLIER of the provider's message time and our receipt time, so a message sent before
  // the cycle began but delivered after it still belongs to the earlier cycle: "received before" would be wrong for it.
  SKIPPED_BEFORE_CYCLE: "Not linked: evidence belongs to an earlier lead cycle",
  SKIPPED_CONVERTED: "Not linked: the contact already has a converted lead",
  SKIPPED_ARCHIVED: "Not linked: the contact was archived",
  RETRY: "Waiting for an automatic retry",
  PARKED: "Automatic linking stopped after repeated failures",
};

/** Why a piece of contact-level evidence is not part of this lead. */
export function otherEvidenceLabel(e: Pick<OtherEvidenceView, "attachment" | "decision">): string {
  if (e.attachment === "OTHER_LEAD") return "Linked to another lead of this contact";
  if (e.decision === null) return "Not linked to any lead yet";
  return Object.hasOwn(DECISION_LABEL, e.decision) ? DECISION_LABEL[e.decision]! : "Not linked";
}

// --------------------------------------------------------------------------------------------------------------- history

/**
 * One line of lead history. Wording follows only what the event records: who acted (or "The system"), what changed, and for a
 * linked touch its stored source label. It never claims a click, registration, payment or consent.
 */
export function eventText(e: LeadEventView): string {
  const who = e.actorName ?? "The system";
  switch (e.kind) {
    case "CREATED":
      return e.origin === "AD_REFERRAL"
        ? "Lead created automatically from a Meta ad referral"
        : e.origin === "MANUAL"
          ? `${who} created the lead`
          : "Lead created";
    case "STATUS":
      return e.from && e.to
        ? `${who} changed the status from ${statusLabel(e.from)} to ${statusLabel(e.to)}`
        : `${who} changed the status`;
    case "TOUCH_LINKED":
      return e.touch ? `Referral evidence linked (${e.touch.label})` : "Referral evidence linked";
    default:
      return "Recorded change";
  }
}
