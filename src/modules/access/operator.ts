import { and, asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type Database } from "@/db";
import { getProvisioningAuth, replaceCredentialPassword } from "@/modules/auth/provisioning";
import { emitSecurityEvent, hashForLog } from "@/shared/security/events";
import { ROLES } from "./permissions";
import { parseInput } from "./staff/schemas";
import { countMemberships } from "./staff/guards";
import type { StaffDeps, Tx } from "./staff/types";

// OPERATOR-ONLY operations (first-admin bootstrap and provisioning-intent recovery). This file is deliberately NOT
// exported from the access barrel and is reached only by the operator CLI scripts in /scripts; src/app cannot import
// it (deep module imports are linted). It follows the same invariants as createStaff: intent first, private
// provisioner (transaction:true), then ONE application transaction that creates the security state and the ACTIVE
// membership and deletes the intent last.

/** Operator-facing refusal. Unlike request-facing errors these messages may be specific: the audience is an operator. */
export class OperatorRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorRefusedError";
  }
}

/**
 * The "this identity was created by the workflow that holds the intent" proof compares the user's created_at (set by
 * the APPLICATION clock inside Better Auth) with the intent's created_at (set by the DATABASE clock), so it must
 * tolerate small clock skew. 5 s covers ordinary NTP-synchronized hosts. It is a tripwire for manually created or
 * corrupted data (supported flows always hold the intent before creating the user), NOT the primary ownership
 * guard: the intent itself, zero memberships anywhere and an unbound/matching auth_user_id are.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5_000;
const predatesIntent = (user: { createdAt: Date }, intent: { createdAt: Date }) =>
  user.createdAt.getTime() < intent.createdAt.getTime() - CLOCK_SKEW_TOLERANCE_MS;

const BOOTSTRAP_LOCK_KEY = 727_001; // serializes bootstrap attempts across processes

async function lockBootstrap(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);
}

// ------------------------------------------------------------------------------------------------ bootstrap

const bootstrapSchema = z.strictObject({
  organizationName: z.string().trim().min(1).max(120),
  organizationSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(128),
});

export type BootstrapResult = {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly resumed: boolean;
};

/**
 * Creates the first organization and its first ADMIN. Refuses unless the system is pristine, or an incomplete
 * bootstrap of THIS workflow is provably being resumed (an intent for the same email whose organization has the
 * same slug and which has no requesting membership - the shape only bootstrap creates).
 *  1. tx (advisory lock): either resume the matching intent, or require zero users AND zero organizations and
 *     insert organization + intent atomically
 *  2. private provisioner creates the user (or, when resuming, the retry's password replaces the crashed one's)
 *  3. tx (advisory lock): the user must be the ONLY user and have no membership; set auth_user_id, create
 *     user_security_state(password_change_required = true) and the ACTIVE ADMIN membership, delete the intent last
 * The password is never logged or returned. Failures keep the intent: the organization has no usable admin until a
 * retry completes (fail closed).
 */
export async function bootstrapFirstAdmin(
  rawInput: unknown,
  deps: StaffDeps = {},
): Promise<BootstrapResult> {
  const input = parseInput(bootstrapSchema, rawInput);
  const db = deps.db ?? getDb();
  const emailHash = hashForLog(input.email);
  const refuse = (reason: string, message: string): never => {
    emitSecurityEvent({ event: "bootstrap.refused", outcome: "denied", reason, emailHash });
    throw new OperatorRefusedError(message);
  };

  // 1. preconditions + organization/intent
  const start = await db.transaction(async (tx) => {
    await lockBootstrap(tx);
    const [intent] = await tx
      .select()
      .from(schema.staffProvisioningIntents)
      .where(eq(schema.staffProvisioningIntents.emailKey, input.email));
    if (intent) {
      const [org] = await tx
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, intent.organizationId));
      if (!org || org.slug !== input.organizationSlug || intent.requestedByMembershipId !== null) {
        return refuse(
          "intent_not_ours",
          "A provisioning intent for this email exists but does not belong to this bootstrap.",
        );
      }
      const others = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(ne(schema.users.email, input.email))
        .limit(1);
      if (others.length > 0)
        return refuse(
          "users_exist",
          "Other users already exist; refusing to resume the bootstrap.",
        );
      return { organizationId: org.id, intentId: intent.id, resumed: true };
    }
    const [userRow] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.users);
    const users = userRow?.n ?? 0;
    if (users > 0)
      return refuse(
        "users_exist",
        "Application users already exist; bootstrap is only for an empty system.",
      );
    const [orgRow] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.organizations);
    const orgs = orgRow?.n ?? 0;
    if (orgs > 0)
      return refuse(
        "organization_exists",
        "An organization already exists; refusing to bootstrap another.",
      );
    const [org] = await tx
      .insert(schema.organizations)
      .values({ name: input.organizationName, slug: input.organizationSlug })
      .returning();
    const [created] = await tx
      .insert(schema.staffProvisioningIntents)
      .values({ organizationId: org!.id, emailKey: input.email, requestedByMembershipId: null })
      .returning();
    return { organizationId: org!.id, intentId: created!.id, resumed: false };
  });

  // 2. identity
  const provisioner = deps.provisioner ?? getProvisioningAuth();
  let userId: string;
  try {
    const [existing] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, input.email));
    if (!existing) {
      const res = await provisioner.api.signUpEmail({
        body: { name: input.name, email: input.email, password: input.password },
      });
      const [persisted] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, input.email));
      if (!persisted || persisted.id !== res.user.id) throw new Error("provisioned user not found");
      userId = persisted.id;
    } else {
      const [intent] = await db
        .select()
        .from(schema.staffProvisioningIntents)
        .where(eq(schema.staffProvisioningIntents.id, start.intentId));
      const memberships = await db.transaction((tx) => countMemberships(tx, existing.id));
      if (!start.resumed || !intent || predatesIntent(existing, intent) || memberships > 0) {
        return refuse(
          "existing_identity",
          "A user with this email already exists and is not part of an incomplete bootstrap.",
        );
      }
      await replaceCredentialPassword(
        provisioner,
        { userId: existing.id, email: input.email },
        input.password,
      );
      userId = existing.id;
    }
  } catch (error) {
    if (error instanceof OperatorRefusedError) throw error;
    emitSecurityEvent({
      event: "bootstrap.incomplete",
      outcome: "failure",
      reason: "auth_step",
      emailHash,
    });
    throw new OperatorRefusedError(
      "Bootstrap stopped after creating the organization; re-run the same command to resume.",
    );
  }

  // 3. membership + security state, atomically
  try {
    const membershipId = await db.transaction(async (tx) => {
      await lockBootstrap(tx);
      const [intent] = await tx
        .select()
        .from(schema.staffProvisioningIntents)
        .where(eq(schema.staffProvisioningIntents.id, start.intentId))
        .for("update");
      if (
        !intent ||
        intent.organizationId !== start.organizationId ||
        intent.emailKey !== input.email
      )
        throw new Error("intent no longer ours");
      const all = await tx.select({ id: schema.users.id }).from(schema.users);
      if (all.length !== 1 || all[0]!.id !== userId) throw new Error("unexpected users present");
      if ((await countMemberships(tx, userId)) > 0) throw new Error("membership already exists");
      await tx
        .update(schema.staffProvisioningIntents)
        .set({ authUserId: userId })
        .where(eq(schema.staffProvisioningIntents.id, intent.id));
      await tx
        .insert(schema.userSecurityState)
        .values({ userId, passwordChangeRequired: true })
        .onConflictDoUpdate({
          target: schema.userSecurityState.userId,
          set: { passwordChangeRequired: true },
        });
      const [membership] = await tx
        .insert(schema.organizationMemberships)
        .values({ organizationId: start.organizationId, userId, role: "ADMIN", status: "ACTIVE" })
        .returning();
      await tx
        .delete(schema.staffProvisioningIntents)
        .where(eq(schema.staffProvisioningIntents.id, intent.id));
      return membership!.id;
    });
    emitSecurityEvent({
      event: "bootstrap.completed",
      outcome: "success",
      organizationId: start.organizationId,
      targetUserId: userId,
      targetMembershipId: membershipId,
      role: "ADMIN",
      emailHash,
    });
    return { organizationId: start.organizationId, userId, membershipId, resumed: start.resumed };
  } catch {
    emitSecurityEvent({
      event: "bootstrap.incomplete",
      outcome: "failure",
      reason: "application_step",
      emailHash,
    });
    throw new OperatorRefusedError(
      "Bootstrap stopped before the admin membership was created; re-run the same command to resume.",
    );
  }
}

// -------------------------------------------------------------------------------- intent inspection/recovery

export type IntentClassification =
  | "NO_AUTH_USER"
  | "RECOVERABLE_UNPROVISIONED_USER"
  | "UNSAFE_USER_HAS_MEMBERSHIP"
  | "UNSAFE_USER_PREDATES_INTENT"
  | "UNSAFE_INTENT_USER_MISMATCH";

export type IntentReport = {
  readonly intentId: string;
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly emailKey: string;
  readonly requestedByMembershipId: string | null;
  readonly authUserId: string | null;
  readonly createdAt: Date;
  readonly ageMinutes: number;
  readonly authUserExists: boolean;
  readonly membershipCount: number;
  readonly classification: IntentClassification;
  readonly allowedActions: ReadonlyArray<"resume" | "remove">;
  readonly note: string;
};

const NOTES: Record<IntentClassification, string> = {
  NO_AUTH_USER:
    "No auth user exists for this email. Nothing can be claimed. Re-run createStaff/bootstrap with a password, or remove the intent once it is old enough.",
  RECOVERABLE_UNPROVISIONED_USER:
    "An auth user created after this intent has no membership anywhere: the same workflow crashed before the membership step. It can be finalized with an explicit role.",
  UNSAFE_USER_HAS_MEMBERSHIP:
    "The identity already has a membership somewhere. Operator review required; the tool will not act.",
  UNSAFE_USER_PREDATES_INTENT:
    "The auth user existed BEFORE this intent, so it is not provably this workflow's identity. Operator review required; the tool will not act.",
  UNSAFE_INTENT_USER_MISMATCH:
    "The intent is bound to a different auth user than the one holding this email. Operator review required; the tool will not act.",
};

async function classify(
  tx: Tx,
  intent: typeof schema.staffProvisioningIntents.$inferSelect,
  organizationSlug: string,
  now: Date,
): Promise<IntentReport> {
  const [user] = await tx
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, intent.emailKey));
  const membershipCount = user ? await countMemberships(tx, user.id) : 0;
  let classification: IntentClassification;
  if (!user) classification = "NO_AUTH_USER";
  else if (membershipCount > 0) classification = "UNSAFE_USER_HAS_MEMBERSHIP";
  else if (predatesIntent(user, intent)) classification = "UNSAFE_USER_PREDATES_INTENT";
  else if (intent.authUserId !== null && intent.authUserId !== user.id)
    classification = "UNSAFE_INTENT_USER_MISMATCH";
  else classification = "RECOVERABLE_UNPROVISIONED_USER";
  return {
    intentId: intent.id,
    organizationId: intent.organizationId,
    organizationSlug,
    emailKey: intent.emailKey,
    requestedByMembershipId: intent.requestedByMembershipId,
    authUserId: intent.authUserId,
    createdAt: intent.createdAt,
    ageMinutes: Math.floor((now.getTime() - intent.createdAt.getTime()) / 60_000),
    authUserExists: user !== undefined,
    membershipCount,
    classification,
    allowedActions:
      classification === "RECOVERABLE_UNPROVISIONED_USER"
        ? ["resume"]
        : classification === "NO_AUTH_USER"
          ? ["remove"]
          : [],
    note: NOTES[classification],
  };
}

/** Read-only listing of every unresolved intent with its classification. Never deletes or expires anything. */
export async function listIntents(
  deps: { db?: Database; now?: Date } = {},
): Promise<IntentReport[]> {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ intent: schema.staffProvisioningIntents, slug: schema.organizations.slug })
      .from(schema.staffProvisioningIntents)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.staffProvisioningIntents.organizationId),
      )
      .orderBy(asc(schema.staffProvisioningIntents.createdAt));
    const reports: IntentReport[] = [];
    for (const row of rows) reports.push(await classify(tx, row.intent, row.slug, now));
    return reports;
  });
}

export async function inspectIntent(
  intentId: string,
  deps: { db?: Database; now?: Date } = {},
): Promise<IntentReport> {
  const all = await listIntents(deps);
  const found = all.find((r) => r.intentId === intentId);
  if (!found) throw new OperatorRefusedError("No such provisioning intent.");
  return found;
}

async function lockedReport(tx: Tx, intentId: string, now: Date) {
  const [intent] = await tx
    .select()
    .from(schema.staffProvisioningIntents)
    .where(eq(schema.staffProvisioningIntents.id, intentId))
    .for("update");
  if (!intent) throw new OperatorRefusedError("No such provisioning intent.");
  const [org] = await tx
    .select({ slug: schema.organizations.slug })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, intent.organizationId));
  // lock the identity row too, so it cannot be changed between classification and action
  await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, intent.emailKey))
    .for("update");
  return { intent, report: await classify(tx, intent, org?.slug ?? "", now) };
}

const resumeSchema = z.strictObject({ role: z.enum(ROLES) });

/**
 * Finalizes an intent ONLY when ownership is provable (RECOVERABLE_UNPROVISIONED_USER): the membership is created
 * in the INTENT'S organization with the operator-supplied role, the security state forces a password change, and the
 * intent is deleted last, all in one transaction. The credential password is not touched. Another organization can
 * never be targeted: the organization comes from the intent.
 */
export async function resumeIntent(
  intentId: string,
  rawInput: unknown,
  deps: { db?: Database; now?: Date } = {},
): Promise<{ membershipId: string; organizationId: string }> {
  const { role } = parseInput(resumeSchema, rawInput);
  const db = deps.db ?? getDb();
  try {
    const result = await db.transaction(async (tx) => {
      const { intent, report } = await lockedReport(tx, intentId, deps.now ?? new Date());
      if (report.classification !== "RECOVERABLE_UNPROVISIONED_USER") {
        throw new OperatorRefusedError(
          `Refusing to resume: ${report.classification}. ${report.note}`,
        );
      }
      const [user] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, intent.emailKey));
      await tx
        .update(schema.staffProvisioningIntents)
        .set({ authUserId: user!.id })
        .where(eq(schema.staffProvisioningIntents.id, intent.id));
      await tx
        .insert(schema.userSecurityState)
        .values({ userId: user!.id, passwordChangeRequired: true })
        .onConflictDoUpdate({
          target: schema.userSecurityState.userId,
          set: { passwordChangeRequired: true },
        });
      const [membership] = await tx
        .insert(schema.organizationMemberships)
        .values({ organizationId: intent.organizationId, userId: user!.id, role, status: "ACTIVE" })
        .returning();
      await tx
        .delete(schema.staffProvisioningIntents)
        .where(eq(schema.staffProvisioningIntents.id, intent.id));
      return {
        membershipId: membership!.id,
        organizationId: intent.organizationId,
        userId: user!.id,
      };
    });
    emitSecurityEvent({
      event: "provisioning_recovery.resumed",
      outcome: "success",
      organizationId: result.organizationId,
      targetUserId: result.userId,
      targetMembershipId: result.membershipId,
      role,
    });
    return { membershipId: result.membershipId, organizationId: result.organizationId };
  } catch (error) {
    if (error instanceof OperatorRefusedError) {
      emitSecurityEvent({
        event: "provisioning_recovery.refused",
        outcome: "denied",
        reason: "resume_not_provable",
      });
    }
    throw error;
  }
}

/**
 * Removes an intent ONLY when no auth identity exists for its email (NO_AUTH_USER): nothing can be claimed by anyone.
 * Refused for every other classification and for intents younger than `minAgeMinutes` (default 10), because the
 * owning process may still be in flight. Intents are never removed automatically.
 */
export async function removeIntent(
  intentId: string,
  deps: { db?: Database; now?: Date; minAgeMinutes?: number } = {},
): Promise<void> {
  const db = deps.db ?? getDb();
  const minAge = deps.minAgeMinutes ?? 10;
  try {
    await db.transaction(async (tx) => {
      const { intent, report } = await lockedReport(tx, intentId, deps.now ?? new Date());
      if (report.classification !== "NO_AUTH_USER") {
        throw new OperatorRefusedError(
          `Refusing to remove: ${report.classification}. ${report.note}`,
        );
      }
      if (report.ageMinutes < minAge) {
        throw new OperatorRefusedError(
          `Refusing to remove: the intent is only ${report.ageMinutes} minute(s) old; its workflow may still be running (minimum ${minAge}).`,
        );
      }
      await tx
        .delete(schema.staffProvisioningIntents)
        .where(and(eq(schema.staffProvisioningIntents.id, intent.id)));
    });
    emitSecurityEvent({
      event: "provisioning_recovery.removed",
      outcome: "success",
      reason: "no_auth_user",
    });
  } catch (error) {
    if (error instanceof OperatorRefusedError) {
      emitSecurityEvent({
        event: "provisioning_recovery.refused",
        outcome: "denied",
        reason: "remove_not_safe",
      });
    }
    throw error;
  }
}
