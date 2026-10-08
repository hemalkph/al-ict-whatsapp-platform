import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { insertEvent } from "../queue/testing";
import { inboundMessageHandlers } from "./handler";
import {
  PN,
  WABA,
  addAccount,
  deliver,
  eventStatus,
  handleDirect,
  ingestFixture,
  minutesAgo,
  process,
  tenant,
} from "./testing";

// The inbound MESSAGE handler against REAL PostgreSQL, driven by genuine events from the real ingest path and run by the
// real queue worker. After every test: no lead, student, consent, tag or status row exists (the handler creates none).

const PN2 = "100000000000002";
const WABA2 = "200000000000002";
const NEVER_CREATED = [
  "leads",
  "contact_consents",
  "contact_tags",
  "tags",
  "message_status_events",
];
const sec = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000); // provider time has second precision

describe("inbound MESSAGE handler", () => {
  let t: TestDb;
  const logs: string[] = [];
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    logs.length = 0;
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((line: unknown) => void logs.push(String(line)));
    }
    await t.pool.query(
      "truncate webhook_events, webhook_requests, whatsapp_accounts, organizations cascade",
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const table of NEVER_CREATED) {
      const r = await t.pool.query(`select count(*)::int n from ${table}`);
      expect(r.rows[0].n, `${table} must stay empty`).toBe(0);
    }
  });

  const rows = async (query: string, params: unknown[] = []) =>
    (await t.pool.query(query, params)).rows;
  const count = async (table: string) =>
    (await rows(`select count(*)::int n from ${table}`))[0].n as number;
  const conversations = () => rows("select * from conversations order by created_at, id");
  const messages = () => rows("select * from messages order by occurred_at, id");
  const attachments = () => rows("select * from message_attachments order by created_at, id");
  const attributions = () => rows("select * from lead_attributions order by created_at, id");
  const contactRows = () => rows("select * from contacts order by created_at, id");
  const message = async (wamid: string) =>
    (await rows("select * from messages where wamid = $1", [wamid]))[0];
  const everything = async () => ({
    contacts: await contactRows(),
    aliases: await rows("select * from contact_bsuids order by bsuid"),
    conversations: await conversations(),
    messages: await messages(),
    attachments: await attachments(),
    attributions: await attributions(),
  });
  const replay = (id: string) =>
    t.pool.query(
      "update webhook_events set status='PENDING', attempts=0, locked_at=null, locked_by=null, last_error=null, next_attempt_at=now() where id=$1",
      [id],
    );
  const resolveConversation = (at: Date) =>
    t.pool.query("update conversations set status='RESOLVED', resolved_at=$1", [at]);

  // ------------------------------------------------------------------------------------------ the first message
  describe("the first inbound message", () => {
    it("creates the contact, the OPEN conversation and the message, and the queue marks the event PROCESSED", async () => {
      const { org, account } = await tenant(t.db);
      const sent = minutesAgo(10);
      const e = await deliver(t.db, { bsuid: "LK.1", name: "Student One", timestamp: sent });
      expect(await process(t.db)).toMatchObject({ claimed: 1, processed: 1, failed: 0, dead: 0 });
      expect(await eventStatus(t.db, e.id)).toMatchObject({ status: "PROCESSED", lastError: null });

      const [contact] = await contactRows();
      expect(contact).toMatchObject({
        organization_id: org.id,
        wa_id: "15550100123",
        marketing_consent_status: "UNKNOWN",
      });
      const [conversation] = await conversations();
      expect(conversation).toMatchObject({
        organization_id: org.id,
        whatsapp_account_id: account.id,
        contact_id: contact.id,
        status: "OPEN",
        resolved_at: null,
        last_outbound_at: null,
      });
      expect(conversation.last_message_at).toEqual(sec(sent));
      expect(conversation.last_inbound_at).toEqual(sec(sent));
      const [stored] = await messages();
      expect(stored).toMatchObject({
        organization_id: org.id,
        conversation_id: conversation.id,
        whatsapp_account_id: account.id,
        wamid: e.providerObjectId,
        direction: "INBOUND",
        type: "TEXT",
        body: `hello ${e.providerObjectId}`,
        reply_to_wamid: null,
        reply_to_message_id: null,
        latest_status: null,
        source_webhook_event_id: e.id,
      });
      expect(stored.occurred_at).toEqual(sec(sent)); // the provider's own time
    });

    it("never creates a lead, student, consent, tag or attribution for an ordinary message", async () => {
      await tenant(t.db);
      await deliver(t.db, { bsuid: "LK.2" });
      await process(t.db);
      expect(await count("lead_attributions")).toBe(0);
      expect((await contactRows())[0].marketing_consent_updated_at).toBeNull();
    });
  });

  // ------------------------------------------------------------------------------------- conversation creation
  describe("conversation creation and reuse", () => {
    it("later messages from the same contact reuse the conversation and advance its activity", async () => {
      await tenant(t.db);
      const first = minutesAgo(30);
      const second = minutesAgo(5);
      await deliver(t.db, { bsuid: "LK.3", timestamp: first });
      await process(t.db);
      await deliver(t.db, { bsuid: "LK.3", timestamp: second });
      await process(t.db);
      const convs = await conversations();
      expect(convs).toHaveLength(1);
      expect(convs[0].last_message_at).toEqual(sec(second));
      expect(convs[0].last_inbound_at).toEqual(sec(second));
      expect(await messages()).toHaveLength(2);
      expect(await contactRows()).toHaveLength(1);
    });

    it("one contact messaging two WhatsApp business numbers of the same organization gets two conversations", async () => {
      const { org } = await tenant(t.db);
      await addAccount(t.db, org.id, PN2, WABA2);
      await deliver(t.db, { bsuid: "LK.4" });
      await deliver(t.db, { bsuid: "LK.4", pn: PN2, waba: WABA2 });
      await process(t.db);
      expect(await contactRows()).toHaveLength(1);
      const convs = await conversations();
      expect(convs).toHaveLength(2);
      expect(new Set(convs.map((c) => c.whatsapp_account_id)).size).toBe(2);
      for (const m of await messages()) {
        const conv = convs.find((c) => c.id === m.conversation_id);
        expect(conv.whatsapp_account_id).toBe(m.whatsapp_account_id);
      }
    });

    it("different organizations never share a contact, conversation or message, even for the same BSUID and wamid", async () => {
      const a = await tenant(t.db);
      const b = await tenant(t.db, { pn: PN2, waba: WABA2 });
      // strictly one after the other, so the second is checked against a COMMITTED first message
      await deliver(t.db, { bsuid: "LK.5", id: "wamid.SHARED" });
      expect(await process(t.db)).toMatchObject({ claimed: 1, processed: 1 });
      await deliver(t.db, { bsuid: "LK.5", id: "wamid.SHARED", pn: PN2, waba: WABA2 });
      expect(await process(t.db)).toMatchObject({ claimed: 1, processed: 1 });
      const msgs = await messages();
      expect(msgs).toHaveLength(2);
      expect(new Set(msgs.map((m) => m.organization_id))).toEqual(new Set([a.org.id, b.org.id]));
      expect(new Set((await conversations()).map((c) => c.organization_id)).size).toBe(2);
      expect(new Set((await contactRows()).map((c) => c.organization_id)).size).toBe(2);
    });

    it("an organization named inside the payload cannot move the message to another tenant", async () => {
      const a = await tenant(t.db);
      const b = await tenant(t.db, { pn: PN2, waba: WABA2 });
      const e = await deliver(t.db, { bsuid: "LK.6" });
      await t.pool.query(
        "update webhook_events set payload = jsonb_set(payload, '{organization_id}', to_jsonb($2::text)) where id = $1",
        [e.id, b.org.id],
      );
      await process(t.db);
      expect((await messages())[0].organization_id).toBe(a.org.id);
      expect(
        await rows("select 1 from messages where organization_id = $1", [b.org.id]),
      ).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------- conversation state rules
  describe("conversation state", () => {
    async function resolvedAfterFirst(resolvedAt: Date) {
      await tenant(t.db);
      await deliver(t.db, { bsuid: "LK.R", timestamp: minutesAgo(120) });
      await process(t.db);
      await resolveConversation(resolvedAt);
    }

    it("a newer inbound message reopens a RESOLVED conversation (status and resolved_at only)", async () => {
      const resolvedAt = sec(minutesAgo(60));
      await resolvedAfterFirst(resolvedAt);
      const before = (await conversations())[0];
      await deliver(t.db, { bsuid: "LK.R", timestamp: minutesAgo(5) });
      await process(t.db);
      const after = (await conversations())[0];
      expect(after).toMatchObject({
        status: "OPEN",
        resolved_at: null,
        id: before.id,
        contact_id: before.contact_id,
      });
      expect(after.last_inbound_at.getTime()).toBeGreaterThan(before.last_inbound_at.getTime());
    });

    it("a delayed message older than resolved_at is stored but does not reopen the conversation (activity still only moves forward)", async () => {
      const resolvedAt = sec(minutesAgo(60));
      await resolvedAfterFirst(resolvedAt); // first message 120 minutes ago
      const ninety = minutesAgo(90);
      await deliver(t.db, { bsuid: "LK.R", timestamp: ninety }); // newer than the first, older than the resolution
      await process(t.db);
      const after = (await conversations())[0];
      expect(after).toMatchObject({ status: "RESOLVED", resolved_at: resolvedAt });
      expect(after.last_message_at).toEqual(sec(ninety));
      expect(await messages()).toHaveLength(2);
      // and one older than everything seen so far moves nothing
      await deliver(t.db, { bsuid: "LK.R", timestamp: minutesAgo(110) });
      await process(t.db);
      expect((await conversations())[0]).toMatchObject({
        status: "RESOLVED",
        last_message_at: sec(ninety),
      });
    });

    it("PENDING and OPEN conversations keep their status", async () => {
      await tenant(t.db);
      await deliver(t.db, { bsuid: "LK.S", timestamp: minutesAgo(60) });
      await process(t.db);
      await t.pool.query("update conversations set status='PENDING'");
      await deliver(t.db, { bsuid: "LK.S", timestamp: minutesAgo(30) });
      await process(t.db);
      expect((await conversations())[0].status).toBe("PENDING");
      await t.pool.query("update conversations set status='OPEN'");
      await deliver(t.db, { bsuid: "LK.S", timestamp: minutesAgo(10) });
      await process(t.db);
      expect((await conversations())[0]).toMatchObject({ status: "OPEN", resolved_at: null });
    });

    it("a RESOLVED conversation without resolved_at is not reopened (there is no instant to compare with)", async () => {
      await resolvedAfterFirst(minutesAgo(60));
      await t.pool.query("update conversations set resolved_at = null");
      await deliver(t.db, { bsuid: "LK.R", timestamp: minutesAgo(5) });
      await process(t.db);
      expect((await conversations())[0]).toMatchObject({ status: "RESOLVED", resolved_at: null });
    });

    it("a reaction is recorded but never reopens, and never changes last_message_at or last_inbound_at", async () => {
      await resolvedAfterFirst(sec(minutesAgo(60)));
      const before = (await conversations())[0];
      await deliver(t.db, {
        bsuid: "LK.R",
        timestamp: minutesAgo(2),
        message: {
          type: "reaction",
          reaction: { message_id: "wamid.SOMETHING", emoji: "\u{1F44D}" },
        },
      });
      await process(t.db);
      const after = (await conversations())[0];
      expect(after).toMatchObject({ status: "RESOLVED", resolved_at: before.resolved_at });
      expect(after.last_message_at).toEqual(before.last_message_at);
      expect(after.last_inbound_at).toEqual(before.last_inbound_at);
      expect((await messages()).map((m) => m.type)).toEqual(["TEXT", "REACTION"]);
    });

    it("a reaction that has to create the conversation does not count as customer activity", async () => {
      await tenant(t.db);
      await deliver(t.db, {
        bsuid: "LK.RC",
        message: { type: "reaction", reaction: { message_id: "wamid.SOMETHING" } },
      });
      await process(t.db);
      const [conversation] = await conversations();
      expect(conversation).toMatchObject({ status: "OPEN", last_inbound_at: null });
      expect(conversation.last_message_at).toBeInstanceOf(Date);
    });
  });

  // --------------------------------------------------------------------------------------------- timestamps
  describe("timestamps", () => {
    it("older messages arriving later never move activity backwards, and each keeps its own occurred_at", async () => {
      await tenant(t.db);
      const newer = minutesAgo(5);
      const older = minutesAgo(50);
      const oldest = minutesAgo(90);
      await deliver(t.db, { bsuid: "LK.T", timestamp: newer });
      await process(t.db);
      await deliver(t.db, { bsuid: "LK.T", timestamp: older });
      await process(t.db);
      await deliver(t.db, { bsuid: "LK.T", timestamp: oldest });
      await process(t.db);
      const [conversation] = await conversations();
      expect(conversation.last_message_at).toEqual(sec(newer));
      expect(conversation.last_inbound_at).toEqual(sec(newer));
      expect((await messages()).map((m) => m.occurred_at)).toEqual([
        sec(oldest),
        sec(older),
        sec(newer),
      ]);
    });

    it("an older message that creates the conversation first is later advanced by a newer one", async () => {
      await tenant(t.db);
      await deliver(t.db, { bsuid: "LK.T2", timestamp: minutesAgo(40) });
      await process(t.db);
      const recent = minutesAgo(3);
      await deliver(t.db, { bsuid: "LK.T2", timestamp: recent });
      await process(t.db);
      expect((await conversations())[0].last_message_at).toEqual(sec(recent));
    });

    it("a far-future provider timestamp is stored as sent, but derived activity is capped at receipt + 5 minutes", async () => {
      await tenant(t.db);
      const future = new Date(Date.now() + 365 * 86_400_000);
      const e = await deliver(t.db, { bsuid: "LK.T3", timestamp: future });
      await process(t.db);
      expect((await messages())[0].occurred_at).toEqual(sec(future));
      const [conversation] = await conversations();
      const cap = e.receivedAt.getTime() + 5 * 60_000;
      expect(conversation.last_message_at.getTime()).toBe(cap);
      expect(conversation.last_inbound_at.getTime()).toBe(cap);
      expect(logs.join("\n")).toContain("timestamp_future");
    });

    it("a stale provider timestamp is stored and flagged, and cannot pull activity back", async () => {
      await tenant(t.db);
      const recent = minutesAgo(5);
      await deliver(t.db, { bsuid: "LK.T4", timestamp: recent });
      await process(t.db);
      const stale = new Date(Date.now() - 20 * 86_400_000);
      await deliver(t.db, { bsuid: "LK.T4", timestamp: stale });
      await process(t.db);
      expect((await conversations())[0].last_message_at).toEqual(sec(recent));
      expect((await messages())[0].occurred_at).toEqual(sec(stale));
      expect(logs.join("\n")).toContain("timestamp_stale");
    });

    it.each(["abc", "0", "-5", "12.5", "99999999999999"])(
      "an unusable provider timestamp (%s) is a permanent failure and persists nothing",
      async (timestamp) => {
        await tenant(t.db);
        const e = await deliver(t.db, { bsuid: "LK.T5", timestamp });
        expect(await process(t.db)).toMatchObject({ claimed: 1, dead: 1, processed: 0 });
        expect(await eventStatus(t.db, e.id)).toMatchObject({
          status: "DEAD",
          lastError: "invalid_timestamp",
          attempts: 1,
        });
        expect(await count("messages")).toBe(0);
        expect(await count("conversations")).toBe(0);
        expect(await count("contacts")).toBe(0);
      },
    );
  });

  // -------------------------------------------------------------------------------------------- duplicates
  describe("duplicate messages", () => {
    it("re-processing the same event changes NOTHING: not a row, a timestamp, a status or an updated_at", async () => {
      await tenant(t.db);
      const e = await deliver(t.db, { bsuid: "LK.D", timestamp: minutesAgo(20) });
      await process(t.db);
      const before = await everything();
      await replay(e.id);
      expect(await process(t.db)).toMatchObject({ claimed: 1, processed: 1 });
      expect(await everything()).toEqual(before);
      expect(await eventStatus(t.db, e.id)).toMatchObject({ status: "PROCESSED" });
    });

    it("a duplicate delivered after the conversation was resolved does not reopen it", async () => {
      await tenant(t.db);
      const e = await deliver(t.db, { bsuid: "LK.D2", timestamp: minutesAgo(20) });
      await process(t.db);
      await resolveConversation(sec(minutesAgo(10)));
      const before = (await conversations())[0];
      await replay(e.id);
      await process(t.db);
      expect((await conversations())[0]).toEqual(before);
    });

    it("a second, different event for the same wamid is a no-op (no contact, conversation, attachment, attribution)", async () => {
      await tenant(t.db);
      const e = await deliver(t.db, {
        bsuid: "LK.D3",
        message: {
          type: "image",
          image: { id: "900000000000009", mime_type: "image/jpeg", caption: "x" },
          referral: { source_type: "ad", source_id: "1", ctwa_clid: "CLID-1" },
        },
      });
      await process(t.db);
      const before = await everything();
      expect(before.attachments).toHaveLength(1);
      expect(before.attributions).toHaveLength(1);
      const second = await insertEvent(t.db, {
        organizationId: e.organizationId,
        whatsappAccountId: e.whatsappAccountId,
        payload: e.payload,
        phoneNumberId: PN,
        wabaId: WABA,
      });
      expect(await process(t.db)).toMatchObject({ claimed: 1, processed: 1 });
      expect(await eventStatus(t.db, second.id)).toMatchObject({ status: "PROCESSED" });
      expect(await everything()).toEqual(before);
    });

    it("the same wamid on a different WhatsApp account of the same organization is a different message", async () => {
      const { org } = await tenant(t.db);
      await addAccount(t.db, org.id, PN2, WABA2);
      await deliver(t.db, { bsuid: "LK.D4", id: "wamid.TWIN" });
      expect(await process(t.db)).toMatchObject({ processed: 1 });
      await deliver(t.db, { bsuid: "LK.D4", id: "wamid.TWIN", pn: PN2, waba: WABA2 });
      expect(await process(t.db)).toMatchObject({ processed: 1 });
      expect(await messages()).toHaveLength(2);
    });

    it("a message that was stored first by another writer between the check and the insert is detected and nothing provisional survives", async () => {
      const { org, account } = await tenant(t.db);
      const earlier = minutesAgo(30);
      await deliver(t.db, { bsuid: "LK.D5", timestamp: earlier });
      await process(t.db);
      const contactBefore = (await contactRows())[0];
      const convId = (await conversations())[0].id;
      await t.pool.query(`
        create or replace function test_block_message_insert() returns trigger language plpgsql as $$
        begin
          if NEW.wamid = 'wamid.RACE' then perform pg_advisory_xact_lock(424242); end if;
          return NEW;
        end $$`);
      await t.pool.query(
        "create trigger test_block_message_insert before insert on messages for each row execute function test_block_message_insert()",
      );
      const client = await t.pool.connect();
      try {
        await client.query("select pg_advisory_lock(424242)");
        const e = await deliver(t.db, {
          bsuid: "LK.D5",
          id: "wamid.RACE",
          timestamp: minutesAgo(2),
        });
        const handled = handleDirect(t.db, e); // passes the existence check, then waits inside the insert trigger
        await new Promise((r) => setTimeout(r, 300));
        await client.query(
          "insert into messages (organization_id, conversation_id, whatsapp_account_id, wamid, direction, type, occurred_at) values ($1,$2,$3,'wamid.RACE','INBOUND','TEXT', now())",
          [org.id, convId, account.id],
        );
        await client.query("select pg_advisory_unlock(424242)");
        await handled; // completes as a duplicate, without error
      } finally {
        client.release();
        await t.pool.query("drop trigger test_block_message_insert on messages");
      }
      expect(await rows("select 1 from messages where wamid = 'wamid.RACE'")).toHaveLength(1);
      expect(await contactRows()).toEqual([contactBefore]); // the contact touch was rolled back with the savepoint
      expect((await conversations())[0].last_message_at).toEqual(sec(earlier));
      expect(logs.join("\n")).toContain("webhook.message_duplicate");
    });
  });

  // -------------------------------------------------------------------------------------------- message types
  describe("message types from the sanitized G0 fixtures", () => {
    const cases: Array<[string, string, string | null]> = [
      ["text-phone.json", "TEXT", "Does the ICT class start in January?"],
      ["image.json", "IMAGE", "Payment slip"],
      ["document.json", "DOCUMENT", "my receipt"],
      ["audio-voice.json", "AUDIO", null],
      ["sticker.json", "STICKER", null],
      ["location.json", "LOCATION", "Test Institute"],
      ["contacts-shared.json", "CONTACT", null],
      ["interactive-button-reply.json", "INTERACTIVE", "Enroll"],
      ["interactive-list-reply.json", "INTERACTIVE", "Evening batch"],
      ["button-quick-reply.json", "BUTTON", "Unsubscribe"],
      ["reaction.json", "REACTION", null],
      ["reaction-removed.json", "REACTION", null],
      ["unknown-type.json", "UNKNOWN", null],
      ["unsupported-edit.json", "UNKNOWN", null],
    ];
    it.each(cases)("%s -> %s", async (file, type, body) => {
      await tenant(t.db);
      const [event] = await ingestFixture(t.db, file);
      expect(await process(t.db)).toMatchObject({ claimed: 1, processed: 1 });
      const stored = await message(event!.providerObjectId);
      expect(stored).toMatchObject({
        type,
        direction: "INBOUND",
        source_webhook_event_id: event!.id,
      });
      expect(stored.body).toBe(body);
    });

    it("video and a Flow reply are stored too", async () => {
      await tenant(t.db);
      const video = await deliver(t.db, {
        bsuid: "LK.V",
        message: { type: "video", video: { id: "v1", mime_type: "video/mp4", caption: "clip" } },
      });
      const flow = await deliver(t.db, {
        bsuid: "LK.V",
        message: {
          type: "interactive",
          interactive: {
            type: "nfm_reply",
            nfm_reply: { name: "flow", body: "Sent", response_json: '{"a":1}' },
          },
        },
      });
      await process(t.db);
      expect(await message(video.providerObjectId)).toMatchObject({ type: "VIDEO", body: "clip" });
      expect(await message(flow.providerObjectId)).toMatchObject({
        type: "FLOW",
        body: null,
        content: { subtype: "nfm_reply", name: "flow" },
      });
    });

    it("an unknown message type is preserved as UNKNOWN with no fabricated fields", async () => {
      await tenant(t.db);
      const [event] = await ingestFixture(t.db, "unknown-type.json");
      await process(t.db);
      expect((await message(event!.providerObjectId)).content).toEqual({
        rawType: "future_message_type",
      });
    });

    it("persists Sinhala and Tamil text exactly and removes NUL", async () => {
      await tenant(t.db);
      const sinhala =
        "\u{D86}\u{DBA}\u{DD4}\u{DB6}\u{DDD}\u{DC0}\u{DB1}\u{DCA} \u{DC1}\u{DCA}\u{200D}\u{DBB}\u{DD3}";
      const tamil = "\u{BB5}\u{BA3}\u{B95}\u{BCD}\u{B95}\u{BAE}\u{BCD}";
      const a = await deliver(t.db, {
        bsuid: "LK.U",
        message: { type: "text", text: { body: sinhala } },
      });
      const b = await deliver(t.db, {
        bsuid: "LK.U",
        message: { type: "text", text: { body: `${tamil}\u0000x` } },
      });
      await process(t.db);
      expect((await message(a.providerObjectId)).body).toBe(sinhala);
      expect((await message(b.providerObjectId)).body).toBe(`${tamil}x`);
    });

    it("cuts an over-long text at its limit; one beyond four times the limit fails permanently with a fixed code", async () => {
      await tenant(t.db);
      const a = await deliver(t.db, {
        bsuid: "LK.L",
        message: { type: "text", text: { body: "x".repeat(5000) } },
      });
      const b = await deliver(t.db, {
        bsuid: "LK.L",
        message: { type: "text", text: { body: "y".repeat(17_000) } },
      });
      await process(t.db);
      expect((await message(a.providerObjectId)).body).toHaveLength(4096);
      expect(await message(b.providerObjectId)).toBeUndefined();
      expect(await eventStatus(t.db, b.id)).toMatchObject({
        status: "DEAD",
        lastError: "content_too_large",
      });
    });
  });

  // ------------------------------------------------------------------------------------------------- media
  describe("media metadata", () => {
    it("stores PENDING attachment metadata (media id, mime type, filename, sha-256) and never the temporary url", async () => {
      await tenant(t.db);
      const [event] = await ingestFixture(t.db, "document.json");
      await process(t.db);
      const [att] = await attachments();
      expect(att).toMatchObject({
        meta_media_id: "900000000000004",
        mime_type: "application/pdf",
        filename: "receipt.pdf",
        sha256: "ZmFrZS1zaGEyNTYtZm9yLXRlc3Rpbmctb25seS0wMDQ=",
        storage_status: "PENDING",
        storage_key: null,
        size_bytes: null,
        error: null,
        message_id: (await message(event!.providerObjectId)).id,
      });
      const all = JSON.stringify(await everything());
      expect(all).not.toContain("lookaside");
      expect(all).not.toContain("http");
    });

    it("every supported media type creates exactly one PENDING attachment", async () => {
      await tenant(t.db);
      for (const file of ["image.json", "audio-voice.json", "sticker.json", "document.json"])
        await ingestFixture(t.db, file);
      await process(t.db);
      const atts = await attachments();
      expect(atts).toHaveLength(4);
      expect(new Set(atts.map((a) => a.storage_status))).toEqual(new Set(["PENDING"]));
    });

    it("replaying a media message creates no second attachment; media without an id creates none", async () => {
      await tenant(t.db);
      const [event] = await ingestFixture(t.db, "image.json");
      await process(t.db);
      await replay(event!.id);
      await process(t.db);
      expect(await attachments()).toHaveLength(1);
      await deliver(t.db, {
        bsuid: "LK.M",
        message: { type: "image", image: { mime_type: "image/png" } },
      });
      await process(t.db);
      expect(await attachments()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------------------------------- replies
  describe("reply relationships", () => {
    it("links a reply to a parent that already exists in the same conversation", async () => {
      await tenant(t.db);
      const parent = await deliver(t.db, {
        bsuid: "LK.P1",
        id: "wamid.PARENT1",
        timestamp: minutesAgo(20),
      });
      await process(t.db);
      const reply = await deliver(t.db, {
        bsuid: "LK.P1",
        message: { type: "text", text: { body: "re" }, context: { id: "wamid.PARENT1" } },
      });
      await process(t.db);
      const stored = await message(reply.providerObjectId);
      expect(stored).toMatchObject({
        reply_to_wamid: "wamid.PARENT1",
        reply_to_message_id: (await message(parent.providerObjectId)).id,
      });
    });

    it("links a reply to one of OUR OWN earlier (outbound) messages in the conversation", async () => {
      const { org, account } = await tenant(t.db);
      await deliver(t.db, { bsuid: "LK.P2", timestamp: minutesAgo(40) });
      await process(t.db);
      const conv = (await conversations())[0];
      const [outbound] = await rows(
        "insert into messages (organization_id, conversation_id, whatsapp_account_id, wamid, direction, type, body, occurred_at) values ($1,$2,$3,'wamid.OURS','OUTBOUND','TEXT','hello',now() - interval '30 minutes') returning id",
        [org.id, conv.id, account.id],
      );
      const reply = await deliver(t.db, {
        bsuid: "LK.P2",
        message: {
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "a", title: "A" } },
          context: { id: "wamid.OURS" },
        },
      });
      await process(t.db);
      expect((await message(reply.providerObjectId)).reply_to_message_id).toBe(outbound.id);
    });

    it("keeps a reply whose parent has not arrived (wamid only) and links it when the parent arrives", async () => {
      await tenant(t.db);
      const reply = await deliver(t.db, {
        bsuid: "LK.P3",
        timestamp: minutesAgo(10),
        message: { type: "text", text: { body: "re" }, context: { id: "wamid.LATE" } },
      });
      expect(await process(t.db)).toMatchObject({ processed: 1 });
      expect(await message(reply.providerObjectId)).toMatchObject({
        reply_to_wamid: "wamid.LATE",
        reply_to_message_id: null,
      });
      const parent = await deliver(t.db, {
        bsuid: "LK.P3",
        id: "wamid.LATE",
        timestamp: minutesAgo(20),
      });
      await process(t.db);
      expect((await message(reply.providerObjectId)).reply_to_message_id).toBe(
        (await message(parent.providerObjectId)).id,
      );
    });

    it("never links across conversations: another contact's reply to this wamid stays unlinked, before and after the parent arrives", async () => {
      await tenant(t.db);
      const foreign = await deliver(t.db, {
        bsuid: "LK.P4B",
        from: "15550100999",
        message: { type: "text", text: { body: "re" }, context: { id: "wamid.THEIRS" } },
      });
      await process(t.db);
      const parent = await deliver(t.db, {
        bsuid: "LK.P4A",
        from: "15550100998",
        id: "wamid.THEIRS",
      });
      await process(t.db);
      expect(await conversations()).toHaveLength(2);
      expect(await message(foreign.providerObjectId)).toMatchObject({
        reply_to_wamid: "wamid.THEIRS",
        reply_to_message_id: null,
      });
      const alsoLater = await deliver(t.db, {
        bsuid: "LK.P4B",
        from: "15550100999",
        message: { type: "text", text: { body: "again" }, context: { id: "wamid.THEIRS" } },
      });
      await process(t.db);
      expect((await message(alsoLater.providerObjectId)).reply_to_message_id).toBeNull();
      expect((await message(parent.providerObjectId)).reply_to_message_id).toBeNull();
    });

    it("never links across organizations or WhatsApp accounts", async () => {
      const a = await tenant(t.db);
      await tenant(t.db, { pn: PN2, waba: WABA2 });
      await deliver(t.db, { bsuid: "LK.P5", id: "wamid.OTHERORG", pn: PN2, waba: WABA2 });
      await process(t.db);
      const reply = await deliver(t.db, {
        bsuid: "LK.P5",
        message: { type: "text", text: { body: "re" }, context: { id: "wamid.OTHERORG" } },
      });
      await process(t.db);
      expect(await message(reply.providerObjectId)).toMatchObject({
        organization_id: a.org.id,
        reply_to_wamid: "wamid.OTHERORG",
        reply_to_message_id: null,
      });
      // another account of the SAME organization
      await addAccount(t.db, a.org.id, "100000000000003", "200000000000003");
      await deliver(t.db, {
        bsuid: "LK.P6",
        id: "wamid.OTHERACC",
        pn: "100000000000003",
        waba: "200000000000003",
      });
      await process(t.db);
      const reply2 = await deliver(t.db, {
        bsuid: "LK.P6",
        message: { type: "text", text: { body: "re" }, context: { id: "wamid.OTHERACC" } },
      });
      await process(t.db);
      expect((await message(reply2.providerObjectId)).reply_to_message_id).toBeNull();
    });

    it("a message cannot reply to itself, and replays never change an existing link", async () => {
      await tenant(t.db);
      const own = await deliver(t.db, {
        bsuid: "LK.P7",
        id: "wamid.SELF",
        message: { type: "text", text: { body: "x" }, context: { id: "wamid.SELF" } },
      });
      await process(t.db);
      expect((await message("wamid.SELF")).reply_to_message_id).toBeNull();
      const parent = await deliver(t.db, {
        bsuid: "LK.P7",
        id: "wamid.PP",
        timestamp: minutesAgo(30),
      });
      const reply = await deliver(t.db, {
        bsuid: "LK.P7",
        message: { type: "text", text: { body: "re" }, context: { id: "wamid.PP" } },
      });
      await process(t.db);
      const linked = (await message(reply.providerObjectId)).reply_to_message_id;
      expect(linked).toBe((await message(parent.providerObjectId)).id);
      for (const e of [own, parent, reply]) await replay(e.id);
      await process(t.db);
      expect((await message(reply.providerObjectId)).reply_to_message_id).toBe(linked);
      expect((await message("wamid.SELF")).reply_to_message_id).toBeNull();
    });
  });

  // ----------------------------------------------------------------------------------- Click-to-WhatsApp
  describe("Click-to-WhatsApp referral", () => {
    it("official-shape referral becomes exactly one attribution for the right contact and message, and no lead", async () => {
      const { org } = await tenant(t.db);
      const [event] = await ingestFixture(t.db, "referral-ctwa-text.json");
      await process(t.db);
      const [attribution] = await attributions();
      const stored = await message(event!.providerObjectId);
      expect(attribution).toMatchObject({
        organization_id: org.id,
        contact_id: (await contactRows())[0].id,
        message_id: stored.id,
        lead_id: null,
        source_type: "META_AD",
        source_id: "400000000000001",
        source_url: "https://fb.me/FAKE0000",
        headline: "Chat with us",
        body: "Join the A/L ICT class",
        media_type: "image",
        media_url: "https://scontent.xx.fbcdn.net/v/FAKE",
        ctwa_clid: "FAKE-ctwa-clid-0000000000000000000000000000000000000001",
        provider_data: { welcome_message_text: "Hi! How can we help?" },
      });
      expect(attribution.received_at).toEqual(event!.receivedAt);
      expect(await count("leads")).toBe(0);
      expect((await contactRows())[0].marketing_consent_status).toBe("UNKNOWN");
      expect(stored).toMatchObject({ type: "TEXT", body: "Can I get more info about this?" });
    });

    it("replaying the event, or a second event for the same message, never duplicates the attribution", async () => {
      await tenant(t.db);
      const [event] = await ingestFixture(t.db, "referral-ctwa-text.json");
      await process(t.db);
      await replay(event!.id);
      await process(t.db);
      const dup = await insertEvent(t.db, {
        organizationId: event!.organizationId,
        whatsappAccountId: event!.whatsappAccountId,
        payload: event!.payload,
        phoneNumberId: PN,
        wabaId: WABA,
      });
      await process(t.db);
      expect(await eventStatus(t.db, dup.id)).toMatchObject({ status: "PROCESSED" });
      expect(await attributions()).toHaveLength(1);
    });

    it("each qualifying message gets its own attribution", async () => {
      await tenant(t.db);
      for (const id of ["1", "2"])
        await deliver(t.db, {
          bsuid: "LK.C",
          message: {
            type: "text",
            text: { body: "hi" },
            referral: { source_type: "ad", source_id: id, ctwa_clid: `CLID-${id}` },
          },
        });
      await process(t.db);
      const atts = await attributions();
      expect(atts).toHaveLength(2);
      expect(new Set(atts.map((a) => a.message_id)).size).toBe(2);
    });

    it("a referral with only source_url keeps nulls elsewhere; a source_type other than `ad` is REFERRAL; ctwa_clid is exact or absent", async () => {
      await tenant(t.db);
      await deliver(t.db, {
        bsuid: "LK.C2",
        message: {
          type: "text",
          text: { body: "a" },
          referral: { source_url: "https://fb.me/only" },
        },
      });
      await deliver(t.db, {
        bsuid: "LK.C2",
        message: {
          type: "text",
          text: { body: "b" },
          referral: { source_type: "post", source_id: "9", ctwa_clid: "ExAcT_clid-0.9" },
        },
      });
      await process(t.db);
      const byUrl = (await attributions()).find((a) => a.source_url === "https://fb.me/only");
      expect(byUrl).toMatchObject({
        source_type: "REFERRAL",
        source_id: null,
        headline: null,
        body: null,
        media_type: null,
        media_url: null,
        ctwa_clid: null,
        provider_data: null,
      });
      const post = (await attributions()).find((a) => a.source_id === "9");
      expect(post).toMatchObject({
        source_type: "REFERRAL",
        ctwa_clid: "ExAcT_clid-0.9",
        provider_data: { source_type: "post" },
      });
    });

    it("sanitizes unknown referral metadata (flat, bounded, no NUL) and never invents fields", async () => {
      await tenant(t.db);
      await deliver(t.db, {
        bsuid: "LK.C3",
        message: {
          type: "text",
          text: { body: "a" },
          referral: {
            source_id: "7",
            future_text: "a\u0000b",
            future_nested: { x: 1 },
            future_flag: true,
          },
        },
      });
      await process(t.db);
      const [a] = await attributions();
      expect(a.provider_data).toEqual({ future_text: "ab", future_flag: true });
      expect(a).toMatchObject({ headline: null, ctwa_clid: null });
    });

    it("an ordinary message without a referral creates no attribution; a referral never creates consent or a lead", async () => {
      await tenant(t.db);
      await deliver(t.db, { bsuid: "LK.C4" });
      await process(t.db);
      expect(await attributions()).toHaveLength(0);
      await deliver(t.db, {
        bsuid: "LK.C4",
        message: {
          type: "text",
          text: { body: "x" },
          referral: { source_type: "ad", ctwa_clid: "C" },
        },
      });
      await process(t.db);
      expect(await attributions()).toHaveLength(1);
      expect(await count("leads")).toBe(0);
      expect(await count("contact_consents")).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------------- archived
  describe("archived contacts", () => {
    it("a message for an archived contact is stored for that contact and the contact stays archived", async () => {
      await tenant(t.db);
      await deliver(t.db, { bsuid: "LK.A", timestamp: minutesAgo(30) });
      await process(t.db);
      await t.pool.query("update contacts set archived_at = now() - interval '1 hour'");
      const archivedAt = (await contactRows())[0].archived_at;
      const e = await deliver(t.db, { bsuid: "LK.A", timestamp: minutesAgo(2) });
      await process(t.db);
      expect((await contactRows())[0].archived_at).toEqual(archivedAt);
      expect(await contactRows()).toHaveLength(1);
      expect(await conversations()).toHaveLength(1);
      expect((await message(e.providerObjectId)).conversation_id).toBe(
        (await conversations())[0].id,
      );
    });
  });

  // ------------------------------------------------------------------------------------ identity integration
  describe("contact identity safety is preserved", () => {
    it("a phone-only message for a BSUID-established contact is not guessed: the event is DEAD with a safe code and nothing is written", async () => {
      await tenant(t.db);
      await deliver(t.db, { bsuid: "LK.I1", from: "15550100777" });
      await process(t.db);
      const before = await everything();
      const phoneOnly = await deliver(t.db, { from: "15550100777", bsuid: null });
      expect(await process(t.db)).toMatchObject({ claimed: 1, dead: 1 });
      expect(await eventStatus(t.db, phoneOnly.id)).toMatchObject({
        status: "DEAD",
        lastError: "phone_only_identity_ambiguous",
        attempts: 1,
      });
      expect(await everything()).toEqual(before);
    });

    it("an unknown BSUID on a legacy contact's phone gets its own contact and its own conversation", async () => {
      await tenant(t.db);
      const legacy = await deliver(t.db, { from: "15550100666", bsuid: null });
      await process(t.db);
      const fresh = await deliver(t.db, { from: "15550100666", bsuid: "LK.I2" });
      await process(t.db);
      expect(await contactRows()).toHaveLength(2);
      expect(await conversations()).toHaveLength(2);
      expect((await contactRows()).filter((c) => c.wa_id === "15550100666")).toHaveLength(1);
      const legacyMessage = await message(legacy.providerObjectId);
      const freshMessage = await message(fresh.providerObjectId);
      expect(freshMessage.conversation_id).not.toBe(legacyMessage.conversation_id);
    });

    it("a message with no usable sender identity is a permanent failure", async () => {
      await tenant(t.db);
      const e = await deliver(t.db, { from: null, bsuid: null, contacts: [] });
      await process(t.db);
      expect(await eventStatus(t.db, e.id)).toMatchObject({
        status: "DEAD",
        lastError: "missing_sender_identity",
      });
    });
  });

  // ------------------------------------------------------------------------------------ worker integration
  describe("worker integration", () => {
    it("registers MESSAGE only; STATUS and OTHER (system) events are never claimed", async () => {
      expect(Object.keys(inboundMessageHandlers)).toEqual(["MESSAGE"]);
      await tenant(t.db);
      const [system] = await ingestFixture(t.db, "system-user-changed-user-id.json");
      const [status] = await ingestFixture(t.db, "status-delivered-phone-bsuid.json");
      expect(await process(t.db)).toMatchObject({ claimed: 0 });
      expect(await eventStatus(t.db, system!.id)).toMatchObject({ status: "IGNORED", attempts: 0 });
      expect(await eventStatus(t.db, status!.id)).toMatchObject({ status: "PENDING", attempts: 0 });
      expect(await count("messages")).toBe(0);
    });

    it("the handler itself refuses a system notification and never writes a chat message for it", async () => {
      const { org, account } = await tenant(t.db);
      // ingest turns system messages into ignored OTHER events; a MESSAGE-shaped one can only come from stored data
      const row = await insertEvent(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        phoneNumberId: PN,
        wabaId: WABA,
        payload: {
          v: 1,
          wabaId: WABA,
          field: "messages",
          metadata: { phone_number_id: PN },
          message: {
            id: "wamid.SYS",
            timestamp: "1790000000",
            type: "system",
            from_user_id: "LK.Y",
            system: { body: "changed", type: "user_changed_user_id" },
          },
        },
      });
      const event = {
        id: row.id,
        eventType: "MESSAGE",
        organizationId: org.id,
        whatsappAccountId: account.id,
        receivedAt: row.receivedAt,
        payload: row.payload,
        providerObjectId: "wamid.SYS",
      };
      await expect(handleDirect(t.db, event)).rejects.toMatchObject({
        code: "system_message_unsupported",
      });
      expect(await count("messages")).toBe(0);
      expect(await count("conversations")).toBe(0);
      expect(await count("contacts")).toBe(0);
    });

    it("an account that is no longer ACTIVE is refused (transient) and nothing is written", async () => {
      await tenant(t.db);
      const e = await deliver(t.db, { bsuid: "LK.Z" });
      await t.pool.query("update whatsapp_accounts set status = 'DISABLED'");
      await expect(handleDirect(t.db, e)).rejects.toThrow("account_not_active");
      expect(await count("messages")).toBe(0);
      expect(await count("contacts")).toBe(0);
    });

    it("a trusted event whose organization does not own the account is refused", async () => {
      const other = await tenant(t.db, { pn: PN2, waba: WABA2 });
      await tenant(t.db);
      const e = await deliver(t.db, { bsuid: "LK.Z2" });
      await expect(handleDirect(t.db, { ...e, organizationId: other.org.id })).rejects.toThrow(
        "account_not_active",
      );
      expect(await count("messages")).toBe(0);
    });
  });
});
