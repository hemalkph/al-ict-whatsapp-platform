import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import type { DbExecutor } from "@/db/ops/executor";
import { claimNext, executeClaim } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import {
  sessionSuppressionCandidatesSql,
  type SuppressionExecutor,
} from "../bot-control/suppression";
import { barrierKit, settledState } from "../bot-control/testing";
import { listCandidates } from "./reconcile";
import { deferred, insertTrigger, runtimeKit } from "./testing";

// R3-S-C (Phase 08E-6; plan I.5.1 Scenario C, J.4) on disposable PostgreSQL 17 at READ COMMITTED: the reconciler's DEADLINE
// rule against the real dispatcher. One prompt request R of a live session S WAITING_FOR_SEND (made by real T1), no staff fence.
// The sweep's decision clock is moved past dispatch_deadline + 30 s through the decision-clock seam.
//   C1 R unlocked: the sweep holds R (bot_send_deadline) and hands S over (send_held, event bot_send_deadline). 0 calls.
//   C2 a claim holds R's row lock (parked before its time check): the sweep skips R WITHOUT WAITING and leaves S byte-identical;
//      the claim, released with an overdue clock, holds R deadline_passed; the next tick hands S over with event deadline_passed.
//   C3 explicit clock SKEW (dispatcher clock within the deadline, sweep clock beyond it): three participants, the witness cursor
//      fetched before the candidate FETCH (as R3-S-A); the sweep skips R, S byte-identical; C records ACCEPTED (1 call); the next
//      tick moves S to WAITING_FOR_INPUT with the tick's own decision clock. No premature HANDED_OVER anywhere.
// The candidate statement of the reconciler's suppression is driven through a cursor by wrapping the bot-control module in THIS
// test file only (vi.mock); the production files pass no seam (pinned by a static test). NOT EXECUTED by the author of this
// change: no isolated PostgreSQL server was configured.

const seam = vi.hoisted(() => ({
  lock: null as null | ((tx: never, org: string, sessionId: string) => Promise<string[]>),
  mutate: null as null | "handover_on_skip",
}));
vi.mock("@/modules/bot-control", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/modules/bot-control")>();
  return {
    ...orig,
    suppressSessionQueuedRequests: async (
      ...a: Parameters<typeof orig.suppressSessionQueuedRequests>
    ) => {
      const [tx, org, sessionId, code] = a;
      if (code !== orig.SEND_DEADLINE_HOLD_CODE) return orig.suppressSessionQueuedRequests(...a);
      const result = await orig.suppressSessionQueuedRequests(
        tx,
        org,
        sessionId,
        code,
        seam.lock ? { lockSessionSuppressionCandidates: seam.lock as never } : {},
      );
      if (seam.mutate !== "handover_on_skip") return result;
      // MUTATION: report every QUEUED-or-SENDING BOT request of the session as held, even when nothing was suppressed
      const all = await tx.execute<{ id: string }>(
        sql`select id from outbound_requests where bot_session_id = ${sessionId} and origin = 'BOT'`,
      );
      return { heldIds: all.rows.map((r) => r.id) };
    },
  };
});

const DEADLOCK = "40P01";
const LOCK_NOT_AVAILABLE = "55P03";

function inlined(organizationId: string, sessionId: string): string {
  const q = new PgDialect().sqlToQuery(sessionSuppressionCandidatesSql(organizationId, sessionId));
  return q.sql.replace(/\$(\d+)/g, (_, n: string) => {
    const v = q.params[Number(n) - 1];
    if (typeof v !== "string" || !/^[0-9a-f-]{36}$/.test(v))
      throw new Error("unexpected parameter");
    return `'${v}'`;
  });
}
const once = (text: string, from: string, to: string) => {
  expect(text.split(from)).toHaveLength(2);
  return text.replace(from, to);
};

describe("deadline sweep versus the dispatcher (R3-S-C)", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  let k: ReturnType<typeof runtimeKit>;
  const db = () => t.db as unknown as DbExecutor;

  beforeAll(async () => {
    t = await createTestDatabase({
      sessionTimeouts: {
        lock_timeout: 15_000,
        statement_timeout: 20_000,
        idle_in_transaction_session_timeout: 25_000,
      },
    });
  });
  beforeEach(async () => {
    await t.pool.query("truncate organizations, webhook_requests cascade");
    kit = barrierKit(t);
    k = runtimeKit(t);
    seam.lock = null;
    seam.mutate = null;
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    seam.lock = null;
    seam.mutate = null;
    k.releaseAll();
    try {
      await kit.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  });
  afterAll(async () => t.close());

  /** S WAITING_FOR_SEND with ONE QUEUED prompt R (real T1), a deferred trigger, and the overdue sweep clock. */
  async function world() {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    const deferredTrigger = await insertTrigger(t, k.ctxOf(f), { dueInMs: 60_000 });
    const deadline = new Date(request.dispatch_deadline as Date).getTime();
    // the session's own send-wait expiry is later than anything this test does
    expect(new Date(session.send_wait_expires_at as Date).getTime()).toBeGreaterThan(
      deadline + 31_000,
    );
    const overdue = k.at(new Date(deadline + 31_000));
    return { f, s: session, r: request, deferredTrigger, deadline, overdue };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const snapshot = async (x: World) => ({
    s: await k.sessionJson(x.s.id as string),
    events: await k.events(x.s.id as string),
    trigger: (
      await k.one("select to_jsonb(t) j from bot_triggers t where id = $1", [x.deferredTrigger.id])
    ).j,
    requests: (await k.botRequests(x.f)).map((r) => r.id),
  });

  it("C1: R unlocked: held bot_send_deadline, then HANDED_OVER send_held (event bot_send_deadline), suppressed; 0 calls; 0 in flight", async () => {
    const x = await world();
    expect(await k.reconcile(x.s, { readClock: x.overdue })).toMatchObject({
      kind: "applied",
      finalState: "HANDED_OVER",
    });
    expect(await k.request(x.r.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "bot_send_deadline",
    });
    const s = await k.session(x.s.id as string);
    expect(s).toMatchObject({
      state: "HANDED_OVER",
      end_reason: "system_handover",
      handover_reason: "send_held",
      awaiting_token: null,
      revision: Number(x.s.revision) + 1,
    });
    expect(s.output_suppressed_at).toBeInstanceOf(Date);
    expect((await k.events(x.s.id as string)).map((e) => [e.kind, e.code])).toEqual([
      ["HANDED_OVER", "bot_send_deadline"],
    ]);
    const transport = new FakeTransport();
    expect((await claimNext(k.dispatchDeps(transport))).claim).toBeNull();
    expect(transport.calls).toHaveLength(0);
    expect(await k.inFlight(x.s.id as string)).toBe(0);
  });

  /** A real claim parked AFTER it locked R and BEFORE its time/eligibility check (it waits for the account row). */
  async function parkedClaim(x: World, transport: FakeTransport, now: () => Date) {
    const account = await kit.hold(
      "select id from whatsapp_accounts where id = $1 for no key update",
      [x.f.w.account.id],
    );
    const b = kit.settle(claimNext(k.dispatchDeps(transport, { now })));
    const bPid = await kit.waitUntilBlocked(account.pid);
    expect(
      (
        await t.pool.query("select 1 from outbound_requests where id = $1 for share skip locked", [
          x.r.id,
        ])
      ).rows,
    ).toHaveLength(0); // R is locked by the claim
    return { account, b, bPid };
  }

  it("C2: a claim holds R: the sweep skips it without waiting, S byte-identical; the claim holds R deadline_passed; next tick hands over (deadline_passed); idempotent", async () => {
    const x = await world();
    const transport = new FakeTransport();
    const { account, b, bPid } = await parkedClaim(
      x,
      transport,
      () => new Date(x.deadline + 1_000),
    );
    const before = await snapshot(x);
    expect(await k.inFlight(x.s.id as string)).toBe(1);
    const sweep = k.reconcile(x.s, { readClock: x.overdue });
    expect(await kit.within(sweep, 5_000)).toBe(true); // never waits on the claim's row lock
    expect(await sweep).toEqual({ kind: "skipped", reason: "request_locked" });
    expect(await snapshot(x)).toEqual(before); // S, its events, the deferred trigger and the requests: unchanged
    expect(await kit.blockersOf(bPid)).toEqual([account.pid]);
    expect((await k.request(x.r.id as string)).state).toBe("QUEUED");
    await account.release();
    expect(await b).toMatchObject({ ok: true, value: { claim: null, held: 1 } });
    expect(await k.request(x.r.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "deadline_passed",
    });
    expect(transport.calls).toHaveLength(0);
    // next tick (real clock: a terminal request makes S a candidate), then a second idempotent tick
    expect((await listCandidates(db())).map((c) => c.sessionId)).toEqual([x.s.id]);
    expect(await k.reconcile(x.s)).toMatchObject({ kind: "applied", finalState: "HANDED_OVER" });
    expect(await k.session(x.s.id as string)).toMatchObject({ handover_reason: "send_held" });
    expect((await k.events(x.s.id as string)).map((e) => e.code)).toEqual(["deadline_passed"]);
    const after = await k.sessionJson(x.s.id as string);
    expect(await k.reconcile(x.s)).toEqual({ kind: "skipped", reason: "not_live" });
    expect(await k.sessionJson(x.s.id as string)).toEqual(after);
    expect((await k.botRequests(x.f)).map((r) => r.id)).toEqual([x.r.id]);
  });

  it("MUTATION (hand over on zero suppressions): the C2 byte-identical check fails — S is handed over although R was skipped", async () => {
    const x = await world();
    const { account, b } = await parkedClaim(
      x,
      new FakeTransport(),
      () => new Date(x.deadline + 1_000),
    );
    const before = await snapshot(x);
    seam.mutate = "handover_on_skip";
    expect(await k.reconcile(x.s, { readClock: x.overdue })).toMatchObject({ kind: "applied" });
    expect((await snapshot(x)).s).not.toEqual(before.s);
    expect((await k.request(x.r.id as string)).state).toBe("QUEUED"); // nothing was actually held
    seam.mutate = null;
    await account.release();
    await b;
  });

  type Variant = "production" | "legacy";

  /** C3: the explicit-skew three-participant order, witness fetched before the candidate FETCH (R3-S-A's choreography). */
  async function c3(variant: Variant, retries = 2) {
    const x = await world();
    const reached = deferred<{ pid: number; isolation: string }>();
    const goOn = deferred();
    const witnessed = deferred<Array<{ id: string; state: string }>>();
    const fetched = deferred<{ ids: string[]; aBlockers: number[]; cBlockers: number[] }>();
    let aPid = 0;
    let cPid = 0;
    seam.lock = (async (tx: SuppressionExecutor, org: string, sessionId: string) => {
      const text = inlined(org, sessionId);
      const candidates = variant === "legacy" ? once(text, " SKIP LOCKED", "") : text;
      const witness = once(
        once(text, "SELECT r.id FROM", "SELECT r.id, r.state FROM"),
        " FOR UPDATE OF r SKIP LOCKED",
        "",
      );
      const isolation = (
        await tx.execute<{ transaction_isolation: string }>(sql.raw("SHOW transaction_isolation"))
      ).rows[0]!.transaction_isolation;
      await tx.execute(sql.raw(`DECLARE c NO SCROLL CURSOR FOR ${candidates}`));
      await tx.execute(sql.raw(`DECLARE w NO SCROLL CURSOR FOR ${witness}`));
      aPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`)).rows[0]!.pid;
      reached.resolve({ pid: aPid, isolation });
      await goOn.promise;
      const w = (
        await tx.execute<{ id: string; state: string }>(sql.raw("FETCH ALL FROM w"))
      ).rows.map((r) => ({ id: r.id, state: r.state }));
      witnessed.resolve(w);
      if (!(w.length === 1 && w[0]!.id === x.r.id && w[0]!.state === "QUEUED"))
        throw new Error("barrier_invalid");
      const ids = (await tx.execute<{ id: string }>(sql.raw("FETCH ALL FROM c"))).rows.map(
        (r) => r.id,
      );
      fetched.resolve({
        ids,
        aBlockers: await kit.blockersOf(aPid),
        cBlockers: cPid ? await kit.blockersOf(cPid) : [],
      });
      return ids;
    }) as never;

    const before = await snapshot(x);
    // A: the real reconciler with the overdue sweep clock (the deliberate skew)
    const a = kit.settle(k.reconcile(x.s, { readClock: x.overdue }));
    const { isolation } = await reached.promise;
    const p0 = await t.pool
      .query("select 1 from conversations where id = $1 for update nowait", [
        x.f.w.student.conversation.id,
      ])
      .then(
        () => "free",
        (e: { code?: string }) => e.code,
      );
    const p1 = await t.pool
      .query("select 1 from outbound_requests where id = $1 for share nowait", [x.r.id])
      .then(
        () => "free",
        (e: { code?: string }) => e.code,
      );

    // B, C: the dispatcher on its own clock, within R's deadline
    const wamid = `wamid.TEST08E6.C3.${variant}`;
    const transport = new FakeTransport().next(k.accepted(wamid));
    const attempts: Array<[number, string | null]> = [];
    const cDeps = k.dispatchDeps(transport, {
      now: () => new Date(x.deadline - 60_000),
      recordRetryLimit: retries,
      onRecordAttempt: (n, o) => void attempts.push([n, o]),
    });
    const { claim } = await claimNext(cDeps);
    const p2 = {
      state: (await k.request(x.r.id as string)).state,
      count: await k.inFlight(x.s.id as string),
    };
    const c = kit.settle(executeClaim(cDeps, claim!));
    cPid = await kit.waitUntilBlocked(aPid);
    const p3 = await kit.blockersOf(cPid);
    const p4 = await t.pool
      .query("select 1 from outbound_requests where id = $1 for share nowait", [x.r.id])
      .then(
        () => "free",
        (e: { code?: string }) => e.code,
      );
    goOn.resolve();
    const p5 = await witnessed.promise;
    let p6l: boolean | null = null;
    if (variant === "legacy") {
      p6l = false;
      const end = Date.now() + 8_000;
      while (Date.now() < end) {
        if ((await kit.blockersOf(aPid).catch(() => [] as number[])).includes(cPid)) {
          p6l = true;
          break;
        }
        if (await kit.within(a, 5)) break;
      }
    }
    const [aResult, cResult] = await Promise.all([a, c]);
    return {
      x,
      before,
      isolation,
      p0,
      p1,
      claim,
      p2,
      p3,
      p4,
      p5,
      p6l,
      aPid,
      transport,
      attempts,
      aResult,
      aState: settledState(aResult),
      cResult,
      wamid,
      fetched: variant === "production" ? await fetched.promise : null,
    };
  }

  it("C3 (explicit skew): the sweep skips R held by the acceptance record, S byte-identical; ACCEPTED with 1 call; the next tick -> WAITING_FOR_INPUT", async () => {
    const r = await c3("production");
    expect(r.isolation).toBe("read committed");
    expect([r.p0, r.p1]).toEqual([LOCK_NOT_AVAILABLE, "free"]);
    expect(r.claim?.requestId).toBe(r.x.r.id);
    expect(r.p2).toEqual({ state: "SENDING", count: 1 });
    expect(r.p3).toEqual([r.aPid]);
    expect(r.p4).toBe(LOCK_NOT_AVAILABLE);
    expect(r.p5).toEqual([{ id: r.x.r.id, state: "QUEUED" }]);
    expect(r.fetched!.ids).toEqual([]);
    expect(r.fetched!.aBlockers).toEqual([]);
    expect(r.fetched!.cBlockers).toEqual([r.aPid]);
    expect(r.aResult).toMatchObject({
      ok: true,
      value: { kind: "skipped", reason: "request_locked" },
    });
    expect(r.cResult).toMatchObject({ ok: true, value: "accepted" });
    expect(r.attempts).toEqual([[1, "ok"]]);
    expect(r.transport.calls).toHaveLength(1);
    const after = await snapshot(r.x);
    expect(after.s).toEqual(r.before.s); // no transition on a skip
    expect(after.events).toEqual([]);
    expect(await k.request(r.x.r.id as string)).toMatchObject({ state: "ACCEPTED" });
    expect(await k.inFlight(r.x.s.id as string)).toBe(0);
    // next tick, with ITS OWN decision clock
    const tick = await k.shifted(0)(db() as never);
    expect(await k.reconcile(r.x.s, { readClock: k.at(tick) })).toMatchObject({
      kind: "applied",
      finalState: "WAITING_FOR_INPUT",
    });
    const s = await k.session(r.x.s.id as string);
    expect(s.awaiting_token).toBe(r.x.s.awaiting_token);
    expect((s.expires_at as Date).getTime()).toBeGreaterThan(tick.getTime());
    expect(await k.events(r.x.s.id as string)).toEqual([]);
    const settled = await k.sessionJson(r.x.s.id as string);
    expect(await k.reconcile(r.x.s)).toEqual({ kind: "skipped", reason: "not_due" }); // idempotent second tick
    expect(await k.sessionJson(r.x.s.id as string)).toEqual(settled);
    expect((await k.botRequests(r.x.f)).map((q) => q.id)).toEqual([r.x.r.id]);
  });

  it("NEGATIVE CONTROL (C3 with the legacy waiting candidate): the cycle is observed and PostgreSQL reports 40P01 on one participant", async () => {
    const r = await c3("legacy", 0);
    expect(r.p5).toEqual([{ id: r.x.r.id, state: "QUEUED" }]);
    expect(r.p6l).toBe(true);
    expect([r.aState, ...r.attempts.map(([, s]) => s)].filter((s) => s === DEADLOCK)).toHaveLength(
      1,
    );
    expect(r.transport.calls).toHaveLength(1);
  });
});
