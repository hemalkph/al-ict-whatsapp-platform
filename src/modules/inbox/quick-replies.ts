import { and, asc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { assertCan, revalidateActor, type AccessContext } from "@/modules/access";
import { NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import { InboxConflictError, UNIQUE_VIOLATION, pgCode } from "./errors";
import { safeText } from "./display";
import { likePattern, type InboxDeps } from "./list";
import { quickReplyCreateSchema, quickReplyListSchema, quickReplyUpdateSchema } from "./schemas";
import { uuid } from "./text";
import type { QuickReplyView } from "./types";

// Quick replies are reusable staff-written TEXT. They are not Meta templates and authorize nothing: selecting one only puts
// its text into the composer (in the browser), and the Phase 05 submission policy (window, recipient, consent, gates) still
// decides whether the typed message may be queued. This module has no outbound import and cannot send.

export const QUICK_REPLIES_MAX_ACTIVE = 200;

type Row = typeof schema.quickReplies.$inferSelect;
const view = (r: Row): QuickReplyView => ({
  id: r.id,
  title: safeText(r.title, 60),
  body: safeText(r.body, 1000),
  archived: r.archivedAt !== null,
});

/** Anyone who can compose (conversation.reply) can list and pick; archived rows are for managers only. */
export async function listQuickReplies(
  ctx: AccessContext,
  rawQuery: unknown,
  deps: InboxDeps = {},
): Promise<QuickReplyView[]> {
  assertCan(ctx, "conversation.reply");
  const parsed = quickReplyListSchema.safeParse(rawQuery);
  if (!parsed.success) throw new ValidationError(["query"]);
  const includeArchived = parsed.data.includeArchived === "true";
  if (includeArchived) assertCan(ctx, "conversation.manage");
  const db = deps.db ?? getDb();
  const term = parsed.data.q ? likePattern(parsed.data.q, "contains") : null;
  const rows = await db
    .select()
    .from(schema.quickReplies)
    .where(
      and(
        eq(schema.quickReplies.organizationId, ctx.organizationId),
        includeArchived ? undefined : isNull(schema.quickReplies.archivedAt),
        term
          ? or(ilike(schema.quickReplies.title, term), ilike(schema.quickReplies.body, term))
          : undefined,
      ),
    )
    .orderBy(asc(sql`lower(${schema.quickReplies.title})`), asc(schema.quickReplies.id))
    .limit(QUICK_REPLIES_MAX_ACTIVE + 50);
  return rows.map(view);
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** Serializes everything that can raise the number of ACTIVE quick replies of an organization (create, restore). */
const lockActiveCount = (tx: Tx, organizationId: string) =>
  tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inbox-quick-replies:${organizationId}`}, 0))`,
  );

async function assertRoomForOneMore(tx: Tx, organizationId: string, field: string) {
  const [active] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.quickReplies)
    .where(
      and(
        eq(schema.quickReplies.organizationId, organizationId),
        isNull(schema.quickReplies.archivedAt),
      ),
    );
  if ((active?.n ?? 0) >= QUICK_REPLIES_MAX_ACTIVE) throw new ValidationError([field]);
}

const duplicate = () =>
  new InboxConflictError("DUPLICATE", "A quick reply with that title already exists.", "title");

export async function createQuickReply(
  ctx: AccessContext,
  rawInput: unknown,
  deps: InboxDeps = {},
): Promise<QuickReplyView> {
  assertCan(ctx, "conversation.manage");
  const parsed = quickReplyCreateSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new ValidationError([
      ...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "body"))),
    ]);
  const db = deps.db ?? getDb();
  try {
    return await db.transaction(async (tx) => {
      await revalidateActor(tx, ctx, "conversation.manage");
      // Serialize creations per organization so the cap cannot be raced past; the unique index is the backstop for titles.
      await lockActiveCount(tx, ctx.organizationId);
      await assertRoomForOneMore(tx, ctx.organizationId, "title");
      const [row] = await tx
        .insert(schema.quickReplies)
        .values({
          organizationId: ctx.organizationId,
          title: parsed.data.title.trim(),
          body: parsed.data.body,
          createdByMembershipId: ctx.membershipId,
        })
        .returning();
      return view(row!);
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw duplicate();
    throw error;
  }
}

export async function updateQuickReply(
  ctx: AccessContext,
  id: string,
  rawInput: unknown,
  deps: InboxDeps = {},
): Promise<QuickReplyView> {
  assertCan(ctx, "conversation.manage");
  if (!uuid.safeParse(id).success) throw new NotFoundError();
  const parsed = quickReplyUpdateSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new ValidationError([
      ...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "body"))),
    ]);
  const input = parsed.data;
  const db = deps.db ?? getDb();
  try {
    return await db.transaction(async (tx) => {
      await revalidateActor(tx, ctx, "conversation.manage");
      // Restoring makes a reply active again, so it is subject to the same cap as creating one, under the same per-organization
      // lock (taken before the row lock; creation never waits on a row lock, so there is no cycle).
      if (input.archived === false) await lockActiveCount(tx, ctx.organizationId);
      const [current] = await tx
        .select()
        .from(schema.quickReplies)
        .where(
          and(
            eq(schema.quickReplies.organizationId, ctx.organizationId),
            eq(schema.quickReplies.id, id),
          ),
        )
        .for("update");
      if (!current) throw new NotFoundError();
      if (input.archived === false && current.archivedAt !== null)
        await assertRoomForOneMore(tx, ctx.organizationId, "archived");
      const [row] = await tx
        .update(schema.quickReplies)
        .set({
          title: input.title === undefined ? undefined : input.title.trim(),
          body: input.body,
          archivedAt:
            input.archived === undefined
              ? undefined
              : input.archived
                ? (current.archivedAt ?? sql`now()`)
                : null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.quickReplies.organizationId, ctx.organizationId),
            eq(schema.quickReplies.id, id),
          ),
        )
        .returning();
      return view(row!);
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw duplicate();
    throw error;
  }
}
