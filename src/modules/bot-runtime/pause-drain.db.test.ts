import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { claimNext } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import {
  deliver,
  handlerContext,
  type DeliverOptions,
  type StoredEvent,
} from "@/modules/whatsapp/inbound/testing";
import { buildWebhookWorkerHandlers } from "@/modules/whatsapp/worker/registry";
import {
  BotControlError,
  pauseDeployment,
  resumeDeployment,
  retireDeployment,
  stopActiveSessions,
} from "../bot-control";
import type { StepSummary } from "./context";
import { menuFlow, runtimeKit, triggerRow, type RuntimeFx } from "./testing";

// O.4 (Phase 08E-9 Batch 1; V3.2 P "08E exit: ... O.4", O.2-O.9 "pause/drain/resume/retire", F.2 deployment fences, F.3
// eligibility matrix, F.4 operator controls) on disposable PostgreSQL 17, with the runtime in the loop.
//
// F.3: PAUSED (also graceful drain) admits a trigger only for a conversation with a live session of the deployment, starts no
// new session, continues existing ones, and queues and dispatches their output. RETIRED admits, starts and continues nothing.
// F.2: resume restarts start_eligible_from, so an older trigger never starts a session. F.4: Stop (and Retire, which stops
// first in the same transaction) hands live sessions over and holds QUEUED BOT requests; resume never revives a stopped
// request. Every operator action is the real bot-control service; inbound messages go through the real ingest and the real
// webhook-worker handler with capture built from an explicit { BOTS_RUNTIME_ENABLED: "true" } object; the dispatcher is real
// with a FakeTransport only. No deployment, session or request state is written directly by these tests.

const STUDENT_A = "15550100123";
const STUDENT_B = "15550100124";
const STUDENT_C = "15550100125";

describe("O.4: pause, drain, resume and retire with the runtime in the loop", () => {
  let t: TestDb;
  let k: ReturnType<typeof runtimeKit>;
  const captureHandlers = buildWebhookWorkerHandlers({ BOTS_RUNTIME_ENABLED: "true" });

  beforeAll(async () => {
    t = await createTestDatabase({
      sessionTimeouts: {
        lock_timeout: 10_000,
        statement_timeout: 15_000,
        idle_in_transaction_session_timeout: 20_000,
      },
    });
    k = runtimeKit(t);
  });
  afterAll(async () => {
    if (t) await t.close();
  });
  beforeEach(async () => {
    await k.q("truncate organizations, webhook_requests cascade");
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(() => {
    k.releaseAll();
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------------------------------------ helpers

  type Row = Record<string, unknown>;
  type Real = {
    event: StoredEvent;
    message: Row & { id: string };
    trigger: (Row & { id: string }) | null;
  };

  /** One message from `from` through the real ingest and the real capture-enabled handler (provider time: DB clock + 1 s). */
  async function realInbound(f: RuntimeFx, from: string, message: Row): Promise<Real> {
    const account = await k.one(
      "select phone_number_id, waba_id from whatsapp_accounts where id = $1",
      [f.w.account.id],
    );
    const dbMs = ((await k.one("select clock_timestamp() t")).t as Date).getTime();
    const options: DeliverOptions = {
      id: `wamid.TEST08E9O4.${randomUUID()}`,
      from,
      pn: account.phone_number_id as string,
      waba: account.waba_id as string,
      timestamp: new Date(dbMs + 1_000),
      message,
    };
    const event = await deliver(t.db, options);
    await t.db.transaction((tx) =>
      captureHandlers.MESSAGE!(tx, { ...event, eventType: "MESSAGE" }, handlerContext()),
    );
    const row = (await k.one("select * from messages where wamid = $1", [
      event.providerObjectId,
    ])) as Real["message"];
    const trigger =
      ((await k.rows("select * from bot_triggers where message_id = $1", [row.id]))[0] as
        Real["trigger"] | undefined) ?? null;
    return { event, message: row, trigger };
  }
  const text = (body: string) => ({ type: "text", text: { body } });
  const tap = (token: string, key: string) => ({
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: `b1.${token}.${key}`, title: key } },
  });
  /** The world seen from the conversation the real handler created for one student. */
  async function fxOf(f0: RuntimeFx, r: Real): Promise<RuntimeFx> {
    const c = await k.one("select id, contact_id from conversations where id = $1", [
      r.message.conversation_id,
    ]);
    return {
      ...f0,
      w: {
        ...f0.w,
        student: {
          contact: { id: c.contact_id as string },
          conversation: { id: c.id as string },
          message: { id: r.message.id },
        },
      },
    };
  }
  function finished(summary: StepSummary, s: "PROCESSED" | "IGNORED", outcome: string) {
    expect(summary).toMatchObject({ kind: "finished", status: s, outcome });
  }
  const sessionOf = async (f: RuntimeFx) =>
    (await k.rows(
      "select * from bot_sessions where conversation_id = $1 order by started_control_seq",
      [f.w.student.conversation.id],
    )) as Row[];
  const deployment = (f: RuntimeFx) =>
    k.one(
      "select status, send_epoch::int send_epoch, start_eligible_from from bot_deployments where id = $1",
      [f.deployment.id],
    );
  const liveSessions = async (f: RuntimeFx) =>
    Number(
      (
        await k.one(
          "select count(*)::int n from bot_sessions where deployment_id = $1 and state in ('ACTIVE', 'WAITING_FOR_SEND', 'WAITING_FOR_INPUT')",
          [f.deployment.id],
        )
      ).n,
    );
  const deploymentEvents = async (f: RuntimeFx) =>
    (
      await k.rows(
        "select kind from bot_deployment_events where deployment_id = $1 order by created_at, id",
        [f.deployment.id],
      )
    ).map((e) => e.kind as string);
  const botKey = async (f: RuntimeFx) =>
    (await k.one("select key from bots where id = $1", [f.bot.id])).key as string;
  const admin = (f: RuntimeFx) => [f.w.admin.ctx, { db: t.db }] as const;
  const pause = (f: RuntimeFx) =>
    pauseDeployment(admin(f)[0], { deploymentId: f.deployment.id }, admin(f)[1]);
  const resume = (f: RuntimeFx) =>
    resumeDeployment(admin(f)[0], { deploymentId: f.deployment.id }, admin(f)[1]);
  const send = async (requestId: string) =>
    (await k.dispatchWith(k.accepted(`wamid.TEST08E9O4.${randomUUID()}`), requestId)).outcome;
  /** No BOT (or any) request is claimable: the dispatcher claims nothing and makes no transport call. */
  async function nothingClaimable() {
    const transport = new FakeTransport();
    const { claim } = await claimNext(k.dispatchDeps(transport));
    expect(claim).toBeNull();
    expect(transport.calls).toHaveLength(0);
  }

  /** Student A's real first message starts a menuFlow session through first_message: S WAITING_FOR_SEND, prompt R1 QUEUED. */
  async function liveWorld() {
    const f0 = await k.fixture(menuFlow());
    const first = await realInbound(f0, STUDENT_A, text("hi"));
    const f = await fxOf(f0, first);
    finished(await k.run(first.trigger!.id), "PROCESSED", "session_started");
    const [s] = await sessionOf(f);
    const [r1] = await k.botRequests(f);
    expect(s).toMatchObject({
      state: "WAITING_FOR_SEND",
      step_seq: 1,
      deployment_id: f.deployment.id,
    });
    expect(r1).toMatchObject({ state: "QUEUED", bot_step_seq: 1 });
    return { f0, f, s: s!, r1: r1!, first };
  }
  /** The prompt of the session's current step is accepted and reconciled: WAITING_FOR_INPUT; returns its token. */
  async function acceptPrompt(f: RuntimeFx, requestId: string) {
    expect(await send(requestId)).toBe("accepted");
    const [s] = await sessionOf(f);
    expect(await k.reconcile(s!)).toMatchObject({
      kind: "applied",
      finalState: "WAITING_FOR_INPUT",
    });
    return (await sessionOf(f))[0]!.awaiting_token as string;
  }

  // ------------------------------------------------------------------------------------------------ cases

  it("Pause New Sessions: the live session keeps accepting input and its queued and new output is dispatched; a pending start is deployment_not_active; a new conversation gets no trigger; nothing is suppressed", async () => {
    const x = await liveWorld();
    // student B writes while the deployment is still ACTIVE: a start trigger is captured, its T1 has not run yet
    const b = await realInbound(x.f0, STUDENT_B, text("hi"));
    expect(b.trigger).toMatchObject({ status: "PENDING" });
    const before = await deployment(x.f);

    expect((await pause(x.f)).applied).toBe(true);
    const paused = await deployment(x.f);
    expect(paused).toMatchObject({
      status: "PAUSED",
      send_epoch: before.send_epoch, // pause is not a Stop: no epoch bump
      start_eligible_from: before.start_eligible_from,
    });
    expect(await k.request(x.r1.id as string)).toMatchObject({
      state: "QUEUED",
      hold_reason: null,
    });
    expect((await sessionOf(x.f))[0]).toMatchObject({
      state: "WAITING_FOR_SEND",
      output_suppressed_at: null,
    });

    // no new session under PAUSED (H.2 rule 8)
    finished(await k.run(b.trigger!.id), "IGNORED", "deployment_not_active");
    expect(await sessionOf(await fxOf(x.f0, b))).toEqual([]);

    // previously authorized output is dispatched; the session continues; its new output is queued and dispatched
    const token = await acceptPrompt(x.f, x.r1.id as string);
    const reply = await realInbound(x.f0, STUDENT_A, tap(token, "a"));
    expect(reply.trigger).toMatchObject({ status: "PENDING" }); // admitted: a live session of this PAUSED deployment
    finished(await k.run(reply.trigger!.id), "PROCESSED", "input_accepted");
    const [s] = await sessionOf(x.f);
    expect(s).toMatchObject({ state: "WAITING_FOR_SEND", step_seq: 2, last_consumed_token: token });
    const r2 = (await k.botRequests(x.f))[1]!;
    expect(r2).toMatchObject({ state: "QUEUED", bot_step_seq: 2 });
    expect(await send(r2.id as string)).toBe("accepted");

    // a conversation with no live session: the message is stored (Inbox), no trigger is admitted
    const c = await realInbound(x.f0, STUDENT_C, text("hi"));
    expect(c.message).toMatchObject({ direction: "INBOUND", type: "TEXT" });
    expect(c.trigger).toBeNull();
    expect(await deploymentEvents(x.f)).toEqual(["ACTIVATED", "PAUSED"]);
  });

  it("graceful drain: under PAUSED the live session runs to its own END, its terminal notice is dispatched, live sessions reach zero; retirement at zero stops nothing and leaves nothing admissible", async () => {
    const x = await liveWorld();
    expect((await pause(x.f)).applied).toBe(true);
    const k1 = await acceptPrompt(x.f, x.r1.id as string);
    finished(
      await k.run((await realInbound(x.f0, STUDENT_A, tap(k1, "a"))).trigger!.id),
      "PROCESSED",
      "input_accepted",
    );
    expect(await liveSessions(x.f)).toBe(1);
    const k2 = await acceptPrompt(x.f, (await k.botRequests(x.f))[1]!.id as string);
    finished(
      await k.run((await realInbound(x.f0, STUDENT_A, tap(k2, "ok"))).trigger!.id),
      "PROCESSED",
      "input_accepted",
    );
    const [s] = await sessionOf(x.f);
    expect(s).toMatchObject({
      state: "COMPLETED",
      end_reason: "flow_end",
      terminal_notice_step_seq: 3,
    });
    expect(await liveSessions(x.f)).toBe(0); // drained
    const notice = (await k.botRequests(x.f))[2]!;
    expect(notice).toMatchObject({ state: "QUEUED", bot_step_seq: 3 });
    expect(await send(notice.id as string)).toBe("accepted"); // a terminal notice is dispatchable under PAUSED

    const epoch = Number((await deployment(x.f)).send_epoch);
    const retired = await retireDeployment(
      x.f.w.admin.ctx,
      {
        deploymentId: x.f.deployment.id,
        expectedLiveSessions: 0,
        confirmBotKey: await botKey(x.f),
      },
      { db: t.db },
    );
    expect(retired.value).toMatchObject({
      sessionsStopped: 0,
      requestsSuppressed: 0,
      requestsInFlight: 0,
    });
    expect(await deployment(x.f)).toMatchObject({ status: "RETIRED", send_epoch: epoch + 1 });
    expect(await sessionOf(x.f)).toEqual([s]); // the completed session is untouched
    expect(await k.request(notice.id as string)).toMatchObject({ state: "ACCEPTED" });

    const again = await realInbound(x.f0, STUDENT_A, text("menu"));
    expect(again.trigger).toBeNull(); // RETIRED: no trigger insertion
    await expect(resume(x.f)).rejects.toBeInstanceOf(BotControlError); // retirement is terminal
    expect(await deploymentEvents(x.f)).toEqual(["ACTIVATED", "PAUSED", "RETIRED"]);
  });

  it("resume restarts start_eligible_from: a start trigger enqueued before the resume is before_activation; one enqueued after it starts a session", async () => {
    const f0 = await k.fixture(menuFlow());
    const early = await realInbound(f0, STUDENT_A, text("hi")); // captured while ACTIVE; its T1 has not run
    const f = await fxOf(f0, early);
    expect((await pause(f)).applied).toBe(true);
    expect((await resume(f)).applied).toBe(true);
    expect(await deployment(f)).toMatchObject({ status: "ACTIVE" });
    expect(
      (
        await k.one(
          "select t.enqueued_at < d.start_eligible_from before from bot_triggers t, bot_deployments d where t.id = $1 and d.id = $2",
          [early.trigger!.id, f.deployment.id],
        )
      ).before,
    ).toBe(true);
    finished(await k.run(early.trigger!.id), "IGNORED", "before_activation");
    expect(await sessionOf(f)).toEqual([]);

    const fresh = await realInbound(f0, STUDENT_A, text("menu")); // keyword; "hi" stays the first eligible message
    finished(await k.run(fresh.trigger!.id), "PROCESSED", "session_started");
    const [s, ...more] = await sessionOf(f);
    expect(more).toEqual([]);
    expect(s).toMatchObject({
      started_by_message_id: fresh.message.id,
      deployment_id: f.deployment.id,
    });
    expect(await deploymentEvents(f)).toEqual(["ACTIVATED", "PAUSED", "RESUMED"]);
  });

  it("Stop while PAUSED takes precedence: the session is handed over and its queued request held; resume revives neither (nothing is claimable) and the next message cannot restart before a staff resolution", async () => {
    const x = await liveWorld();
    expect((await pause(x.f)).applied).toBe(true);
    const epoch = Number((await deployment(x.f)).send_epoch);
    const stopped = await stopActiveSessions(
      x.f.w.admin.ctx,
      { deploymentId: x.f.deployment.id, expectedLiveSessions: 1 },
      { db: t.db },
    );
    expect(stopped.value).toMatchObject({ sessionsStopped: 1, requestsSuppressed: 1 });
    expect(await deployment(x.f)).toMatchObject({ status: "PAUSED", send_epoch: epoch + 1 });
    const [s] = await sessionOf(x.f);
    expect(s).toMatchObject({
      state: "HANDED_OVER",
      end_reason: "system_handover",
      handover_reason: "operator_stop",
      awaiting_token: null,
    });
    expect(s!.output_suppressed_at).toBeTruthy();
    expect(await k.request(x.r1.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "bot_stopped",
    });
    const stoppedRequest = await k.requestJson(x.r1.id as string);
    const stoppedSession = await k.sessionJson(s!.id as string);

    expect((await resume(x.f)).applied).toBe(true);
    expect(await deployment(x.f)).toMatchObject({ status: "ACTIVE", send_epoch: epoch + 1 }); // resume keeps the epoch
    await nothingClaimable();
    expect(await k.requestJson(x.r1.id as string)).toEqual(stoppedRequest);
    expect(await k.sessionJson(s!.id as string)).toEqual(stoppedSession);
    const sAfter = stoppedSession;

    const next = await realInbound(x.f0, STUDENT_A, text("menu"));
    expect(next.trigger).toMatchObject({ status: "PENDING" }); // captured: the deployment is ACTIVE again
    finished(await k.run(next.trigger!.id), "IGNORED", "handover_unresolved");
    expect(await sessionOf(x.f)).toHaveLength(1);
    expect(await k.sessionJson(s!.id as string)).toEqual(sAfter);
    expect(await k.botRequests(x.f)).toHaveLength(1);
    expect(await deploymentEvents(x.f)).toEqual([
      "ACTIVATED",
      "PAUSED",
      "SESSIONS_STOPPED",
      "RESUMED",
    ]);
  });

  it("Retire with a live session stops it first in the same transaction: handed over, queued request held, epoch bumped; a pending input never continues it; nothing new is admitted; resume is refused", async () => {
    const x = await liveWorld();
    // the student taps while the prompt is still QUEUED: captured (a live session exists), not yet processed
    const pendingTap = await realInbound(x.f0, STUDENT_A, tap(x.s.awaiting_token as string, "a"));
    expect(pendingTap.trigger).toMatchObject({ status: "PENDING" });
    const epoch = Number((await deployment(x.f)).send_epoch);

    const retired = await retireDeployment(
      x.f.w.admin.ctx,
      {
        deploymentId: x.f.deployment.id,
        expectedLiveSessions: 1,
        confirmBotKey: await botKey(x.f),
      },
      { db: t.db },
    );
    expect(retired.value).toMatchObject({ sessionsStopped: 1, requestsSuppressed: 1 });
    expect(await deployment(x.f)).toMatchObject({ status: "RETIRED", send_epoch: epoch + 1 });
    const [s] = await sessionOf(x.f);
    expect(s).toMatchObject({ state: "HANDED_OVER", handover_reason: "operator_stop" });
    expect(s!.output_suppressed_at).toBeTruthy();
    expect(await k.request(x.r1.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "bot_stopped",
    });
    await nothingClaimable();
    const sAfter = await k.sessionJson(s!.id as string);

    // the session is no longer live: the tap takes the start path, which an unresolved handover refuses (rule 2 precedes the
    // deployment rule 8); the session row is untouched and nothing is queued
    finished(await k.run(pendingTap.trigger!.id), "IGNORED", "handover_unresolved");
    expect(await k.sessionJson(s!.id as string)).toEqual(sAfter);
    expect(await k.botRequests(x.f)).toHaveLength(1);
    expect(await triggerRow(t, pendingTap.trigger!.id)).toMatchObject({
      status: "IGNORED",
      session_id: null,
    });

    const later = await realInbound(x.f0, STUDENT_A, text("menu"));
    expect(later.trigger).toBeNull(); // RETIRED and no live session: no trigger insertion
    await expect(resume(x.f)).rejects.toBeInstanceOf(BotControlError);
    expect(await deploymentEvents(x.f)).toEqual(["ACTIVATED", "RETIRED"]);
  });
});
