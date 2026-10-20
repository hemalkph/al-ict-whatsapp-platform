import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { claimNext, executeClaim, type DispatchDeps } from "@/modules/messaging/dispatch";
import { FakeTransport, minutesAgo } from "@/modules/messaging/testing";
import type { SendResult } from "@/modules/messaging/transport";
import {
  EMERGENCY_STOP_PHRASE,
  emergencyStop,
  retireDeployment,
  stopActiveSessions,
} from "./index";
import type { BotControlDeps, Tx } from "./common";
import { lockSuppressionCandidates, suppressionCandidatesSql } from "./suppression";
import {
  BOTS_ON,
  barrierKit,
  deployedBot,
  dispatchWorld,
  liveSessionFor,
  queueBotStep,
  settledState,
  textMessage,
  windowStudent,
  type DispatchFixture,
  type LiveSession,
  holdLeftoverQueued,
} from "./testing";

// The acceptance-recording versus Stop-suppression concurrency finding (Phase 08D, ADR 0020), on disposable al_ict_test_*
// PostgreSQL at the production isolation level (READ COMMITTED) everywhere. Participants: A = Stop (the real service),
// B = the dispatcher's claim (real claimNext), C = acceptance recording (real executeClaim -> record). Order is proved by lock
// OWNERSHIP (pg_blocking_pids and NOWAIT probes), never by sleeps.
//
// I.1 reproduces the reviewer's interleaving: A's suppression statement has OBSERVED request R as QUEUED (its snapshot) but has
// not yet tried to lock R, while B commits R as SENDING and C holds R's newest version and waits for the conversation A holds.
// The barrier: A's candidate statement is executed through a cursor (identical SQL text, parameters inlined), which keeps the
// snapshot of the statement and lets FETCH stop between two rows (the plan's lock node locks rows as they are fetched; whatever
// the plan, P1/P2 below establish empirically that exactly the first row is locked after FETCH 1). Everything else in A is the
// real Stop. The legacy control is the same text without SKIP LOCKED and must deadlock (40P01); the production text must not.

const T0 = new Date("2026-06-01T12:00:00Z");
const DEADLOCK = "40P01";
const LOCK_NOT_AVAILABLE = "55P03";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** The candidate statement's text with its parameters inlined as literals (validated: UUIDs and a UUID-array literal only). */
function inlined(organizationId: string, deploymentIds: readonly string[]): string {
  const q = new PgDialect().sqlToQuery(suppressionCandidatesSql(organizationId, deploymentIds));
  return q.sql.replace(/\$(\d+)/g, (_, n: string) => {
    const v = q.params[Number(n) - 1];
    if (typeof v !== "string" || !/^[0-9a-f{},-]+$/.test(v))
      throw new Error("unexpected parameter");
    return `'${v}'`;
  });
}
const once = (text: string, from: string, to: string) => {
  expect(text.split(from)).toHaveLength(2); // exactly one occurrence
  return text.replace(from, to);
};

describe("Stop suppression versus claim and acceptance recording (READ COMMITTED)", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
  const row = async (id: string) =>
    (await q("select * from outbound_requests where id = $1", [id])).rows[0];
  const probeNowait = async (id: string) => {
    try {
      await q("select 1 from outbound_requests where id = $1 for share nowait", [id]);
      return "free";
    } catch (e) {
      return (e as { code?: string }).code ?? "error";
    }
  };
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
    await holdLeftoverQueued(t);
    kit = barrierKit(t);
    for (const m of ["log", "warn", "error"] as const)
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

  /** Two live sessions (S0 in K0, S in K) of deployment D, each with one QUEUED BOT request; R0 has the smaller id. */
  async function twoRequests(f?: DispatchFixture) {
    const fx = f ?? (await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) }));
    const s1 = await liveSessionFor(t, fx);
    const s2 = await liveSessionFor(t, fx, await windowStudent(t, fx.w, minutesAgo(30, T0)));
    const r1 = await queueBotStep(t, fx, s1, { stepSeq: 1, message: textMessage("one"), now: T0 });
    const r2 = await queueBotStep(t, fx, s2, { stepSeq: 1, message: textMessage("two"), now: T0 });
    const [first, second] =
      r1.requestId < r2.requestId
        ? [
            { s: s1, r: r1 },
            { s: s2, r: r2 },
          ]
        : [
            { s: s2, r: r2 },
            { s: s1, r: r1 },
          ];
    return { f: fx, R0: first.r, S0: first.s, R: second.r, S: second.s };
  }

  type Variant = "production" | "legacy";
  type Op = "stop" | "emergency";

  /**
   * I.1. Runs A (the real Stop or Emergency Stop) with its candidate statement driven through a cursor, orchestrates B and C
   * at the barrier, and returns every observation. `retries` is the acceptance-record retry limit used by C.
   */
  async function interleave(variant: Variant, o: { op?: Op; retries?: number } = {}) {
    const op = o.op ?? "stop";
    const x = await twoRequests();
    let other: Awaited<ReturnType<typeof deployedBot>> | undefined;
    if (op === "emergency") other = await deployedBot(t.db, x.f.w, 2); // a second deployment, no sessions
    const reachedFirst = deferred<{ pid: number; first: string[] }>();
    const goOn = deferred();
    const witnessed = deferred<Array<{ id: string; state: string }>>();
    const afterFetch = deferred<{ ids: string[]; cBlockersAfter: number[] | null }>();
    let cPid = 0;

    const cursorLock = async (tx: Tx, organizationId: string, deploymentIds: readonly string[]) => {
      const text = inlined(organizationId, deploymentIds);
      const candidates = variant === "legacy" ? once(text, " SKIP LOCKED", "") : text;
      const witness = once(
        once(text, "SELECT r.id FROM", "SELECT r.id, r.state FROM"),
        " FOR UPDATE OF r SKIP LOCKED",
        "",
      );
      await tx.execute(sql.raw(`DECLARE stop_candidates CURSOR FOR ${candidates}`));
      await tx.execute(sql.raw(`DECLARE stop_witness CURSOR FOR ${witness}`));
      const first = (
        await tx.execute<{ id: string }>(sql.raw("FETCH 1 FROM stop_candidates"))
      ).rows.map((r) => r.id);
      const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`)).rows[0]!
        .pid;
      reachedFirst.resolve({ pid, first });
      await goOn.promise;
      witnessed.resolve(
        (await tx.execute<{ id: string; state: string }>(sql.raw("FETCH ALL FROM stop_witness")))
          .rows,
      );
      const rest = (
        await tx.execute<{ id: string }>(sql.raw("FETCH ALL FROM stop_candidates"))
      ).rows.map((r) => r.id);
      const cBlockersAfter = cPid ? await kit.blockersOf(cPid) : null;
      afterFetch.resolve({ ids: [...first, ...rest], cBlockersAfter });
      return [...first, ...rest];
    };
    const deps: BotControlDeps = { db: t.db as never, lockSuppressionCandidates: cursorLock };
    const a = kit.settle<unknown>(
      op === "stop"
        ? stopActiveSessions(
            x.f.w.admin.ctx,
            { deploymentId: x.f.d.deployment.id, expectedLiveSessions: 2 },
            deps,
          )
        : emergencyStop(
            x.f.w.admin.ctx,
            { expectedDeployments: 2, confirmPhrase: EMERGENCY_STOP_PHRASE },
            deps,
          ),
    );
    const { pid: aPid, first } = await reachedFirst.promise;

    // P1 / P2: after FETCH 1 exactly the first row (R0) is locked by A; R is not locked by anyone.
    const p1 = await probeNowait(x.R0.requestId);
    const p2 = await probeNowait(x.R.requestId);

    // B: the real claim. R0 is skipped (A holds it), R is claimed and committed SENDING.
    const transport = new FakeTransport().next(accepted("wamid.TEST08D.STOP.0001"));
    const attempts: Array<[number, string | null]> = [];
    const cDeps = dispatchDeps(transport, {
      recordRetryLimit: o.retries ?? 2,
      onRecordAttempt: (attempt, outcome) => void attempts.push([attempt, outcome]),
    });
    const claimed = await claimNext(cDeps);
    const rAfterClaim = (await row(x.R.requestId)).state;

    // C: final read passes (A is uncommitted), one transport call, the record locks R's newest version and waits for K.
    const c = kit.settle(executeClaim(cDeps, claimed.claim!));
    cPid = await kit.waitUntilBlocked(aPid);
    const p3 = await kit.blockersOf(cPid);
    const p4 = await probeNowait(x.R.requestId);
    goOn.resolve();
    const p5 = await witnessed.promise;

    // P6 (legacy only): A now waits on C while C waits on A, observed before the detector breaks it.
    let p6: boolean | null = null;
    if (variant === "legacy") {
      const deadline = Date.now() + 5_000;
      p6 = false;
      while (Date.now() < deadline) {
        const b = await kit.blockersOf(aPid).catch(() => [] as number[]);
        if (b.includes(cPid)) {
          p6 = true;
          break;
        }
        if ((await kit.within(a, 5)) === true) break;
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    const [aResult, cResult] = await Promise.all([a, c]);
    const fetched = variant === "production" ? await afterFetch.promise : null;
    return {
      x,
      other,
      first,
      p1,
      p2,
      p3,
      p4,
      p5,
      p6,
      aPid,
      cPid,
      claimed,
      rAfterClaim,
      transport,
      attempts,
      aResult,
      aState: settledState(aResult),
      cResult,
      fetched,
    };
  }

  describe("I.1: the reviewer's interleaving, deterministic, at READ COMMITTED", () => {
    it("the barrier establishes the intended visibility and lock relationships (P1-P5), and the PRODUCTION statement never waits: no deadlock, Stop succeeds, ACCEPTED is recorded", async () => {
      const r = await interleave("production");
      expect(r.first).toEqual([r.x.R0.requestId]);
      expect(r.p1).toBe(LOCK_NOT_AVAILABLE); // P1: R0 locked by A after FETCH 1
      expect(r.p2).toBe("free"); // P2: R not yet locked: incremental, ordered locking, whatever the plan
      expect(r.claimed.claim?.requestId).toBe(r.x.R.requestId); // B skipped R0, claimed R
      expect(r.rAfterClaim).toBe("SENDING");
      expect(r.p3).toEqual([r.aPid]); // P3: C waits on A (the conversation), nothing else
      expect(r.p4).toBe(LOCK_NOT_AVAILABLE); // P4: R's newest version is held (by C: B committed, A never locked R)
      // P5 (supporting evidence; the witness cursor has its own snapshot, opened right after the candidates' and before B):
      expect(r.p5.map((w) => [w.id, w.state]).sort()).toEqual(
        [
          [r.x.R0.requestId, "QUEUED"],
          [r.x.R.requestId, "QUEUED"],
        ].sort(),
      );
      // A's FETCH ALL returned without R while C was STILL blocked by A: A cannot have waited on C (C waits on A).
      expect(r.fetched!.ids).toEqual([r.x.R0.requestId]);
      expect(r.fetched!.cBlockersAfter).toEqual([r.aPid]);
      // committed outcomes
      expect(r.aResult.ok, String((r.aResult as { error?: unknown }).error)).toBe(true);
      expect(r.aState).toBeNull();
      expect(r.cResult).toMatchObject({ ok: true, value: "accepted" });
      expect(r.attempts).toEqual([[1, "ok"]]); // one record transaction: no retry was needed
      expect([r.aState, ...r.attempts.map(([, s]) => s)]).not.toContain(DEADLOCK);
      expect(r.transport.calls).toHaveLength(1);
      expect(await row(r.x.R.requestId)).toMatchObject({ state: "ACCEPTED" });
      expect(
        (await q("select wamid from messages where id = $1", [r.x.R.messageId])).rows[0].wamid,
      ).toBe("wamid.TEST08D.STOP.0001");
      expect(await row(r.x.R0.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_stopped",
      });
      expect(
        (await q("select wamid from messages where id = $1", [r.x.R0.messageId])).rows[0].wamid,
      ).toBeNull();
      expect(
        (
          await q("select status, send_epoch::int epoch from bot_deployments where id = $1", [
            r.x.f.d.deployment.id,
          ])
        ).rows[0],
      ).toEqual({ status: "PAUSED", epoch: 2 });
      for (const s of [r.x.S0, r.x.S])
        expect(
          (
            await q(
              "select state, end_reason, handover_reason, output_suppressed_at is not null suppressed from bot_sessions where id = $1",
              [s.id],
            )
          ).rows[0],
        ).toEqual({
          state: "HANDED_OVER",
          end_reason: "system_handover",
          handover_reason: "operator_stop",
          suppressed: true,
        });
      expect(
        (
          await q(
            "select kind, sessions_affected, requests_suppressed, requests_in_flight from bot_deployment_events where deployment_id = $1 order by created_at",
            [r.x.f.d.deployment.id],
          )
        ).rows,
      ).toEqual([
        { kind: "ACTIVATED", sessions_affected: 0, requests_suppressed: 0, requests_in_flight: 0 },
        {
          kind: "SESSIONS_STOPPED",
          sessions_affected: 2,
          requests_suppressed: 1,
          requests_in_flight: 1,
        },
      ]);
      // no duplicate request, no other BOT message
      expect(
        (
          await q(
            "select count(*)::int n from outbound_requests where organization_id = $1 and origin = 'BOT'",
            [r.x.f.w.org.id],
          )
        ).rows[0],
      ).toEqual({ n: 2 });
    });

    it("NEGATIVE CONTROL (legacy text, acceptance retries DISABLED): the same interleaving deadlocks (40P01) and harms Stop or acceptance", async () => {
      const r = await interleave("legacy", { retries: 0 });
      expect(r.p1).toBe(LOCK_NOT_AVAILABLE);
      expect(r.p2).toBe("free");
      expect(r.p3).toEqual([r.aPid]);
      expect(r.p4).toBe(LOCK_NOT_AVAILABLE);
      expect(r.p6).toBe(true); // A waited on C while C waited on A: the cycle itself, observed
      const deadlocks = [r.aState, ...r.attempts.map(([, s]) => s)].filter((s) => s === DEADLOCK);
      expect(deadlocks).toHaveLength(1); // exactly one victim, chosen by the detector
      expect(r.transport.calls).toHaveLength(1);
      const finalR = await row(r.x.R.requestId);
      if (r.aState === DEADLOCK) {
        // A was the victim: Stop failed and rolled back entirely
        expect(r.aResult.ok).toBe(false);
        expect(finalR.state).toBe("ACCEPTED");
        expect(
          (await q("select state from bot_sessions where id = $1", [r.x.S.id])).rows[0].state,
        ).toBe("WAITING_FOR_SEND");
      } else {
        // C was the victim: a message Meta accepted is recorded as UNKNOWN_OUTCOME (the false uncertainty)
        expect(r.attempts).toEqual([[1, DEADLOCK]]);
        expect(finalR).toMatchObject({
          state: "UNKNOWN_OUTCOME",
          failure_code: "accepted_but_not_recorded",
        });
      }
    });

    it("NEGATIVE CONTROL (legacy text, retries enabled): the deadlock is still observed per attempt, so retries cannot hide it", async () => {
      const r = await interleave("legacy", { retries: 2 });
      expect(r.p6).toBe(true);
      const deadlocks = [r.aState, ...r.attempts.map(([, s]) => s)].filter((s) => s === DEADLOCK);
      expect(deadlocks).toHaveLength(1);
      expect(r.transport.calls).toHaveLength(1);
      if (r.aState !== DEADLOCK) expect(r.attempts.map(([, s]) => s)).toEqual([DEADLOCK, "ok"]);
    });

    it("O6 (I.1 with Emergency Stop): production statement, two deployments, no deadlock, ACCEPTED recorded", async () => {
      const r = await interleave("production", { op: "emergency" });
      expect([r.p1, r.p2, r.p4]).toEqual([LOCK_NOT_AVAILABLE, "free", LOCK_NOT_AVAILABLE]);
      expect(r.aResult.ok, String((r.aResult as { error?: unknown }).error)).toBe(true);
      expect(r.attempts).toEqual([[1, "ok"]]);
      expect(r.transport.calls).toHaveLength(1);
      expect(await row(r.x.R.requestId)).toMatchObject({ state: "ACCEPTED" });
      expect(await row(r.x.R0.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_stopped",
      });
      expect(
        (
          await q("select id, status from bot_deployments where id = any($1) order by id", [
            [r.x.f.d.deployment.id, r.other!.deployment.id],
          ])
        ).rows.map((d) => d.status),
      ).toEqual(["STOPPED", "STOPPED"]);
      expect(
        (
          await q(
            "select requests_suppressed, requests_in_flight from bot_deployment_events where deployment_id = $1 and kind = 'STOPPED'",
            [r.x.f.d.deployment.id],
          )
        ).rows,
      ).toEqual([{ requests_suppressed: 1, requests_in_flight: 1 }]);
    });
  });

  // ------------------------------------------------------------------------------------------------ I.2 real Stop
  describe("I.2: the real Stop against the dispatcher, in competing orders (production code only)", () => {
    async function one(f?: DispatchFixture, terminal?: "COMPLETED") {
      const fx = f ?? (await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) }));
      const s = await liveSessionFor(t, fx);
      const r = await queueBotStep(t, fx, s, {
        stepSeq: 1,
        message: textMessage(),
        now: T0,
        ...(terminal ? { terminal } : {}),
      });
      return { f: fx, s, r };
    }
    const stop = (x: { f: DispatchFixture }, live = 1) =>
      stopActiveSessions(
        x.f.w.admin.ctx,
        { deploymentId: x.f.d.deployment.id, expectedLiveSessions: live },
        { db: t.db as never },
      );
    const events = (x: { f: DispatchFixture }) =>
      q(
        "select kind, requests_suppressed, requests_in_flight from bot_deployment_events where deployment_id = $1 and kind <> 'ACTIVATED' order by created_at",
        [x.f.d.deployment.id],
      ).then((r) => r.rows);
    const countBot = (x: { s: LiveSession }) =>
      q("select count(*)::int n from outbound_requests where bot_session_id = $1", [x.s.id]).then(
        (r) => r.rows[0].n,
      );

    it("O1: Stop commits before any claim: HELD bot_stopped by Stop; nothing is claimed; 0 calls", async () => {
      const x = await one();
      expect((await stop(x)).value).toMatchObject({ requestsSuppressed: 1, requestsInFlight: 0 });
      expect(await row(x.r.requestId)).toMatchObject({ state: "HELD", hold_reason: "bot_stopped" });
      const transport = new FakeTransport();
      expect((await claimNext(dispatchDeps(transport))).claim).toBeNull();
      expect(transport.calls).toHaveLength(0);
      expect(await events(x)).toEqual([
        { kind: "SESSIONS_STOPPED", requests_suppressed: 1, requests_in_flight: 0 },
      ]);
    });

    /** B parked while holding R QUEUED: the test holds the account row, so the claim waits in loadAccount FOR SHARE. */
    async function parkedClaim(x: { f: DispatchFixture }, transport: FakeTransport) {
      const account = await kit.hold("select id from whatsapp_accounts where id = $1 for update", [
        x.f.w.account.id,
      ]);
      const b = kit.settle(claimNext(dispatchDeps(transport)));
      const bPid = await kit.waitUntilBlocked(account.pid);
      return { account, b, bPid };
    }

    // The dispatcher's hold code names the FIRST failing rule of bot_request_hold_code: deployment status, then send epoch. Stop
    // leaves the deployment PAUSED (a usable status) with a new epoch, so the request is held for its stale epoch. Retire makes the
    // deployment RETIRED (and also bumps the epoch); the status rule comes first, so the reason is the deployment being inactive.
    for (const [name, run, reason] of [
      ["Stop", (x: Awaited<ReturnType<typeof one>>) => stop(x), "bot_epoch_superseded"],
      [
        "Retire (O7)",
        async (x: Awaited<ReturnType<typeof one>>) => {
          const key = (await q("select key from bots where id = $1", [x.f.d.bot.id])).rows[0].key;
          return retireDeployment(
            x.f.w.admin.ctx,
            { deploymentId: x.f.d.deployment.id, confirmBotKey: key, expectedLiveSessions: 1 },
            { db: t.db as never },
          );
        },
        "bot_deployment_inactive",
      ],
    ] as const)
      it(`O2${name === "Stop" ? "" : "/O7"}: ${name} runs while a claim holds R QUEUED: it never waits (skips R); the claim then holds it; 0 calls`, async () => {
        const x = await one();
        const transport = new FakeTransport();
        const { account, b, bPid } = await parkedClaim(x, transport);
        const result = await run(x); // must complete while B is still parked holding R
        expect(result.value).toMatchObject({ requestsSuppressed: 0, requestsInFlight: 1 });
        expect(await kit.blockersOf(bPid)).toEqual([account.pid]); // B never moved: Stop did not wait on it
        await account.release();
        expect(await b).toMatchObject({ ok: true, value: { claim: null, held: 1 } });
        expect(await row(x.r.requestId)).toMatchObject({ state: "HELD", hold_reason: reason });
        expect(transport.calls).toHaveLength(0);
        expect(await countBot(x)).toBe(1);
      });

    it("O3: the claim committed SENDING, then Stop commits: the final authorization holds it (never QUEUED); 0 calls", async () => {
      const x = await one();
      const transport = new FakeTransport();
      const { claim } = await claimNext(dispatchDeps(transport));
      expect((await stop(x)).value).toMatchObject({ requestsSuppressed: 0, requestsInFlight: 1 });
      expect(await executeClaim(dispatchDeps(transport), claim!)).toBe("held");
      expect(await row(x.r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_epoch_superseded",
      });
      expect(transport.calls).toHaveLength(0);
    });

    it("O4: authorized and in the transport when Stop commits: it cannot be recalled; ACCEPTED, 1 call (documented limit)", async () => {
      const x = await one();
      const release = deferred();
      const transport = new FakeTransport().next(async () => {
        await release.promise;
        return accepted("wamid.O4");
      });
      const { claim } = await claimNext(dispatchDeps(transport));
      const c = kit.settle(executeClaim(dispatchDeps(transport), claim!));
      for (let i = 0; i < 500 && transport.calls.length === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(transport.calls).toHaveLength(1);
      expect((await stop(x)).value).toMatchObject({ requestsSuppressed: 0, requestsInFlight: 1 });
      release.resolve();
      expect(await c).toMatchObject({ ok: true, value: "accepted" });
      expect(await row(x.r.requestId)).toMatchObject({ state: "ACCEPTED" });
      expect(transport.calls).toHaveLength(1);
    });

    it("O5: three participants with the real Stop: Stop holds the conversation, the record waits for it, no deadlock, ACCEPTED", async () => {
      const x = await one();
      const session = await kit.hold("select id from bot_sessions where id = $1 for update", [
        x.s.id,
      ]);
      const a = kit.settle(stop(x));
      const aPid = await kit.waitUntilBlocked(session.pid); // Stop holds D and K, waits on S
      const transport = new FakeTransport().next(accepted("wamid.O5"));
      const attempts: Array<[number, string | null]> = [];
      const deps = dispatchDeps(transport, {
        onRecordAttempt: (attempt, outcome) => void attempts.push([attempt, outcome]),
      });
      const { claim } = await claimNext(deps);
      expect(claim?.requestId).toBe(x.r.requestId);
      const c = kit.settle(executeClaim(deps, claim!));
      const cPid = await kit.waitUntilBlocked(aPid); // the record holds R and waits for K, held by Stop
      expect(await kit.blockersOf(cPid)).toEqual([aPid]);
      expect(transport.calls).toHaveLength(1);
      await session.release();
      const [aResult, cResult] = await Promise.all([a, c]);
      expect(settledState(aResult)).toBeNull();
      expect(aResult).toMatchObject({
        ok: true,
        value: { value: { requestsSuppressed: 0, requestsInFlight: 1, sessionsStopped: 1 } },
      });
      expect(cResult).toMatchObject({ ok: true, value: "accepted" });
      expect(attempts).toEqual([[1, "ok"]]);
      expect(await row(x.r.requestId)).toMatchObject({ state: "ACCEPTED" });
      expect(
        (await q("select wamid from messages where id = $1", [x.r.messageId])).rows[0].wamid,
      ).toBe("wamid.O5");
      expect(
        (
          await q(
            "select state, end_reason, handover_reason, output_suppressed_at is not null s from bot_sessions where id = $1",
            [x.s.id],
          )
        ).rows[0],
      ).toEqual({
        state: "HANDED_OVER",
        end_reason: "system_handover",
        handover_reason: "operator_stop",
        s: true,
      });
      expect(
        (
          await q("select status, send_epoch::int e from bot_deployments where id = $1", [
            x.f.d.deployment.id,
          ])
        ).rows[0],
      ).toEqual({ status: "PAUSED", e: 2 });
      expect(await events(x)).toEqual([
        { kind: "SESSIONS_STOPPED", requests_suppressed: 0, requests_in_flight: 1 },
      ]);
      expect(await countBot(x)).toBe(1);
      expect(transport.calls).toHaveLength(1);
      // the record moved the outbound timestamps (and, through Drizzle's $onUpdate, updated_at); allocation did not
      const conversation = (
        await q("select last_outbound_at from conversations where id = $1", [
          x.s.student.conversation.id,
        ])
      ).rows[0];
      expect(conversation.last_outbound_at).toEqual(T0);
    });

    it("O6: Emergency Stop in the O5 order (two deployments, R on one)", async () => {
      const x = await one();
      const other = await deployedBot(t.db, x.f.w, 2);
      const session = await kit.hold("select id from bot_sessions where id = $1 for update", [
        x.s.id,
      ]);
      const a = kit.settle(
        emergencyStop(
          x.f.w.admin.ctx,
          { expectedDeployments: 2, confirmPhrase: EMERGENCY_STOP_PHRASE },
          { db: t.db as never },
        ),
      );
      const aPid = await kit.waitUntilBlocked(session.pid);
      const transport = new FakeTransport().next(accepted("wamid.O6"));
      const { claim } = await claimNext(dispatchDeps(transport));
      const c = kit.settle(executeClaim(dispatchDeps(transport), claim!));
      await kit.waitUntilBlocked(aPid);
      await session.release();
      const [aResult, cResult] = await Promise.all([a, c]);
      expect(settledState(aResult)).toBeNull();
      expect(aResult.ok).toBe(true);
      expect(cResult).toMatchObject({ ok: true, value: "accepted" });
      expect(transport.calls).toHaveLength(1);
      expect(
        (
          await q("select status from bot_deployments where id = any($1)", [
            [x.f.d.deployment.id, other.deployment.id],
          ])
        ).rows.map((d) => d.status),
      ).toEqual(["STOPPED", "STOPPED"]);
    });

    it("O8: a terminal notice: Stop first holds it (bot_stopped); with a claim parked, the dispatcher holds it; 0 calls", async () => {
      const a = await one(undefined, "COMPLETED");
      expect((await stop(a, 0)).value).toMatchObject({
        requestsSuppressed: 1,
        requestsInFlight: 0,
      });
      expect(await row(a.r.requestId)).toMatchObject({ state: "HELD", hold_reason: "bot_stopped" });
      const b = await one(undefined, "COMPLETED");
      const transport = new FakeTransport();
      const { account, b: claim } = await parkedClaim(b, transport);
      expect((await stop(b, 0)).value).toMatchObject({
        requestsSuppressed: 0,
        requestsInFlight: 1,
      });
      await account.release();
      expect(await claim).toMatchObject({ ok: true, value: { claim: null, held: 1 } });
      expect(await row(b.r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_epoch_superseded",
      });
      expect(transport.calls).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------------------ I.3 invariant
  describe("I.3: suppression never waits on a request-row lock", () => {
    for (const how of ["claim-like FOR UPDATE", "record-like uncommitted UPDATE"] as const)
      it(`production completes while R is held (${how}); the legacy text is blocked by the holder (positive control)`, async () => {
        const { f, r } = await (async () => {
          const fx = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
          const s = await liveSessionFor(t, fx);
          return {
            f: fx,
            r: await queueBotStep(t, fx, s, { stepSeq: 1, message: textMessage(), now: T0 }),
          };
        })();
        const holder = await kit.hold(
          how === "claim-like FOR UPDATE"
            ? "select id from outbound_requests where id = $1 for update"
            : "update outbound_requests set provider_message_status = 'held_by_test' where id = $1",
          [r.requestId],
        );
        const production = await kit.settle(
          t.db.transaction((tx) => lockSuppressionCandidates(tx, f.w.org.id, [f.d.deployment.id])),
        );
        expect(production).toMatchObject({ ok: true, value: [] }); // skipped, while the holder still holds it
        const legacy = kit.settle(
          t.db.transaction((tx) =>
            tx.execute(sql.raw(once(inlined(f.w.org.id, [f.d.deployment.id]), " SKIP LOCKED", ""))),
          ),
        );
        await kit.waitUntilBlocked(holder.pid); // the legacy statement waits on the holder
        await holder.abort();
        expect((await legacy).ok).toBe(true);
      });
  });
});
