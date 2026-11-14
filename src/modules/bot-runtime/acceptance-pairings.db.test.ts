import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, extraTestDb, type TestDb } from "@/db/__tests__/helpers";
import { pausingDatabase } from "@/db/__tests__/pausing-database";
import { terminalizeTrigger as terminalizeTriggerOp } from "@/db/ops/bot-trigger-queue";
import type { DbExecutor } from "@/db/ops/executor";
import { claimNext, executeClaim, type DispatchDeps } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { OUTPUT_SUPPRESSED_HOLD_CODE, suppressSessionQueuedRequests } from "../bot-control";
import { barrierKit, settledState } from "../bot-control/testing";
import { RUNTIME_POLICY } from "./policy";
import { deferred, insertTrigger, runtimeKit, triggerRow } from "./testing";

// R3-L (Phase 08E-6; plan K.2, K.6 item 3, N.2) on disposable PostgreSQL 17 at READ COMMITTED: the dispatcher's acceptance
// RECORD (advisory(message) -> request row -> message -> conversation) against the two 08E transactions that hold the
// conversation row: the reconciler and trigger terminalization. Neither waits for a request row, so the record only queues
// behind the conversation lock and then commits: no 40P01, the request ends ACCEPTED (never UNKNOWN_OUTCOME
// accepted_but_not_recorded), one transport call. MUTATION: a 1 s lock_timeout on the record's connection turns that latency into
// a false UNKNOWN_OUTCOME (why the record path must keep no short lock_timeout). The mutation uses a separate test pool; the
// dispatcher code is unchanged. NOT EXECUTED by the author of this change: no isolated PostgreSQL server was configured.

const DEADLOCK = "40P01";
type Settled = Parameters<typeof settledState>[0];

describe("acceptance recording versus reconciliation and terminalization (R3-L)", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  let k: ReturnType<typeof runtimeKit>;

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
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    k.releaseAll();
    try {
      await kit.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  });
  afterAll(async () => t.close());

  /** S WAITING_FOR_SEND, its prompt R claimed (committed SENDING) by the real dispatcher. */
  async function world() {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    const transport = new FakeTransport().next(
      k.accepted(`wamid.TEST08E6.L.${request.id as string}`),
    );
    const { claim } = await claimNext(k.dispatchDeps(transport));
    expect(claim?.requestId).toBe(request.id);
    return { f, s: session, r: request, transport, claim: claim! };
  }

  /** Runs C (executeClaim -> one call -> record) while `holder` holds the conversation; returns the observations. */
  async function recordBehind(
    x: Awaited<ReturnType<typeof world>>,
    holderPid: number,
    release: () => void,
    over: Partial<DispatchDeps> = {},
    waitFor?: (attempts: Array<[number, string | null]>) => boolean,
  ) {
    const attempts: Array<[number, string | null]> = [];
    const d = k.dispatchDeps(x.transport, {
      recordRetryLimit: 0,
      onRecordAttempt: (n, o) => void attempts.push([n, o]),
      ...over,
    });
    const c = kit.settle(executeClaim(d, x.claim));
    const cPid = await kit.waitUntilBlocked(holderPid); // the record waits for the conversation, nothing else
    const blockers = await kit.blockersOf(cPid);
    if (waitFor)
      for (let i = 0; i < 1_000 && !waitFor(attempts); i++)
        await new Promise((r) => setTimeout(r, 10));
    release();
    return { c: await c, cPid, blockers, attempts };
  }

  // ------------------------------------------------------------------- the second order (Phase 08E-9 Batch 3, V3.2 L874)
  //
  // V3.2 runs each pairing in both orders: the record paused before its first statement (the tests above: the holder already
  // holds the conversation when the record starts) and the record paused AFTER its request-row update. The owner-authorized
  // test-only pausing database parks the REAL record transaction on its own connection immediately before it transmits its
  // conversation update; at that point it holds the per-message advisory lock, R's uncommitted ACCEPTED version and the
  // message row, and no conversation lock. The holder then takes the conversation, the record is released and must queue
  // behind the holder only; neither waits for the other's rows in a cycle.

  /** The record transaction's last statement: the conversation timestamps (dispatch.ts, record of ACCEPTED). */
  const RECORD_CONVERSATION_UPDATE = /^update "conversations" set /;
  const RECORD_REQUEST_UPDATE = /^update "outbound_requests" set /;
  const probe = (text: string, id: string) =>
    t.pool.query(text, [id]).then(
      () => "free",
      (e: { code?: string }) => e.code ?? "error",
    );

  /** Starts executeClaim (one call -> record) on a pausing database and parks the record before its conversation update. */
  async function recordParkedAfterRequestUpdate(
    x: Awaited<ReturnType<typeof world>>,
    p: ReturnType<typeof pausingDatabase>,
  ) {
    const attempts: Array<[number, string | null]> = [];
    const pause = p.arm(RECORD_CONVERSATION_UPDATE);
    const c = kit.settle(
      executeClaim(
        k.dispatchDeps(x.transport, {
          db: p.db as never,
          recordRetryLimit: 0,
          onRecordAttempt: (n, o) => void attempts.push([n, o]),
        }),
        x.claim,
      ),
    );
    const at = await p.reachedBefore(pause, c);
    expect(x.transport.calls).toHaveLength(1); // the one transport call happened before the record
    // the record's own statements on that backend: R's update came first, the conversation update is the paused one
    const mine = p.statements.filter((s) => s.pid === at.pid).map((s) => s.text);
    expect(mine.findIndex((s) => RECORD_REQUEST_UPDATE.test(s))).toBeGreaterThanOrEqual(0);
    expect(mine.at(-1)).toMatch(RECORD_CONVERSATION_UPDATE);
    // what it holds: R (its uncommitted ACCEPTED version) and the per-message advisory lock; NOT the conversation
    expect((await k.one("select state from pg_stat_activity where pid = $1", [at.pid])).state).toBe(
      "idle in transaction",
    );
    expect(
      await probe(
        "select 1 from outbound_requests where id = $1 for update nowait",
        x.r.id as string,
      ),
    ).toBe("55P03");
    expect(
      await probe(
        "select 1 from conversations where id = $1 for update nowait",
        x.f.w.student.conversation.id,
      ),
    ).toBe("free");
    expect(
      Number(
        (
          await k.one(
            "select count(*)::int n from pg_locks where pid = $1 and locktype = 'advisory' and granted",
            [at.pid],
          )
        ).n,
      ),
    ).toBe(1);
    // an independent READ COMMITTED observer still sees the committed SENDING version
    expect(await k.request(x.r.id as string)).toMatchObject({ state: "SENDING" });
    return { pause, at, c, attempts };
  }

  /**
   * Second order: the record is parked first; the holder (`start`) takes the conversation and pauses; the record is released and
   * must wait for the holder alone; then the holder is released. `beforeHolderRelease` runs while the record waits.
   */
  async function secondOrder(
    x: Awaited<ReturnType<typeof world>>,
    p: ReturnType<typeof pausingDatabase>,
    start: () => { done: Promise<unknown>; reached: Promise<number>; release: () => void },
    beforeHolderRelease?: (rec: { attempts: Array<[number, string | null]> }) => Promise<void>,
  ) {
    const rec = await recordParkedAfterRequestUpdate(x, p);
    const holder = start();
    const holderPid = await holder.reached;
    expect(await kit.blockersOf(holderPid)).toEqual([]); // the record's locks did not stop it taking the conversation
    rec.pause.release();
    expect(await kit.waitUntilBlocked(holderPid)).toBe(rec.at.pid);
    expect(await kit.blockersOf(rec.at.pid)).toEqual([holderPid]); // the record waits for the holder only
    await beforeHolderRelease?.(rec);
    holder.release();
    const [h, r] = await Promise.all([holder.done, rec.c]);
    expect(rec.pause.fired).toBe(1);
    return { h, r, attempts: rec.attempts, recordPid: rec.at.pid, holderPid };
  }

  async function withShortLockTimeoutDb<T>(fn: (db: DispatchDeps["db"]) => Promise<T>): Promise<T> {
    const extra = extraTestDb(t, { lock_timeout: 1_000 });
    try {
      return await fn(extra.db as unknown as DispatchDeps["db"]);
    } finally {
      await extra.end();
    }
  }

  // ------------------------------------------------------------------------------------------------ A: reconciliation
  describe("A: acceptance record versus the reconciler", () => {
    it("the reconciler holds the conversation; the record queues behind it then commits ACCEPTED; no 40P01; 1 call; the next tick applies it", async () => {
      const x = await world();
      const p = k.pause();
      let isolation = "";
      const rec = kit.settle(
        k.reconcile(x.s, {
          hooks: {
            afterRowLocks: async (tx) => {
              isolation = (
                await tx.execute<{ transaction_isolation: string }>(
                  sql.raw("SHOW transaction_isolation"),
                )
              ).rows[0]!.transaction_isolation;
              await p.hook(tx);
            },
          },
        }),
      );
      const aPid = await p.reached;
      const r = await recordBehind(x, aPid, p.release);
      const a = await rec;
      expect(isolation).toBe("read committed");
      expect(r.blockers).toEqual([aPid]);
      expect([settledState(a), settledState(r.c)]).not.toContain(DEADLOCK);
      // the reconciler read R committed SENDING (the record was uncommitted) and changed nothing
      expect(a).toMatchObject({ ok: true, value: { kind: "skipped", reason: "not_due" } });
      expect(r.c).toMatchObject({ ok: true, value: "accepted" });
      expect(r.attempts).toEqual([[1, "ok"]]);
      expect(x.transport.calls).toHaveLength(1);
      expect(await k.request(x.r.id as string)).toMatchObject({
        state: "ACCEPTED",
        failure_code: null,
      });
      expect(await k.reconcile(x.s)).toMatchObject({
        kind: "applied",
        finalState: "WAITING_FOR_INPUT",
      });
    });

    it("the reconciler hands an overdue SENDING session over while the record waits: the record still commits ACCEPTED truthfully; 1 call", async () => {
      const x = await world();
      const p = k.pause();
      const expiry = new Date(x.s.send_wait_expires_at as Date).getTime();
      const rec = kit.settle(
        k.reconcile(x.s, {
          readClock: k.at(new Date(expiry + 1)),
          hooks: { afterRowLocks: p.hook },
        }),
      );
      const aPid = await p.reached;
      const r = await recordBehind(x, aPid, p.release);
      const a = await rec;
      expect([settledState(a), settledState(r.c)]).not.toContain(DEADLOCK);
      expect(a).toMatchObject({ ok: true, value: { action: "send_outcome_unresolved" } });
      expect(r.c).toMatchObject({ ok: true, value: "accepted" });
      expect(await k.request(x.r.id as string)).toMatchObject({ state: "ACCEPTED" });
      expect(await k.session(x.s.id as string)).toMatchObject({
        state: "HANDED_OVER",
        handover_reason: "send_outcome_unresolved",
      });
      expect(x.transport.calls).toHaveLength(1);
    });

    const reconcilerHolder = (x: Awaited<ReturnType<typeof world>>) => () => {
      const hp = k.pause();
      const done = kit.settle(k.reconcile(x.s, { hooks: { afterRowLocks: hp.hook } }));
      return { done, reached: hp.reached, release: hp.release };
    };

    it("SECOND ORDER: the record is parked after its request-row update; the reconciler takes the conversation, then reads the committed SENDING and changes nothing; the record waits for it alone and commits ACCEPTED; no 40P01; 1 call; the next tick applies it", async () => {
      const x = await world();
      const p = pausingDatabase(t);
      try {
        const res = await secondOrder(x, p, reconcilerHolder(x));
        const [h, r] = [res.h as Settled, res.r as Settled];
        expect([settledState(h), settledState(r)]).not.toContain(DEADLOCK);
        expect(h).toMatchObject({ ok: true, value: { kind: "skipped", reason: "not_due" } });
        expect(r).toMatchObject({ ok: true, value: "accepted" });
        expect(res.attempts).toEqual([[1, "ok"]]);
      } finally {
        await p.close();
      }
      expect(x.transport.calls).toHaveLength(1);
      expect(await k.request(x.r.id as string)).toMatchObject({
        state: "ACCEPTED",
        failure_code: null,
      });
      expect(
        (await k.one("select wamid from messages where id = $1", [x.r.message_id])).wamid,
      ).toBe(`wamid.TEST08E6.L.${x.r.id as string}`);
      expect(await k.reconcile(x.s)).toMatchObject({
        kind: "applied",
        finalState: "WAITING_FOR_INPUT",
      });
    });

    it("SECOND ORDER MUTATION: with a 1 s lock_timeout on the record's own connection, the wait behind the reconciler becomes a false UNKNOWN_OUTCOME accepted_but_not_recorded", async () => {
      const x = await world();
      const p = pausingDatabase(t, { lockTimeoutMs: 1_000 });
      try {
        const res = await secondOrder(x, p, reconcilerHolder(x), async (rec) => {
          for (let i = 0; i < 1_000 && rec.attempts.length === 0; i++)
            await new Promise((r) => setTimeout(r, 10));
        });
        expect(res.attempts).toEqual([[1, "55P03"]]);
        expect(res.r).toMatchObject({ ok: true, value: "unknown" });
      } finally {
        await p.close();
      }
      expect(await k.request(x.r.id as string)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "accepted_but_not_recorded",
      });
      expect(x.transport.calls).toHaveLength(1);
    });

    it("MUTATION: a 1 s lock_timeout on the record's connection turns the wait into a false UNKNOWN_OUTCOME accepted_but_not_recorded", async () => {
      const x = await world();
      const p = k.pause();
      const rec = kit.settle(k.reconcile(x.s, { hooks: { afterRowLocks: p.hook } }));
      const aPid = await p.reached;
      const r = await withShortLockTimeoutDb((db) =>
        recordBehind(x, aPid, p.release, { db }, (attempts) => attempts.length > 0),
      );
      await rec;
      expect(r.attempts).toEqual([[1, "55P03"]]);
      expect(await k.request(x.r.id as string)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "accepted_but_not_recorded",
      });
      expect(x.transport.calls).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------------------------ B: terminalization
  describe("B: acceptance record versus trigger terminalization", () => {
    async function pausedTerminalizer(x: Awaited<ReturnType<typeof world>>) {
      const trig = await insertTrigger(t, k.ctxOf(x.f), { attempts: 6 });
      const inside = deferred<{ pid: number; isolation: string }>();
      const go = deferred();
      const a = kit.settle(
        terminalizeTriggerOp(
          t.db as unknown as DbExecutor,
          {
            organizationId: x.f.w.org.id,
            id: trig.id,
            conversationId: x.f.w.student.conversation.id,
          },
          {
            maxClaims: 6,
            leaseMs: 60_000,
            lockTimeoutMs: RUNTIME_POLICY.lockTimeoutMs,
            suppressSession: async (tx, org, sid) => {
              inside.resolve({
                pid: (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`)).rows[0]!
                  .pid,
                isolation: (
                  await tx.execute<{ transaction_isolation: string }>(
                    sql.raw("SHOW transaction_isolation"),
                  )
                ).rows[0]!.transaction_isolation,
              });
              await go.promise;
              return suppressSessionQueuedRequests(tx, org, sid, OUTPUT_SUPPRESSED_HOLD_CODE);
            },
          },
        ),
      );
      const { pid, isolation } = await inside.promise;
      return { trig, a, pid, isolation, release: () => go.resolve() };
    }

    it("the terminalizer holds the conversation: the record queues behind it then commits ACCEPTED; T DEAD, S handed over; no 40P01; 1 call", async () => {
      const x = await world();
      const term = await pausedTerminalizer(x);
      const r = await recordBehind(x, term.pid, term.release);
      const a = await term.a;
      expect(term.isolation).toBe("read committed");
      expect(r.blockers).toEqual([term.pid]);
      expect([settledState(a), settledState(r.c)]).not.toContain(DEADLOCK);
      expect(a).toMatchObject({ ok: true, value: { kind: "dead", handedOverSessionId: x.s.id } });
      expect(r.c).toMatchObject({ ok: true, value: "accepted" });
      expect(r.attempts).toEqual([[1, "ok"]]);
      expect(x.transport.calls).toHaveLength(1);
      expect(await k.request(x.r.id as string)).toMatchObject({
        state: "ACCEPTED",
        failure_code: null,
      });
      expect(await triggerRow(t, term.trig.id)).toMatchObject({
        status: "DEAD",
        outcome_code: "attempts_exhausted",
      });
      expect(await k.session(x.s.id as string)).toMatchObject({
        state: "HANDED_OVER",
        handover_reason: "bot_error",
      });
      // reconciliation afterwards leaves the terminal session and the accepted request as they are
      const s0 = await k.sessionJson(x.s.id as string);
      expect(await k.reconcile(x.s)).toEqual({ kind: "skipped", reason: "not_live" });
      expect(await k.sessionJson(x.s.id as string)).toEqual(s0);
    });

    /** The terminalizer as a holder that has not started yet (second order): it pauses inside its suppression step. */
    const terminalizerHolder = (x: Awaited<ReturnType<typeof world>>, triggerId: string) => () => {
      const reached = deferred<number>();
      const go = deferred();
      const done = kit.settle(
        terminalizeTriggerOp(
          t.db as unknown as DbExecutor,
          {
            organizationId: x.f.w.org.id,
            id: triggerId,
            conversationId: x.f.w.student.conversation.id,
          },
          {
            maxClaims: 6,
            leaseMs: 60_000,
            lockTimeoutMs: RUNTIME_POLICY.lockTimeoutMs,
            suppressSession: async (tx, org, sid) => {
              reached.resolve(
                (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`)).rows[0]!.pid,
              );
              await go.promise;
              return suppressSessionQueuedRequests(tx, org, sid, OUTPUT_SUPPRESSED_HOLD_CODE);
            },
          },
        ),
      );
      return { done, reached: reached.promise, release: () => go.resolve() };
    };

    it("SECOND ORDER: the record is parked after its request-row update; the terminalizer takes the conversation and the session; the record waits for it alone and commits ACCEPTED; T DEAD, S handed over bot_error; no 40P01; 1 call", async () => {
      const x = await world();
      const trig = await insertTrigger(t, k.ctxOf(x.f), { attempts: 6 });
      const p = pausingDatabase(t);
      try {
        const res = await secondOrder(x, p, terminalizerHolder(x, trig.id));
        const [h, r] = [res.h as Settled, res.r as Settled];
        expect([settledState(h), settledState(r)]).not.toContain(DEADLOCK);
        expect(h).toMatchObject({ ok: true, value: { kind: "dead", handedOverSessionId: x.s.id } });
        expect(r).toMatchObject({ ok: true, value: "accepted" });
        expect(res.attempts).toEqual([[1, "ok"]]);
      } finally {
        await p.close();
      }
      expect(x.transport.calls).toHaveLength(1);
      expect(await k.request(x.r.id as string)).toMatchObject({
        state: "ACCEPTED",
        failure_code: null,
      });
      expect(
        (await k.one("select wamid from messages where id = $1", [x.r.message_id])).wamid,
      ).toBe(`wamid.TEST08E6.L.${x.r.id as string}`);
      expect(await triggerRow(t, trig.id)).toMatchObject({
        status: "DEAD",
        outcome_code: "attempts_exhausted",
      });
      expect(await k.session(x.s.id as string)).toMatchObject({
        state: "HANDED_OVER",
        handover_reason: "bot_error",
      });
      const s0 = await k.sessionJson(x.s.id as string);
      expect(await k.reconcile(x.s)).toEqual({ kind: "skipped", reason: "not_live" });
      expect(await k.sessionJson(x.s.id as string)).toEqual(s0);
    });

    it("SECOND ORDER MUTATION: with a 1 s lock_timeout on the record's own connection, the wait behind the terminalizer becomes a false UNKNOWN_OUTCOME", async () => {
      const x = await world();
      const trig = await insertTrigger(t, k.ctxOf(x.f), { attempts: 6 });
      const p = pausingDatabase(t, { lockTimeoutMs: 1_000 });
      try {
        const res = await secondOrder(x, p, terminalizerHolder(x, trig.id), async (rec) => {
          for (let i = 0; i < 1_000 && rec.attempts.length === 0; i++)
            await new Promise((r) => setTimeout(r, 10));
        });
        expect(res.attempts).toEqual([[1, "55P03"]]);
      } finally {
        await p.close();
      }
      expect(await k.request(x.r.id as string)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "accepted_but_not_recorded",
      });
    });

    it("MUTATION: with a 1 s lock_timeout on the record's connection the same order yields a false UNKNOWN_OUTCOME", async () => {
      const x = await world();
      const term = await pausedTerminalizer(x);
      const r = await withShortLockTimeoutDb((db) =>
        recordBehind(x, term.pid, term.release, { db }, (attempts) => attempts.length > 0),
      );
      await term.a;
      expect(r.attempts).toEqual([[1, "55P03"]]);
      expect(await k.request(x.r.id as string)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "accepted_but_not_recorded",
      });
    });
  });
});
