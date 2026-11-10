import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { oneOf, pk, tz } from "./_shared";
import {
  PLATFORM_AUDIT_ACTOR_KINDS,
  PLATFORM_AUDIT_OUTCOMES,
  PLATFORM_GRANT_KINDS,
  PLATFORM_ROLES,
  PLATFORM_ROLE_STATUSES,
} from "./enums";
import { organizations } from "./organizations";

// PLATFORM-LEVEL tables (Phase 08G-7B C1A). No organization_id: platform roles are not tenant data and never imply an
// organization membership, and a membership never implies a platform role. Triggers (migration 0010) make roles
// insert-ACTIVE-then-revoke-only and the audit insert-only FOR THE APPLICATION'S STATEMENTS. They do not bind whoever holds
// the database credential: today the runtime role owns these tables, so it can TRUNCATE them, disable the triggers or
// rewrite rows (C1-G3). Append-only integrity needs a separate, non-owner runtime role (pre-production / C1B, OD-C1-4).

// Short owner reference to out-of-band identity verification or approval: an id, never the evidence or personal data.
const REF_PATTERN = "^[A-Za-z0-9._:-]{1,64}$";

/**
 * One row per grant. A grant is never updated except ACTIVE -> REVOKED and never deleted, so the history is the table.
 * At most one ACTIVE row per (user, role). Exactly one BOOTSTRAP grant can ever exist (single-use bootstrap; revoking it
 * does not make bootstrap available again because the row stays).
 */
export const platformOperatorRoles = pgTable(
  "platform_operator_roles",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: PLATFORM_ROLES }).notNull(),
    status: text("status", { enum: PLATFORM_ROLE_STATUSES }).notNull().default("ACTIVE"),
    grantKind: text("grant_kind", { enum: PLATFORM_GRANT_KINDS }).notNull(),
    // NULL only for the BOOTSTRAP grant (no platform human exists yet).
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id),
    verificationRef: text("verification_ref").notNull(),
    grantedAt: tz("granted_at").notNull().defaultNow(),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id),
    revokedAt: tz("revoked_at"),
  },
  (t) => [
    uniqueIndex("platform_operator_roles_user_role_active_uidx")
      .on(t.userId, t.role)
      .where(sql`${t.status} = 'ACTIVE'`),
    uniqueIndex("platform_operator_roles_single_bootstrap_uidx")
      .on(t.grantKind)
      .where(sql`${t.grantKind} = 'BOOTSTRAP'`),
    check("platform_operator_roles_role_check", oneOf(t.role, PLATFORM_ROLES)),
    check("platform_operator_roles_status_check", oneOf(t.status, PLATFORM_ROLE_STATUSES)),
    check("platform_operator_roles_grant_kind_check", oneOf(t.grantKind, PLATFORM_GRANT_KINDS)),
    check(
      "platform_operator_roles_granter_check",
      sql`(${t.grantKind} = 'BOOTSTRAP') = (${t.grantedByUserId} IS NULL)`,
    ),
    check(
      "platform_operator_roles_no_self_grant_check",
      sql`${t.grantedByUserId} IS NULL OR ${t.grantedByUserId} <> ${t.userId}`,
    ),
    check(
      "platform_operator_roles_revocation_check",
      sql`(${t.status} = 'REVOKED') = (${t.revokedAt} IS NOT NULL) AND (${t.revokedAt} IS NULL) = (${t.revokedByUserId} IS NULL)`,
    ),
    check(
      "platform_operator_roles_verification_ref_check",
      sql`${t.verificationRef} ~ ${sql.raw(`'${REF_PATTERN}'`)}`,
    ),
  ],
);

/**
 * Insert-only record of platform-privileged actions. Ids and fixed codes only: never message content, phone numbers,
 * names, emails, tokens, passwords or request bodies. Retention is a pending owner decision (OD-C1-5).
 */
export const platformAuditEvents = pgTable(
  "platform_audit_events",
  {
    id: pk(),
    occurredAt: tz("occurred_at").notNull().defaultNow(),
    correlationId: uuid("correlation_id").notNull(),
    actorKind: text("actor_kind", { enum: PLATFORM_AUDIT_ACTOR_KINDS }).notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    permission: text("permission"),
    outcome: text("outcome", { enum: PLATFORM_AUDIT_OUTCOMES }).notNull(),
    // Requested targets are kept as given (a denied request may name a missing user), so no FK on target_user_id.
    targetUserId: uuid("target_user_id"),
    targetOrganizationId: uuid("target_organization_id"),
    approvalRef: text("approval_ref"),
    resultCode: text("result_code"),
  },
  (t) => [
    // Named explicitly: the generated name exceeds PostgreSQL's 63-byte identifier limit.
    foreignKey({
      name: "platform_audit_events_target_organization_fk",
      columns: [t.targetOrganizationId],
      foreignColumns: [organizations.id],
    }),
    index("platform_audit_events_occurred_at_idx").on(t.occurredAt),
    index("platform_audit_events_actor_occurred_at_idx").on(t.actorUserId, t.occurredAt),
    check("platform_audit_events_actor_kind_check", oneOf(t.actorKind, PLATFORM_AUDIT_ACTOR_KINDS)),
    check("platform_audit_events_outcome_check", oneOf(t.outcome, PLATFORM_AUDIT_OUTCOMES)),
    check(
      "platform_audit_events_actor_check",
      sql`(${t.actorKind} = 'HUMAN') = (${t.actorUserId} IS NOT NULL)`,
    ),
    check(
      "platform_audit_events_codes_check",
      sql`${t.action} ~ '^[a-z_.]{1,64}$' AND (${t.permission} IS NULL OR ${t.permission} ~ '^[a-z_.]{1,64}$') AND (${t.resultCode} IS NULL OR ${t.resultCode} ~ '^[A-Z_]{1,64}$')`,
    ),
    check(
      "platform_audit_events_approval_ref_check",
      sql`${t.approvalRef} IS NULL OR ${t.approvalRef} ~ ${sql.raw(`'${REF_PATTERN}'`)}`,
    ),
  ],
);

/**
 * MUTABLE throttle for best-effort DENIED/FAILED audit rows (kept apart from the immutable audit): at most one durable row
 * per (actor, action, outcome) per minute, so a signed-in caller cannot write audit rows at request rate. Keys are bounded
 * (actions are fixed route codes); every refusal is still logged as a security event.
 */
export const platformAuditThrottle = pgTable(
  "platform_audit_throttle",
  {
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    action: text("action").notNull(),
    outcome: text("outcome", { enum: PLATFORM_AUDIT_OUTCOMES }).notNull(),
    lastRecordedAt: tz("last_recorded_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.actorUserId, t.action, t.outcome] })],
);
