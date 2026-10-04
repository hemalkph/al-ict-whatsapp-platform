import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { createdAt, oneOf, pk, updatedAt } from "./_shared";
import { MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES } from "./enums";
import { orgId } from "./organizations";

// APPLICATION-OWNED authentication/authorization tables (not shaped by Better Auth).
// Users are GLOBAL identities (./auth.ts); memberships are ORGANIZATION-SPECIFIC. A user with no
// ACTIVE membership has zero application access.

/**
 * Links a global user to an organization with a role. Capabilities per role are defined in
 * application code (fixed permission matrix), never in the database. No INVITED/REMOVED states:
 * accounts are admin-created, and offboarding is SUSPENDED (reversible, keeps history and FKs).
 * FK actions are NO ACTION: memberships are never cascaded away.
 */
export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: pk(),
    organizationId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: MEMBERSHIP_ROLES }).notNull(),
    status: text("status", { enum: MEMBERSHIP_STATUSES }).notNull().default("ACTIVE"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("organization_memberships_org_user_unique").on(t.organizationId, t.userId),
    // FK target for organization-aware references to a membership (e.g. provisioning intents, later assignment).
    unique("organization_memberships_org_id_unique").on(t.organizationId, t.id),
    index("organization_memberships_user_id_idx").on(t.userId),
    check("organization_memberships_role_check", oneOf(t.role, MEMBERSHIP_ROLES)),
    check("organization_memberships_status_check", oneOf(t.status, MEMBERSHIP_STATUSES)),
  ],
);

/**
 * Global (not per-organization) application security state for an identity. One row per user, created
 * with the user; a missing row is treated by the application as password_change_required = false.
 * Deleted together with the user (it is a 1:1 extension of the user row, like the library's own
 * sessions/accounts). Add fields only when genuinely required.
 */
export const userSecurityState = pgTable("user_security_state", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  passwordChangeRequired: boolean("password_change_required").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Short-lived, recoverable coordinator for staff/bootstrap provisioning. NOT an audit log and NOT a
 * workflow engine: a row exists only while a provisioning attempt is in flight and is deleted on
 * completion, so row existence == "this email is being provisioned by this organization".
 *
 * Every supported provisioning path inserts the intent BEFORE calling the private Better Auth
 * instance. email_key is globally UNIQUE, so no other organization can provision (or reconcile) the same
 * identity while the intent exists. If the process dies after Better Auth committed the user but before
 * the membership was created, a retry holding the same organization's intent can reconcile the existing
 * normalized-email user; a different organization cannot claim it. No password or credential material is
 * ever stored here.
 */
export const staffProvisioningIntents = pgTable(
  "staff_provisioning_intents",
  {
    id: pk(),
    organizationId: orgId(),
    // trim + lowercase of the requested email; globally unique among live intents.
    emailKey: text("email_key").notNull(),
    // NULL for the first-admin bootstrap (no membership exists yet). If set, it must belong to organization_id.
    requestedByMembershipId: uuid("requested_by_membership_id"),
    // Set once Better Auth has created the user (lets a retry resume). ON DELETE SET NULL: if an
    // unprovisioned user is cleaned up, the intent stays and the attempt can be retried.
    authUserId: uuid("auth_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("staff_provisioning_intents_email_key_unique").on(t.emailKey),
    unique("staff_provisioning_intents_auth_user_id_unique").on(t.authUserId),
    foreignKey({
      name: "staff_provisioning_intents_org_requested_by_fk",
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
    }),
    check(
      "staff_provisioning_intents_email_key_check",
      sql`${t.emailKey} = lower(btrim(${t.emailKey})) AND ${t.emailKey} <> ''`,
    ),
  ],
);
