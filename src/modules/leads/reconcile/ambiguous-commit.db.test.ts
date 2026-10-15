import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPTIONS } from "./config";
import { recordFailure } from "./failure";
import { processCandidate, type AttemptTrace } from "./process";
import { runReconciliation } from "./run";
import {
  addContact,
  addTouch,
  faultyDatabase,
  fixture,
  injectFailure,
  makeDue,
  minutesAgo,
  removeFailure,
  type Fixture,
} from "./testing";

// Third review, M1. The acknowledgement of a COMMIT can be lost AFTER the server committed. The fallback must then treat the outcome
// as UNKNOWN, read the committed state and record a failure only when that state is still the one the attempt observed: one actual
// processing failure consumes at most one retry attempt. The acknowledgement loss is injected AFTER a real, successful COMMIT
// (testing.ts: faultyDatabase), on real transactions with every production trigger enabled.

describe("lead reconciler: an ambiguous COMMIT never consumes a second attempt", () => {
  let f: Fixture;
  let faulty: ReturnType<typeof faultyDatabase>;
  const fetchSpy = vi.fn(() => {
    throw new Error("the reconciler must never make a network request");
  });
  beforeEach(async () => {
    f = await fixture();
    faulty = faultyDatabase(f.t);
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await faulty.close();
    await f.close();
  });

  const decision = async (touchId: string) =>
    (
      await f.q<{ decision: string; attempts: number; created_at: Date; code: string | null }>(
        "select decision, attempts, created_at, last_error_code as code from lead_reconcile_decisions where attribution_id = $1",
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
  const setup = async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    return {
      touch,
      c: {
        organizationId: f.w.org.id,
        attributionId: touch.id,
        contactId: contact.id,
        receivedKey: "",
      },
    };
  };
  const run = () => runReconciliation(faulty.db, DEFAULT_OPTIONS);

  it("A. the RETRY commits, the acknowledgement is lost: exactly one attempt is consumed and nothing is written twice", async () => {
    const { touch } = await setup();
    await injectFailure(f.t, "CREATED");
    faulty.loseAckOfCommit(1);
    const report = await run();
    expect(await decision(touch.id)).toMatchObject({ decision: "RETRY", attempts: 1 });
    expect(report.processed).toBe(1);
    expect(report.failuresUncertain).toBe(1);
    expect(report.errors).toMatchObject({ pg_08006: 1 });
    expect(await count("lead_reconcile_decisions")).toBe(1);
    expect(await count("leads")).toBe(0);
    expect(await linkOf(touch.id)).toBeNull();
  });

  it("B. five actual failures, every acknowledgement but one lost: attempts 1, 2, 3, 4, then PARKED at 5 (never 2, 4, PARKED)", async () => {
    const { touch } = await setup();
    await injectFailure(f.t, "CREATED");
    const seen: Array<[string, number]> = [];
    for (let k = 1; k <= 5; k++) {
      if (k > 1) await makeDue(f.t, touch.id);
      if (k !== 3) faulty.loseAckOfCommit(1);
      const report = await run();
      expect(report.processed).toBe(1);
      const d = (await decision(touch.id))!;
      seen.push([d.decision, d.attempts]);
    }
    expect(seen).toEqual([
      ["RETRY", 1],
      ["RETRY", 2],
      ["RETRY", 3],
      ["RETRY", 4],
      ["PARKED", 5],
    ]);
    expect(await count("lead_reconcile_decisions")).toBe(1);
    // parked is final: another run does nothing
    expect(await run()).toMatchObject({ scanned: 0, processed: 0 });
    expect((await decision(touch.id))!.attempts).toBe(5);
  });

  it("C. a confirmed rollback (the COMMIT really did not happen) records exactly one failure, with the original anchor", async () => {
    const { touch } = await setup();
    await injectFailure(f.t, "CREATED");
    faulty.rollbackInsteadOfCommit(1);
    const report = await run();
    expect(report).toMatchObject({ processed: 1, retryScheduled: 1, failuresUncertain: 0 });
    expect(await decision(touch.id)).toMatchObject({ decision: "RETRY", attempts: 1 });
    // the anchor was taken before the failure was recorded
    const row = await f.one<{ later: boolean }>(
      "select updated_at > created_at as later from lead_reconcile_decisions where attribution_id = $1",
      [touch.id],
    );
    expect(row.later).toBe(true);
    // and again after a due retry: still one attempt per failure
    await makeDue(f.t, touch.id);
    faulty.rollbackInsteadOfCommit(1);
    await run();
    expect(await decision(touch.id)).toMatchObject({ decision: "RETRY", attempts: 2 });
  });

  it("D. another worker advances the touch before the fallback runs: the fallback writes nothing, no duplicate increment", async () => {
    const { touch, c } = await setup();
    await injectFailure(f.t, "CREATED");
    const trace: AttemptTrace = { firstConsideredAt: null };
    faulty.loseAckOfCommit(1);
    await expect(processCandidate(faulty.db, c, DEFAULT_OPTIONS, trace)).rejects.toBeDefined();
    expect(trace.prior).toEqual({ kind: "absent" });
    expect(await decision(touch.id)).toMatchObject({ decision: "RETRY", attempts: 1 });
    // another worker's due attempt fails too and records attempt 2
    await makeDue(f.t, touch.id);
    expect(await f.run()).toMatchObject({ processed: 1, retryScheduled: 1 });
    expect(await decision(touch.id)).toMatchObject({ attempts: 2 });
    // the first attempt's fallback now finds a state it did not observe
    expect(await recordFailure(f.t.db, c, "pg_08006", DEFAULT_OPTIONS, trace)).toEqual({
      kind: "changed",
    });
    expect(await decision(touch.id)).toMatchObject({ decision: "RETRY", attempts: 2 });
  });

  it("D2. an attempt that observed RETRY(2) and lost the acknowledgement of RETRY(3): the fallback sees 3 and writes nothing", async () => {
    const { touch, c } = await setup();
    await injectFailure(f.t, "CREATED");
    await f.run();
    await makeDue(f.t, touch.id);
    await f.run();
    expect(await decision(touch.id)).toMatchObject({ attempts: 2 });
    await makeDue(f.t, touch.id);
    const trace: AttemptTrace = { firstConsideredAt: null };
    faulty.loseAckOfCommit(1);
    await expect(processCandidate(faulty.db, c, DEFAULT_OPTIONS, trace)).rejects.toBeDefined();
    expect(trace.prior).toEqual({ kind: "retry", attempts: 2 });
    expect(await decision(touch.id)).toMatchObject({ attempts: 3 });
    expect(await recordFailure(f.t.db, c, "pg_08006", DEFAULT_OPTIONS, trace)).toEqual({
      kind: "changed",
    });
    expect(await decision(touch.id)).toMatchObject({ decision: "RETRY", attempts: 3 });
  });

  it("E. another worker links the touch before the fallback: no spurious RETRY, no decision beside the link", async () => {
    const { touch, c } = await setup();
    await injectFailure(f.t, "CREATED");
    const trace: AttemptTrace = { firstConsideredAt: null };
    faulty.loseAckOfCommit(1);
    await expect(processCandidate(faulty.db, c, DEFAULT_OPTIONS, trace)).rejects.toBeDefined();
    expect(await decision(touch.id)).toMatchObject({ attempts: 1 });
    // the fault is gone and the touch is due: another worker creates the lead and removes the waiting RETRY row
    await removeFailure(f.t);
    await makeDue(f.t, touch.id);
    expect(await f.run()).toMatchObject({ created: 1 });
    expect(await linkOf(touch.id)).not.toBeNull();
    expect(await recordFailure(f.t.db, c, "pg_08006", DEFAULT_OPTIONS, trace)).toEqual({
      kind: "gone",
    });
    expect(await decision(touch.id)).toBeUndefined();
    expect(await count("leads")).toBe(1);
  });

  it("F. a failure before any state was observed is not recorded: no blind increment (outcome unknown), the touch is simply tried again", async () => {
    const { touch, c } = await setup();
    // the connection fails at the very statement that observes the state (after the anchor was read)
    faulty.failBefore(/AS linked/, 1);
    const report = await run();
    expect(report).toMatchObject({ processed: 1, failuresUncertain: 1, retryScheduled: 0 });
    expect(await decision(touch.id)).toBeUndefined();
    // called directly with no observed state: unknown, nothing written, whatever the anchor
    expect(
      await recordFailure(f.t.db, c, "pg_08006", DEFAULT_OPTIONS, {
        firstConsideredAt: "2026-01-01 00:00:00+00",
        prior: null,
      }),
    ).toEqual({ kind: "unknown" });
    expect(await count("lead_reconcile_decisions")).toBe(0);
    // an existing RETRY is not incremented blindly either
    await injectFailure(f.t, "CREATED");
    await f.run();
    expect(await decision(touch.id)).toMatchObject({ attempts: 1 });
    expect(await recordFailure(f.t.db, c, "pg_08006", DEFAULT_OPTIONS, {})).toEqual({
      kind: "unknown",
    });
    expect(await decision(touch.id)).toMatchObject({ attempts: 1 });
    // and the next clean run still handles the touch
    await removeFailure(f.t);
    await makeDue(f.t, touch.id);
    expect(await f.run()).toMatchObject({ created: 1 });
  });

  it("G. a successful automatic creation commits and its acknowledgement is lost: no duplicate lead, no duplicate history, no RETRY", async () => {
    const { touch } = await setup();
    faulty.loseAckOfCommit(1);
    const report = await run();
    expect(report.processed).toBe(1);
    expect(report.retryScheduled).toBe(0);
    expect(await linkOf(touch.id)).not.toBeNull();
    expect(await count("leads")).toBe(1);
    expect(await count("lead_events where kind = 'CREATED'")).toBe(1);
    expect(await count("lead_events where kind = 'TOUCH_LINKED'")).toBe(1);
    expect(await count("lead_reconcile_decisions")).toBe(0);
    // the next run finds nothing to do and creates nothing
    expect(await f.run()).toMatchObject({ scanned: 0, created: 0, linked: 0 });
    expect(await count("leads")).toBe(1);
    expect(await count("lead_events")).toBe(2);
  });

  it("G2. a skip that commits (stale evidence) and loses its acknowledgement: the terminal decision stays, nothing is resurrected", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(Date.now() - 30 * 24 * 3_600_000),
    });
    faulty.loseAckOfCommit(1);
    await run();
    expect(await decision(touch.id)).toMatchObject({ decision: "SKIPPED_STALE", attempts: 0 });
    expect(await count("lead_reconcile_decisions")).toBe(1);
    expect(await count("leads")).toBe(0);
  });

  it("H. the freshness anchor of an existing RETRY is never moved by an ambiguous commit or by its fallback", async () => {
    const { touch } = await setup();
    await injectFailure(f.t, "CREATED");
    faulty.loseAckOfCommit(1);
    await run();
    const first = (await decision(touch.id))!;
    for (const attempts of [2, 3]) {
      await makeDue(f.t, touch.id);
      faulty.loseAckOfCommit(1);
      await run();
      const d = (await decision(touch.id))!;
      expect(d.attempts).toBe(attempts);
      expect(d.created_at).toEqual(first.created_at);
    }
  });
});
