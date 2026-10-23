import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import {
  terminalizeTrigger as terminalizeTriggerOp,
  type TerminalizationCandidate,
} from "@/db/ops/bot-trigger-queue";
import type { DbExecutor } from "@/db/ops/executor";
import { claimNext, executeClaim, type DispatchDeps } from "@/modules/messaging/dispatch";
import { FakeTransport, minutesAgo } from "@/modules/messaging/testing";
import type { SendResult } from "@/modules/messaging/transport";
import {
  OUTPUT_SUPPRESSED_HOLD_CODE,
  sessionSuppressionCandidatesSql,
  suppressSessionQueuedRequests,
  type SuppressionExecutor,
} from "../bot-control/suppression";
import {
  BOTS_ON,
  barrierKit,
  dispatchWorld,
  liveSessionFor,
  queueBotStep,
  settledState,
  textMessage,
  windowStudent,
  type DispatchFixture,
  type LiveSession,
} from "../bot-control/testing";
import { deferred, insertTrigger, triggerRow } from "./testing";
import { terminalizeTrigger } from "./trigger-queue";

// R3-S-A and R3-O (Phase 08E-5; plan I.5, I.5.1, J.3) on disposable PostgreSQL 17 at READ COMMITTED.
//
// R3-S-A: ONE legal BOT request R for the session's current step (the migration 0008 partial unique indexes allow one in flight;
// no second request is manufactured as a cursor barrier). A = the REAL attempt-exhaustion terminalizer (J.3) whose session-scoped
// suppression runs its IDENTICAL candidate SQL through a cursor (the test seam); B = the real claimNext; C = the real executeClaim
// with a FakeTransport returning accepted, then the real acceptance record. There is NO committed staff fence, Stop or epoch
// change: B and C authorize legitimately against committed state while A's hand-over is still uncommitted.
//
// Chronology: A holds T, the conversation advisory try-lock, D FOR SHARE, K FOR UPDATE, S FOR UPDATE, has written DEAD and the
// hand-over, and DECLAREs the candidate cursor c and a NON-locking witness cursor W, then pauses before any FETCH. P0/P1 probe
// that A owns K and not R. B commits R SENDING (P2). C makes ONE accepted fake call, its record locks R's newest version
// (ACCEPTED, uncommitted) and blocks on A's K (P3/P4). P5: A fetches W FIRST and the test validates it saw (R, QUEUED) — an
// invalid barrier fails the test — and only then A fetches c. Production: c returns [] without waiting (P6/P7). Legacy (the one
// " SKIP LOCKED" removed): c waits on C while C waits on A, and PostgreSQL reports 40P01 (P6L), victim not assumed.
// NOT EXECUTED by the author of this change: no isolated PostgreSQL server was configured.

const T0 = new Date("2026-06-01T12:00:00Z");
const DEADLOCK = "40P01";
const LOCK_NOT_AVAILABLE = "55P03";
const WAMID = "wamid.TEST08E5.R3SA.0001";
const POLICY = { maxClaims: 6, leaseMs: 60_000, lockTimeoutMs: 15_000 };

/** The candidate statement's text with its parameters inlined (validated UUID literals only). */
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
  expect(text.split(from)).toHaveLength(2); // exactly one occurrence
  return text.replace(from, to);
};

describe("session-scoped suppression versus claim and acceptance recording (R3-S-A, R3-O)", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
  const row = async (id: string) =>
    (await q("select * from outbound_requests where id = $1", [id])).rows[0];
  const probe = async (text: string, id: string) => {
    try {
      await q(text, [id]);
      return "free";
    } catch (e) {
      return (e as { code?: string }).code ?? "error";
    }
  };
  const inFlight = async (sessionId: string) =>
    Number(
      (
        await q(
          "select count(*)::int n from outbound_requests where bot_session_id = $1 and origin = 'BOT' and state in ('QUEUED','SENDING')",
          [sessionId],
        )
      ).rows[0].n,
    );
  const accepted = (wamid: string): SendResult => ({
    kind: "accepted",
    wamid,
    providerStatus: "accepted",
    httpStatus: 200,
  });
  const dispatchDeps = (
    transport: FakeTransport,
    over: Partial<DispatchDeps> = {},
  ): DispatchDeps => ({
    db: t.db as never,
    transport,
    config: BOTS_ON,
    now: () => T0,
    random: () => 0.5,
    accountMinIntervalMs: 0,
    conversationMinIntervalMs: 0,
    ...over,
  });

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
    await q("truncate organizations, webhook_requests cascade");
    kit = barrierKit(t);
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    try {
      await kit.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  });
  afterAll(async () => t.close());

  /** S WAITING_FOR_SEND with ONE legal QUEUED request R (queueBotStep), and an exhausted trigger T in K, no live claim. */
  async function world() {
    const f = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
    const s = await liveSessionFor(t, f, await windowStudent(t, f.w, minutesAgo(30, T0)));
    const r = await queueBotStep(t, f, s, { stepSeq: 1, message: textMessage("prompt"), now: T0 });
    const trig = await insertTrigger(
      t,
      {
        organizationId: f.w.org.id,
        accountId: f.w.account.id,
        conversationId: s.student.conversation.id,
      },
      { attempts: 6, messageId: s.student.message.id },
    );
    const candidate: TerminalizationCandidate = {
      organizationId: f.w.org.id,
      id: trig.id,
      conversationId: s.student.conversation.id,
    };
    return { f, s, r, trig, candidate };
  }
  type World = Awaited<ReturnType<typeof world>>;

  async function preconditions(x: World) {
    // no committed STAFF fence, Stop or epoch change: the dispatcher's hold function says R may be sent
    expect(
      (await q("select bot_request_hold_code($1, $2) c", [x.f.w.org.id, x.r.requestId])).rows[0].c,
    ).toBeNull();
    expect(
      (await q("select count(*)::int n from outbound_requests where bot_session_id = $1", [x.s.id]))
        .rows[0].n,
    ).toBe(1);
    expect(await inFlight(x.s.id)).toBe(1);
    expect(
      (await q("show default_transaction_isolation")).rows[0].default_transaction_isolation,
    ).toBe("read committed");
  }

  type Variant = "production" | "legacy" | "late_witness";

  /** R3-S-A: runs the chronology and returns every observation. */
  async function interleave(variant: Variant, retries = 2) {
    const x = await world();
    await preconditions(x);
    const reached = deferred<{ pid: number; isolation: string }>();
    const goOn = deferred();
    const witnessed = deferred<Array<{ id: string; state: string }>>();
    const afterFetch = deferred<{ ids: string[]; aBlockers: number[]; cBlockers: number[] }>();
    let cPid = 0;
    let aPid = 0;
    let lateState: string | null = null;

    const cursorLock = async (tx: SuppressionExecutor, org: string, sessionId: string) => {
      const text = inlined(org, sessionId);
      const candidates = variant === "legacy" ? once(text, " SKIP LOCKED", "") : text;
      const witness = once(
        once(text, "SELECT r.id FROM", "SELECT r.id, r.state FROM"),
        " FOR UPDATE OF r SKIP LOCKED",
        "",
      );
      expect(witness).not.toMatch(/FOR (UPDATE|SHARE)/); // the witness takes no row lock
      const isolation = (
        await tx.execute<{ transaction_isolation: string }>(sql.raw("SHOW transaction_isolation"))
      ).rows[0]!.transaction_isolation;
      await tx.execute(sql.raw(`DECLARE c NO SCROLL CURSOR FOR ${candidates}`));
      if (variant !== "late_witness")
        await tx.execute(sql.raw(`DECLARE w NO SCROLL CURSOR FOR ${witness}`));
      aPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`)).rows[0]!.pid;
      reached.resolve({ pid: aPid, isolation });
      await goOn.promise;
      // MUTATION "late_witness": the witness is declared only now, after B committed SENDING. Its snapshot (taken at this
      // DECLARE, READ COMMITTED) no longer satisfies the candidate predicate (state = 'QUEUED'), so it returns no row and the
      // barrier must be rejected. A plain read at the same point records what that later snapshot sees for R.
      if (variant === "late_witness") {
        await tx.execute(sql.raw(`DECLARE w NO SCROLL CURSOR FOR ${witness}`));
        lateState = (
          await tx.execute<{ state: string }>(
            sql`select state from outbound_requests where id = ${x.r.requestId}`,
          )
        ).rows[0]!.state;
      }
      const w = (
        await tx.execute<{ id: string; state: string }>(sql.raw("FETCH ALL FROM w"))
      ).rows.map((r) => ({ id: r.id, state: r.state }));
      witnessed.resolve(w);
      if (!(w.length === 1 && w[0]!.id === x.r.requestId && w[0]!.state === "QUEUED"))
        throw new Error("barrier_invalid"); // never count a run whose candidate snapshot did not see (R, QUEUED)
      const ids = (await tx.execute<{ id: string }>(sql.raw("FETCH ALL FROM c"))).rows.map(
        (r) => r.id,
      );
      afterFetch.resolve({
        ids,
        aBlockers: await kit.blockersOf(aPid),
        cBlockers: cPid ? await kit.blockersOf(cPid) : [],
      });
      return ids;
    };

    // A: the real J.3 terminalizer; only the candidate statement of its session-scoped suppression goes through the cursor
    const a = kit.settle(
      terminalizeTriggerOp(t.db as unknown as DbExecutor, x.candidate, {
        ...POLICY,
        suppressSession: (tx, org, sessionId) =>
          suppressSessionQueuedRequests(tx, org, sessionId, OUTPUT_SUPPRESSED_HOLD_CODE, {
            lockSessionSuppressionCandidates: cursorLock,
          }),
      }),
    );
    const { isolation: aIsolation } = await reached.promise;

    // P0 / P1 (before B): A owns K; A has not locked R; the probes leave nothing behind
    const p0 = await probe(
      "select 1 from conversations where id = $1 for update nowait",
      x.s.student.conversation.id,
    );
    const p1 = await probe(
      "select 1 from outbound_requests where id = $1 for share nowait",
      x.r.requestId,
    );
    const p1Count = await inFlight(x.s.id);

    // B: the real claim takes exactly R and commits it SENDING
    const transport = new FakeTransport().next(accepted(WAMID));
    const attempts: Array<[number, string | null]> = [];
    const cDeps = dispatchDeps(transport, {
      recordRetryLimit: retries,
      onRecordAttempt: (attempt, outcome) => void attempts.push([attempt, outcome]),
    });
    const claimed = await claimNext(cDeps);
    const p2 = {
      state: (await row(x.r.requestId)).state,
      count: await inFlight(x.s.id),
      calls: transport.calls.length,
    };

    // C: final authorization passes, ONE fake call, the record holds R's newest version and blocks on A's K
    const c = kit.settle(executeClaim(cDeps, claimed.claim!));
    cPid = await kit.waitUntilBlocked(aPid);
    const p3 = await kit.blockersOf(cPid);
    const p4 = await probe(
      "select 1 from outbound_requests where id = $1 for share nowait",
      x.r.requestId,
    );
    const p4Observer = { state: (await row(x.r.requestId)).state, count: await inFlight(x.s.id) };

    goOn.resolve();
    const p5 = await witnessed.promise;

    // P6L (legacy): A waits on C while C waits on A, observed before the detector breaks the cycle
    let p6l: boolean | null = null;
    if (variant === "legacy") {
      p6l = false;
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const b = await kit.blockersOf(aPid).catch(() => [] as number[]);
        if (b.includes(cPid)) {
          p6l = true;
          break;
        }
        if (await kit.within(a, 5)) break;
      }
    }
    const [aResult, cResult] = await Promise.all([a, c]);
    const fetched = variant === "production" ? await afterFetch.promise : null;
    return {
      x,
      aIsolation,
      p0,
      p1,
      p1Count,
      claimed,
      p2,
      p3,
      p4,
      p4Observer,
      p5,
      p6l,
      fetched,
      lateState,
      aPid,
      cPid,
      transport,
      attempts,
      aResult,
      aState: settledState(aResult),
      cResult,
    };
  }

  describe("R3-S-A: attempt-exhaustion terminalization, one request, witnessed three-participant order", () => {
    it("PRODUCTION: the barrier is valid (P0-P5), the candidate FETCH skips R without waiting (P6/P7), T DEAD, S handed over, R ACCEPTED", async () => {
      const r = await interleave("production");
      const { x } = r;
      expect(r.aIsolation).toBe("read committed");
      expect(r.p0).toBe(LOCK_NOT_AVAILABLE); // P0: A owns K
      expect(r.p1).toBe("free"); // P1: R not locked by A
      expect(r.p1Count).toBe(1);
      expect(r.claimed.claim?.requestId).toBe(x.r.requestId); // B claimed exactly R
      expect(r.p2).toEqual({ state: "SENDING", count: 1, calls: 0 }); // P2
      expect(r.p3).toEqual([r.aPid]); // P3: C waits on A only
      expect(r.p4).toBe(LOCK_NOT_AVAILABLE); // P4: R's newest version held (by C's uncommitted ACCEPTED)
      expect(r.p4Observer).toEqual({ state: "SENDING", count: 1 }); // uncommitted ACCEPTED is still in flight to an observer
      expect(r.p5).toEqual([{ id: x.r.requestId, state: "QUEUED" }]); // P5: the witness snapshot saw (R, QUEUED)
      expect(r.fetched!.ids).toEqual([]); // P6: skipped
      expect(r.fetched!.aBlockers).toEqual([]); // P7: A waits on nothing ...
      expect(r.fetched!.cBlockers).toEqual([r.aPid]); // ... while C is still blocked by A
      expect(r.aResult.ok, String((r.aResult as { error?: unknown }).error)).toBe(true);
      expect(r.aResult).toMatchObject({ value: { kind: "dead", handedOverSessionId: x.s.id } });
      expect(r.cResult).toMatchObject({ ok: true, value: "accepted" });
      expect(r.attempts).toEqual([[1, "ok"]]);
      expect([r.aState, ...r.attempts.map(([, s]) => s)]).not.toContain(DEADLOCK);
      expect(r.transport.calls).toHaveLength(1);

      // exact final state
      expect(await triggerRow(t, x.trig.id)).toMatchObject({
        status: "DEAD",
        outcome_code: "attempts_exhausted",
        attempts: 6,
        claim_token: null,
        claimed_at: null,
      });
      const s = (await q("select * from bot_sessions where id = $1", [x.s.id])).rows[0];
      expect(s).toMatchObject({
        state: "HANDED_OVER",
        end_reason: "system_handover",
        handover_reason: "bot_error",
        awaiting: null,
        awaiting_token: null,
        terminal_notice_step_seq: null,
        revision: 2, // 1 after queueBotStep, +1 exactly once
      });
      expect(s.output_suppressed_at).toBeInstanceOf(Date);
      expect(s.ended_at).toBeInstanceOf(Date);
      expect(Number(s.handover_control_seq)).toBeGreaterThan(Number(s.started_control_seq));
      expect(
        (await q("select kind, code from bot_session_events where session_id = $1", [x.s.id])).rows,
      ).toEqual([{ kind: "HANDED_OVER", code: "bot_error" }]);
      expect(await row(x.r.requestId)).toMatchObject({ state: "ACCEPTED", hold_reason: null });
      expect(
        (await q("select wamid from messages where id = $1", [x.r.messageId])).rows[0].wamid,
      ).toBe(WAMID);
      expect(
        (
          await q("select last_outbound_at from conversations where id = $1", [
            x.s.student.conversation.id,
          ])
        ).rows[0].last_outbound_at,
      ).toEqual(T0);
      expect(
        (
          await q("select count(*)::int n from outbound_requests where bot_session_id = $1", [
            x.s.id,
          ])
        ).rows[0].n,
      ).toBe(1); // no resend, no replacement
      expect(await inFlight(x.s.id)).toBe(0); // zero after ACCEPTED committed
      expect(
        (await q("select count(*)::int n from messages where id = $1", [x.s.student.message.id]))
          .rows[0].n,
      ).toBe(1); // the student's inbound message is preserved
      // a second terminalization round changes nothing (the trigger is no longer a candidate; S stays as it is)
      const before = (await q("select to_jsonb(s) j from bot_sessions s where id = $1", [x.s.id]))
        .rows[0].j;
      expect(await terminalizeTrigger(t.db, x.candidate)).toEqual({
        kind: "skipped",
        reason: "not_candidate",
      });
      expect(
        (await q("select to_jsonb(s) j from bot_sessions s where id = $1", [x.s.id])).rows[0].j,
      ).toEqual(before);
    });

    it("NEGATIVE CONTROL (legacy candidate without SKIP LOCKED, record retries DISABLED): the same order deadlocks (40P01)", async () => {
      const r = await interleave("legacy", 0);
      expect([r.p0, r.p1, r.p4]).toEqual([LOCK_NOT_AVAILABLE, "free", LOCK_NOT_AVAILABLE]);
      expect(r.p3).toEqual([r.aPid]);
      expect(r.p5).toEqual([{ id: r.x.r.requestId, state: "QUEUED" }]); // valid barrier, captured BEFORE the waiting FETCH
      expect(r.p6l).toBe(true); // both wait edges observed
      const deadlocks = [r.aState, ...r.attempts.map(([, s]) => s)].filter((s) => s === DEADLOCK);
      expect(deadlocks).toHaveLength(1); // one victim, chosen by the detector
      expect(r.transport.calls).toHaveLength(1); // never a second call
      const finalR = await row(r.x.r.requestId);
      if (r.aState === DEADLOCK) {
        // A was the victim: terminalization rolled back entirely; C then recorded ACCEPTED truthfully
        expect(r.cResult).toMatchObject({ ok: true, value: "accepted" });
        expect(finalR.state).toBe("ACCEPTED");
        expect(await triggerRow(t, r.x.trig.id)).toMatchObject({ status: "PENDING", attempts: 6 });
        expect(
          (await q("select state from bot_sessions where id = $1", [r.x.s.id])).rows[0].state,
        ).toBe("WAITING_FOR_SEND");
      } else {
        // C was the victim: a message Meta accepted is recorded as UNKNOWN_OUTCOME (the false uncertainty the fix prevents)
        expect(r.attempts).toEqual([[1, DEADLOCK]]);
        expect(finalR).toMatchObject({
          state: "UNKNOWN_OUTCOME",
          failure_code: "accepted_but_not_recorded",
        });
      }
    });

    it("NEGATIVE CONTROL (legacy, record retries ENABLED): the cycle is still observed per attempt; retries cannot hide it", async () => {
      const r = await interleave("legacy", 2);
      expect(r.p6l).toBe(true);
      const deadlocks = [r.aState, ...r.attempts.map(([, s]) => s)].filter((s) => s === DEADLOCK);
      expect(deadlocks).toHaveLength(1);
      expect(r.transport.calls).toHaveLength(1);
      if (r.aState !== DEADLOCK) expect(r.attempts.map(([, s]) => s)).toEqual([DEADLOCK, "ok"]);
    });

    it("MUTATION (witness declared after B committed): the barrier is detected as invalid and the run is not counted", async () => {
      const r = await interleave("late_witness");
      // the barrier conditions before the witness are those of the valid run ...
      expect(r.p2).toEqual({ state: "SENDING", count: 1, calls: 0 });
      expect(r.p3).toEqual([r.aPid]);
      // ... but a witness whose snapshot follows B's commit sees R SENDING, which the candidate predicate excludes: no row
      expect(r.lateState).toBe("SENDING");
      expect(r.p5).toEqual([]);
      expect(r.aResult.ok).toBe(false);
      expect(String((r.aResult as { error?: unknown }).error)).toMatch(/barrier_invalid/);
      // A rolled back entirely; C then completed truthfully; one call
      expect(await triggerRow(t, r.x.trig.id)).toMatchObject({ status: "PENDING", attempts: 6 });
      expect(r.cResult).toMatchObject({ ok: true, value: "accepted" });
      expect(r.transport.calls).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------------------------ R3-O
  describe("R3-O: terminalization against the dispatcher in competing orders (production code only)", () => {
    const realTerminalize = (x: World) => terminalizeTrigger(t.db, x.candidate);

    it("O1: terminalization commits before any claim: the terminalizer holds R (bot_output_suppressed); nothing claimed; 0 calls", async () => {
      const x = await world();
      expect(await realTerminalize(x)).toMatchObject({ kind: "dead", handedOverSessionId: x.s.id });
      expect(await row(x.r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_output_suppressed",
      });
      const transport = new FakeTransport();
      expect(await claimNext(dispatchDeps(transport))).toEqual({ claim: null, held: 0 });
      expect(transport.calls).toHaveLength(0);
      expect(await inFlight(x.s.id)).toBe(0);
    });

    it("O2: a claim holds R before terminalization commits: R is skipped (no wait); the claim then holds it bot_output_suppressed; 0 calls", async () => {
      const x = await world();
      const account = await kit.hold("select id from whatsapp_accounts where id = $1 for update", [
        x.f.w.account.id,
      ]);
      const transport = new FakeTransport();
      const b = kit.settle(claimNext(dispatchDeps(transport)));
      const bPid = await kit.waitUntilBlocked(account.pid);
      const done = realTerminalize(x);
      expect(await kit.within(done, 5_000)).toBe(true);
      expect(await done).toMatchObject({ kind: "dead", handedOverSessionId: x.s.id });
      expect((await row(x.r.requestId)).state).toBe("QUEUED");
      expect(await kit.blockersOf(bPid)).toEqual([account.pid]);
      await account.release();
      expect(await b).toMatchObject({ ok: true, value: { claim: null, held: 1 } });
      expect(await row(x.r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_output_suppressed",
      });
      expect(transport.calls).toHaveLength(0);
    });

    it("O3: R committed SENDING, then terminalization commits before the final read: final authorization holds it; 0 calls", async () => {
      const x = await world();
      const transport = new FakeTransport();
      const { claim } = await claimNext(dispatchDeps(transport));
      expect(claim?.requestId).toBe(x.r.requestId);
      const before = await row(x.r.requestId);
      expect(await realTerminalize(x)).toMatchObject({ kind: "dead" });
      expect(await row(x.r.requestId)).toEqual(before); // SENDING untouched by the terminalizer
      expect(await executeClaim(dispatchDeps(transport), claim!)).toBe("held");
      expect(await row(x.r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_output_suppressed",
      });
      expect(transport.calls).toHaveLength(0);
      expect(await inFlight(x.s.id)).toBe(0);
    });

    it("O4: final authorization already passed (transport in flight) when terminalization commits: ACCEPTED, 1 call (the accepted limit)", async () => {
      const x = await world();
      const release = deferred();
      const transport = new FakeTransport().next(async () => {
        await release.promise;
        return accepted("wamid.TEST08E5.O4");
      });
      const { claim } = await claimNext(dispatchDeps(transport));
      const c = kit.settle(executeClaim(dispatchDeps(transport), claim!));
      for (let i = 0; i < 500 && transport.calls.length === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(transport.calls).toHaveLength(1);
      expect(await realTerminalize(x)).toMatchObject({ kind: "dead", handedOverSessionId: x.s.id });
      release.resolve();
      expect(await c).toMatchObject({ ok: true, value: "accepted" });
      expect(await row(x.r.requestId)).toMatchObject({ state: "ACCEPTED" });
      expect(transport.calls).toHaveLength(1);
      expect(
        (await q("select state from bot_sessions where id = $1", [x.s.id])).rows[0].state,
      ).toBe("HANDED_OVER");
      expect(await inFlight(x.s.id)).toBe(0);
    });
  });

  // ------------------------------------------------------------------------------------------------ primitive
  describe("the primitive itself", () => {
    async function oneRequest(f?: DispatchFixture) {
      const fx = f ?? (await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) }));
      const s: LiveSession = await liveSessionFor(
        t,
        fx,
        await windowStudent(t, fx.w, minutesAgo(30, T0)),
      );
      const r = await queueBotStep(t, fx, s, { stepSeq: 1, message: textMessage(), now: T0 });
      return { f: fx, s, r };
    }
    const suppress = (orgId: string, sessionId: string) =>
      t.db.transaction((tx) =>
        suppressSessionQueuedRequests(tx, orgId, sessionId, OUTPUT_SUPPRESSED_HOLD_CODE),
      );

    it("holds only QUEUED BOT requests of exactly that session in that organization; other sessions and states are untouched", async () => {
      const a = await oneRequest();
      const b = await oneRequest(a.f); // another session of the same deployment
      const sending = await oneRequest(a.f);
      await q(
        "update outbound_requests set state='SENDING', claimed_by='test', claimed_at=clock_timestamp(), send_started_at=clock_timestamp(), attempt_count=1 where id=$1",
        [sending.r.requestId],
      );
      const other = await oneRequest(); // another organization
      const beforeB = await row(b.r.requestId);
      const beforeSending = await row(sending.r.requestId);
      const beforeOther = await row(other.r.requestId);

      expect(await suppress(a.f.w.org.id, a.s.id)).toEqual({
        heldIds: [a.r.requestId],
      });
      expect(await row(a.r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_output_suppressed",
      });
      expect(await row(b.r.requestId)).toEqual(beforeB);
      // the SENDING row is not a candidate; another organization's id matches nothing
      expect(await suppress(a.f.w.org.id, sending.s.id)).toEqual({ heldIds: [] });
      expect(await row(sending.r.requestId)).toEqual(beforeSending);
      expect(await suppress(a.f.w.org.id, other.s.id)).toEqual({ heldIds: [] });
      expect(await row(other.r.requestId)).toEqual(beforeOther);
      // idempotent: an already held row is not touched again
      const held = await row(a.r.requestId);
      expect(await suppress(a.f.w.org.id, a.s.id)).toEqual({ heldIds: [] });
      expect(await row(a.r.requestId)).toEqual(held);
    });

    for (const how of ["claim-like FOR UPDATE", "record-like uncommitted UPDATE"] as const)
      it(`never waits on a request-row lock (${how}); the legacy text is blocked by the holder (positive control)`, async () => {
        const { f, s, r } = await oneRequest();
        const holder = await kit.hold(
          how === "claim-like FOR UPDATE"
            ? "select id from outbound_requests where id = $1 for update"
            : "update outbound_requests set provider_message_status = 'held_by_test' where id = $1",
          [r.requestId],
        );
        const production = await kit.settle(suppress(f.w.org.id, s.id));
        expect(production).toMatchObject({ ok: true, value: { heldIds: [] } });
        const legacy = kit.settle(
          t.db.transaction((tx) =>
            tx.execute(sql.raw(once(inlined(f.w.org.id, s.id), " SKIP LOCKED", ""))),
          ),
        );
        await kit.waitUntilBlocked(holder.pid);
        await holder.abort();
        expect((await legacy).ok).toBe(true);
      });

    it("refuses an invalid hold code or identifier before touching the database", async () => {
      const { f, s } = await oneRequest();
      await expect(suppress(f.w.org.id, "not-a-uuid")).rejects.toThrow(/UUID/);
      await expect(
        t.db.transaction((tx) => suppressSessionQueuedRequests(tx, f.w.org.id, s.id, "Bad Code")),
      ).rejects.toThrow(/hold code/);
    });
  });
});
