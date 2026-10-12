import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import { PN, tenant } from "@/modules/whatsapp/identity/testing";
import { deliver, handleDirect } from "@/modules/whatsapp/inbound/testing";
import {
  InboxConflictError,
  assignConversation,
  changeConversationStatus,
  getConversationDetail,
  listAssignees,
} from "./index";
import { addActor, addMessage, setMembershipStatus, world } from "./testing";

// Status and assignment on real PostgreSQL: compare-and-set against what the browser saw, the conversation row lock shared
// with the inbound handler, append-only history, and the guarantee that staff actions never move a messaging timestamp.

describe("conversation workflow", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());
  const db = () => ({ db: t.db as never });
  const row = async (id: string) =>
    (await t.pool.query("select * from conversations where id = $1", [id])).rows[0];
  const events = async (id: string) =>
    (
      await t.pool.query(
        "select * from conversation_events where conversation_id = $1 order by created_at, id",
        [id],
      )
    ).rows;
  const status = (
    x: { actor: { ctx: never }; conversation: { id: string } },
    to: string,
    expected: string,
    d = db(),
  ) => changeConversationStatus(x.actor.ctx, x.conversation.id, { to, expected }, d);

  describe("status", () => {
    it("OPEN → PENDING → RESOLVED → OPEN, with resolved_at set only while RESOLVED and one history row per change", async () => {
      const x = await world(t.db);
      expect(await status(x as never, "PENDING", "OPEN")).toEqual({
        changed: true,
        status: "PENDING",
      });
      expect((await row(x.conversation.id)).resolved_at).toBeNull();
      expect(await status(x as never, "RESOLVED", "PENDING")).toEqual({
        changed: true,
        status: "RESOLVED",
      });
      expect((await row(x.conversation.id)).resolved_at).not.toBeNull();
      expect(await status(x as never, "OPEN", "RESOLVED")).toEqual({
        changed: true,
        status: "OPEN",
      });
      expect((await row(x.conversation.id)).resolved_at).toBeNull();
      const log = await events(x.conversation.id);
      expect(log.map((e) => [e.kind, e.from_status, e.to_status, e.actor_membership_id])).toEqual([
        ["STATUS", "OPEN", "PENDING", x.actor.membershipId],
        ["STATUS", "PENDING", "RESOLVED", x.actor.membershipId],
        ["STATUS", "RESOLVED", "OPEN", x.actor.membershipId],
      ]);
    });

    it("asking for the status it already has is an unchanged result and writes no history", async () => {
      const x = await world(t.db);
      expect(await status(x as never, "OPEN", "OPEN")).toEqual({ changed: false, status: "OPEN" });
      expect(await events(x.conversation.id)).toHaveLength(0);
    });

    it("a stale screen cannot overwrite a newer state: 409 STALE_STATE, nothing changes", async () => {
      const x = await world(t.db);
      const other = await addActor(t.db, x.org.id, "STAFF");
      await changeConversationStatus(
        other.ctx,
        x.conversation.id,
        { to: "RESOLVED", expected: "OPEN" },
        db(),
      );
      const err = await status(x as never, "PENDING", "OPEN").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(InboxConflictError);
      expect(err).toMatchObject({ code: "STALE_STATE", httpStatus: 409 });
      expect((await row(x.conversation.id)).status).toBe("RESOLVED");
      expect(await events(x.conversation.id)).toHaveLength(1);
    });

    it("two simultaneous changes from the same screen: exactly one wins, the other is refused as stale", async () => {
      const x = await world(t.db);
      const other = await addActor(t.db, x.org.id, "STAFF");
      const results = await Promise.allSettled([
        changeConversationStatus(
          x.actor.ctx,
          x.conversation.id,
          { to: "PENDING", expected: "OPEN" },
          db(),
        ),
        changeConversationStatus(
          other.ctx,
          x.conversation.id,
          { to: "RESOLVED", expected: "OPEN" },
          db(),
        ),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(InboxConflictError);
      expect(await events(x.conversation.id)).toHaveLength(1);
    });

    it("staff status changes never touch the messaging timestamps, create a message, or send anything", async () => {
      const x = await world(t.db);
      await addMessage(t.db, x, { direction: "INBOUND" });
      const before = await row(x.conversation.id);
      const messagesBefore = (
        await t.pool.query("select count(*)::int n from messages where conversation_id = $1", [
          x.conversation.id,
        ])
      ).rows[0].n;
      await status(x as never, "RESOLVED", "OPEN");
      await status(x as never, "OPEN", "RESOLVED");
      const after = await row(x.conversation.id);
      for (const k of ["last_inbound_at", "last_outbound_at", "last_message_at"])
        expect(after[k]).toEqual(before[k]);
      expect(
        (
          await t.pool.query("select count(*)::int n from messages where conversation_id = $1", [
            x.conversation.id,
          ])
        ).rows[0].n,
      ).toBe(messagesBefore);
      expect(
        (
          await t.pool.query(
            "select count(*)::int n from outbound_requests where conversation_id = $1",
            [x.conversation.id],
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it("a viewer, a suspended or demoted actor, another organization and bad input are all refused", async () => {
      const x = await world(t.db);
      const viewer = await addActor(t.db, x.org.id, "VIEWER");
      await expect(
        changeConversationStatus(
          viewer.ctx,
          x.conversation.id,
          { to: "PENDING", expected: "OPEN" },
          db(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const stale = await addActor(t.db, x.org.id, "STAFF");
      await setMembershipStatus(t.db, stale.membershipId, "SUSPENDED"); // the AccessContext below is now stale
      await expect(
        changeConversationStatus(
          stale.ctx,
          x.conversation.id,
          { to: "PENDING", expected: "OPEN" },
          db(),
        ),
      ).rejects.toMatchObject({ reason: "stale_actor" });
      const y = await world(t.db);
      await expect(
        changeConversationStatus(
          y.actor.ctx,
          x.conversation.id,
          { to: "PENDING", expected: "OPEN" },
          db(),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      for (const bad of [
        { to: "DONE", expected: "OPEN" },
        { to: "PENDING" },
        { to: "PENDING", expected: "OPEN", organizationId: x.org.id },
        null,
      ])
        await expect(
          changeConversationStatus(x.actor.ctx, x.conversation.id, bad, db()),
        ).rejects.toBeInstanceOf(ValidationError);
      expect((await row(x.conversation.id)).status).toBe("OPEN");
      expect(await events(x.conversation.id)).toHaveLength(0);
    });

    it("a new inbound message still reopens a RESOLVED conversation (Phase 04 rule) and a stale screen is then refused", async () => {
      const { org } = await tenant(t.db, { pn: PN, waba: "200000000000001" });
      const first = await deliver(t.db, {
        from: "15550100321",
        timestamp: new Date(Date.now() - 60_000),
      });
      await handleDirect(t.db, first);
      const conv = (
        await t.pool.query("select * from conversations where organization_id = $1", [org.id])
      ).rows[0];
      const actor = await addActor(t.db, org.id, "STAFF");
      await changeConversationStatus(
        actor.ctx,
        conv.id,
        { to: "RESOLVED", expected: "OPEN" },
        db(),
      );
      const resolved = await row(conv.id);
      expect(resolved.status).toBe("RESOLVED");
      const inboundBefore = resolved.last_inbound_at;

      const reply = await deliver(t.db, {
        from: "15550100321",
        timestamp: new Date(Date.now() + 3000),
      });
      await handleDirect(t.db, reply);
      const reopened = await row(conv.id);
      expect(reopened.status).toBe("OPEN");
      expect(reopened.resolved_at).toBeNull();
      expect(new Date(reopened.last_inbound_at).getTime()).toBeGreaterThan(
        new Date(inboundBefore).getTime(),
      );
      // the screen that still shows RESOLVED must not be able to overwrite what the customer just reopened
      await expect(
        changeConversationStatus(actor.ctx, conv.id, { to: "PENDING", expected: "RESOLVED" }, db()),
      ).rejects.toBeInstanceOf(InboxConflictError);
      expect((await row(conv.id)).status).toBe("OPEN");
    });

    it("an inbound message arriving while staff resolve cannot be lost: both orders end in a consistent state", async () => {
      const { org } = await tenant(t.db, { pn: "100000000000011", waba: "200000000000011" });
      const first = await deliver(t.db, {
        pn: "100000000000011",
        waba: "200000000000011",
        from: "15550100444",
        timestamp: new Date(Date.now() - 60_000),
      });
      await handleDirect(t.db, first);
      const conv = (
        await t.pool.query("select * from conversations where organization_id = $1", [org.id])
      ).rows[0];
      const actor = await addActor(t.db, org.id, "STAFF");
      const incoming = await deliver(t.db, {
        pn: "100000000000011",
        waba: "200000000000011",
        from: "15550100444",
        timestamp: new Date(Date.now() + 2000),
      });
      const results = await Promise.allSettled([
        handleDirect(t.db, incoming),
        changeConversationStatus(actor.ctx, conv.id, { to: "RESOLVED", expected: "OPEN" }, db()),
      ]);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const end = await row(conv.id);
      // either the customer's message came last (OPEN) or staff resolved after it (RESOLVED); never a half state
      if (end.status === "RESOLVED") expect(end.resolved_at).not.toBeNull();
      else expect(end.resolved_at).toBeNull();
      expect(
        (
          await t.pool.query(
            "select count(*)::int n from messages where conversation_id = $1 and direction='INBOUND'",
            [conv.id],
          )
        ).rows[0].n,
      ).toBe(2);
    });
  });

  describe("assignment", () => {
    it("assign to me, assign to another member, reassign and unassign, each with one history row", async () => {
      const x = await world(t.db);
      const other = await addActor(t.db, x.org.id, "STAFF");
      const asg = (to: string | null, expected: string | null) =>
        assignConversation(
          x.actor.ctx,
          x.conversation.id,
          { assigneeMembershipId: to, expectedAssigneeMembershipId: expected },
          db(),
        );
      expect(await asg(x.actor.membershipId, null)).toEqual({
        changed: true,
        assigneeMembershipId: x.actor.membershipId,
      });
      expect((await row(x.conversation.id)).assigned_membership_id).toBe(x.actor.membershipId);
      expect((await row(x.conversation.id)).assigned_at).not.toBeNull();
      await asg(other.membershipId, x.actor.membershipId);
      await asg(null, other.membershipId);
      const after = await row(x.conversation.id);
      expect(after.assigned_membership_id).toBeNull();
      expect(after.assigned_at).toBeNull();
      expect(
        (await events(x.conversation.id)).map((e) => [
          e.kind,
          e.from_assignee_membership_id,
          e.to_assignee_membership_id,
          e.actor_membership_id,
        ]),
      ).toEqual([
        ["ASSIGNMENT", null, x.actor.membershipId, x.actor.membershipId],
        ["ASSIGNMENT", x.actor.membershipId, other.membershipId, x.actor.membershipId],
        ["ASSIGNMENT", other.membershipId, null, x.actor.membershipId],
      ]);
      const detail = await getConversationDetail(x.actor.ctx, x.conversation.id, db());
      expect(detail.history.map((h) => [h.kind, h.to])).toEqual([
        ["ASSIGNMENT", null],
        ["ASSIGNMENT", detail.history[1]!.to],
        ["ASSIGNMENT", detail.history[2]!.to],
      ]);
    });

    it("assigning the current assignee again, or unassigning an unassigned conversation, changes nothing", async () => {
      const x = await world(t.db);
      expect(
        await assignConversation(
          x.actor.ctx,
          x.conversation.id,
          { assigneeMembershipId: null, expectedAssigneeMembershipId: null },
          db(),
        ),
      ).toEqual({ changed: false, assigneeMembershipId: null });
      await assignConversation(
        x.actor.ctx,
        x.conversation.id,
        { assigneeMembershipId: x.actor.membershipId, expectedAssigneeMembershipId: null },
        db(),
      );
      expect(
        (
          await assignConversation(
            x.actor.ctx,
            x.conversation.id,
            {
              assigneeMembershipId: x.actor.membershipId,
              expectedAssigneeMembershipId: x.actor.membershipId,
            },
            db(),
          )
        ).changed,
      ).toBe(false);
      expect(await events(x.conversation.id)).toHaveLength(1);
    });

    it("only an ACTIVE member of THIS organization whose role can work conversations may be assigned; every other case is the same refusal", async () => {
      const x = await world(t.db);
      const y = await world(t.db);
      const suspended = await addActor(t.db, x.org.id, "STAFF");
      await setMembershipStatus(t.db, suspended.membershipId, "SUSPENDED");
      const viewer = await addActor(t.db, x.org.id, "VIEWER");
      const admin = await addActor(t.db, x.org.id, "ADMIN");
      for (const target of [
        suspended.membershipId,
        viewer.membershipId,
        y.actor.membershipId,
        "00000000-0000-4000-8000-000000000042",
      ])
        await expect(
          assignConversation(
            x.actor.ctx,
            x.conversation.id,
            { assigneeMembershipId: target, expectedAssigneeMembershipId: null },
            db(),
          ),
        ).rejects.toBeInstanceOf(ValidationError);
      expect((await row(x.conversation.id)).assigned_membership_id).toBeNull();
      expect(await events(x.conversation.id)).toHaveLength(0);
      expect(
        (
          await assignConversation(
            x.actor.ctx,
            x.conversation.id,
            { assigneeMembershipId: admin.membershipId, expectedAssigneeMembershipId: null },
            db(),
          )
        ).changed,
      ).toBe(true);
    });

    it("a stale screen is refused; two simultaneous assignments produce exactly one winner and one history row", async () => {
      const x = await world(t.db);
      const a = await addActor(t.db, x.org.id, "STAFF");
      const b = await addActor(t.db, x.org.id, "STAFF");
      const results = await Promise.allSettled([
        assignConversation(
          a.ctx,
          x.conversation.id,
          { assigneeMembershipId: a.membershipId, expectedAssigneeMembershipId: null },
          db(),
        ),
        assignConversation(
          b.ctx,
          x.conversation.id,
          { assigneeMembershipId: b.membershipId, expectedAssigneeMembershipId: null },
          db(),
        ),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
      ).toBeInstanceOf(InboxConflictError);
      const current = (await row(x.conversation.id)).assigned_membership_id;
      expect([a.membershipId, b.membershipId]).toContain(current);
      expect(await events(x.conversation.id)).toHaveLength(1);
    });

    it("a member suspended later stays assigned (never silently moved), is flagged, can be replaced, and the history keeps them", async () => {
      const x = await world(t.db);
      const gone = await addActor(t.db, x.org.id, "STAFF");
      await assignConversation(
        x.actor.ctx,
        x.conversation.id,
        { assigneeMembershipId: gone.membershipId, expectedAssigneeMembershipId: null },
        db(),
      );
      await setMembershipStatus(t.db, gone.membershipId, "SUSPENDED");
      expect((await row(x.conversation.id)).assigned_membership_id).toBe(gone.membershipId);
      const detail = await getConversationDetail(x.actor.ctx, x.conversation.id, db());
      expect(detail.assignee).toMatchObject({ membershipId: gone.membershipId, suspended: true });
      await assignConversation(
        x.actor.ctx,
        x.conversation.id,
        {
          assigneeMembershipId: x.actor.membershipId,
          expectedAssigneeMembershipId: gone.membershipId,
        },
        db(),
      );
      const log = await events(x.conversation.id);
      expect(log[1]!.from_assignee_membership_id).toBe(gone.membershipId);
    });

    it("a suspension that is in flight cannot be raced past: the assignment waits and is then refused", async () => {
      const x = await world(t.db);
      const target = await addActor(t.db, x.org.id, "STAFF");
      const holder = await t.pool.connect();
      try {
        await holder.query("begin");
        await holder.query("select 1 from organization_memberships where id = $1 for update", [
          target.membershipId,
        ]);
        const assigning = assignConversation(
          x.actor.ctx,
          x.conversation.id,
          { assigneeMembershipId: target.membershipId, expectedAssigneeMembershipId: null },
          db(),
        ).then(
          () => "assigned",
          (e: unknown) => e,
        );
        for (let i = 0; i < 200; i++) {
          const waiting = await t.pool.query(
            "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
          );
          if (waiting.rows[0].n > 0) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        await holder.query(
          "update organization_memberships set status = 'SUSPENDED' where id = $1",
          [target.membershipId],
        );
        await holder.query("commit");
        expect(await assigning).toBeInstanceOf(ValidationError);
      } finally {
        holder.release();
      }
      expect((await row(x.conversation.id)).assigned_membership_id).toBeNull();
    });

    it("a viewer, another organization's staff and bad input are refused; the assignee list shows only eligible staff of the caller's organization", async () => {
      const x = await world(t.db);
      const y = await world(t.db);
      const viewer = await addActor(t.db, x.org.id, "VIEWER");
      const off = await addActor(t.db, x.org.id, "STAFF");
      await setMembershipStatus(t.db, off.membershipId, "SUSPENDED");
      await expect(
        assignConversation(
          viewer.ctx,
          x.conversation.id,
          { assigneeMembershipId: null, expectedAssigneeMembershipId: null },
          db(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        assignConversation(
          y.actor.ctx,
          x.conversation.id,
          { assigneeMembershipId: null, expectedAssigneeMembershipId: null },
          db(),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        assignConversation(
          x.actor.ctx,
          x.conversation.id,
          { assigneeMembershipId: "nope", expectedAssigneeMembershipId: null },
          db(),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(listAssignees(viewer.ctx, db())).rejects.toBeInstanceOf(ForbiddenError);
      const list = await listAssignees(x.actor.ctx, db());
      expect(list.map((a) => a.membershipId)).toContain(x.actor.membershipId);
      expect(list.map((a) => a.membershipId)).not.toContain(viewer.membershipId);
      expect(list.map((a) => a.membershipId)).not.toContain(off.membershipId);
      expect(list.map((a) => a.membershipId)).not.toContain(y.actor.membershipId);
      expect(Object.keys(list[0]!).sort()).toEqual(["membershipId", "name", "role"]); // no email, no user id
    });

    it("assignment changes never move a messaging timestamp", async () => {
      const x = await world(t.db);
      const before = await row(x.conversation.id);
      await assignConversation(
        x.actor.ctx,
        x.conversation.id,
        { assigneeMembershipId: x.actor.membershipId, expectedAssigneeMembershipId: null },
        db(),
      );
      const after = await row(x.conversation.id);
      for (const k of ["last_inbound_at", "last_outbound_at", "last_message_at", "status"])
        expect(after[k]).toEqual(before[k]);
    });
  });
});
