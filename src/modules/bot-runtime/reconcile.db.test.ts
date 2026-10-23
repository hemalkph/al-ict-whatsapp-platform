import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import type { DbExecutor } from "@/db/ops/executor";
import { claimNext, executeClaim } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { barrierKit, updateSession } from "../bot-control/testing";
import { BOTS_ON } from "../bot-control/testing";
import type { FlowCache } from "./flow-cache";
import { listCandidates, sweepOnce } from "./reconcile";
import {
  endFirstFlow,
  insertTrigger,
  messageFlow,
  runtimeKit,
  triggerRow,
  type RuntimeFx,
} from "./testing";
import { terminalizeTrigger } from "./trigger-queue";

// E-REC and E-MISS (Phase 08E-6; plan J.3, J.4, J.4a, J.5, J.5a) on disposable PostgreSQL 17: the reconciler's table row by row
// with REAL sessions (real T1), REAL request outcomes (the real dispatcher with a FakeTransport), exact time boundaries through
// the decision-clock seam, terminal-notice protection, reconciliation after terminalization, the flow_invalid hold, interruption
// and the sweep. NOT EXECUTED by the author of this change: no isolated PostgreSQL server was configured.

describe("the reconciler (E-REC, E-MISS)", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  let k: ReturnType<typeof runtimeKit>;
  const logs: string[] = [];

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

  const db = () => t.db as unknown as DbExecutor;
  const sessionOf = async (f: RuntimeFx) =>
    k.one(
      "select * from bot_sessions where conversation_id = $1 order by started_at desc limit 1",
      [f.w.student.conversation.id],
    );
  /** A PENDING trigger scheduled in the future, as a deferral leaves it. */
  const deferredTrigger = (f: RuntimeFx) => insertTrigger(t, k.ctxOf(f), { dueInMs: 60_000 });
  const handedOver = (reason: string) => ({
    state: "HANDED_OVER",
    end_reason: "system_handover",
    handover_reason: reason,
    awaiting: null,
    awaiting_token: null,
    terminal_notice_step_seq: null,
  });

  // ------------------------------------------------------------------------------------------------ candidates
  it("candidates: terminal, missing and stopped-deployment cases are listed; not-yet-due QUEUED/SENDING and terminal sessions are not", async () => {
    // The dispatcher claims the GLOBALLY earliest QUEUED request, so every world that needs a dispatcher step is built (and
    // dispatched) before any other world has a QUEUED request; dispatchWith/claim checks fail loudly on any other claim.
    // A: WAITING_FOR_SEND, request ACCEPTED                          -> listed (terminal request)
    const a = await k.fixture();
    const sa = (await k.acceptedPrompt(a)).session;
    // S: WAITING_FOR_SEND, request SENDING, send-wait not yet expired -> not listed
    const sw = await k.fixture();
    const ss = await k.startedPrompt(sw);
    expect((await claimNext(k.dispatchDeps(new FakeTransport()))).claim?.requestId).toBe(
      ss.request.id,
    );
    // M: WAITING_FOR_SEND at a step with no request (defect fixture)  -> listed (missing request)
    const m = await k.fixture();
    const sm = (await k.startedPrompt(m)).session;
    await updateSession(t.pool, sm.id as string, "step_seq = 2");
    // D: a live session of a STOPPED deployment (defect fixture)       -> listed (stopped deployment)
    const d = await k.fixture();
    const sd = (await k.startedPrompt(d)).session;
    await t.pool.query(
      "update bot_deployments set status = 'STOPPED', send_epoch = send_epoch + 1 where id = $1",
      [d.deployment.id],
    );
    // Q: WAITING_FOR_SEND, request QUEUED, deadline + 30 s not passed  -> not listed
    const q = await k.fixture();
    const sq = (await k.startedPrompt(q)).session;
    // T: COMPLETED with its QUEUED terminal notice                     -> not listed (terminal session)
    const done = await k.fixture(endFirstFlow("Bye"));
    const tr = await k.trigger(done, { first: true, body: "menu" });
    await k.run(tr.id);
    const st = await sessionOf(done);
    expect(st.state).toBe("COMPLETED");

    const ids = (await listCandidates(db())).map((c) => c.sessionId);
    expect(ids).toEqual([sa.id, sm.id, sd.id].map(String).sort());
    for (const excluded of [ss.session.id, sq.id, st.id]) expect(ids).not.toContain(excluded);
    // the listing maps each row to its own session's organization, conversation and deployment
    for (const c of await listCandidates(db())) {
      const row = await k.session(c.sessionId);
      expect(c).toEqual(k.candidateOf(row));
    }
  });

  // ------------------------------------------------------------------------------------------------ ACCEPTED
  it("ACCEPTED: send_result -> WAITING_FOR_INPUT with the decision-clock expiry; deferred triggers woken; no new request; idempotent", async () => {
    const f = await k.fixture();
    const { session, request } = await k.acceptedPrompt(f);
    const waiting = await deferredTrigger(f);
    const now = await k.shifted(0)(db() as never);
    const outcome = await k.reconcile(session, { readClock: k.at(now) });
    expect(outcome).toEqual({
      kind: "applied",
      action: "send_result_accepted",
      finalState: "WAITING_FOR_INPUT",
    });
    const s = await k.session(session.id as string);
    expect(s).toMatchObject({
      state: "WAITING_FOR_INPUT",
      awaiting_token: session.awaiting_token,
      revision: Number(session.revision) + 1,
    });
    expect((s.awaiting as { phase: string }).phase).toBe("SENT");
    expect((s.expires_at as Date).getTime()).toBeGreaterThan(now.getTime());
    expect(s.output_suppressed_at).toBeNull();
    expect(
      Number(
        (
          await k.one(
            "select extract(epoch from (next_attempt_at - clock_timestamp())) s from bot_triggers where id = $1",
            [waiting.id],
          )
        ).s,
      ),
    ).toBeLessThanOrEqual(0);
    expect((await triggerRow(t, waiting.id)).status).toBe("PENDING"); // woken, never finished or re-claimed
    expect((await k.botRequests(f)).map((r) => r.id)).toEqual([request.id]);
    expect(await k.events(session.id as string)).toEqual([]);
    // idempotent: no longer a candidate; a forced second pass changes nothing
    const after = await k.sessionJson(session.id as string);
    expect((await listCandidates(db())).map((c) => c.sessionId)).not.toContain(session.id);
    expect(await k.reconcile(session)).toEqual({ kind: "skipped", reason: "not_due" });
    expect(await k.sessionJson(session.id as string)).toEqual(after);
  });

  it("ACCEPTED applied once under concurrency: two reconcilers, exactly one transition", async () => {
    const f = await k.fixture();
    const { session } = await k.acceptedPrompt(f);
    const results = await Promise.all([k.reconcile(session), k.reconcile(session)]);
    expect(results.filter((r) => r.kind === "applied")).toHaveLength(1);
    expect(Number((await k.session(session.id as string)).revision)).toBe(
      Number(session.revision) + 1,
    );
  });

  it("ACCEPTED of a MESSAGE step continues the flow: the next send (an END notice) is enqueued once and the session completes", async () => {
    const f = await k.fixture(messageFlow());
    const tr = await k.trigger(f, { first: true, body: "menu" });
    await k.run(tr.id);
    const s0 = await sessionOf(f);
    expect(s0.state).toBe("WAITING_FOR_SEND");
    expect(
      (
        await k.dispatchWith(
          k.accepted("wamid.TEST08E6.MSG"),
          (await k.botRequests(f))[0]!.id as string,
        )
      ).outcome,
    ).toBe("accepted");
    expect(await k.reconcile(s0)).toMatchObject({ kind: "applied", finalState: "COMPLETED" });
    const s = await k.session(s0.id as string);
    expect(s).toMatchObject({ state: "COMPLETED", end_reason: "flow_end" });
    const reqs = await k.botRequests(f);
    expect(reqs).toHaveLength(2);
    // the authorized notice stays QUEUED and unheld (08E-6 P2; dispatch is covered in reconcile-notice.db.test.ts)
    expect(reqs[1]).toMatchObject({ state: "QUEUED", hold_reason: null });
    expect(s.output_suppressed_at).toBeNull();
    expect(Number(s.terminal_notice_step_seq)).toBe(Number(reqs[1]!.bot_step_seq));
    // the terminal notice is never touched again by the reconciler
    expect(await k.reconcile(s0)).toEqual({ kind: "skipped", reason: "not_live" });
    expect(await k.botRequests(f)).toHaveLength(2);
  });

  // ------------------------------------------------------------------------------------------------ HELD / REJECTED / UNKNOWN
  it("HELD (by the dispatcher, deadline_passed): HANDED_OVER send_held, event code = the hold code, suppressed, triggers ended, request untouched", async () => {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    const waiting = await deferredTrigger(f);
    const transport = new FakeTransport();
    expect(
      await claimNext(k.dispatchDeps(transport, { now: () => new Date(Date.now() + 200_000) })),
    ).toMatchObject({ claim: null, held: 1 });
    const held = await k.requestJson(request.id as string);
    expect(held).toMatchObject({ state: "HELD", hold_reason: "deadline_passed" });
    expect(await k.reconcile(session)).toMatchObject({
      kind: "applied",
      finalState: "HANDED_OVER",
    });
    const s = await k.session(session.id as string);
    expect(s).toMatchObject(handedOver("send_held"));
    expect(s.output_suppressed_at).toBeInstanceOf(Date);
    expect((await k.events(session.id as string)).map((e) => [e.kind, e.code])).toEqual([
      ["HANDED_OVER", "deadline_passed"],
    ]);
    expect(await k.requestJson(request.id as string)).toEqual(held);
    expect(await triggerRow(t, waiting.id)).toMatchObject({
      status: "IGNORED",
      outcome_code: "session_ended",
    });
    expect(transport.calls).toHaveLength(0);
  });

  for (const [name, result, outcome, reason] of [
    [
      "REJECTED",
      { kind: "rejected", reason: "test_rejected", httpStatus: 400, providerErrorCode: "131000" },
      "rejected",
      "send_rejected",
    ],
    [
      "UNKNOWN_OUTCOME",
      { kind: "unknown", reason: "timeout", httpStatus: null },
      "unknown",
      "send_outcome_unknown",
    ],
  ] as const)
    it(`${name}: HANDED_OVER ${reason}; the request is never retried, re-queued or replaced`, async () => {
      const f = await k.fixture();
      const { session, request } = await k.startedPrompt(f);
      const sent = await k.dispatchWith(result as never, request.id as string);
      expect(sent.outcome).toBe(outcome);
      const before = await k.requestJson(request.id as string);
      expect(await k.reconcile(session)).toMatchObject({
        kind: "applied",
        finalState: "HANDED_OVER",
      });
      expect(await k.session(session.id as string)).toMatchObject(handedOver(reason));
      expect((await k.events(session.id as string)).map((e) => e.code)).toEqual([reason]);
      expect(await k.requestJson(request.id as string)).toEqual(before);
      expect(await k.botRequests(f)).toHaveLength(1);
      expect((await claimNext(k.dispatchDeps(new FakeTransport()))).claim).toBeNull();
      expect(sent.transport.calls).toHaveLength(1);
    });

  // ------------------------------------------------------------------------------------------------ SENDING
  it("SENDING: not past send_wait_expires_at -> nothing (byte-identical); exactly at it -> nothing; 1 ms later -> HANDED_OVER send_outcome_unresolved, request untouched", async () => {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    const { claim } = await claimNext(k.dispatchDeps(new FakeTransport()));
    expect(claim?.requestId).toBe(request.id);
    const s0 = await k.sessionJson(session.id as string);
    const r0 = await k.requestJson(request.id as string);
    const expiry = new Date(session.send_wait_expires_at as Date);
    expect(await k.reconcile(session)).toEqual({ kind: "skipped", reason: "not_due" });
    expect(await k.reconcile(session, { readClock: k.at(expiry) })).toEqual({
      kind: "skipped",
      reason: "not_due",
    });
    expect(await k.sessionJson(session.id as string)).toEqual(s0);
    expect(await k.reconcile(session, { readClock: k.at(new Date(expiry.getTime() + 1)) })).toEqual(
      {
        kind: "applied",
        action: "send_outcome_unresolved",
        finalState: "HANDED_OVER",
      },
    );
    expect(await k.session(session.id as string)).toMatchObject(
      handedOver("send_outcome_unresolved"),
    );
    expect(await k.requestJson(request.id as string)).toEqual(r0); // SENDING untouched
    expect(await k.botRequests(f)).toHaveLength(1);
  });

  // ------------------------------------------------------------------------------------------------ QUEUED deadline
  it("QUEUED: exactly dispatch_deadline + 30 s -> nothing; 1 ms later -> HELD bot_send_deadline, then HANDED_OVER send_held (event bot_send_deadline)", async () => {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    const deadline = new Date(request.dispatch_deadline as Date).getTime();
    const s0 = await k.sessionJson(session.id as string);
    expect(await k.reconcile(session, { readClock: k.at(new Date(deadline + 30_000)) })).toEqual({
      kind: "skipped",
      reason: "not_due",
    });
    expect(await k.sessionJson(session.id as string)).toEqual(s0);
    expect((await k.request(request.id as string)).state).toBe("QUEUED");
    expect(
      await k.reconcile(session, { readClock: k.at(new Date(deadline + 30_001)) }),
    ).toMatchObject({ kind: "applied", finalState: "HANDED_OVER" });
    expect(await k.request(request.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "bot_send_deadline",
    });
    expect(await k.session(session.id as string)).toMatchObject(handedOver("send_held"));
    expect((await k.events(session.id as string)).map((e) => e.code)).toEqual([
      "bot_send_deadline",
    ]);
    expect(await k.inFlight(session.id as string)).toBe(0);
  });

  // ------------------------------------------------------------------------------------------------ missing request (E-MISS)
  it("E-MISS: WAITING_FOR_SEND with no request for its step -> FAILED/error, handover NULL, ERROR send_state_missing, operator log, no request created", async () => {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    // a defect fixture (a manual edit): the session points at a step that has no request
    const edited = await updateSession(t.pool, session.id as string, "step_seq = 2");
    expect((await listCandidates(db())).map((c) => c.sessionId)).toContain(session.id);
    expect(await k.reconcile(edited)).toEqual({
      kind: "applied",
      action: "send_state_missing",
      finalState: "FAILED",
    });
    const s = await k.session(session.id as string);
    expect(s).toMatchObject({
      state: "FAILED",
      end_reason: "error",
      handover_reason: null,
      awaiting: null,
      awaiting_token: null,
    });
    expect(s.output_suppressed_at).toBeInstanceOf(Date);
    expect((await k.events(session.id as string)).map((e) => [e.kind, e.code])).toEqual([
      ["ERROR", "send_state_missing"],
    ]);
    expect((await k.botRequests(f)).map((r) => r.id)).toEqual([request.id]); // none created
    expect(await k.request(request.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "bot_output_suppressed",
    });
    expect(
      logs.some((l) => l.includes("bots.send_state_missing") && l.includes(session.id as string)),
    ).toBe(true);
  });

  // ------------------------------------------------------------------------------------------------ idle expiry
  async function waitingForInput(f: RuntimeFx) {
    const { session, request } = await k.acceptedPrompt(f);
    await k.reconcile(session);
    return { session: await k.session(session.id as string), request };
  }

  it("idle expiry: 1 ms before expires_at -> nothing; exactly at it -> COMPLETED idle_timeout, silent, suppressed, no request", async () => {
    const f = await k.fixture();
    const { session } = await waitingForInput(f);
    const expiry = new Date(session.expires_at as Date).getTime();
    expect(await k.reconcile(session, { readClock: k.at(new Date(expiry - 1)) })).toEqual({
      kind: "skipped",
      reason: "not_due",
    });
    expect(await k.reconcile(session, { readClock: k.at(new Date(expiry)) })).toEqual({
      kind: "applied",
      action: "idle_expired",
      finalState: "COMPLETED",
    });
    const s = await k.session(session.id as string);
    expect(s).toMatchObject({
      state: "COMPLETED",
      end_reason: "idle_timeout",
      handover_reason: null,
      terminal_notice_step_seq: null,
    });
    expect(s.output_suppressed_at).toBeInstanceOf(Date);
    expect(await k.events(session.id as string)).toEqual([]);
    expect(await k.botRequests(f)).toHaveLength(1);
  });

  it("idle expiry with the prompt's delivery FAILED -> HANDED_OVER delivery_failed, silent", async () => {
    const f = await k.fixture();
    const { session, request } = await waitingForInput(f);
    await t.pool.query("update messages set latest_status = 'FAILED' where id = $1", [
      request.message_id,
    ]);
    const expiry = new Date(session.expires_at as Date);
    expect(await k.reconcile(session, { readClock: k.at(expiry) })).toMatchObject({
      finalState: "HANDED_OVER",
    });
    expect(await k.session(session.id as string)).toMatchObject(handedOver("delivery_failed"));
    expect((await k.events(session.id as string)).map((e) => e.code)).toEqual(["delivery_failed"]);
    expect(await k.botRequests(f)).toHaveLength(1);
  });

  // ------------------------------------------------------------------------------------------------ stopped deployment
  it("a live session of a STOPPED deployment (defect fixture) is handed over deployment_stopped (I.3 invariant)", async () => {
    const f = await k.fixture();
    const { session } = await waitingForInput(f);
    await t.pool.query(
      "update bot_deployments set status = 'STOPPED', send_epoch = send_epoch + 1 where id = $1",
      [f.deployment.id],
    );
    expect((await listCandidates(db())).map((c) => c.sessionId)).toContain(session.id);
    expect(await k.reconcile(session)).toMatchObject({
      action: "deployment_stopped",
      finalState: "HANDED_OVER",
    });
    expect(await k.session(session.id as string)).toMatchObject(handedOver("deployment_stopped"));
  });

  // ------------------------------------------------------------------------------------------------ guards
  it("terminal sessions and their notices are never touched: not candidates; a forced pass is not_live; notice QUEUED/SENDING/HELD byte-identical", async () => {
    const f = await k.fixture(endFirstFlow("Bye"));
    const tr = await k.trigger(f, { first: true, body: "menu" });
    await k.run(tr.id);
    const s = await sessionOf(f);
    const [notice] = await k.botRequests(f);
    expect(Number(s.terminal_notice_step_seq)).toBe(Number(notice!.bot_step_seq));
    const s0 = await k.sessionJson(s.id as string);
    for (const stage of ["QUEUED", "SENDING"] as const) {
      if (stage === "SENDING") await claimNext(k.dispatchDeps(new FakeTransport()));
      const r0 = await k.requestJson(notice!.id as string);
      expect((r0 as { state: string }).state).toBe(stage);
      expect(await k.reconcile(s)).toEqual({ kind: "skipped", reason: "not_live" });
      await sweepOnce(db(), k.deps());
      expect(await k.requestJson(notice!.id as string)).toEqual(r0);
      expect(await k.sessionJson(s.id as string)).toEqual(s0);
      expect(await k.botRequests(f)).toHaveLength(1);
    }
  });

  it("gates off: nothing is read or written; a busy conversation is skipped at once and retried later", async () => {
    const f = await k.fixture();
    const { session } = await k.acceptedPrompt(f);
    const s0 = await k.sessionJson(session.id as string);
    expect(
      await k.reconcile(session, { config: { ...BOTS_ON, botsRuntimeEnabled: false } }),
    ).toEqual({ kind: "gates_off" });
    expect(
      await sweepOnce(db(), k.deps({ config: { ...BOTS_ON, outboundEnabled: false } })),
    ).toMatchObject({ reconciled: 0 });
    const busy = await kit.hold("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `bot-conv:${f.w.org.id}:${f.w.student.conversation.id}`,
    ]);
    const skipped = k.reconcile(session);
    expect(await kit.within(skipped, 5_000)).toBe(true);
    expect(await skipped).toEqual({ kind: "skipped", reason: "conversation_busy" });
    expect(await k.sessionJson(session.id as string)).toEqual(s0);
    await busy.release();
    expect(await k.reconcile(session)).toMatchObject({ kind: "applied" });
  });

  it("tenant isolation: another organization's identifiers reach nothing", async () => {
    const f = await k.fixture();
    const g = await k.fixture();
    const { session } = await k.acceptedPrompt(f);
    const s0 = await k.sessionJson(session.id as string);
    await expect(k.reconcile({ ...session, organization_id: g.w.org.id })).rejects.toThrow();
    expect(await k.sessionJson(session.id as string)).toEqual(s0);
  });

  // ------------------------------------------------------------------------------------------------ after terminalization
  it("reconciliation after terminalization (08E-5 condition): the handed-over session is unchanged, R keeps its identity, no new request; idempotent", async () => {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    const exhausted = await insertTrigger(t, k.ctxOf(f), { attempts: 6 });
    expect(
      await terminalizeTrigger(t.db, {
        organizationId: f.w.org.id,
        id: exhausted.id,
        conversationId: f.w.student.conversation.id,
      }),
    ).toMatchObject({ kind: "dead", handedOverSessionId: session.id });
    const s0 = await k.sessionJson(session.id as string);
    const r0 = await k.requestJson(request.id as string);
    expect(r0).toMatchObject({
      id: request.id,
      state: "HELD",
      hold_reason: "bot_output_suppressed",
    });
    for (let i = 0; i < 2; i++) {
      expect((await listCandidates(db())).map((c) => c.sessionId)).not.toContain(session.id);
      expect(await k.reconcile(session)).toEqual({ kind: "skipped", reason: "not_live" });
      expect(await sweepOnce(db(), k.deps())).toMatchObject({ reconciled: 0 });
      expect(await k.sessionJson(session.id as string)).toEqual(s0);
      expect(await k.requestJson(request.id as string)).toEqual(r0);
      expect(await k.botRequests(f)).toHaveLength(1);
    }
  });

  // ------------------------------------------------------------------------------------------------ flow_invalid hold
  describe("flow_invalid hand-over holds the session's QUEUED request (08E-5 review condition)", () => {
    const missing = {
      load: async () => ({ ok: false, reason: "missing" }),
    } as unknown as FlowCache;

    it("unlocked QUEUED: T1 holds it bot_output_suppressed in the same transaction; nothing to claim; 0 calls", async () => {
      const f = await k.fixture();
      const { session, request } = await k.startedPrompt(f);
      const tr = await k.trigger(f, { body: "hello" });
      expect(await k.run(tr.id, { flows: missing })).toMatchObject({
        status: "PROCESSED",
        outcome: "flow_invalid",
      });
      expect(await k.request(request.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_output_suppressed",
      });
      expect(await k.session(session.id as string)).toMatchObject(handedOver("bot_error"));
      const transport = new FakeTransport();
      expect((await claimNext(k.dispatchDeps(transport))).claim).toBeNull();
      expect(transport.calls).toHaveLength(0);
    });

    it("QUEUED locked by a claim-form row lock: T1 skips it without waiting; the real claim then refuses it; 0 calls", async () => {
      const f = await k.fixture();
      const { request } = await k.startedPrompt(f);
      // the dispatcher claim's exact lock on R (FOR UPDATE), held open: an account barrier would also block T1's account FOR SHARE
      const holder = await kit.hold("select id from outbound_requests where id = $1 for update", [
        request.id,
      ]);
      const tr = await k.trigger(f, { body: "hello" });
      const run = k.run(tr.id, { flows: missing });
      expect(await kit.within(run, 5_000)).toBe(true);
      expect(await run).toMatchObject({ outcome: "flow_invalid" });
      expect((await k.request(request.id as string)).state).toBe("QUEUED");
      await holder.abort();
      const transport = new FakeTransport();
      expect(await claimNext(k.dispatchDeps(transport))).toMatchObject({ claim: null, held: 1 });
      expect(await k.request(request.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_output_suppressed",
      });
      expect(transport.calls).toHaveLength(0);
    });

    it("already SENDING: T1 leaves it untouched; final authorization refuses it; 0 calls", async () => {
      const f = await k.fixture();
      const { request } = await k.startedPrompt(f);
      const transport = new FakeTransport();
      const { claim } = await claimNext(k.dispatchDeps(transport));
      const r0 = await k.requestJson(request.id as string);
      const tr = await k.trigger(f, { body: "hello" });
      expect(await k.run(tr.id, { flows: missing })).toMatchObject({ outcome: "flow_invalid" });
      expect(await k.requestJson(request.id as string)).toEqual(r0);
      expect(await executeClaim(k.dispatchDeps(transport), claim!)).toBe("held");
      expect(await k.request(request.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_output_suppressed",
      });
      expect(transport.calls).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------------------ interruption and sweep
  it("an interrupted reconciliation (backend terminated under its locks) commits nothing; the next pass applies it once", async () => {
    const f = await k.fixture();
    const { session, request } = await k.acceptedPrompt(f);
    const s0 = await k.sessionJson(session.id as string);
    const r0 = await k.requestJson(request.id as string);
    const interrupted = await k.interruptedReconcile(session);
    expect(interrupted.result.ok).toBe(false); // the terminated transaction failed ...
    expect(interrupted.locksReleased).toBe(true); // ... and released the conversation row and advisory locks
    expect(await k.sessionJson(session.id as string)).toEqual(s0); // nothing committed
    expect(await k.events(session.id as string)).toEqual([]);
    expect(await k.requestJson(r0.id as string)).toEqual(r0);
    // recovery on a healthy connection applies the authoritative result exactly once; repeating it changes nothing
    expect(await k.reconcile(session)).toMatchObject({
      kind: "applied",
      finalState: "WAITING_FOR_INPUT",
    });
    const settled = await k.sessionJson(session.id as string);
    expect(Number(settled.revision)).toBe(Number(s0.revision) + 1);
    expect(await k.reconcile(session)).toEqual({ kind: "skipped", reason: "not_due" });
    expect(await k.sessionJson(session.id as string)).toEqual(settled);
    expect((await k.botRequests(f)).map((r) => r.id)).toEqual([r0.id]); // no duplicate request
  });

  it("sweepOnce: terminalization, then every candidate, then the audit; a second sweep finds nothing to do", async () => {
    const a = await k.fixture();
    const sa = (await k.acceptedPrompt(a)).session;
    const b = await k.fixture();
    const sb = await k.startedPrompt(b);
    await claimNext(
      k.dispatchDeps(new FakeTransport(), { now: () => new Date(Date.now() + 200_000) }),
    ); // HELD deadline_passed
    const c = await k.fixture();
    const exhausted = await insertTrigger(t, k.ctxOf(c), { attempts: 6 });
    expect(await sweepOnce(db(), k.deps())).toEqual({
      terminalized: 1,
      reconciled: 2,
      skipped: 0,
      failed: 0,
      overdueConversations: 0,
    });
    expect((await k.session(sa.id as string)).state).toBe("WAITING_FOR_INPUT");
    expect((await k.session(sb.session.id as string)).state).toBe("HANDED_OVER");
    expect((await triggerRow(t, exhausted.id)).status).toBe("DEAD");
    expect(await sweepOnce(db(), k.deps())).toEqual({
      terminalized: 0,
      reconciled: 0,
      skipped: 0,
      failed: 0,
      overdueConversations: 0,
    });
  });
});
