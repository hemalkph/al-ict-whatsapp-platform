import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { schema } from "@/db";
import { resolveStatusEventsForMessage } from "@/db/ops/message-status";
import type { WebhookHandlerRegistry } from "../queue/process";
import { FIXTURE_DEFERRED_DDL, deferred, expireLeases, insertEvent, until } from "../queue/testing";
import { handleMessageStatus } from "./handler";
import {
  PN,
  WABA,
  deliverStatus,
  eventStatus,
  handleStatusDirect,
  processBoth,
  processStatuses,
  seedMessage,
  tenant,
} from "./testing";

// Races, rollback and lease fencing for the STATUS handler, on REAL PostgreSQL.

const BASE = 1_790_000_000;
const at = (s: number) => String(BASE + s);
const ts = (s: number) => new Date((BASE + s) * 1000);

describe("status handler: concurrency, rollback and fencing", () => {
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
    await t.pool.query("drop trigger if exists test_fail_status on message_status_events");
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
  const history = (wamid: string) =>
    rows("select * from message_status_events where wamid = $1 order by occurred_at, status", [
      wamid,
    ]);
  const message = async (id: string) =>
    (await rows("select * from messages where id = $1", [id]))[0];

  // ------------------------------------------------------------------------------------------------- races
  describe("races", () => {
    it("every status of one message handled at once converges on READ with a complete history (repeated rounds)", async () => {
      const { org, account } = await tenant(t.db);
      for (let round = 0; round < 8; round++) {
        const wamid = `wamid.RACE${round}`;
        const { message: m } = await seedMessage(t.db, {
          organizationId: org.id,
          whatsappAccountId: account.id,
          wamid,
        });
        const events = await Promise.all(
          (["read", "sent", "delivered", "failed"] as const).map((status, i) =>
            deliverStatus(t.db, { id: wamid, status, timestamp: at(round * 100 + i * 5) }),
          ),
        );
        const results = await Promise.allSettled(events.map((e) => handleStatusDirect(t.db, e)));
        expect(results.map((r) => r.status)).toEqual(Array(4).fill("fulfilled"));
        expect(await history(wamid), `round ${round}`).toHaveLength(4);
        expect(await message(m.id), `round ${round}`).toMatchObject({ latest_status: "READ" });
      }
    });

    it("the same event handled by two connections at once writes one row and the cache is unharmed", async () => {
      const { org, account } = await tenant(t.db);
      const { message: m } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.SAME",
      });
      for (let round = 0; round < 6; round++) {
        const e = await deliverStatus(t.db, {
          id: "wamid.SAME",
          status: "delivered",
          timestamp: at(round),
        });
        const copies = await Promise.all(
          Array.from({ length: 3 }, () =>
            insertEvent(t.db, {
              organizationId: e.organizationId,
              whatsappAccountId: e.whatsappAccountId,
              payload: e.payload,
              phoneNumberId: PN,
              wabaId: WABA,
              eventType: "STATUS",
            }),
          ),
        );
        const results = await Promise.allSettled(
          [e, ...copies.map((c) => ({ ...e, id: c.id }))].map((c) => handleStatusDirect(t.db, c)),
        );
        expect(results.map((r) => r.status)).toEqual(Array(4).fill("fulfilled"));
      }
      expect(await history("wamid.SAME")).toHaveLength(6);
      expect(await message(m.id)).toMatchObject({ latest_status: "DELIVERED" });
    });

    it("three whole workers draining a mixed queue process every status exactly once", async () => {
      const { org, account } = await tenant(t.db);
      const wamids = ["wamid.W0", "wamid.W1", "wamid.W2"];
      const ids = [];
      for (const wamid of wamids)
        ids.push(
          (
            await seedMessage(t.db, {
              organizationId: org.id,
              whatsappAccountId: account.id,
              wamid,
            })
          ).message.id,
        );
      for (let i = 0; i < 18; i++)
        await deliverStatus(t.db, {
          id: wamids[i % 3]!,
          status: (["sent", "delivered", "read"] as const)[i % 3]!,
          timestamp: at(i),
        });
      const summaries = await Promise.all([
        processBoth(t.db),
        processBoth(t.db),
        processBoth(t.db),
      ]);
      expect(summaries.reduce((n, s) => n + s.processed, 0)).toBe(18);
      expect(summaries.reduce((n, s) => n + s.failed + s.dead + s.leaseLost, 0)).toBe(0);
      expect(await count("message_status_events")).toBe(18);
      for (const [i, id] of ids.entries())
        expect(await message(id)).toMatchObject({
          latest_status: (["SENT", "DELIVERED", "READ"] as const)[i],
        });
    });

    it("orphan statuses racing for one future message are all kept once", async () => {
      await tenant(t.db);
      const events = await Promise.all(
        (["sent", "delivered", "read"] as const).map((status, i) =>
          deliverStatus(t.db, { id: "wamid.ORPH", status, timestamp: at(i) }),
        ),
      );
      await Promise.all(events.map((e) => handleStatusDirect(t.db, e)));
      const h = await history("wamid.ORPH");
      expect(h).toHaveLength(3);
      expect(h.every((x) => x.message_id === null)).toBe(true);
    });

    it("the same wamid on two organizations handled at once never crosses over", async () => {
      const a = await tenant(t.db);
      const b = await tenant(t.db, { pn: "100000000000002", waba: "200000000000002" });
      const ma = await seedMessage(t.db, {
        organizationId: a.org.id,
        whatsappAccountId: a.account.id,
        wamid: "wamid.X",
      });
      const mb = await seedMessage(t.db, {
        organizationId: b.org.id,
        whatsappAccountId: b.account.id,
        wamid: "wamid.X",
      });
      const events = await Promise.all([
        deliverStatus(t.db, { id: "wamid.X", status: "delivered", timestamp: at(0) }),
        deliverStatus(t.db, {
          id: "wamid.X",
          status: "read",
          timestamp: at(1),
          pn: "100000000000002",
          waba: "200000000000002",
        }),
      ]);
      await Promise.all(events.map((e) => handleStatusDirect(t.db, e)));
      expect(await message(ma.message.id)).toMatchObject({ latest_status: "DELIVERED" });
      expect(await message(mb.message.id)).toMatchObject({ latest_status: "READ" });
    });
  });

  // ---------------------------------------------------------------- status versus creation of the message
  describe("a status racing the creation of its message", () => {
    const lockKey = (org: string, account: string, wamid: string) =>
      `wa-message:${org}:${account}:${wamid}`;

    it("blocks on the per-message lock while the outbound writer holds it, then links and applies the status once the message is committed", async () => {
      const { org, account } = await tenant(t.db);
      const e = await deliverStatus(t.db, {
        id: "wamid.LATEMSG",
        status: "read",
        timestamp: at(9),
      });
      const created = gate();
      const commit = gate();
      let messageId = "";
      // the future outbound writer: lock, insert the message, reconcile, then commit
      const writer = t.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(org.id, account.id, "wamid.LATEMSG")}, 0))`,
        );
        const [conversationSeed] = await tx
          .insert(schema.contacts)
          .values({
            organizationId: org.id,
            waId: "wa-writer",
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
          })
          .returning();
        const [conversation] = await tx
          .insert(schema.conversations)
          .values({
            organizationId: org.id,
            whatsappAccountId: account.id,
            contactId: conversationSeed!.id,
            lastMessageAt: new Date(),
          })
          .returning();
        const [m] = await tx
          .insert(schema.messages)
          .values({
            organizationId: org.id,
            conversationId: conversation!.id,
            whatsappAccountId: account.id,
            wamid: "wamid.LATEMSG",
            direction: "OUTBOUND",
            type: "TEXT",
            body: "x",
            occurredAt: new Date(),
          })
          .returning();
        messageId = m!.id;
        created.resolve();
        await commit.promise;
        await resolveStatusEventsForMessage(tx, {
          id: m!.id,
          organizationId: org.id,
          whatsappAccountId: account.id,
          wamid: "wamid.LATEMSG",
        });
      });
      await created.promise;
      let finished = false;
      const status = handleStatusDirect(t.db, e).then(() => void (finished = true));
      // the handler is parked on the advisory lock (a waiting, ungranted lock request in this database)
      await until(
        async () =>
          (
            await t.pool.query(
              "select count(*)::int n from pg_locks l join pg_database d on d.oid = l.database where l.locktype = 'advisory' and not l.granted and d.datname = current_database()",
            )
          ).rows[0].n === 1,
      );
      expect(finished).toBe(false);
      expect(await count("message_status_events")).toBe(0);
      commit.resolve();
      await writer;
      await status;
      expect(await history("wamid.LATEMSG")).toMatchObject([
        { message_id: messageId, status: "READ" },
      ]);
      expect(await message(messageId)).toMatchObject({
        latest_status: "READ",
        latest_status_at: ts(9),
      });
    });

    it("a status that wins the race is reconciled by the writer's resolve step: the final state is the same", async () => {
      const { org, account } = await tenant(t.db);
      const e = await deliverStatus(t.db, {
        id: "wamid.WIN",
        status: "delivered",
        timestamp: at(3),
      });
      await handleStatusDirect(t.db, e); // arrives first: unlinked
      expect((await history("wamid.WIN"))[0].message_id).toBeNull();
      const { message: m } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.WIN",
      });
      await t.db.transaction((tx) =>
        resolveStatusEventsForMessage(tx, {
          id: m.id,
          organizationId: org.id,
          whatsappAccountId: account.id,
          wamid: "wamid.WIN",
        }),
      );
      expect((await history("wamid.WIN"))[0].message_id).toBe(m.id);
      expect(await message(m.id)).toMatchObject({
        latest_status: "DELIVERED",
        latest_status_at: ts(3),
      });
    });
  });

  // -------------------------------------------------------------------------------------------------- rollback
  describe("rollback: the status writes and the event's final state stand or fall together", () => {
    const wrap = (
      after: (
        tx: Parameters<typeof handleMessageStatus>[0],
        e: Parameters<typeof handleMessageStatus>[1],
      ) => Promise<void>,
    ): WebhookHandlerRegistry => ({
      STATUS: async (tx, e, c) => {
        await handleMessageStatus(tx, e, c);
        await after(tx, e);
      },
    });

    it("an exception after the writes rolls back the history row and the message cache", async () => {
      const { org, account } = await tenant(t.db);
      const { message: m } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.RB1",
      });
      const e = await deliverStatus(t.db, { id: "wamid.RB1", status: "read", timestamp: at(0) });
      const summary = await processStatuses(t.db, {
        handlers: wrap(async (tx) => {
          // by now both writes exist inside the transaction
          const [inTx] = await tx
            .execute(sql`select latest_status from messages where id = ${m.id}`)
            .then((r) => r.rows);
          expect(inTx).toMatchObject({ latest_status: "READ" });
          throw new Error("later step failed");
        }),
      });
      expect(summary).toMatchObject({ claimed: 1, failed: 1, processed: 0 });
      expect(await count("message_status_events")).toBe(0);
      expect(await message(m.id)).toMatchObject({ latest_status: null, latest_status_at: null });
      expect(await eventStatus(t.db, e.id)).toMatchObject({ status: "FAILED", attempts: 1 });
    });

    it("a deferred-constraint failure at COMMIT discards the writes and the event is not PROCESSED", async () => {
      const { org, account } = await tenant(t.db);
      const { message: m } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.RB2",
      });
      const e = await deliverStatus(t.db, {
        id: "wamid.RB2",
        status: "delivered",
        timestamp: at(0),
      });
      const summary = await processStatuses(t.db, {
        handlers: wrap(
          async (tx) =>
            void (await tx.execute(
              sql`insert into queue_fixture_children (parent_id) values (999)`,
            )),
        ),
      });
      expect(summary).toMatchObject({ failed: 1, processed: 0 });
      expect(await count("message_status_events")).toBe(0);
      expect((await message(m.id)).latest_status).toBeNull();
      expect(await eventStatus(t.db, e.id)).toMatchObject({
        status: "FAILED",
        lastError: "pg_23503",
      });
    });

    it("a database error while inserting the history row fails the event and persists nothing", async () => {
      const { org, account } = await tenant(t.db);
      const { message: m } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.RB3",
      });
      await t.pool.query(`
        create or replace function test_fail_status() returns trigger language plpgsql as $$
        begin raise exception 'injected status failure' using errcode = '23514'; end $$`);
      await t.pool.query(
        "create trigger test_fail_status before insert on message_status_events for each row execute function test_fail_status()",
      );
      const e = await deliverStatus(t.db, { id: "wamid.RB3", status: "read", timestamp: at(0) });
      const summary = await processStatuses(t.db);
      expect(summary).toMatchObject({ claimed: 1, failed: 1, processed: 0 });
      expect(await count("message_status_events")).toBe(0);
      expect((await message(m.id)).latest_status).toBeNull();
      expect(await eventStatus(t.db, e.id)).toMatchObject({
        status: "FAILED",
        lastError: "pg_23514",
      });
    });

    it("a failed event is retried later and then completes with exactly one history row", async () => {
      const { org, account } = await tenant(t.db);
      const { message: m } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.RB4",
      });
      const e = await deliverStatus(t.db, {
        id: "wamid.RB4",
        status: "delivered",
        timestamp: at(0),
      });
      await processStatuses(t.db, {
        handlers: wrap(async () => {
          throw new Error("transient");
        }),
      });
      expect(await count("message_status_events")).toBe(0);
      await t.pool.query("update webhook_events set next_attempt_at = now() where id = $1", [e.id]);
      expect(await processStatuses(t.db)).toMatchObject({ processed: 1 });
      expect(await history("wamid.RB4")).toHaveLength(1);
      expect(await message(m.id)).toMatchObject({ latest_status: "DELIVERED" });
      expect(await eventStatus(t.db, e.id)).toMatchObject({ status: "PROCESSED", attempts: 2 });
    });

    it("an invalid timestamp is permanent: the event is DEAD at once and nothing was written", async () => {
      await tenant(t.db);
      const e = await deliverStatus(t.db, { id: "wamid.RB5", status: "read", timestamp: "oops" });
      expect(await processStatuses(t.db)).toMatchObject({ dead: 1, processed: 0 });
      expect(await count("message_status_events")).toBe(0);
      expect(await eventStatus(t.db, e.id)).toMatchObject({
        status: "DEAD",
        lastError: "invalid_timestamp",
      });
    });
  });

  // ---------------------------------------------------------------------------------------------- lease fencing
  describe("lease fencing", () => {
    it("a worker that lost its lease BEFORE writing finds the status already stored, adds nothing, and its completion is refused", async () => {
      const { org, account } = await tenant(t.db);
      const { message: m } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.F1",
      });
      const e = await deliverStatus(t.db, { id: "wamid.F1", status: "read", timestamp: at(0) });
      const inHandler = gate();
      const hold = gate();
      const stale = processStatuses(t.db, {
        handlers: {
          STATUS: async (tx, event, context) => {
            inHandler.resolve();
            await hold.promise;
            await handleMessageStatus(tx, event, context);
          },
        },
      });
      await inHandler.promise;
      await expireLeases(t.pool);
      expect(await processStatuses(t.db)).toMatchObject({ claimed: 1, processed: 1 });
      const after = { history: await history("wamid.F1"), message: await message(m.id) };
      hold.resolve();
      expect(await stale).toMatchObject({
        claimed: 1,
        leaseLost: 1,
        processed: 0,
        failed: 0,
        dead: 0,
      });
      expect({ history: await history("wamid.F1"), message: await message(m.id) }).toEqual(after);
      expect(after.history).toHaveLength(1);
      expect(await eventStatus(t.db, e.id)).toMatchObject({ status: "PROCESSED", attempts: 2 });
    });

    it("once a worker has written its history row the event cannot be reclaimed (the row references it) and its own completion succeeds", async () => {
      const { org, account } = await tenant(t.db);
      await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.F2",
      });
      const e = await deliverStatus(t.db, {
        id: "wamid.F2",
        status: "delivered",
        timestamp: at(0),
      });
      const written = gate();
      const hold = gate();
      const slow = processStatuses(t.db, {
        handlers: {
          STATUS: async (tx, event, context) => {
            await handleMessageStatus(tx, event, context);
            written.resolve();
            await hold.promise;
          },
        },
      });
      await written.promise;
      await expireLeases(t.pool);
      expect(await processStatuses(t.db)).toMatchObject({ claimed: 0 });
      hold.resolve();
      expect(await slow).toMatchObject({ claimed: 1, processed: 1, leaseLost: 0 });
      expect(await history("wamid.F2")).toHaveLength(1);
      expect(await eventStatus(t.db, e.id)).toMatchObject({ status: "PROCESSED", attempts: 1 });
    });

    it("the handler never completes the event itself: only the queue's fenced update changes the status", async () => {
      await tenant(t.db);
      const e = await deliverStatus(t.db, { id: "wamid.F3", status: "sent", timestamp: at(0) });
      await handleStatusDirect(t.db, e);
      expect(await eventStatus(t.db, e.id)).toMatchObject({ status: "PENDING", attempts: 0 });
      expect(await count("message_status_events")).toBe(1);
    });
  });
});
