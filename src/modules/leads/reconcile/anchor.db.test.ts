import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManualLead } from "../index";
import { DEFAULT_OPTIONS } from "./config";
import { recordFailure } from "./failure";
import { processCandidate, type AttemptTrace } from "./process";
import {
  DAY,
  addContact,
  addTouch,
  fixture,
  injectFailure,
  injectSlowFailure,
  makeDue,
  minutesAgo,
  removeFailure,
  type Fixture,
} from "./testing";

// Review C-M2. A touch that is fresh when its first attempt begins must stay eligible through valid retries, even if the attempt
// FAILS after the freshness boundary has been crossed and the failure is written later. The anchor of freshness is the instant (from
// the DATABASE clock) at which the first attempt began; it is stored as the created_at of the RETRY row and never moved by a later
// attempt. Real PostgreSQL, real rollbacks.

describe("lead reconciler: the first-consideration time survives failures", () => {
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
        age_ms: number;
      }>(
        `select decision, attempts, created_at, updated_at, (extract(epoch from (updated_at - created_at)) * 1000)::float as age_ms
         from lead_reconcile_decisions where attribution_id = $1`,
        [touchId],
      )
    )[0];
  const linkOf = async (id: string) =>
    (
      await f.one<{ lead_id: string | null }>(
        "select lead_id from lead_attributions where id = $1",
        [id],
      )
    ).lead_id;
  const count = async (sql: string) =>
    (await f.one<{ n: number }>(`select count(*)::int n from ${sql}`)).n;
  const candidateOf = (touchId: string, contactId: string) => ({
    organizationId: f.w.org.id,
    attributionId: touchId,
    contactId,
    receivedKey: "",
  });

  it("A-E. fresh at the first attempt, the attempt FAILS after crossing the boundary, the failure is recorded later, the retry still finds the touch fresh and succeeds", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    // 1.5 s inside the 14-day window when the attempt begins; the attempt then works for 3 s before it fails: the boundary is crossed
    const evidence = new Date(Date.now() - 14 * DAY + 1_500);
    const touch = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: evidence,
      occurredAt: evidence,
    });
    await injectSlowFailure(f.t, 3);
    const report = await f.run({ freshnessDays: 14 });
    expect(report).toMatchObject({ retryScheduled: 1, created: 0, skipped: { stale: 0 } });
    // C: recorded, with the ANCHOR of the attempt's start, not of the moment the failure was written (>= 3 s later)
    const d = (await decision(touch.id))!;
    expect(d).toMatchObject({ decision: "RETRY", attempts: 1 });
    expect(d.age_ms).toBeGreaterThan(2_500);
    // without the anchor the retry below would see the touch as older than 14 days: prove the boundary really was crossed
    expect(
      (
        await f.one<{ crossed: boolean }>(
          "select $1::timestamptz < $2::timestamptz - interval '14 days' as crossed",
          [evidence, d.updated_at],
        )
      ).crossed,
    ).toBe(true);
    expect(
      (
        await f.one<{ fresh: boolean }>(
          "select $1::timestamptz >= $2::timestamptz - interval '14 days' as fresh",
          [evidence, d.created_at],
        )
      ).fresh,
    ).toBe(true);
    // D, E: the retry becomes due and the original eligibility survives
    await removeFailure(f.t);
    await makeDue(f.t, touch.id);
    const retry = await f.run({ freshnessDays: 14 });
    expect(retry).toMatchObject({ created: 1, skipped: { stale: 0 } });
    expect(await linkOf(touch.id)).not.toBeNull();
    expect(await decision(touch.id)).toBeUndefined();
  });

  it("an already-stale first attempt is skipped at once: the anchor never makes a stale touch eligible", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const evidence = new Date(Date.now() - 14 * DAY - 5_000);
    const touch = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: evidence,
      occurredAt: evidence,
    });
    await injectSlowFailure(f.t, 1);
    expect(await f.run()).toMatchObject({ skipped: { stale: 1 }, retryScheduled: 0 });
    expect((await decision(touch.id))?.decision).toBe("SKIPPED_STALE");
    expect(await count("leads")).toBe(0);
  });

  it("repeated failures never move the anchor: it stays the first attempt's start while attempts and back-off advance", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    await injectFailure(f.t, "CREATED");
    await f.run();
    const anchor = (await decision(touch.id))!.created_at;
    for (const attempts of [2, 3, 4]) {
      await makeDue(f.t, touch.id);
      await new Promise((resolve) => setTimeout(resolve, 15));
      await f.run();
      const d = (await decision(touch.id))!;
      expect(d.attempts).toBe(attempts);
      expect(d.created_at).toEqual(anchor); // not moved
      expect(d.updated_at.getTime()).toBeGreaterThan(anchor.getTime());
    }
    await makeDue(f.t, touch.id);
    await f.run();
    expect(await decision(touch.id)).toMatchObject({ decision: "PARKED", attempts: 5 });
    expect((await decision(touch.id))!.created_at).toEqual(anchor);
  });

  it("an existing RETRY keeps its ORIGINAL anchor whatever anchor a later failure brings", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const c = candidateOf(touch.id, contact.id);
    const first = (
      await f.one<{ t: string }>("select (clock_timestamp() - interval '10 minutes')::text as t")
    ).t;
    const later = (await f.one<{ t: string }>("select clock_timestamp()::text as t")).t;
    expect(
      await recordFailure(f.t.db, c, "pg_p0001", DEFAULT_OPTIONS, {
        firstConsideredAt: first,
        prior: { kind: "absent" },
      }),
    ).toEqual({
      kind: "retry",
      attempts: 1,
    });
    const original = (await decision(touch.id))!.created_at;
    expect(
      await recordFailure(f.t.db, c, "pg_p0001", DEFAULT_OPTIONS, {
        firstConsideredAt: later,
        prior: { kind: "retry", attempts: 1 },
      }),
    ).toEqual({
      kind: "retry",
      attempts: 2,
    });
    expect((await decision(touch.id))!.created_at).toEqual(original);
    expect(
      (
        await f.one<{ same: boolean }>(
          "select created_at = $1::timestamptz as same from lead_reconcile_decisions where attribution_id = $2",
          [first, touch.id],
        )
      ).same,
    ).toBe(true);
  });

  it("two failures of the same observed state recorded at the same moment: one failure, one attempt, one row, the first writer's anchor stays", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const c = candidateOf(touch.id, contact.id);
    const a1 = (
      await f.one<{ t: string }>("select (clock_timestamp() - interval '10 minutes')::text as t")
    ).t;
    const a2 = (
      await f.one<{ t: string }>("select (clock_timestamp() - interval '5 minutes')::text as t")
    ).t;
    const results = await Promise.all([
      recordFailure(f.t.db, c, "pg_p0001", DEFAULT_OPTIONS, {
        firstConsideredAt: a1,
        prior: { kind: "absent" },
      }),
      recordFailure(f.t.db, c, "pg_p0001", DEFAULT_OPTIONS, {
        firstConsideredAt: a2,
        prior: { kind: "absent" },
      }),
    ]);
    // both observed "no decision": the first records attempt 1, the second finds the state moved on and writes nothing (one
    // failure, one attempt)
    expect(results.map((r) => r.kind).sort()).toEqual(["changed", "retry"]);
    expect(await count("lead_reconcile_decisions")).toBe(1);
    const d = (await decision(touch.id))!;
    expect(d.attempts).toBe(1);
    const anchors = (
      await f.q<{ ok: boolean }>(
        "select created_at in ($1::timestamptz, $2::timestamptz) as ok from lead_reconcile_decisions",
        [a1, a2],
      )
    )[0]!;
    expect(anchors.ok).toBe(true);
  });

  it("another reconciler linking the touch before the failure is recorded: nothing is recorded, no decision beside the link", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const trace: AttemptTrace = { firstConsideredAt: null };
    // the first attempt "fails" (here: we only take its anchor), and before its failure is written another run links the touch
    expect(
      await processCandidate(f.t.db, candidateOf(touch.id, contact.id), DEFAULT_OPTIONS, trace),
    ).toEqual({ kind: "created" });
    expect(trace.firstConsideredAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(
      await recordFailure(
        f.t.db,
        candidateOf(touch.id, contact.id),
        "pg_p0001",
        DEFAULT_OPTIONS,
        trace,
      ),
    ).toEqual({ kind: "gone" });
    expect(await count("lead_reconcile_decisions")).toBe(0);
    expect(await linkOf(touch.id)).not.toBeNull();
  });

  it("a rolled-back attempt leaves only the RETRY row (with the anchor): no lead, no link, no history", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    await injectFailure(f.t, "CREATED");
    await f.run();
    expect(await count("leads")).toBe(0);
    expect(await count("lead_events")).toBe(0);
    expect(await linkOf(touch.id)).toBeNull();
    expect(await decision(touch.id)).toMatchObject({ decision: "RETRY", attempts: 1 });
  });

  it("the anchor is read from the DATABASE clock: a skewed JavaScript clock, or input of any kind, cannot move it", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    await injectFailure(f.t, "CREATED");
    const dbNow = (await f.one<{ t: Date }>("select clock_timestamp() as t")).t;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
    try {
      await f.run();
    } finally {
      vi.useRealTimers();
    }
    const d = (await decision(touch.id))!;
    expect(Math.abs(d.created_at.getTime() - dbNow.getTime())).toBeLessThan(30_000);
    expect(d.created_at.getFullYear()).toBeGreaterThan(2024);
  });

  it("freshness also holds for linking to an open lead: a touch fresh at its first attempt is linked on retry", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    await createManualLead(f.w.staff.ctx, { contactId: contact.id }, { db: f.t.db });
    const evidence = new Date(Date.now() + 1_000); // after the lead's cycle
    const touch = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: evidence,
      occurredAt: evidence,
    });
    await injectFailure(f.t, "TOUCH_LINKED");
    expect((await f.run()).retryScheduled).toBe(1);
    await removeFailure(f.t);
    await makeDue(f.t, touch.id);
    expect(await f.run()).toMatchObject({ linked: 1 });
    expect(await linkOf(touch.id)).not.toBeNull();
  });
});
