import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema, type Database } from "@/db";
import { getSession, type SessionProvider } from "@/modules/auth";
import { AppError } from "@/shared/errors/app-error";
import {
  ForbiddenError,
  PasswordChangeRequiredError,
  ReauthenticationRequiredError,
  UnauthenticatedError,
} from "@/shared/errors/http-errors";
import { emitSecurityEvent } from "@/shared/security/events";
import { recordRefusalThrottled, type Tx } from "./audit";
import { platformCan, type PlatformPermission, type PlatformRole } from "./permissions";

// Server-side PLATFORM authorization boundary (plan 7.1). The actor is ONLY the validated Better Auth session user; roles are
// read from PostgreSQL on every request (no cookie cache), so a revocation applies to the next request. No organization
// context is created here: a platform actor never becomes a tenant AccessContext.

export type PlatformActor = {
  readonly userId: string;
  readonly sessionId: string;
  readonly roles: readonly PlatformRole[];
};

export type PlatformDeps = { readonly db?: Database; readonly auth?: SessionProvider };

/** Minutes since the password sign-in that created the session, within which a platform mutation is allowed (plan 5.2). */
export const REAUTHENTICATION_WINDOW_MINUTES = 10;

async function activeRoles(db: Tx | Database, userId: string): Promise<PlatformRole[]> {
  const rows = await db
    .select({ role: schema.platformOperatorRoles.role })
    .from(schema.platformOperatorRoles)
    .where(
      and(
        eq(schema.platformOperatorRoles.userId, userId),
        eq(schema.platformOperatorRoles.status, "ACTIVE"),
      ),
    );
  return rows.map((r) => r.role);
}

/** Does the user hold any ACTIVE platform role? (Used by tenant credential paths to refuse operator accounts.) */
export async function hasActivePlatformRole(db: Tx | Database, userId: string): Promise<boolean> {
  return (await activeRoles(db, userId)).length > 0;
}

export function assertPlatformCan(actor: PlatformActor, permission: PlatformPermission): void {
  if (platformCan(actor.roles, permission)) return;
  emitSecurityEvent({
    event: "platform.access_denied",
    outcome: "denied",
    userId: actor.userId,
    permission,
    reason: "role_lacks_permission",
  });
  throw new ForbiddenError(`missing_platform_permission:${permission}`);
}

/**
 * Early in every platform mutation transaction (after the platform-roles advisory lock). Locks the actor's ACTIVE role rows
 * FOR SHARE (a revocation takes FOR UPDATE: the mutation commits before it, or sees it and is refused) and re-checks the
 * permission (`null` = any ACTIVE role, for revoking one's own grant). Re-authentication is checked separately and LAST
 * (assertRecentAuthentication), so no lock wait can separate it from the write.
 */
export async function lockPlatformActor(
  tx: Tx,
  actor: PlatformActor,
  permission: PlatformPermission | null,
): Promise<void> {
  const rows = await tx
    .select({ role: schema.platformOperatorRoles.role })
    .from(schema.platformOperatorRoles)
    .where(
      and(
        eq(schema.platformOperatorRoles.userId, actor.userId),
        eq(schema.platformOperatorRoles.status, "ACTIVE"),
      ),
    )
    .for("share");
  const roles = rows.map((r) => r.role);
  if (roles.length === 0 || (permission !== null && !platformCan(roles, permission)))
    throw new ForbiddenError("stale_platform_actor");
}

/**
 * Is the session bound to the CURRENT credential? Its credential_generation (stamped at issue by the session-create hook and
 * checked by migration 0010's trigger) must equal the user's current one: a session issued for a password that has since
 * been replaced carries no platform authority, whether or not it was deleted.
 */
const sessionOnCurrentCredential = sql`${schema.sessions.credentialGeneration} = coalesce((select us.credential_generation from user_security_state us where us.user_id = ${schema.sessions.userId}), 0)`;

/**
 * The re-authentication check of a platform mutation (plan 5.2), run early and AGAIN LAST, after every lock the mutation
 * needs is held. On the CURRENT database clock (clock_timestamp(), not the transaction start) the actor's session must exist,
 * be unexpired, be bound to the current credential, and carry a password verification time (credential_verified_at, read
 * from the database clock by the session-create hook immediately before it re-verified the password) that is not in the
 * future and is within the window. Sessions without that time (none are issued so) are never fresh. The row is locked FOR
 * SHARE, so a sign-out or revocation cannot delete it before commit.
 */
export async function assertRecentAuthentication(tx: Tx, actor: PlatformActor): Promise<void> {
  const fresh = await tx
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.id, actor.sessionId),
        eq(schema.sessions.userId, actor.userId),
        sql`${schema.sessions.expiresAt} > clock_timestamp()`,
        sessionOnCurrentCredential,
        sql`${schema.sessions.credentialVerifiedAt} <= clock_timestamp()`,
        sql`${schema.sessions.credentialVerifiedAt} > clock_timestamp() - make_interval(mins => ${REAUTHENTICATION_WINDOW_MINUTES})`,
      ),
    )
    .for("share");
  if (fresh.length === 0) throw new ReauthenticationRequiredError();
}

/**
 * Resolves the platform actor from the session and runs `run`. Any refusal or failure after the user is known is written as
 * a DENIED (403) or FAILED platform audit row, best effort; the error is re-thrown unchanged either way.
 *  - no valid session            -> 401 (no audit row: there is no human to attribute it to)
 *  - no ACTIVE platform role     -> 403
 *  - password_change_required    -> 403 PASSWORD_CHANGE_REQUIRED
 */
export async function withPlatformActor<T>(
  headers: Headers,
  audit: { readonly action: string; readonly permission: PlatformPermission },
  run: (actor: PlatformActor, correlationId: string) => Promise<T>,
  deps: PlatformDeps = {},
): Promise<T> {
  const correlationId = randomUUID();
  const session = await getSession(headers, deps.auth);
  if (!session) throw new UnauthenticatedError("no_valid_session");
  const db = deps.db ?? getDb();
  const userId = session.user.id;
  try {
    // One READ COMMITTED statement snapshot: a revoked session cannot acquire roles from a later credential state.
    const current = await db
      .select({
        role: schema.platformOperatorRoles.role,
        passwordChangeRequired: schema.userSecurityState.passwordChangeRequired,
      })
      .from(schema.sessions)
      .leftJoin(
        schema.userSecurityState,
        eq(schema.userSecurityState.userId, schema.sessions.userId),
      )
      .leftJoin(
        schema.platformOperatorRoles,
        and(
          eq(schema.platformOperatorRoles.userId, schema.sessions.userId),
          eq(schema.platformOperatorRoles.status, "ACTIVE"),
        ),
      )
      .where(
        and(
          eq(schema.sessions.id, session.session.id),
          eq(schema.sessions.userId, userId),
          sql`${schema.sessions.expiresAt} > clock_timestamp()`,
          sessionOnCurrentCredential,
        ),
      );
    const state = current[0];
    if (!state) throw new ReauthenticationRequiredError();
    const roles = current.flatMap((r) => (r.role === null ? [] : [r.role]));
    if (roles.length === 0) {
      emitSecurityEvent({
        event: "platform.access_denied",
        outcome: "denied",
        userId,
        reason: "no_platform_role",
      });
      throw new ForbiddenError("no_platform_role");
    }
    if (state.passwordChangeRequired === true) throw new PasswordChangeRequiredError();
    const actor = { userId, sessionId: session.session.id, roles };
    // Self-revocation permits any ACTIVE role; its service retains the locked target-specific permission check.
    if (audit.permission !== "platform.operator.revoke") assertPlatformCan(actor, audit.permission);
    return await run(actor, correlationId);
  } catch (error) {
    const status = error instanceof AppError ? error.httpStatus : 500;
    await recordRefusalThrottled(db, {
      correlationId,
      actorKind: "HUMAN",
      actorUserId: userId,
      action: audit.action,
      permission: audit.permission,
      outcome: status === 401 || status === 403 ? "DENIED" : "FAILED",
      resultCode: error instanceof AppError ? error.code : "INTERNAL_ERROR",
    });
    throw error;
  }
}
