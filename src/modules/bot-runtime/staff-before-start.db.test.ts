import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { claimNext } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { barrierKit } from "../bot-control/testing";
import { expireClaim, runtimeKit, triggerRow, type RuntimeFx } from "./testing";

// R7-F (Phase 08E-5; plan E.3 rule 1, I.1, I.4) on disposable PostgreSQL 17: a real staff action (Inbox assignment or STAFF
// submission) races a CLAIMED start trigger, the worker held between T0 and T1, in both transaction orders at the conversation
// row, with restart (a worker killed after its claim, the claim re-taken after the lease). Staff first: the start is superseded
// and nothing is created. T1 first: the staff writer waits for the conversation, commits a later control_seq, and the session's
// request never reaches the transport; the next step hands the session over. NOT EXECUTED by the author of this change: no
// isolated PostgreSQL server was configured.

type Action = "assign" | "submit";
const REASON: Record<Action, string> = { assign: "staff_assigned", submit: "staff_replied" };

describe("staff intervention racing a claimed trigger (R7-F)", () => {
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

  const act = (f: RuntimeFx, action: Action) => (action === "assign" ? k.assign(f) : k.submit(f));
  const sessions = (f: RuntimeFx) =>
    k.rows("select * from bot_sessions where conversation_id = $1", [f.w.student.conversation.id]);
  /** Worker restart: the claim is lost with the process, the lease expires, a new worker claims the trigger again. */
  async function crashAndReclaim(id: string) {
    await k.claimOf(id); // T0 of the worker that dies before T1
    await expireClaim(t, id);
    return k.claimOf(id);
  }

  for (const action of ["assign", "submit"] as const) {
    describe(action === "assign" ? "real Inbox assignment" : "real STAFF submission", () => {
      it("staff commits between T0 and T1: the start is superseded; no session, no request; a restart decides the same", async () => {
        const f = await k.fixture();
        const tr = await k.trigger(f, { first: true, observed: await k.controlSeq(f) });
        const claim = await k.claimOf(tr.id); // T0 committed; the worker is held before T1
        await act(f, action);
        expect(await k.runClaim(claim)).toMatchObject({
          kind: "finished",
          status: "IGNORED",
          outcome: "superseded_by_staff",
        });
        expect(await sessions(f)).toHaveLength(0);
        expect(await k.botRequests(f)).toHaveLength(0);
        // restart variant: a second fresh input after the staff action is staff_engaged (no resolution yet), also via restart
        const later = await k.trigger(f, { observed: await k.controlSeq(f) });
        expect(await k.runClaim(await crashAndReclaim(later.id))).toMatchObject({
          status: "IGNORED",
          outcome: "staff_engaged",
        });
        expect(await sessions(f)).toHaveLength(0);
        expect(await k.botRequests(f)).toHaveLength(0);
      });

      it("worker killed after T0, staff commits, the trigger is re-claimed after the lease: still superseded, never a session", async () => {
        const f = await k.fixture();
        const tr = await k.trigger(f, { first: true, observed: await k.controlSeq(f) });
        await k.claimOf(tr.id);
        await act(f, action);
        await expireClaim(t, tr.id);
        const again = await k.claimOf(tr.id);
        expect(again.attempts).toBe(2);
        expect(await k.runClaim(again)).toMatchObject({ outcome: "superseded_by_staff" });
        expect(await sessions(f)).toHaveLength(0);
        expect(await triggerRow(t, tr.id)).toMatchObject({ status: "IGNORED", claim_token: null });
      });

      for (const next of ["dispatcher", "runtime"] as const)
        it(`T1 holds the conversation first: staff waits, then commits a later control_seq; ${next} acts next: R never sent; the next step hands over (${REASON[action]})`, async () => {
          const f = await k.fixture();
          const tr = await k.trigger(f, { first: true, observed: await k.controlSeq(f) });
          const claim = await k.claimOf(tr.id);
          const p = k.pause();
          const t1 = kit.settle(k.runClaim(claim, { hooks: { beforeCommit: p.hook } }));
          const t1Pid = await p.reached; // the session and R are written, uncommitted, under K
          const staff = kit.settle<unknown>(act(f, action));
          const staffPid = await kit.waitUntilBlocked(t1Pid);
          expect(await kit.blockersOf(staffPid)).toEqual([t1Pid]);
          p.release();
          const [t1Result, staffResult] = await Promise.all([t1, staff]);
          expect(t1Result).toMatchObject({ ok: true, value: { outcome: "session_started" } });
          expect(staffResult.ok).toBe(true);
          const [s] = await sessions(f);
          const [r] = await k.botRequests(f);
          const staffSeq = await k.controlSeq(f);
          expect(staffSeq).toBeGreaterThan(Number(s!.started_control_seq)); // commit order = control order

          const transport = new FakeTransport();
          if (next === "dispatcher") {
            await claimNext(k.dispatchDeps(transport)); // a STAFF request it may claim is never executed here
            expect(await k.request(r!.id as string)).toMatchObject({
              state: "HELD",
              hold_reason: "staff_took_over",
            });
          }
          // the next student message, processed after a worker restart, hands the session over under the locks
          const reply = await k.trigger(f, { body: "hello?" });
          expect(await k.runClaim(await crashAndReclaim(reply.id))).toMatchObject({
            status: "IGNORED",
            outcome: "session_ended",
          });
          expect(await k.session(s!.id as string)).toMatchObject({
            state: "HANDED_OVER",
            end_reason: "system_handover",
            handover_reason: REASON[action],
            awaiting_token: null,
            terminal_notice_step_seq: null,
          });
          expect((await k.events(s!.id as string)).map((e) => e.code)).toEqual([REASON[action]]);
          expect(await k.request(r!.id as string)).toMatchObject({
            state: "HELD",
            hold_reason: next === "dispatcher" ? "staff_took_over" : "bot_output_suppressed",
          });
          if (next === "runtime") await claimNext(k.dispatchDeps(transport));
          expect(transport.calls).toHaveLength(0);
          expect(await k.botRequests(f)).toHaveLength(1);
          expect(await k.inFlight(s!.id as string)).toBe(0);
        });
    });
  }
});
