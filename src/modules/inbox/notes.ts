import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { assertCan, revalidateActor, type AccessContext } from "@/modules/access";
import { NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import { decodeCursor, encodeCursor } from "./cursor";
import { safeLine, safeText } from "./display";
import type { InboxDeps } from "./list";
import { noteSchema, notesQuerySchema } from "./schemas";
import { uuid } from "./text";
import type { NotePage, NoteView } from "./types";

// Internal notes. A note belongs to a conversation of the caller's organization and records its author's membership. It is
// not a message: it is stored in its own table, never reaches the outbound path or Meta, is never counted as unread, and
// does not touch the conversation row at all (so it cannot move any timestamp or the 24-hour window). Reading and writing both
// need conversation.manage (ADMIN and STAFF): a read-only VIEWER never sees internal notes. Note text is never logged.

async function requireConversation(
  db: NonNullable<InboxDeps["db"]>,
  organizationId: string,
  conversationId: string,
) {
  if (!uuid.safeParse(conversationId).success) throw new NotFoundError();
  const found = await db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.organizationId, organizationId),
        eq(schema.conversations.id, conversationId),
      ),
    );
  if (found.length === 0) throw new NotFoundError();
}

export async function listNotes(
  ctx: AccessContext,
  conversationId: string,
  rawQuery: unknown,
  deps: InboxDeps = {},
): Promise<NotePage> {
  assertCan(ctx, "conversation.manage");
  const parsed = notesQuerySchema.safeParse(rawQuery);
  if (!parsed.success)
    throw new ValidationError([
      ...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "query"))),
    ]);
  const q = parsed.data;
  const cursor = q.before === undefined ? null : decodeCursor(q.before);
  if (q.before !== undefined && cursor === null) throw new ValidationError(["before"]);
  const db = deps.db ?? getDb();
  await requireConversation(db, ctx.organizationId, conversationId);

  const result = await db.execute<{
    id: string;
    body: string;
    created_at: Date;
    cursor_t: string;
    author_name: string | null;
  }>(sql`
    SELECT n.id, n.body, n.created_at,
           to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_t,
           u.name AS author_name
    FROM conversation_notes n
    LEFT JOIN organization_memberships m ON m.organization_id = n.organization_id AND m.id = n.author_membership_id
    LEFT JOIN users u ON u.id = m.user_id
    WHERE n.organization_id = ${ctx.organizationId}::uuid AND n.conversation_id = ${conversationId}::uuid
      ${cursor ? sql`AND (n.created_at, n.id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : sql``}
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT ${q.limit + 1}`);
  const page = result.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    notes: page.map((n) => ({
      id: n.id,
      body: safeText(n.body, 4000),
      createdAt: new Date(n.created_at).toISOString(),
      authorName: safeLine(n.author_name, 80) || "Staff member",
    })),
    nextCursor:
      result.rows.length > q.limit && last ? encodeCursor({ t: last.cursor_t, id: last.id }) : null,
  };
}

export async function createNote(
  ctx: AccessContext,
  conversationId: string,
  rawInput: unknown,
  deps: InboxDeps = {},
): Promise<NoteView> {
  assertCan(ctx, "conversation.manage");
  const parsed = noteSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new ValidationError([
      ...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "body"))),
    ]);
  const db = deps.db ?? getDb();
  return db.transaction(async (tx) => {
    await revalidateActor(tx, ctx, "conversation.manage");
    await requireConversation(tx, ctx.organizationId, conversationId);
    const [row] = await tx
      .insert(schema.conversationNotes)
      .values({
        organizationId: ctx.organizationId,
        conversationId,
        authorMembershipId: ctx.membershipId,
        body: parsed.data.body,
      })
      .returning();
    const [author] = await tx
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, ctx.userId));
    return {
      id: row!.id,
      body: safeText(row!.body, 4000),
      createdAt: row!.createdAt.toISOString(),
      authorName: safeLine(author?.name, 80) || "Staff member",
    };
  });
}
