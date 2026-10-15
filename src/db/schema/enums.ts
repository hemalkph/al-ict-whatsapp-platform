// Single source of truth for constrained text values (ADR 0011: text + CHECK, no PostgreSQL enums).
// The same arrays feed Drizzle column types, DB CHECK constraints, and application validation.

export const WHATSAPP_ACCOUNT_STATUSES = ["PENDING", "ACTIVE", "DISABLED"] as const;

export const WEBHOOK_EVENT_STATUSES = [
  "PENDING",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
  "DEAD",
  "UNROUTABLE",
  "IGNORED",
] as const;

export const CONSENT_STATUSES = ["UNKNOWN", "GRANTED", "WITHDRAWN"] as const;
export const CONSENT_SCOPES = ["MARKETING"] as const;
export const CONSENT_ACTIONS = ["GRANTED", "WITHDRAWN"] as const;
export const CONSENT_SOURCES = [
  "META_AD",
  "WHATSAPP_FORM",
  "WEBSITE_FORM",
  "STAFF_RECORDED",
  "IMPORT_WITH_PROOF",
] as const;

export const CONVERSATION_STATUSES = ["OPEN", "PENDING", "RESOLVED"] as const;
// Append-only workflow history (Phase 06): who changed a conversation's assignee or status, from what to what.
export const CONVERSATION_EVENT_KINDS = ["ASSIGNMENT", "STATUS"] as const;

export const MESSAGE_DIRECTIONS = ["INBOUND", "OUTBOUND"] as const;
// Open-ended: unknown Meta types map to UNKNOWN; deliberately NOT a CHECK constraint.
export const MESSAGE_TYPES = [
  "TEXT",
  "IMAGE",
  "VIDEO",
  "AUDIO",
  "DOCUMENT",
  "STICKER",
  "LOCATION",
  "CONTACT",
  "INTERACTIVE",
  "BUTTON",
  "FLOW",
  "TEMPLATE",
  "SYSTEM",
  "REACTION",
  "UNKNOWN",
] as const;

export const MESSAGE_STATUSES = ["SENT", "FAILED", "DELIVERED", "READ"] as const;
/** Transition priority: a status event only updates messages.latest_status if its priority is strictly higher. NULL = 0. */
export const MESSAGE_STATUS_PRIORITY = { SENT: 1, FAILED: 2, DELIVERED: 3, READ: 4 } as const;

export const ATTACHMENT_STORAGE_STATUSES = ["PENDING", "STORED", "FAILED", "EXPIRED"] as const;

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
] as const;

// Lead lifecycle groups (ADR 0016). Every value is one of LEAD_STATUSES; the groups partition it.
// OPEN: the lead is being worked. At most one open lead per contact (partial unique index).
export const OPEN_LEAD_STATUSES = [
  "NEW",
  "QUALIFIED",
  "INTERESTED",
  "REGISTRATION_STARTED",
  "REGISTERED",
  "PAID",
] as const satisfies readonly (typeof LEAD_STATUSES)[number][];
export const CLOSED_LEAD_STATUSES = [
  "CONVERTED",
  "NOT_INTERESTED",
  "NO_RESPONSE",
  "INVALID",
] as const satisfies readonly (typeof LEAD_STATUSES)[number][];
// The only statuses a staff member may set in Phase 07, and the only ones lead history can record as a status change.
export const STAFF_SETTABLE_LEAD_STATUSES = [
  "NEW",
  "QUALIFIED",
  "INTERESTED",
  "NOT_INTERESTED",
  "NO_RESPONSE",
  "INVALID",
] as const satisfies readonly (typeof LEAD_STATUSES)[number][];
// Reserved for the later registration and payment workflow (roadmap item 8). Nothing in Phase 07 sets them.
export const RESERVED_LEAD_STATUSES = [
  "REGISTRATION_STARTED",
  "REGISTERED",
  "PAID",
  "CONVERTED",
] as const satisfies readonly (typeof LEAD_STATUSES)[number][];

export const LEAD_EVENT_KINDS = ["CREATED", "STATUS", "TOUCH_LINKED"] as const;
// How a lead came to exist: a staff member created it, or a confirmed Meta ad referral did (the reconciler).
export const LEAD_ORIGINS = ["MANUAL", "AD_REFERRAL"] as const;

// Durable outcome of considering one attribution touch for automatic lead handling (lead_reconcile_decisions).
// SKIPPED_* and PARKED are terminal; RETRY is waiting for its next attempt.
export const LEAD_RECONCILE_DECISIONS = [
  "SKIPPED_STALE", // older than the freshness window when first considered
  "SKIPPED_BEFORE_CYCLE", // not newer than the contact's latest lead-cycle boundary
  "SKIPPED_CONVERTED", // the contact has a CONVERTED lead: no automatic lead
  "SKIPPED_ARCHIVED", // the contact is archived
  "RETRY", // a transient failure; attempts 1..4, due at next_attempt_at
  "PARKED", // the fifth failure: needs an operator
] as const;
export const LEAD_RECONCILE_MAX_ATTEMPTS = 5;

export const ATTRIBUTION_SOURCE_TYPES = [
  "META_AD",
  "FACEBOOK_AD",
  "INSTAGRAM_AD",
  "ORGANIC_WHATSAPP",
  "WEBSITE",
  "QR_CODE",
  "MANUAL",
  "REFERRAL",
] as const;

// Open-ended: webhook_events.event_type has no CHECK. IDENTITY = a user's identifier changed (BSUID / phone change).
export const WEBHOOK_EVENT_TYPES = ["MESSAGE", "STATUS", "IDENTITY", "OTHER"] as const;

// Outcome of parsing/ingesting one signature-verified delivery (webhook_requests.ingest_status). Only deliveries whose
// HMAC verified are ever stored. ACCEPTED = the body was understood (it may still have produced zero events).
export const INGEST_STATUSES = [
  "ACCEPTED",
  "UNPARSEABLE", // valid signature, but the bytes are not valid UTF-8 / JSON
  "UNSUPPORTED_SHAPE", // valid JSON that is not the expected webhook envelope
  "EVENTS_REJECTED", // understood, but persisting its events failed deterministically (retrying would not help)
] as const;

// Organization membership (Phase 03). Capabilities per role live in application code, not the database.
export const MEMBERSHIP_ROLES = ["ADMIN", "STAFF", "VIEWER"] as const;
export const MEMBERSHIP_STATUSES = ["ACTIVE", "SUSPENDED"] as const;

// Outbound messaging (Phase 05). Lifecycle of ONE staff-requested send. HELD / ACCEPTED / REJECTED / UNKNOWN_OUTCOME are
// terminal: UNKNOWN_OUTCOME in particular is never retried automatically, because the request may already have reached
// Meta (a retry could send the customer a duplicate message).
export const OUTBOUND_REQUEST_STATES = [
  "QUEUED", // ready to be claimed by the dispatcher
  "SENDING", // claimed; the HTTP request may have been (or be about to be) transmitted
  "ACCEPTED", // Meta returned a wamid (acceptance, not delivery)
  "REJECTED", // Meta conclusively refused it
  "HELD", // not sent, and will not be: a policy check failed (window, consent, recipient, deadline). A new request is needed
  "UNKNOWN_OUTCOME", // may or may not have been sent: manual reconciliation, never an automatic resend
] as const;
export const OUTBOUND_MESSAGE_TYPES = ["TEXT", "TEMPLATE"] as const;
export const RECIPIENT_KINDS = ["PHONE", "BSUID"] as const;
export const TEMPLATE_CATEGORIES = ["UTILITY", "MARKETING", "AUTHENTICATION"] as const;
// PENDING_ATTESTATION: registered, never confirmed approved. APPROVED: an operator attested, in the Meta dashboard, that this
// exact template (name + language) is approved for this WhatsApp account. The platform never calls Meta to verify it.
export const TEMPLATE_STATUSES = ["PENDING_ATTESTATION", "APPROVED", "DISABLED"] as const;
