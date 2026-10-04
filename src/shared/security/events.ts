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
  | "auth.login_failed"
  | "staff.created"
  | "staff.creation_refused"
  | "staff.provisioning_incomplete"
  | "staff.password_reset"
  | "staff.password_reset_refused"
  | "staff.password_reset_incomplete"
  | "membership.role_changed"
  | "membership.suspended"
  | "membership.reactivated"
  | "membership.change_refused"
  | "auth.login_succeeded"
  | "auth.logout"
  | "auth.password_changed"
  | "auth.password_change_incomplete"
  | "bootstrap.completed"
  | "bootstrap.refused"
  | "bootstrap.incomplete"
  | "provisioning_recovery.resumed"
  | "provisioning_recovery.removed"
  | "provisioning_recovery.refused";

export type SecurityEvent = {
  event: SecurityEventName;
  outcome: "denied" | "failure" | "success";
  userId?: string;
  organizationId?: string;
  membershipId?: string;
  /** The user / membership an operation acted on (as opposed to the actor above). */
  targetUserId?: string;
  targetMembershipId?: string;
  role?: string;
  previousRole?: string;
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
    target_user_id: e.targetUserId,
    target_membership_id: e.targetMembershipId,
    role: e.role,
    previous_role: e.previousRole,
    permission: e.permission,
    reason: e.reason,
    email_hash: e.emailHash,
  };
  if (e.outcome === "success") logger.info("security event", context);
  else logger.warn("security event", context);
}
