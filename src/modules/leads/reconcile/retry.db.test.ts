import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerDatabase } from "@/db";
import { createManualLead } from "../index";
import { contactLockKey } from "../locks";
import { seedLead } from "../testing";
import { DEFAULT_OPTIONS } from "./config";
import { recordFailure } from "./failure";
import { runReconciliation } from "./run";
import {
  addContact,
  addTouch,
  daysAgo,
  fixture,
  injectFailure,
  makeDue,
  minutesAgo,
  holdBarrier,
  installBarrier,
  removeBarrier,
  removeFailure,
  waitUntilBlocked,
  type Fixture,
} from "./testing";

// Retry, PARKED, rollback, crash, starvation and bounded work, on real PostgreSQL and real transactions.

describe("lead reconciler: retries, rollback, starvation and bounded work", () => {
  let f: Fixture;
  const fetchSpy = vi.fn(() => {
    throw new Error("the reconciler must never make a network request");
  });
  beforeEach(async () => {
    f = await fixture();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await f.close();
  });

  const decision = async (touchId: string) =>
    (
      await f.q<{
        decision: string;
        attempts: number;
        seconds: number | null;
        code: string | null;
      }>(
        `select decision, attempts, last_error_code as code,
                extract(epoch from (next_attempt_at - clock_timestamp()))::float as seconds
         from lead_reconcile_decisions where attribution_id = $1`,
        [touchId],
      )
    )[0];
  const count = async (table: string) =>
    (await f.one<{ n: number }>(`select count(*)::int n from ${table}`)).n;
  const linkOf = async (id: string) =>
    (
      await f.one<{ lead_id: string | null }>(
        "select lead_id from lead_attributions where id = $1",
        [id],
      )
    ).lead_id;

  // -------------------------------------------------------------------------------------------- retry policy
  it("RETRY progression: five failed attempts, back-off 1 minute, 5 minutes, 30 minutes, 2 hours, then PARKED for good", async () => {
    const touch = await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(5) });
    await injectFailure(f.t, "CREATED");
    const expected: Array<[number, number]> = [
      [1, 60],
      [2, 300],
      [3, 1_800],
      [4, 7_200],
    ];
    for (const [attempts, seconds] of expected) {
      const report = await f.run();
      expect(report.retryScheduled, `attempt ${attempts}`).toBe(1);
      expect(report.errors).toEqual({ pg_p0001: 1 });
      const d = (await decision(touch.id))!;
      expect(d).toMatchObject({ decision: "RETRY", attempts, code: "pg_p0001" });
      expect(d.seconds!).toBeGreaterThan(seconds - 20);
      expect(d.seconds!).toBeLessThanOrEqual(seconds);
      // not due yet: the next run does not touch it, and says so
      expect(await f.run()).toMatchObject({
        scanned: 0,
        processed: 0,
        remaining: { due: 0, retryWaiting: 1 },
      });
      await makeDue(f.t, touch.id);
    }
    // the fifth failure
    expect((await f.run()).parked).toBe(1);
    expect(await decision(touch.id)).toMatchObject({
      decision: "PARKED",
      attempts: 5,
      seconds: null,
      code: "pg_p0001",
    });
    expect(await linkOf(touch.id)).toBeNull();
    expect(await count("leads")).toBe(0);

    // parked is final: the fault is gone, and nothing reactivates it
    await removeFailure(f.t);
    expect(await f.run()).toMatchObject({
      scanned: 0,
      processed: 0,
      remaining: { due: 0, retryWaiting: 0 },
    });
    expect(await decision(touch.id)).toMatchObject({ decision: "PARKED", attempts: 5 });
    await expect(
      f.q(
        "update lead_reconcile_decisions set decision = 'RETRY', attempts = 1, next_attempt_at = now() + interval '1 hour' where attribution_id = $1",
        [touch.id],
      ),
    ).rejects.toThrow(/terminal decision is final/);
    expect(await count("leads")).toBe(0);
  });

  it("a retry that succeeds removes its RETRY row in the same transaction as the link and the history (a linked touch keeps no decision)", async () => {
    const touch = await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(5) });
    await injectFailure(f.t, "CREATED");
    await f.run();
    await f.run(); // not due
    expect(await decision(touch.id)).toMatchObject({ decision: "RETRY", attempts: 1 });
    await removeFailure(f.t);
    await makeDue(f.t, touch.id);
    expect(await f.run()).toMatchObject({ created: 1, remaining: { due: 0, retryWaiting: 0 } });
    expect(await decision(touch.id)).toBeUndefined();
    expect(await linkOf(touch.id)).not.toBeNull();
    // no linked touch anywhere keeps a decision row (the 07A rule, checked on the data)
    expect(
      await count(
        "(select 1 from lead_reconcile_decisions d join lead_attributions a on a.id = d.attribution_id where a.lead_id is not null) x",
      ),
    ).toBe(0);

    // the same for a touch that is linked to an EXISTING open lead
    const contact = await addContact(f.t.db, f.w.org.id);
    const manual = await createManualLead(f.w.staff.ctx, { contactId: contact.id }, { db: f.t.db });
    const t2 = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(Date.now() + 60_000),
    });
    await injectFailure(f.t, "TOUCH_LINKED");
    expect((await f.run()).retryScheduled).toBe(1);
    expect(await linkOf(t2.id)).toBeNull();
    await removeFailure(f.t);
    await makeDue(f.t, t2.id);
    expect(await f.run()).toMatchObject({ linked: 1 });
    expect(await linkOf(t2.id)).toBe(manual.lead.id);
    expect(await decision(t2.id)).toBeUndefined();
  });

  it("a retry that becomes a skip keeps its attempt count, and a failure after the contact is archived still ends terminally", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    await injectFailure(f.t, "CREATED");
    await f.run();
    await makeDue(f.t, touch.id);
    await f.run();
    expect(await decision(touch.id)).toMatchObject({ decision: "RETRY", attempts: 2 });
    await f.q("update contacts set archived_at = now() where id = $1", [contact.id]);
    await makeDue(f.t, touch.id);
    expect((await f.run()).skipped.archived).toBe(1);
    expect(await decision(touch.id)).toMatchObject({
      decision: "SKIPPED_ARCHIVED",
      attempts: 2,
      seconds: null,
    });
    expect(await f.run()).toMatchObject({ processed: 0 });
  });

  it("the retry step function is the policy: 1 min, 5 min, 30 min, 2 h, then PARKED, whatever the starting point", async () => {
    const { stepAfterFailure } = await import("./policy");
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => stepAfterFailure(n))).toEqual([
      { decision: "RETRY", attempts: 1, delaySeconds: 60 },
      { decision: "RETRY", attempts: 2, delaySeconds: 300 },
      { decision: "RETRY", attempts: 3, delaySeconds: 1_800 },
      { decision: "RETRY", attempts: 4, delaySeconds: 7_200 },
      { decision: "PARKED", attempts: 5 },
      { decision: "PARKED", attempts: 5 },
      { decision: "PARKED", attempts: 5 },
    ]);
  });

  // ------------------------------------------------------------------------------------ rollback and crash
  it("a failure part way rolls EVERYTHING back: no lead, no link, no history, and a RETRY row that survives with its attempts", async () => {
    // the failure comes at the very last write of the transaction: the lead, its CREATED row, the link and the RETRY removal already happened
    const touch = await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(5) });
    await injectFailure(f.t, "CREATED");
    await f.run(); // attempt 1 fails at the CREATED insert (the lead insert already ran)
    await removeFailure(f.t);
    await injectFailure(f.t, "TOUCH_LINKED");
    await makeDue(f.t, touch.id);
    expect((await f.run()).retryScheduled).toBe(1);
    expect(await count("leads")).toBe(0);
    expect(await count("lead_events")).toBe(0);
    expect(await linkOf(touch.id)).toBeNull();
    // the RETRY row was deleted INSIDE the rolled-back transaction: it is back, one attempt further
    expect(await decision(touch.id)).toMatchObject({ decision: "RETRY", attempts: 2 });
    await removeFailure(f.t);
    await makeDue(f.t, touch.id);
    expect((await f.run()).created).toBe(1);
    expect(await count("leads")).toBe(1);
    expect(await count("lead_events")).toBe(2);
    expect(await decision(touch.id)).toBeUndefined();
  });

  it("a crash mid-transaction (the connection is killed while the run holds its locks and has written) leaves nothing behind and the touch is tried again", async () => {
    const touch = await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(5) });
    // the run's own pool, so that killing its connection cannot disturb the test harness
    const own = createWorkerDatabase(f.t.url, {
      maxConnections: 2,
      applicationName: "reconcile-crash-test",
      onPoolError: () => undefined,
    });
    // the barrier holds the run INSIDE its transaction, after it inserted the lead and with every lock held
    await installBarrier(f.t);
    const barrier = await holdBarrier(f.t);
    let killedAt = "";
    try {
      const running = runReconciliation(own.db, { ...DEFAULT_OPTIONS });
      await waitUntilBlocked(f.t, 1);
      const killed = await f.q<{ n: number }>(
        "select count(pg_terminate_backend(pid))::int n from pg_stat_activity where application_name = 'reconcile-crash-test' and wait_event_type = 'Lock'",
      );
      expect(killed[0]!.n).toBe(1);
      // CLASS C (a lost connection): the attempt's transaction, and the lock it held, are gone; the failure is recorded afterwards
      // by the command's fallback, with the anchor the attempt had read from the database clock: EARLIER than the kill
      killedAt = (await f.one<{ t: string }>("select clock_timestamp()::text as t")).t;
      const report = await running;
      // the failure was recorded afterwards on a fresh connection, as the first step of the retry policy
      expect(report.retryScheduled).toBe(1);
      expect(Object.keys(report.errors)).toHaveLength(1);
    } finally {
      await barrier.release();
      await removeBarrier(f.t);
      await own.close();
    }
    expect(await count("leads")).toBe(0);
    expect(await count("lead_events")).toBe(0);
    expect(await linkOf(touch.id)).toBeNull();
    expect(await decision(touch.id)).toMatchObject({ decision: "RETRY", attempts: 1 });
    expect(
      (
        await f.one<{ earlier: boolean }>(
          "select created_at < $1::timestamptz as earlier from lead_reconcile_decisions where attribution_id = $2",
          [killedAt, touch.id],
        )
      ).earlier,
    ).toBe(true);
    await makeDue(f.t, touch.id);
    expect((await f.run()).created).toBe(1);
  });
  it("failure recording never invents state: a linked touch or a terminal decision is left alone, and a contact that stays busy is not charged", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const c = {
      organizationId: f.w.org.id,
      attributionId: touch.id,
      contactId: contact.id,
      receivedKey: "",
    };
    const quick = { ...DEFAULT_OPTIONS, lockTimeoutMs: 300 };
    // busy: the contact's lock is held, and the (bounded) wait for it times out
    const holder = await f.t.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        contactLockKey(f.w.org.id, contact.id),
      ]);
      const started = Date.now();
      expect(await recordFailure(f.t.db, c, "pg_p0001", quick)).toEqual({ kind: "busy" });
      expect(Date.now() - started).toBeLessThan(3_000);
      await holder.query("commit");
    } finally {
      holder.release();
    }
    expect(await decision(touch.id)).toBeUndefined();
    // linked: nothing is recorded for a linked touch
    await f.run();
    expect(await recordFailure(f.t.db, c, "pg_p0001", quick)).toEqual({ kind: "gone" });
    expect(await decision(touch.id)).toBeUndefined();
    // terminal: left alone
    const stale = await addTouch(f.t.db, f.w, (await addContact(f.t.db, f.w.org.id)).id, {
      receivedAt: daysAgo(30),
    });
    await f.run();
    const d = (
      await f.one<{ contact_id: string }>(
        "select contact_id from lead_attributions where id = $1",
        [stale.id],
      )
    ).contact_id;
    expect(
      await recordFailure(
        f.t.db,
        { ...c, attributionId: stale.id, contactId: d },
        "pg_p0001",
        quick,
      ),
    ).toEqual({ kind: "gone" });
    expect(await decision(stale.id)).toMatchObject({ decision: "SKIPPED_STALE", attempts: 0 });
  });
  // ------------------------------------------------------------------- starvation and bounded work
  it("old, poisoned and busy candidates cannot starve newer work: they are left out of the scan or passed over, and a run still reaches fresh touches", async () => {
    const mk = async (received: Date) => {
      const contact = await addContact(f.t.db, f.w.org.id);
      return { contact, touch: await addTouch(f.t.db, f.w, contact.id, { receivedAt: received }) };
    };
    // 20 terminal (skipped), 5 parked, 8 waiting for their retry time: the oldest, so they would fill every early page
    for (let i = 0; i < 20; i++) {
      const { contact, touch } = await mk(daysAgo(5, new Date(Date.now() + i * 1000)));
      await f.q(
        "insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision) values ($1,$2,$3,'SKIPPED_STALE')",
        [f.w.org.id, touch.id, contact.id],
      );
    }
    for (let i = 0; i < 5; i++) {
      const { contact, touch } = await mk(daysAgo(4, new Date(Date.now() + i * 1000)));
      await f.q(
        "insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts, last_error_code) values ($1,$2,$3,'PARKED',5,'pg_p0001')",
        [f.w.org.id, touch.id, contact.id],
      );
    }
    for (let i = 0; i < 8; i++) {
      const { contact, touch } = await mk(daysAgo(3, new Date(Date.now() + i * 1000)));
      await f.q(
        "insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts, next_attempt_at, last_error_code) values ($1,$2,$3,'RETRY',2, clock_timestamp() + interval '1 hour','pg_p0001')",
        [f.w.org.id, touch.id, contact.id],
      );
    }
    // 4 busy contacts, older than the fresh work
    const busy: Awaited<ReturnType<typeof mk>>[] = [];
    for (let i = 0; i < 4; i++) busy.push(await mk(minutesAgo(60 - i)));
    const fresh: string[] = [];
    for (let i = 0; i < 3; i++) fresh.push((await mk(minutesAgo(10 - i))).touch.id);

    const holders = [];
    try {
      for (const b of busy) {
        const h = await f.t.pool.connect();
        await h.query("begin");
        await h.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          contactLockKey(f.w.org.id, b.contact.id),
        ]);
        holders.push(h);
      }
      // a tiny page and a small batch: if decided or waiting rows or busy contacts occupied pages, the fresh touches would never be reached
      const report = await f.run({ pageSize: 2, batchSize: 3 });
      expect(report).toMatchObject({
        processed: 3,
        created: 3,
        busy: 0,
        waiting: 0,
        stopReason: "exhausted",
      });
      // only the three fresh candidates were read: not one of the 33 decided touches and not one of the 4 busy contacts
      expect(report.scanned).toBe(3);
      for (const id of fresh) expect(await linkOf(id)).not.toBeNull();
      expect(report.remaining).toMatchObject({ known: true, due: 4, retryWaiting: 8, parked: 5 });
    } finally {
      for (const h of holders) {
        await h.query("commit").catch(() => undefined);
        h.release();
      }
    }
    // the busy contacts are picked up by the next run
    expect(await f.run()).toMatchObject({
      created: 4,
      busy: 0,
      remaining: { due: 0, retryWaiting: 8 },
    });
    expect(await count("leads")).toBe(7);
  });
  it("every run makes progress through a large backlog of stale evidence, never re-reading what it decided", async () => {
    for (let i = 0; i < 12; i++)
      await addTouch(f.t.db, f.w, (await addContact(f.t.db, f.w.org.id)).id, {
        receivedAt: daysAgo(30 - i * 0.01),
      });
    const fresh = await addTouch(f.t.db, f.w, (await addContact(f.t.db, f.w.org.id)).id, {
      receivedAt: minutesAgo(1),
    });
    let totalProcessed = 0;
    for (let run = 1; run <= 4; run++) {
      const report = await f.run({ batchSize: 5, pageSize: 3 });
      expect(report.scanned).toBe(report.processed); // nothing already decided is ever scanned again
      totalProcessed += report.processed;
      if (report.stopReason === "exhausted") break;
      expect(report.processed).toBe(5);
    }
    expect(totalProcessed).toBe(13);
    expect(await linkOf(fresh.id)).not.toBeNull();
    expect(await count("lead_reconcile_decisions")).toBe(12);
  });

  it("bounded work: the batch, the scan limit and the time limit each stop a run, and the report says what is left", async () => {
    const contacts = [];
    for (let i = 0; i < 9; i++) contacts.push(await addContact(f.t.db, f.w.org.id));
    for (const [i, c] of contacts.entries())
      await addTouch(f.t.db, f.w, c.id, { receivedAt: minutesAgo(30 - i) });
    const batch = await f.run({ batchSize: 4, pageSize: 3 });
    expect(batch).toMatchObject({
      processed: 4,
      created: 4,
      stopReason: "batch_limit",
      remaining: { known: true, due: 5 },
    });

    // the time limit: a clock that stands still until a candidate has been handled, then jumps past the budget
    let t = 0;
    const timed = await runReconciliation(
      f.t.db,
      { ...DEFAULT_OPTIONS, maxRunMs: 15_000 },
      {
        now: () => t,
        afterCandidate: () => {
          t += 20_000;
        },
      },
    );
    expect(timed.stopReason).toBe("time_limit");
    expect(timed.processed).toBe(1);
    expect(timed.remaining.due).toBe(4);

    // the scan limit: rows READ, whatever becomes of them
    const limited = await f.run({ scanLimit: 3, pageSize: 2 });
    expect(limited).toMatchObject({
      scanned: 3,
      processed: 3,
      created: 3,
      stopReason: "scan_limit",
    });
    expect(limited.remaining.due).toBe(1);
    const finish = await f.run();
    expect(finish).toMatchObject({ created: 1, stopReason: "exhausted", remaining: { due: 0 } });
    expect(await count("leads")).toBe(9);
  });
  it("a contact whose lock is held is passed over at once (never waited for) and its touches stay untouched until it is free", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const other = await addContact(f.t.db, f.w.org.id);
    const first = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(30) });
    const second = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(20) });
    const unrelated = await addTouch(f.t.db, f.w, other.id, { receivedAt: minutesAgo(10) });
    const holder = await f.t.pool.connect();
    const started = Date.now();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        contactLockKey(f.w.org.id, contact.id),
      ]);
      const report = await f.run();
      expect(Date.now() - started).toBeLessThan(2_000); // it did not wait for the lock
      // the busy contact's touches are not even candidates while its lock is held: the later work behind them is reached
      expect(report).toMatchObject({ scanned: 1, created: 1, processed: 1, busy: 0 });
      expect(report.remaining.due).toBe(2);
      expect(await linkOf(first.id)).toBeNull();
      expect(await linkOf(second.id)).toBeNull();
      expect(await linkOf(unrelated.id)).not.toBeNull();
    } finally {
      await holder.query("commit");
      holder.release();
    }
    expect(await f.run()).toMatchObject({ created: 1, linked: 1 });
    const l = await f.one<{ initiating_attribution_id: string }>(
      "select initiating_attribution_id from leads where contact_id = $1",
      [contact.id],
    );
    expect(l.initiating_attribution_id).toBe(first.id);
  });
  it("a contact that turns busy during the run is passed over for the REST of the run (counted as busy, once per touch), even if it frees up in between", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const other = await addContact(f.t.db, f.w.org.id);
    const x = await addTouch(f.t.db, f.w, other.id, { receivedAt: minutesAgo(40) });
    const first = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(30) });
    const second = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(20) });
    const holder = await f.t.pool.connect();
    let calls = 0;
    const report = await runReconciliation(f.t.db, DEFAULT_OPTIONS, {
      // after the first touch is handled the contact's lock is taken by someone else; after the second (busy) it is released again
      afterCandidate: async () => {
        calls++;
        if (calls === 1) {
          await holder.query("begin");
          await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
            contactLockKey(f.w.org.id, contact.id),
          ]);
        } else if (calls === 2) {
          await holder.query("commit");
          holder.release();
        }
      },
    });
    expect(calls).toBe(2);
    // the first touch of the contact found it busy; the later one was passed over for the same reason although the lock was free
    expect(report).toMatchObject({ created: 1, busy: 2, waiting: 0, processed: 1, scanned: 3 });
    expect(await linkOf(x.id)).not.toBeNull();
    expect(await linkOf(first.id)).toBeNull();
    expect(await linkOf(second.id)).toBeNull();
    expect(await f.run()).toMatchObject({ created: 1, linked: 1 });
    const l = await f.one<{ initiating_attribution_id: string }>(
      "select initiating_attribution_id from leads where contact_id = $1",
      [contact.id],
    );
    expect(l.initiating_attribution_id).toBe(first.id);
  });
  it("the 07A guarantees still hold after the reconciler has run: no fabricated origin, no decision beside a link", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const origin = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(30) });
    await f.run();
    const leadId = (
      await f.one<{ id: string }>("select id from leads where contact_id = $1", [contact.id])
    ).id;
    // H1: a CREATED event cannot be written afterwards to grant an old touch the initiating exception
    const old = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(900) });
    await expect(
      f.q(
        "insert into lead_events (organization_id, lead_id, contact_id, kind, origin, attribution_id, revision) values ($1,$2,$3,'CREATED','AD_REFERRAL',$4,0)",
        [f.w.org.id, leadId, contact.id, old.id],
      ),
    ).rejects.toThrow(/created_uidx|names the touch recorded|duplicate key/);
    await expect(
      f.q("update lead_attributions set lead_id = $1 where id = $2", [leadId, old.id]),
    ).rejects.toThrow(/predates|TOUCH_LINKED/);
    // H2: a decision cannot be written for the linked touch
    await expect(
      f.q(
        "insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision) values ($1,$2,$3,'SKIPPED_STALE')",
        [f.w.org.id, origin.id, contact.id],
      ),
    ).rejects.toThrow(/linked touch has no reconcile decision/);
    expect(await linkOf(old.id)).toBeNull();
    // the reconciler itself then treats the old touch as before the cycle, never as an origin
    expect((await f.run()).skipped.beforeCycle).toBe(1);
    expect(
      (
        await f.one<{ initiating_attribution_id: string }>(
          "select initiating_attribution_id from leads where id = $1",
          [leadId],
        )
      ).initiating_attribution_id,
    ).toBe(origin.id);
    void seedLead;
  });
});
