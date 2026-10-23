import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { endConversationTriggersSql } from "@/db/ops/bot-trigger-queue";
import type { DbExecutor } from "@/db/ops/executor";
import { claimNext } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { barrierKit } from "../bot-control/testing";
import { sweepOnce } from "./reconcile";
import { insertTrigger, runtimeKit, triggerRow, type RuntimeFx } from "./testing";
import { auditOverdueTriggers, TRIGGER_OVERDUE_AGE_MS } from "./trigger-queue";

// E-DRAIN (Phase 08E-6; plan J.4a, K.2) on disposable PostgreSQL 17: an operation that holds a conversation lock never WAITS for a
// trigger row. The reconciler's end and wake passes use FOR UPDATE SKIP LOCKED: a trigger row a T1 holds is skipped (that T1
// finishes the trigger itself after the sweep commits), unlocked rows are ended or woken, finished rows are never reactivated.
// The J.4a audit reports PENDING triggers older than maxInputAge + 2 x lease. MUTATION: the same end pass WITHOUT SKIP LOCKED,
// run under the conversation lock against a trigger holder that then needs the conversation, closes a cycle and PostgreSQL
// reports 40P01. (The real T1 additionally never waits for the conversation: it takes the conversation advisory TRY-lock first,
// see R3-P; the mutation therefore uses a holder that takes the conversation row directly, which is the cycle J.4a forbids.)
// NOT EXECUTED by the author of this change: no isolated PostgreSQL server was configured.

const DEADLOCK = "40P01";

describe("trigger cleanup never waits on a trigger row (E-DRAIN)", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  let k: ReturnType<typeof runtimeKit>;
  const logs: string[] = [];
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
    logs.length = 0;
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation((line: unknown) => void logs.push(String(line)));
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

  const nowaitProbe = (id: string) =>
    t.pool.query("select 1 from bot_triggers where id = $1 for update nowait", [id]).then(
      () => "free",
      (e: { code?: string }) => e.code ?? "error",
    );

  /** S WAITING_FOR_SEND whose prompt the dispatcher HELD (deadline_passed): the next reconciliation hands S over. */
  async function heldPromptWorld() {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    await claimNext(
      k.dispatchDeps(new FakeTransport(), { now: () => new Date(Date.now() + 200_000) }),
    );
    expect((await k.request(request.id as string)).state).toBe("HELD");
    return { f, s: session };
  }

  it("the end pass skips a trigger row a T1 holds (no wait), ends the unlocked ones; the skipped trigger then finishes itself", async () => {
    const { f, s } = await heldPromptWorld();
    const x = await k.trigger(f, { body: "hello?" }); // will be held by its T1
    const claim = await k.claimOf(x.id);
    const y = await k.trigger(f, { body: "anyone?" }); // unlocked, PENDING
    const p = k.pause();
    const t1 = kit.settle(k.runClaim(claim, { hooks: { afterTriggerLock: p.hook } }));
    await p.reached; // T1 holds X's row, before its conversation try-lock
    expect(await nowaitProbe(x.id)).toBe("55P03");

    const sweep = k.reconcile(s);
    expect(await kit.within(sweep, 5_000)).toBe(true); // completes while X's row is still held: it never waited
    expect(await sweep).toMatchObject({ kind: "applied", finalState: "HANDED_OVER" });
    expect(await triggerRow(t, y.id)).toMatchObject({
      status: "IGNORED",
      outcome_code: "session_ended",
    });
    expect(await triggerRow(t, x.id)).toMatchObject({
      status: "PENDING",
      claim_token: claim.claimToken,
    }); // skipped

    p.release();
    const done = await t1;
    // X's own T1 re-reads under its locks: the session ended, so the input starts nothing (an unresolved hand-over)
    expect(done).toMatchObject({
      ok: true,
      value: { kind: "finished", status: "IGNORED", outcome: "handover_unresolved" },
    });
    expect((await triggerRow(t, x.id)).status).toBe("IGNORED");
    expect(await k.botRequests(f)).toHaveLength(1);
    expect(await auditOverdueTriggers(db())).toBe(0); // nothing left behind
  });

  it("the wake pass skips a held trigger row, wakes the unlocked deferred one, and never reactivates a finished trigger", async () => {
    const f = await k.fixture();
    const { session } = await k.acceptedPrompt(f);
    const held = await insertTrigger(t, k.ctxOf(f), { dueInMs: 60_000 });
    const free = await insertTrigger(t, k.ctxOf(f), { dueInMs: 60_000 });
    const finished = await insertTrigger(t, k.ctxOf(f), { dueInMs: 60_000, finished: "IGNORED" });
    const finishedBefore = await triggerRow(t, finished.id);
    const holder = await kit.hold("select id from bot_triggers where id = $1 for update", [
      held.id,
    ]);
    const sweep = k.reconcile(session);
    expect(await kit.within(sweep, 5_000)).toBe(true);
    expect(await sweep).toMatchObject({ kind: "applied", finalState: "WAITING_FOR_INPUT" });
    const due = async (id: string) =>
      Number(
        (
          await k.one(
            "select extract(epoch from (next_attempt_at - clock_timestamp())) s from bot_triggers where id = $1",
            [id],
          )
        ).s,
      );
    expect(await due(free.id)).toBeLessThanOrEqual(0); // woken
    await holder.abort();
    expect(await due(held.id)).toBeGreaterThan(30); // skipped: still deferred (its own T1 or the ladder resolves it)
    expect(await triggerRow(t, finished.id)).toEqual(finishedBefore); // never reactivated
    for (const id of [held.id, free.id])
      expect(await triggerRow(t, id)).toMatchObject({
        status: "PENDING",
        attempts: 0,
        claim_token: null,
      });
  });

  it("the overdue audit: a PENDING trigger older than maxInputAge + 2 x lease is reported (ids and count only); younger ones are not; processing clears it", async () => {
    const f = await k.fixture();
    expect(TRIGGER_OVERDUE_AGE_MS).toBe(12 * 60_000);
    const old = await k.trigger(f, { body: "secret text" });
    const young = await insertTrigger(t, k.ctxOf(f), {});
    await t.pool.query(
      "update bot_triggers set enqueued_at = clock_timestamp() - interval '13 minutes', input_occurred_at = clock_timestamp() - interval '13 minutes' where id = $1",
      [old.id],
    );
    await t.pool.query(
      "update bot_triggers set enqueued_at = clock_timestamp() - interval '11 minutes' where id = $1",
      [young.id],
    );
    expect(await auditOverdueTriggers(db())).toBe(1);
    const line = logs.find((l) => l.includes("bots.trigger_overdue"));
    expect(line).toBeDefined();
    expect(line).toContain(f.w.student.conversation.id);
    expect(JSON.parse(line!)).toMatchObject({ bots_event: "bots.trigger_overdue", count: 1 }); // only the 13-minute one
    expect(line).not.toContain("secret text");
    // processing the overdue (stale) head clears it; the 11-minute one is not overdue
    expect(await k.run(old.id)).toMatchObject({ status: "IGNORED", outcome: "stale_trigger" });
    logs.length = 0;
    expect(await auditOverdueTriggers(db())).toBe(0);
    expect(await sweepOnce(db(), k.deps())).toMatchObject({ overdueConversations: 0 });
  });

  it("an interrupted end pass (sweeper terminated under its locks) commits nothing; the retry ends the triggers once", async () => {
    const { f, s } = await heldPromptWorld();
    const y = await insertTrigger(t, k.ctxOf(f), { dueInMs: 60_000 });
    const before = await triggerRow(t, y.id);
    const interrupted = await k.interruptedReconcile(s);
    expect(interrupted.result.ok).toBe(false);
    expect(interrupted.locksReleased).toBe(true);
    expect(await triggerRow(t, y.id)).toEqual(before);
    expect((await k.session(s.id as string)).state).toBe("WAITING_FOR_SEND");
    expect(await k.reconcile(s)).toMatchObject({ kind: "applied", finalState: "HANDED_OVER" });
    const ended = await triggerRow(t, y.id);
    expect(ended).toMatchObject({ status: "IGNORED", outcome_code: "session_ended" });
    // exactly once: a further pass finds the session terminal and leaves the trigger as it is
    expect(await k.reconcile(s)).toEqual({ kind: "skipped", reason: "not_live" });
    expect(await triggerRow(t, y.id)).toEqual(ended);
  });

  // ------------------------------------------------------------------------------------------------ mutation
  /**
   * A sweeper-shaped transaction holds K (FOR UPDATE) and runs the end pass; a holder owns trigger X's row and then asks for K.
   * Production text: the pass skips X and commits; the holder gets K afterwards. Mutated text (no SKIP LOCKED): a cycle.
   */
  async function cycle(f: RuntimeFx, variant: "production" | "legacy") {
    const x = await insertTrigger(t, k.ctxOf(f), {});
    const rendered = new PgDialect().sqlToQuery(
      endConversationTriggersSql({
        organizationId: f.w.org.id,
        conversationId: f.w.student.conversation.id,
      }),
    );
    const text = variant === "legacy" ? rendered.sql.replace(" SKIP LOCKED", "") : rendered.sql;
    if (variant === "legacy") expect(text).not.toBe(rendered.sql);
    const holder = await t.pool.connect();
    const sweeper = await t.pool.connect();
    const states: Record<string, string | null> = {};
    try {
      await holder.query("begin");
      const holderPid = (await holder.query("select pg_backend_pid() pid")).rows[0].pid as number;
      await holder.query("select id from bot_triggers where id = $1 for update", [x.id]);
      await sweeper.query("begin");
      const sweeperPid = (await sweeper.query("select pg_backend_pid() pid")).rows[0].pid as number;
      expect(
        (await sweeper.query("show transaction_isolation")).rows[0].transaction_isolation,
      ).toBe("read committed");
      expect((await holder.query("show transaction_isolation")).rows[0].transaction_isolation).toBe(
        "read committed",
      );
      await sweeper.query("select id from conversations where id = $1 for update", [
        f.w.student.conversation.id,
      ]);
      const pass = kit.settle(sweeper.query(text, rendered.params));
      let sweeperWaitsOnHolder = false;
      if (variant === "legacy") {
        await kit.waitUntilBlocked(holderPid);
        sweeperWaitsOnHolder = (await kit.blockersOf(sweeperPid)).includes(holderPid);
      } else expect(await kit.within(pass, 5_000)).toBe(true);
      const want = kit.settle(
        holder.query("select id from conversations where id = $1 for update", [
          f.w.student.conversation.id,
        ]),
      );
      const [p, w] = await Promise.all([
        pass.then(async (r) => {
          if (r.ok) await sweeper.query("commit");
          else await sweeper.query("rollback");
          return r;
        }),
        want,
      ]);
      await holder.query(w.ok ? "commit" : "rollback");
      states.pass = p.ok ? null : ((p.error as { code?: string }).code ?? "error");
      states.want = w.ok ? null : ((w.error as { code?: string }).code ?? "error");
      return {
        x,
        states,
        sweeperWaitsOnHolder,
        passRows: p.ok ? (p.value as { rowCount: number }).rowCount : null,
      };
    } finally {
      holder.release();
      sweeper.release();
    }
  }

  it("production end pass under the conversation lock: skips the held trigger, commits; the holder gets the conversation afterwards; no 40P01", async () => {
    const f = await k.fixture();
    const r = await cycle(f, "production");
    expect(r.states).toEqual({ pass: null, want: null });
    expect(r.passRows).toBe(0);
    expect((await triggerRow(t, r.x.id)).status).toBe("PENDING");
  });

  it("MUTATION: the end pass WITHOUT SKIP LOCKED waits for the held trigger while its holder waits for the conversation: 40P01", async () => {
    const f = await k.fixture();
    const r = await cycle(f, "legacy");
    expect(r.sweeperWaitsOnHolder).toBe(true); // the wait edge sweeper -> holder, observed
    expect([r.states.pass, r.states.want].filter((s) => s === DEADLOCK)).toHaveLength(1);
  });
});
