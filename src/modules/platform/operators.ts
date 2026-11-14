import { and, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type Database } from "@/db";
import {
  LastSecurityAdminRequiredError,
  NotFoundError,
  OperationRefusedError,
  ValidationError,
} from "@/shared/errors/http-errors";
import {
  assertPlatformCan,
  assertRecentAuthentication,
  lockPlatformActor,
  type PlatformActor,
} from "./access";
import { recordAudit, type Tx } from "./audit";
import { PLATFORM_ROLES } from "./permissions";

// Operator management (plan 5.1, 5.4). Every mutation is ONE transaction: the platform-roles advisory lock (serializes
// grants, revocations and the bootstrap, which makes the last-security-admin count race-free), the actor re-check under
// lock with re-authentication, the change, and its SUCCEEDED audit row. An audit failure rolls the change back.

export const VERIFICATION_REF = /^[A-Za-z0-9._:-]{1,64}$/;

const grantSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: z.enum(PLATFORM_ROLES),
  // Short reference to the owner's out-of-band verification of this person (never the evidence itself).
  verificationRef: z.string().regex(VERIFICATION_REF),
});
const revokeSchema = z.strictObject({ grantId: z.uuid() });

function parse<S extends z.ZodType>(s: S, input: unknown): z.infer<S> {
  const r = s.safeParse(input);
  if (r.success) return r.data;
  throw new ValidationError([
    ...new Set(
      r.error.issues.flatMap((i) =>
        i.code === "unrecognized_keys" ? i.keys : [i.path.join(".") || "(root)"],
      ),
    ),
  ]);
}

export async function lockPlatformRoles(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('platform_operator_roles', 0))`,
  );
}

type Ctx = { readonly correlationId: string; readonly db?: Database };

/** Grants and their state: ids, roles, kinds and times only (plan 4: no emails or names). Newest first. */
export async function listOperators(actor: PlatformActor, db: Database = getDb()) {
  assertPlatformCan(actor, "platform.operator.read");
  const r = schema.platformOperatorRoles;
  return db
    .select({
      grantId: r.id,
      userId: r.userId,
      role: r.role,
      status: r.status,
      grantKind: r.grantKind,
      grantedByUserId: r.grantedByUserId,
      grantedAt: r.grantedAt,
      revokedByUserId: r.revokedByUserId,
      revokedAt: r.revokedAt,
    })
    .from(r)
    .orderBy(desc(r.grantedAt), desc(r.id));
}

/**
 * Grants one role to ANOTHER existing user. Refused (409) for oneself, for a user who must still change an
 * administrator-set password (someone else may know it), for a user an organization is still provisioning (a tenant
 * workflow could still replace the password), and when the role is already ACTIVE.
 */
export async function grantPlatformRole(actor: PlatformActor, rawInput: unknown, ctx: Ctx) {
  assertPlatformCan(actor, "platform.operator.grant");
  const input = parse(grantSchema, rawInput);
  const db = ctx.db ?? getDb();
  return db.transaction(async (tx) => {
    await lockPlatformRoles(tx);
    await lockPlatformActor(tx, actor, "platform.operator.grant");
    await assertRecentAuthentication(tx, actor); // early: a stale session learns nothing about targets
    // The per-user coordination point (P1): every tenant credential replacement (reset, provisioning resume) writes the
    // password while holding this same row FOR UPDATE, so it either committed before this grant (and left
    // password_change_required set, refused below) or waits and then sees the ACTIVE role and refuses.
    const [target] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, input.email))
      .for("update");
    if (!target) throw new NotFoundError();
    if (target.id === actor.userId) throw new OperationRefusedError("self_grant");
    const [state] = await tx
      .select({ required: schema.userSecurityState.passwordChangeRequired })
      .from(schema.userSecurityState)
      .where(eq(schema.userSecurityState.userId, target.id));
    if (state?.required === true)
      throw new OperationRefusedError("target_password_change_required");
    const intents = await tx
      .select({ id: schema.staffProvisioningIntents.id })
      .from(schema.staffProvisioningIntents)
      .where(
        or(
          eq(schema.staffProvisioningIntents.emailKey, input.email),
          eq(schema.staffProvisioningIntents.authUserId, target.id),
        ),
      )
      .limit(1);
    if (intents.length > 0) throw new OperationRefusedError("target_provisioning_in_progress");
    const active = await tx
      .select({ id: schema.platformOperatorRoles.id })
      .from(schema.platformOperatorRoles)
      .where(
        and(
          eq(schema.platformOperatorRoles.userId, target.id),
          eq(schema.platformOperatorRoles.role, input.role),
          eq(schema.platformOperatorRoles.status, "ACTIVE"),
        ),
      );
    if (active.length > 0) throw new OperationRefusedError("already_granted");
    await assertRecentAuthentication(tx, actor); // authoritative: last, after every lock, right before the write

    const [grant] = await tx
      .insert(schema.platformOperatorRoles)
      .values({
        userId: target.id,
        role: input.role,
        grantKind: "NORMAL",
        grantedByUserId: actor.userId,
        verificationRef: input.verificationRef,
      })
      .returning({ id: schema.platformOperatorRoles.id });
    await recordAudit(tx, {
      correlationId: ctx.correlationId,
      actorKind: "HUMAN",
      actorUserId: actor.userId,
      action: "platform.operator.grant",
      permission: "platform.operator.grant",
      outcome: "SUCCEEDED",
      targetUserId: target.id,
      approvalRef: input.verificationRef,
    });
    return { grantId: grant!.id, userId: target.id, role: input.role };
  });
}

/**
 * Revokes one grant: another user's with platform.operator.revoke, one's own with any ACTIVE role. Refuses the last ACTIVE
 * security administrator. Deletes ALL of the target's sessions in the same transaction (signed out everywhere; tenant
 * access returns at the next sign-in, platform access does not).
 */
export async function revokePlatformRole(actor: PlatformActor, rawInput: unknown, ctx: Ctx) {
  const input = parse(revokeSchema, rawInput);
  const db = ctx.db ?? getDb();
  return db.transaction(async (tx) => {
    await lockPlatformRoles(tx);
    const [grant] = await tx
      .select()
      .from(schema.platformOperatorRoles)
      .where(eq(schema.platformOperatorRoles.id, input.grantId))
      .for("update");
    const own = grant?.userId === actor.userId;
    // Without the permission, another user's grant and a missing grant look the same (no existence oracle).
    if (!own) assertPlatformCan(actor, "platform.operator.revoke");
    await lockPlatformActor(tx, actor, own ? null : "platform.operator.revoke");
    await assertRecentAuthentication(tx, actor); // early: a stale session learns nothing about targets
    if (!grant) throw new NotFoundError();
    if (grant.status !== "ACTIVE") throw new OperationRefusedError("already_revoked");
    if (grant.role === "PLATFORM_SECURITY_ADMIN") {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.platformOperatorRoles)
        .where(
          and(
            eq(schema.platformOperatorRoles.role, "PLATFORM_SECURITY_ADMIN"),
            eq(schema.platformOperatorRoles.status, "ACTIVE"),
          ),
        );
      if ((row?.n ?? 0) <= 1) throw new LastSecurityAdminRequiredError();
    }
    await assertRecentAuthentication(tx, actor); // authoritative: last, after every lock, right before the write
    await tx
      .update(schema.platformOperatorRoles)
      .set({ status: "REVOKED", revokedByUserId: actor.userId, revokedAt: sql`now()` })
      .where(eq(schema.platformOperatorRoles.id, grant.id));
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, grant.userId));
    await recordAudit(tx, {
      correlationId: ctx.correlationId,
      actorKind: "HUMAN",
      actorUserId: actor.userId,
      action: "platform.operator.revoke",
      permission: own ? null : "platform.operator.revoke",
      outcome: "SUCCEEDED",
      targetUserId: grant.userId,
    });
    return {
      grantId: grant.id,
      userId: grant.userId,
      role: grant.role,
      status: "REVOKED" as const,
    };
  });
}
