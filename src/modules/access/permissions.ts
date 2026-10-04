import { ForbiddenError } from "@/shared/errors/http-errors";
import { emitSecurityEvent } from "@/shared/security/events";

// Fixed roles with a permission matrix defined HERE, in application code (ADR 0012). No permission tables,
// no per-user overrides. Feature modules ask `can(...)`; they never compare roles themselves.

export const ROLES = ["ADMIN", "STAFF", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

// Only permissions for modules/data that exist today. Future modules add theirs when they are introduced.
export const PERMISSIONS = [
  "organization.manage",
  "staff.read",
  "staff.manage",
  "whatsapp_account.read",
  "whatsapp_account.manage",
  "contact.read",
  "contact.edit",
  "consent.record",
  "lead.read",
  "lead.edit",
  "conversation.read",
  "conversation.reply",
  "conversation.manage",
  "tag.manage",
  "webhook.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ADMIN: readonly Permission[] = PERMISSIONS; // everything

const STAFF: readonly Permission[] = [
  "staff.read",
  "whatsapp_account.read",
  "contact.read",
  "contact.edit",
  "consent.record",
  "lead.read",
  "lead.edit",
  "conversation.read",
  "conversation.reply",
  "conversation.manage",
  "tag.manage",
];

// Read-only. Must never gain an edit/manage/reply/record permission.
const VIEWER: readonly Permission[] = [
  "whatsapp_account.read",
  "contact.read",
  "lead.read",
  "conversation.read",
];

export const PERMISSION_MATRIX: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  ADMIN: new Set(ADMIN),
  STAFF: new Set(STAFF),
  VIEWER: new Set(VIEWER),
};

type Subject = Role | { readonly role: Role };

/** Does the role (or the context's role) hold the permission? Unknown roles hold nothing (fail closed). */
export function can(subject: Subject, permission: Permission): boolean {
  const role = typeof subject === "string" ? subject : subject.role;
  return PERMISSION_MATRIX[role]?.has(permission) ?? false;
}

type SubjectDetails = {
  readonly userId?: string;
  readonly organizationId?: string;
  readonly membershipId?: string;
};

/** Throws ForbiddenError (403) when the permission is missing; emits a security event. */
export function assertCan(
  subject: Role | ({ readonly role: Role } & SubjectDetails),
  permission: Permission,
): void {
  if (can(subject, permission)) return;
  const details: SubjectDetails = typeof subject === "string" ? {} : subject;
  emitSecurityEvent({
    event: "access.permission_denied",
    outcome: "denied",
    permission,
    reason: "role_lacks_permission",
    userId: details.userId,
    organizationId: details.organizationId,
    membershipId: details.membershipId,
  });
  throw new ForbiddenError(`missing_permission:${permission}`);
}
