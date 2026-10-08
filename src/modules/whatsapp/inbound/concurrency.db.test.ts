import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { FIXTURE_DEFERRED_DDL, deferred, expireLeases, insertEvent, until } from "../queue/testing";
import type { WebhookHandlerRegistry } from "../queue/process";
import { handleInboundMessage } from "./handler";
import {
  PN,
  WABA,
  addAccount,
  deliver,
  eventStatus,
  handleDirect,
  minutesAgo,
  process,
  tenant,
  type StoredEvent,
} from "./testing";

// Races, rollback and lease fencing for the inbound handler, on REAL PostgreSQL.

const PN2 = "100000000000002";
const WABA2 = "200000000000002";
const sec = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);

describe("inbound handler: concurrency, rollback and fencing", () => {
  let t: TestDb;
  const gates: Array<() => void> = [];
  beforeAll(async () => {
    t = await createTestDatabase();
    for (const ddl of FIXTURE_DEFERRED_DDL) await t.pool.query(ddl);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    for (const method of ["log", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation(() => undefined);
    await t.pool.query(
      "truncate webhook_events, webhook_requests, whatsapp_accounts, organizations, queue_fixture_parents cascade",
    );
  });
  afterEach(async () => {
    gates.splice(0).forEach((open) => open());
    vi.restoreAllMocks();
    await t.pool.query("drop trigger if exists test_fail_attribution on lead_attributions");
    await until(
      async () =>
        (
          await t.pool.query(
            "select count(*)::int n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'",
          )
        ).rows[0].n === 0,
    );
  });

  const rows = async (query: string, params: unknown[] = []) =>
    (await t.pool.query(query, params)).rows;
  const count = async (table: string) =>
    (await rows(`select count(*)::int n from ${table}`))[0].n as number;
  const gate = () => {
    const d = deferred();
    gates.push(d.resolve);
    return d;
  };
  const counts = async () => ({
    contacts: await count("contacts"),
    aliases: await count("contact_bsuids"),
    conversations: await count("conversations"),
    messages: await count("messages"),
    attachments: await count("message_attachments"),
    attributions: await count("lead_attributions"),
  });
  const EMPTY = {
    contacts: 0,
    aliases: 0,
    conversations: 0,
    messages: 0,
    attachments: 0,
    attributions: 0,
  };
  const richMessage = {
    type: "image",
    image: { id: "900000000000042", mime_type: "image/jpeg", caption: "slip" },
    referral: { source_type: "ad", source_id: "77", ctwa_clid: "CLID-77" },
  };

  // ------------------------------------------------------------------------------------------------- races
  describe("races", () => {
    it("simultaneous first messages from one new contact create one contact and one conversation (repeated rounds)", async () => {
      await tenant(t.db);
      for (let round = 0; round < 6; round++) {
        const bsuid = `LK.RACE${round}`;
        const events = await Promise.all(
          Array.from({ length: 6 }, () => deliver(t.db, { bsuid, from: `1555010${round}000` })),
        );
        await Promise.all(events.map((e) => handleDirect(t.db, e)));
        const contact = await rows(
          "select c.id from contacts c join contact_bsuids b on b.contact_id = c.id where b.bsuid = $1",
          [bsuid],
        );
        expect(contact, `round ${round}`).toHaveLength(1);
        const conversations = await rows("select id from conversations where contact_id = $1", [
          contact[0].id,
        ]);
        expect(conversations, `round ${round}`).toHaveLength(1);
        const messages = await rows("select 1 from messages where conversation_id = $1", [
          conversations[0].id,
        ]);
        expect(messages, `round ${round}`).toHaveLength(6);
      }
    });

    it("three workers draining one queue process every event exactly once", async () => {
      await tenant(t.db);
      for (let i = 0; i < 18; i++)
        await deliver(t.db, { bsuid: `LK.W${i % 3}`, from: `1555020000${i % 3}` });
      const summaries = await Promise.all([process(t.db), process(t.db), process(t.db)]);
      expect(summaries.reduce((n, s) => n + s.processed, 0)).toBe(18);
      expect(summaries.reduce((n, s) => n + s.failed + s.dead, 0)).toBe(0);
      expect(await count("messages")).toBe(18);
      expect(await count("contacts")).toBe(3);
      expect(await count("conversations")).toBe(3);
    });

    it("two events for the SAME message racing create exactly one message and nothing else (media, referral included)", async () => {
      await tenant(t.db);
      for (let round = 0; round < 6; round++) {
        const first = await deliver(t.db, {
          bsuid: `LK.DUP${round}`,
          id: `wamid.DUP${round}`,
          message: richMessage,
        });
        const second = await insertEvent(t.db, {
          organizationId: first.organizationId,
          whatsappAccountId: first.whatsappAccountId,
          payload: first.payload,
          phoneNumberId: PN,
          wabaId: WABA,
        });
        const results = await Promise.allSettled([
          handleDirect(t.db, first),
          handleDirect(t.db, { ...first, id: second.id }),
        ]);
        expect(
          results.map((r) => r.status),
          `round ${round}`,
        ).toEqual(["fulfilled", "fulfilled"]);
      }
      expect(await counts()).toMatchObject({
        messages: 6,
        attachments: 6,
        attributions: 6,
        conversations: 6,
        contacts: 6,
      });
    });

    it("the same wamid raced by whole workers is handled once", async () => {
      await tenant(t.db);
      const e = await deliver(t.db, { bsuid: "LK.DW", id: "wamid.DW", message: richMessage });
      await insertEvent(t.db, {
        organizationId: e.organizationId,
        whatsappAccountId: e.whatsappAccountId,
        payload: e.payload,
        phoneNumberId: PN,
        wabaId: WABA,
      });
      const summaries = await Promise.all([process(t.db), process(t.db)]);
      expect(summaries.reduce((n, s) => n + s.processed, 0)).toBe(2);
      expect(await counts()).toMatchObject({
        messages: 1,
        attachments: 1,
        attributions: 1,
        conversations: 1,
        contacts: 1,
      });
    });

    it("one contact messaging two business numbers at once gets one contact and two conversations", async () => {
      const { org } = await tenant(t.db);
      await addAccount(t.db, org.id, PN2, WABA2);
      for (let round = 0; round < 4; round++) {
        const events = await Promise.all([
          ...Array.from({ length: 3 }, () => deliver(t.db, { bsuid: `LK.TWO${round}` })),
          ...Array.from({ length: 3 }, () =>
            deliver(t.db, { bsuid: `LK.TWO${round}`, pn: PN2, waba: WABA2 }),
          ),
        ]);
        await Promise.all(events.map((e) => handleDirect(t.db, e)));
      }
      expect(await count("contacts")).toBe(4);
      expect(await count("conversations")).toBe(8);
      expect(await count("messages")).toBe(24);
    });

    it("a reply and its parent racing end up linked, whichever is processed first", async () => {
      await tenant(t.db);
      for (let round = 0; round < 8; round++) {
        const parentId = `wamid.PAR${round}`;
        const parent = await deliver(t.db, {
          bsuid: `LK.RP${round}`,
          id: parentId,
          timestamp: minutesAgo(30),
        });
        const reply = await deliver(t.db, {
          bsuid: `LK.RP${round}`,
          message: { type: "text", text: { body: "re" }, context: { id: parentId } },
        });
        await Promise.all(
          round % 2 === 0
            ? [handleDirect(t.db, parent), handleDirect(t.db, reply)]
            : [handleDirect(t.db, reply), handleDirect(t.db, parent)],
        );
        const linked = await rows(
          "select r.reply_to_message_id, p.id as parent_id from messages r join messages p on p.wamid = $1 where r.wamid = $2",
          [parentId, reply.providerObjectId],
        );
        expect(linked[0].reply_to_message_id, `round ${round}`).toBe(linked[0].parent_id);
      }
    });

    it("concurrent older and newer messages for a resolved conversation end OPEN with activity at the newest", async () => {
      await tenant(t.db);
      await deliver(t.db, { bsuid: "LK.RO", timestamp: minutesAgo(200) });
      await process(t.db);
      await t.pool.query(
        "update conversations set status='RESOLVED', resolved_at = now() - interval '100 minutes'",
      );
      const newest = minutesAgo(5);
      const events = await Promise.all([
        deliver(t.db, { bsuid: "LK.RO", timestamp: minutesAgo(150) }), // older than the resolution
        deliver(t.db, { bsuid: "LK.RO", timestamp: newest }),
        deliver(t.db, { bsuid: "LK.RO", timestamp: minutesAgo(50) }),
        deliver(t.db, { bsuid: "LK.RO", timestamp: minutesAgo(120) }),
      ]);
      await Promise.all(events.map((e) => handleDirect(t.db, e)));
      const [conversation] = await rows("select * from conversations");
      expect(conversation).toMatchObject({ status: "OPEN", resolved_at: null });
      expect(conversation.last_message_at).toEqual(sec(newest));
      expect(conversation.last_inbound_at).toEqual(sec(newest));
    });

    it("activity timestamps end at the maximum no matter the processing order", async () => {
      await tenant(t.db);
      const stamps = [90, 10, 60, 5, 45, 30, 75, 20].map((m) => minutesAgo(m));
      const events = await Promise.all(
        stamps.map((timestamp) => deliver(t.db, { bsuid: "LK.ACT", timestamp })),
      );
      await Promise.all(events.map((e) => handleDirect(t.db, e)));
      const [conversation] = await rows("select * from conversations");
      expect(conversation.last_message_at).toEqual(sec(stamps[3]!));
      expect(await count("messages")).toBe(8);
      expect(await count("conversations")).toBe(1);
    });

    it("two organizations processing the same BSUID and wamid at once never touch each other", async () => {
      await tenant(t.db);
      await tenant(t.db, { pn: PN2, waba: WABA2 });
      const events = await Promise.all([
        ...Array.from({ length: 3 }, (_, i) =>
          deliver(t.db, { bsuid: "LK.ORG", id: `wamid.ORG${i}` }),
        ),
        ...Array.from({ length: 3 }, (_, i) =>
          deliver(t.db, { bsuid: "LK.ORG", id: `wamid.ORG${i}`, pn: PN2, waba: WABA2 }),
        ),
      ]);
      await Promise.all(events.map((e) => handleDirect(t.db, e)));
      expect(await count("messages")).toBe(6);
      expect(
        await rows("select organization_id, count(*)::int n from conversations group by 1"),
      ).toHaveLength(2);
      expect(await count("contacts")).toBe(2);
    });
  });

  // -------------------------------------------------------------------------------------------------- rollback
  describe("rollback: the domain writes and the event's final state stand or fall together", () => {
    const wrap = (
      after: (
        tx: Parameters<typeof handleInboundMessage>[0],
        e: Parameters<typeof handleInboundMessage>[1],
      ) => Promise<void>,
    ): WebhookHandlerRegistry => ({
      MESSAGE: async (tx, e, c) => {
        await handleInboundMessage(tx, e, c);
        await after(tx, e);
      },
    });

    it("an exception after every domain write rolls back contact, alias, conversation, message, attachment and attribution", async () => {
      await tenant(t.db);
      const e = await deliver(t.db, { bsuid: "LK.RB1", message: richMessage });
      const summary = await process(t.db, {
        handlers: wrap(async () => {
          // by now all six kinds of rows exist inside the transaction
          expect(await count("messages")).toBe(1);
          expect(await count("lead_attributions")).toBe(1);
          throw new Error("later step failed");
        }),
      });
      expect(summary).toMatchObject({ claimed: 1, failed: 1, processed: 0 });
      expect(await counts()).toEqual(EMPTY);
      expect(await eventStatus(t.db, e.id)).toMatchObject({ status: "FAILED", attempts: 1 });
    });

    it("a deferred-constraint failure at COMMIT discards everything and the event is not PROCESSED", async () => {
      await tenant(t.db);
      const e = await deliver(t.db, { bsuid: "LK.RB2", message: richMessage });
      const summary = await process(t.db, {
        handlers: wrap(
          async (tx) =>
            void (await tx.execute(
              sql`insert into queue_fixture_children (parent_id) values (999)`,
            )),
        ),
      });
      expect(summary).toMatchObject({ failed: 1, processed: 0 });
      expect(await counts()).toEqual(EMPTY);
      expect(await eventStatus(t.db, e.id)).toMatchObject({
        status: "FAILED",
        lastError: "pg_23503",
      });
    });

    it("a database error in the middle of the writes (a constraint failing inside the handler) fails the event and persists nothing", async () => {
      await tenant(t.db);
      await t.pool.query(`
        create or replace function test_fail_attribution() returns trigger language plpgsql as $$
        begin raise exception 'injected attribution failure' using errcode = '23514'; end $$`);
      await t.pool.query(
        "create trigger test_fail_attribution before insert on lead_attributions for each row execute function test_fail_attribution()",
      );
      const e = await deliver(t.db, { bsuid: "LK.RB3", message: richMessage });
      const summary = await process(t.db);
      expect(summary).toMatchObject({ claimed: 1, failed: 1, processed: 0 });
      expect(await counts()).toEqual(EMPTY);
      expect(await eventStatus(t.db, e.id)).toMatchObject({
        status: "FAILED",
        lastError: "pg_23514",
      });
    });

    it("a failed event is retried later and then completes with exactly one set of rows", async () => {
      await tenant(t.db);
      const e = await deliver(t.db, { bsuid: "LK.RB4", message: richMessage });
      await process(t.db, {
        handlers: wrap(async () => {
          throw new Error("transient");
        }),
      });
      expect(await counts()).toEqual(EMPTY);
      await t.pool.query("update webhook_events set next_attempt_at = now() where id = $1", [e.id]);
      expect(await process(t.db)).toMatchObject({ processed: 1 });
      expect(await counts()).toEqual({
        contacts: 1,
        aliases: 1,
        conversations: 1,
        messages: 1,
        attachments: 1,
        attributions: 1,
      });
      expect(await eventStatus(t.db, e.id)).toMatchObject({ status: "PROCESSED", attempts: 2 });
    });

    it("an identity failure (ambiguous phone-only) rolls back the whole message and is permanent", async () => {
      await tenant(t.db);
      await deliver(t.db, { bsuid: "LK.RB5", from: "15550100555" });
      await process(t.db);
      const before = await counts();
      const e = await deliver(t.db, { bsuid: null, from: "15550100555", message: richMessage });
      expect(await process(t.db)).toMatchObject({ dead: 1 });
      expect(await counts()).toEqual(before);
      expect(await eventStatus(t.db, e.id)).toMatchObject({
        status: "DEAD",
        lastError: "phone_only_identity_ambiguous",
      });
    });
  });

  // ---------------------------------------------------------------------------------------------- lease fencing
  describe("lease fencing", () => {
    it("a worker that lost its lease BEFORE writing sees the message already stored, writes nothing, and its completion is refused", async () => {
      await tenant(t.db);
      const e = await deliver(t.db, { bsuid: "LK.F1", message: richMessage });
      const inHandler = gate();
      const hold = gate();
      const stale = process(t.db, {
        handlers: {
          MESSAGE: async (tx, event, context) => {
            inHandler.resolve();
            await hold.promise; // stuck before its first domain write
            await handleInboundMessage(tx, event, context);
          },
        },
      });
      await inHandler.promise;
      await expireLeases(t.pool); // the lease runs out; another worker reclaims and finishes the event
      expect(await process(t.db)).toMatchObject({ claimed: 1, processed: 1 });
      const afterReclaim = await counts();
      hold.resolve(); // the stale worker wakes up
      expect(await stale).toMatchObject({
        claimed: 1,
        leaseLost: 1,
        processed: 0,
        failed: 0,
        dead: 0,
      });
      expect(await counts()).toEqual(afterReclaim);
      expect(afterReclaim).toEqual({
        contacts: 1,
        aliases: 1,
        conversations: 1,
        messages: 1,
        attachments: 1,
        attributions: 1,
      });
      expect(await eventStatus(t.db, e.id)).toMatchObject({ status: "PROCESSED", attempts: 2 });
    });

    it("once a worker has written domain rows its event cannot be reclaimed (they reference it), and its own completion then succeeds", async () => {
      await tenant(t.db);
      const e = await deliver(t.db, { bsuid: "LK.F3", message: richMessage });
      const written = gate();
      const hold = gate();
      const slow = process(t.db, {
        handlers: {
          MESSAGE: async (tx, event, context) => {
            await handleInboundMessage(tx, event, context);
            written.resolve();
            await hold.promise;
          },
        },
      });
      await written.promise;
      await expireLeases(t.pool);
      // the row is key-share locked by the writer's foreign keys: SKIP LOCKED passes over it
      expect(await process(t.db)).toMatchObject({ claimed: 0 });
      hold.resolve();
      expect(await slow).toMatchObject({ claimed: 1, processed: 1, leaseLost: 0 });
      expect(await counts()).toEqual({
        contacts: 1,
        aliases: 1,
        conversations: 1,
        messages: 1,
        attachments: 1,
        attributions: 1,
      });
      expect(await eventStatus(t.db, e.id)).toMatchObject({ status: "PROCESSED", attempts: 1 });
    });

    it("the handler never completes the event itself: it returns, and only the queue's fenced update changes the status", async () => {
      await tenant(t.db);
      const e = await deliver(t.db, { bsuid: "LK.F2" });
      await handleDirect(t.db, e); // the handler alone, outside any queue claim
      expect(await eventStatus(t.db, e.id)).toMatchObject({ status: "PENDING", attempts: 0 });
      expect(await count("messages")).toBe(1);
    });
  });

  // --------------------------------------------------------------------------------------- deadlock freedom
  it("many mixed messages (new contacts, repeats, replies, media, referrals, two accounts) processed concurrently never deadlock", async () => {
    const { org } = await tenant(t.db);
    await addAccount(t.db, org.id, PN2, WABA2);
    const events: StoredEvent[] = [];
    for (let i = 0; i < 30; i++) {
      events.push(
        await deliver(t.db, {
          bsuid: `LK.MIX${i % 5}`,
          from: `1555030000${i % 5}`,
          pn: i % 3 === 0 ? PN2 : PN,
          waba: i % 3 === 0 ? WABA2 : WABA,
          message:
            i % 4 === 0
              ? richMessage
              : {
                  type: "text",
                  text: { body: `m${i}` },
                  ...(i % 7 === 0 ? { context: { id: `wamid.NONE${i}` } } : {}),
                },
          id: `wamid.MIX${i}`,
          timestamp: minutesAgo(100 - i),
        }),
      );
    }
    const results = await Promise.allSettled(events.map((e) => handleDirect(t.db, e)));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(await count("messages")).toBe(30);
    expect(await count("contacts")).toBe(5);
  });
});
