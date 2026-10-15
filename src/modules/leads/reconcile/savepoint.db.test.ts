import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changeLeadStatus, createManualLead } from "../index";
import { contactLockKey } from "../locks";
import { DEFAULT_OPTIONS } from "./config";
import { processCandidate } from "./process";
import {
  DAY,
  addContact,
  addTouch,
  contactLockHolder,
  fixture,
  holdBarrier,
  holdRecordBarrier,
  injectFailure,
  injectSlowFailure,
  installBarrier,
  installRecordBarrier,
  makeDue,
  minutesAgo,
  removeBarrier,
  removeFailure,
  removeRecordBarrier,
  waitUntilBlocked,
  waitersOnContact,
  waitUntilWaitingOnBarrier,
  type Fixture,
} from "./testing";

// Second review, C-M2. A recoverable failure is rolled back to a SAVEPOINT inside the attempt's own transaction and recorded there,
// with the contact's advisory lock and the organization lock (both taken BEFORE the savepoint) held without a gap from the
// first-consideration instant to COMMIT. A concurrent reconciler can therefore never judge the touch in between. Real PostgreSQL,
// separate connections, deterministic barriers (a trigger waiting for an advisory lock the test holds): no sleep orders anything.

describe("lead reconciler: a failure is recorded under the contact lock the attempt already holds", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => f.close());

  const decision = async (touchId: string) =>
    (
      await f.q<{
        decision: string;
        attempts: number;
        created_at: Date;
        updated_at: Date;
        last_error_code: string | null;
      }>(
        "select decision, attempts, created_at, updated_at, last_error_code from lead_reconcile_decisions where attribution_id = $1",
        [touchId],
      )
    )[0];
  const count = async (sql: string) =>
    (await f.one<{ n: number }>(`select count(*)::int n from ${sql}`)).n;
  const linkOf = async (id: string) =>
    (
      await f.one<{ lead_id: string | null }>(
        "select lead_id from lead_attributions where id = $1",
        [id],
      )
    ).lead_id;
  const cand = (touchId: string, contactId: string) => ({
    organizationId: f.w.org.id,
    attributionId: touchId,
    contactId,
    receivedKey: "",
  });
  const settle = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

  it("THE REPRODUCED RACE: A fails after crossing the freshness boundary; B cannot judge the touch between the rollback and the recording; the original anchor is recorded and B finds a RETRY, not SKIPPED_STALE", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    // fresh by 3 s when A begins; A's failing statement works for 4 s, so the boundary is crossed before the failure is recorded
    const evidence = new Date(Date.now() - 14 * DAY + 3_000);
    const touch = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: evidence,
      occurredAt: evidence,
    });
    const c = cand(touch.id, contact.id);
    const key = contactLockKey(f.w.org.id, contact.id);
    await installBarrier(f.t); // inside the work (all its locks held, its first writes made)
    await injectSlowFailure(f.t, 4); // then: 4 s of work, then a recoverable failure
    await installRecordBarrier(f.t); // inside the recording of the failure, after the rollback to the savepoint
    const work = await holdBarrier(f.t);
    const record = await holdRecordBarrier(f.t);
    try {
      const a = settle(processCandidate(f.t.db, c, DEFAULT_OPTIONS));
      await waitUntilWaitingOnBarrier(f.t, 1);
      // A is inside its work: it holds the contact. Remember WHICH transaction holds it.
      const during = await contactLockHolder(f.t, key);
      expect(during).not.toBeNull();
      // B (a second reconciler, its own connection) cannot take the contact
      expect(await processCandidate(f.t.db, c, DEFAULT_OPTIONS)).toEqual({ kind: "busy" });

      // a THIRD session queues for the contact's lock now, while A holds it (it is what B or a manual writer would do)
      const contender = await f.t.pool.connect();
      await contender.query("begin");
      const queued = contender.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        key,
      ]);
      while ((await waitersOnContact(f.t, key)) < 1) await new Promise((r) => setTimeout(r, 10));

      await work.release(); // A goes on: 4 s of work inside the database, then the failure, the rollback, the recording
      await waitUntilWaitingOnBarrier(f.t, 2);
      // the rollback to the savepoint did NOT release the contact: the queued session has not been granted it
      expect(await waitersOnContact(f.t, key)).toBe(1);
      // A is now RECORDING the failure, after its work was rolled back: it still holds the contact, in the SAME transaction
      const recording = await contactLockHolder(f.t, key);
      expect(recording).toEqual(during); // same backend, same transaction start: no gap, no second transaction
      // the freshness boundary really was crossed meanwhile: judged now, the touch IS stale
      expect(
        (
          await f.one<{ stale: boolean }>(
            "select $1::timestamptz < clock_timestamp() - interval '14 days' as stale",
            [evidence],
          )
        ).stale,
      ).toBe(true);
      // and B, trying again NOW, still cannot take the contact: it cannot commit SKIPPED_STALE in the gap
      expect(await processCandidate(f.t.db, c, DEFAULT_OPTIONS)).toEqual({ kind: "busy" });
      expect(await decision(touch.id)).toBeUndefined();
      expect(await count("leads")).toBe(0);

      await record.release();
      const outcome = await a;
      // only now, with A's transaction committed, does the queued session get the contact
      await queued;
      expect(await waitersOnContact(f.t, key)).toBe(0);
      await contender.query("commit");
      contender.release();
      expect(outcome).toMatchObject({
        ok: true,
        value: { kind: "failed", code: "pg_p0001", recorded: { kind: "retry", attempts: 1 } },
      });
    } finally {
      await work.release().catch(() => undefined);
      await record.release().catch(() => undefined);
    }
    // the contact is free again
    expect(await contactLockHolder(f.t, key)).toBeNull();
    // A's original anchor was recorded (fresh at its first consideration), and B observes the RETRY (not due), never SKIPPED_STALE
    const d = (await decision(touch.id))!;
    expect(d).toMatchObject({ decision: "RETRY", attempts: 1, last_error_code: "pg_p0001" });
    expect(
      (
        await f.one<{ fresh: boolean }>(
          "select $1::timestamptz >= $2::timestamptz - interval '14 days' as fresh",
          [evidence, d.created_at],
        )
      ).fresh,
    ).toBe(true);
    expect(await processCandidate(f.t.db, c, DEFAULT_OPTIONS)).toEqual({ kind: "gone" });
    expect((await decision(touch.id))!.decision).toBe("RETRY");
    // nothing of the rolled-back work remains
    expect(await count("leads")).toBe(0);
    expect(await count("lead_events")).toBe(0);
    expect(await linkOf(touch.id)).toBeNull();
    // and the retry, when due and healthy, finds the touch eligible by its ORIGINAL anchor
    await removeBarrier(f.t);
    await removeRecordBarrier(f.t);
    await removeFailure(f.t);
    await makeDue(f.t, touch.id);
    expect(await f.run({ freshnessDays: 14 })).toMatchObject({ created: 1, skipped: { stale: 0 } });
    expect(await linkOf(touch.id)).not.toBeNull();
    expect(await decision(touch.id)).toBeUndefined();
  });

  it("two reconcilers at the same moment on a failing touch: one attempt fails and records, the other is busy; one decision row, attempts 1", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const c = cand(touch.id, contact.id);
    await installBarrier(f.t);
    await injectFailure(f.t, "CREATED");
    const work = await holdBarrier(f.t);
    try {
      const a = settle(processCandidate(f.t.db, c, DEFAULT_OPTIONS));
      await waitUntilWaitingOnBarrier(f.t, 1);
      const b = await processCandidate(f.t.db, c, DEFAULT_OPTIONS);
      await work.release();
      expect(b).toEqual({ kind: "busy" });
      expect(await a).toMatchObject({ ok: true, value: { kind: "failed" } });
    } finally {
      await work.release().catch(() => undefined);
    }
    expect(await count("lead_reconcile_decisions")).toBe(1);
    expect(await decision(touch.id)).toMatchObject({ decision: "RETRY", attempts: 1 });
  });

  it("an earlier freshness anchor is never overwritten: a second failure of the same touch only advances the attempt", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const c = cand(touch.id, contact.id);
    await injectFailure(f.t, "CREATED");
    expect(await processCandidate(f.t.db, c, DEFAULT_OPTIONS)).toMatchObject({
      kind: "failed",
      recorded: { kind: "retry", attempts: 1 },
    });
    const first = (await decision(touch.id))!;
    await makeDue(f.t, touch.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await processCandidate(f.t.db, c, DEFAULT_OPTIONS)).toMatchObject({
      kind: "failed",
      recorded: { kind: "retry", attempts: 2 },
    });
    const second = (await decision(touch.id))!;
    expect(second.created_at).toEqual(first.created_at);
    expect(second.updated_at.getTime()).toBeGreaterThan(first.updated_at.getTime());
  });

  it("first failure is attempt 1, repeated failures increment, the fifth is PARKED; no second decision row and no linked touch with a decision", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const c = cand(touch.id, contact.id);
    await injectFailure(f.t, "CREATED");
    const seen: string[] = [];
    for (let i = 1; i <= 5; i++) {
      if (i > 1) await makeDue(f.t, touch.id);
      const outcome = await processCandidate(f.t.db, c, DEFAULT_OPTIONS);
      expect(outcome.kind).toBe("failed");
      const d = (await decision(touch.id))!;
      seen.push(`${d.decision}:${d.attempts}`);
    }
    expect(seen).toEqual(["RETRY:1", "RETRY:2", "RETRY:3", "RETRY:4", "PARKED:5"]);
    expect(await count("lead_reconcile_decisions")).toBe(1);
    expect(await linkOf(touch.id)).toBeNull();
    // a parked touch is not a candidate any more: a further attempt finds nothing to do
    expect(await processCandidate(f.t.db, c, DEFAULT_OPTIONS)).toEqual({ kind: "gone" });
  });

  it("a DEFERRED constraint failure (it would fire at COMMIT) is raised inside the savepoint and recorded like any other failure", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    await f.q(`
      create or replace function test_deferred_failure() returns trigger language plpgsql as $$
      begin raise exception 'deferred failure' using errcode = 'P0001'; end $$;
      create constraint trigger test_deferred_failure_trg after insert on lead_events
        deferrable initially deferred for each row when (new.kind = 'CREATED')
        execute function test_deferred_failure();`);
    const outcome = await processCandidate(f.t.db, cand(touch.id, contact.id), DEFAULT_OPTIONS);
    // detected by the attempt (inside its savepoint), not by a failed COMMIT: it came back as a recorded failure, not as an exception
    expect(outcome).toMatchObject({
      kind: "failed",
      code: "pg_p0001",
      recorded: { kind: "retry", attempts: 1 },
    });
    expect(await count("leads")).toBe(0);
    expect(await count("lead_events")).toBe(0);
    expect(await linkOf(touch.id)).toBeNull();
    expect(await decision(touch.id)).toMatchObject({ decision: "RETRY", attempts: 1 });
  });

  it("no contact lock is left behind by success, failure, a skip or busy", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const ok = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const key = contactLockKey(f.w.org.id, contact.id);
    await injectFailure(f.t, "CREATED");
    expect((await processCandidate(f.t.db, cand(ok.id, contact.id), DEFAULT_OPTIONS)).kind).toBe(
      "failed",
    );
    expect(await contactLockHolder(f.t, key)).toBeNull();
    await removeFailure(f.t);
    await makeDue(f.t, ok.id);
    expect((await processCandidate(f.t.db, cand(ok.id, contact.id), DEFAULT_OPTIONS)).kind).toBe(
      "created",
    );
    expect(await contactLockHolder(f.t, key)).toBeNull();
    const stale = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(Date.now() - 30 * DAY),
    });
    expect((await processCandidate(f.t.db, cand(stale.id, contact.id), DEFAULT_OPTIONS)).kind).toBe(
      "skipped",
    );
    expect(await contactLockHolder(f.t, key)).toBeNull();
  });

  it("manual lead creation and closure racing a failing reconciler: no deadlock, both succeed, the failure is recorded, nothing is lost", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const c = cand(touch.id, contact.id);
    await installBarrier(f.t);
    // fails only the reconciler's creation (origin AD_REFERRAL), never the manual one of the staff member
    await f.q(`
      create or replace function test_inject_failure() returns trigger language plpgsql as $$
      begin raise exception 'injected failure' using errcode = 'P0001'; end $$;
      create trigger test_inject_failure_trg before insert on lead_events
        for each row when (new.kind = 'CREATED' and new.origin = 'AD_REFERRAL') execute function test_inject_failure();`);
    const work = await holdBarrier(f.t);
    let manual: Awaited<ReturnType<typeof createManualLead>>;
    try {
      const a = settle(processCandidate(f.t.db, c, DEFAULT_OPTIONS));
      await waitUntilWaitingOnBarrier(f.t, 1);
      // staff creates a lead for the same contact: it waits for the contact lock the reconciler holds
      const creating = settle(
        createManualLead(f.w.staff.ctx, { contactId: contact.id }, { db: f.t.db }),
      );
      await waitUntilBlocked(f.t, 2);
      await work.release();
      const [ra, rc] = await Promise.all([a, creating]);
      expect(ra).toMatchObject({ ok: true, value: { kind: "failed" } });
      expect(rc.ok, JSON.stringify(rc)).toBe(true);
      manual = (rc as { ok: true; value: Awaited<ReturnType<typeof createManualLead>> }).value;
    } finally {
      await work.release().catch(() => undefined);
    }
    expect(await decision(touch.id)).toMatchObject({ decision: "RETRY", attempts: 1 });
    expect(await count("leads")).toBe(1);

    // closure racing a failing attempt: a touch received after the lead's cycle began would link to the open lead, so make that fail
    await removeFailure(f.t);
    await injectFailure(f.t, "TOUCH_LINKED");
    const later = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(Date.now() + 30_000),
    });
    const c2 = cand(later.id, contact.id);
    const work2 = await holdBarrier(f.t);
    try {
      const a = settle(processCandidate(f.t.db, c2, DEFAULT_OPTIONS));
      await waitUntilWaitingOnBarrier(f.t, 1);
      const closing = settle(
        changeLeadStatus(
          f.w.staff.ctx,
          manual.lead.id,
          { to: "NOT_INTERESTED", expectedRevision: 0 },
          { db: f.t.db },
        ),
      );
      await waitUntilBlocked(f.t, 2);
      await work2.release();
      const [ra, rc] = await Promise.all([a, closing]);
      expect(ra).toMatchObject({ ok: true, value: { kind: "failed" } });
      expect(rc.ok, JSON.stringify(rc)).toBe(true);
    } finally {
      await work2.release().catch(() => undefined);
    }
    expect(await decision(later.id)).toMatchObject({ decision: "RETRY", attempts: 1 });
    expect(await linkOf(later.id)).toBeNull();
  });
});
