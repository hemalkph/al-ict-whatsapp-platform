import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import { submitOutboundMessage } from "@/modules/messaging";
import { getConversationDetail, listConversations, listMessages } from "./index";
import {
  ON,
  addAccount,
  addActor,
  addConversation,
  addMessage,
  forceRequestState,
  minutesAgo,
  world,
} from "./testing";

// The read side of the inbox on real PostgreSQL: organization scoping, filters, search, keyset pagination, previews, unread
// counts, the contact panel and the message timeline (ordering, replies, attachments, delivery display).

describe("inbox read side", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());
  const db = () => ({ db: t.db as never });

  const ids = (page: { items: Array<{ id: string }> }) => page.items.map((i) => i.id);

  describe("conversation list", () => {
    it("shows only the caller's organization, with the contact, account, preview, status and assignee", async () => {
      const a = await world(t.db);
      const b = await world(t.db);
      await addMessage(t.db, a, { direction: "INBOUND", body: "ICT theory class කොහොමද?" });
      await addMessage(t.db, b, { direction: "INBOUND", body: "secret of org B" });
      const page = await listConversations(a.actor.ctx, {}, db());
      expect(ids(page)).toEqual([a.conversation.id]);
      const [item] = page.items;
      expect(item).toMatchObject({
        status: "OPEN",
        account: { id: a.account.id, label: "+94 77 000 0000" },
        assignee: null,
        preview: { direction: "INBOUND", text: "ICT theory class කොහොමද?" },
        unreadCount: 1,
        unreadCapped: false,
      });
      expect(JSON.stringify(page)).not.toContain("secret of org B");
    });

    it("an empty inbox is an empty page", async () => {
      const x = await world(t.db);
      await t.pool.query("delete from conversations where id = $1", [x.conversation.id]);
      expect(await listConversations(x.actor.ctx, {}, db())).toEqual({
        items: [],
        nextCursor: null,
      });
    });

    it("names: profile name, else username, else a neutral fallback with only a short id tail; BSUID-only contacts work", async () => {
      const x = await world(t.db);
      await t.pool.query("delete from conversations where id = $1", [x.conversation.id]);
      const named = await addConversation(t.db, x, { profileName: "Nimal Perera" });
      const user = await addConversation(t.db, x, { profileName: null, username: "@kasun_ict" });
      const bare = await addConversation(t.db, x, { waId: "94771234821" });
      const bsuid = await addConversation(t.db, x, { waId: null, bsuid: "LK.AbCd1234efgh" });
      const page = await listConversations(x.actor.ctx, { limit: 50 }, db());
      const by = (id: string) => page.items.find((i) => i.id === id)!;
      expect(by(named.conversation.id).contact).toMatchObject({
        displayName: "Nimal Perera",
        named: true,
      });
      expect(by(user.conversation.id).contact).toMatchObject({
        displayName: "@kasun_ict",
        named: true,
      });
      expect(by(bare.conversation.id).contact).toEqual({
        displayName: "Unnamed contact",
        named: false,
        idHint: "…4821",
      });
      expect(by(bsuid.conversation.id).contact).toEqual({
        displayName: "Unnamed contact",
        named: false,
        idHint: "…efgh",
      });
      expect(JSON.stringify(page)).not.toContain("94771234821");
      expect(JSON.stringify(page)).not.toContain("LK.AbCd1234efgh");
    });

    it("a hostile profile name is shown as safe text: control and bidi-override characters are removed and the length is bounded", async () => {
      const x = await world(t.db);
      await t.pool.query("delete from conversations where id = $1", [x.conversation.id]);
      const bidi = String.fromCharCode(0x202e); // right-to-left override
      const bell = String.fromCharCode(7);
      const zeroWidth = String.fromCharCode(0x200b);
      const c = await addConversation(t.db, x, {
        profileName: `${bidi}Evil<script>alert(1)</script>${bell}${zeroWidth}${"x".repeat(300)}`,
      });
      const [item] = (await listConversations(x.actor.ctx, {}, db())).items;
      expect(item!.id).toBe(c.conversation.id);
      for (const code of [0x202e, 7, 0x200b])
        expect(item!.contact.displayName.includes(String.fromCharCode(code))).toBe(false);
      expect(item!.contact.displayName.length).toBeLessThanOrEqual(80);
      expect(item!.contact.displayName).toContain("<script>"); // returned as TEXT; React renders it escaped
    });

    it("orders by last activity (newest first) with a stable tiebreak, and keyset pagination never skips or repeats", async () => {
      const x = await world(t.db);
      await t.pool.query("delete from conversations where id = $1", [x.conversation.id]);
      const created: string[] = [];
      const same = new Date("2026-06-01T10:00:00.123456Z");
      for (let i = 0; i < 7; i++)
        created.push(
          (await addConversation(t.db, x, { lastMessageAt: i < 4 ? same : minutesAgo(i * 10) }))
            .conversation.id,
        );
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await listConversations(x.actor.ctx, { limit: 3, cursor }, db());
        seen.push(...ids(page));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      expect([...seen].sort()).toEqual([...created].sort());
      const all = await listConversations(x.actor.ctx, { limit: 50 }, db());
      expect(ids(all)).toEqual(seen); // identical order whatever the page size
    });

    it("a malformed, foreign or forged cursor is refused, never used", async () => {
      const x = await world(t.db);
      for (const cursor of [
        "nonsense",
        "e30",
        "a".repeat(500),
        Buffer.from('{"t":"x","id":"y"}').toString("base64url"),
      ])
        await expect(listConversations(x.actor.ctx, { cursor }, db())).rejects.toBeInstanceOf(
          ValidationError,
        );
    });

    it("filters: status, assigned to me, unassigned, unread, and WhatsApp account", async () => {
      const x = await world(t.db);
      const other = await addActor(t.db, x.org.id, "STAFF");
      await t.pool.query("delete from conversations where id = $1", [x.conversation.id]);
      const second = await addAccount(t.db, x.org.id, "+94 71 999 0000");
      const open = await addConversation(t.db, x, { status: "OPEN" });
      const pending = await addConversation(t.db, x, { status: "PENDING" });
      const resolved = await addConversation(t.db, x, { status: "RESOLVED" });
      const mine = await addConversation(t.db, x, { assignedMembershipId: x.actor.membershipId });
      const theirs = await addConversation(t.db, x, { assignedMembershipId: other.membershipId });
      const onSecond = await addConversation(t.db, x, { accountId: second.id });
      await addMessage(
        t.db,
        { org: x.org, account: x.account, conversation: open.conversation },
        { direction: "INBOUND" },
      );
      const ctx = x.actor.ctx;
      expect(ids(await listConversations(ctx, { view: "PENDING" }, db()))).toEqual([
        pending.conversation.id,
      ]);
      expect(ids(await listConversations(ctx, { view: "RESOLVED" }, db()))).toEqual([
        resolved.conversation.id,
      ]);
      expect(ids(await listConversations(ctx, { view: "mine" }, db()))).toEqual([
        mine.conversation.id,
      ]);
      expect(ids(await listConversations(ctx, { view: "unread" }, db()))).toEqual([
        open.conversation.id,
      ]);
      const unassigned = ids(await listConversations(ctx, { view: "unassigned", limit: 50 }, db()));
      expect(unassigned).toContain(open.conversation.id);
      expect(unassigned).not.toContain(mine.conversation.id);
      expect(unassigned).not.toContain(theirs.conversation.id);
      expect(ids(await listConversations(ctx, { accountId: second.id }, db()))).toEqual([
        onSecond.conversation.id,
      ]);
      expect(
        ids(
          await listConversations(ctx, { accountId: x.account.id, view: "OPEN", limit: 50 }, db()),
        ),
      ).toContain(open.conversation.id);
    });

    it("search: bounded, matches name, username, phone prefix and exact BSUID; wildcards are literal; never crosses organizations", async () => {
      const x = await world(t.db);
      const y = await world(t.db);
      await t.pool.query("delete from conversations where id = any($1)", [
        [x.conversation.id, y.conversation.id],
      ]);
      const nimal = await addConversation(t.db, x, {
        profileName: "Nimal Perera",
        waId: "94770001111",
      });
      const kasun = await addConversation(t.db, x, {
        profileName: "Kasun_100%",
        waId: "94770002222",
      });
      const user = await addConversation(t.db, x, { profileName: null, username: "tamil_student" });
      const alias = await addConversation(t.db, x, { waId: null, bsuid: "LK.ExactBsuid9" });
      const foreign = await addConversation(t.db, y, {
        profileName: "Nimal Foreign",
        waId: "94770001999",
      });
      const ctx = x.actor.ctx;
      const find = async (q: string) => ids(await listConversations(ctx, { q }, db()));
      expect(await find("nim")).toEqual([nimal.conversation.id]);
      expect(await find("TAMIL")).toEqual([user.conversation.id]);
      expect(await find("9477000")).toHaveLength(2); // phone-id prefix
      expect(await find("LK.ExactBsuid9")).toEqual([alias.conversation.id]);
      expect(await find("LK.Exact")).toEqual([]); // a BSUID matches exactly, not by fragment
      expect(await find("%%")).toEqual([]); // not a wildcard
      expect(await find("100%")).toEqual([kasun.conversation.id]);
      expect(await find("__")).toEqual([]);
      expect(await find("Nimal")).not.toContain(foreign.conversation.id);
      for (const q of ["a", "x".repeat(65)])
        await expect(listConversations(ctx, { q }, db())).rejects.toBeInstanceOf(ValidationError);
    });

    it("previews and unread counts: outbound and notes-like activity do not count; non-text types get safe placeholders", async () => {
      const x = await world(t.db);
      await addMessage(t.db, x, { direction: "INBOUND", body: "one" });
      await addMessage(t.db, x, {
        direction: "INBOUND",
        type: "REACTION",
        body: null,
        content: { emoji: "👍" },
      });
      await addMessage(t.db, x, {
        direction: "OUTBOUND",
        body: "reply",
        occurredAt: new Date(Date.now() + 1000),
      });
      const [item] = (await listConversations(x.actor.ctx, {}, db())).items;
      expect(item!.unreadCount).toBe(1); // the text only: reactions and outbound do not count
      expect(item!.preview).toEqual({ direction: "OUTBOUND", text: "reply" });
      const y = await world(t.db);
      await addMessage(t.db, y, { direction: "INBOUND", type: "IMAGE", body: null });
      expect((await listConversations(y.actor.ctx, {}, db())).items[0]!.preview!.text).toBe(
        "Photo",
      );
    });

    it("a new staff member does not inherit the old backlog as unread, and unread is capped at 99", async () => {
      const x = await world(t.db);
      for (let i = 0; i < 3; i++)
        await addMessage(t.db, x, { direction: "INBOUND", createdAt: minutesAgo(60) });
      const newcomer = await addActor(t.db, x.org.id, "STAFF"); // membership created now, after those messages
      expect((await listConversations(newcomer.ctx, {}, db())).items[0]!.unreadCount).toBe(0);
      expect((await listConversations(x.actor.ctx, {}, db())).items[0]!.unreadCount).toBe(0); // x.actor existed before? no: created after
      const y = await world(t.db);
      await t.pool.query(
        "insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at) select $1, $2, $3, 'INBOUND', 'TEXT', 'm', now() from generate_series(1, 120)",
        [y.org.id, y.conversation.id, y.account.id],
      );
      expect((await listConversations(y.actor.ctx, {}, db())).items[0]).toMatchObject({
        unreadCount: 99,
        unreadCapped: true,
      });
    });

    it("a viewer can read the list", async () => {
      const x = await world(t.db, { role: "VIEWER" });
      expect((await listConversations(x.actor.ctx, {}, db())).items).toHaveLength(1);
    });

    it("unknown query keys are rejected", async () => {
      const x = await world(t.db);
      await expect(
        listConversations(x.actor.ctx, { organizationId: x.org.id }, db()),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("conversation detail", () => {
    it("returns the contact panel, history and capabilities for the caller's role", async () => {
      const x = await world(t.db, { waId: "94771234567" });
      const d = await getConversationDetail(x.actor.ctx, x.conversation.id, db());
      expect(d).toMatchObject({
        id: x.conversation.id,
        status: "OPEN",
        account: { id: x.account.id },
        assignee: null,
        contact: {
          marketingConsent: "UNKNOWN",
          identity: {
            hasCurrentBsuid: false,
            lastObservedPhone: "94771234567",
            phoneIsHistorical: false,
          },
          tags: [],
        },
        history: [],
        can: { reply: true, manage: true, editContact: true, manageTags: true },
      });
      const viewer = await addActor(t.db, x.org.id, "VIEWER");
      const v = await getConversationDetail(viewer.ctx, x.conversation.id, db());
      expect(v.can).toEqual({ reply: false, manage: false, editContact: false, manageTags: false });
    });

    it("a historical phone on a contact seen with a BSUID is flagged as not verified current", async () => {
      const x = await world(t.db, { waId: "94771234567", bsuids: [{ bsuid: "LK.Hist00001" }] });
      const d = await getConversationDetail(x.actor.ctx, x.conversation.id, db());
      expect(d.contact.identity).toMatchObject({
        hasCurrentBsuid: true,
        bsuidTail: "…t00001",
        lastObservedPhone: "94771234567",
        phoneIsHistorical: true,
      });
    });

    it("reply readiness mirrors the outbound policy and never queues anything", async () => {
      const open = await world(t.db, { lastInboundAt: minutesAgo(30) });
      const closed = await world(t.db, { lastInboundAt: minutesAgo(48 * 60) });
      process.env.WHATSAPP_OUTBOUND_ENABLED = "true";
      try {
        expect(
          (await getConversationDetail(open.actor.ctx, open.conversation.id, db())).reply,
        ).toMatchObject({
          outboundEnabled: true,
          canQueueText: true,
          reason: null,
        });
        expect(
          (await getConversationDetail(closed.actor.ctx, closed.conversation.id, db())).reply,
        ).toMatchObject({
          canQueueText: false,
          reason: "window_closed",
        });
      } finally {
        delete process.env.WHATSAPP_OUTBOUND_ENABLED;
      }
      expect(
        (await getConversationDetail(open.actor.ctx, open.conversation.id, db())).reply,
      ).toMatchObject({
        outboundEnabled: false,
        canQueueText: false,
        reason: "outbound_disabled",
      });
      expect(
        (
          await t.pool.query("select 1 from outbound_requests where conversation_id = any($1)", [
            [open.conversation.id, closed.conversation.id],
          ])
        ).rowCount,
      ).toBe(0);
    });

    it("another organization's conversation and a malformed id are the same 404", async () => {
      const a = await world(t.db);
      const b = await world(t.db);
      await expect(
        getConversationDetail(a.actor.ctx, b.conversation.id, db()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(getConversationDetail(a.actor.ctx, "not-a-uuid", db())).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        getConversationDetail(a.actor.ctx, "00000000-0000-4000-8000-000000000000", db()),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("message timeline", () => {
    it("returns the newest page oldest-first, with keyset paging to older messages and no repeats", async () => {
      const x = await world(t.db);
      const base = Date.now() - 3_600_000;
      const created: string[] = [];
      for (let i = 0; i < 12; i++)
        created.push(
          (await addMessage(t.db, x, { body: `m${i}`, occurredAt: new Date(base + i * 1000) })).id,
        );
      const first = await listMessages(x.actor.ctx, x.conversation.id, { limit: 5 }, db());
      expect(first.messages.map((m) => m.text)).toEqual(["m7", "m8", "m9", "m10", "m11"]);
      expect(first.olderCursor).not.toBeNull();
      const second = await listMessages(
        x.actor.ctx,
        x.conversation.id,
        { limit: 5, before: first.olderCursor! },
        db(),
      );
      expect(second.messages.map((m) => m.text)).toEqual(["m2", "m3", "m4", "m5", "m6"]);
      const third = await listMessages(
        x.actor.ctx,
        x.conversation.id,
        { limit: 5, before: second.olderCursor! },
        db(),
      );
      expect(third.messages.map((m) => m.text)).toEqual(["m0", "m1"]);
      expect(third.olderCursor).toBeNull();
    });

    it("identical provider timestamps keep a stable order (row id tiebreak)", async () => {
      const x = await world(t.db);
      const at = new Date(Date.now() - 60_000);
      for (let i = 0; i < 6; i++) await addMessage(t.db, x, { body: `t${i}`, occurredAt: at });
      const a = await listMessages(x.actor.ctx, x.conversation.id, { limit: 50 }, db());
      const b = await listMessages(x.actor.ctx, x.conversation.id, { limit: 50 }, db());
      expect(a.messages.map((m) => m.id)).toEqual(b.messages.map((m) => m.id));
      const paged: string[] = [];
      let before: string | undefined;
      for (let i = 0; i < 6; i++) {
        const p = await listMessages(x.actor.ctx, x.conversation.id, { limit: 2, before }, db());
        paged.unshift(...p.messages.map((m) => m.id));
        if (!p.olderCursor) break;
        before = p.olderCursor;
      }
      expect(paged).toEqual(a.messages.map((m) => m.id));
    });

    it("messages of another conversation, another account and another organization are never included", async () => {
      const x = await world(t.db);
      const y = await world(t.db);
      await addMessage(t.db, x, { body: "mine" });
      const sibling = await addConversation(t.db, x);
      await addMessage(
        t.db,
        { org: x.org, account: x.account, conversation: sibling.conversation },
        { body: "sibling conversation" },
      );
      await addMessage(t.db, y, { body: "other org" });
      const page = await listMessages(x.actor.ctx, x.conversation.id, {}, db());
      expect(page.messages.map((m) => m.text)).toEqual(["mine"]);
      await expect(listMessages(x.actor.ctx, y.conversation.id, {}, db())).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("Sinhala and Tamil text is returned exactly; HTML is returned as plain text", async () => {
      const x = await world(t.db);
      const si = "ICT පන්තිය ඉරිදා ආරම්භ වේ";
      const ta = "ICT வகுப்பு ஞாயிற்றுக்கிழமை";
      const html = '<img src=x onerror="alert(1)"> &amp; <b>bold</b>';
      for (const [i, body] of [si, ta, html].entries())
        await addMessage(t.db, x, { body, occurredAt: new Date(Date.now() - 10_000 + i) });
      const texts = (await listMessages(x.actor.ctx, x.conversation.id, {}, db())).messages.map(
        (m) => m.text,
      );
      expect(texts).toEqual([si, ta, html]);
    });

    it("unsupported and non-text types get safe placeholders; attachments show metadata only (no storage keys)", async () => {
      const x = await world(t.db);
      const img = await addMessage(t.db, x, {
        type: "IMAGE",
        body: "caption",
        occurredAt: new Date(Date.now() - 5000),
      });
      await t.pool.query(
        "insert into message_attachments (organization_id, message_id, meta_media_id, mime_type, size_bytes, filename, storage_key, storage_status) values ($1,$2,'media-1','image/jpeg',2048,'photo.jpg','private/key/123','PENDING')",
        [x.org.id, img.id],
      );
      await addMessage(t.db, x, {
        type: "UNKNOWN",
        body: null,
        content: { rawType: "order" },
        occurredAt: new Date(Date.now() - 4000),
      });
      await addMessage(t.db, x, {
        type: "CONTACT",
        body: null,
        content: { contacts: [{ name: "Private Person", phones: ["0771111111"] }] },
        occurredAt: new Date(Date.now() - 3000),
      });
      await addMessage(t.db, x, {
        type: "LOCATION",
        body: "Library",
        content: { address: "Main Street" },
        occurredAt: new Date(Date.now() - 2000),
      });
      const msgs = (await listMessages(x.actor.ctx, x.conversation.id, {}, db())).messages;
      expect(msgs[0]).toMatchObject({
        placeholder: "Photo",
        text: "caption",
        media: [
          { mimeType: "image/jpeg", filename: "photo.jpg", sizeBytes: 2048, state: "PENDING" },
        ],
      });
      expect(msgs[1]).toMatchObject({ placeholder: "Unsupported message", text: null });
      expect(msgs[2]).toMatchObject({ placeholder: "Shared contact card", text: null });
      expect(msgs[3]).toMatchObject({ placeholder: "Location", text: "Library · Main Street" });
      const raw = JSON.stringify(msgs);
      expect(raw).not.toMatch(/private\/key|media-1|Private Person|0771111111/);
    });

    it("reply relationships: a resolved parent shows a preview; an unresolved wamid is marked unresolved", async () => {
      const x = await world(t.db);
      const parent = await addMessage(t.db, x, {
        direction: "OUTBOUND",
        body: "Class starts at 8",
        wamid: "wamid.P1",
        occurredAt: new Date(Date.now() - 9000),
      });
      await addMessage(t.db, x, {
        body: "ok thanks",
        replyToMessageId: parent.id,
        replyToWamid: "wamid.P1",
        occurredAt: new Date(Date.now() - 8000),
      });
      await addMessage(t.db, x, {
        body: "what about earlier?",
        replyToWamid: "wamid.GONE",
        occurredAt: new Date(Date.now() - 7000),
      });
      const msgs = (await listMessages(x.actor.ctx, x.conversation.id, {}, db())).messages;
      expect(msgs[1]!.reply).toEqual({
        resolved: true,
        direction: "OUTBOUND",
        preview: "Class starts at 8",
      });
      expect(msgs[2]!.reply).toEqual({ resolved: false, direction: null, preview: null });
      expect(msgs[0]!.reply).toBeNull();
    });

    it("outbound delivery display is accurate for every request state and never invented", async () => {
      const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
      const queue = async (body: string) => {
        const r = await submitOutboundMessage(
          x.actor.ctx,
          {
            idempotencyKey: `k-${body}-0123456789`,
            conversationId: x.conversation.id,
            message: { type: "text", body },
          },
          { db: t.db as never, config: ON },
        );
        return r;
      };
      await queue("queued");
      const s = await queue("sending");
      await forceRequestState(t.pool, s.requestId, "SENDING");
      const acc = await queue("accepted");
      await forceRequestState(t.pool, acc.requestId, "ACCEPTED");
      const del = await queue("delivered");
      await forceRequestState(t.pool, del.requestId, "ACCEPTED");
      await t.pool.query("update messages set latest_status='DELIVERED' where id=$1", [
        del.messageId,
      ]);
      const rd = await queue("read");
      await forceRequestState(t.pool, rd.requestId, "ACCEPTED");
      await t.pool.query("update messages set latest_status='READ' where id=$1", [rd.messageId]);
      const rej = await queue("rejected");
      await forceRequestState(t.pool, rej.requestId, "REJECTED");
      const held = await queue("held");
      await forceRequestState(t.pool, held.requestId, "HELD", { holdReason: "window_closed" });
      const unk = await queue("unknown");
      await forceRequestState(t.pool, unk.requestId, "UNKNOWN_OUTCOME");
      // an old outbound row with no request and no status: nothing is invented
      const legacy = await addMessage(t.db, x, {
        direction: "OUTBOUND",
        body: "legacy",
        wamid: "wamid.LEG",
        occurredAt: new Date(Date.now() - 86_400_000),
      });
      const msgs = (await listMessages(x.actor.ctx, x.conversation.id, { limit: 50 }, db()))
        .messages;
      const phase = (text: string) => msgs.find((m) => m.text === text)!.delivery!;
      expect(phase("queued")).toMatchObject({ phase: "QUEUED", label: "Queued" });
      expect(phase("queued").detail).toMatch(/not been sent to WhatsApp yet/);
      expect(phase("sending")).toMatchObject({ phase: "SENDING" });
      expect(phase("accepted")).toMatchObject({ phase: "ACCEPTED", label: "Accepted by WhatsApp" });
      expect(phase("accepted").detail).toMatch(/not yet reported as sent or delivered/);
      expect(phase("delivered")).toMatchObject({ phase: "DELIVERED", severity: "good" });
      expect(phase("read")).toMatchObject({ phase: "READ" });
      expect(phase("rejected")).toMatchObject({ phase: "REJECTED", severity: "error" });
      expect(phase("held")).toMatchObject({ phase: "HELD", severity: "warning" });
      expect(phase("held").detail).toMatch(/24-hour reply window/);
      const unknown = phase("unknown");
      expect(unknown).toMatchObject({
        phase: "UNKNOWN_OUTCOME",
        severity: "warning",
        label: "Outcome unknown",
      });
      expect(unknown.detail).toMatch(/may or may not have been sent/);
      expect(unknown.detail).toMatch(/Do not send it again/);
      expect(msgs.find((m) => m.id === legacy.id)!.delivery).toMatchObject({ phase: "NONE" });
      expect(msgs.filter((m) => m.direction === "INBOUND").every((m) => m.delivery === null)).toBe(
        true,
      );
      // the payload text of the request and the recipient never appear in the view
      expect(JSON.stringify(msgs)).not.toContain(String(x.contact.waId));
    });

    it("a future-dated provider message is displayed with its stored time and is not rewritten", async () => {
      const x = await world(t.db);
      const future = new Date(Date.now() + 3 * 86_400_000);
      await addMessage(t.db, x, { body: "from the future", occurredAt: future });
      const [m] = (await listMessages(x.actor.ctx, x.conversation.id, {}, db())).messages;
      expect(m!.occurredAt).toBe(future.toISOString());
    });
  });
});
