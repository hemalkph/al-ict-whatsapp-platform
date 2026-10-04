import { and, eq } from "drizzle-orm";
import { getSession, type SessionProvider } from "@/modules/auth";
import { getDb, schema, type Database } from "@/db";
import {
  ForbiddenError,
  OrganizationSelectionRequiredError,
  PasswordChangeRequiredError,
  UnauthenticatedError,
} from "@/shared/errors/http-errors";
import { emitSecurityEvent } from "@/shared/security/events";
import { assertCan, can, type Permission, type Role } from "./permissions";

// Server-side authorization boundary. An AccessContext is built ONLY from (1) the validated Better Auth session
// and (2) the user's ACTIVE organization_membership read from PostgreSQL on every call. Nothing coming from the
// browser (organization id, role, membership id, user id) is ever an input here, and roles are never stored in
// cookies or sessions, so role changes, suspension and session deletion take effect on the next call.

export type AccessContext = {
  readonly userId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly role: Role;
  can(permission: Permission): boolean;
};

export type AuthenticatedUser = { readonly userId: string; readonly sessionId: string };

export type AccessOptions = {
  /** Only for the future password-change flow: skip the password_change_required gate. Default false. */
  readonly allowPasswordChangeRequired?: boolean;
  /** Dependency injection for tests; production code uses the lazy defaults. */
  readonly db?: Database;
  readonly auth?: SessionProvider;
};

/** Authenticated identity only (no membership check). 401 when there is no valid session. */
export async function requireUser(
  headers: Headers,
  options: Pick<AccessOptions, "auth"> = {},
): Promise<AuthenticatedUser> {
  const session = await getSession(headers, options.auth);
  if (!session) {
    emitSecurityEvent({
      event: "access.unauthenticated",
      outcome: "denied",
      reason: "no_valid_session",
    });
    throw new UnauthenticatedError("no_valid_session");
  }
  return { userId: session.user.id, sessionId: session.session.id };
}

/**
 * Full application access: valid session + exactly one ACTIVE membership + no pending password change.
 *  - no session                      -> 401
 *  - 0 ACTIVE memberships            -> 403 (includes partially provisioned and fully suspended users)
 *  - >1 ACTIVE memberships           -> 409 (organization selection is not implemented: fail closed)
 *  - password_change_required = true -> 403 PASSWORD_CHANGE_REQUIRED (unless allowPasswordChangeRequired)
 */
export async function requireAccess(
  headers: Headers,
  options: AccessOptions = {},
): Promise<AccessContext> {
  const user = await requireUser(headers, options);
  const db = options.db ?? getDb();

  const memberships = await db
    .select({
      id: schema.organizationMemberships.id,
      organizationId: schema.organizationMemberships.organizationId,
      role: schema.organizationMemberships.role,
    })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.userId, user.userId),
        eq(schema.organizationMemberships.status, "ACTIVE"),
      ),
    )
    .limit(2);

  const membership = memberships[0];
  if (!membership) {
    emitSecurityEvent({
      event: "access.no_active_membership",
      outcome: "denied",
      userId: user.userId,
    });
    throw new ForbiddenError("no_active_membership");
  }
  if (memberships.length > 1) {
    emitSecurityEvent({
      event: "access.organization_selection_required",
      outcome: "denied",
      userId: user.userId,
    });
    throw new OrganizationSelectionRequiredError();
  }

  if (!options.allowPasswordChangeRequired) {
    const [state] = await db
      .select({ passwordChangeRequired: schema.userSecurityState.passwordChangeRequired })
      .from(schema.userSecurityState)
      .where(eq(schema.userSecurityState.userId, user.userId));
    // A missing row means false (documented): only an explicit true blocks access.
    if (state?.passwordChangeRequired === true) {
      emitSecurityEvent({
        event: "access.password_change_required",
        outcome: "denied",
        userId: user.userId,
        organizationId: membership.organizationId,
        membershipId: membership.id,
      });
      throw new PasswordChangeRequiredError();
    }
  }

  const role = membership.role;
  return {
    userId: user.userId,
    membershipId: membership.id,
    organizationId: membership.organizationId,
    role,
    can: (permission) => can(role, permission),
  };
}

/** requireAccess + assertCan in one step. 401 / 403 / 409 as above, then 403 when the role lacks the permission. */
export async function requirePermission(
  headers: Headers,
  permission: Permission,
  options: AccessOptions = {},
): Promise<AccessContext> {
  const ctx = await requireAccess(headers, options);
  assertCan(ctx, permission);
  return ctx;
}
