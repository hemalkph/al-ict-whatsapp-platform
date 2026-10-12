import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import { listConversations, listMessages, markMessagesSeen } from "./index";
import {
  addActor,
  addConversation,
  addMessage,
  minutesAgo,
  setMembershipStatus,
  world,
} from "./testing";

// Per-staff unread state on real PostgreSQL. A message is "seen" only by the staff member who saw it, and only the exact
// messages the browser displayed are marked, so a late or out-of-order arrival can never be hidden by someone else's reading.

describe("per-staff unread tracking", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());
  const db = () => ({ db: t.db as never });
  const unread = async (ctx: Parameters<typeof listConversations>[0], conversationId: string) =>
    (await listConversations(ctx, { limit: 50 }, db())).items.find((i) => i.id === conversationId)!
      .unreadCount;
  const seen = (
    ctx: Parameters<typeof markMessagesSeen>[0],
    conversationId: string,
    messageIds: string[],
  ) => markMessagesSeen(ctx, conversationId, { messageIds }, db());
  // staff created BEFORE the messages, so the messages count as unread for them
  const team = async () => {
    const x = await world(t.db);
    const b = await addActor(t.db, x.org.id, "STAFF");
    return { x, a: x.actor, b };
  };

  it("staff A reading a conversation does not mark it read for staff B", async () => {
    const { x, a, b } = await team();
    const m1 = await addMessage(t.db, x, { direction: "INBOUND" });
    const m2 = await addMessage(t.db, x, { direction: "INBOUND" });
    expect(await unread(a.ctx, x.conversation.id)).toBe(2);
    expect(await unread(b.ctx, x.conversation.id)).toBe(2);
    expect(await seen(a.ctx, x.conversation.id, [m1.id, m2.id])).toMatchObject({
      marked: 2,
      unreadCount: 0,
    });
    expect(await unread(a.ctx, x.conversation.id)).toBe(0);
    expect(await unread(b.ctx, x.conversation.id)).toBe(2);
  });

  it("a new inbound message is unread, even after everything before it was seen", async () => {
    const { x, a } = await team();
    const m1 = await addMessage(t.db, x, { direction: "INBOUND" });
    await seen(a.ctx, x.conversation.id, [m1.id]);
    await addMessage(t.db, x, { direction: "INBOUND" });
    expect(await unread(a.ctx, x.conversation.id)).toBe(1);
  });

  it("outbound messages, reactions and internal notes never create unread", async () => {
    const { x, a } = await team();
    await addMessage(t.db, x, { direction: "OUTBOUND", body: "ours" });
    await addMessage(t.db, x, {
      direction: "INBOUND",
      type: "REACTION",
      body: null,
      content: { emoji: "👍" },
    });
    await t.pool.query(
      "insert into conversation_notes (organization_id, conversation_id, author_membership_id, body) values ($1,$2,$3,'note')",
      [x.org.id, x.conversation.id, a.membershipId],
    );
    expect(await unread(a.ctx, x.conversation.id)).toBe(0);
  });

  it("marking twice is idempotent", async () => {
    const { x, a } = await team();
    const m = await addMessage(t.db, x, { direction: "INBOUND" });
    expect(await seen(a.ctx, x.conversation.id, [m.id])).toMatchObject({ marked: 1 });
    expect(await seen(a.ctx, x.conversation.id, [m.id, m.id])).toMatchObject({
      marked: 0,
      unreadCount: 0,
    });
    expect(
      (
        await t.pool.query("select count(*)::int n from message_reads where message_id = $1", [
          m.id,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it("an older provider timestamp that arrives later is still unread: there is no timestamp high-water mark", async () => {
    const { x, a } = await team();
    const newer = await addMessage(t.db, x, { direction: "INBOUND", occurredAt: minutesAgo(1) });
    await seen(a.ctx, x.conversation.id, [newer.id]);
    const late = await addMessage(t.db, x, { direction: "INBOUND", occurredAt: minutesAgo(120) }); // committed later, dated earlier
    expect(await unread(a.ctx, x.conversation.id)).toBe(1);
    const timeline = (await listMessages(a.ctx, x.conversation.id, {}, db())).messages;
    expect(timeline.find((m) => m.id === late.id)!.unseen).toBe(true);
    expect(timeline.find((m) => m.id === newer.id)!.unseen).toBe(false);
  });

  it("a message that arrives while another is being marked stays unread", async () => {
    const { x, a } = await team();
    const m1 = await addMessage(t.db, x, { direction: "INBOUND" });
    const [, m2] = await Promise.all([
      seen(a.ctx, x.conversation.id, [m1.id]),
      addMessage(t.db, x, { direction: "INBOUND" }),
    ]);
    expect(await unread(a.ctx, x.conversation.id)).toBe(1);
    expect(
      (await t.pool.query("select 1 from message_reads where message_id = $1", [m2.id])).rowCount,
    ).toBe(0);
  });

  it("only exact, valid inbound messages of THIS conversation can be marked; any other id refuses the whole request", async () => {
    const { x, a } = await team();
    const y = await world(t.db);
    const good = await addMessage(t.db, x, { direction: "INBOUND" });
    const out = await addMessage(t.db, x, { direction: "OUTBOUND", body: "ours" });
    const sibling = await addConversation(t.db, x);
    const sib = await addMessage(
      t.db,
      { org: x.org, account: x.account, conversation: sibling.conversation },
      { direction: "INBOUND" },
    );
    const foreign = await addMessage(t.db, y, { direction: "INBOUND" });
    for (const bad of [out.id, sib.id, foreign.id, "00000000-0000-4000-8000-000000000042"])
      await expect(seen(a.ctx, x.conversation.id, [good.id, bad])).rejects.toBeInstanceOf(
        ValidationError,
      );
    expect(
      (
        await t.pool.query("select count(*)::int n from message_reads where organization_id = $1", [
          x.org.id,
        ])
      ).rows[0].n,
    ).toBe(0); // nothing partial
    await expect(seen(a.ctx, y.conversation.id, [foreign.id])).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(seen(a.ctx, x.conversation.id, [])).rejects.toBeInstanceOf(ValidationError);
    await expect(
      seen(
        a.ctx,
        x.conversation.id,
        Array.from({ length: 101 }, () => good.id),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      markMessagesSeen(
        a.ctx,
        x.conversation.id,
        { messageIds: [good.id], membershipId: "x" },
        db(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("a viewer may mark their own state; a suspended or stale actor may not; marking never queues or sends anything", async () => {
    const x = await world(t.db);
    const viewer = await addActor(t.db, x.org.id, "VIEWER");
    const m = await addMessage(t.db, x, { direction: "INBOUND" });
    expect(await seen(viewer.ctx, x.conversation.id, [m.id])).toMatchObject({ marked: 1 });
    expect(await unread(viewer.ctx, x.conversation.id)).toBe(0);
    expect(await unread(x.actor.ctx, x.conversation.id)).toBe(1); // the staff member's own state is untouched
    const gone = await addActor(t.db, x.org.id, "STAFF");
    await setMembershipStatus(t.db, gone.membershipId, "SUSPENDED");
    await expect(seen(gone.ctx, x.conversation.id, [m.id])).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      (
        await t.pool.query(
          "select count(*)::int n from outbound_requests where organization_id = $1",
          [x.org.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("the Unread filter follows the same per-staff state", async () => {
    const { x, a, b } = await team();
    const m = await addMessage(t.db, x, { direction: "INBOUND" });
    await seen(a.ctx, x.conversation.id, [m.id]);
    expect((await listConversations(a.ctx, { view: "unread" }, db())).items).toHaveLength(0);
    expect(
      (await listConversations(b.ctx, { view: "unread" }, db())).items.map((i) => i.id),
    ).toEqual([x.conversation.id]);
  });
});
