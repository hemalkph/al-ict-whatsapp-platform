import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import {
  InboxConflictError,
  addContactTag,
  createNote,
  createQuickReply,
  createTag,
  getConversationDetail,
  listAvailableTags,
  listNotes,
  listQuickReplies,
  removeContactTag,
  updateQuickReply,
} from "./index";
import { addActor, addMessage, setMembershipStatus, world } from "./testing";

// Internal notes, contact tags and quick replies on real PostgreSQL: scoping, permissions, bounds, and the guarantee that none
// of them is a WhatsApp message or moves any timestamp.

describe("notes, tags and quick replies", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());
  const db = () => ({ db: t.db as never });
  const conv = async (id: string) =>
    (await t.pool.query("select * from conversations where id = $1", [id])).rows[0];

  describe("internal notes", () => {
    it("are created with their author, listed newest first with paging, and stay out of WhatsApp entirely", async () => {
      const x = await world(t.db);
      const other = await addActor(t.db, x.org.id, "STAFF");
      await addMessage(t.db, x, { direction: "INBOUND" });
      const before = await conv(x.conversation.id);
      const messagesBefore = (await t.pool.query("select count(*)::int n from messages")).rows[0].n;
      const n1 = await createNote(
        x.actor.ctx,
        x.conversation.id,
        { body: "Student asked about the next ICT theory class." },
        db(),
      );
      await createNote(
        other.ctx,
        x.conversation.id,
        { body: "ශිෂ්‍යයා ලියාපදිංචිය ගැන ඇසුවා" },
        db(),
      );
      await createNote(x.actor.ctx, x.conversation.id, { body: "<b>follow up</b>" }, db());
      expect(n1).toMatchObject({ body: "Student asked about the next ICT theory class." });
      const page = await listNotes(x.actor.ctx, x.conversation.id, { limit: 2 }, db());
      expect(page.notes.map((n) => n.body)).toEqual([
        "<b>follow up</b>",
        "ශිෂ්‍යයා ලියාපදිංචිය ගැන ඇසුවා",
      ]);
      expect(page.nextCursor).not.toBeNull();
      const rest = await listNotes(
        x.actor.ctx,
        x.conversation.id,
        { limit: 2, before: page.nextCursor! },
        db(),
      );
      expect(rest.notes.map((n) => n.body)).toEqual([
        "Student asked about the next ICT theory class.",
      ]);
      expect(rest.nextCursor).toBeNull();
      // not messages, not outbound, no conversation change at all
      expect((await t.pool.query("select count(*)::int n from messages")).rows[0].n).toBe(
        messagesBefore,
      );
      expect(
        (
          await t.pool.query(
            "select count(*)::int n from outbound_requests where conversation_id = $1",
            [x.conversation.id],
          )
        ).rows[0].n,
      ).toBe(0);
      const after = await conv(x.conversation.id);
      expect(after).toEqual(before);
    });

    it("need conversation.manage to read or write: a viewer sees none; another organization is a 404; a suspended author is refused", async () => {
      const x = await world(t.db);
      const y = await world(t.db);
      const viewer = await addActor(t.db, x.org.id, "VIEWER");
      await createNote(x.actor.ctx, x.conversation.id, { body: "private" }, db());
      await expect(listNotes(viewer.ctx, x.conversation.id, {}, db())).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(
        createNote(viewer.ctx, x.conversation.id, { body: "x" }, db()),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listNotes(y.actor.ctx, x.conversation.id, {}, db())).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        createNote(y.actor.ctx, x.conversation.id, { body: "x" }, db()),
      ).rejects.toBeInstanceOf(NotFoundError);
      const gone = await addActor(t.db, x.org.id, "STAFF");
      await setMembershipStatus(t.db, gone.membershipId, "SUSPENDED");
      await expect(
        createNote(gone.ctx, x.conversation.id, { body: "x" }, db()),
      ).rejects.toMatchObject({ reason: "stale_actor" });
      const detail = await getConversationDetail(viewer.ctx, x.conversation.id, db());
      expect(JSON.stringify(detail)).not.toContain("private"); // notes are never part of the detail a viewer receives
    });

    it("are bounded and exact: blank, over-long, control characters and unknown keys are rejected", async () => {
      const x = await world(t.db);
      for (const body of ["", "   ", "x".repeat(4001), "a\u0000b", "a\u0007b", "\ud800"])
        await expect(
          createNote(x.actor.ctx, x.conversation.id, { body }, db()),
        ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        createNote(
          x.actor.ctx,
          x.conversation.id,
          { body: "ok", conversationId: x.conversation.id },
          db(),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(
        (await createNote(x.actor.ctx, x.conversation.id, { body: "x".repeat(4000) }, db())).body,
      ).toHaveLength(4000);
      expect(
        (await createNote(x.actor.ctx, x.conversation.id, { body: "line 1\nline 2\tend" }, db()))
          .body,
      ).toBe("line 1\nline 2\tend");
    });
  });

  describe("contact tags", () => {
    it("add, remove and duplicate prevention reuse the existing tables; nothing else about the contact changes", async () => {
      const x = await world(t.db, { waId: "94771230000", bsuids: [{ bsuid: "LK.TagTest0001" }] });
      const { tag } = await createTag(x.actor.ctx, { name: "Maths class" }, db());
      const contactBefore = (
        await t.pool.query("select * from contacts where id = $1", [x.contact.id])
      ).rows[0];
      const aliasesBefore = (
        await t.pool.query("select * from contact_bsuids where contact_id = $1", [x.contact.id])
      ).rows;
      expect(await addContactTag(x.actor.ctx, x.contact.id, { tagId: tag.id }, db())).toEqual({
        added: true,
      });
      expect(await addContactTag(x.actor.ctx, x.contact.id, { tagId: tag.id }, db())).toEqual({
        added: false,
      }); // no duplicate
      expect(
        (
          await t.pool.query("select count(*)::int n from contact_tags where contact_id = $1", [
            x.contact.id,
          ])
        ).rows[0].n,
      ).toBe(1);
      const detail = await getConversationDetail(x.actor.ctx, x.conversation.id, db());
      expect(detail.contact.tags).toEqual([
        { id: tag.id, name: "Maths class", color: null, archived: false },
      ]);
      expect(await removeContactTag(x.actor.ctx, x.contact.id, tag.id, db())).toEqual({
        removed: true,
      });
      expect(await removeContactTag(x.actor.ctx, x.contact.id, tag.id, db())).toEqual({
        removed: false,
      });
      expect(
        (await t.pool.query("select * from contacts where id = $1", [x.contact.id])).rows[0],
      ).toEqual(contactBefore);
      expect(
        (await t.pool.query("select * from contact_bsuids where contact_id = $1", [x.contact.id]))
          .rows,
      ).toEqual(aliasesBefore);
      expect(
        (
          await t.pool.query("select count(*)::int n from leads where organization_id = $1", [
            x.org.id,
          ])
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await t.pool.query(
            "select count(*)::int n from outbound_requests where organization_id = $1",
            [x.org.id],
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it("tag definitions are organization-scoped, unique ignoring case and spaces, and creating the same tag again returns it", async () => {
      const x = await world(t.db);
      const y = await world(t.db);
      const first = await createTag(x.actor.ctx, { name: "Theory" }, db());
      expect(first.created).toBe(true);
      const again = await createTag(x.actor.ctx, { name: "  theory " }, db());
      expect(again).toMatchObject({ created: false, tag: { id: first.tag.id } });
      const theirs = await createTag(y.actor.ctx, { name: "Theory" }, db());
      expect(theirs.tag.id).not.toBe(first.tag.id); // independent per organization
      expect((await listAvailableTags(x.actor.ctx, db())).map((tag) => tag.id)).toEqual([
        first.tag.id,
      ]);
      await expect(createTag(x.actor.ctx, { name: "" }, db())).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(createTag(x.actor.ctx, { name: "x".repeat(41) }, db())).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(createTag(x.actor.ctx, { name: "two\nlines" }, db())).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("an archived tag cannot be added or re-created, is hidden from the picker, and an existing link is still shown and removable", async () => {
      const x = await world(t.db);
      const { tag } = await createTag(x.actor.ctx, { name: "Old batch" }, db());
      await addContactTag(x.actor.ctx, x.contact.id, { tagId: tag.id }, db());
      await t.pool.query("update tags set archived_at = now() where id = $1", [tag.id]);
      expect(await listAvailableTags(x.actor.ctx, db())).toEqual([]);
      const detail = await getConversationDetail(x.actor.ctx, x.conversation.id, db());
      expect(detail.contact.tags).toEqual([
        { id: tag.id, name: "Old batch", color: null, archived: true },
      ]);
      const other = await world(t.db);
      await t.pool.query("update tags set archived_at = null where id = $1", [tag.id]);
      const { tag: t2 } = await createTag(x.actor.ctx, { name: "Another" }, db());
      await t.pool.query("update tags set archived_at = now() where id = $1", [t2.id]);
      await expect(
        addContactTag(x.actor.ctx, x.contact.id, { tagId: t2.id }, db()),
      ).rejects.toMatchObject({ code: "ARCHIVED" });
      await expect(createTag(x.actor.ctx, { name: "another" }, db())).rejects.toBeInstanceOf(
        InboxConflictError,
      );
      await t.pool.query("update tags set archived_at = now() where id = $1", [tag.id]);
      expect(await removeContactTag(x.actor.ctx, x.contact.id, tag.id, db())).toEqual({
        removed: true,
      });
      void other;
    });

    it("a contact or tag of another organization is refused the same way as a missing one; viewers cannot change tags", async () => {
      const x = await world(t.db);
      const y = await world(t.db);
      const viewer = await addActor(t.db, x.org.id, "VIEWER");
      const mine = (await createTag(x.actor.ctx, { name: "Mine" }, db())).tag;
      const theirs = (await createTag(y.actor.ctx, { name: "Theirs" }, db())).tag;
      await expect(
        addContactTag(x.actor.ctx, x.contact.id, { tagId: theirs.id }, db()),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        addContactTag(x.actor.ctx, y.contact.id, { tagId: mine.id }, db()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        removeContactTag(x.actor.ctx, y.contact.id, mine.id, db()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        addContactTag(x.actor.ctx, "nope", { tagId: mine.id }, db()),
      ).rejects.toBeInstanceOf(NotFoundError);
      for (const attempt of [
        () => addContactTag(viewer.ctx, x.contact.id, { tagId: mine.id }, db()),
        () => removeContactTag(viewer.ctx, x.contact.id, mine.id, db()),
        () => createTag(viewer.ctx, { name: "Nope" }, db()),
        () => listAvailableTags(viewer.ctx, db()),
      ])
        await expect(attempt()).rejects.toBeInstanceOf(ForbiddenError);
      expect(
        (
          await t.pool.query(
            "select count(*)::int n from contact_tags where organization_id = $1",
            [x.org.id],
          )
        ).rows[0].n,
      ).toBe(0);
    });
  });

  describe("quick replies", () => {
    it("create, list, edit, archive and un-archive; a title is unique among active replies, ignoring case", async () => {
      const x = await world(t.db);
      const created = await createQuickReply(
        x.actor.ctx,
        { title: "Greeting", body: "Hello! How can we help you with the ICT class?" },
        db(),
      );
      expect(created).toMatchObject({ title: "Greeting", archived: false });
      await expect(
        createQuickReply(x.actor.ctx, { title: " greeting ", body: "dup" }, db()),
      ).rejects.toMatchObject({ code: "DUPLICATE" });
      const edited = await updateQuickReply(
        x.actor.ctx,
        created.id,
        { body: "Our next theory session begins on Sunday." },
        db(),
      );
      expect(edited.body).toBe("Our next theory session begins on Sunday.");
      expect(
        (await updateQuickReply(x.actor.ctx, created.id, { archived: true }, db())).archived,
      ).toBe(true);
      expect(await listQuickReplies(x.actor.ctx, {}, db())).toEqual([]);
      expect(
        (await listQuickReplies(x.actor.ctx, { includeArchived: "true" }, db())).map((q) => q.id),
      ).toEqual([created.id]);
      const reuse = await createQuickReply(
        x.actor.ctx,
        { title: "Greeting", body: "new one" },
        db(),
      ); // title is free again
      await expect(
        updateQuickReply(x.actor.ctx, created.id, { archived: false }, db()),
      ).rejects.toMatchObject({ code: "DUPLICATE" });
      expect((await listQuickReplies(x.actor.ctx, {}, db())).map((q) => q.id)).toEqual([reuse.id]);
    });

    it("are organization-scoped; searchable; viewers cannot list or manage them; bounds are enforced", async () => {
      const x = await world(t.db);
      const y = await world(t.db);
      const viewer = await addActor(t.db, x.org.id, "VIEWER");
      const a = await createQuickReply(
        x.actor.ctx,
        { title: "Fees", body: "The monthly fee is Rs. 2500" },
        db(),
      );
      await createQuickReply(x.actor.ctx, { title: "Schedule", body: "Sunday 8am" }, db());
      expect(await listQuickReplies(y.actor.ctx, {}, db())).toEqual([]);
      await expect(
        updateQuickReply(y.actor.ctx, a.id, { body: "hijack" }, db()),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(
        (await t.pool.query("select body from quick_replies where id = $1", [a.id])).rows[0].body,
      ).toBe("The monthly fee is Rs. 2500");
      expect((await listQuickReplies(x.actor.ctx, { q: "fee" }, db())).map((q) => q.title)).toEqual(
        ["Fees"],
      );
      expect(await listQuickReplies(x.actor.ctx, { q: "%%" }, db())).toEqual([]);
      await expect(listQuickReplies(viewer.ctx, {}, db())).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        createQuickReply(viewer.ctx, { title: "x", body: "y" }, db()),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateQuickReply(viewer.ctx, a.id, { body: "z" }, db())).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      for (const bad of [
        { title: "", body: "x" },
        { title: "t".repeat(61), body: "x" },
        { title: "a\nb", body: "x" },
        { title: "ok", body: "" },
        { title: "ok", body: "b".repeat(1001) },
        { title: "ok", body: "x", extra: 1 },
      ])
        await expect(createQuickReply(x.actor.ctx, bad, db())).rejects.toBeInstanceOf(
          ValidationError,
        );
      await expect(updateQuickReply(x.actor.ctx, a.id, {}, db())).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("using the quick-reply endpoints never creates a message, a request or any outbound activity", async () => {
      const x = await world(t.db);
      const q = await createQuickReply(x.actor.ctx, { title: "Hi", body: "Hello" }, db());
      await listQuickReplies(x.actor.ctx, { q: "hi" }, db());
      await updateQuickReply(x.actor.ctx, q.id, { archived: true }, db());
      expect(
        (
          await t.pool.query(
            "select count(*)::int n from outbound_requests where organization_id = $1",
            [x.org.id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await t.pool.query("select count(*)::int n from messages where organization_id = $1", [
            x.org.id,
          ])
        ).rows[0].n,
      ).toBe(0);
    });

    it("the active quick-reply count is capped per organization", async () => {
      const x = await world(t.db);
      await t.pool.query(
        "insert into quick_replies (organization_id, title, body, created_by_membership_id) select $1, 'q' || g, 'b', $2 from generate_series(1, 200) g",
        [x.org.id, x.actor.membershipId],
      );
      await expect(
        createQuickReply(x.actor.ctx, { title: "one too many", body: "b" }, db()),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
