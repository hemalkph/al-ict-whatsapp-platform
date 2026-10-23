import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_VIOLATION,
  createTestDatabase,
  expectPgError,
  type TestDb,
} from "@/db/__tests__/helpers";
import {
  claimTriggersSql,
  lockTerminalizationCandidateSql,
  markTriggerDeadSql,
} from "@/db/ops/bot-trigger-queue";
import { claimNext, type DispatchDeps } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import {
  BOTS_ON,
  addStudent,
  barrierKit,
  botWorld,
  dispatchWorld,
  liveSessionFor,
  queueBotStep,
  textMessage,
  windowStudent,
  type BotWorld,
  type DispatchFixture,
  type LiveSession,
} from "../bot-control/testing";
import {
  claimTriggers,
  finishTrigger,
  listTerminalizationCandidates,
  recordTriggerFailure,
  terminalizeTrigger,
  type ClaimedTrigger,
  type TerminalizationCandidate,
} from "./trigger-queue";
import { expireClaim, insertTrigger, makeDue, triggerRow, type QueueCtx } from "./testing";

// R1 (Phase 08E-3): a trigger whose six claims are used is terminalized, never claimed a seventh time, without disturbing a
// running sixth attempt, with a live session handed over in the same transaction, and with recovery from a lost sixth claim or a
// lost failure acknowledgment. Real PostgreSQL 17, real persisted state, real lock ownership barriers (no mocks).
//
// 08E-5 resolved the interim dependency of 08E-3: the terminalizer now holds a handed-over session's QUEUED request itself
// (QUEUED -> HELD bot_output_suppressed, the session-scoped primitive, in the same transaction as DEAD and the hand-over). A
// request a dispatcher claim holds is skipped, never waited for, and the dispatcher's claim/final authorization then refuse it
// because the session's suppression committed first. A SENDING request is never touched.

const dialect = new PgDialect();
const random = () => 0.5;
const SECRET = "secret@example.com wrote this";
const failure = () => Object.assign(new Error(SECRET), { code: "40001" });

describe("trigger exhaustion and terminalization (R1)", () => {
  let t: TestDb;
  let w: BotWorld;
  let barriers: ReturnType<typeof barrierKit>;
  const logs: string[] = [];
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
  const ctxOf = (world: BotWorld, conversationId = world.student.conversation.id): QueueCtx => ({
    organizationId: world.org.id,
    accountId: world.account.id,
    conversationId,
  });
  const candidate = (id: string, ctx: QueueCtx): TerminalizationCandidate => ({
    organizationId: ctx.organizationId,
    id,
    conversationId: ctx.conversationId,
  });
  const claimOne = async (id: string): Promise<ClaimedTrigger> => {
    const c = (await claimTriggers(t.db)).find((x) => x.id === id);
    if (!c) throw new Error(`trigger ${id} was not claimed`);
    return c;
  };
  /** n claim-then-fail cycles (each fails after rolling back, then the backoff is skipped). */
  async function failTimes(id: string, n: number): Promise<void> {
    for (let i = 1; i <= n; i++) {
      const c = await claimOne(id);
      expect(c.attempts).toBe(i);
      expect(await recordTriggerFailure(t.db, c, failure(), random)).toBe(true);
      await makeDue(t, id);
    }
  }
  const mutated = (s: SQL, edit: (text: string) => string) => {
    const rendered = dialect.sqlToQuery(s);
    const text = edit(rendered.sql);
    expect(text, "the mutation must change the statement").not.toBe(rendered.sql);
    return { text, params: rendered.params };
  };
  const policy = { maxClaims: 6, leaseMs: 60_000 };

  beforeAll(async () => {
    t = await createTestDatabase({
      sessionTimeouts: {
        lock_timeout: 10_000,
        statement_timeout: 15_000,
        idle_in_transaction_session_timeout: 20_000,
      },
    });
  });
  afterAll(async () => {
    if (t) await t.close();
  });
  beforeEach(async () => {
    logs.length = 0;
    for (const method of ["log", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation((line: unknown) => {
        logs.push(String(line));
      });
    await q("truncate organizations, webhook_requests cascade");
    w = await botWorld(t.db);
    barriers = barrierKit(t);
  });
  afterEach(async () => {
    try {
      await barriers.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  });

  // ------------------------------------------------------------------------------------- six failures -> DEAD

  describe("six failures lead to DEAD", () => {
    it("no seventh claim; terminalization marks it DEAD; the later input is then claimable and the log carries ids and codes only", async () => {
      const ctx = ctxOf(w);
      const base = Date.now() - 120_000;
      const poison = await insertTrigger(t, ctx, { inputOccurredAt: new Date(base) });
      const later = await insertTrigger(t, ctx, { inputOccurredAt: new Date(base + 1_000) });
      await failTimes(poison.id, 6);
      expect(await triggerRow(t, poison.id)).toMatchObject({
        status: "PENDING",
        attempts: 6,
        claim_token: null,
        last_error_code: "serialization_failure",
      });
      // no seventh claim, and the later input is still blocked behind the exhausted head of line
      expect(await claimTriggers(t.db)).toEqual([]);
      expect(await triggerRow(t, later.id)).toMatchObject({ attempts: 0 });
      expect(await listTerminalizationCandidates(t.db)).toEqual([candidate(poison.id, ctx)]);

      expect(await terminalizeTrigger(t.db, candidate(poison.id, ctx))).toEqual({
        kind: "dead",
        handedOverSessionId: null,
        endedTriggers: 0,
      });
      const dead = await triggerRow(t, poison.id);
      expect(dead).toMatchObject({
        status: "DEAD",
        outcome_code: "attempts_exhausted",
        attempts: 6,
        claim_token: null,
        claimed_at: null,
        last_error_code: "serialization_failure",
      });
      expect(dead.processed_at).toBeInstanceOf(Date);
      // later eligible work is not permanently blocked
      const next = await claimTriggers(t.db);
      expect(next.map((c) => c.id)).toEqual([later.id]);
      expect(next[0]!.attempts).toBe(1);
      // DEAD is final: never claimed, never terminalized again
      expect(await terminalizeTrigger(t.db, candidate(poison.id, ctx))).toEqual({
        kind: "skipped",
        reason: "not_candidate",
      });
      expect(await listTerminalizationCandidates(t.db)).toEqual([]);

      const line = logs.find((l) => l.includes("bots.trigger_dead"));
      expect(line).toBeDefined();
      expect(JSON.parse(line!)).toMatchObject({
        bots_event: "bots.trigger_dead",
        trigger_id: poison.id,
        conversation_id: ctx.conversationId,
        reason: "attempts_exhausted",
      });
      expect(logs.join("\n")).not.toContain("secret@example.com");
    });

    it("the sixth claim is the last: a fifth failure still has a sixth chance, and attempts never exceed six", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      await failTimes(trig.id, 5);
      expect(await terminalizeTrigger(t.db, candidate(trig.id, ctxOf(w)))).toEqual({
        kind: "skipped",
        reason: "not_candidate",
      });
      const sixth = await claimOne(trig.id);
      expect(sixth.attempts).toBe(6);
      expect((await q("select max(attempts) m from bot_triggers")).rows[0].m).toBe(6);
    });

    it("NEGATIVE CONTROL: a claim without the attempts limit would make a seventh and the CHECK refuses it", async () => {
      const trig = await insertTrigger(t, ctxOf(w), { attempts: 6 });
      const broken = mutated(
        claimTriggersSql({ limit: 5, leaseMs: 60_000, maxClaims: 6 }),
        (text) => text.replaceAll("t.attempts <", "t.attempts <="),
      );
      await expectPgError(
        q(broken.text, broken.params),
        CHECK_VIOLATION,
        "bot_triggers_attempts_check",
      );
      expect(await triggerRow(t, trig.id)).toMatchObject({ attempts: 6 });
    });
  });

  // ---------------------------------------------------------------------------------- the sixth attempt variants

  describe("the sixth attempt", () => {
    it("(a) a sixth attempt still running is never terminalized: a live claim, and a lease-expired T1 still holding the row, are both left alone", async () => {
      const ctx = ctxOf(w);
      const trig = await insertTrigger(t, ctx);
      await failTimes(trig.id, 5);
      const sixth = await claimOne(trig.id);
      // the claim is live: not a candidate, nothing changes
      expect(await listTerminalizationCandidates(t.db)).toEqual([]);
      expect(await terminalizeTrigger(t.db, candidate(trig.id, ctx))).toEqual({
        kind: "skipped",
        reason: "not_candidate",
      });
      // the lease is over but the attempt is alive and holds its row (a late, slow T1)
      await expireClaim(t, trig.id);
      const t1 = await barriers.hold(
        "select id from bot_triggers where id = $1 and claim_token = $2::uuid for update",
        [trig.id, sixth.claimToken],
      );
      const during = terminalizeTrigger(t.db, candidate(trig.id, ctx));
      expect(await barriers.within(during, 5_000)).toBe(true); // SKIP LOCKED: it did not wait for the running attempt
      expect(await during).toEqual({ kind: "skipped", reason: "not_candidate" });
      expect(await triggerRow(t, trig.id)).toMatchObject({
        status: "PENDING",
        attempts: 6,
        claim_token: sixth.claimToken,
      });
      // the attempt fails and records its failure: only now is the trigger terminalized
      await t1.release();
      expect(await recordTriggerFailure(t.db, sixth, failure(), random)).toBe(true);
      expect(await terminalizeTrigger(t.db, candidate(trig.id, ctx))).toMatchObject({
        kind: "dead",
      });
    });

    it("(b) a sixth attempt that commits is PROCESSED and never DEAD", async () => {
      const ctx = ctxOf(w);
      const trig = await insertTrigger(t, ctx);
      await failTimes(trig.id, 5);
      const sixth = await claimOne(trig.id);
      await expireClaim(t, trig.id); // the lease ran out while the attempt was still working
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const t1 = barriers.settle(
        t.db.transaction(async (tx) => {
          const locked = await tx.execute(
            sql`select id from bot_triggers where id = ${trig.id} and claim_token = ${sixth.claimToken}::uuid for update`,
          );
          if (locked.rows.length !== 1) throw new Error("the running attempt lost its row");
          started.resolve();
          await release.promise;
          return finishTrigger(tx, sixth, { status: "PROCESSED", outcomeCode: "processed" });
        }),
      );
      await started.promise;
      expect(await terminalizeTrigger(t.db, candidate(trig.id, ctx))).toEqual({
        kind: "skipped",
        reason: "not_candidate",
      });
      release.resolve();
      expect(await t1).toMatchObject({ ok: true, value: true });
      expect(await triggerRow(t, trig.id)).toMatchObject({
        status: "PROCESSED",
        outcome_code: "processed",
        attempts: 6,
      });
      expect(await terminalizeTrigger(t.db, candidate(trig.id, ctx))).toEqual({
        kind: "skipped",
        reason: "not_candidate",
      });
      expect(await triggerRow(t, trig.id)).toMatchObject({ status: "PROCESSED" }); // never DEAD
      expect(await claimTriggers(t.db)).toEqual([]);
    });

    it("(c) a worker killed after the sixth claim: protected by the lease, then terminalized; never a seventh claim", async () => {
      const ctx = ctxOf(w);
      const trig = await insertTrigger(t, ctx);
      await failTimes(trig.id, 5);
      await claimOne(trig.id); // the worker dies here
      expect(await terminalizeTrigger(t.db, candidate(trig.id, ctx))).toMatchObject({
        kind: "skipped",
      });
      expect(await claimTriggers(t.db)).toEqual([]);
      await expireClaim(t, trig.id);
      expect(await claimTriggers(t.db)).toEqual([]); // still no seventh claim once the lease is over
      expect(await listTerminalizationCandidates(t.db)).toEqual([candidate(trig.id, ctx)]);
      expect(await terminalizeTrigger(t.db, candidate(trig.id, ctx))).toMatchObject({
        kind: "dead",
      });
      expect(await triggerRow(t, trig.id)).toMatchObject({ status: "DEAD", attempts: 6 });
    });

    it("(d) a lost failure acknowledgment: the record committed, the worker never saw it; the replay changes nothing and the next sweep terminalizes", async () => {
      const ctx = ctxOf(w);
      const trig = await insertTrigger(t, ctx);
      await failTimes(trig.id, 5);
      const sixth = await claimOne(trig.id);
      expect(await recordTriggerFailure(t.db, sixth, failure(), random)).toBe(true); // committed ... acknowledgment lost
      const after = await triggerRow(t, trig.id);
      expect(await recordTriggerFailure(t.db, sixth, failure(), random)).toBe(false); // the worker's retry
      expect(await triggerRow(t, trig.id)).toEqual(after);
      expect(await listTerminalizationCandidates(t.db)).toEqual([candidate(trig.id, ctx)]);
      expect(await terminalizeTrigger(t.db, candidate(trig.id, ctx))).toMatchObject({
        kind: "dead",
      });
    });

    it("(d') the failure record never reached the database: the claim stays until the lease ends, then the trigger is terminalized", async () => {
      const ctx = ctxOf(w);
      const trig = await insertTrigger(t, ctx);
      await failTimes(trig.id, 5);
      await claimOne(trig.id); // T1 rolled back, T2 lost
      expect(await listTerminalizationCandidates(t.db)).toEqual([]);
      await expireClaim(t, trig.id);
      expect(await terminalizeTrigger(t.db, candidate(trig.id, ctx))).toMatchObject({
        kind: "dead",
      });
    });
  });

  // ---------------------------------------------------------------------------------------------- not candidates

  describe("only exhausted, unprotected, PENDING triggers are terminalized", () => {
    it("fewer than six claims, a live claim, and finished or dead triggers are skipped without change", async () => {
      const cases: Array<[string, Parameters<typeof insertTrigger>[2]]> = [
        ["five claims", { attempts: 5 }],
        ["a live sixth claim", { attempts: 6, claimAgeMs: 1_000 }],
        ["processed", { attempts: 6, finished: "PROCESSED" }],
        ["ignored", { attempts: 6, finished: "IGNORED" }],
        ["already dead", { attempts: 6, finished: "DEAD" }],
      ];
      for (const [name, seed] of cases) {
        const student = await addStudent(t.db, w.org.id, w.account.id);
        const ctx = ctxOf(w, student.conversation.id);
        const trig = await insertTrigger(t, ctx, seed);
        const before = await triggerRow(t, trig.id);
        expect(await terminalizeTrigger(t.db, candidate(trig.id, ctx)), name).toEqual({
          kind: "skipped",
          reason: "not_candidate",
        });
        expect(await triggerRow(t, trig.id), name).toEqual(before);
      }
    });

    it("another organization's identifiers terminalize nothing", async () => {
      const other = await botWorld(t.db);
      const ctx = ctxOf(w);
      const trig = await insertTrigger(t, ctx, { attempts: 6 });
      expect(
        await terminalizeTrigger(t.db, {
          organizationId: other.org.id,
          id: trig.id,
          conversationId: ctx.conversationId,
        }),
      ).toEqual({ kind: "skipped", reason: "not_candidate" });
      expect(await triggerRow(t, trig.id)).toMatchObject({ status: "PENDING", attempts: 6 });
    });

    it("lists only candidates, oldest id first, bounded by the limit", async () => {
      const made: string[] = [];
      for (let i = 0; i < 3; i++) {
        const student = await addStudent(t.db, w.org.id, w.account.id);
        made.push((await insertTrigger(t, ctxOf(w, student.conversation.id), { attempts: 6 })).id);
      }
      await insertTrigger(
        t,
        ctxOf(w, (await addStudent(t.db, w.org.id, w.account.id)).conversation.id),
        { attempts: 6, claimAgeMs: 1_000 },
      );
      const all = await listTerminalizationCandidates(t.db, 10);
      expect(all.map((c) => c.id)).toEqual([...made].sort());
      expect(await listTerminalizationCandidates(t.db, 2)).toHaveLength(2);
    });
  });

  // ------------------------------------------------------------------------------------------- a live session

  describe("an existing live session", () => {
    let fx: DispatchFixture;
    let s: LiveSession;
    const dispatchDeps = (transport: FakeTransport): DispatchDeps => ({
      db: t.db as never,
      transport,
      config: BOTS_ON,
      now: () => new Date(Date.now() + 1_000),
      random: () => 0.5,
      accountMinIntervalMs: 0,
      conversationMinIntervalMs: 0,
    });
    const sessionRow = async () =>
      (await q("select * from bot_sessions where id = $1", [s.id])).rows[0] as Record<
        string,
        unknown
      >;
    const controlSeq = async () =>
      Number(
        (
          await q("select control_seq from conversations where id = $1", [
            s.student.conversation.id,
          ])
        ).rows[0].control_seq,
      );

    beforeEach(async () => {
      fx = await dispatchWorld(t, { lastInboundAt: new Date() });
      s = await liveSessionFor(t, fx, await windowStudent(t, fx.w, new Date()));
    });

    it("is handed over in the same transaction, suppressed and stamped by the database; the conversation's other triggers end with it", async () => {
      const ctx = ctxOf(fx.w, s.student.conversation.id);
      const base = Date.now() - 120_000;
      const poison = await insertTrigger(t, ctx, {
        messageId: s.student.message.id,
        inputOccurredAt: new Date(base),
      });
      const later = await insertTrigger(t, ctx, { inputOccurredAt: new Date(base + 1_000) });
      await failTimes(poison.id, 6);
      const other = await insertTrigger(
        t,
        ctxOf(fx.w, (await addStudent(t.db, fx.w.org.id, fx.w.account.id)).conversation.id),
      );

      const before = await sessionRow();
      const seqBefore = await controlSeq();

      const result = await terminalizeTrigger(t.db, candidate(poison.id, ctx));
      expect(result).toEqual({ kind: "dead", handedOverSessionId: s.id, endedTriggers: 1 });

      const after = await sessionRow();
      expect(after).toMatchObject({
        state: "HANDED_OVER",
        end_reason: "system_handover",
        handover_reason: "bot_error",
        awaiting: null,
        awaiting_token: null,
        expires_at: null,
        send_wait_expires_at: null,
        terminal_notice_step_seq: null,
        revision: Number(before.revision) + 1,
      });
      expect(after.output_suppressed_at).toBeInstanceOf(Date);
      expect(after.ended_at).toBeInstanceOf(Date);
      expect(Number(after.handover_control_seq)).toBeGreaterThan(
        Number(before.started_control_seq),
      );
      expect(await controlSeq()).toBe(seqBefore + 1); // exactly one allocation, on the conversation row this transaction held
      const events = await q("select kind, code from bot_session_events where session_id = $1", [
        s.id,
      ]);
      expect(events.rows).toEqual([{ kind: "HANDED_OVER", code: "bot_error" }]);

      expect(await triggerRow(t, poison.id)).toMatchObject({
        status: "DEAD",
        outcome_code: "attempts_exhausted",
      });
      expect(await triggerRow(t, later.id)).toMatchObject({
        status: "IGNORED",
        outcome_code: "session_ended",
        claim_token: null,
      });
      // another conversation is untouched and still claimable
      expect((await triggerRow(t, other.id)).status).toBe("PENDING");
      expect((await claimTriggers(t.db)).map((c) => c.id)).toEqual([other.id]);
      expect(logs.some((l) => l.includes("bots.trigger_dead") && l.includes(s.id))).toBe(true);
    });

    it("a QUEUED request of the handed-over session is held in the same transaction (08E-5): HELD bot_output_suppressed, nothing to claim, 0 calls", async () => {
      const queued = await queueBotStep(t, fx, s, {
        stepSeq: 1,
        message: textMessage("hello"),
        now: new Date(),
      });
      const ctx = ctxOf(fx.w, s.student.conversation.id);
      const poison = await insertTrigger(t, ctx, { messageId: s.student.message.id });
      await failTimes(poison.id, 6);
      expect(await terminalizeTrigger(t.db, candidate(poison.id, ctx))).toMatchObject({
        kind: "dead",
        handedOverSessionId: s.id,
      });
      // held by the terminalizer itself (the interim QUEUED pin of 08E-3 is gone), with the suppression's own code
      expect(
        (
          await q(
            "select state, hold_reason, finished_at is not null finished from outbound_requests where id = $1",
            [queued.requestId],
          )
        ).rows[0],
      ).toEqual({ state: "HELD", hold_reason: "bot_output_suppressed", finished: true });
      const transport = new FakeTransport();
      const claimed = await claimNext(dispatchDeps(transport));
      expect(claimed).toEqual({ claim: null, held: 0 }); // nothing left QUEUED for the dispatcher
      expect(transport.calls).toHaveLength(0);
      expect(
        (
          await q(
            "select count(*)::int n from outbound_requests where bot_session_id = $1 and state in ('QUEUED','SENDING')",
            [s.id],
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it("a QUEUED request a dispatcher claim holds is SKIPPED, never waited for; the claim then refuses it (bot_output_suppressed), 0 calls", async () => {
      const queued = await queueBotStep(t, fx, s, {
        stepSeq: 1,
        message: textMessage("hello"),
        now: new Date(),
      });
      const ctx = ctxOf(fx.w, s.student.conversation.id);
      const poison = await insertTrigger(t, ctx, { messageId: s.student.message.id });
      await failTimes(poison.id, 6);
      // park a real claim AFTER it locked R (FOR UPDATE SKIP LOCKED) and BEFORE its bot-rule read: it waits for the account row
      const account = await barriers.hold(
        "select id from whatsapp_accounts where id = $1 for update",
        [fx.w.account.id],
      );
      const transport = new FakeTransport();
      const claim = barriers.settle(claimNext(dispatchDeps(transport)));
      const claimPid = await barriers.waitUntilBlocked(account.pid);
      const probe = await q("select 1 from outbound_requests where id = $1 for share skip locked", [
        queued.requestId,
      ]);
      expect(probe.rows).toHaveLength(0); // R is locked by the parked claim

      const done = terminalizeTrigger(t.db, candidate(poison.id, ctx));
      expect(await barriers.within(done, 5_000)).toBe(true); // completes while the claim still holds R
      expect(await done).toMatchObject({ kind: "dead", handedOverSessionId: s.id });
      expect(await barriers.blockersOf(claimPid)).toEqual([account.pid]); // the claim never moved
      expect(
        (await q("select state from outbound_requests where id = $1", [queued.requestId])).rows[0]
          .state,
      ).toBe("QUEUED"); // skipped, not held
      expect((await triggerRow(t, poison.id)).status).toBe("DEAD");
      expect(
        (
          await q(
            "select state, output_suppressed_at is not null s from bot_sessions where id = $1",
            [s.id],
          )
        ).rows[0],
      ).toEqual({ state: "HANDED_OVER", s: true });

      await account.release();
      expect(await claim).toMatchObject({ ok: true, value: { claim: null, held: 1 } });
      expect(
        (
          await q("select state, hold_reason from outbound_requests where id = $1", [
            queued.requestId,
          ])
        ).rows[0],
      ).toEqual({ state: "HELD", hold_reason: "bot_output_suppressed" });
      expect(transport.calls).toHaveLength(0);
    });

    it("a SENDING request is never touched: no state change, no recall, no new transport attempt", async () => {
      const queued = await queueBotStep(t, fx, s, {
        stepSeq: 1,
        message: textMessage("hello"),
        now: new Date(),
      });
      await q(
        "update outbound_requests set state='SENDING', claimed_by='test-worker', claimed_at=clock_timestamp(), send_started_at=clock_timestamp(), attempt_count=1 where id=$1",
        [queued.requestId],
      );
      const ctx = ctxOf(fx.w, s.student.conversation.id);
      const poison = await insertTrigger(t, ctx, { messageId: s.student.message.id });
      await failTimes(poison.id, 6);
      const before = (await q("select * from outbound_requests where id = $1", [queued.requestId]))
        .rows[0];
      expect(await terminalizeTrigger(t.db, candidate(poison.id, ctx))).toMatchObject({
        kind: "dead",
        handedOverSessionId: s.id,
      });
      expect(
        (await q("select * from outbound_requests where id = $1", [queued.requestId])).rows[0],
      ).toEqual(before);
      expect(before.state).toBe("SENDING");
      const transport = new FakeTransport();
      await claimNext(dispatchDeps(transport));
      expect(transport.calls).toHaveLength(0);
    });

    it("four concurrent terminalizers: exactly one writes DEAD and the hand-over; the session changes once", async () => {
      const ctx = ctxOf(fx.w, s.student.conversation.id);
      const poison = await insertTrigger(t, ctx, { messageId: s.student.message.id });
      await failTimes(poison.id, 6);
      const before = await sessionRow();
      const results = await Promise.all(
        Array.from({ length: 4 }, () => terminalizeTrigger(t.db, candidate(poison.id, ctx))),
      );
      expect(results.filter((r) => r.kind === "dead")).toHaveLength(1);
      for (const r of results.filter((x) => x.kind === "skipped"))
        expect(["not_candidate", "conversation_busy"]).toContain(r.reason);
      expect((await sessionRow()).revision).toBe(Number(before.revision) + 1);
      expect(
        (await q("select count(*)::int n from bot_session_events where session_id = $1", [s.id]))
          .rows[0].n,
      ).toBe(1);
      expect((await triggerRow(t, poison.id)).status).toBe("DEAD");
    });

    it("a busy conversation (a step transaction holds its advisory lock) skips the round untouched; the next round succeeds", async () => {
      const ctx = ctxOf(fx.w, s.student.conversation.id);
      const poison = await insertTrigger(t, ctx, { messageId: s.student.message.id });
      await failTimes(poison.id, 6);
      const before = await sessionRow();
      const key = `bot-conv:${fx.w.org.id}:${s.student.conversation.id}`;
      const step = await barriers.hold("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        key,
      ]);
      const skipped = terminalizeTrigger(t.db, candidate(poison.id, ctx));
      expect(await barriers.within(skipped, 5_000)).toBe(true); // a try-lock: it never waits
      expect(await skipped).toEqual({ kind: "skipped", reason: "conversation_busy" });
      expect(await triggerRow(t, poison.id)).toMatchObject({ status: "PENDING", attempts: 6 });
      expect(await sessionRow()).toEqual(before);
      await step.release();
      expect(await terminalizeTrigger(t.db, candidate(poison.id, ctx))).toMatchObject({
        kind: "dead",
        handedOverSessionId: s.id,
      });
    });

    it("waits its turn behind a Stop-like deployment lock without deadlocking (deployment before conversation, as a step does)", async () => {
      const ctx = ctxOf(fx.w, s.student.conversation.id);
      const poison = await insertTrigger(t, ctx, { messageId: s.student.message.id });
      await failTimes(poison.id, 6);
      const stop = await barriers.hold("select id from bot_deployments where id = $1 for update", [
        fx.d.deployment.id,
      ]);
      const pending = barriers.settle(terminalizeTrigger(t.db, candidate(poison.id, ctx)));
      const blocked = await barriers.waitUntilBlocked(stop.pid); // waiting at the deployment row, holding only its trigger row
      expect(await barriers.blockersOf(blocked)).toEqual([stop.pid]);
      await stop.release();
      expect((await pending).ok).toBe(true);
      expect((await triggerRow(t, poison.id)).status).toBe("DEAD");
    });
  });

  // ------------------------------------------------------------------------------------- mutations of the terminalizer

  describe("mutation checks: a broken terminalizer is detected", () => {
    it("without the PENDING guard the DEAD write overwrites a trigger that already completed", async () => {
      const ctx = ctxOf(w);
      const done = await insertTrigger(t, ctx, { attempts: 6, finished: "PROCESSED" });
      const good = dialect.sqlToQuery(markTriggerDeadSql(candidate(done.id, ctx), policy));
      expect((await q(good.sql, good.params)).rowCount).toBe(0);
      const broken = mutated(markTriggerDeadSql(candidate(done.id, ctx), policy), (text) =>
        text.replace(" AND status = 'PENDING'", ""),
      );
      expect((await q(broken.text, broken.params)).rowCount).toBe(1);
      expect((await triggerRow(t, done.id)).status).toBe("DEAD"); // a completed trigger was killed
    });

    it("without the live-claim guard the DEAD write kills a trigger whose sixth attempt is running", async () => {
      const ctx = ctxOf(w);
      const running = await insertTrigger(t, ctx, { attempts: 6, claimAgeMs: 1_000 });
      const good = dialect.sqlToQuery(markTriggerDeadSql(candidate(running.id, ctx), policy));
      expect((await q(good.sql, good.params)).rowCount).toBe(0);
      const broken = mutated(markTriggerDeadSql(candidate(running.id, ctx), policy), (text) =>
        text.replace("(claim_token IS NULL OR claimed_at <", "(true OR claimed_at <"),
      );
      expect((await q(broken.text, broken.params)).rowCount).toBe(1);
      expect((await triggerRow(t, running.id)).status).toBe("DEAD");
    });

    it("without the attempts guard an unexhausted trigger is killed", async () => {
      const ctx = ctxOf(w);
      const young = await insertTrigger(t, ctx, { attempts: 2 });
      const good = dialect.sqlToQuery(markTriggerDeadSql(candidate(young.id, ctx), policy));
      expect((await q(good.sql, good.params)).rowCount).toBe(0);
      const broken = mutated(markTriggerDeadSql(candidate(young.id, ctx), policy), (text) =>
        text.replace(/ AND attempts = \$(\d+)/, (_m, n: string) => ` AND $${n}::int IS NOT NULL`),
      );
      expect((await q(broken.text, broken.params)).rowCount).toBe(1);
      expect((await triggerRow(t, young.id)).status).toBe("DEAD");
    });

    it("without SKIP LOCKED the terminalizer WAITS behind the running attempt it must never wait for", async () => {
      const ctx = ctxOf(w);
      const trig = await insertTrigger(t, ctx, { attempts: 6 });
      const attempt = await barriers.hold("select id from bot_triggers where id = $1 for update", [
        trig.id,
      ]);
      const waiting = mutated(
        lockTerminalizationCandidateSql(candidate(trig.id, ctx), policy),
        (text) => text.replace(" SKIP LOCKED", ""),
      );
      const blocked = barriers.settle(q(waiting.text, waiting.params));
      const pid = await barriers.waitUntilBlocked(attempt.pid);
      expect(await barriers.blockersOf(pid)).toEqual([attempt.pid]);
      await attempt.release();
      expect((await blocked).ok).toBe(true);
    });
  });
});
