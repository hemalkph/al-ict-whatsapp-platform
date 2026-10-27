// View types shared by the inbox services, the API routes and the browser UI. Pure data: no imports from the server side, so
// client components can use them with `import type`. Every timestamp is an ISO string; nothing here carries a secret, a token,
// a storage URL or another organization's data.

export const INBOX_VIEWS = [
  "all",
  "OPEN",
  "PENDING",
  "RESOLVED",
  "mine",
  "unassigned",
  "unread",
  // Phase 08F-2 (owner decision D-2): unresolved conversations whose latest bot session is HANDED_OVER or FAILED. Needs bot.read.
  "botAttention",
] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];
export type ConversationStatus = "OPEN" | "PENDING" | "RESOLVED";

export type ContactLabel = {
  /** profile name, else username, else a neutral fallback. Untrusted display text, never identity evidence. */
  readonly displayName: string;
  readonly named: boolean;
  /** A short, non-identifying tail of an identifier so two unnamed contacts can be told apart ("…4821"). */
  readonly idHint: string | null;
};

export type AssigneeView = {
  readonly membershipId: string;
  readonly name: string;
  /** The assignee's membership is no longer ACTIVE. The assignment is kept (never silently moved); staff should reassign. */
  readonly suspended: boolean;
};

export type BotSessionStatus =
  "ACTIVE" | "WAITING_FOR_SEND" | "WAITING_FOR_INPUT" | "COMPLETED" | "HANDED_OVER" | "FAILED";

/** The terminal notice's request state, as recorded. NONE: the session has no notice (or none was queued). PENDING: still QUEUED or SENDING. */
export type BotNoticeOutcome =
  "NONE" | "PENDING" | "ACCEPTED" | "HELD" | "REJECTED" | "UNKNOWN_OUTCOME";

/**
 * Read-only view of a conversation's LATEST bot session (Phase 08F-2, V3.2 J.4 and I.5). Present only for callers holding
 * bot.read. It is built from lifecycle columns alone: never session variables, captured input, tokens or any message text.
 */
export type BotIndicator = {
  readonly state: BotSessionStatus;
  /** Plain-language headline, e.g. "Bot asked for a human". */
  readonly label: string;
  readonly severity: "neutral" | "attention" | "warning";
  readonly handover: {
    /** flow: a HANDOVER node asked for a human. system: the platform handed over. unrecognized: a code this build does not know. */
    readonly origin: "flow" | "system" | "unrecognized";
    /** The code, only when it is on the published allowlists; otherwise null. */
    readonly reasonCode: string | null;
    readonly reason: string;
    /** The reason means the student may not have received a bot message. */
    readonly studentMayNotHaveReceivedMessage: boolean;
  } | null;
  /** Null when the session has no terminal notice. */
  readonly notice: {
    readonly outcome: BotNoticeOutcome;
    readonly label: string;
    /** HELD, REJECTED or UNKNOWN_OUTCOME. */
    readonly warning: boolean;
  } | null;
  /** The session's sensitive fields were cleared by the retention job; the lifecycle summary above is unaffected. */
  readonly redacted: boolean;
  readonly startedAt: string;
  readonly endedAt: string | null;
};

export type ConversationListItem = {
  readonly id: string;
  readonly status: ConversationStatus;
  readonly account: { readonly id: string; readonly label: string };
  readonly contact: ContactLabel;
  readonly lastMessageAt: string;
  /** The exact ordering key, microsecond UTC text ("YYYY-MM-DDTHH:MM:SS.UUUUUUZ"). Sort by (activityKey, id), never by lastMessageAt (milliseconds). */
  readonly activityKey: string;
  readonly lastInboundAt: string | null;
  readonly preview: { readonly direction: "INBOUND" | "OUTBOUND"; readonly text: string } | null;
  readonly assignee: AssigneeView | null;
  /** This staff member's unread inbound messages, capped (see unreadCapped). */
  readonly unreadCount: number;
  readonly unreadCapped: boolean;
  /** Present only for callers with bot.read, and only when the conversation has a bot session. */
  readonly bot?: BotIndicator;
};

export type ConversationPage = {
  readonly items: ConversationListItem[];
  readonly nextCursor: string | null;
};

export type DeliveryPhase =
  | "NONE"
  | "QUEUED"
  | "SENDING"
  | "ACCEPTED"
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED"
  | "REJECTED"
  | "HELD"
  | "UNKNOWN_OUTCOME";

/** What staff see for one outbound message. Transport acceptance is never presented as delivery. */
export type DeliveryView = {
  readonly phase: DeliveryPhase;
  readonly label: string;
  readonly detail: string | null;
  /** UNKNOWN_OUTCOME and failures: shown prominently. */
  readonly severity: "neutral" | "good" | "warning" | "error";
};

export type MediaView = {
  readonly mimeType: string | null;
  readonly filename: string | null;
  readonly sizeBytes: number | null;
  readonly state: "PENDING" | "STORED" | "FAILED" | "EXPIRED";
};

export type TimelineMessage = {
  readonly id: string;
  readonly direction: "INBOUND" | "OUTBOUND";
  readonly type: string;
  /** Text to show, as TEXT (rendered by React, never as HTML). Null when the message has no text. */
  readonly text: string | null;
  /** A safe placeholder for types the inbox does not render ("Photo", "Unsupported message", ...). */
  readonly placeholder: string | null;
  readonly media: MediaView[];
  readonly occurredAt: string;
  readonly reply: {
    readonly resolved: boolean;
    readonly direction: "INBOUND" | "OUTBOUND" | null;
    readonly preview: string | null;
  } | null;
  /** Outbound only. */
  readonly delivery: DeliveryView | null;
  /** Inbound only: this staff member has not seen it yet. */
  readonly unseen: boolean;
};

export type MessagePage = {
  /** Oldest first, ready to render. */
  readonly messages: TimelineMessage[];
  /** Cursor for the next OLDER page, or null when this is the beginning. */
  readonly olderCursor: string | null;
};

export type ReplyState = {
  /** Outbound messaging is switched on for the platform (WHATSAPP_OUTBOUND_ENABLED). */
  readonly outboundEnabled: boolean;
  readonly canQueueText: boolean;
  readonly reason: string | null;
  readonly windowClosesAt: string | null;
};

export type TagView = {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly archived: boolean;
};

export type HistoryEntry = {
  readonly id: string;
  readonly kind: "ASSIGNMENT" | "STATUS";
  readonly at: string;
  readonly actorName: string;
  readonly from: string | null;
  readonly to: string | null;
};

export type ConversationDetail = {
  readonly id: string;
  readonly status: ConversationStatus;
  readonly createdAt: string;
  readonly lastInboundAt: string | null;
  readonly lastOutboundAt: string | null;
  readonly resolvedAt: string | null;
  readonly account: { readonly id: string; readonly label: string };
  readonly assignee: AssigneeView | null;
  readonly contact: {
    readonly id: string;
    readonly label: ContactLabel;
    readonly firstSeenAt: string;
    readonly lastSeenAt: string;
    readonly marketingConsent: "UNKNOWN" | "GRANTED" | "WITHDRAWN";
    /** How this person is identified here. Never merged, never derived, never verified by the inbox. */
    readonly identity: {
      readonly bsuidTail: string | null;
      readonly hasCurrentBsuid: boolean;
      /** The phone-based WhatsApp ID last observed, when any. NOT verified as the person's current number. */
      readonly lastObservedPhone: string | null;
      readonly phoneIsHistorical: boolean;
    };
    readonly tags: TagView[];
  };
  readonly history: HistoryEntry[];
  readonly reply: ReplyState;
  /** What this caller may do, from the permission matrix. The server enforces each one again on every request. */
  readonly can: {
    readonly reply: boolean;
    readonly manage: boolean;
    readonly editContact: boolean;
    readonly manageTags: boolean;
  };
  /** Present only for callers with bot.read, and only when the conversation has a bot session. */
  readonly bot?: BotIndicator;
};

export type NoteView = {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly authorName: string;
};
export type NotePage = { readonly notes: NoteView[]; readonly nextCursor: string | null };

export type AssigneeOption = {
  readonly membershipId: string;
  readonly name: string;
  readonly role: string;
};

export type QuickReplyView = {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly archived: boolean;
};
