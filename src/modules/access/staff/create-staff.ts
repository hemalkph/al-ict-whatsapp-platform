import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema, type Database } from "@/db";
import { hashPassword } from "better-auth/crypto";
import { getProvisioningAuth } from "@/modules/auth/provisioning";
import { hasActivePlatformRole } from "@/modules/platform";
import { OperationRefusedError, ProvisioningIncompleteError } from "@/shared/errors/http-errors";
import { emitSecurityEvent, hashForLog } from "@/shared/security/events";
import type { AccessContext } from "../access";
import { assertCan } from "../permissions";
import {
  countMemberships,
  markAdministratorPassword,
  replaceCredentialInTx,
  revalidateActor,
} from "./guards";
import { createStaffSchema, parseInput } from "./schemas";
import type { StaffDeps, StaffMember } from "./types";

// createStaff follows the MANDATORY provisioning order from ADR 0012:
//  1. require staff.manage
//  2. acquire the globally-unique staff_provisioning_intents row (email_key) for ctx.organizationId
//  3. decide: fresh identity | resumable crash of THIS organization's workflow | refuse (generic)
//  4. call ONLY the private provisioning instance (transaction:true); verify against the persisted row
//  5. ONE application transaction: lock/revalidate intent, set auth_user_id, user_security_state(true),
//     ACTIVE membership, delete the intent last
// Every failure leaves the intent in place and the user without any ACTIVE membership (fail closed).
// An existing identity is NEVER attached; refusals are one generic error whatever the reason.
//
// Resuming a crashed attempt (Phase 08G-7B C1A) needs PROVENANCE, not an email match: right after THIS workflow's sign-up
// created the identity (and the persisted row was confirmed), the intent is bound to it with a compare-and-set
// (auth_user_id NULL -> that id). Only a bound intent can resume, only for that identity, only by the membership that created
// it, and the replacement password is written in step 5's transaction under the intent and user row locks, after
// re-checking the binding, that the identity has no membership and no ACTIVE platform role. An unbound intent next to an
// existing identity (a pre-existing account, or a crash between sign-up and binding) is never resumable here: it goes to the
// operator recovery (`auth:intents`), which has its own provenance checks. A platform grant takes the same user row lock and
// refuses while any intent names the user, so a grant and a resume are strictly ordered.

type IntentHandle = {
  id: string;
  resumed: boolean;
  authUserId: string | null;
  requestedByMembershipId: string | null;
};

async function acquireIntent(
  db: Database,
  ctx: AccessContext,
  emailKey: string,
): Promise<IntentHandle | null> {
  const [inserted] = await db
    .insert(schema.staffProvisioningIntents)
    .values({
      organizationId: ctx.organizationId,
      emailKey,
      requestedByMembershipId: ctx.membershipId,
    })
    .onConflictDoNothing({ target: schema.staffProvisioningIntents.emailKey })
    .returning();
  if (inserted)
    return {
      id: inserted.id,
      resumed: false,
      authUserId: null,
      requestedByMembershipId: ctx.membershipId,
    };
  const [existing] = await db
    .select()
    .from(schema.staffProvisioningIntents)
    .where(eq(schema.staffProvisioningIntents.emailKey, emailKey));
  // Only the original requester may advance even an UNBOUND intent, before any private sign-up can commit.
  if (
    !existing ||
    existing.organizationId !== ctx.organizationId ||
    existing.requestedByMembershipId !== ctx.membershipId
  )
    return null;
  return {
    id: existing.id,
    resumed: true,
    authUserId: existing.authUserId,
    requestedByMembershipId: existing.requestedByMembershipId,
  };
}

async function findUserByEmail(db: Database, email: string) {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  return row;
}

export async function createStaff(
  ctx: AccessContext,
  rawInput: unknown,
  deps: StaffDeps = {},
): Promise<StaffMember> {
  assertCan(ctx, "staff.manage");
  const input = parseInput(createStaffSchema, rawInput);
  const db = deps.db ?? getDb();
  const base = {
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    membershipId: ctx.membershipId,
    emailHash: hashForLog(input.email),
  };
  const refuse = (reason: string): never => {
    emitSecurityEvent({ event: "staff.creation_refused", outcome: "denied", reason, ...base });
    throw new OperationRefusedError(reason);
  };

  const intent = await acquireIntent(db, ctx, input.email);
  if (!intent) return refuse("intent_held_elsewhere");

  const existing = await findUserByEmail(db, input.email);
  let userId: string;
  // Set only when resuming onto an identity the crashed attempt created: written inside step 5's transaction.
  let replacementHash: string | null = null;
  const provisioner = deps.provisioner ?? getProvisioningAuth();

  try {
    if (!existing) {
      // Hold the intent claim across private sign-up's separate transaction and binding; re-check before creating anything.
      userId = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(schema.staffProvisioningIntents)
          .where(eq(schema.staffProvisioningIntents.id, intent.id))
          .for("update");
        if (
          !locked ||
          locked.organizationId !== ctx.organizationId ||
          locked.emailKey !== input.email ||
          locked.requestedByMembershipId !== ctx.membershipId ||
          locked.authUserId !== null
        )
          return refuse("intent_no_longer_eligible");
        await revalidateActor(tx, ctx, "staff.manage");
        const res = await provisioner.api.signUpEmail({
          body: { name: input.name, email: input.email, password: input.initialPassword },
        });
        // Never trust only the returned object (a duplicate sign-up returns a fabricated id): the persisted row decides.
        const persisted = await findUserByEmail(db, input.email);
        if (!persisted || persisted.id !== res.user.id)
          throw new Error("provisioned user not found");
        const bound = await tx
          .update(schema.staffProvisioningIntents)
          .set({ authUserId: persisted.id })
          .where(
            and(
              eq(schema.staffProvisioningIntents.id, intent.id),
              eq(schema.staffProvisioningIntents.organizationId, ctx.organizationId),
              eq(schema.staffProvisioningIntents.requestedByMembershipId, ctx.membershipId),
              isNull(schema.staffProvisioningIntents.authUserId),
            ),
          )
          .returning({ id: schema.staffProvisioningIntents.id });
        if (bound.length !== 1) throw new Error("intent no longer ours");
        return persisted.id;
      });
    } else {
      // Resumable crash of THIS administrator's attempt: the intent pre-existed, was created by this membership, is BOUND
      // to this very identity (provenance: our sign-up created it), and the identity has no membership anywhere and no
      // platform role. Anything else is an unrelated or unproven identity. (Re-checked under lock in step 5.)
      const resumable =
        intent.resumed &&
        intent.requestedByMembershipId === ctx.membershipId &&
        intent.authUserId === existing.id &&
        (await db.transaction((tx) => countMemberships(tx, existing.id))) === 0 &&
        !(await hasActivePlatformRole(db, existing.id));
      if (!resumable) {
        // A freshly inserted intent is ours to remove; a pre-existing one is left untouched.
        if (!intent.resumed) {
          await db
            .delete(schema.staffProvisioningIntents)
            .where(eq(schema.staffProvisioningIntents.id, intent.id));
        }
        return refuse("existing_identity");
      }
      // The retry's initial password becomes the effective one (the crashed attempt's password is unknown here).
      replacementHash = await hashPassword(input.initialPassword);
      userId = existing.id;
    }
  } catch (error) {
    if (error instanceof OperationRefusedError) throw error;
    emitSecurityEvent({
      event: "staff.provisioning_incomplete",
      outcome: "failure",
      reason: "auth_step",
      ...base,
    });
    throw new ProvisioningIncompleteError();
  }

  try {
    const membership = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(schema.staffProvisioningIntents)
        .where(eq(schema.staffProvisioningIntents.id, intent.id))
        .for("update");
      if (
        !locked ||
        locked.organizationId !== ctx.organizationId ||
        locked.emailKey !== input.email ||
        locked.requestedByMembershipId !== ctx.membershipId ||
        locked.authUserId !== userId
      ) {
        throw new Error("intent no longer ours");
      }
      if (locked.requestedByMembershipId) {
        const [requester] = await tx
          .select({ id: schema.organizationMemberships.id })
          .from(schema.organizationMemberships)
          .where(
            and(
              eq(schema.organizationMemberships.id, locked.requestedByMembershipId),
              eq(schema.organizationMemberships.organizationId, ctx.organizationId),
            ),
          );
        if (!requester) throw new Error("requesting membership not in organization");
      }
      await revalidateActor(tx, ctx, "staff.manage");

      const [user] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, input.email))
        .for("update");
      if (!user || user.id !== userId) throw new Error("user mismatch");
      if ((await countMemberships(tx, user.id)) > 0)
        throw new OperationRefusedError("existing_membership");
      if (await hasActivePlatformRole(tx, user.id))
        throw new OperationRefusedError("existing_identity");

      await tx
        .update(schema.staffProvisioningIntents)
        .set({ authUserId: user.id })
        .where(eq(schema.staffProvisioningIntents.id, intent.id));
      if (replacementHash !== null) await replaceCredentialInTx(tx, user.id, replacementHash);
      else await markAdministratorPassword(tx, user.id);
      const [created] = await tx
        .insert(schema.organizationMemberships)
        .values({
          organizationId: ctx.organizationId,
          userId: user.id,
          role: input.role,
          status: "ACTIVE",
        })
        .returning();
      // The intent is deleted only after every prior write succeeded.
      await tx
        .delete(schema.staffProvisioningIntents)
        .where(eq(schema.staffProvisioningIntents.id, intent.id));
      return { membership: created!, user };
    });

    emitSecurityEvent({
      event: "staff.created",
      outcome: "success",
      targetUserId: membership.user.id,
      targetMembershipId: membership.membership.id,
      role: input.role,
      ...base,
    });
    return {
      membershipId: membership.membership.id,
      userId: membership.user.id,
      email: membership.user.email,
      name: membership.user.name,
      role: input.role,
      status: "ACTIVE",
      passwordChangeRequired: true,
      createdAt: membership.membership.createdAt,
    };
  } catch (error) {
    if (error instanceof OperationRefusedError) refuse(error.reason ?? "refused");
    emitSecurityEvent({
      event: "staff.provisioning_incomplete",
      outcome: "failure",
      reason: "application_step",
      ...base,
    });
    throw new ProvisioningIncompleteError();
  }
}
