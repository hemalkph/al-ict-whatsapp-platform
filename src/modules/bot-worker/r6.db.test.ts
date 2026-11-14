import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { claimNext, executeClaim, recoverStuck } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { stopActiveSessions } from "../bot-control";
import { barrierKit, BOTS_ON } from "../bot-control/testing";
import { runtimeKit, triggerRow, type RuntimeFx } from "../bot-runtime/testing";
import { EXIT_REFUSED } from "./run";
import { startWorker, until } from "./testing";

// R6 (Phase 08E-7; plan M, N.2): suspension and restart on disposable PostgreSQL 17. "Suspended" is BOTS_RUNTIME_ENABLED off in a
// process: the bot runtime (T1, reconciler) does nothing, and the outbound worker claims no BOT row (08D). Every decision after
// re-enabling comes from the approved components with their own clocks: the dispatcher's deadline and staff/Stop/epoch rules,
// its SENDING recovery, the reconciler. FakeTransport only. A send whose final authorization already passed is not recalled (the
// accepted window, covered in R5/R3-S-B). NOT EXECUTED by the author of this change: no isolated PostgreSQL server was configured.

const OFF = { ...BOTS_ON, botsRuntimeEnabled: false };

describe("suspension and restart (R6)", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  let k: ReturnType<typeof runtimeKit>;
  const workers: Array<ReturnType<typeof startWorker>> = [];

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
    try {
      for (const w of workers.splice(0)) await w.stop();
      k.releaseAll();
      await kit.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  });
  afterAll(async () => t.close());

  /** A live session WAITING_FOR_SEND with its prompt R QUEUED (real T1), then the runtime suspended everywhere. */
  async function suspendedWithQueuedPrompt() {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    // suspended: the outbound worker claims no BOT row, the reconciler and T1 do nothing
    const transport = new FakeTransport();
    expect((await claimNext(k.dispatchDeps(transport, { config: OFF }))).claim).toBeNull();
    expect(await k.reconcile(session, { config: OFF })).toEqual({ kind: "gates_off" });
    const tap = await k.replyTrigger(f, session.awaiting_token as string, "a");
    expect(await k.run(tap.id, { config: OFF })).toEqual({ kind: "gates_off" });
    expect(await k.request(request.id as string)).toMatchObject({ state: "QUEUED" });
    expect(transport.calls).toHaveLength(0);
    const deadline = new Date(request.dispatch_deadline as Date).getTime();
    return { f, s: session, r: request, deadline };
  }

  it("re-enabled WITHIN the 120 s deadline: the prompt is dispatched once and reconciled", async () => {
    const x = await suspendedWithQueuedPrompt();
    const sent = await k.dispatchWith(k.accepted("wamid.TEST08E7.R6.IN"), x.r.id as string, {
      now: () => new Date(x.deadline - 1_000),
    });
    expect(sent.outcome).toBe("accepted");
    expect(sent.transport.calls).toHaveLength(1);
    expect(await k.reconcile(x.s)).toMatchObject({ finalState: "WAITING_FOR_INPUT" });
  });

  it("re-enabled AFTER the deadline: the claim holds R deadline_passed, 0 calls; the reconciler hands over send_held", async () => {
    const x = await suspendedWithQueuedPrompt();
    const transport = new FakeTransport();
    expect(
      await claimNext(k.dispatchDeps(transport, { now: () => new Date(x.deadline + 1_000) })),
    ).toMatchObject({
      claim: null,
      held: 1,
    });
    expect(await k.request(x.r.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "deadline_passed",
    });
    expect(transport.calls).toHaveLength(0);
    expect(await k.reconcile(x.s)).toMatchObject({ finalState: "HANDED_OVER" });
    expect(await k.session(x.s.id as string)).toMatchObject({ handover_reason: "send_held" });
  });

  it("staff takeover during the suspension: on re-enabling the claim holds R staff_took_over, 0 calls; then handed over", async () => {
    const x = await suspendedWithQueuedPrompt();
    await k.assign(x.f);
    const transport = new FakeTransport();
    expect(await claimNext(k.dispatchDeps(transport))).toMatchObject({ claim: null, held: 1 });
    expect(await k.request(x.r.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "staff_took_over",
    });
    expect(transport.calls).toHaveLength(0);
    await k.reconcile(x.s);
    expect((await k.events(x.s.id as string)).map((e) => e.code)).toContain("staff_took_over");
  });

  it("Stop during the suspension: Stop holds R (bot_stopped) and hands the session over; re-enabling sends nothing", async () => {
    const x = await suspendedWithQueuedPrompt();
    await stopActiveSessions(
      x.f.w.admin.ctx,
      { deploymentId: x.f.deployment.id, expectedLiveSessions: 1 },
      { db: t.db as never },
    );
    expect(await k.request(x.r.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "bot_stopped",
    });
    expect(await k.session(x.s.id as string)).toMatchObject({
      state: "HANDED_OVER",
      handover_reason: "operator_stop",
    });
    const transport = new FakeTransport();
    expect((await claimNext(k.dispatchDeps(transport))).claim).toBeNull();
    expect(transport.calls).toHaveLength(0);
  });

  it("SENDING beyond the recovery window (the dispatcher died after its claim): recovered UNKNOWN_OUTCOME, never resent; handed over send_outcome_unknown", async () => {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    const transport = new FakeTransport();
    const { claim } = await claimNext(k.dispatchDeps(transport));
    expect(claim?.requestId).toBe(request.id); // ... and the process dies before sending
    const sendStarted = new Date(
      (await k.request(request.id as string)).send_started_at as Date,
    ).getTime();
    expect(
      await recoverStuck(
        k.dispatchDeps(transport, { now: () => new Date(sendStarted + 5 * 60_000 + 1_000) }),
      ),
    ).toBe(1);
    expect(await k.request(request.id as string)).toMatchObject({ state: "UNKNOWN_OUTCOME" });
    expect(await k.reconcile(session)).toMatchObject({ finalState: "HANDED_OVER" });
    expect(await k.session(session.id as string)).toMatchObject({
      handover_reason: "send_outcome_unknown",
    });
    expect((await claimNext(k.dispatchDeps(transport))).claim).toBeNull();
    expect(transport.calls).toHaveLength(0);
    expect(await k.botRequests(f)).toHaveLength(1);
    // the dead dispatcher's claim can no longer send either
    expect(await executeClaim(k.dispatchDeps(transport), claim!)).not.toBe("accepted");
    expect(transport.calls).toHaveLength(0);
  });

  it("the bot worker disabled, then enabled: refused with nothing changed, then the waiting trigger is processed once", async () => {
    const f = await k.fixture();
    const tr = await k.trigger(f, { first: true });
    const before = await triggerRow(t, tr.id);
    const off = startWorker(t, { WHATSAPP_OUTBOUND_ENABLED: "false" });
    expect(await off.running).toBe(EXIT_REFUSED);
    expect(await triggerRow(t, tr.id)).toEqual(before);
    workers.push(startWorker(t));
    await until(
      async () => (await triggerRow(t, tr.id)).status === "PROCESSED",
      20_000,
      "processed",
    );
    expect(await k.botRequests(f)).toHaveLength(1);
  });

  it("after a restart, an input older than maxInputAge ends IGNORED stale_trigger (never DEAD); one received before activation ends before_activation", async () => {
    const stale = await k.fixture();
    const st = await k.trigger(stale, { first: true });
    await t.pool.query(
      "update bot_triggers set input_occurred_at = clock_timestamp() - interval '11 minutes' where id = $1",
      [st.id],
    );
    const early = await k.fixture();
    const et = await k.trigger(early, { first: true });
    await t.pool.query(
      "update bot_triggers set enqueued_at = (select start_eligible_from - interval '1 minute' from bot_deployments where id = $2) where id = $1",
      [et.id, early.deployment.id],
    );
    workers.push(startWorker(t));
    await until(
      async () =>
        (await triggerRow(t, st.id)).status !== "PENDING" &&
        (await triggerRow(t, et.id)).status !== "PENDING",
      20_000,
      "both finished",
    );
    expect(await triggerRow(t, st.id)).toMatchObject({
      status: "IGNORED",
      outcome_code: "stale_trigger",
      attempts: 1,
    });
    expect(await triggerRow(t, et.id)).toMatchObject({
      status: "IGNORED",
      outcome_code: "before_activation",
    });
    expect(await k.botRequests(stale)).toHaveLength(0);
    expect(await k.botRequests(early)).toHaveLength(0);
  });

  it("several workers stopping and restarting process every trigger exactly once", async () => {
    const worlds: RuntimeFx[] = [];
    const ids: string[] = [];
    const add = async () => {
      const f = await k.fixture();
      worlds.push(f);
      ids.push((await k.trigger(f, { first: true })).id);
    };
    for (let i = 0; i < 3; i++) await add();
    const a = startWorker(t);
    const b = startWorker(t);
    await until(
      async () =>
        (await Promise.all(ids.map((id) => triggerRow(t, id)))).every(
          (r) => r.status === "PROCESSED",
        ),
      30_000,
      "first round",
    );
    await Promise.all([a.stop(), b.stop()]);
    for (let i = 0; i < 3; i++) await add();
    workers.push(startWorker(t), startWorker(t));
    await until(
      async () =>
        (await Promise.all(ids.map((id) => triggerRow(t, id)))).every(
          (r) => r.status === "PROCESSED",
        ),
      30_000,
      "second round",
    );
    for (const id of ids) expect((await triggerRow(t, id)).attempts).toBe(1);
    for (const f of worlds) expect(await k.botRequests(f)).toHaveLength(1);
  });
});
