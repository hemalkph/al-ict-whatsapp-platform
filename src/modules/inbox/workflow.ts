import { and, eq, sql } from "drizzle-orm";
import { getDb, schema, type Database } from "@/db";
import { assertCan, can, revalidateActor, type AccessContext } from "@/modules/access";
import { NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import { staleState } from "./errors";
import type { InboxDeps } from "./list";
import { assignmentSchema, statusChangeSchema } from "./schemas";
import { uuid } from "./text";
import type { AssigneeOption, ConversationStatus } from "./types";

// Staff workflow on a conversation: status and assignment. Both are compare-and-set against what the browser last saw, inside
// a transaction that first locks the conversation row. That lock is the same row lock the inbound handler takes when it
// reopens a conversation, so the two serialize: a change made from a stale screen is refused (409) and nothing is overwritten
// silently. Neither operation touches last_inbound_at, last_outbound_at or last_message_at, creates a message, or sends
// anything, so staff actions can never open or extend the 24-hour messaging window.

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const fieldsOf = (issues: ReadonlyArray<{ path: PropertyKey[] }>) => [
  ...new Set(issues.map((i) => String(i.path[0] ?? "body"))),
];

async function lockConversation(tx: Tx, organizationId: string, conversationId: string) {
  if (!uuid.safeParse(conversationId).success) throw new NotFoundError();
  const [row] = await tx
    .select({
      id: schema.conversations.id,
      status: schema.conversations.status,
      assignedMembershipId: schema.conversations.assignedMembershipId,
    })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.organizationId, organizationId),
        eq(schema.conversations.id, conversationId),
      ),
    )
    .for("update");
  // Another organization's conversation is the same 404 as a missing one.
  if (!row) throw new NotFoundError();
  return row;
}

/**
 * The moment of a transition, read AFTER the conversation row lock was obtained. now() is the transaction's START time, which a
 * lock wait can leave far in the past: a resolution that waited would then be stamped before the messages that arrived while it
 * waited. One value (kept as microsecond text) stamps the row, its updated_at and the history row together.
 */
async function transitionTime(tx: Tx): Promise<ReturnType<typeof sql>> {
  const res = await tx.execute<{ t: string }>(sql`select clock_timestamp()::text as t`);
  return sql`${res.rows[0]!.t}::timestamptz`;
}

export type StatusChangeResult = {
  readonly changed: boolean;
  readonly status: ConversationStatus;
};

export async function changeConversationStatus(
  ctx: AccessContext,
  conversationId: string,
  rawInput: unknown,
  deps: InboxDeps = {},
): Promise<StatusChangeResult> {
  assertCan(ctx, "conversation.manage");
  const parsed = statusChangeSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(fieldsOf(parsed.error.issues));
  const { to, expected } = parsed.data;
  const db = deps.db ?? getDb();

  return db.transaction(async (tx) => {
    await revalidateActor(tx, ctx, "conversation.manage");
    const row = await lockConversation(tx, ctx.organizationId, conversationId);
    if (row.status !== expected) throw staleState("status");
    if (to === row.status) return { changed: false, status: row.status };
    const at = await transitionTime(tx);
    await tx
      .update(schema.conversations)
      .set({
        status: to,
        // resolved_at is when staff resolved it; leaving RESOLVED clears it. The inbound handler's reopen rule compares the
        // customer's effective time with it, exactly as for a conversation resolved before this phase.
        resolvedAt: to === "RESOLVED" ? at : null,
        updatedAt: at,
      })
      .where(
        and(
          eq(schema.conversations.organizationId, ctx.organizationId),
          eq(schema.conversations.id, row.id),
        ),
      );
    await tx.insert(schema.conversationEvents).values({
      organizationId: ctx.organizationId,
      conversationId: row.id,
      kind: "STATUS",
      actorMembershipId: ctx.membershipId,
      fromStatus: row.status,
      toStatus: to,
      createdAt: at,
    });
    return { changed: true, status: to };
  });
}

export type AssignmentResult = {
  readonly changed: boolean;
  readonly assigneeMembershipId: string | null;
};

export async function assignConversation(
  ctx: AccessContext,
  conversationId: string,
  rawInput: unknown,
  deps: InboxDeps = {},
): Promise<AssignmentResult> {
  assertCan(ctx, "conversation.manage");
  const parsed = assignmentSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(fieldsOf(parsed.error.issues));
  const { assigneeMembershipId: target, expectedAssigneeMembershipId: expected } = parsed.data;
  const db = deps.db ?? getDb();

  return db.transaction(async (tx) => {
    await revalidateActor(tx, ctx, "conversation.manage");
    const row = await lockConversation(tx, ctx.organizationId, conversationId);
    if (row.assignedMembershipId !== expected) throw staleState("assignee");
    if (target === row.assignedMembershipId)
      return { changed: false, assigneeMembershipId: target };

    if (target !== null) {
      // The assignee must be an ACTIVE member of THIS organization whose role can work conversations. Locked FOR SHARE so a
      // concurrent suspension waits for this transaction (or is seen by it). Every way of being ineligible (another
      // organization's member, a suspended or viewer member, a member that does not exist) is the same generic refusal.
      const [member] = await tx
        .select({
          role: schema.organizationMemberships.role,
          status: schema.organizationMemberships.status,
        })
        .from(schema.organizationMemberships)
        .where(
          and(
            eq(schema.organizationMemberships.organizationId, ctx.organizationId),
            eq(schema.organizationMemberships.id, target),
          ),
        )
        .for("share");
      if (!member || member.status !== "ACTIVE" || !can(member.role, "conversation.reply"))
        throw new ValidationError(["assigneeMembershipId"]);
    }
    const at = await transitionTime(tx);
    await tx
      .update(schema.conversations)
      .set({
        assignedMembershipId: target,
        assignedAt: target === null ? null : at,
        updatedAt: at,
      })
      .where(
        and(
          eq(schema.conversations.organizationId, ctx.organizationId),
          eq(schema.conversations.id, row.id),
        ),
      );
    await tx.insert(schema.conversationEvents).values({
      organizationId: ctx.organizationId,
      conversationId: row.id,
      kind: "ASSIGNMENT",
      actorMembershipId: ctx.membershipId,
      fromAssigneeMembershipId: row.assignedMembershipId,
      toAssigneeMembershipId: target,
      createdAt: at,
    });
    return { changed: true, assigneeMembershipId: target };
  });
}

/** Staff who can currently be assigned: ACTIVE members of the caller's organization whose role can reply. */
export async function listAssignees(
  ctx: AccessContext,
  deps: InboxDeps = {},
): Promise<AssigneeOption[]> {
  assertCan(ctx, "conversation.manage");
  const db = deps.db ?? getDb();
  const rows = await db
    .select({
      membershipId: schema.organizationMemberships.id,
      name: schema.users.name,
      role: schema.organizationMemberships.role,
    })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, ctx.organizationId),
        eq(schema.organizationMemberships.status, "ACTIVE"),
      ),
    );
  return rows
    .filter((r) => can(r.role, "conversation.reply"))
    .map((r) => ({ membershipId: r.membershipId, name: r.name, role: r.role }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.membershipId.localeCompare(b.membershipId));
}
