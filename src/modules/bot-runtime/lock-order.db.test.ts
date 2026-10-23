import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { lockConversation, lockDeploymentsShare } from "@/db/ops/bot-step";
import { terminalizeTrigger as terminalizeTriggerOp } from "@/db/ops/bot-trigger-queue";
import type { DbExecutor } from "@/db/ops/executor";
import { claimNext, executeClaim } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { deliver, handleDirect } from "@/modules/whatsapp/inbound/testing";
import { PN, WABA } from "@/modules/whatsapp/identity/testing";
import {
  OUTPUT_SUPPRESSED_HOLD_CODE,
  stopActiveSessions,
  suppressSessionQueuedRequests,
} from "../bot-control";
import { barrierKit, settledState } from "../bot-control/testing";
import type { StepSummary } from "./context";
import { RUNTIME_POLICY } from "./policy";
import {
  deferred,
  insertTrigger,
  makeDue,
  runtimeKit,
  triggerRow,
  type RuntimeFx,
} from "./testing";
import { claimTriggers, terminalizeTrigger } from "./trigger-queue";

// R3-P (Phase 08E-5; plan I.2, I.4, K.1, K.2) on disposable PostgreSQL 17 at READ COMMITTED: the real step transaction T1
// against Stop, trigger terminalization, the Inbox assignment, the staff submission and the inbound handler, in both lock orders
// where a deterministic barrier exists. T1's order is trigger -> conversation advisory TRY-lock -> deployment FOR SHARE ->
// conversation FOR UPDATE -> session FOR UPDATE -> account FOR SHARE; Stop's is deployment FOR UPDATE -> conversation -> session.
// Order is proved by lock ownership (pg_blocking_pids), never by sleeping. No 40P01 may appear with the approved order; the
// deliberately inverted order (conversation before deployment) must deadlock against Stop. NOT EXECUTED by the author of this
// change: no isolated PostgreSQL server was configured.

const DEADLOCK = "40P01";

describe("T1 lock order against Stop, terminalization and staff/inbound writers (R3-P)", () => {
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

  /**
   * A live session WAITING_FOR_SEND whose prompt R was ACCEPTED (real T1 + real dispatcher), and a reply trigger for it: run
   * alone, T1 consumes the reply and enqueues the NEXT prompt R2 (so "no unauthorized request" is a meaningful assertion).
   */
  async function world() {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    const transport = new FakeTransport().acceptAll("wamid.TEST08E5.P");
    const { claim } = await claimNext(k.dispatchDeps(transport));
    expect(await executeClaim(k.dispatchDeps(transport), claim!)).toBe("accepted");
    const reply = await k.replyTrigger(f, session.awaiting_token as string, "a");
    return { f, s: session, r: request, reply, claim: await k.claimOf(reply.id) };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const stop = (x: { f: RuntimeFx }) =>
    stopActiveSessions(
      x.f.w.admin.ctx,
      { deploymentId: x.f.deployment.id, expectedLiveSessions: 1 },
      { db: t.db as never },
    );
  const noDeadlock = (...results: Array<{ ok: boolean; error?: unknown }>) =>
    expect(results.map((r) => settledState(r))).not.toContain(DEADLOCK);
  const ok = (s: StepSummary, status: string, outcome: string) =>
    expect(s).toMatchObject({ kind: "finished", status, outcome });

  /** T1 paused before COMMIT (all its locks held, its writes done). */
  async function t1PausedBeforeCommit(x: World) {
    const p = k.pause();
    const run = kit.settle(k.runClaim(x.claim, { hooks: { beforeCommit: p.hook } }));
    const pid = await p.reached;
    return { run, pid, release: p.release };
  }

  // ------------------------------------------------------------------------------------------------ T1 x Stop
  describe("T1 x Stop (they meet at the deployment row)", () => {
    it("A: Stop commits first: T1, waiting at the deployment, re-reads under its locks, creates NO request; restart ignores the input", async () => {
      const x = await world();
      const session = await kit.hold("select id from bot_sessions where id = $1 for update", [
        x.s.id,
      ]);
      const a = kit.settle(stop(x));
      const stopPid = await kit.waitUntilBlocked(session.pid); // Stop holds D and K, waits on S
      const t1 = kit.settle(k.runClaim(x.claim));
      const t1Pid = await kit.waitUntilBlocked(stopPid); // T1 waits at the deployment row, behind Stop
      expect(await kit.blockersOf(t1Pid)).toEqual([stopPid]);
      await session.release();
      const [stopResult, t1Result] = await Promise.all([a, t1]);
      noDeadlock(stopResult, t1Result);
      expect(stopResult).toMatchObject({
        ok: true,
        value: { value: { sessionsStopped: 1, requestsSuppressed: 0 } },
      });
      // T1 saw the session gone under its locks: no engine run, no request, no session write by T1
      expect(t1Result).toMatchObject({
        ok: true,
        value: { kind: "deferred", reason: "session_changed" },
      });
      const s = await k.session(x.s.id as string);
      expect(s).toMatchObject({ state: "HANDED_OVER", handover_reason: "operator_stop" });
      expect(Number(s.revision)).toBe(Number(x.s.revision) + 1); // Stop's write only
      expect((await k.botRequests(x.f)).map((r) => r.state)).toEqual(["ACCEPTED"]);
      // restart: the same input, claimed again, starts nothing (an unresolved hand-over blocks a start)
      await makeDue(t, x.reply.id);
      ok(await k.run(x.reply.id), "IGNORED", "handover_unresolved");
      expect(await k.botRequests(x.f)).toHaveLength(1);
    });

    it("B: T1 commits first: Stop waits at the deployment, then sees T1's committed QUEUED R2 and holds it (bot_stopped); 0 calls", async () => {
      const x = await world();
      const p = await t1PausedBeforeCommit(x);
      const a = kit.settle(stop(x));
      const stopPid = await kit.waitUntilBlocked(p.pid);
      expect(await kit.blockersOf(stopPid)).toEqual([p.pid]);
      p.release();
      const [t1Result, stopResult] = await Promise.all([p.run, a]);
      noDeadlock(t1Result, stopResult);
      expect(t1Result).toMatchObject({
        ok: true,
        value: { status: "PROCESSED", outcome: "input_accepted" },
      });
      expect(stopResult).toMatchObject({
        ok: true,
        value: { value: { sessionsStopped: 1, requestsSuppressed: 1, requestsInFlight: 0 } },
      });
      const [, r2] = await k.botRequests(x.f);
      expect(r2).toMatchObject({ bot_step_seq: 2, state: "HELD", hold_reason: "bot_stopped" });
      const transport = new FakeTransport();
      expect((await claimNext(k.dispatchDeps(transport))).claim).toBeNull();
      expect(transport.calls).toHaveLength(0);
    });

    it("B': T1 commits first and a dispatcher claim holds R2: Stop skips it without waiting; the claim then holds it (bot_epoch_superseded); 0 calls", async () => {
      const x = await world();
      ok(await k.runClaim(x.claim), "PROCESSED", "input_accepted");
      const account = await kit.hold("select id from whatsapp_accounts where id = $1 for update", [
        x.f.w.account.id,
      ]);
      const transport = new FakeTransport();
      const b = kit.settle(claimNext(k.dispatchDeps(transport)));
      const bPid = await kit.waitUntilBlocked(account.pid);
      const result = await stop(x);
      expect(result.value).toMatchObject({ requestsSuppressed: 0, requestsInFlight: 1 });
      expect(await kit.blockersOf(bPid)).toEqual([account.pid]);
      await account.release();
      expect(await b).toMatchObject({ ok: true, value: { claim: null, held: 1 } });
      const [, r2] = await k.botRequests(x.f);
      expect(r2).toMatchObject({ state: "HELD", hold_reason: "bot_epoch_superseded" });
      expect(transport.calls).toHaveLength(0);
    });

    it("a T1 wait longer than lock_timeout fails (55P03), commits nothing, and T2 records lock_timeout with the attempt charged", async () => {
      const x = await world();
      const session = await kit.hold("select id from bot_sessions where id = $1 for update", [
        x.s.id,
      ]);
      const a = kit.settle(stop(x));
      await kit.waitUntilBlocked(session.pid);
      const t1 = await k.runClaim(x.claim); // waits at the deployment for lock_timeout, then fails
      expect(t1).toEqual({ kind: "failed", errorCode: "lock_timeout", recorded: true });
      expect(RUNTIME_POLICY.lockTimeoutMs).toBeLessThan(15_000);
      expect(await triggerRow(t, x.reply.id)).toMatchObject({
        status: "PENDING",
        attempts: 1,
        claim_token: null,
        last_error_code: "lock_timeout",
      });
      expect(await k.botRequests(x.f)).toHaveLength(1);
      await session.release();
      noDeadlock(await a);
    });

    it("MUTATION: the inverted order (conversation FOR UPDATE before deployment FOR SHARE, the real T1 statements) deadlocks against Stop (40P01)", async () => {
      const x = await world();
      const org = x.f.w.org.id;
      const k1 = deferred<number>();
      const go = deferred();
      const m = kit.settle(
        t.db.transaction(async (tx) => {
          const db = tx as unknown as DbExecutor;
          await lockConversation(db, org, x.f.w.student.conversation.id);
          k1.resolve(
            (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`)).rows[0]!.pid,
          );
          await go.promise;
          await lockDeploymentsShare(db, org, [x.f.deployment.id]);
        }),
      );
      const mPid = await k1.promise;
      const a = kit.settle(stop(x)); // Stop takes D FOR UPDATE, then waits for K (held by the mutated T1)
      const stopPid = await kit.waitUntilBlocked(mPid);
      go.resolve(); // the mutated T1 now waits for D, held by Stop: a cycle
      const [mr, sr] = await Promise.all([m, a]);
      expect([settledState(mr), settledState(sr)].filter((s) => s === DEADLOCK)).toHaveLength(1);
      expect(stopPid).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------------------------------------------ T1 x terminalization
  describe("T1 x trigger terminalization (both take the conversation advisory TRY-lock; neither waits)", () => {
    async function exhausted(x: World) {
      const trig = await insertTrigger(t, k.ctxOf(x.f), { attempts: 6 });
      return {
        organizationId: x.f.w.org.id,
        id: trig.id,
        conversationId: x.f.w.student.conversation.id,
      };
    }

    it("T1 holds the conversation: terminalization skips the round at once (conversation_busy); after T1 commits it hands over and holds R2", async () => {
      const x = await world();
      const cand = await exhausted(x);
      const p = await t1PausedBeforeCommit(x);
      const busy = terminalizeTrigger(t.db, cand);
      expect(await kit.within(busy, 5_000)).toBe(true);
      expect(await busy).toEqual({ kind: "skipped", reason: "conversation_busy" });
      p.release();
      noDeadlock(await p.run);
      expect(await terminalizeTrigger(t.db, cand)).toMatchObject({
        kind: "dead",
        handedOverSessionId: x.s.id,
      });
      const [, r2] = await k.botRequests(x.f);
      expect(r2).toMatchObject({ state: "HELD", hold_reason: "bot_output_suppressed" });
    });

    it("terminalization holds the conversation: T1 defers at once (conversation_busy, fresh input); restart after the hand-over starts nothing", async () => {
      const x = await world();
      const cand = await exhausted(x);
      const inside = deferred<number>();
      const go = deferred();
      const a = kit.settle(
        terminalizeTriggerOp(t.db as unknown as DbExecutor, cand, {
          maxClaims: 6,
          leaseMs: 60_000,
          lockTimeoutMs: RUNTIME_POLICY.lockTimeoutMs,
          suppressSession: async (tx, org, sid) => {
            inside.resolve(
              (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`)).rows[0]!.pid,
            );
            await go.promise;
            return suppressSessionQueuedRequests(tx, org, sid, OUTPUT_SUPPRESSED_HOLD_CODE);
          },
        }),
      );
      await inside.promise;
      const t1 = k.runClaim(x.claim);
      expect(await kit.within(t1, 5_000)).toBe(true);
      expect(await t1).toEqual({ kind: "deferred", reason: "conversation_busy" });
      go.resolve();
      const done = await a;
      noDeadlock(done);
      expect(done).toMatchObject({
        ok: true,
        value: { kind: "dead", handedOverSessionId: x.s.id },
      });
      // T1's deferral committed first, so the trigger was PENDING and unlocked when the terminalizer's J.4a pass ran in the same
      // hand-over transaction: it was ended IGNORED session_ended there. Nothing is left to claim; the old claim does nothing.
      expect(await triggerRow(t, x.reply.id)).toMatchObject({
        status: "IGNORED",
        outcome_code: "session_ended",
        claim_token: null,
        session_id: null,
      });
      await makeDue(t, x.reply.id); // a no-op on a finished trigger
      expect((await claimTriggers(t.db, 50)).map((c) => c.id)).not.toContain(x.reply.id);
      expect(await k.runClaim(x.claim)).toEqual({ kind: "lost_claim" });
      expect(await k.session(x.s.id as string)).toMatchObject({
        state: "HANDED_OVER",
        handover_reason: "bot_error",
      });
      expect(await k.botRequests(x.f)).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------------------------ T1 x Inbox / staff
  describe("T1 x Inbox assignment and staff submission (both take the conversation first)", () => {
    for (const action of ["assign", "submit"] as const) {
      it(`${action}: T1 commits first; the staff writer waits for K, then commits a later control_seq; the dispatcher holds R2 staff_took_over`, async () => {
        const x = await world();
        const p = await t1PausedBeforeCommit(x);
        const staff = kit.settle<unknown>(action === "assign" ? k.assign(x.f) : k.submit(x.f));
        const staffPid = await kit.waitUntilBlocked(p.pid);
        expect(await kit.blockersOf(staffPid)).toEqual([p.pid]);
        p.release();
        const [t1Result, staffResult] = await Promise.all([p.run, staff]);
        noDeadlock(t1Result, staffResult);
        expect(staffResult.ok).toBe(true);
        expect(t1Result).toMatchObject({ ok: true, value: { outcome: "input_accepted" } });
        const transport = new FakeTransport();
        await claimNext(k.dispatchDeps(transport)); // a STAFF request it may claim is never executed here
        const [, r2] = await k.botRequests(x.f);
        expect(r2).toMatchObject({ state: "HELD", hold_reason: "staff_took_over" });
        expect(transport.calls).toHaveLength(0);
      });

      it(`${action}: the staff writer holds K first; T1 waits for it, then hands the session over (${action === "assign" ? "staff_assigned" : "staff_replied"}); no request`, async () => {
        const x = await world();
        // park the staff writer AFTER its conversation lock: the assignment waits on its target membership (FOR SHARE), the
        // submission on the account row
        const gate =
          action === "assign"
            ? await kit.hold("select id from organization_memberships where id = $1 for update", [
                x.f.w.staff.membershipId,
              ])
            : await kit.hold("select id from whatsapp_accounts where id = $1 for update", [
                x.f.w.account.id,
              ]);
        const staff = kit.settle<unknown>(action === "assign" ? k.assign(x.f) : k.submit(x.f));
        const staffPid = await kit.waitUntilBlocked(gate.pid);
        const t1 = kit.settle(k.runClaim(x.claim));
        const t1Pid = await kit.waitUntilBlocked(staffPid); // T1 waits for K, held by the staff writer
        expect(await kit.blockersOf(t1Pid)).toEqual([staffPid]);
        await gate.release();
        const [staffResult, t1Result] = await Promise.all([staff, t1]);
        noDeadlock(staffResult, t1Result);
        expect(staffResult.ok).toBe(true);
        expect(t1Result).toMatchObject({
          ok: true,
          value: { status: "IGNORED", outcome: "session_ended" },
        });
        expect(await k.session(x.s.id as string)).toMatchObject({
          state: "HANDED_OVER",
          handover_reason: action === "assign" ? "staff_assigned" : "staff_replied",
        });
        expect((await k.botRequests(x.f)).map((r) => r.state)).toEqual(["ACCEPTED"]); // no R2
      });
    }
  });

  // ------------------------------------------------------------------------------------------------ T1 x inbound handler
  describe("T1 x the inbound handler", () => {
    it("T1 holds K: the real inbound handler waits for it (activity update), then stores the message; no deadlock, nothing lost", async () => {
      const x = await world();
      // route the real ingest path to this world's account and student
      await t.pool.query(
        "update whatsapp_accounts set phone_number_id = $2, waba_id = $3 where id = $1",
        [x.f.w.account.id, PN, WABA],
      );
      await t.pool.query("update contacts set wa_id = '15550100123' where id = $1", [
        x.f.w.student.contact.id,
      ]);
      const event = await deliver(t.db, {});
      const p = await t1PausedBeforeCommit(x);
      const handler = kit.settle(handleDirect(t.db, event));
      const hPid = await kit.waitUntilBlocked(p.pid);
      expect(await kit.blockersOf(hPid)).toEqual([p.pid]);
      p.release();
      const [t1Result, hResult] = await Promise.all([p.run, handler]);
      noDeadlock(t1Result, hResult);
      expect(hResult.ok, String((hResult as { error?: unknown }).error)).toBe(true);
      expect(t1Result).toMatchObject({ ok: true, value: { outcome: "input_accepted" } });
      expect(
        Number(
          (
            await k.one(
              "select count(*)::int n from messages where conversation_id = $1 and wamid = $2",
              [x.f.w.student.conversation.id, event.providerObjectId],
            )
          ).n,
        ),
      ).toBe(1);
    });
  });
});
