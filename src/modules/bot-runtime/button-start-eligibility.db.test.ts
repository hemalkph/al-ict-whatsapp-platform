import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { readFirstEligibleRows } from "@/db/ops/bot-step";
import { changeConversationStatus } from "@/modules/inbox";
import { submitOutboundMessage } from "@/modules/messaging/submit";
import { ON, addTemplate } from "@/modules/messaging/testing";
import {
  deliver,
  handlerContext,
  type DeliverOptions,
  type StoredEvent,
} from "@/modules/whatsapp/inbound/testing";
import { buildWebhookWorkerHandlers } from "@/modules/whatsapp/worker/registry";
import type { StepSummary } from "./context";
import { messageFlow, runtimeKit, triggerRow, type RuntimeFx } from "./testing";

// E-BTNSTART (Phase 08E-9 Batch 1; plan N.2 E-BTNSTART, flag AC-2, owner decisions C-1/C-2) on disposable PostgreSQL 17.
// A template quick reply (inbound BUTTON) may be the conversation's first eligible message (C-1), "first" is first EVER (C-2),
// a staff template keeps staff engaged until a resolution (H.2 rule 2), staff OUTBOUND templates and inbound media are not
// eligible inbound history, and a BUTTON that was ignored while staff were engaged still counts as prior eligible history.
//
// Every hop is real: inbound IMAGE and BUTTON messages go through the real ingest and the real webhook-worker handler with
// trigger capture built from an explicit { BOTS_RUNTIME_ENABLED: "true" } object; the staff template is the real STAFF
// submission (sent by the real dispatcher with a FakeTransport); the resolution is the real Inbox status change; the start
// decision is the real T1 start path. LOGICAL CLOCK (plan N.2a): the 30-minute cooldown after the resolution cannot be waited
// out, so the captured BUTTON's input time and the T1 decision clock advance together by SHIFT; control sequences, record
// order and every database-stamped time stay real.

const MIN = 60_000;
const SHIFT = 31 * MIN;
const FROM = "15550100123";
const FIRST_MESSAGE = { kind: "first_message" } as const;

describe("E-BTNSTART: a BUTTON as the first eligible message (AC-2)", () => {
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
  const conv = (f: RuntimeFx) => f.w.student.conversation.id;

  /** One student message through the real ingest and the real capture-enabled handler (provider time: DB clock + 1 s). */
  async function realInbound(f: RuntimeFx, message: Row): Promise<Real> {
    const account = await k.one(
      "select phone_number_id, waba_id from whatsapp_accounts where id = $1",
      [f.w.account.id],
    );
    const dbMs = ((await k.one("select clock_timestamp() t")).t as Date).getTime();
    const options: DeliverOptions = {
      id: `wamid.TEST08E9B.${randomUUID()}`,
      from: FROM,
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
  const image = { type: "image", image: { id: "MEDIA08E9B0001", mime_type: "image/jpeg" } };
  const button = (text: string) => ({
    type: "button",
    button: { payload: `PAYLOAD_${text}`, text },
  });

  /** The deployed first_message flow, and the conversation the real handler created for the student's first (IMAGE) message. */
  async function mediaFirstWorld() {
    const f0 = await k.fixture(messageFlow(FIRST_MESSAGE));
    const media = await realInbound(f0, image);
    expect(media.message).toMatchObject({ direction: "INBOUND", type: "IMAGE" });
    expect(media.trigger).toBeNull(); // not capturable (V3.2 H.1): it can never start or continue a bot
    const c = await k.one("select id, contact_id from conversations where id = $1", [
      media.message.conversation_id,
    ]);
    const f: RuntimeFx = {
      ...f0,
      w: {
        ...f0.w,
        student: {
          contact: { id: c.contact_id as string },
          conversation: { id: c.id as string },
          message: { id: media.message.id },
        },
      },
    };
    return { f, media };
  }
  /** The real STAFF template submission, then sent by the real dispatcher (FakeTransport): staff engagement (H.2 rule 2 O). */
  async function staffTemplate(f: RuntimeFx) {
    const template = await addTemplate(t.db, { org: f.w.org, account: f.w.account }); // UTILITY, APPROVED, no parameters
    const submitted = await submitOutboundMessage(
      f.w.staff.ctx,
      {
        idempotencyKey: `tpl-key-${randomUUID()}`,
        conversationId: conv(f),
        message: { type: "template", templateId: template.id, parameters: [] },
      },
      { db: t.db as never, config: ON, now: () => new Date() },
    );
    const { outcome } = await k.dispatchWith(
      k.accepted(`wamid.TEST08E9B.STAFF.${randomUUID()}`),
      submitted.requestId,
    );
    expect(outcome).toBe("accepted");
    const request = await k.request(submitted.requestId);
    expect(request).toMatchObject({ origin: "STAFF", message_type: "TEMPLATE", state: "ACCEPTED" });
    return { requestId: submitted.requestId, seq: Number(request.control_seq) };
  }
  async function resolve(f: RuntimeFx) {
    await changeConversationStatus(
      f.w.staff.ctx,
      conv(f),
      { to: "RESOLVED", expected: "OPEN" },
      { db: t.db as never },
    );
    const r = await k.one(
      "select control_seq::int seq from conversation_events where conversation_id = $1 and kind = 'STATUS' and to_status = 'RESOLVED' order by control_seq desc limit 1",
      [conv(f)],
    );
    return Number(r.seq);
  }
  const status = async (f: RuntimeFx) =>
    (await k.one("select status from conversations where id = $1", [conv(f)])).status as string;
  /** The logical clock: the captured trigger's input advances with the decision clock (rule 6 cooldown cleared, nothing else). */
  async function runShifted(triggerId: string): Promise<StepSummary> {
    await k.q(
      "update bot_triggers set input_occurred_at = input_occurred_at + $2 * interval '1 millisecond' where id = $1 and status = 'PENDING'",
      [triggerId, SHIFT],
    );
    return k.run(triggerId, { readClock: k.shifted(SHIFT) });
  }
  const firstFacts = (f: RuntimeFx, messageId: string) =>
    t.db.transaction((tx) =>
      readFirstEligibleRows(tx as never, {
        organizationId: f.w.org.id,
        conversationId: conv(f),
        messageId,
      }),
    );
  const sessionsOf = (f: RuntimeFx) =>
    k.rows("select * from bot_sessions where conversation_id = $1 order by started_control_seq", [
      conv(f),
    ]);
  /** The conversation's inbound history in database record order (created_at, id): the order first_message uses. */
  const recordOrder = async (f: RuntimeFx) =>
    (
      await k.rows(
        "select id, type from messages where conversation_id = $1 and direction = 'INBOUND' order by created_at, id",
        [conv(f)],
      )
    ).map((m) => `${m.type as string}:${m.id as string}`);
  function finished(summary: StepSummary, s: "PROCESSED" | "IGNORED", outcome: string) {
    expect(summary).toMatchObject({ kind: "finished", status: s, outcome });
  }

  // ------------------------------------------------------------------------------------------------ cases

  it("a staff template blocks a BUTTON that arrives before the resolution (staff_engaged); that BUTTON stays prior eligible history, so a later BUTTON after the resolution and cooldown is not first", async () => {
    const { f, media } = await mediaFirstWorld();
    const tpl = await staffTemplate(f);

    const b1 = await realInbound(f, button("Yes"));
    expect(b1.message).toMatchObject({ direction: "INBOUND", type: "BUTTON" });
    expect(Number(b1.trigger!.observed_control_seq)).toBe(tpl.seq);
    // before any decision, B1 IS the first eligible message (the IMAGE and the staff template do not count)
    expect(await firstFacts(f, b1.message.id)).toEqual({
      firstInRecordHistory: true,
      noPreviousSessionStart: true,
      evidenceDefect: false,
    });
    finished(await k.run(b1.trigger!.id), "IGNORED", "staff_engaged"); // H.2 rule 2: O = the template, no later resolution
    expect(await sessionsOf(f)).toEqual([]);
    expect(await k.botRequests(f)).toEqual([]);

    const r = await resolve(f);
    expect(r).toBeGreaterThan(tpl.seq);
    const b2 = await realInbound(f, button("Yes"));
    expect(await status(f)).toBe("OPEN"); // the real handler reopened the resolved conversation
    expect(Number(b2.trigger!.observed_control_seq)).toBe(r);
    expect(await recordOrder(f)).toEqual([
      `IMAGE:${media.message.id}`,
      `BUTTON:${b1.message.id}`,
      `BUTTON:${b2.message.id}`,
    ]);
    expect(await firstFacts(f, b2.message.id)).toEqual({
      firstInRecordHistory: false, // the ignored B1 precedes it
      noPreviousSessionStart: true,
      evidenceDefect: false,
    });
    // no_trigger_match is rule 10: every staff, freshness, cooldown, cap, deployment and tenant rule (1-9) passed before it
    finished(await runShifted(b2.trigger!.id), "IGNORED", "no_trigger_match");
    expect(await sessionsOf(f)).toEqual([]);
    expect(await k.botRequests(f)).toEqual([]);
    expect(await triggerRow(t, b1.trigger!.id)).toMatchObject({
      status: "IGNORED",
      session_id: null,
    });
  });

  it("with only staff OUTBOUND templates and inbound media before the resolution, the first BUTTON after it and the cooldown starts the session; a later BUTTON is never first", async () => {
    const { f, media } = await mediaFirstWorld();
    const tpl = await staffTemplate(f);
    const r = await resolve(f);
    expect(r).toBeGreaterThan(tpl.seq);

    const b1 = await realInbound(f, button("Join"));
    expect(await status(f)).toBe("OPEN");
    expect(Number(b1.trigger!.observed_control_seq)).toBe(r);
    expect(await firstFacts(f, b1.message.id)).toEqual({
      firstInRecordHistory: true,
      noPreviousSessionStart: true,
      evidenceDefect: false,
    });
    finished(await runShifted(b1.trigger!.id), "PROCESSED", "session_started");
    const [s, ...more] = await sessionsOf(f);
    expect(more).toEqual([]);
    expect(s).toMatchObject({
      started_by_message_id: b1.message.id,
      last_input_message_id: b1.message.id,
      deployment_id: f.deployment.id,
      contact_id: f.w.student.contact.id,
      state: "WAITING_FOR_SEND",
      step_seq: 1,
    });
    expect(Number(s!.started_control_seq)).toBe(r + 1);
    expect(await k.events(s!.id as string)).toEqual([]); // the BUTTON is the start, never replayed as an input
    const [r1, ...others] = await k.botRequests(f);
    expect(others).toEqual([]);
    expect(r1).toMatchObject({
      bot_session_id: s!.id,
      bot_step_seq: 1,
      state: "QUEUED",
      origin: "BOT",
    });

    // the session runs to its end (MESSAGE accepted -> END notice accepted). Its times derive from the shifted decision clock,
    // so the dispatcher and the reconciler run on the same logical clock
    const logicalDispatch = (requestId: string) =>
      k.dispatchWith(k.accepted(`wamid.TEST08E9B.${randomUUID()}`), requestId, {
        now: () => new Date(Date.now() + SHIFT + 1_000),
      });
    expect((await logicalDispatch(r1!.id as string)).outcome).toBe("accepted");
    expect(await k.reconcile(s!, { readClock: k.shifted(SHIFT) })).toMatchObject({
      kind: "applied",
      finalState: "COMPLETED",
    });
    const notice = (await k.botRequests(f))[1]!;
    expect(notice).toMatchObject({ bot_session_id: s!.id, bot_step_seq: 2, state: "QUEUED" });
    expect((await logicalDispatch(notice.id as string)).outcome).toBe("accepted");
    expect((await sessionsOf(f))[0]).toMatchObject({
      state: "COMPLETED",
      end_reason: "flow_end",
      terminal_notice_step_seq: 2,
    });

    const b2 = await realInbound(f, button("Join"));
    expect(await recordOrder(f)).toEqual([
      `IMAGE:${media.message.id}`,
      `BUTTON:${b1.message.id}`,
      `BUTTON:${b2.message.id}`,
    ]);
    expect(await firstFacts(f, b2.message.id)).toEqual({
      firstInRecordHistory: false,
      noPreviousSessionStart: false,
      evidenceDefect: false,
    });
    finished(await runShifted(b2.trigger!.id), "IGNORED", "no_trigger_match");
    expect(await sessionsOf(f)).toHaveLength(1);
    expect(await k.botRequests(f)).toHaveLength(2);
  });
});
