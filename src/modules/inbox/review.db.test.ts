import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { ValidationError } from "@/shared/errors/http-errors";
import { PN, tenant } from "@/modules/whatsapp/identity/testing";
import { deliver, handleDirect } from "@/modules/whatsapp/inbound/testing";
import {
  assignConversation,
  changeConversationStatus,
  createQuickReply,
  updateQuickReply,
} from "./index";
import { QUICK_REPLIES_MAX_ACTIVE } from "./quick-replies";
import { addActor, world } from "./testing";

// Phase 06 review corrections on real PostgreSQL: the transition time is taken after the lock (M3) and restoring an archived
// quick reply obeys the same cap as creating one (L2).

describe("review corrections", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());
  const db = () => ({ db: t.db as never });
  const row = async (id: string) =>
    (await t.pool.query("select * from conversations where id = $1", [id])).rows[0];

  /** Waits until some backend is blocked on a lock (the transaction under test is queued behind the holder). */
  async function waitUntilBlocked() {
    for (let i = 0; i < 500; i++) {
      const waiting = await t.pool.query(
        "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      );
      if (waiting.rows[0].n > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("the transaction under test never blocked on the lock");
  }

  describe("M3: the transition is stamped after the conversation row lock is obtained", () => {
    it("resolved_at, updated_at and the history row carry the post-lock time, not the transaction start", async () => {
      const x = await world(t.db);
      const before = await row(x.conversation.id);
      const holder = await t.pool.connect();
      let released: string;
      try {
        await holder.query("begin");
        await holder.query("select 1 from conversations where id = $1 for update", [
          x.conversation.id,
        ]);
        const resolving = changeConversationStatus(
          x.actor.ctx,
          x.conversation.id,
          { to: "RESOLVED", expected: "OPEN" },
          db(),
        );
        await waitUntilBlocked();
        await holder.query("select pg_sleep(0.05)"); // the wait is real time on the database clock
        released = (await holder.query("select clock_timestamp()::text t")).rows[0].t;
        await holder.query("commit");
        expect(await resolving).toEqual({ changed: true, status: "RESOLVED" });
      } finally {
        holder.release();
      }
      const after = await row(x.conversation.id);
      const q = await t.pool.query(
        `select (c.resolved_at > $2::timestamptz) AS after_release,
                (c.resolved_at = c.updated_at) AS same_instant,
                (e.created_at = c.resolved_at) AS history_same
         FROM conversations c JOIN conversation_events e ON e.conversation_id = c.id
         WHERE c.id = $1`,
        [x.conversation.id, released],
      );
      expect(q.rows[0]).toEqual({ after_release: true, same_instant: true, history_same: true });
      // a staff action never moves a messaging timestamp
      for (const k of ["last_inbound_at", "last_outbound_at", "last_message_at"])
        expect(after[k]).toEqual(before[k]);
    });

    it("assignment is stamped the same way (assigned_at, updated_at and the history row agree, after the lock)", async () => {
      const x = await world(t.db);
      const peer = await addActor(t.db, x.org.id, "STAFF");
      const holder = await t.pool.connect();
      let released: string;
      try {
        await holder.query("begin");
        await holder.query("select 1 from conversations where id = $1 for update", [
          x.conversation.id,
        ]);
        const assigning = assignConversation(
          x.actor.ctx,
          x.conversation.id,
          { assigneeMembershipId: peer.membershipId, expectedAssigneeMembershipId: null },
          db(),
        );
        await waitUntilBlocked();
        await holder.query("select pg_sleep(0.05)");
        released = (await holder.query("select clock_timestamp()::text t")).rows[0].t;
        await holder.query("commit");
        await assigning;
      } finally {
        holder.release();
      }
      const q = await t.pool.query(
        `select (c.assigned_at > $2::timestamptz) AS after_release, (c.assigned_at = c.updated_at) AS same_instant,
                (e.created_at = c.assigned_at) AS history_same
         FROM conversations c JOIN conversation_events e ON e.conversation_id = c.id WHERE c.id = $1`,
        [x.conversation.id, released],
      );
      expect(q.rows[0]).toEqual({ after_release: true, same_instant: true, history_same: true });
    });

    it("a customer message timestamped DURING the lock wait predates the resolution, so it does not reopen the conversation", async () => {
      const { org } = await tenant(t.db, { pn: PN, waba: "200000000000101" });
      await handleDirect(
        t.db,
        await deliver(t.db, {
          waba: "200000000000101",
          from: "15550100777",
          timestamp: new Date(Date.now() - 60_000),
        }),
      );
      const conv = (
        await t.pool.query("select * from conversations where organization_id = $1", [org.id])
      ).rows[0];
      const actor = await addActor(t.db, org.id, "STAFF");

      const holder = await t.pool.connect();
      let during: Date;
      try {
        await holder.query("begin");
        await holder.query("select 1 from conversations where id = $1 for update", [conv.id]);
        const resolving = changeConversationStatus(
          actor.ctx,
          conv.id,
          { to: "RESOLVED", expected: "OPEN" },
          db(),
        );
        await waitUntilBlocked();
        // Provider timestamps have one-second resolution. Waiting 1.1 s guarantees the whole second below lies inside the
        // wait: after the resolving transaction began, before the lock is released.
        await holder.query("select pg_sleep(1.1)");
        const now = (await holder.query("select clock_timestamp() t")).rows[0].t as Date;
        during = new Date(Math.floor(now.getTime() / 1000) * 1000);
        await holder.query("commit");
        await resolving;
      } finally {
        holder.release();
      }
      const resolvedAt = new Date((await row(conv.id)).resolved_at).getTime();
      expect(resolvedAt).toBeGreaterThan(during.getTime()); // stamped after the wait (xact-start time would be earlier)

      await handleDirect(
        t.db,
        await deliver(t.db, { waba: "200000000000101", from: "15550100777", timestamp: during }),
      );
      const final = await row(conv.id);
      expect(final.status).toBe("RESOLVED"); // the message is older than the resolution
      expect(new Date(final.last_inbound_at).getTime()).toBeGreaterThanOrEqual(during.getTime());

      // and a message that really is newer reopens it, exactly as before
      await handleDirect(
        t.db,
        await deliver(t.db, {
          waba: "200000000000101",
          from: "15550100777",
          timestamp: new Date(Date.now() + 3000),
        }),
      );
      expect((await row(conv.id)).status).toBe("OPEN");
    });
  });

  describe("L2: restoring an archived quick reply obeys the active cap", () => {
    async function fill(orgId: string, membershipId: string, active: number, archived: number) {
      await t.pool.query(
        "insert into quick_replies (organization_id, title, body, created_by_membership_id) select $1, 'a' || g, 'b', $2 from generate_series(1, $3::int) g",
        [orgId, membershipId, active],
      );
      await t.pool.query(
        "insert into quick_replies (organization_id, title, body, created_by_membership_id, archived_at) select $1, 'z' || g, 'b', $2, now() from generate_series(1, $3::int) g",
        [orgId, membershipId, archived],
      );
    }
    const archivedIds = async (orgId: string) =>
      (
        await t.pool.query(
          "select id from quick_replies where organization_id = $1 and archived_at is not null order by title",
          [orgId],
        )
      ).rows.map((r) => r.id as string);
    const activeCount = async (orgId: string) =>
      (
        await t.pool.query(
          "select count(*)::int n from quick_replies where organization_id = $1 and archived_at is null",
          [orgId],
        )
      ).rows[0].n as number;

    it("is refused at the cap, allowed again after one is archived, and leaves other organizations alone", async () => {
      const x = await world(t.db);
      const other = await world(t.db);
      await fill(x.org.id, x.actor.membershipId, QUICK_REPLIES_MAX_ACTIVE, 1);
      await fill(other.org.id, other.actor.membershipId, 1, 1);
      const [archived] = await archivedIds(x.org.id);

      await expect(
        updateQuickReply(x.actor.ctx, archived!, { archived: false }, db()),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await activeCount(x.org.id)).toBe(QUICK_REPLIES_MAX_ACTIVE);
      // creating is still refused too (same rule)
      await expect(
        createQuickReply(x.actor.ctx, { title: "one more", body: "b" }, db()),
      ).rejects.toBeInstanceOf(ValidationError);

      const [someActive] = (
        await t.pool.query(
          "select id from quick_replies where organization_id = $1 and archived_at is null limit 1",
          [x.org.id],
        )
      ).rows;
      await updateQuickReply(x.actor.ctx, someActive.id, { archived: true }, db());
      const restored = await updateQuickReply(x.actor.ctx, archived!, { archived: false }, db());
      expect(restored.archived).toBe(false);
      expect(await activeCount(x.org.id)).toBe(QUICK_REPLIES_MAX_ACTIVE);

      // the other organization (far below its cap) is unaffected by the first one being full
      const [theirs] = await archivedIds(other.org.id);
      expect(
        (await updateQuickReply(other.actor.ctx, theirs!, { archived: false }, db())).archived,
      ).toBe(false);
    });

    it("two restores racing for the last slot: exactly one succeeds", async () => {
      const x = await world(t.db);
      await fill(x.org.id, x.actor.membershipId, QUICK_REPLIES_MAX_ACTIVE - 1, 2);
      const [a, b] = await archivedIds(x.org.id);
      const results = await Promise.allSettled([
        updateQuickReply(x.actor.ctx, a!, { archived: false }, db()),
        updateQuickReply(x.actor.ctx, b!, { archived: false }, db()),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ValidationError);
      expect(await activeCount(x.org.id)).toBe(QUICK_REPLIES_MAX_ACTIVE);
    });

    it("a restore racing a create for the last slot: exactly one wins", async () => {
      const x = await world(t.db);
      await fill(x.org.id, x.actor.membershipId, QUICK_REPLIES_MAX_ACTIVE - 1, 1);
      const [a] = await archivedIds(x.org.id);
      const results = await Promise.allSettled([
        updateQuickReply(x.actor.ctx, a!, { archived: false }, db()),
        createQuickReply(x.actor.ctx, { title: "newcomer", body: "b" }, db()),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await activeCount(x.org.id)).toBe(QUICK_REPLIES_MAX_ACTIVE);
    });

    it("restoring still respects title uniqueness among active replies, and editing without restoring is not capped", async () => {
      const x = await world(t.db);
      const first = await createQuickReply(x.actor.ctx, { title: "Hello", body: "1" }, db());
      await updateQuickReply(x.actor.ctx, first.id, { archived: true }, db());
      await createQuickReply(x.actor.ctx, { title: "hello", body: "2" }, db());
      await expect(
        updateQuickReply(x.actor.ctx, first.id, { archived: false }, db()),
      ).rejects.toMatchObject({ code: "DUPLICATE" });

      const y = await world(t.db);
      await fill(y.org.id, y.actor.membershipId, QUICK_REPLIES_MAX_ACTIVE, 1);
      const [anyActive] = (
        await t.pool.query(
          "select id from quick_replies where organization_id = $1 and archived_at is null limit 1",
          [y.org.id],
        )
      ).rows;
      await updateQuickReply(y.actor.ctx, anyActive.id, { body: "edited at the cap" }, db());
    });
  });
});
