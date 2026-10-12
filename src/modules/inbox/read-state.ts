import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { assertCan, revalidateActor, type AccessContext } from "@/modules/access";
import { NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import type { InboxDeps } from "./list";
import { unreadCountSql, UNREAD_CAP } from "./list";
import { seenSchema } from "./schemas";
import { uuid } from "./text";

// Per-staff "seen" state. One row = THIS staff member has seen THIS inbound message. It is internal bookkeeping for the team:
// it is NOT a WhatsApp read receipt and nothing here can send one (this file has no network and no outbound import).
//
// Why a per-message set and not a timestamp high-water mark: a message can commit late or carry an old provider time, so
// "everything up to time T" could mark a message read that nobody has looked at. Here only the exact messages the browser
// displayed are marked; a message that arrives meanwhile has no row and stays unread. Marking is idempotent.

export type SeenResult = {
  /** How many of the given messages were newly marked (0 when they were all already seen). */
  readonly marked: number;
  readonly unreadCount: number;
  readonly unreadCapped: boolean;
};

export async function markMessagesSeen(
  ctx: AccessContext,
  conversationId: string,
  rawInput: unknown,
  deps: InboxDeps = {},
): Promise<SeenResult> {
  assertCan(ctx, "conversation.read");
  if (!uuid.safeParse(conversationId).success) throw new NotFoundError();
  const parsed = seenSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new ValidationError([
      ...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "body"))),
    ]);
  const ids = [...new Set(parsed.data.messageIds)];
  const db = deps.db ?? getDb();

  return db.transaction(async (tx) => {
    await revalidateActor(tx, ctx, "conversation.read");
    const conversation = await tx
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.organizationId, ctx.organizationId),
          eq(schema.conversations.id, conversationId),
        ),
      );
    if (conversation.length === 0) throw new NotFoundError();

    // Every id must be an INBOUND message of THIS conversation in THIS organization (and its account). An id that is unknown,
    // outbound, in another conversation or in another organization refuses the whole request: nothing is marked.
    const valid = await tx
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.organizationId, ctx.organizationId),
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.direction, "INBOUND"),
          inArray(schema.messages.id, ids),
        ),
      );
    if (valid.length !== ids.length) throw new ValidationError(["messageIds"]);

    const inserted = await tx
      .insert(schema.messageReads)
      .values(
        ids.map((messageId) => ({
          organizationId: ctx.organizationId,
          membershipId: ctx.membershipId,
          messageId,
        })),
      )
      .onConflictDoNothing()
      .returning({ messageId: schema.messageReads.messageId });

    const count = await tx.execute<{ n: number }>(
      sql`SELECT ${unreadCountSql(ctx.membershipId, ctx.organizationId, "cv")} AS n
          FROM (SELECT ${conversationId}::uuid AS id) cv`,
    );
    const n = count.rows[0]?.n ?? 0;
    return {
      marked: inserted.length,
      unreadCount: Math.min(n, UNREAD_CAP),
      unreadCapped: n > UNREAD_CAP,
    };
  });
}
