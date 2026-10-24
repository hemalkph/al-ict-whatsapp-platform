import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { claimNext, executeClaim } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { barrierKit, settledState } from "../bot-control/testing";
import { deferred, messageFlow, runtimeKit, terminationWatch, type RuntimeFx } from "./testing";

// Phase 08E-8D1 on disposable PostgreSQL 17 (READ COMMITTED), real T1 / reconciler / dispatcher, FakeTransport only.
//   Part 1 STAFF submission versus the bot step T1 at the conversation row (plan I.4, K.1, K.2): staff-first, bot-first, a staff
//     rollback, and concurrent submissions. Order is proved by lock ownership (pg_blocking_pids), never by sleeping.
//   Part 2 direct MESSAGE follow-ups after staff intervention: the reconciler applies a MESSAGE whose request was ACCEPTED; a
//     staff event after the session started decides the session's fate first (J.2 rules 4-6: HANDED_OVER staff_* or COMPLETED
//     conversation_resolved), whether the flow would send next, end with a notice or end silently, so no BOT request is
//     created and no later handover barrier is invented. The actual contracts are pinned here (see the per-case comments).
// The deterministic B4 for submission (claim parked between its bot-rule read and the staff commit) needs a dispatcher test hook
// and stays unproven here: docs/TESTING_STRATEGY.md and review-conditions.db.test.ts.

const DEADLOCK = "40P01";
type Action = "assign" | "submit" | "resolve";

describe("staff intervention versus the bot runtime (08E-8D1)", () => {
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

  const noDeadlock = (...results: Array<{ ok: boolean; error?: unknown }>) =>
    expect(results.map((r) => settledState(r))).not.toContain(DEADLOCK);
  const staffRequests = (f: RuntimeFx) =>
    k.rows(
      "select r.*, m.body, m.direction from outbound_requests r join messages m on m.id = r.message_id where r.conversation_id = $1 and r.origin = 'STAFF' order by r.control_seq",
      [f.w.student.conversation.id],
    );
  /** A blocked backend waits in a statement on the conversation row, never on an outbound request row. */
  const waitsOnConversationOnly = async (pid: number) => {
    const q = String(
      (await k.one("select query from pg_stat_activity where pid = $1", [pid])).query,
    );
    expect(q).toMatch(/conversations/i);
    expect(q).not.toMatch(/outbound_requests/i);
  };
  const accountGate = (f: RuntimeFx) =>
    kit.hold("select id from whatsapp_accounts where id = $1 for update", [f.w.account.id]);
  const messageExists = async (id: string) =>
    Number((await k.one("select count(*)::int n from messages where id = $1", [id])).n) === 1;

  // ================================================================================== Part 1: STAFF submission x T1
  describe("STAFF submission and the bot step serialize at the conversation row", () => {
    /** S WAITING_FOR_SEND with R QUEUED (real T1). */
    async function queuedWorld() {
      const f = await k.fixture();
      const { session, request } = await k.startedPrompt(f);
      return { f, s: session, r: request };
    }
    /** S WAITING_FOR_SEND whose prompt was ACCEPTED, and a reply trigger whose T1 enqueues R2. */
    async function repliedWorld() {
      const f = await k.fixture();
      const { session, request } = await k.startedPrompt(f);
      const transport = new FakeTransport().acceptAll("wamid.TEST08D1.P");
      const { claim } = await claimNext(k.dispatchDeps(transport));
      expect(await executeClaim(k.dispatchDeps(transport), claim!)).toBe("accepted");
      const reply = await k.replyTrigger(f, session.awaiting_token as string, "a");
      return { f, s: session, r: request, reply, claim: await k.claimOf(reply.id) };
    }

    it("A staff first: the submission holds K; T1 waits for it, then hands over staff_replied; R held; no BOT request; both messages durable", async () => {
      const x = await queuedWorld();
      const tr = await k.trigger(x.f, { body: "hello?" });
      const claim = await k.claimOf(tr.id);
      const gate = await accountGate(x.f); // parks the submission AFTER its conversation lock (the account read)
      const staff = kit.settle(k.submit(x.f, "staff words"));
      const staffPid = await kit.waitUntilBlocked(gate.pid);
      const t1 = kit.settle(k.runClaim(claim));
      const t1Pid = await kit.waitUntilBlocked(staffPid);
      await waitsOnConversationOnly(t1Pid);
      expect(await kit.blockersOf(t1Pid)).toEqual([staffPid]); // T1 waits for the staff holder at K
      expect(await staffRequests(x.f)).toHaveLength(0); // nothing of the staff writer is visible yet
      await gate.release();
      const [sr, tr1] = await Promise.all([staff, t1]);
      noDeadlock(sr, tr1);
      expect(sr.ok).toBe(true);
      expect(tr1).toMatchObject({
        ok: true,
        value: { status: "IGNORED", outcome: "session_ended" },
      });

      const [staffReq, ...others] = await staffRequests(x.f);
      expect(others).toHaveLength(0); // committed exactly once
      expect(staffReq).toMatchObject({
        state: "QUEUED",
        body: "staff words",
        direction: "OUTBOUND",
      });
      const s = await k.session(x.s.id as string);
      expect(s).toMatchObject({
        state: "HANDED_OVER",
        end_reason: "system_handover",
        handover_reason: "staff_replied",
        awaiting: null,
        terminal_notice_step_seq: null,
      });
      expect(s.output_suppressed_at).toBeInstanceOf(Date);
      expect(Number(staffReq!.control_seq)).toBeGreaterThan(Number(s.started_control_seq)); // observed as a takeover
      expect(Number(s.handover_control_seq)).toBeGreaterThan(Number(staffReq!.control_seq)); // handover sequenced after it
      expect((await k.events(x.s.id as string)).map((e) => [e.kind, e.code])).toEqual([
        ["HANDED_OVER", "staff_replied"],
      ]);
      expect(await k.request(x.r.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_output_suppressed",
      });
      expect(await k.botRequests(x.f)).toHaveLength(1); // no new BOT request
      expect(await messageExists(tr.messageId)).toBe(true);
      expect(await messageExists(staffReq!.message_id as string)).toBe(true);
    });

    it("B bot first: T1 commits R2 first; the submission waits at K and gets a LATER control_seq; the dispatcher holds R2; the next bot step hands over", async () => {
      const x = await repliedWorld();
      const p = k.pause();
      const t1 = kit.settle(k.runClaim(x.claim, { hooks: { beforeCommit: p.hook } }));
      const t1Pid = await p.reached;
      const staff = kit.settle(k.submit(x.f, "late staff"));
      const staffPid = await kit.waitUntilBlocked(t1Pid);
      await waitsOnConversationOnly(staffPid);
      expect(await kit.blockersOf(staffPid)).toEqual([t1Pid]);
      p.release();
      const [t1r, sr] = await Promise.all([t1, staff]);
      noDeadlock(t1r, sr);
      expect(sr.ok).toBe(true);
      expect(t1r).toMatchObject({ ok: true, value: { outcome: "input_accepted" } });

      const [, r2] = await k.botRequests(x.f);
      const [staffReq] = await staffRequests(x.f);
      expect(Number(staffReq!.control_seq)).toBeGreaterThan(Number(r2!.control_seq)); // staff sequenced after R2
      const transport = new FakeTransport();
      await claimNext(k.dispatchDeps(transport)); // R2 first (earlier); a STAFF claim is never executed here
      expect(await k.request(r2!.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "staff_took_over",
      });
      expect(transport.calls).toHaveLength(0);

      // the later bot execution detects the newer staff event
      const later = await k.trigger(x.f, { body: "anyone?" });
      expect(await k.run(later.id)).toMatchObject({ status: "IGNORED", outcome: "session_ended" });
      expect(await k.session(x.s.id as string)).toMatchObject({
        state: "HANDED_OVER",
        handover_reason: "staff_replied",
      });
      expect(await k.botRequests(x.f)).toHaveLength(2); // no third request
      expect(await k.request(r2!.id as string)).toMatchObject({ hold_reason: "staff_took_over" }); // not rewritten
      expect(await staffRequests(x.f)).toHaveLength(1);
    });

    it("C a rolled-back submission (backend terminated while it holds K) leaves nothing: T1 proceeds as if no staff event existed", async () => {
      const x = await repliedWorld();
      const watch = terminationWatch(t.pool);
      const gate = await accountGate(x.f);
      const staff = kit.settle(k.submit(x.f, "doomed"));
      const staffPid = await kit.waitUntilBlocked(gate.pid);
      watch.stopCapturing();
      const t1 = kit.settle(k.runClaim(x.claim));
      await kit.waitUntilBlocked(staffPid); // T1 waits for the doomed holder
      await watch.terminate(staffPid);
      await watch.terminated();
      await gate.release(); // T1's own account FOR SHARE would otherwise wait for the gate
      const [sr, t1r] = await Promise.all([staff, t1]);
      await watch.verify();
      expect(sr.ok).toBe(false);
      expect(t1r).toMatchObject({ ok: true, value: { outcome: "input_accepted" } });
      expect(await staffRequests(x.f)).toHaveLength(0);
      expect(
        Number(
          (
            await k.one(
              "select count(*)::int n from messages where direction = 'OUTBOUND' and body = 'doomed'",
            )
          ).n,
        ),
      ).toBe(0);
      expect((await k.session(x.s.id as string)).state).toBe("WAITING_FOR_SEND"); // R2's prompt
      expect((await k.events(x.s.id as string)).map((e) => e.kind)).toEqual(["INPUT_ACCEPTED"]); // no HANDED_OVER
      expect(await k.botRequests(x.f)).toHaveLength(2); // R2 exists and is not held
      expect((await k.botRequests(x.f))[1]).toMatchObject({ state: "QUEUED", hold_reason: null });
    });

    it("D concurrent submissions serialize at K: the second waits for the first; two durable requests, ascending control_seq, no 40P01", async () => {
      const x = await queuedWorld();
      const gate = await accountGate(x.f);
      const s1 = kit.settle(k.submit(x.f, "one"));
      const pid1 = await kit.waitUntilBlocked(gate.pid);
      const s2 = kit.settle(k.submit(x.f, "two"));
      const pid2 = await kit.waitUntilBlocked(pid1);
      await waitsOnConversationOnly(pid2);
      expect(await kit.blockersOf(pid2)).toEqual([pid1]);
      await gate.release();
      const [r1, r2] = await Promise.all([s1, s2]);
      noDeadlock(r1, r2);
      expect([r1.ok, r2.ok]).toEqual([true, true]);
      const reqs = await staffRequests(x.f);
      expect(reqs.map((r) => r.body)).toEqual(["one", "two"]);
      expect(Number(reqs[1]!.control_seq)).toBeGreaterThan(Number(reqs[0]!.control_seq));
    });
  });

  // ================================================================================== Part 2: MESSAGE follow-ups
  const testFlow = (nodes: Record<string, unknown>) => ({
    schemaVersion: 1,
    name: "Test flow",
    startNodeId: "welcome",
    errorNodeId: "fallback",
    triggers: [{ kind: "keyword", words: ["menu"] }],
    nodes: {
      fallback: { type: "HANDOVER", reason: "needs_staff", message: "A person will reply." },
      ...nodes,
    },
  });
  /** MESSAGE -> MESSAGE -> END: the first follow-up is an ORDINARY send. */
  const chainFlow = () =>
    testFlow({
      welcome: { type: "MESSAGE", text: "Hello", next: "more" },
      more: { type: "MESSAGE", text: "More", next: "done" },
      done: { type: "END", message: "Bye" },
    });
  /** MESSAGE -> END with NO message: accepting R1 ends the flow with zero effects (COMPLETED flow_end, nothing to enqueue). */
  const silentEndFlow = () =>
    testFlow({
      welcome: { type: "MESSAGE", text: "Hello", next: "done" },
      done: { type: "END" },
    });
  /** What accepting R1 leads to when no staff acted. */
  const FLOWS = {
    notice: { flow: messageFlow, label: "a terminal END notice" },
    ordinary: { flow: chainFlow, label: "an ordinary MESSAGE" },
    silent: { flow: silentEndFlow, label: "a silent END (no message, no effect)" },
  } as const;
  const KINDS = ["notice", "ordinary", "silent"] as const;

  async function staffDo(f: RuntimeFx, action: Action) {
    if (action === "assign") expect((await k.assign(f)).changed).toBe(true);
    else if (action === "submit") await k.submit(f, "staff words");
    else {
      const { changeConversationStatus } = await import("@/modules/inbox");
      await changeConversationStatus(
        f.w.staff.ctx,
        f.w.student.conversation.id,
        { to: "RESOLVED", expected: "OPEN" },
        { db: t.db as never },
      );
    }
  }
  /** J.2 rules 4-6: the fate staff control gives a live session (classifyTakeover), applied before the flow moves on. */
  const FATE = {
    assign: { state: "HANDED_OVER", endReason: "system_handover", handover: "staff_assigned" },
    submit: { state: "HANDED_OVER", endReason: "system_handover", handover: "staff_replied" },
    resolve: { state: "COMPLETED", endReason: "conversation_resolved", handover: null },
  } as const;

  /** A MESSAGE session started by real T1: S WAITING_FOR_SEND, R1 QUEUED, the student's trigger message recorded. */
  async function started(flow: Record<string, unknown>) {
    const f = await k.fixture(flow);
    const tr = await k.trigger(f, { first: true, body: "menu" });
    expect(await k.run(tr.id)).toMatchObject({ outcome: "session_started" });
    const s = await k.one("select * from bot_sessions where conversation_id = $1", [
      f.w.student.conversation.id,
    ]);
    const [r1, ...more] = await k.botRequests(f);
    expect(more).toHaveLength(0);
    expect(r1).toMatchObject({ state: "QUEUED" });
    return { f, s, r1: r1!, studentMessageId: tr.messageId };
  }
  type Started = Awaited<ReturnType<typeof started>>;
  const accept = async (x: Started, wamid: string) =>
    expect((await k.dispatchWith(k.accepted(wamid), x.r1.id as string)).outcome).toBe("accepted");

  /**
   * Terminal-state invariants every follow-up scenario shares. 08E-8D1 P2: the staff fate (J.2 rules 4-6) is applied before
   * the flow moves on, whatever the follow-up is; the flow never continues into a defensive enqueue refusal (send_refused /
   * TERMINAL_NOTICE_NOT_QUEUED) and never completes flow_end past newer staff control.
   */
  async function expectStaffFate(x: Started, action: Action, outcome: unknown) {
    const c = FATE[action];
    expect(outcome).toEqual({
      kind: "applied",
      action: c.handover ?? c.endReason,
      finalState: c.state,
    });
    const s = await k.session(x.s.id as string);
    expect(s).toMatchObject({
      state: c.state,
      end_reason: c.endReason,
      handover_reason: c.handover,
      terminal_notice_step_seq: null,
      awaiting: null,
      awaiting_token: null,
    });
    expect(s.output_suppressed_at).toBeInstanceOf(Date);
    // a resolution completes the session: no session event, no handover barrier (handover_control_seq stays NULL)
    if (c.handover === null) expect(s.handover_control_seq).toBeNull();
    else expect(Number(s.handover_control_seq)).toBeGreaterThan(Number(s.started_control_seq));
    const events = (await k.events(x.s.id as string)).map((e) => [e.kind, e.code]);
    expect(events).toEqual(c.handover === null ? [] : [["HANDED_OVER", c.handover]]);
    // no follow-up BOT request, no duplicate; R1 keeps its truthful ACCEPTED
    const reqs = await k.botRequests(x.f);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ id: x.r1.id, state: "ACCEPTED", hold_reason: null });
    expect(await k.inFlight(x.s.id as string)).toBe(0);
    expect(await messageExists(x.studentMessageId)).toBe(true);
    if (action === "submit") {
      const staff = await staffRequests(x.f);
      expect(staff).toHaveLength(1);
      expect(await messageExists(staff[0]!.message_id as string)).toBe(true);
    }
    // no duplicate terminal transition: reconciling again changes nothing
    const before = await k.sessionJson(x.s.id as string);
    expect(await k.reconcile(x.s)).toEqual({ kind: "skipped", reason: "not_live" });
    expect(await k.sessionJson(x.s.id as string)).toEqual(before);
    expect(await k.botRequests(x.f)).toHaveLength(1);
  }

  for (const kind of KINDS) {
    describe(`follow-up is ${FLOWS[kind].label}`, () => {
      for (const action of ["assign", "submit", "resolve"] as const) {
        it(`A/B/C ${action} after R1 ACCEPTED, before the reconciler continues: no follow-up request; ${FATE[action].state}/${FATE[action].handover ?? FATE[action].endReason}`, async () => {
          const x = await started(FLOWS[kind].flow());
          await accept(x, `wamid.TEST08D1.${kind}.${action}`);
          await staffDo(x.f, action);
          await expectStaffFate(x, action, await k.reconcile(x.s));
        });
      }

      it("D staff acts while R1 is still QUEUED: the dispatcher holds R1 staff_took_over (0 BOT calls); the reconciler then hands over send_held; no follow-up", async () => {
        const x = await started(FLOWS[kind].flow());
        await k.assign(x.f);
        const transport = new FakeTransport();
        const result = await claimNext(k.dispatchDeps(transport));
        expect(result.claim).toBeNull();
        expect(result.held).toBe(1);
        expect(transport.calls).toHaveLength(0);
        expect(await k.request(x.r1.id as string)).toMatchObject({
          state: "HELD",
          hold_reason: "staff_took_over",
        });
        expect(await k.reconcile(x.s)).toMatchObject({
          kind: "applied",
          finalState: "HANDED_OVER",
        });
        expect(await k.session(x.s.id as string)).toMatchObject({
          state: "HANDED_OVER",
          end_reason: "system_handover",
          handover_reason: "send_held",
          terminal_notice_step_seq: null,
        });
        expect((await k.events(x.s.id as string)).map((e) => [e.kind, e.code])).toEqual([
          ["HANDED_OVER", "staff_took_over"],
        ]);
        expect(await k.botRequests(x.f)).toHaveLength(1);
        expect(await messageExists(x.studentMessageId)).toBe(true);
        expect(await k.reconcile(x.s)).toEqual({ kind: "skipped", reason: "not_live" });
      });

      it("F final authorization already passed (transport paused) when staff acts: the accepted window — one call, R1 ACCEPTED; the reconciler then hands over staff_assigned, no follow-up", async () => {
        const x = await started(FLOWS[kind].flow());
        const release = deferred();
        const wamid = `wamid.TEST08D1.F.${kind}`;
        const transport = new FakeTransport().next(async () => {
          await release.promise;
          return k.accepted(wamid);
        });
        const { claim } = await claimNext(k.dispatchDeps(transport));
        expect(claim?.requestId).toBe(x.r1.id);
        const c = kit.settle(executeClaim(k.dispatchDeps(transport), claim!));
        for (let i = 0; i < 500 && transport.calls.length === 0; i++)
          await new Promise((r) => setTimeout(r, 10));
        expect(transport.calls).toHaveLength(1); // the final read has passed
        await k.assign(x.f); // the staff event commits inside the window
        release.resolve();
        expect((await c).ok && (await c)).toMatchObject({ value: "accepted" });
        expect(transport.calls).toHaveLength(1); // no second call
        expect(
          (await k.one("select wamid from messages where id = $1", [x.r1.message_id])).wamid,
        ).toBe(wamid);
        await expectStaffFate(x, "assign", await k.reconcile(x.s));
      });
    });
  }

  describe("E staff races the reconciler at the conversation row (follow-up = END notice)", () => {
    for (const action of ["assign", "submit"] as const) {
      it(`${action}: reconciler first — it commits the notice R2 (no staff event yet), the staff writer waits at K and sequences later; the dispatcher holds R2 staff_took_over, 0 calls`, async () => {
        const x = await started(messageFlow());
        await accept(x, `wamid.TEST08D1.E1.${action}`);
        const p = k.pause();
        const rec = kit.settle(k.reconcile(x.s, { hooks: { afterDecisionClock: p.hook } }));
        const recPid = await p.reached; // holds K, nothing written yet
        const staff = kit.settle<unknown>(action === "assign" ? k.assign(x.f) : k.submit(x.f));
        const staffPid = await kit.waitUntilBlocked(recPid);
        await waitsOnConversationOnly(staffPid);
        expect(await kit.blockersOf(staffPid)).toEqual([recPid]);
        p.release();
        const [rr, sr] = await Promise.all([rec, staff]);
        noDeadlock(rr, sr);
        expect(sr.ok).toBe(true);
        expect(rr).toMatchObject({ ok: true, value: { kind: "applied", finalState: "COMPLETED" } });
        const [, r2] = await k.botRequests(x.f);
        expect(r2).toMatchObject({ state: "QUEUED" });
        const s = await k.session(x.s.id as string);
        expect(s).toMatchObject({ state: "COMPLETED", end_reason: "flow_end" });
        expect(Number(s.terminal_notice_step_seq)).toBe(Number(r2!.bot_step_seq));
        const transport = new FakeTransport();
        // a STAFF request may be claimed first (never executed here); the staff fence committed before R2's claim, so R2 is refused
        for (let i = 0; i < 3 && (await k.request(r2!.id as string)).state === "QUEUED"; i++) {
          const claimed = await claimNext(k.dispatchDeps(transport));
          if (claimed.claim)
            expect((await k.request(claimed.claim.requestId)).origin).toBe("STAFF");
        }
        expect(await k.request(r2!.id as string)).toMatchObject({
          state: "HELD",
          hold_reason: "staff_took_over",
        });
        expect(transport.calls).toHaveLength(0);
      });

      it(`${action}: staff first — the writer holds K; the reconciler waits, then hands over (staff_assigned / staff_replied); no request`, async () => {
        const x = await started(messageFlow());
        await accept(x, `wamid.TEST08D1.E2.${action}`);
        const gate =
          action === "assign"
            ? await kit.hold("select id from organization_memberships where id = $1 for update", [
                x.f.w.staff.membershipId,
              ])
            : await accountGate(x.f);
        const staff = kit.settle<unknown>(action === "assign" ? k.assign(x.f) : k.submit(x.f));
        const staffPid = await kit.waitUntilBlocked(gate.pid);
        const rec = kit.settle(k.reconcile(x.s));
        const recPid = await kit.waitUntilBlocked(staffPid);
        await waitsOnConversationOnly(recPid);
        expect(await kit.blockersOf(recPid)).toEqual([staffPid]);
        await gate.release();
        const [sr, rr] = await Promise.all([staff, rec]);
        noDeadlock(sr, rr);
        expect(sr.ok).toBe(true);
        expect(rr).toMatchObject({
          ok: true,
          value: { kind: "applied", finalState: "HANDED_OVER" },
        });
        await expectStaffFate(x, action, (rr as { value: unknown }).value);
      });
    }
  });

  // ================================================================================== P2 lifecycle correction (08E-8D1)
  const MIN = 60_000;
  const statusSeq = async (f: RuntimeFx) =>
    Number(
      (
        await k.one(
          "select max(control_seq) s from conversation_events where conversation_id = $1 and kind = 'STATUS'",
          [f.w.student.conversation.id],
        )
      ).s,
    );
  /** A fresh keyword input committed now, aged so that a decision clock shifted by `ms` sees it as one second old. */
  async function freshInput(f: RuntimeFx, ms: number) {
    const tr = await k.trigger(f, { body: "menu", observed: await k.controlSeq(f) });
    const at = new Date(Date.now() + ms - 1000);
    await k.q("update bot_triggers set input_occurred_at = $2 where id = $1", [tr.id, at]);
    await k.q("update messages set occurred_at = $2 where id = $1", [tr.messageId, at]);
    return tr;
  }

  // SETUP SHORTCUT: `reopen` sets status OPEN with a raw UPDATE in place of the real inbound reopening transaction
  // (reopenIfNewer). The bot start (real T1) still runs every eligibility rule on the reopened row; the inbound reopening
  // path itself is NOT exercised by these tests.
  const reopen = (f: RuntimeFx) =>
    k.q("update conversations set status = 'OPEN' where id = $1", [f.w.student.conversation.id]);

  for (const kind of KINDS) {
    it(`P2 primary (${kind}): staff reply then resolution after R1 ACCEPTED -> HANDED_OVER staff_replied after the resolution; no follow-up; restart only after a later resolution`, async () => {
      const x = await started(FLOWS[kind].flow());
      await accept(x, `wamid.TEST08D1.P2.${kind}`);
      await staffDo(x.f, "submit");
      await staffDo(x.f, "resolve");
      const resolutionSeq = await statusSeq(x.f);
      expect(resolutionSeq).toBeGreaterThan(Number(x.s.started_control_seq) + 1); // reply, then resolution

      expect(await k.reconcile(x.s)).toEqual({
        kind: "applied",
        action: "staff_replied",
        finalState: "HANDED_OVER",
      });
      const s = await k.session(x.s.id as string);
      expect(s).toMatchObject({
        state: "HANDED_OVER",
        end_reason: "system_handover",
        handover_reason: "staff_replied",
        terminal_notice_step_seq: null,
        awaiting: null,
      });
      expect(s.output_suppressed_at).toBeInstanceOf(Date);
      expect(Number(s.handover_control_seq)).toBeGreaterThan(resolutionSeq);
      expect((await k.events(x.s.id as string)).map((e) => [e.kind, e.code])).toEqual([
        ["HANDED_OVER", "staff_replied"],
      ]);
      const reqs = await k.botRequests(x.f);
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({ id: x.r1.id, state: "ACCEPTED", hold_reason: null });
      expect(await k.inFlight(x.s.id as string)).toBe(0);
      const transport = new FakeTransport();
      for (let i = 0; i < 2; i++) {
        const claimed = await claimNext(k.dispatchDeps(transport)); // only the STAFF request may be claimed (never executed)
        if (claimed.claim) expect((await k.request(claimed.claim.requestId)).origin).toBe("STAFF");
      }
      expect(transport.calls).toHaveLength(0);

      // idempotent: no second transition, no duplicate event
      const before = await k.sessionJson(x.s.id as string);
      expect(await k.reconcile(x.s)).toEqual({ kind: "skipped", reason: "not_live" });
      expect(await k.sessionJson(x.s.id as string)).toEqual(before);
      expect(await k.events(x.s.id as string)).toHaveLength(1);

      // after the cooldown a fresh input is still blocked: the handover is later than the resolution
      const blocked = await freshInput(x.f, 31 * MIN);
      expect(await k.run(blocked.id, { readClock: k.shifted(31 * MIN) })).toMatchObject({
        status: "IGNORED",
        outcome: "handover_unresolved",
      });
      // a later staff resolution, then eligible fresh input after the cooldown, restarts
      await reopen(x.f);
      await staffDo(x.f, "resolve");
      await reopen(x.f);
      const again = await freshInput(x.f, 31 * MIN);
      expect(await k.run(again.id, { readClock: k.shifted(31 * MIN) })).toMatchObject({
        status: "PROCESSED",
        outcome: "session_started",
      });
    });

    it(`P2 resolution-only (${kind}): resolution after R1 ACCEPTED -> COMPLETED conversation_resolved; no handover barrier; restart after reopening + cooldown needs no second resolution`, async () => {
      const x = await started(FLOWS[kind].flow());
      await accept(x, `wamid.TEST08D1.P2R.${kind}`);
      await staffDo(x.f, "resolve");
      const resolutionSeq = await statusSeq(x.f);
      expect(resolutionSeq).toBeGreaterThan(Number(x.s.started_control_seq));

      expect(await k.reconcile(x.s)).toEqual({
        kind: "applied",
        action: "conversation_resolved",
        finalState: "COMPLETED",
      });
      const s = await k.session(x.s.id as string);
      expect(s).toMatchObject({
        state: "COMPLETED",
        end_reason: "conversation_resolved",
        handover_reason: null,
        handover_control_seq: null, // no handover barrier after the resolution
        terminal_notice_step_seq: null,
        awaiting: null,
        awaiting_token: null,
      });
      expect(s.output_suppressed_at).toBeInstanceOf(Date);
      expect(await k.events(x.s.id as string)).toEqual([]); // no HANDED_OVER / send_refused / notice event
      const reqs = await k.botRequests(x.f);
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({ id: x.r1.id, state: "ACCEPTED", hold_reason: null });
      expect(await k.inFlight(x.s.id as string)).toBe(0);
      const transport = new FakeTransport();
      expect((await claimNext(k.dispatchDeps(transport))).claim).toBeNull(); // nothing to send
      expect(transport.calls).toHaveLength(0);

      // idempotent
      const before = await k.sessionJson(x.s.id as string);
      expect(await k.reconcile(x.s)).toEqual({ kind: "skipped", reason: "not_live" });
      expect(await k.sessionJson(x.s.id as string)).toEqual(before);

      // still RESOLVED (no reopening): a fresh input is refused conversation_resolved
      const closed = await freshInput(x.f, 31 * MIN);
      expect(await k.run(closed.id, { readClock: k.shifted(31 * MIN) })).toMatchObject({
        status: "IGNORED",
        outcome: "conversation_resolved",
      });
      // reopened, before the cooldown: refused by the cooldown rule, not by a handover barrier
      await reopen(x.f);
      const early = await freshInput(x.f, 2000); // after the resolution, inside the cooldown
      expect(await k.run(early.id, { readClock: k.shifted(2000) })).toMatchObject({
        status: "IGNORED",
        outcome: "cooldown",
      });
      // after the cooldown: starts, with no second resolution
      const again = await freshInput(x.f, 31 * MIN);
      expect(await k.run(again.id, { readClock: k.shifted(31 * MIN) })).toMatchObject({
        status: "PROCESSED",
        outcome: "session_started",
      });
    });
  }

  for (const kind of ["notice", "silent"] as const)
    for (const [actions, reason] of [
      [["submit", "assign", "resolve"], "staff_assigned"],
      [["assign", "resolve"], "staff_assigned"],
      [["submit", "resolve"], "staff_replied"],
    ] as const)
      it(`P2 precedence (${kind}): ${actions.join(" + ")} -> ${reason}; a later resolution never overrides an assignment or reply`, async () => {
        const x = await started(FLOWS[kind].flow());
        await accept(x, `wamid.TEST08D1.P2.PREC.${kind}.${actions.join("")}`);
        for (const a of actions) await staffDo(x.f, a);
        expect(await k.reconcile(x.s)).toEqual({
          kind: "applied",
          action: reason,
          finalState: "HANDED_OVER",
        });
        const s = await k.session(x.s.id as string);
        expect(s).toMatchObject({ end_reason: "system_handover", handover_reason: reason });
        expect(Number(s.handover_control_seq)).toBeGreaterThan(await statusSeq(x.f));
        expect((await k.events(x.s.id as string)).map((e) => [e.kind, e.code])).toEqual([
          ["HANDED_OVER", reason],
        ]);
        expect(await k.botRequests(x.f)).toHaveLength(1);
      });

  it("P2 Stop precedence: a live session of a STOPPED deployment with a staff reply is handed over deployment_stopped, not staff_replied", async () => {
    const x = await started(messageFlow());
    await accept(x, "wamid.TEST08D1.P2.STOP");
    await staffDo(x.f, "submit");
    await k.q(
      "update bot_deployments set status = 'STOPPED', send_epoch = send_epoch + 1 where id = $1",
      [x.f.deployment.id],
    );
    expect(await k.reconcile(x.s)).toMatchObject({
      action: "deployment_stopped",
      finalState: "HANDED_OVER",
    });
    expect(await k.session(x.s.id as string)).toMatchObject({
      handover_reason: "deployment_stopped",
    });
    expect(await k.botRequests(x.f)).toHaveLength(1);
  });

  // Positive controls without staff: each flow DOES move on (a notice, a next MESSAGE, a silent flow_end), so the staff-fate
  // assertions above are not vacuous.
  for (const [kind, finalState, requests, endReason] of [
    ["notice", "COMPLETED", 2, "flow_end"],
    ["ordinary", "WAITING_FOR_SEND", 2, null],
    ["silent", "COMPLETED", 1, "flow_end"],
  ] as const)
    it(`CONTROL (${kind}): with no staff event the reconciler continues the flow -> ${finalState}`, async () => {
      const x = await started(FLOWS[kind].flow());
      await accept(x, `wamid.TEST08D1.CONTROL.${kind}`);
      expect(await k.reconcile(x.s)).toEqual({
        kind: "applied",
        action: "send_result_accepted",
        finalState,
      });
      expect(await k.session(x.s.id as string)).toMatchObject({
        state: finalState,
        end_reason: endReason,
      });
      expect(await k.botRequests(x.f)).toHaveLength(requests);
    });
});
