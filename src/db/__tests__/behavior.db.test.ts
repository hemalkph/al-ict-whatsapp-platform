import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { schema } from "../index";
import { recordMarketingConsent } from "../ops/consent";
import { getConversation, upsertConversationActivity } from "../ops/conversation-activity";
import { recordMessageStatus, resolveStatusEventsForMessage } from "../ops/message-status";
import { claimWebhookEvents } from "../ops/webhook-queue";
import {
  createTestDatabase,
  seedMessage,
  seedWebhookEvent,
  seedWorld,
  type TestDb,
} from "./helpers";

type Status = "SENT" | "FAILED" | "DELIVERED" | "READ";
const ALL: Status[] = ["SENT", "FAILED", "DELIVERED", "READ"];
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute, 0));

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
  );
}

describe("database behaviors on real PostgreSQL", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  });
  afterAll(async () => t.close());

  describe("message status transitions", () => {
    async function freshMessage() {
      const w = await seedWorld(db);
      const m = await seedMessage(db, {
        organizationId: w.org.id,
        conversationId: w.conversation.id,
        whatsappAccountId: w.account.id,
      });
      return { w, m };
    }
    const send = (x: Awaited<ReturnType<typeof freshMessage>>, status: Status, minute: number) =>
      db.transaction((tx) =>
        recordMessageStatus(tx, {
          organizationId: x.w.org.id,
          whatsappAccountId: x.w.account.id,
          wamid: x.m.wamid!,
          status,
          occurredAt: at(minute),
          errorCode: status === "FAILED" ? "131026" : null,
          errorMessage: status === "FAILED" ? "undeliverable" : null,
        }),
      );
    const latest = async (id: string) =>
      (await db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0]!;

    // current (null = none yet) x incoming -> expected latest_status, written out explicitly.
    const TABLE: Record<string, Record<Status, Status | null>> = {
      NONE: { SENT: "SENT", FAILED: "FAILED", DELIVERED: "DELIVERED", READ: "READ" },
      SENT: { SENT: "SENT", FAILED: "FAILED", DELIVERED: "DELIVERED", READ: "READ" },
      FAILED: { SENT: "FAILED", FAILED: "FAILED", DELIVERED: "DELIVERED", READ: "READ" },
      DELIVERED: { SENT: "DELIVERED", FAILED: "DELIVERED", DELIVERED: "DELIVERED", READ: "READ" },
      READ: { SENT: "READ", FAILED: "READ", DELIVERED: "READ", READ: "READ" },
    };

    for (const current of ["NONE", ...ALL]) {
      for (const incoming of ALL) {
        it(`${current} + incoming ${incoming} -> ${TABLE[current]![incoming]}`, async () => {
          const x = await freshMessage();
          if (current !== "NONE") await send(x, current as Status, 1);
          await send(x, incoming, 2);
          expect((await latest(x.m.id)).latestStatus).toBe(TABLE[current]![incoming]);
        });
      }
    }

    it("is order-independent: every permutation of the same events gives the same result", async () => {
      const cases: Array<[Status[], Status]> = [
        [["SENT", "FAILED"], "FAILED"],
        [["SENT", "DELIVERED"], "DELIVERED"],
        [["SENT", "FAILED", "DELIVERED"], "DELIVERED"],
        [["SENT", "DELIVERED", "READ"], "READ"],
        [["SENT", "FAILED", "DELIVERED", "READ"], "READ"],
      ];
      for (const [events, expected] of cases) {
        for (const order of permutations(events)) {
          const x = await freshMessage();
          // occurred_at follows the *logical* order (SENT earliest) regardless of arrival order
          for (const s of order) await send(x, s, ALL.indexOf(s) + 1);
          expect((await latest(x.m.id)).latestStatus, `${order.join(">")}`).toBe(expected);
        }
      }
    });

    it("is idempotent: replaying an event changes nothing and reports a duplicate", async () => {
      const x = await freshMessage();
      const first = await send(x, "DELIVERED", 3);
      const before = await latest(x.m.id);
      const again = await send(x, "DELIVERED", 3);
      expect(first.duplicate).toBe(false);
      expect(again.duplicate).toBe(true);
      expect((await latest(x.m.id)).latestStatusAt).toEqual(before.latestStatusAt);
      const n = await t.pool.query(
        "select count(*)::int n from message_status_events where wamid = $1",
        [x.m.wamid],
      );
      expect(n.rows[0].n).toBe(1);
    });

    it("keeps FAILED error info only while FAILED is the winning status", async () => {
      const x = await freshMessage();
      await send(x, "FAILED", 1);
      expect((await latest(x.m.id)).errorCode).toBe("131026");
      await send(x, "DELIVERED", 2); // later DELIVERED proves FAILED was not final
      const m = await latest(x.m.id);
      expect(m.latestStatus).toBe("DELIVERED");
      expect(m.errorCode).toBeNull();
      const history = await t.pool.query(
        "select status from message_status_events where wamid = $1 order by occurred_at",
        [x.m.wamid],
      );
      expect(history.rows.map((r) => r.status)).toEqual(["FAILED", "DELIVERED"]); // history stays authoritative
    });

    it("stores a status that arrives before its message and resolves it afterwards", async () => {
      const w = await seedWorld(db);
      const wamid = "wamid.EARLY";
      const ev = (status: Status, minute: number) =>
        db.transaction((tx) =>
          recordMessageStatus(tx, {
            organizationId: w.org.id,
            whatsappAccountId: w.account.id,
            wamid,
            status,
            occurredAt: at(minute),
          }),
        );
      const r1 = await ev("DELIVERED", 2);
      const r2 = await ev("SENT", 1);
      expect(r1.messageId).toBeNull();
      expect(r2.messageId).toBeNull();

      const m = await seedMessage(db, {
        organizationId: w.org.id,
        conversationId: w.conversation.id,
        whatsappAccountId: w.account.id,
        wamid,
      });
      expect(m.latestStatus).toBeNull();
      await db.transaction((tx) =>
        resolveStatusEventsForMessage(tx, {
          id: m.id,
          organizationId: w.org.id,
          whatsappAccountId: w.account.id,
          wamid,
        }),
      );
      const resolved = (
        await db.select().from(schema.messages).where(eq(schema.messages.id, m.id))
      )[0]!;
      expect(resolved.latestStatus).toBe("DELIVERED");
      const events = await t.pool.query(
        "select message_id from message_status_events where wamid = $1",
        [wamid],
      );
      expect(events.rows.every((r) => r.message_id === m.id)).toBe(true);

      // later events now apply directly
      const r3 = await ev("READ", 3);
      expect(r3.messageId).toBe(m.id);
      expect(
        (await db.select().from(schema.messages).where(eq(schema.messages.id, m.id)))[0]!
          .latestStatus,
      ).toBe("READ");
    });

    it("applies concurrent out-of-order events correctly", async () => {
      const x = await freshMessage();
      await Promise.all(
        permutations(ALL)
          .slice(0, 6)
          .flatMap((order) => order.map((s) => send(x, s, ALL.indexOf(s) + 1))),
      );
      expect((await latest(x.m.id)).latestStatus).toBe("READ");
    });
  });

  describe("conversation activity timestamps", () => {
    it("never move backwards under out-of-order messages, and are set from occurred_at", async () => {
      const w = await seedWorld(db);
      const contact2 = (
        await db
          .insert(schema.contacts)
          .values({
            organizationId: w.org.id,
            waId: "wa-activity",
            firstSeenAt: at(0),
            lastSeenAt: at(0),
          })
          .returning()
      )[0]!;
      const base = {
        organizationId: w.org.id,
        whatsappAccountId: w.account.id,
        contactId: contact2.id,
      };
      const step = (direction: "INBOUND" | "OUTBOUND", minute: number) =>
        db.transaction((tx) =>
          upsertConversationActivity(tx, { ...base, direction, occurredAt: at(minute) }),
        );
      const read = async (id: string) => db.transaction((tx) => getConversation(tx, id));

      const id = await step("OUTBOUND", 10); // created by an outbound first message
      let c = (await read(id))!;
      expect(c.lastMessageAt).toEqual(at(10));
      expect(c.lastInboundAt).toBeNull();
      expect(c.lastOutboundAt).toEqual(at(10));

      expect(await step("INBOUND", 20)).toBe(id);
      c = (await read(id))!;
      expect([c.lastMessageAt, c.lastInboundAt, c.lastOutboundAt]).toEqual([
        at(20),
        at(20),
        at(10),
      ]);

      await step("INBOUND", 5); // stale inbound
      await step("OUTBOUND", 7); // stale outbound
      c = (await read(id))!;
      expect([c.lastMessageAt, c.lastInboundAt, c.lastOutboundAt]).toEqual([
        at(20),
        at(20),
        at(10),
      ]);

      await step("OUTBOUND", 30);
      c = (await read(id))!;
      expect([c.lastMessageAt, c.lastInboundAt, c.lastOutboundAt]).toEqual([
        at(30),
        at(20),
        at(30),
      ]);

      const n = await t.pool.query(
        "select count(*)::int n from conversations where contact_id = $1",
        [contact2.id],
      );
      expect(n.rows[0].n).toBe(1);
    });
  });

  describe("marketing consent cache invariant", () => {
    async function check(orgId: string, contactId: string) {
      const [contact] = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, contactId));
      const events = await t.pool.query(
        "select action, occurred_at from contact_consents where contact_id = $1 and scope = 'MARKETING' order by occurred_at desc, created_at desc, id desc limit 1",
        [contactId],
      );
      const latest = events.rows[0];
      expect(contact!.marketingConsentStatus).toBe(latest ? latest.action : "UNKNOWN");
      if (latest) expect(contact!.marketingConsentUpdatedAt).toEqual(latest.occurred_at);
      void orgId;
    }
    const record = (
      w: Awaited<ReturnType<typeof seedWorld>>,
      action: "GRANTED" | "WITHDRAWN",
      minute: number,
    ) =>
      db.transaction((tx) =>
        recordMarketingConsent(tx, {
          organizationId: w.org.id,
          contactId: w.contact.id,
          action,
          source: "STAFF_RECORDED",
          sourceRef: `m${minute}`,
          occurredAt: at(minute),
        }),
      );

    it("starts UNKNOWN and always equals the latest event, including out-of-order arrival", async () => {
      const w = await seedWorld(db);
      await check(w.org.id, w.contact.id);
      await record(w, "GRANTED", 10);
      await check(w.org.id, w.contact.id);
      await record(w, "WITHDRAWN", 20);
      await check(w.org.id, w.contact.id);
      await record(w, "GRANTED", 5); // older event arriving late must not override WITHDRAWN
      await check(w.org.id, w.contact.id);
      const [c] = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, w.contact.id));
      expect(c!.marketingConsentStatus).toBe("WITHDRAWN");
      await record(w, "GRANTED", 30);
      await check(w.org.id, w.contact.id);
      const n = await t.pool.query(
        "select count(*)::int n from contact_consents where contact_id = $1",
        [w.contact.id],
      );
      expect(n.rows[0].n).toBe(4); // append-only history
    });

    it("stays consistent under concurrent writers", async () => {
      const w = await seedWorld(db);
      await Promise.all([
        record(w, "GRANTED", 1),
        record(w, "WITHDRAWN", 8),
        record(w, "GRANTED", 4),
        record(w, "WITHDRAWN", 6),
        record(w, "GRANTED", 9),
        record(w, "WITHDRAWN", 2),
      ]);
      await check(w.org.id, w.contact.id);
      const [c] = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, w.contact.id));
      expect(c!.marketingConsentStatus).toBe("GRANTED"); // latest by occurred_at is minute 9
    });
  });

  describe("webhook queue", () => {
    beforeEach(async () => {
      await t.pool.query("truncate webhook_events, webhook_requests cascade");
    });
    const claim = (
      client: Parameters<typeof claimWebhookEvents>[0],
      limit: number,
      worker = "w",
      lease = 60,
    ) => claimWebhookEvents(client, { limit, workerId: worker, leaseSeconds: lease });
    const seed = async (n: number) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) ids.push((await seedWebhookEvent(db, { receivedAt: at(i) })).id);
      return ids;
    };

    it("claims disjoint rows for concurrent workers (FOR UPDATE SKIP LOCKED)", async () => {
      await seed(10);
      let release!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      let started!: () => void;
      const startedP = new Promise<void>((r) => (started = r));
      let first: string[] = [];
      const tx1 = db.transaction(async (tx) => {
        first = await claim(tx, 4, "worker-1");
        started();
        await hold; // keep row locks open while worker 2 claims
      });
      await startedP;
      const second = await claim(db, 4, "worker-2"); // separate connection, must skip worker 1's locked rows
      release();
      await tx1;

      expect(first).toHaveLength(4);
      expect(second).toHaveLength(4);
      expect(new Set([...first, ...second]).size).toBe(8);
      const counts = await t.pool.query(
        "select status, count(*)::int n from webhook_events group by status order by status",
      );
      expect(counts.rows).toEqual([
        { status: "PENDING", n: 2 },
        { status: "PROCESSING", n: 8 },
      ]);
    });

    it("never hands the same event to two of many concurrent claimers", async () => {
      await seed(10);
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => claim(db, 3, `w${i}`)));
      const all = results.flat();
      expect(all).toHaveLength(10);
      expect(new Set(all).size).toBe(10);
    });

    it("increments attempts and respects status/next_attempt_at eligibility", async () => {
      const [due, future, processed, dead, unroutable] = await Promise.all([
        seedWebhookEvent(db, { status: "FAILED" }),
        seedWebhookEvent(db, { status: "FAILED" }),
        seedWebhookEvent(db, { status: "PROCESSED" }),
        seedWebhookEvent(db, { status: "DEAD" }),
        seedWebhookEvent(db, { status: "UNROUTABLE" }),
      ]);
      await db
        .update(schema.webhookEvents)
        .set({ nextAttemptAt: sql`now() + interval '1 hour'` })
        .where(eq(schema.webhookEvents.id, future.id));
      const claimed = await claim(db, 10);
      expect(claimed).toEqual([due.id]);
      expect(claimed).not.toContain(future.id);
      for (const e of [processed, dead, unroutable]) expect(claimed).not.toContain(e.id);
      const [row] = await db
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.id, due.id));
      expect(row!.status).toBe("PROCESSING");
      expect(row!.attempts).toBe(1);
      expect(row!.lockedBy).toBe("w");
    });

    it("reclaims PROCESSING events only after the lease has expired", async () => {
      const expired = await seedWebhookEvent(db, { status: "PROCESSING" });
      const live = await seedWebhookEvent(db, { status: "PROCESSING" });
      await db
        .update(schema.webhookEvents)
        .set({ lockedAt: sql`now() - interval '10 minutes'`, lockedBy: "dead-worker", attempts: 1 })
        .where(eq(schema.webhookEvents.id, expired.id));
      await db
        .update(schema.webhookEvents)
        .set({ lockedAt: sql`now() - interval '5 seconds'`, lockedBy: "busy-worker", attempts: 1 })
        .where(eq(schema.webhookEvents.id, live.id));

      const claimed = await claim(db, 10, "rescuer", 60);
      expect(claimed).toEqual([expired.id]);
      const [row] = await db
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.id, expired.id));
      expect(row!.lockedBy).toBe("rescuer");
      expect(row!.attempts).toBe(2);
      const [stillLive] = await db
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.id, live.id));
      expect(stillLive!.lockedBy).toBe("busy-worker");
    });

    it("has partial indexes for both the due-queue path and the lease-reclaim path", async () => {
      const r = await t.pool.query(
        "select indexname, indexdef from pg_indexes where tablename = 'webhook_events' and indexname in ('webhook_events_queue_idx','webhook_events_lease_idx')",
      );
      const defs = Object.fromEntries(r.rows.map((x) => [x.indexname, x.indexdef as string]));
      expect(defs["webhook_events_queue_idx"]).toMatch(/WHERE .*status.*PENDING.*FAILED/);
      expect(defs["webhook_events_lease_idx"]).toMatch(/locked_at.*WHERE .*status.*PROCESSING/);
    });
  });
});
