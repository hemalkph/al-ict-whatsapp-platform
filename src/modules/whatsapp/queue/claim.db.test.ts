import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimWebhookEventRows } from "@/db/ops/webhook-queue";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { deferred, expireLeases, getEvent, insertEvent, pending, world } from "./testing";

// Claiming against REAL PostgreSQL: eligibility, ordering, attempts, SKIP LOCKED under contention.

describe("webhook queue claiming", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.pool.query(
      "truncate webhook_events, webhook_requests, whatsapp_accounts, organizations cascade",
    );
  });

  const claim = (
    limit: number,
    workerId = "w",
    extra: { eventTypes?: string[]; lease?: number } = {},
  ) =>
    claimWebhookEventRows(t.db, {
      limit,
      workerId,
      leaseSeconds: extra.lease ?? 120,
      eventTypes: extra.eventTypes,
    });
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i));

  it("returns nothing from an empty queue", async () => {
    expect(await claim(10)).toEqual([]);
  });

  it("claims one event: PROCESSING, owner and lease stamped, attempts 1, row fields returned", async () => {
    const w = await world(t.db);
    const e = await pending(t.db, w);
    const [claimed] = await claim(5, "owner-1");
    expect(claimed).toMatchObject({
      id: e.id,
      eventType: "MESSAGE",
      organizationId: w.org.id,
      whatsappAccountId: w.account.id,
      attempts: 1,
    });
    expect(claimed!.receivedAt).toBeInstanceOf(Date);
    const row = await getEvent(t.pool, e.id);
    expect(row).toMatchObject({ status: "PROCESSING", attempts: 1, locked_by: "owner-1" });
    expect(row.locked_at).toBeInstanceOf(Date);
  });

  it("honours the batch limit and returns rows ordered by received_at then id", async () => {
    const w = await world(t.db);
    const ids: string[] = [];
    for (const i of [4, 1, 3, 0, 2]) ids.push((await pending(t.db, w, { receivedAt: at(i) })).id);
    const first = await claim(3);
    expect(first.map((e) => e.receivedAt.getTime())).toEqual(
      [at(0), at(1), at(2)].map((d) => d.getTime()),
    );
    const rest = await claim(10);
    expect(rest).toHaveLength(2);
    expect((await claim(10)).length).toBe(0);
  });

  it("claims due PENDING and due FAILED, never future-dated ones", async () => {
    const w = await world(t.db);
    const pendingDue = await pending(t.db, w);
    const failedDue = await pending(t.db, w, { status: "FAILED", attempts: 2 });
    const pendingFuture = await pending(t.db, w);
    const failedFuture = await pending(t.db, w, { status: "FAILED", attempts: 2 });
    await t.pool.query(
      "update webhook_events set next_attempt_at = now() + interval '1 hour' where id = any($1)",
      [[pendingFuture.id, failedFuture.id]],
    );
    const ids = (await claim(10)).map((e) => e.id).sort();
    expect(ids).toEqual([pendingDue.id, failedDue.id].sort());
    expect((await getEvent(t.pool, failedDue.id)).attempts).toBe(3);
  });

  it("reclaims PROCESSING only after the lease expired, and counts the reclaim as a new attempt", async () => {
    const w = await world(t.db);
    const e = await pending(t.db, w);
    await claim(1, "first");
    expect(await claim(1, "second")).toEqual([]); // live lease
    await expireLeases(t.pool);
    const [again] = await claim(1, "second");
    expect(again).toMatchObject({ id: e.id, attempts: 2 });
    expect((await getEvent(t.pool, e.id)).locked_by).toBe("second");
  });

  it("reclaims a PROCESSING row that has no lease timestamp rather than stranding it", async () => {
    const w = await world(t.db);
    const e = await pending(t.db, w, { status: "PROCESSING", attempts: 1 });
    expect((await claim(1)).map((x) => x.id)).toEqual([e.id]);
  });

  it("never claims PROCESSED, DEAD, UNROUTABLE or IGNORED events, however old", async () => {
    const w = await world(t.db);
    for (const status of ["PROCESSED", "DEAD", "UNROUTABLE", "IGNORED"] as const)
      await pending(t.db, w, { status, receivedAt: at(0) });
    expect(await claim(10)).toEqual([]);
    await expireLeases(t.pool);
    expect(await claim(10)).toEqual([]);
  });

  it("claims only the requested event types; an empty list claims nothing", async () => {
    const w = await world(t.db);
    const message = await pending(t.db, w, { eventType: "MESSAGE" });
    const status = await pending(t.db, w, { eventType: "STATUS" });
    expect(await claim(10, "w", { eventTypes: [] })).toEqual([]);
    expect((await claim(10, "w", { eventTypes: ["STATUS"] })).map((e) => e.id)).toEqual([
      status.id,
    ]);
    expect((await getEvent(t.pool, message.id)).attempts).toBe(0);
    expect((await getEvent(t.pool, message.id)).status).toBe("PENDING");
  });

  it("increments attempts exactly once per claim", async () => {
    const w = await world(t.db);
    const e = await pending(t.db, w);
    await claim(1);
    expect((await getEvent(t.pool, e.id)).attempts).toBe(1);
    for (let n = 2; n <= 4; n++) {
      await expireLeases(t.pool);
      await claim(1);
      expect((await getEvent(t.pool, e.id)).attempts).toBe(n);
    }
  });

  it("never hands one live event to two of many concurrent workers (repeated high-contention rounds)", async () => {
    const w = await world(t.db);
    for (let round = 0; round < 8; round++) {
      await t.pool.query("truncate webhook_events, webhook_requests cascade");
      const total = 80;
      for (let i = 0; i < total; i++) await pending(t.db, w, { receivedAt: at(i) });
      const perWorker = await Promise.all(
        Array.from({ length: 8 }, async (_, k) => {
          const mine: string[] = [];
          for (;;) {
            const got = await claim(3, `w${k}`);
            if (got.length === 0) return mine;
            mine.push(...got.map((e) => e.id));
          }
        }),
      );
      const all = perWorker.flat();
      expect(all).toHaveLength(total);
      expect(new Set(all).size).toBe(total);
      const attempts = await t.pool.query("select distinct attempts from webhook_events");
      expect(attempts.rows).toEqual([{ attempts: 1 }]);
    }
  });

  it("skips rows another transaction holds locked instead of waiting for them (SKIP LOCKED)", async () => {
    const w = await world(t.db);
    for (let i = 0; i < 6; i++) await pending(t.db, w, { receivedAt: at(i) });
    const locked = deferred();
    const release = deferred();
    let first: string[] = [];
    const holder = t.db.transaction(async (tx) => {
      first = (
        await claimWebhookEventRows(tx, { limit: 3, workerId: "holder", leaseSeconds: 120 })
      ).map((e) => e.id);
      locked.resolve();
      await release.promise; // the first three rows stay locked and uncommitted
    });
    await locked.promise;
    const started = Date.now();
    const second = (await claim(10, "other")).map((e) => e.id);
    expect(Date.now() - started).toBeLessThan(3000); // returned without waiting for the holder
    release.resolve();
    await holder;
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    expect(new Set([...first, ...second]).size).toBe(6);
  });

  it("concurrent reclaimers of one expired lease: exactly one wins", async () => {
    const w = await world(t.db);
    const e = await pending(t.db, w);
    await claim(1, "dead-worker");
    await expireLeases(t.pool);
    const results = await Promise.all(Array.from({ length: 6 }, (_, k) => claim(1, `r${k}`)));
    expect(results.flat().map((x) => x.id)).toEqual([e.id]);
    expect((await getEvent(t.pool, e.id)).attempts).toBe(2);
  });

  it("does not claim events whose status is eligible but belongs to another type filter", async () => {
    await insertEvent(t.db, { eventType: "OTHER" });
    expect(await claim(5, "w", { eventTypes: ["MESSAGE", "STATUS"] })).toEqual([]);
  });
});
