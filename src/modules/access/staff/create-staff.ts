import { and, eq } from "drizzle-orm";
import { getDb, schema, type Database } from "@/db";
import { getProvisioningAuth, replaceCredentialPassword } from "@/modules/auth/provisioning";
import { OperationRefusedError, ProvisioningIncompleteError } from "@/shared/errors/http-errors";
import { emitSecurityEvent, hashForLog } from "@/shared/security/events";
import type { AccessContext } from "../access";
import { assertCan } from "../permissions";
import { countMemberships, revalidateActor } from "./guards";
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

type IntentHandle = { id: string; resumed: boolean; authUserId: string | null };

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
  if (inserted) return { id: inserted.id, resumed: false, authUserId: null };
  const [existing] = await db
    .select()
    .from(schema.staffProvisioningIntents)
    .where(eq(schema.staffProvisioningIntents.emailKey, emailKey));
  // Held by another organization (or vanished in a race): refuse without saying which.
  if (!existing || existing.organizationId !== ctx.organizationId) return null;
  return { id: existing.id, resumed: true, authUserId: existing.authUserId };
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
  const provisioner = deps.provisioner ?? getProvisioningAuth();

  try {
    if (!existing) {
      const res = await provisioner.api.signUpEmail({
        body: { name: input.name, email: input.email, password: input.initialPassword },
      });
      // Never trust only the returned object (a duplicate sign-up returns a fabricated id): the persisted row decides.
      const persisted = await findUserByEmail(db, input.email);
      if (!persisted || persisted.id !== res.user.id) throw new Error("provisioned user not found");
      userId = persisted.id;
    } else {
      // Resumable crash of THIS organization's workflow: the intent pre-existed, is ours, is unbound or bound to
      // this very user, and the identity has no membership anywhere. Anything else is an unrelated identity.
      const resumable =
        intent.resumed &&
        (intent.authUserId === null || intent.authUserId === existing.id) &&
        (await db.transaction((tx) => countMemberships(tx, existing.id))) === 0;
      if (!resumable) {
        // A freshly inserted intent is ours to remove; a pre-existing one is left untouched.
        if (!intent.resumed) {
          await db
            .delete(schema.staffProvisioningIntents)
            .where(eq(schema.staffProvisioningIntents.id, intent.id));
        }
        return refuse("existing_identity");
      }
      // Make the retry's initial password the effective one (the crashed attempt's password is unknown here).
      await replaceCredentialPassword(
        provisioner,
        { userId: existing.id, email: input.email },
        input.initialPassword,
      );
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
        locked.emailKey !== input.email
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

      await tx
        .update(schema.staffProvisioningIntents)
        .set({ authUserId: user.id })
        .where(eq(schema.staffProvisioningIntents.id, intent.id));
      await tx
        .insert(schema.userSecurityState)
        .values({ userId: user.id, passwordChangeRequired: true })
        .onConflictDoUpdate({
          target: schema.userSecurityState.userId,
          set: { passwordChangeRequired: true },
        });
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
