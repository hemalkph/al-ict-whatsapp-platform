import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { enquiryFlow, generalInfoFlow, type Json } from "@/modules/bots/testing";
import { assignConversation } from "@/modules/inbox";
import { MetaTransport, type HttpPost } from "@/modules/messaging/meta-transport";
import { TEST_APP_SECRET } from "@/modules/whatsapp/testing";
import {
  activateDeployment,
  changeDeploymentVersion,
  pauseDeployment,
  publishVersion,
  stopActiveSessions,
  updateDraft,
} from "../bot-control";
import { BOTS_ON, publishedBot, shortenRetention } from "../bot-control/testing";
import { reconcileSession } from "./reconcile";
import { closedLoopKit, type LoopWorld, type SentMessage } from "./testing";

// Phase 08G-1, GI-CL-1 .. GI-CL-13 and GI-CL-15 of docs/PHASE_08G-1_APPROVAL_ADDENDUM.md: the SYNTHETIC General Information golden
// flow (generalInfoFlow, src/modules/bots/testing.ts) through the REAL closed loop of the Student enquiry suite
// (closedLoopKit: signed webhook -> ingest -> webhook worker with capture -> bot worker -> dispatcher -> FakeTransport), on a
// disposable PostgreSQL 17 database only. Nothing here can reach Meta. The tests are WRITTEN BUT NOT YET EXECUTED (they need
// owner-authorized isolated database validation). GI-CL-14 (internal engine error) is NOT implemented: see the addendum, section
// 5, for the test-design blocker; the engine contract itself is pinned by the database-free simulator regression.

type Node = Record<string, unknown> & { type: string };
const FLOW = generalInfoFlow();
const NODES = FLOW.nodes as Record<string, Node>;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const MIN = 60_000;

const textOf = (body: string) => ({ type: "text", body, replyToWamid: null });
const nodeText = (nodeId: string) =>
  textOf((NODES[nodeId]!.text ?? NODES[nodeId]!.message) as string);

/** The prompt token of a captured interactive message (every option id carries the same one). */
function tokenOf(m: SentMessage): string {
  if (m.request.message.type !== "interactive") throw new Error("not a prompt");
  const p = m.request.message.payload;
  const ids = (p.kind === "buttons" ? p.buttons : p.sections.flatMap((s) => s.rows)).map(
    (o) => o.id,
  );
  const tokens = new Set(ids.map((id) => id.split(".")[1]));
  expect(tokens.size).toBe(1);
  return [...tokens][0]!;
}

/** The exact payload the flow node must produce for `token`, built from the fixture, not from the capture. */
function expectedPrompt(nodeId: string, token: string) {
  const n = NODES[nodeId]!;
  const options = (n.options as Array<Record<string, string>>).map((o) => ({
    id: `b1.${token}.${o.key}`,
    title: o.title,
    ...(o.description === undefined ? {} : { description: o.description }),
  }));
  const footer = n.footer === undefined ? {} : { footer: n.footer };
  return n.type === "BUTTONS"
    ? {
        type: "interactive",
        payload: { v: 1, kind: "buttons", body: n.body, ...footer, buttons: options },
      }
    : {
        type: "interactive",
        payload: {
          v: 1,
          kind: "list",
          body: n.body,
          buttonLabel: n.buttonLabel,
          ...footer,
          sections: [{ title: n.buttonLabel, rows: options }],
        },
      };
}

/** One expected outbound message: a prompt of a node (token checked) or the exact text of a node. */
type Out = { prompt: string } | { text: ReturnType<typeof textOf> };
const P = (nodeId: string): Out => ({ prompt: nodeId });
const T = (nodeId: string): Out => ({ text: nodeText(nodeId) });

const TOPIC_ONE = "[TEST] Topic one";
const TOPIC_TWO = "[TEST] Topic two";

describe("closed loop: General Information (SYNTHETIC golden flow), 08G-1", () => {
  let t: TestDb;
  let k: ReturnType<typeof closedLoopKit>;
  let phoneSeq = 0;

  beforeAll(async () => {
    t = await createTestDatabase({
      sessionTimeouts: {
        lock_timeout: 15_000,
        statement_timeout: 20_000,
        idle_in_transaction_session_timeout: 25_000,
      },
    });
    k = closedLoopKit(t);
  });
  afterAll(async () => {
    await k?.close();
    await t?.close();
  });
  beforeEach(() => {
    vi.stubEnv("META_APP_SECRET", TEST_APP_SECRET); // the signed route reads it; process-local, test-only
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------------------------------------ conversation driver

  /** A second student in the same organization and account (a fresh contact; the first webhook creates the conversation). */
  const anotherStudent = (x: LoopWorld): LoopWorld => ({
    ...x,
    phone: `9478${String(Date.now() % 1e7).padStart(7, "0")}${++phoneSeq % 10}`,
  });

  /** The student's text through the real signed route; the whole loop then runs until nothing is left to do. */
  async function say(x: LoopWorld, body: string) {
    const { bytes, wamid } = k.studentBytes(x, k.textMessage(body));
    expect(await k.post(bytes)).toBe(200);
    await k.settle();
    return wamid;
  }
  /** The first message: the session id once the welcome and the topic list were accepted. */
  async function start(x: LoopWorld, body = "info") {
    await say(x, body);
    const [s, ...more] = await k.sessionsOf(x);
    expect(more).toEqual([]);
    return s!.id as string;
  }
  /** Taps the option titled `title` on the LAST captured prompt: its real id and the real prompt wamid go back. */
  async function tap(x: LoopWorld, title: string) {
    const prompt = k.sentTo(x).at(-1)!;
    const option = k.optionsOf(prompt).get(title);
    if (!option) throw new Error(`no option titled ${title}`);
    const subtype =
      prompt.request.message.type === "interactive" &&
      prompt.request.message.payload.kind === "list"
        ? "list_reply"
        : "button_reply";
    const { bytes, wamid } = k.studentBytes(x, k.tapMessage(option, subtype, prompt.wamid));
    expect(await k.post(bytes)).toBe(200);
    await k.settle();
    return wamid;
  }

  /** The whole transcript the fake provider received for this student, and every durable BOT request behind it. */
  async function expectTranscript(x: LoopWorld, sessionId: string, expected: Out[]) {
    const sent = k.sentTo(x);
    expect(sent).toHaveLength(expected.length);
    const tokens: string[] = [];
    sent.forEach((m, i) => {
      const e = expected[i]!;
      expect(m.request).toMatchObject({
        phoneNumberId: x.pn,
        credentialRef: "WA_TOKEN_TEST",
        recipient: { kind: "PHONE", id: x.phone },
      });
      if ("prompt" in e) {
        const token = tokenOf(m);
        expect(token).toMatch(TOKEN);
        tokens.push(token);
        expect(m.request.message).toEqual(expectedPrompt(e.prompt, token));
      } else expect(m.request.message).toEqual(e.text);
    });
    expect(new Set(tokens).size).toBe(tokens.length); // every prompt has a fresh token
    const requests = await k.rows(
      `select r.*, m.wamid from outbound_requests r join messages m on m.id = r.message_id
        where r.organization_id = $1 and r.bot_session_id = $2 order by r.bot_step_seq`,
      [x.w.org.id, sessionId],
    );
    expect(requests.map((r) => r.bot_step_seq)).toEqual(expected.map((_, i) => i + 1));
    expect(requests.map((r) => r.idempotency_key)).toEqual(
      expected.map((_, i) => `bot-${sessionId}-${i + 1}`),
    );
    expect(requests.map((r) => [r.origin, r.state, r.attempt_count])).toEqual(
      expected.map(() => ["BOT", "ACCEPTED", 1]),
    );
    expect(requests.map((r) => r.wamid)).toEqual(sent.map((m) => m.wamid));
    expect(await k.requestsOf(x)).toHaveLength(expected.length); // no request outside the session
    expect(k.transport.calls.filter((c) => c.recipient.id === x.phone)).toHaveLength(
      expected.length,
    );
    return { sent, tokens };
  }

  /** Every inbound message has exactly one trigger, with these outcomes (in arrival order). */
  async function expectTriggers(x: LoopWorld, outcomes: string[]) {
    const inbound = await k.inboundOf(x);
    const triggers = await k.triggersOf(x);
    expect(triggers.map((tr) => tr.message_id)).toEqual(inbound.map((m) => m.id));
    expect(triggers.map((tr) => tr.outcome_code)).toEqual(outcomes);
    return inbound;
  }
  const eventRows = async (sessionId: string) =>
    (await k.eventsOf(sessionId)).map((e) => [e.kind, e.code]);

  /** Every durable count for this student plus the provider calls. */
  async function counts(x: LoopWorld) {
    const sessions = await k.sessionsOf(x);
    const requests = await k.requestsOf(x);
    return {
      inbound: (await k.inboundOf(x)).length,
      triggers: (await k.triggersOf(x)).length,
      sessions: sessions.length,
      botRequests: requests.filter((r) => r.origin === "BOT").length,
      calls: k.transport.calls.filter((c) => c.recipient.id === x.phone).length,
    };
  }
  const assign = async (x: LoopWorld) =>
    assignConversation(
      x.w.staff.ctx,
      (await k.conversationOf(x))!,
      { assigneeMembershipId: x.w.staff.membershipId, expectedAssigneeMembershipId: null },
      { db: t.db as never },
    );

  // ------------------------------------------------------------------------------------------------ GI-CL-1

  it("GI-CL-1: info -> topic one -> Ask another -> topic two (second LIST) -> That's all: eight sends, one END notice, COMPLETED", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x, "info");
    expect(await k.sessionsOf(x)).toMatchObject([
      { state: "WAITING_FOR_INPUT", current_node_id: "topics", step_seq: 2, variables: {} },
    ]);
    await tap(x, TOPIC_ONE);
    await tap(x, "Ask another");
    await tap(x, TOPIC_TWO);
    await tap(x, "That's all");

    await expectTranscript(x, sid, [
      T("welcome"),
      P("topics"),
      T("ans_t1"),
      P("more"),
      P("topics"), // the SECOND list, with a fresh token
      T("ans_t2"),
      P("more"),
      T("bye"),
    ]);
    expect(nodeText("bye")).toEqual(textOf("Thank you. This enquiry is complete."));
    await expectTriggers(x, [
      "session_started",
      "input_accepted",
      "input_accepted",
      "input_accepted",
      "input_accepted",
    ]);
    expect((await eventRows(sid)).filter(([kind]) => kind === "INPUT_ACCEPTED")).toHaveLength(4);
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        id: sid,
        state: "COMPLETED",
        current_node_id: "bye",
        end_reason: "flow_end",
        handover_reason: null,
        terminal_notice_step_seq: 8, // the one END notice is the eighth send
        step_seq: 8,
        awaiting: null,
        variables: {},
      },
    ]);
  });

  // ------------------------------------------------------------------------------------------------ GI-CL-2

  it.each(["faq", "  FAQ  ", "Info"])(
    "GI-CL-2: the keyword %j starts the bot (NFC, trimmed, case-insensitive whole-message match)",
    async (body) => {
      const x = await k.world(FLOW);
      const sid = await start(x, body);
      const [inbound] = await k.inboundOf(x);
      expect(inbound).toMatchObject({ type: "TEXT", body });
      expect(await k.sessionsOf(x)).toMatchObject([
        { id: sid, state: "WAITING_FOR_INPUT", started_by_message_id: inbound!.id },
      ]);
      expect((await k.sentTo(x))[0]!.request.message).toEqual(nodeText("welcome"));
      await expectTriggers(x, ["session_started"]);
    },
  );

  it("GI-CL-2 / A-ISO-2: with Student Enquiry also deployed (lower priority), 'info' starts General Information and a plain first message starts Student Enquiry", async () => {
    const x = await k.world(FLOW); // General Information, priority 1
    const se = await publishedBot(t.db, x.w, enquiryFlow());
    await activateDeployment(
      x.w.admin.ctx,
      {
        botId: se.bot.id,
        versionId: se.version.id,
        whatsappAccountId: x.w.account.id,
        priority: 2,
      },
      { db: t.db },
    );
    const keyword = await start(x, "info");
    const y = anotherStudent(x);
    const plain = await start(y, "Good morning");
    const bots = async (z: LoopWorld) => (await k.sessionsOf(z)).map((s) => s.bot_id);
    expect(await bots(x)).toEqual([x.bot.id]);
    expect(await bots(y)).toEqual([se.bot.id]);
    expect(keyword).not.toBe(plain);
    // The keyword student got the General Information welcome; the plain first message got the language menu.
    expect(k.sentTo(x)[0]!.request.message).toEqual(nodeText("welcome"));
    expect(k.sentTo(y)[0]!.request.message.type).toBe("interactive");
    // No keyword starts a second session while one is live (the live session is selected before start matching).
    await say(x, "hi");
    expect((await k.sessionsOf(x)).map((s) => s.bot_id)).toEqual([x.bot.id]);
  });

  // ------------------------------------------------------------------------------------------------ GI-CL-3, 4

  it("GI-CL-3: Other question hands over as needs_staff with its notice", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await tap(x, "Other question");
    await expectTranscript(x, sid, [T("welcome"), P("topics"), T("needs_staff")]);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_ACCEPTED", null],
      ["HANDED_OVER", "needs_staff"],
    ]);
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        state: "HANDED_OVER",
        current_node_id: "needs_staff",
        end_reason: "flow_handover",
        handover_reason: "needs_staff",
        terminal_notice_step_seq: 3,
      },
    ]);
  });

  it("GI-CL-4: Talk to staff from the list and from the buttons hands over as student_requested", async () => {
    const a = await k.world(FLOW);
    const sa = await start(a);
    await tap(a, "Talk to staff");
    await expectTranscript(a, sa, [T("welcome"), P("topics"), T("to_staff")]);
    expect(await k.sessionsOf(a)).toMatchObject([
      { state: "HANDED_OVER", handover_reason: "student_requested", terminal_notice_step_seq: 3 },
    ]);

    const b = await k.world(FLOW);
    const sb = await start(b);
    await tap(b, "[TEST] Topic four");
    await tap(b, "Talk to staff");
    await expectTranscript(b, sb, [
      T("welcome"),
      P("topics"),
      T("ans_t4"),
      P("more"),
      T("to_staff"),
    ]);
    expect(await k.sessionsOf(b)).toMatchObject([
      { state: "HANDED_OVER", handover_reason: "student_requested", terminal_notice_step_seq: 5 },
    ]);
  });

  // ------------------------------------------------------------------------------------------------ GI-CL-5

  it("GI-CL-5: an invalid reply re-sends the same list with a fresh token, then a valid reply continues", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await say(x, "what is the fee?");
    expect(await k.sessionsOf(x)).toMatchObject([
      { state: "WAITING_FOR_INPUT", current_node_id: "topics", invalid_attempts: 1 },
    ]);
    await tap(x, TOPIC_TWO);
    await expectTranscript(x, sid, [
      T("welcome"),
      P("topics"),
      P("topics"), // the re-prompt
      T("ans_t2"),
      P("more"),
    ]);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_REJECTED", "wrong_kind"],
      ["INPUT_ACCEPTED", null],
    ]);
    expect(await k.sessionsOf(x)).toMatchObject([{ current_node_id: "more", invalid_attempts: 0 }]);
  });

  it("GI-CL-5: two invalid replies hand over as invalid_input with the notice (no second re-prompt)", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await say(x, "??");
    await say(x, "!!");
    await expectTranscript(x, sid, [T("welcome"), P("topics"), P("topics"), T("invalid_to_staff")]);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_REJECTED", "wrong_kind"],
      ["INPUT_REJECTED", "wrong_kind"],
      ["HANDED_OVER", "invalid_input"],
    ]);
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        state: "HANDED_OVER",
        end_reason: "flow_handover",
        handover_reason: "invalid_input",
        terminal_notice_step_seq: 4,
      },
    ]);
  });

  // ------------------------------------------------------------------------------------------------ GI-CL-6

  it.each(["info", "faq", "classes", "payment"])(
    "GI-CL-6: %j typed while the list awaits an answer is invalid input (wrong_kind), re-prompts, and starts no other bot",
    async (keyword) => {
      const x = await k.world(FLOW);
      const sid = await start(x);
      await say(x, keyword);
      await expectTriggers(x, ["session_started", "input_rejected"]);
      expect(await eventRows(sid)).toEqual([["INPUT_REJECTED", "wrong_kind"]]);
      expect(await k.sessionsOf(x)).toMatchObject([
        { id: sid, state: "WAITING_FOR_INPUT", current_node_id: "topics", invalid_attempts: 1 },
      ]);
      await tap(x, TOPIC_ONE); // the same session is still the one answered
      expect((await k.sessionsOf(x)).map((s) => s.id)).toEqual([sid]);
      await expectTranscript(x, sid, [
        T("welcome"),
        P("topics"),
        P("topics"),
        T("ans_t1"),
        P("more"),
      ]);
    },
  );

  it("GI-CL-6: a second keyword while the first prompt is still QUEUED is deferred first, then applied by the live session as wrong_kind", async () => {
    const x = await k.world(FLOW);
    const first = k.studentBytes(x, k.textMessage("info"));
    expect(await k.post(first.bytes)).toBe(200);
    expect((await k.webhookPass()).processed).toBe(1);
    expect((await k.triggerPass()).totals).toMatchObject({ claimed: 1, finished: 1 }); // welcome is QUEUED
    const second = k.studentBytes(x, k.textMessage("faq"));
    expect(await k.post(second.bytes)).toBe(200);
    await k.webhookPass();
    expect((await k.triggerPass()).totals.deferred).toBe(1); // a request is in flight: deferred, not started
    await k.settle();
    expect((await k.triggersOf(x)).map((tr) => tr.outcome_code)).toEqual([
      "session_started",
      "input_rejected",
    ]);
    expect(await counts(x)).toMatchObject({ sessions: 1, botRequests: 3, calls: 3 }); // welcome, topics, re-prompt
  });

  // ------------------------------------------------------------------------------------------------ GI-CL-7

  it("GI-CL-7: a new keyword inside the 30-minute cooldown after END is ignored (cooldown): no request, no call", async () => {
    const x = await k.world(FLOW);
    await start(x);
    await tap(x, TOPIC_ONE);
    await tap(x, "That's all");
    const before = await counts(x);
    expect(before).toMatchObject({ sessions: 1, botRequests: 5, calls: 5 });
    await say(x, "info");
    expect((await k.triggersOf(x)).at(-1)).toMatchObject({
      status: "IGNORED",
      outcome_code: "cooldown",
    });
    expect(await counts(x)).toEqual({
      ...before,
      inbound: before.inbound + 1,
      triggers: before.triggers + 1,
    });
  });

  // ------------------------------------------------------------------------------------------------ GI-CL-8

  it("GI-CL-8a: staff assign while the welcome is QUEUED and the dispatcher reaches it first: HELD staff_took_over, 0 calls, then send_held handover", async () => {
    const x = await k.world(FLOW);
    const first = k.studentBytes(x, k.textMessage("info"));
    expect(await k.post(first.bytes)).toBe(200);
    await k.webhookPass();
    await k.triggerPass();
    await assign(x);
    await k.settle();
    expect(await k.requestsOf(x)).toMatchObject([
      { origin: "BOT", state: "HELD", hold_reason: "staff_took_over" },
    ]);
    expect(await counts(x)).toMatchObject({ sessions: 1, botRequests: 1, calls: 0 });
    expect(await k.sessionsOf(x)).toMatchObject([
      { state: "HANDED_OVER", end_reason: "system_handover", handover_reason: "send_held" },
    ]);
  });

  it("GI-CL-8b / A-SEQ-1: staff assign, then the runtime (the student's next message) wins before the dispatcher: HELD bot_output_suppressed, handover staff_assigned, control sequences ordered", async () => {
    const x = await k.world(FLOW);
    const first = k.studentBytes(x, k.textMessage("info"));
    expect(await k.post(first.bytes)).toBe(200);
    await k.webhookPass();
    await k.triggerPass(); // the session exists; its welcome is QUEUED and nothing was dispatched
    await assign(x);
    const next = k.studentBytes(x, k.textMessage("hello?"));
    expect(await k.post(next.bytes)).toBe(200);
    await k.webhookPass();
    await k.triggerPass(); // T1 sees the staff event after the session start: hand over and suppress
    await k.dispatchPass();
    const [r] = await k.requestsOf(x);
    expect(r).toMatchObject({ origin: "BOT", state: "HELD", hold_reason: "bot_output_suppressed" });
    expect(await counts(x)).toMatchObject({ sessions: 1, botRequests: 1, calls: 0 });
    const [s] = await k.sessionsOf(x);
    expect(s).toMatchObject({
      state: "HANDED_OVER",
      end_reason: "system_handover",
      handover_reason: "staff_assigned",
      awaiting: null,
      awaiting_token: null,
      terminal_notice_step_seq: null,
    });
    expect(s!.output_suppressed_at).toBeInstanceOf(Date);
    const staffSeq = Number(
      (await k.one(
        "select max(control_seq) s from conversation_events where conversation_id = $1 and kind = 'ASSIGNMENT'",
        [(await k.conversationOf(x))!],
      ))!.s,
    );
    expect(staffSeq).toBeGreaterThan(Number(s!.started_control_seq));
    expect(Number(s!.handover_control_seq)).toBeGreaterThan(staffSeq);
    expect((await k.triggersOf(x)).map((tr) => [tr.status, tr.outcome_code])).toEqual([
      ["PROCESSED", "session_started"],
      ["IGNORED", "session_ended"],
    ]);
    await k.settle(); // nothing is left to send
    expect(await counts(x)).toMatchObject({ botRequests: 1, calls: 0 });
  });

  // ------------------------------------------------------------------------------------------------ GI-CL-9

  it("GI-CL-9: operator Stop hands the live session over (operator_stop) and nothing more is sent", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    const stop = await stopActiveSessions(
      x.w.admin.ctx,
      { deploymentId: x.deployment.id, expectedLiveSessions: 1 },
      { db: t.db as never },
    );
    expect(stop.value).toMatchObject({ sessionsStopped: 1, requestsSuppressed: 0 });
    const before = await counts(x);
    await tap(x, TOPIC_ONE);
    expect((await k.sessionsOf(x))[0]).toMatchObject({
      id: sid,
      state: "HANDED_OVER",
      handover_reason: "operator_stop",
    });
    expect(
      (await k.one("select status from bot_deployments where id = $1", [x.deployment.id]))!.status,
    ).toBe("PAUSED");
    expect(await counts(x)).toMatchObject({
      inbound: before.inbound + 1,
      triggers: before.triggers, // no ACTIVE deployment: capture admits nothing
      sessions: 1,
      botRequests: before.botRequests,
      calls: before.calls,
    });
  });

  it("GI-CL-9: Pause drains the live session to completion and refuses a new student's keyword", async () => {
    const x = await k.world(FLOW);
    await start(x);
    await pauseDeployment(x.w.admin.ctx, { deploymentId: x.deployment.id }, { db: t.db });
    await tap(x, TOPIC_ONE); // the pinned live session still finishes its step
    await tap(x, "That's all");
    expect((await k.sessionsOf(x))[0]).toMatchObject({
      state: "COMPLETED",
      end_reason: "flow_end",
    });
    const y = anotherStudent(x);
    await say(y, "info");
    expect(await k.triggersOf(y)).toEqual([]); // no ACTIVE deployment and no live session: no trigger
    expect(await counts(y)).toMatchObject({ sessions: 0, botRequests: 0, calls: 0 });
  });

  // ------------------------------------------------------------------------------------------------ GI-CL-10

  it("GI-CL-10: the same keyword in two organizations gives independent sessions; a reply from the other organization's prompt is rejected", async () => {
    const a = await k.world(FLOW);
    const b = await k.world(FLOW);
    const sa = await start(a);
    const sb = await start(b);
    expect(a.w.org.id).not.toBe(b.w.org.id);
    const orgOf = async (id: string) =>
      (await k.one(
        "select organization_id, bot_id, deployment_id from bot_sessions where id = $1",
        [id],
      ))!;
    expect(await orgOf(sa)).toMatchObject({
      organization_id: a.w.org.id,
      bot_id: a.bot.id,
      deployment_id: a.deployment.id,
    });
    expect(await orgOf(sb)).toMatchObject({
      organization_id: b.w.org.id,
      bot_id: b.bot.id,
      deployment_id: b.deployment.id,
    });
    expect(
      (
        await k.rows(
          "select distinct organization_id from outbound_requests where bot_session_id = $1",
          [sa],
        )
      ).map((r) => r.organization_id),
    ).toEqual([a.w.org.id]);
    // B's real option and prompt wamid, sent by A's student: rejected by A's session, B's session untouched.
    const promptB = k.sentTo(b).at(-1)!;
    const bBefore = (await k.sessionsOf(b))[0]!;
    const foreign = k.studentBytes(
      a,
      k.tapMessage(k.optionsOf(promptB).get(TOPIC_ONE)!, "list_reply", promptB.wamid),
    );
    expect(await k.post(foreign.bytes)).toBe(200);
    await k.settle();
    expect((await k.triggersOf(a)).at(-1)).toMatchObject({ outcome_code: "input_rejected" });
    expect((await k.sessionsOf(a))[0]).toMatchObject({
      id: sa,
      state: "WAITING_FOR_INPUT",
      invalid_attempts: 1,
    });
    expect((await k.sessionsOf(b))[0]).toEqual(bBefore);
    expect(await k.triggersOf(b)).toHaveLength(1);
    // B's own student can still continue.
    await tap(b, TOPIC_ONE);
    expect((await k.sessionsOf(b))[0]).toMatchObject({ id: sb, current_node_id: "more" });
  });

  // ------------------------------------------------------------------------------------------------ GI-CL-11

  it("GI-CL-11: a version published and switched mid-session does not change the live session; a new student gets the new version", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    const v1 = x.version.id;
    const changed = structuredClone(FLOW) as Json;
    (changed.nodes as Record<string, Json>).ans_t1!.text =
      "[SYNTHETIC TEST ANSWER 1 v2] This is placeholder text for automated tests. It is not real A/L ICT information.";
    const deps = { db: t.db };
    await updateDraft(
      x.w.admin.ctx,
      { botId: x.bot.id, expectedRevision: 1, config: changed },
      deps,
    );
    const v2 = (await publishVersion(x.w.admin.ctx, { botId: x.bot.id, expectedRevision: 2 }, deps))
      .value;
    await changeDeploymentVersion(
      x.w.admin.ctx,
      { deploymentId: x.deployment.id, versionId: v2.id },
      deps,
    );
    await tap(x, TOPIC_ONE);
    expect((await k.sessionsOf(x))[0]).toMatchObject({ id: sid, bot_version_id: v1 });
    expect((k.sentTo(x).at(-2)!.request.message as { body: string }).body).toBe(
      NODES.ans_t1!.text as string,
    );
    const y = anotherStudent(x);
    await start(y);
    await tap(y, TOPIC_ONE);
    expect((await k.sessionsOf(y))[0]).toMatchObject({ bot_version_id: v2.id });
    expect((k.sentTo(y).at(-2)!.request.message as { body: string }).body).toContain("ANSWER 1 v2");
  });

  // ------------------------------------------------------------------------------------------------ GI-CL-12

  it("GI-CL-12: with the bot dispatch gate off the QUEUED welcome is not sent; with live sending off the transport is never called", async () => {
    const a = await k.world(FLOW);
    const first = k.studentBytes(a, k.textMessage("info"));
    expect(await k.post(first.bytes)).toBe(200);
    await k.webhookPass();
    await k.triggerPass();
    await k.dispatchPass({ config: { ...BOTS_ON, botsRuntimeEnabled: false } });
    expect(await counts(a)).toMatchObject({ botRequests: 1, calls: 0 });
    expect(await k.requestsOf(a)).toMatchObject([{ state: "QUEUED" }]);

    const b = await k.world(FLOW);
    const second = k.studentBytes(b, k.textMessage("info"));
    expect(await k.post(second.bytes)).toBe(200);
    await k.webhookPass();
    await k.triggerPass();
    // The live-send gate is enforced at the HTTP boundary by the REAL MetaTransport (a FakeTransport never checks it, so
    // dispatch config alone cannot close it). Its `post` seam must never be reached, and a BOT request is then HELD.
    const post = vi.fn<HttpPost>();
    const gated = new MetaTransport({
      env: () => ({
        WHATSAPP_OUTBOUND_ENABLED: "true",
        WHATSAPP_LIVE_SEND_ENABLED: "false",
        WHATSAPP_GRAPH_API_VERSION: "v25.0",
      }),
      post,
    });
    await k.dispatchPass({ transport: gated });
    expect(post).not.toHaveBeenCalled();
    expect(k.transport.calls.filter((c) => c.recipient.id === b.phone)).toEqual([]);
    expect(await k.requestsOf(b)).toMatchObject([
      { state: "HELD", hold_reason: "live_send_disabled" },
    ]);
    // The three-process gate matrix itself is covered by gates.db.test.ts (E-GATE); this only proves it for this bot.
  });

  // ------------------------------------------------------------------------------------------------ GI-CL-13

  it("GI-CL-13: redaction of the terminal session clears variables, tokens and awaiting data only; lifecycle fields and message history are unchanged", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await tap(x, TOPIC_ONE);
    await tap(x, "That's all");
    const json = async () =>
      (await k.one("select to_jsonb(s) j from bot_sessions s where id = $1", [sid]))!.j as Record<
        string,
        unknown
      >;
    const history = async () =>
      k.rows(
        "select id, direction, type, body from messages where organization_id = $1 and conversation_id = $2 order by created_at, id",
        [x.w.org.id, (await k.conversationOf(x))!],
      );
    const before = await json();
    const messagesBefore = await history();
    const eventsBefore = await k.eventsOf(sid);
    expect(before).toMatchObject({
      state: "COMPLETED",
      redacted_at: null,
      variables: {},
      awaiting: null,
    });
    expect(before.last_consumed_token).not.toBeNull(); // real data to clear
    // The journey is exactly: 3 student messages (info, topic, That's all) and 5 sends (welcome, list, answer, prompt, bye).
    expect(messagesBefore.filter((m) => m.direction === "INBOUND")).toHaveLength(3);
    expect(messagesBefore.filter((m) => m.direction === "OUTBOUND")).toHaveLength(5);
    try {
      await shortenRetention(t.pool); // this disposable database only
      expect(
        Number((await k.one("select redact_expired_bot_sessions($1, 100) n", [x.w.org.id]))!.n),
      ).toBe(1);
    } finally {
      await shortenRetention(t.pool, "30 days"); // restore the migration's value
    }
    const after = await json();
    expect(after.redacted_at).not.toBeNull();
    expect(after).toMatchObject({
      variables: {},
      awaiting: null,
      awaiting_token: null,
      last_consumed_token: null,
    });
    const keep = (j: Record<string, unknown>) => {
      const { variables, awaiting, awaiting_token, last_consumed_token, redacted_at, ...rest } = j;
      void [variables, awaiting, awaiting_token, last_consumed_token, redacted_at];
      return rest;
    };
    expect(keep(after)).toEqual(keep(before)); // state, end_reason, handover_reason, step_seq, notice step, control sequences, times
    expect(await history()).toEqual(messagesBefore); // message history has its own retention rules
    expect(await k.eventsOf(sid)).toEqual(eventsBefore);
  });

  // ------------------------------------------------------------------------------------------------ GI-CL-15 (idle)

  it("GI-CL-15: idle expiry completes the session silently: COMPLETED idle_timeout, suppressed, no new request, no call", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    const before = await counts(x);
    const [live] = await k.sessionsOf(x);
    expect(live!.expires_at).toBeInstanceOf(Date);
    // sweepPass cannot be used: its candidate query filters on the real clock_timestamp() (listReconcileCandidates), and readClock
    // only feeds the per-session decision, so a future clock never reaches it. Reconcile the session directly, as the
    // reconcile suite does, with fixed decision clocks around the persisted expires_at.
    const expiry = (live!.expires_at as Date).getTime();
    expect(expiry - Date.now()).toBeGreaterThan(29 * MIN); // set from the 30-minute idle timeout when the list was accepted
    expect(expiry - Date.now()).toBeLessThanOrEqual(30 * MIN);
    const at = (ms: number) => async () => new Date(ms);
    const candidate = {
      organizationId: live!.organization_id as string,
      sessionId: sid,
      conversationId: live!.conversation_id as string,
      deploymentId: live!.deployment_id as string,
    };
    const reconcile = (clock: () => Promise<Date>) =>
      reconcileSession(k.workerDb, candidate, { ...k.production, readClock: clock });
    expect(await reconcile(at(expiry - 1))).toEqual({ kind: "skipped", reason: "not_due" });
    expect(await reconcile(at(expiry))).toMatchObject({ kind: "applied", action: "idle_expired" });
    expect((await k.sessionsOf(x))[0]).toMatchObject({
      id: sid,
      state: "COMPLETED",
      end_reason: "idle_timeout",
      handover_reason: null,
      terminal_notice_step_seq: null,
    });
    expect((await k.sessionsOf(x))[0]!.output_suppressed_at).toBeInstanceOf(Date);
    expect(await counts(x)).toMatchObject({ botRequests: before.botRequests, calls: before.calls });
    expect(await eventRows(sid)).toEqual([]);
  });
});
