// View types shared by the lead services, the API routes and the future browser UI (07D). Pure data: no server-side imports, so
// client components can use them with `import type`. Every timestamp is an ISO string; nothing here carries a secret, a provider
// payload, a storage URL, a full click id or another organization's data. Text that came from Meta is untrusted display text.

export type LeadStatus =
  | "NEW"
  | "QUALIFIED"
  | "INTERESTED"
  | "REGISTRATION_STARTED"
  | "REGISTERED"
  | "PAID"
  | "CONVERTED"
  | "NOT_INTERESTED"
  | "NO_RESPONSE"
  | "INVALID";

export type ContactLabel = {
  /** profile name, else username, else a neutral fallback. Untrusted display text, never identity evidence. */
  readonly displayName: string;
  readonly named: boolean;
  /** A short, non-identifying tail of an identifier so two unnamed contacts can be told apart ("…4821"). */
  readonly idHint: string | null;
};

export const NO_REFERRAL_LABEL = "No advertisement referral recorded";

/**
 * Where a lead's advertisement evidence stands, from the touches LINKED TO THIS LEAD only. "NONE" means no referral is recorded
 * for the lead: it never means "organic", and evidence stored for the contact but not linked here is not counted.
 */
export type SourceSummary = {
  readonly kind: "META_AD" | "OTHER_REFERRAL" | "NONE";
  readonly label: string;
  readonly adTouches: number;
  readonly linkedTouches: number;
  readonly firstReceivedAt: string | null;
  readonly latestReceivedAt: string | null;
};

export type LeadItem = {
  readonly id: string;
  readonly status: LeadStatus;
  /** The optimistic-concurrency token: send it back unchanged with a status change. */
  readonly revision: number;
  readonly open: boolean;
  /** A reserved status (registration, payment, converted): staff can read the lead but not change it. */
  readonly readOnly: boolean;
  readonly createdAt: string;
  /** The exact ordering key, microsecond UTC text. Sort by (createdKey, id), never by createdAt (milliseconds). */
  readonly createdKey: string;
  /** The time of the last change of status (the action time; the history row of that change has the same time). */
  readonly statusChangedAt: string;
  /** The start of the current cycle. After a reopening it is the reopening time, or a later stored boundary (ADR 0016). */
  readonly cycleStartedAt: string;
  readonly contact: {
    readonly id: string;
    readonly label: ContactLabel;
    readonly archived: boolean;
  };
  readonly source: SourceSummary;
};

export type LeadPage = { readonly items: LeadItem[]; readonly nextCursor: string | null };

export type ConversationRef = {
  readonly id: string;
  readonly status: "OPEN" | "PENDING" | "RESOLVED";
  readonly accountLabel: string;
  readonly lastMessageAt: string;
};

/** One Click-to-WhatsApp referral touch. Every text field is bounded, cleaned plain text; nothing is ever fetched or rendered as HTML. */
export type TouchView = {
  readonly id: string;
  /** The stored source type, in words ("Meta ad"). Facebook and Instagram are never told apart unless the provider said so. */
  readonly label: string;
  readonly receivedAt: string;
  readonly receivedKey: string;
  readonly headline: string | null;
  readonly body: string | null;
  readonly sourceId: string | null;
  /** Origin and path of the link only (no query string or fragment). Display text: never loaded or followed by the server. */
  readonly sourceLink: string | null;
  readonly mediaType: string | null;
  readonly mediaLink: string | null;
  /** The last characters of the click id, or null. The click id itself is never returned. */
  readonly clickIdTail: string | null;
  /** The touch that created this lead. */
  readonly initiating: boolean;
};

export type OtherEvidenceView = TouchView & {
  /** UNLINKED: contact-level evidence not attached to any lead. OTHER_LEAD: attached to a different lead of this contact. */
  readonly attachment: "UNLINKED" | "OTHER_LEAD";
  /** The reconciler's recorded decision for an unlinked touch, if any (07C). */
  readonly decision: string | null;
};

export type LeadEventView = {
  readonly id: string;
  readonly kind: "CREATED" | "STATUS" | "TOUCH_LINKED";
  readonly at: string;
  readonly atKey: string;
  /** The staff member, or null when the system acted (an automatic lead, a linked touch). */
  readonly actorName: string | null;
  readonly origin: "MANUAL" | "AD_REFERRAL" | null;
  readonly from: LeadStatus | null;
  readonly to: LeadStatus | null;
  readonly revision: number | null;
  readonly touch: { readonly id: string; readonly label: string } | null;
};

export type LeadEventPage = {
  /** Newest first. */
  readonly events: LeadEventView[];
  readonly nextCursor: string | null;
};

export type LeadDetail = {
  readonly lead: LeadItem & {
    readonly closedAt: string | null;
    /** How the lead came to exist, from the history; null for a lead that predates lead history. */
    readonly origin: "MANUAL" | "AD_REFERRAL" | null;
  };
  readonly contact: {
    readonly id: string;
    readonly label: ContactLabel;
    readonly archived: boolean;
    readonly firstSeenAt: string;
    readonly lastSeenAt: string;
    readonly identity: {
      readonly bsuidTail: string | null;
      readonly lastObservedPhone: string | null;
    };
  };
  readonly conversations: ConversationRef[];
  readonly attribution: {
    readonly source: SourceSummary;
    /** Evidence LINKED TO THIS LEAD, oldest first (bounded; `linkedTotal` is the real count). */
    readonly linked: TouchView[];
    readonly linkedTotal: number;
    readonly first: TouchView | null;
    readonly latest: TouchView | null;
    /** Other evidence recorded for this CONTACT: not evidence for this lead. Newest first (bounded). */
    readonly otherForContact: OtherEvidenceView[];
    readonly otherTotal: number;
  };
  readonly history: LeadEventPage;
  readonly can: { readonly edit: boolean };
};

export type ContactLeads = {
  readonly contact: {
    readonly id: string;
    readonly label: ContactLabel;
    readonly archived: boolean;
  };
  /** The contact's open lead, if any (at most one exists). */
  readonly openLead: LeadItem | null;
  /** Newest first, bounded. */
  readonly leads: LeadItem[];
  readonly can: { readonly create: boolean };
};

export type CreateLeadResult = {
  /** false: the contact already had an open lead, which is returned unchanged. */
  readonly created: boolean;
  readonly lead: LeadItem;
};

export type StatusChangeResult = {
  /** false: the lead already had that status; nothing was written and the revision did not move. */
  readonly changed: boolean;
  readonly lead: LeadItem;
};
