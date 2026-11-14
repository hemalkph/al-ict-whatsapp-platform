import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { lostCommitAck } from "@/db/__tests__/lost-commit-ack";
import { pausingDatabase } from "@/db/__tests__/pausing-database";
import type { DbExecutor } from "@/db/ops/executor";
import { claimNext, dispatchBatch, executeClaim } from "@/modules/messaging/dispatch";
import { SENDING_RECOVERY_AFTER_MS } from "@/modules/messaging/policy";
import { FakeTransport } from "@/modules/messaging/testing";
import { stopActiveSessions } from "../bot-control";
import { barrierKit, BOTS_ON, settledState } from "../bot-control/testing";
import type { StepSummary } from "./context";
import { processTrigger } from "./step";
import {
  deferred,
  endFirstFlow,
  makeDue,
  messageFlow,
  runtimeKit,
  triggerRow,
  type RuntimeFx,
} from "./testing";
import { claimTriggers } from "./trigger-queue";

// R8 F, G, H and J (Phase 08E-9 Batch 3; V3.2 O.10 R8 L937-953, "R8 (all cases end to end)" in the 08E exit L1048; plan N.2 R8)
// on disposable PostgreSQL 17. EVERY notice here is created by the real bot runtime, never inserted by hand:
//   - reconciledNotice(): real T1 starts a MESSAGE -> END flow; the real dispatcher accepts the MESSAGE; the real reconciler
//     applies the acceptance and, in the same transaction, ends the session COMPLETED with the END notice queued and authorized
//     (terminal_notice_step_seq);
//   - endFirstFlow: real T1 starts a session whose first node is an END with a message (R8-I), in one commit.
// The dispatcher is the real claim / final authorization / record with a FakeTransport only. Suspension is BOTS_RUNTIME_ENABLED
// off in a process (R6's pattern): the outbound worker claims no BOT row and the bot runtime does nothing. Elapsed time is the
// dispatcher's own `now` option; nothing is written to a request, session or deadline by hand.

const OFF = { ...BOTS_ON, botsRuntimeEnabled: false };
const CLAIM_BOT_RULE = /^SELECT bot_request_hold_code\(\$1, \$2\) AS code$/;

describe("R8: runtime-created terminal notices end to end (F, G, H, J)", () => {
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

  // ------------------------------------------------------------------------------------------------ helpers

  type Notice = Awaited<ReturnType<typeof reconciledNotice>>;
  /** MESSAGE (real T1) -> ACCEPTED by the real dispatcher -> reconciled once: COMPLETED with the END notice QUEUED. */
  async function reconciledNotice() {
    const f = await k.fixture(messageFlow());
    const tr = await k.trigger(f, { first: true, body: "menu" });
    expect(await k.run(tr.id)).toMatchObject({ outcome: "session_started" });
    const [message] = await k.botRequests(f);
    expect(
      (
        await k.dispatchWith(
          k.accepted(`wamid.TEST08E9R8.MSG.${f.w.org.id}`),
          message!.id as string,
        )
      ).outcome,
    ).toBe("accepted");
    const s = (await sessionsOf(f))[0]!;
    expect(await k.reconcile(s)).toMatchObject({ kind: "applied", finalState: "COMPLETED" });
    const session = await k.session(s.id as string);
    const requests = await k.botRequests(f);
    expect(requests).toHaveLength(2);
    const notice = requests[1]!;
    // created by the runtime: QUEUED, unheld, authorized by the terminal session, output not suppressed
    expect(notice).toMatchObject({ state: "QUEUED", hold_reason: null, bot_session_id: s.id });
    expect(session).toMatchObject({ state: "COMPLETED", end_reason: "flow_end" });
    expect(Number(session.terminal_notice_step_seq)).toBe(Number(notice.bot_step_seq));
    expect(session.output_suppressed_at).toBeNull();
    return {
      f,
      s,
      notice,
      deadline: new Date(notice.dispatch_deadline as Date).getTime(),
      sessionJson: await k.sessionJson(s.id as string),
    };
  }
  const sessionsOf = (f: RuntimeFx) =>
    k.rows("select * from bot_sessions where conversation_id = $1 order by started_control_seq", [
      f.w.student.conversation.id,
    ]);
  /** Suspended: the dispatcher claims no BOT row and the bot runtime does nothing. */
  async function suspended(x: Notice) {
    const transport = new FakeTransport();
    expect((await claimNext(k.dispatchDeps(transport, { config: OFF }))).claim).toBeNull();
    expect(await k.reconcile(x.s, { config: OFF })).toEqual({ kind: "gates_off" });
    expect(transport.calls).toHaveLength(0);
    expect(await k.request(x.notice.id as string)).toMatchObject({ state: "QUEUED" });
  }
  /** Nothing about the terminal session ever changes, nothing new is queued, and nothing is claimable any more. */
  async function settledForever(x: Notice) {
    expect(await k.sessionJson(x.s.id as string)).toEqual(x.sessionJson);
    for (let i = 0; i < 2; i++)
      expect(await k.reconcile(x.s)).toEqual({ kind: "skipped", reason: "not_live" });
    expect(await k.sessionJson(x.s.id as string)).toEqual(x.sessionJson);
    expect(await k.botRequests(x.f)).toHaveLength(2); // the MESSAGE and the one notice: never recreated
    const again = new FakeTransport();
    expect((await claimNext(k.dispatchDeps(again))).claim).toBeNull();
    expect(again.calls).toHaveLength(0);
  }
  const wamidOf = async (messageId: unknown) =>
    (await k.one("select wamid from messages where id = $1", [messageId])).wamid as string | null;
  const probe = (text: string, id: string) =>
    t.pool.query(text, [id]).then(
      () => "free",
      (e: { code?: string }) => e.code ?? "error",
    );
  function finished(summary: StepSummary, status: "PROCESSED" | "IGNORED", outcome: string) {
    expect(summary).toMatchObject({ kind: "finished", status, outcome });
  }

  // ===================================================================================== F: suspended, resumed in time

  describe("F: dispatch suspended, resumed within the deadline", () => {
    it("re-enabled at about 60 s: the notice is re-authorized at claim and final read and sent once; ACCEPTED with its wamid; never recreated", async () => {
      const x = await reconciledNotice();
      await suspended(x);
      const wamid = "wamid.TEST08E9R8.F";
      const sent = await k.dispatchWith(k.accepted(wamid), x.notice.id as string, {
        now: () => new Date(x.deadline - 60_000),
      });
      expect(sent.outcome).toBe("accepted");
      expect(sent.transport.calls).toHaveLength(1);
      expect(await k.request(x.notice.id as string)).toMatchObject({
        state: "ACCEPTED",
        hold_reason: null,
      });
      expect(await wamidOf(x.notice.message_id)).toBe(wamid);
      await settledForever(x);
    });

    it("a staff assignment during the suspension: on re-enabling the claim holds the notice staff_took_over; 0 calls", async () => {
      const x = await reconciledNotice();
      await suspended(x);
      expect((await k.assign(x.f)).changed).toBe(true);
      const transport = new FakeTransport();
      expect(
        await claimNext(k.dispatchDeps(transport, { now: () => new Date(x.deadline - 60_000) })),
      ).toMatchObject({ claim: null, held: 1 });
      expect(await k.request(x.notice.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "staff_took_over",
        send_started_at: null,
      });
      expect(transport.calls).toHaveLength(0);
      expect(await wamidOf(x.notice.message_id)).toBeNull();
      await settledForever(x);
    });

    it("Stop during the suspension (no live session): Stop itself holds the terminal session's notice bot_stopped; re-enabling claims nothing; 0 calls", async () => {
      const x = await reconciledNotice();
      await suspended(x);
      const stopped = await stopActiveSessions(
        x.f.w.admin.ctx,
        { deploymentId: x.f.deployment.id, expectedLiveSessions: 0 },
        { db: t.db },
      );
      expect(stopped.value).toMatchObject({ sessionsStopped: 0, requestsSuppressed: 1 });
      expect(await k.request(x.notice.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_stopped",
      });
      const transport = new FakeTransport();
      expect(
        (await claimNext(k.dispatchDeps(transport, { now: () => new Date(x.deadline - 60_000) })))
          .claim,
      ).toBeNull();
      expect(transport.calls).toHaveLength(0);
      await settledForever(x);
    });
  });

  // ===================================================================================== G: resumed after the deadline

  it("G: re-enabled after the 120 s deadline: the claim holds the notice deadline_passed; 0 calls; the session stays terminal and unchanged; never recreated", async () => {
    const x = await reconciledNotice();
    await suspended(x);
    const transport = new FakeTransport();
    expect(
      await claimNext(k.dispatchDeps(transport, { now: () => new Date(x.deadline + 10_000) })),
    ).toMatchObject({ claim: null, held: 1 });
    expect(await k.request(x.notice.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "deadline_passed",
      send_started_at: null,
    });
    expect(transport.calls).toHaveLength(0);
    await settledForever(x);
  });

  // ===================================================================================== H: UNKNOWN_OUTCOME

  describe("H: the notice's outcome is unknown", () => {
    it("the transport throws during the attempt: UNKNOWN_OUTCOME transport_threw, recorded through the fence; exactly 1 call; never re-queued or recreated", async () => {
      const x = await reconciledNotice();
      const sent = await k.dispatchWith(new Error("socket hang up"), x.notice.id as string);
      expect(sent.outcome).toBe("unknown");
      expect(sent.transport.calls).toHaveLength(1);
      expect(await k.request(x.notice.id as string)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "transport_threw",
      });
      expect(await wamidOf(x.notice.message_id)).toBeNull();
      await settledForever(x);
    });

    it("the dispatcher dies after the final authorization: recovery makes it UNKNOWN_OUTCOME; the late answer is fenced out; exactly 1 call (the accepted window); never re-queued or recreated", async () => {
      const x = await reconciledNotice();
      const inHttp = deferred();
      const go = deferred();
      const transport = new FakeTransport().next(async () => {
        inHttp.resolve();
        await go.promise;
        return k.accepted("wamid.TEST08E9R8.H.late");
      });
      const { claim } = await claimNext(k.dispatchDeps(transport));
      expect(claim?.requestId).toBe(x.notice.id);
      const first = kit.settle(executeClaim(k.dispatchDeps(transport), claim!));
      try {
        await inHttp.promise; // the final authorization passed and the HTTP attempt began
        expect(await k.request(x.notice.id as string)).toMatchObject({ state: "SENDING" });
        const later = await dispatchBatch(
          k.dispatchDeps(new FakeTransport(), {
            now: () => new Date(Date.now() + SENDING_RECOVERY_AFTER_MS + 60_000),
          }),
        );
        expect(later).toMatchObject({ recoveredUnknown: 1, claimed: 0 });
      } finally {
        go.resolve();
      }
      expect(await first).toMatchObject({ ok: true, value: "fence_lost" }); // the late result cannot overwrite
      expect(await k.request(x.notice.id as string)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "process_died_after_dispatch_start",
      });
      expect(await wamidOf(x.notice.message_id)).toBeNull();
      expect(transport.calls).toHaveLength(1);
      await settledForever(x);
    });
  });

  // ===================================================================================== J: concurrency

  describe("J: concurrent terminal transition and dispatcher", () => {
    it("J1: while the step that creates the notice is uncommitted, the dispatcher sees and claims nothing; after COMMIT the notice and its authorization appear together and it is sent once", async () => {
      const f = await k.fixture(endFirstFlow("Bye"));
      const tr = await k.trigger(f, { first: true, body: "menu" });
      const p = k.pause();
      const step = kit.settle(k.run(tr.id, { hooks: { beforeCommit: p.hook } }));
      const pid = await p.reached;
      expect((await k.one("select state from pg_stat_activity where pid = $1", [pid])).state).toBe(
        "idle in transaction",
      );
      // the dispatcher polls while the step is open: nothing is visible, nothing is claimed
      const early = new FakeTransport();
      expect(await claimNext(k.dispatchDeps(early))).toEqual({ claim: null, held: 0 });
      expect(early.calls).toHaveLength(0);
      expect(await sessionsOf(f)).toEqual([]);
      expect(await k.botRequests(f)).toEqual([]);
      p.release();
      const done = await step;
      expect(settledState(done)).toBeNull();
      expect(done).toMatchObject({ ok: true, value: { outcome: "session_started" } });
      // now both exist together: the terminal session with its authorization, and the notice
      const [s] = await sessionsOf(f);
      const [notice, ...more] = await k.botRequests(f);
      expect(more).toEqual([]);
      expect(s).toMatchObject({ state: "COMPLETED", end_reason: "flow_end" });
      expect(Number(s!.terminal_notice_step_seq)).toBe(Number(notice!.bot_step_seq));
      expect(notice).toMatchObject({ state: "QUEUED", bot_session_id: s!.id });
      const sent = await k.dispatchWith(k.accepted("wamid.TEST08E9R8.J1"), notice!.id as string);
      expect(sent.outcome).toBe("accepted");
      expect(sent.transport.calls).toHaveLength(1);
    });

    it("J2: dispatcher A is parked holding the notice (before its bot-rule read); dispatcher B skips the locked row without waiting and claims nothing; A then claims and sends it; exactly one claim and one call", async () => {
      const x = await reconciledNotice();
      const p = pausingDatabase(t);
      const transportA = new FakeTransport().next(k.accepted("wamid.TEST08E9R8.J2"));
      const transportB = new FakeTransport();
      let claimA = null as Awaited<ReturnType<typeof claimNext>>["claim"];
      try {
        const pause = p.arm(CLAIM_BOT_RULE);
        const a = kit.settle(claimNext(k.dispatchDeps(transportA, { db: p.db as never })));
        const at = await p.reachedBefore(pause, a);
        expect(
          (await k.one("select state from pg_stat_activity where pid = $1", [at.pid])).state,
        ).toBe("idle in transaction");
        expect(
          await probe(
            "select 1 from outbound_requests where id = $1 for update nowait",
            x.notice.id as string,
          ),
        ).toBe("55P03"); // A holds the notice's row
        // B runs the real claim on the ordinary pool: it skips the locked row, waits for nothing, claims nothing
        const b = kit.settle(claimNext(k.dispatchDeps(transportB)));
        expect(await kit.within(b, 5_000), "dispatcher B waited for A's row").toBe(true);
        expect(await b).toMatchObject({ ok: true, value: { claim: null, held: 0 } });
        expect(await k.request(x.notice.id as string)).toMatchObject({
          state: "QUEUED",
          claimed_by: null,
        });
        pause.release();
        const ra = await a;
        expect(ra).toMatchObject({ ok: true });
        claimA = ra.ok ? ra.value.claim : null;
        expect(claimA?.requestId).toBe(x.notice.id);
        expect(pause.fired).toBe(1);
      } finally {
        await p.close();
      }
      expect(await executeClaim(k.dispatchDeps(transportA), claimA!)).toBe("accepted");
      expect(transportA.calls).toHaveLength(1);
      expect(transportB.calls).toHaveLength(0);
      expect(await k.request(x.notice.id as string)).toMatchObject({
        state: "ACCEPTED",
        attempt_count: 1,
      });
      expect(await wamidOf(x.notice.message_id)).toBe("wamid.TEST08E9R8.J2");
      await settledForever(x);
    });

    it("J3: the step that creates the notice commits but its acknowledgement is lost: the fenced failure record cannot overwrite it; the replayed claim finds nothing; exactly one notice, sent once", async () => {
      const f = await k.fixture(endFirstFlow("Bye"));
      const tr = await k.trigger(f, { first: true, body: "menu" });
      const lost = lostCommitAck(t);
      let claim: Awaited<ReturnType<typeof claimTriggers>>[number] | undefined;
      let summary: StepSummary;
      try {
        claim = (await claimTriggers(lost.db as unknown as DbExecutor, 50)).find(
          (c) => c.id === tr.id,
        );
        expect(claim).toBeDefined();
        lost.arm(async () => {
          // an independent connection proves the server committed the step before the injected loss
          expect(await sessionsOf(f)).toHaveLength(1);
          expect(await k.botRequests(f)).toHaveLength(1);
        });
        summary = await processTrigger(lost.db as unknown as DbExecutor, claim!, k.deps());
        expect(lost.injected).toBe(1);
      } finally {
        await lost.close();
      }
      expect(summary).toMatchObject({ kind: "failed", recorded: false });
      expect(await triggerRow(t, tr.id)).toMatchObject({
        status: "PROCESSED",
        outcome_code: "session_started",
        attempts: 1,
        claim_token: null,
        last_error_code: null,
      });
      // the same claim replayed (a retry after the lost acknowledgement) is fenced out and creates nothing
      expect(await processTrigger(t.db as unknown as DbExecutor, claim!, k.deps())).toEqual({
        kind: "lost_claim",
      });
      expect(
        (await claimTriggers(t.db as unknown as DbExecutor, 50)).map((c) => c.id),
      ).not.toContain(tr.id);
      const [s] = await sessionsOf(f);
      const [notice, ...more] = await k.botRequests(f);
      expect(more).toEqual([]);
      expect(Number(s!.terminal_notice_step_seq)).toBe(Number(notice!.bot_step_seq));
      const sent = await k.dispatchWith(k.accepted("wamid.TEST08E9R8.J3"), notice!.id as string);
      expect(sent.transport.calls).toHaveLength(1);
      const again = new FakeTransport();
      expect((await claimNext(k.dispatchDeps(again))).claim).toBeNull();
      expect(again.calls).toHaveLength(0);
    });

    it("J4: a new start while the notice is in flight is deferred (refund, no counter charge); once the notice is ACCEPTED and H.2 passes, it starts a new session; no notice is duplicated", async () => {
      const f = await k.fixture(endFirstFlow("Bye"));
      finished(
        await k.run((await k.trigger(f, { first: true, body: "menu" })).id),
        "PROCESSED",
        "session_started",
      );
      const [first] = await sessionsOf(f);
      const [notice] = await k.botRequests(f);
      expect(notice).toMatchObject({ state: "QUEUED", bot_session_id: first!.id });

      const next = await k.trigger(f, { body: "menu" });
      expect(await k.run(next.id)).toMatchObject({
        kind: "deferred",
        reason: "bot_request_in_flight",
      });
      expect(await triggerRow(t, next.id)).toMatchObject({
        status: "PENDING",
        attempts: 0,
        deferrals: 1,
        claim_token: null,
      });
      await makeDue(t, next.id);
      expect(await k.run(next.id)).toMatchObject({
        kind: "deferred",
        reason: "bot_request_in_flight",
      });
      expect(await triggerRow(t, next.id)).toMatchObject({ attempts: 0, deferrals: 2 });
      expect(await sessionsOf(f)).toHaveLength(1);

      const sent = await k.dispatchWith(k.accepted("wamid.TEST08E9R8.J4"), notice!.id as string);
      expect(sent.outcome).toBe("accepted");
      // H.2 also requires the 30-minute cooldown after the first session's end. LOGICAL CLOCK (plan N.2a): the trigger's input
      // time and the decision clock advance together past it; control sequences and database-stamped times stay real
      const SHIFT = 31 * 60_000;
      await k.q(
        "update bot_triggers set input_occurred_at = input_occurred_at + $2 * interval '1 millisecond' where id = $1 and status = 'PENDING'",
        [next.id, SHIFT],
      );
      await makeDue(t, next.id);
      finished(
        await k.run(next.id, { readClock: k.shifted(SHIFT) }),
        "PROCESSED",
        "session_started",
      );
      const sessions = await sessionsOf(f);
      expect(sessions).toHaveLength(2);
      expect(Number(sessions[1]!.started_control_seq)).toBeGreaterThan(
        Number(first!.started_control_seq),
      );
      expect(sessions[1]).toMatchObject({ started_by_message_id: next.messageId });
      expect(await triggerRow(t, next.id)).toMatchObject({ attempts: 1, deferrals: 2 });
      // one notice per session: the first one ACCEPTED (sent once), the new session's own one QUEUED
      const requests = await k.botRequests(f);
      expect(requests.map((r) => [r.bot_session_id, r.state]).sort()).toEqual(
        [
          [first!.id, "ACCEPTED"],
          [sessions[1]!.id, "QUEUED"],
        ].sort(),
      );
      expect(sent.transport.calls).toHaveLength(1);
    });
  });
});
