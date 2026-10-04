import { createHash } from "node:crypto";
import { logger } from "@/shared/logging/logger";

// The single integration point for security-relevant events. For now it writes safe structured logs; the
// future audit-log table will plug in here. Only the whitelisted fields below are ever emitted, so passwords,
// session tokens, secrets and request bodies cannot be logged through this function by construction.

export type SecurityEventName =
  | "access.unauthenticated"
  | "access.no_active_membership"
  | "access.organization_selection_required"
  | "access.password_change_required"
  | "access.permission_denied"
  | "access.cross_origin_rejected"
  | "auth.session_denied"
  | "auth.login_failed";

export type SecurityEvent = {
  event: SecurityEventName;
  outcome: "denied" | "failure" | "success";
  userId?: string;
  organizationId?: string;
  membershipId?: string;
  permission?: string;
  reason?: string;
  /** Output of hashForLog(email); never the email itself. */
  emailHash?: string;
};

/** Stable, non-reversible-in-practice identifier for correlating events about the same email. */
export function hashForLog(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 16);
}

export function emitSecurityEvent(e: SecurityEvent): void {
  const context = {
    security_event: e.event,
    outcome: e.outcome,
    user_id: e.userId,
    organization_id: e.organizationId,
    membership_id: e.membershipId,
    permission: e.permission,
    reason: e.reason,
    email_hash: e.emailHash,
  };
  if (e.outcome === "success") logger.info("security event", context);
  else logger.warn("security event", context);
}
