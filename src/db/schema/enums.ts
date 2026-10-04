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

// Open-ended: webhook_events.event_type has no CHECK.
export const WEBHOOK_EVENT_TYPES = ["MESSAGE", "STATUS", "OTHER"] as const;

// Organization membership (Phase 03). Capabilities per role live in application code, not the database.
export const MEMBERSHIP_ROLES = ["ADMIN", "STAFF", "VIEWER"] as const;
export const MEMBERSHIP_STATUSES = ["ACTIVE", "SUSPENDED"] as const;
