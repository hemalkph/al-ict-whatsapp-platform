import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { lostCommitAck } from "@/db/__tests__/lost-commit-ack";
import type { DbExecutor } from "@/db/ops/executor";
import { enquiryFlow } from "@/modules/bots/testing";
import { assignConversation } from "@/modules/inbox";
import { dispatchBatch, type DispatchDeps } from "@/modules/messaging/dispatch";
import { SENDING_RECOVERY_AFTER_MS } from "@/modules/messaging/policy";
import { FakeTransport } from "@/modules/messaging/testing";
import type { SendRequest, SendResult } from "@/modules/messaging/transport";
import { handleWebhookPost } from "@/modules/whatsapp/handler";
import { deliveryBytes } from "@/modules/whatsapp/inbound/testing";
import { processWebhookBatch } from "@/modules/whatsapp/queue/process";
import { TEST_APP_SECRET, webhookPost } from "@/modules/whatsapp/testing";
import { buildWebhookWorkerHandlers } from "@/modules/whatsapp/worker/registry";
import {
  activateDeployment,
  pauseDeployment,
  resumeDeployment,
  stopActiveSessions,
} from "../bot-control";
import { BOTS_ON, botWorld, publishedBot, type BotWorld } from "../bot-control/testing";
import { productionStepDeps } from "../bot-worker/compose";
import { runSweepLoop, runTriggerLoop } from "../bot-worker/loops";
import { botWorkerDatabase, preflight } from "../bot-worker/run";
import { WORKER_ON } from "../bot-worker/testing";
import type { StepDeps } from "./outbound";
import { sweepOnce } from "./reconcile";
import { processTrigger } from "./step";
import { deferred, expireClaim, makeDue, terminateThenResume, terminationWatch } from "./testing";
import { claimTriggers } from "./trigger-queue";

// Phase 08E-8B, plan N.2 E2E (closed loop), on disposable PostgreSQL 17 with FakeTransport only. Every hop is the real
// application path (see closedLoopKit): a correctly signed webhook through the real route handler and ingest, the real webhook
// worker with trigger capture built from an explicit { BOTS_RUNTIME_ENABLED: "true" } object, the bot worker's own pool,
// preflight, production step composition (REAL random prompt tokens) and real loops, and the real dispatcher. Every student
// reply is built from the reply id and the wamid the fake provider actually received; no reply id is ever written by hand.
//
// SCOPE (owner decision, 2026-10-24): the approved six-bot acceptance criterion names six example bots, but only ONE has an
// approved definition: the "Student enquiry" flow (enquiryFlow, src/modules/bots/testing.ts). These are the conversation PATHS
// of that one approved bot, every genuinely implemented branch end to end. They are NOT six independently defined bots; the
// five other definitions (class information, payment enquiry, staff routing, new-registration enquiry, general information)
// do not exist and remain an UNRESOLVED requirement of that criterion.

type Node = Record<string, unknown> & { type: string };
const NODES = enquiryFlow().nodes as Record<string, Node>;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** The prompt token of a captured interactive message (every option id must carry the same one). */
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

/** The exact payload the approved flow node must produce for `token` (built from the fixture, not from the capture). */
function expectedPrompt(nodeId: string, token: string) {
  const n = NODES[nodeId]!;
  const options = (n.options as Array<Record<string, string>>).map((o) => ({
    id: `b1.${token}.${o.key}`,
    title: o.title,
    ...(o.description === undefined ? {} : { description: o.description }),
  }));
  return n.type === "BUTTONS"
    ? {
        type: "interactive",
        payload: {
          v: 1,
          kind: "buttons",
          body: n.body,
          ...(n.footer === undefined ? {} : { footer: n.footer }),
          buttons: options,
        },
      }
    : {
        type: "interactive",
        payload: {
          v: 1,
          kind: "list",
          body: n.body,
          buttonLabel: n.buttonLabel,
          sections: [{ title: n.buttonLabel, rows: options }],
        },
      };
}
const textOf = (body: string) => ({ type: "text", body, replyToWamid: null });
const nodeText = (nodeId: string) =>
  textOf((NODES[nodeId]!.text ?? NODES[nodeId]!.message) as string);

/** One expected outbound message: a prompt of a node (token checked) or an exact text. */
type Out = { prompt: string } | { text: ReturnType<typeof textOf> };
const P = (nodeId: string): Out => ({ prompt: nodeId });
const T = (nodeId: string): Out => ({ text: nodeText(nodeId) });

describe("closed loop: the approved Student enquiry bot, every implemented branch (08E-8B E2E)", () => {
  let t: TestDb;
  let k: ReturnType<typeof closedLoopKit>;

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

  /** The student's first message, then ONLY the webhook worker and one bot-worker pass: the session as T1 committed it. */
  async function begin(x: LoopWorld, body: string) {
    const { bytes, wamid } = k.studentBytes(x, k.textMessage(body));
    expect(await k.post(bytes)).toBe(200);
    expect((await k.webhookPass()).processed).toBe(1);
    const triggers = await k.triggersOf(x);
    expect(triggers).toHaveLength(1); // captured exactly once
    expect(triggers[0]).toMatchObject({ status: "PENDING", attempts: 0 });
    expect((await k.triggerPass()).totals).toMatchObject({ claimed: 1, finished: 1, failed: 0 });
    const [inbound] = await k.inboundOf(x);
    expect(inbound).toMatchObject({ wamid, type: "TEXT", body });
    const [s, ...more] = await k.sessionsOf(x);
    expect(more).toEqual([]);
    expect(await k.triggersOf(x)).toMatchObject([
      { status: "PROCESSED", outcome_code: "session_started", session_id: s!.id, attempts: 1 },
    ]);
    // The initial state, before anything was dispatched.
    expect(s).toMatchObject({
      state: "WAITING_FOR_SEND",
      current_node_id: "language_menu",
      step_seq: 1,
      revision: 1,
      invalid_attempts: 0,
      variables: {},
      started_by_message_id: inbound!.id,
      awaiting: {
        kind: "BUTTONS",
        phase: "QUEUED",
        nodeId: "language_menu",
        optionKeys: ["si", "ta", "en"],
      },
      last_consumed_token: null,
      ended_at: null,
    });
    expect(s!.awaiting_token).toMatch(TOKEN);
    const [r, ...others] = await k.requestsOf(x);
    expect(others).toEqual([]);
    expect(r).toMatchObject({
      origin: "BOT",
      state: "QUEUED",
      bot_session_id: s!.id,
      bot_step_seq: 1,
      idempotency_key: `bot-${s!.id as string}-1`,
      message_type: "INTERACTIVE",
      recipient_kind: "PHONE",
      recipient_id: x.phone,
    });
    // The QUEUED payload is the approved node with THIS session's token.
    expect({ type: "interactive", payload: r!.payload }).toEqual(
      expectedPrompt("language_menu", s!.awaiting_token as string),
    );
    expect(k.sentTo(x)).toEqual([]); // nothing reached the provider yet
    await k.settle();
    return s!.id as string;
  }

  /** Taps the option titled `title` on the LAST captured prompt: its real id and the real prompt wamid go back. */
  async function tap(x: LoopWorld, title: string, from?: SentMessage) {
    const prompt = from ?? k.sentTo(x).at(-1)!;
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
  async function say(x: LoopWorld, body: string) {
    const { bytes, wamid } = k.studentBytes(x, k.textMessage(body));
    expect(await k.post(bytes)).toBe(200);
    await k.settle();
    return wamid;
  }

  /** The whole transcript the fake provider received, and every durable row behind it. */
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
    // ONE durable BOT request per transmitted message, in step order, each accepted once, nothing else.
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
    expect(triggers.map((tr) => [tr.attempts, tr.claim_token, tr.last_error_code])).toEqual(
      outcomes.map(() => [1, null, null]),
    );
    return inbound;
  }

  const eventRows = async (sessionId: string) =>
    (await k.eventsOf(sessionId)).map((e) => [e.kind, e.code, e.step_seq, e.message_id]);

  // ------------------------------------------------------------------------------------------------ the paths

  it("path 1 (English, keyword 'hi'): language buttons -> list -> 'Class details' loops back to a NEW list -> 'Talk to a person' hands over with its notice", async () => {
    const x = await k.world(enquiryFlow());
    const sid = await begin(x, "hi");
    expect(await k.sessionsOf(x)).toMatchObject([
      { state: "WAITING_FOR_INPUT", current_node_id: "language_menu", revision: 2 },
    ]);
    await tap(x, "English");
    const list1 = k.sentTo(x).at(-1)!;
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        state: "WAITING_FOR_INPUT",
        current_node_id: "main_menu",
        step_seq: 3,
        revision: 5,
        awaiting: {
          kind: "LIST",
          phase: "SENT",
          optionKeys: ["classes", "fees", "register", "staff"],
        },
        awaiting_token: tokenOf(list1),
      },
    ]);
    await tap(x, "Class details");
    await tap(x, "Talk to a person");

    const { tokens } = await expectTranscript(x, sid, [
      P("language_menu"),
      T("en_welcome"),
      P("main_menu"),
      T("class_info"),
      P("main_menu"),
      T("to_staff"),
    ]);
    const inbound = await expectTriggers(x, [
      "session_started",
      "input_accepted",
      "input_accepted",
      "input_accepted",
    ]);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_ACCEPTED", null, 2, inbound[1]!.id],
      ["INPUT_ACCEPTED", null, 4, inbound[2]!.id],
      ["INPUT_ACCEPTED", null, 6, inbound[3]!.id],
      ["HANDED_OVER", "student_requested", 6, null],
    ]);
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        id: sid,
        state: "HANDED_OVER",
        current_node_id: "to_staff",
        end_reason: "flow_handover",
        handover_reason: "student_requested",
        terminal_notice_step_seq: 6,
        step_seq: 6,
        last_consumed_token: tokens[2],
        awaiting: null,
        variables: {},
      },
    ]);
    // Inbound replies carried the real prompt wamid as their context.
    const sent = k.sentTo(x);
    expect(inbound.slice(1).map((m) => m.reply_to_wamid)).toEqual([
      sent[0]!.wamid,
      sent[2]!.wamid,
      sent[4]!.wamid,
    ]);
  });

  it("path 2 (Sinhala, first_message): 'Fees' loops back -> 'I want to join' -> name -> grade 12 -> CONDITION all/any -> SET_VARIABLE -> interpolated confirm -> END notice", async () => {
    const x = await k.world(enquiryFlow());
    const sid = await begin(x, "Good morning"); // not a keyword: the first_message trigger starts it
    await tap(x, "සිංහල");
    await tap(x, "Fees");
    await tap(x, "I want to join");
    await say(x, "Nimal Perera");
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        state: "WAITING_FOR_INPUT",
        current_node_id: "ask_grade",
        variables: { student_name: "Nimal Perera" },
        awaiting: { kind: "QUESTION", phase: "SENT" },
      },
    ]);
    await say(x, "12");

    await expectTranscript(x, sid, [
      P("language_menu"),
      T("si_welcome"),
      P("main_menu"),
      T("fee_info"),
      P("main_menu"),
      T("ask_name"),
      T("ask_grade"),
      { text: textOf("Thank you, Nimal Perera. We will contact you.") },
      T("done"),
    ]);
    const inbound = await expectTriggers(x, [
      "session_started",
      "input_accepted",
      "input_accepted",
      "input_accepted",
      "input_accepted",
      "input_accepted",
    ]);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_ACCEPTED", null, 2, inbound[1]!.id],
      ["INPUT_ACCEPTED", null, 4, inbound[2]!.id],
      ["INPUT_ACCEPTED", null, 6, inbound[3]!.id],
      ["INPUT_ACCEPTED", null, 7, inbound[4]!.id],
      ["INPUT_ACCEPTED", null, 8, inbound[5]!.id],
    ]);
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        state: "COMPLETED",
        current_node_id: "done",
        end_reason: "flow_end",
        handover_reason: null,
        terminal_notice_step_seq: 9,
        variables: { student_name: "Nimal Perera", grade: 12, wants_call: true },
        awaiting: null,
      },
    ]);
  });

  it("path 3 (Tamil, keyword 'வணக்கம்'): a re-tap of the consumed prompt is duplicate_reply (uncounted); a tap on an OLDER prompt is stale_prompt (counted once, re-prompt with a NEW token); register; an invalid grade re-asks; grade 10 takes the 'in' branch -> END", async () => {
    const x = await k.world(enquiryFlow());
    const sid = await begin(x, "வணக்கம்");
    await tap(x, "தமிழ்");
    const list1 = k.sentTo(x).at(-1)!;
    await tap(x, "Fees");
    // The student taps the list they already answered (its real captured id): the token is the last consumed one.
    const before = await k.sessionsOf(x);
    const sentBefore = k.sentTo(x).length;
    await tap(x, "Class details", list1);
    expect(k.sentTo(x)).toHaveLength(sentBefore);
    expect(await k.sessionsOf(x)).toEqual(before); // byte-identical: ignored, not counted
    await tap(x, "Class details");
    // Now list1's token is neither awaited nor the last consumed: stale_prompt, counted once, the list is sent again.
    await tap(x, "I want to join", list1);
    const s4 = (await k.sessionsOf(x))[0]!;
    expect(s4).toMatchObject({ current_node_id: "main_menu", invalid_attempts: 1 });
    expect(s4.awaiting_token).toBe(tokenOf(k.sentTo(x).at(-1)!));
    await tap(x, "I want to join");
    await say(x, "Kumar");
    await say(x, "ten");
    expect(await k.sessionsOf(x)).toMatchObject([
      { current_node_id: "ask_grade", invalid_attempts: 1, variables: { student_name: "Kumar" } },
    ]);
    await say(x, "10");

    const { tokens } = await expectTranscript(x, sid, [
      P("language_menu"),
      T("ta_welcome"),
      P("main_menu"),
      T("fee_info"),
      P("main_menu"),
      T("class_info"),
      P("main_menu"),
      P("main_menu"),
      T("ask_name"),
      T("ask_grade"),
      T("ask_grade"),
      { text: textOf("Thank you, Kumar. We will contact you.") },
      T("done"),
    ]);
    expect(tokens).toHaveLength(5);
    const inbound = await expectTriggers(x, [
      "session_started",
      "input_accepted",
      "input_accepted",
      "duplicate_reply",
      "input_accepted",
      "input_rejected",
      "input_accepted",
      "input_accepted",
      "input_rejected",
      "input_accepted",
    ]);
    expect((await k.triggersOf(x))[3]).toMatchObject({ status: "IGNORED" });
    expect((await eventRows(sid)).map((e) => [e[0], e[1], e[3]])).toEqual([
      ["INPUT_ACCEPTED", null, inbound[1]!.id],
      ["INPUT_ACCEPTED", null, inbound[2]!.id],
      ["INPUT_ACCEPTED", null, inbound[4]!.id],
      ["INPUT_REJECTED", "stale_prompt", inbound[5]!.id],
      ["INPUT_ACCEPTED", null, inbound[6]!.id],
      ["INPUT_ACCEPTED", null, inbound[7]!.id],
      ["INPUT_REJECTED", "answer_invalid", inbound[8]!.id],
      ["INPUT_ACCEPTED", null, inbound[9]!.id],
    ]);
    const done = (await k.sessionsOf(x))[0]!;
    expect(done).toMatchObject({
      state: "COMPLETED",
      end_reason: "flow_end",
      terminal_notice_step_seq: 13,
      variables: { student_name: "Kumar", grade: 10 },
    });
    expect(done.variables).not.toHaveProperty("wants_call");
  });

  it("path 4 (onInvalid): two invalid answers at the list hand over through the error branch with the HANDOVER notice", async () => {
    const x = await k.world(enquiryFlow());
    const sid = await begin(x, "hello there");
    await tap(x, "English");
    await say(x, "??");
    await say(x, "!!");
    await expectTranscript(x, sid, [
      P("language_menu"),
      T("en_welcome"),
      P("main_menu"),
      P("main_menu"),
      T("to_staff"),
    ]);
    const inbound = await expectTriggers(x, [
      "session_started",
      "input_accepted",
      "input_rejected",
      "input_rejected",
    ]);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_ACCEPTED", null, 2, inbound[1]!.id],
      ["INPUT_REJECTED", "wrong_kind", 4, inbound[2]!.id],
      ["INPUT_REJECTED", "wrong_kind", 5, inbound[3]!.id],
      ["HANDED_OVER", "student_requested", 5, null],
    ]);
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        state: "HANDED_OVER",
        end_reason: "flow_handover",
        handover_reason: "student_requested",
        terminal_notice_step_seq: 5,
      },
    ]);
  });

  it("path 5 (keyword 'menu'): grade 5 matches neither CONDITION branch and takes 'else' -> confirm -> END, wants_call never set", async () => {
    const x = await k.world(enquiryFlow());
    const sid = await begin(x, "menu");
    await tap(x, "English");
    await tap(x, "I want to join");
    await say(x, "Sam");
    await say(x, "5");
    await expectTranscript(x, sid, [
      P("language_menu"),
      T("en_welcome"),
      P("main_menu"),
      T("ask_name"),
      T("ask_grade"),
      { text: textOf("Thank you, Sam. We will contact you.") },
      T("done"),
    ]);
    await expectTriggers(x, [
      "session_started",
      "input_accepted",
      "input_accepted",
      "input_accepted",
      "input_accepted",
    ]);
    const done = (await k.sessionsOf(x))[0]!;
    expect(done).toMatchObject({
      state: "COMPLETED",
      end_reason: "flow_end",
      terminal_notice_step_seq: 7,
      variables: { student_name: "Sam", grade: 5 },
    });
    expect(done.variables).not.toHaveProperty("wants_call");
  });

  it("path 6 (keyword 'ආයුබෝවන්'): two out-of-range grades exhaust maxInvalidAttempts at the QUESTION -> onInvalid HANDOVER notice; the sensitive name stays only in the session", async () => {
    const x = await k.world(enquiryFlow());
    const sid = await begin(x, "ආයුබෝවන්");
    await tap(x, "සිංහල");
    await tap(x, "I want to join");
    await say(x, "Ann");
    await say(x, "14");
    await say(x, "0");
    await expectTranscript(x, sid, [
      P("language_menu"),
      T("si_welcome"),
      P("main_menu"),
      T("ask_name"),
      T("ask_grade"),
      T("ask_grade"),
      T("to_staff"),
    ]);
    const inbound = await expectTriggers(x, [
      "session_started",
      "input_accepted",
      "input_accepted",
      "input_accepted",
      "input_rejected",
      "input_rejected",
    ]);
    expect((await eventRows(sid)).slice(-3)).toEqual([
      ["INPUT_REJECTED", "answer_invalid", 6, inbound[4]!.id],
      ["INPUT_REJECTED", "answer_invalid", 7, inbound[5]!.id],
      ["HANDED_OVER", "student_requested", 7, null],
    ]);
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        state: "HANDED_OVER",
        end_reason: "flow_handover",
        handover_reason: "student_requested",
        terminal_notice_step_seq: 7,
        variables: { student_name: "Ann" },
      },
    ]);
    // the sensitive answer was never sent anywhere: no outbound text contains it
    expect(k.sentTo(x).some((m) => JSON.stringify(m.request.message).includes("Ann"))).toBe(false);
  });

  it("after a terminal session, further student messages start nothing and send nothing (no reopening inside the cooldown)", async () => {
    const x = await k.world(enquiryFlow());
    const sid = await begin(x, "hi");
    await tap(x, "English");
    await tap(x, "Talk to a person");
    const sent = k.sentTo(x).length;
    await say(x, "hi"); // a keyword again, inside the 30-minute cooldown
    await tap(x, "Fees", k.sentTo(x)[2]); // a real tap on the dead session's list
    expect(k.sentTo(x)).toHaveLength(sent);
    expect((await k.sessionsOf(x)).map((s) => [s.id, s.state])).toEqual([[sid, "HANDED_OVER"]]);
    const outcomes = (await k.triggersOf(x)).map((tr) => [tr.status, tr.outcome_code]);
    expect(outcomes.slice(0, 3)).toEqual([
      ["PROCESSED", "session_started"],
      ["PROCESSED", "input_accepted"],
      ["PROCESSED", "input_accepted"],
    ]);
    expect(outcomes.slice(3).every(([status]) => status === "IGNORED")).toBe(true);
    expect(outcomes).toHaveLength(5);
  });
});

// Phase 08E-8B, plan N.2 E2E / O.11 "zero duplicate bot messages across duplicate webhooks, crashes and concurrent workers
// (counting requests)", on disposable PostgreSQL 17 through the REAL closed loop (see closedLoopKit) with FakeTransport only.
// Exactly-once is claimed for LOCAL DURABLE effects only (messages, triggers, sessions, events, outbound requests); the
// external transport is never claimed to be exactly-once: a dispatcher that dies after its final authorization leaves an
// UNKNOWN_OUTCOME that is never retried, and the accepted post-final-authorization window is preserved and asserted (H4).
// Order between processes is proved by pause points and lock ownership, never by sleeping. All of these use the approved
// Student enquiry flow (the only approved example bot definition; see the SCOPE note above).

const accepted = (wamid: string): SendResult => ({
  kind: "accepted",
  wamid,
  providerStatus: "accepted",
  httpStatus: 200,
});

/** A pause inside the bot worker's T1 (a test seam of the step), on whichever pool runs it. */
function pausePoint() {
  const reached = deferred<number>();
  const go = deferred();
  return {
    hook: async (tx: DbExecutor) => {
      const r = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`);
      reached.resolve(r.rows[0]!.pid);
      await go.promise;
    },
    reached: reached.promise,
    release: () => go.resolve(),
  };
}

describe("closed loop: duplicates, concurrent workers, crashes, in-flight replies, takeover and Stop (08E-8B)", () => {
  let t: TestDb;
  let k: ReturnType<typeof closedLoopKit>; // worker A + the dispatcher + the fake provider
  let k2: ReturnType<typeof closedLoopKit>; // worker B (its own pool)
  let k3: ReturnType<typeof closedLoopKit>; // worker C (its own pool)
  const releases: Array<() => void> = [];

  beforeAll(async () => {
    t = await createTestDatabase({
      sessionTimeouts: {
        lock_timeout: 15_000,
        statement_timeout: 20_000,
        idle_in_transaction_session_timeout: 25_000,
      },
    });
    k = closedLoopKit(t);
    k2 = closedLoopKit(t);
    k3 = closedLoopKit(t);
  });
  afterAll(async () => {
    for (const kit of [k, k2, k3]) await kit?.close();
    await t?.close();
  });
  beforeEach(() => {
    vi.stubEnv("META_APP_SECRET", TEST_APP_SECRET);
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const r of releases.splice(0)) r();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------------------------------------ helpers

  /** Every durable count for this student (BOT requests counted, not transport calls) plus the provider calls. */
  async function counts(x: LoopWorld) {
    const sessions = await k.sessionsOf(x);
    const events = (await Promise.all(sessions.map((s) => k.eventsOf(s.id as string)))).flat();
    const requests = await k.requestsOf(x);
    return {
      inbound: (await k.inboundOf(x)).length,
      triggers: (await k.triggersOf(x)).length,
      sessions: sessions.length,
      botRequests: requests.filter((r) => r.origin === "BOT").length,
      events: events.length,
      calls: k.transport.calls.filter((c) => c.recipient.id === x.phone).length,
    };
  }
  /** One BOT request per (session, step): no duplicate step ever exists. */
  async function expectOneRequestPerStep(x: LoopWorld) {
    const requests = (await k.requestsOf(x)).filter((r) => r.origin === "BOT");
    const keys = requests.map((r) => `${r.bot_session_id as string}:${r.bot_step_seq as number}`);
    expect(new Set(keys).size).toBe(keys.length);
    return requests;
  }
  async function post(x: LoopWorld, message: Record<string, unknown>, id?: string) {
    const d = k.studentBytes(x, message, id);
    expect(await k.post(d.bytes)).toBe(200);
    return d;
  }
  /** The first message is captured (webhook worker only); no bot worker has run yet. */
  async function captured(x: LoopWorld, body = "hi") {
    const d = await post(x, k.textMessage(body));
    expect((await k.webhookPass()).processed).toBe(1);
    const [tr] = await k.triggersOf(x);
    expect(tr).toMatchObject({ status: "PENDING", attempts: 0 });
    return { ...d, triggerId: tr!.id as string };
  }
  /** The real tap on the latest captured prompt (or on `prompt`). */
  function tapOn(x: LoopWorld, title: string, prompt = k.sentTo(x).at(-1)!) {
    const option = k.optionsOf(prompt).get(title)!;
    const kind =
      prompt.request.message.type === "interactive" &&
      prompt.request.message.payload.kind === "list"
        ? "list_reply"
        : "button_reply";
    return k.tapMessage(option, kind, prompt.wamid);
  }
  /** A session started and settled at the language prompt, then English tapped: WAITING_FOR_INPUT at the main list. */
  async function atMainList(x: LoopWorld) {
    await captured(x);
    await k.settle();
    await post(x, tapOn(x, "English"));
    await k.settle();
    expect(await k.sessionsOf(x)).toMatchObject([
      { state: "WAITING_FOR_INPUT", current_node_id: "main_menu" },
    ]);
  }
  const trigger = async (id: string) =>
    (await k.one("select * from bot_triggers where id = $1", [id]))!;

  // ------------------------------------------------------------------------------------------------ A, B duplicates

  it("A. duplicate inbound webhook delivery (same bytes, a re-serialized envelope, and after the session started): one message, one trigger, one session, one request, one call", async () => {
    const x = await k.world(enquiryFlow());
    const { bytes, wamid } = k.studentBytes(x, k.textMessage("hi"));
    expect(await k.post(bytes)).toBe(200);
    expect(await k.post(bytes)).toBe(200); // Meta redelivers the identical body
    // the same wamid in a re-serialized envelope (another profile name, indented JSON): different bytes, same message
    const envelope = JSON.parse(bytes.toString("utf8")) as {
      entry: Array<{
        changes: Array<{ value: { contacts: Array<{ profile: { name: string } }> } }>;
      }>;
    };
    envelope.entry[0]!.changes[0]!.value.contacts[0]!.profile.name = "Student (renamed)";
    const other = Buffer.from(JSON.stringify(envelope, null, 2));
    expect(Buffer.compare(other, bytes)).not.toBe(0);
    expect(await k.post(other)).toBe(200);
    await k.webhookPass();
    expect(await counts(x)).toEqual({
      inbound: 1,
      triggers: 1,
      sessions: 0,
      botRequests: 0,
      events: 0,
      calls: 0,
    });
    await k.settle();
    expect(await k.post(bytes)).toBe(200); // a late redelivery after the session started
    await k.settle();
    expect(await counts(x)).toEqual({
      inbound: 1,
      triggers: 1,
      sessions: 1,
      botRequests: 1,
      events: 0,
      calls: 1,
    });
    expect(
      (await k.one(
        "select count(*)::int n from webhook_events e where e.organization_id = $1 and e.provider_object_id = $2",
        [x.w.org.id, wamid],
      ))!.n,
    ).toBe(1);
  });

  it("B. duplicate interactive reply: the same tap delivered three times is one message and one INPUT_ACCEPTED; a genuine double tap (two messages, same real id) is applied once, the second is duplicate_reply", async () => {
    const x = await k.world(enquiryFlow());
    await captured(x);
    await k.settle();
    const tap = tapOn(x, "English");
    const first = await post(x, tap);
    await post(x, tap, first.wamid);
    await k.webhookPass();
    await post(x, tap, first.wamid); // after it was processed into a message
    await k.settle();
    expect(await counts(x)).toEqual({
      inbound: 2,
      triggers: 2,
      sessions: 1,
      botRequests: 3,
      events: 1,
      calls: 3,
    });
    // The student taps "Fees" twice on the same list: two distinct messages carrying the same real reply id.
    const fees = tapOn(x, "Fees");
    await post(x, fees);
    await post(x, fees);
    await k.settle();
    expect(await counts(x)).toEqual({
      inbound: 4,
      triggers: 4,
      sessions: 1,
      botRequests: 5, // fee_info + the list again, once
      events: 2,
      calls: 5,
    });
    const outcomes = (await k.triggersOf(x)).slice(2).map((tr) => tr.outcome_code);
    expect(outcomes.sort()).toEqual(["duplicate_reply", "input_accepted"]);
    await expectOneRequestPerStep(x);
    expect((await k.sessionsOf(x))[0]).toMatchObject({ invalid_attempts: 0 });
  });

  // ------------------------------------------------------------------------------------------------ C concurrent workers

  it("C1. three workers compete for one trigger: while worker A holds it inside T1, B and C claim nothing; one session, one request, one call", async () => {
    const x = await k.world(enquiryFlow());
    const { triggerId } = await captured(x);
    const hold = pausePoint();
    releases.push(hold.release);
    const a = k.triggerPass({ hooks: { afterRowLocks: hold.hook } });
    await hold.reached;
    const [b, c] = await Promise.all([k2.triggerPass(), k3.triggerPass()]);
    expect([b.totals.claimed, c.totals.claimed]).toEqual([0, 0]);
    hold.release();
    expect((await a).totals).toMatchObject({ claimed: 1, finished: 1, failed: 0 });
    await k.settle();
    expect(await trigger(triggerId)).toMatchObject({
      status: "PROCESSED",
      outcome_code: "session_started",
      attempts: 1,
    });
    expect(await counts(x)).toMatchObject({ triggers: 1, sessions: 1, botRequests: 1, calls: 1 });
  });

  it("C2. three workers released together on one trigger: exactly one claims and processes it", async () => {
    const x = await k.world(enquiryFlow());
    await captured(x);
    const all = await Promise.all([k.triggerPass(), k2.triggerPass(), k3.triggerPass()]);
    expect(all.map((r) => r.totals.claimed).reduce((a, b) => a + b, 0)).toBe(1);
    expect(all.map((r) => r.totals.failed + r.totals.lostClaims)).toEqual([0, 0, 0]);
    await k.settle();
    expect(await counts(x)).toMatchObject({ triggers: 1, sessions: 1, botRequests: 1, calls: 1 });
  });

  it("C2b. forced claim race: worker A's real T0 claim is held UNCOMMITTED on the row while two real workers contend for it; exactly one claim exists, and it is the one that is then processed", async () => {
    const x = await k.world(enquiryFlow());
    const { triggerId } = await captured(x);
    // The contention point is made by the database, not by scheduler luck: A's real claim statement has locked and updated the
    // trigger row and its transaction stays open until released.
    const won = deferred<Awaited<ReturnType<typeof claimTriggers>>>();
    const commit = deferred();
    releases.push(commit.resolve);
    const holder = t.db.transaction(async (tx) => {
      won.resolve(await claimTriggers(tx as unknown as DbExecutor));
      await commit.promise;
    });
    const [winnerClaim] = await won.promise;
    expect(winnerClaim).toMatchObject({ id: triggerId, attempts: 1 });
    // proof the contention point is real: the row is locked by another transaction right now
    await expect(
      t.pool.query("select 1 from bot_triggers where id = $1 for update nowait", [triggerId]),
    ).rejects.toMatchObject({ code: "55P03" });

    // B and C run the real worker claim loop at that point. Correct claim safety (FOR UPDATE SKIP LOCKED) skips the locked row
    // at once; without it they would WAIT on A's row and then claim it again, which the watcher below reports as "blocked".
    const rivals = Promise.all([k2.triggerPass(), k3.triggerPass()]);
    let watching = true;
    const blocked = (async () => {
      while (watching) {
        const r = await t.pool.query(
          "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        if (Number(r.rows[0].n) > 0) return "blocked" as const;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return "finished" as const;
    })();
    const verdict = await Promise.race([rivals.then(() => "finished" as const), blocked]);
    watching = false;
    commit.resolve(); // always release A, so a failure cannot leave rivals waiting forever
    await holder;
    const [b, c] = await rivals;
    expect(verdict).toBe("finished");
    expect([b.totals.claimed, c.totals.claimed]).toEqual([0, 0]);
    expect((await trigger(triggerId)).attempts).toBe(1);

    // the one valid claim is A's: it is still protected by its lease and is processed through the real step transaction
    expect(await claimTriggers(k.workerDb)).toEqual([]);
    const summary = await processTrigger(k.workerDb, winnerClaim!, k.production);
    expect(summary).toMatchObject({ kind: "finished", outcome: "session_started" });
    await k.settle();
    expect(await trigger(triggerId)).toMatchObject({ status: "PROCESSED", attempts: 1 });
    expect(await counts(x)).toMatchObject({ triggers: 1, sessions: 1, botRequests: 1, calls: 1 });
  });

  it("C3. claim-token fence: a stalled worker's old claim, replayed after another worker re-claimed the trigger, is lost_claim and changes nothing", async () => {
    const x = await k.world(enquiryFlow());
    const { triggerId } = await captured(x);
    const [stale] = await claimTriggers(k.workerDb, 10); // worker A's T0; A then stalls
    expect(stale!.id).toBe(triggerId);
    await expireClaim(t, triggerId);
    const [fresh] = await claimTriggers(k2.workerDb, 10); // worker B re-claims after the lease
    expect(fresh!.id).toBe(triggerId);
    expect(fresh!.claimToken).not.toBe(stale!.claimToken);
    const before = await trigger(triggerId);
    expect(await processTrigger(k.workerDb, stale!, k.production)).toEqual({ kind: "lost_claim" });
    expect(await trigger(triggerId)).toEqual(before);
    expect(await counts(x)).toMatchObject({ sessions: 0, botRequests: 0 });
    expect(await processTrigger(k2.workerDb, fresh!, k2.production)).toMatchObject({
      kind: "finished",
      outcome: "session_started",
    });
    expect(await processTrigger(k.workerDb, stale!, k.production)).toEqual({ kind: "lost_claim" });
    await k.settle();
    expect(await trigger(triggerId)).toMatchObject({ status: "PROCESSED", attempts: 2 });
    expect(await counts(x)).toMatchObject({ triggers: 1, sessions: 1, botRequests: 1, calls: 1 });
  });

  it("C4. active-session guard: a second 'hi' while the session's first prompt is in flight starts nothing; it waits for the prompt and is then evaluated by the live session", async () => {
    const x = await k.world(enquiryFlow());
    await captured(x);
    expect((await k.triggerPass()).totals).toMatchObject({ claimed: 1, finished: 1 });
    await post(x, k.textMessage("hi")); // a second, distinct message, captured while the prompt is QUEUED
    await k.webhookPass();
    const r = await Promise.all([k2.triggerPass(), k3.triggerPass()]);
    expect(r.map((p) => p.totals.failed + p.totals.lostClaims)).toEqual([0, 0]);
    expect(r.map((p) => p.totals.deferred).reduce((a, b) => a + b, 0)).toBe(1);
    await k.settle();
    expect((await k.triggersOf(x)).map((tr) => tr.outcome_code)).toEqual([
      "session_started",
      "input_rejected", // text at a BUTTONS prompt: wrong_kind, counted once, re-prompted
    ]);
    expect(await counts(x)).toMatchObject({ sessions: 1, botRequests: 2, calls: 2 });
    await expectOneRequestPerStep(x);
  });

  // ------------------------------------------------------------------------------------------------ D, E crashes

  it("D1. a worker that dies after T0 (claim committed, no T1): its lease protects the trigger, then another worker processes it once (attempt 2) and the conversation continues", async () => {
    const x = await k.world(enquiryFlow());
    const { triggerId } = await captured(x);
    expect((await claimTriggers(k2.workerDb, 10)).map((c) => c.id)).toEqual([triggerId]); // B dies here
    expect((await k.triggerPass()).totals.claimed).toBe(0); // leased: A does not touch it
    await expireClaim(t, triggerId);
    expect((await k.triggerPass()).totals).toMatchObject({ claimed: 1, finished: 1 });
    expect(await trigger(triggerId)).toMatchObject({ status: "PROCESSED", attempts: 2 });
    await k.settle();
    await post(x, tapOn(x, "English"));
    await k.settle();
    expect(await counts(x)).toMatchObject({ sessions: 1, botRequests: 3, calls: 3, events: 1 });
    await expectOneRequestPerStep(x);
  });

  it("D2. T1's connection terminated after the session and request were written, before COMMIT: nothing survives, the failure is recorded, and the retry starts exactly one session", async () => {
    const x = await k.world(enquiryFlow());
    const { triggerId } = await captured(x);
    const watch = terminationWatch(k.workerPool);
    const hold = pausePoint();
    releases.push(hold.release);
    const running = k.triggerPass({ hooks: { afterEnqueue: hold.hook } });
    const pid = await hold.reached;
    expect(await counts(x)).toMatchObject({ sessions: 0, botRequests: 0 }); // uncommitted
    await terminateThenResume(watch, pid, hold.release);
    const result = await running;
    await watch.verify();
    expect(result.totals).toMatchObject({ claimed: 1, finished: 0, failed: 1 });
    const failed = await trigger(triggerId);
    expect(failed).toMatchObject({ status: "PENDING", attempts: 1, claim_token: null });
    expect(failed.last_error_code).not.toBeNull();
    expect(await counts(x)).toMatchObject({ sessions: 0, botRequests: 0, events: 0, calls: 0 });
    await makeDue(t, triggerId); // instead of sleeping through the backoff
    await k.settle();
    expect(await trigger(triggerId)).toMatchObject({
      status: "PROCESSED",
      outcome_code: "session_started",
      attempts: 2,
    });
    expect(await counts(x)).toMatchObject({ sessions: 1, botRequests: 1, calls: 1 });
  });

  it("E. T1 committed but its COMMIT acknowledgement was lost: the fenced failure record cannot overwrite the result, nothing is replayed", async () => {
    const x = await k.world(enquiryFlow());
    const { triggerId } = await captured(x);
    const lost = lostCommitAck(t);
    try {
      lost.arm(async () => {
        // an independent connection proves the server committed before the injected loss
        expect(await counts(x)).toMatchObject({ sessions: 1, botRequests: 1 });
      });
      const r = await k.triggerPass({}, 2, lost.db as unknown as DbExecutor);
      expect(lost.injected).toBe(1);
      expect(r.totals).toMatchObject({ claimed: 1, finished: 0, failed: 1 });
    } finally {
      await lost.close();
    }
    expect(await trigger(triggerId)).toMatchObject({
      status: "PROCESSED",
      outcome_code: "session_started",
      attempts: 1,
      claim_token: null,
      last_error_code: null,
    });
    expect((await k.triggerPass()).totals.claimed).toBe(0);
    await k.settle();
    expect(await counts(x)).toMatchObject({ triggers: 1, sessions: 1, botRequests: 1, calls: 1 });
  });

  // ------------------------------------------------------------------------------------------------ F, G in flight

  it("F. dispatcher dies after final authorization (HTTP attempt started): recovery makes it UNKNOWN_OUTCOME, the late result is fenced out, the bot hands over; never retried, never a second request", async () => {
    const x = await k.world(enquiryFlow());
    await captured(x);
    await k.triggerPass();
    const [r] = await k.requestsOf(x);
    const inHttp = deferred();
    const go = deferred();
    releases.push(go.resolve);
    k.transport.next(async () => {
      inHttp.resolve();
      await go.promise;
      return accepted("wamid.TEST08E8B.F.late");
    });
    const first = k.dispatchPass(); // dispatcher A: claim, final authorization, HTTP attempt
    await inHttp.promise;
    expect((await k.one("select state from outbound_requests where id = $1", [r!.id]))!.state).toBe(
      "SENDING",
    );
    // A is presumed dead; a later dispatcher pass recovers the stuck row.
    const later = await k.dispatchPass({
      now: () => new Date(Date.now() + SENDING_RECOVERY_AFTER_MS + 60_000),
    });
    expect(later).toMatchObject({ recoveredUnknown: 1, claimed: 0 });
    go.resolve();
    expect(await first).toMatchObject({ claimed: 1, accepted: 0, fenceLost: 1 });
    expect(
      await k.one("select state, failure_code from outbound_requests where id = $1", [r!.id]),
    ).toEqual({
      state: "UNKNOWN_OUTCOME",
      failure_code: "process_died_after_dispatch_start",
    });
    const s = (await k.sweepPass()).totals;
    expect(s).toMatchObject({ reconciled: 1, failed: 0 });
    const [session] = await k.sessionsOf(x);
    expect(session).toMatchObject({
      state: "HANDED_OVER",
      handover_reason: "send_outcome_unknown",
      terminal_notice_step_seq: null,
    });
    // The student did receive it and taps a real option: the session has ended; nothing is sent.
    const call = k.transport.calls.filter((c) => c.recipient.id === x.phone).at(-1)!;
    await post(x, tapOn(x, "English", { request: call, wamid: "wamid.TEST08E8B.F.late" }));
    await k.settle();
    expect((await k.triggersOf(x)).map((tr) => [tr.status, tr.outcome_code])).toEqual([
      ["PROCESSED", "session_started"],
      // no live session: the tap is a START candidate, refused by H.2 while the bot's handover is unresolved
      ["IGNORED", "handover_unresolved"],
    ]);
    expect(await counts(x)).toMatchObject({ sessions: 1, botRequests: 1, calls: 1 });
    expect((await k.dispatchPass()).claimed).toBe(0);
  });

  it("G. a reply to the prompt while it is still SENDING is deferred (one PROMPT_INTERACTION, attempt refunded, nothing consumed); after acceptance it is applied exactly once", async () => {
    const x = await k.world(enquiryFlow());
    await captured(x);
    await k.triggerPass();
    const [session0] = await k.sessionsOf(x);
    const inHttp = deferred();
    const go = deferred();
    releases.push(go.resolve);
    const promptWamid = "wamid.TEST08E8B.G.prompt";
    k.transport.next(async () => {
      inHttp.resolve();
      await go.promise;
      return accepted(promptWamid);
    });
    const d = k.dispatchPass();
    await inHttp.promise;
    // The provider already has the payload: the student taps its REAL option before our record of the acceptance.
    const call = k.transport.calls.filter((c) => c.recipient.id === x.phone).at(-1)!;
    const tap = tapOn(x, "English", { request: call, wamid: promptWamid });
    const first = await post(x, tap);
    await post(x, tap, first.wamid); // and Meta redelivers it
    await k.webhookPass();
    const [, tapTrigger] = await k.triggersOf(x);
    expect((await k.triggerPass()).totals).toMatchObject({ claimed: 1, deferred: 1, finished: 0 });
    expect(await trigger(tapTrigger!.id as string)).toMatchObject({
      status: "PENDING",
      attempts: 0,
      deferrals: 1,
      claim_token: null,
    });
    const deferredSession = (await k.sessionsOf(x))[0]!;
    expect(deferredSession).toMatchObject({
      state: "WAITING_FOR_SEND",
      revision: session0!.revision,
      last_consumed_token: null,
      invalid_attempts: 0,
    });
    expect((await k.eventsOf(session0!.id as string)).map((e) => e.kind)).toEqual([
      "PROMPT_INTERACTION",
    ]);
    expect(await counts(x)).toMatchObject({ inbound: 2, triggers: 2, botRequests: 1, calls: 1 });
    go.resolve();
    expect(await d).toMatchObject({ accepted: 1 });
    await k.settle();
    expect(await trigger(tapTrigger!.id as string)).toMatchObject({
      status: "PROCESSED",
      outcome_code: "input_accepted",
      attempts: 1,
      deferrals: 1,
    });
    expect((await k.eventsOf(session0!.id as string)).map((e) => e.kind)).toEqual([
      "PROMPT_INTERACTION",
      "INPUT_ACCEPTED",
    ]);
    expect(await counts(x)).toMatchObject({ inbound: 2, triggers: 2, botRequests: 3, calls: 3 });
    expect((await k.sessionsOf(x))[0]).toMatchObject({
      current_node_id: "main_menu",
      last_consumed_token: session0!.awaiting_token,
    });
    await expectOneRequestPerStep(x);
  });

  // ------------------------------------------------------------------------------------------------ H takeover and Stop

  // ---------------------------------------------------------------------------------------- referral_source (08E-8C)
  // enquiryFlow lists its triggers as keyword, first_message, referral_source and the matcher takes the FIRST that holds, so a
  // student's first eligible message starts through first_message, never referral_source. The only legitimate way to reach the
  // third trigger is a message that is NOT the conversation's first eligible one (D.4a: an earlier eligible inbound message
  // exists) and is not a keyword, but carries a recorded Meta ad referral. Real shape: the student wrote while the deployment
  // was paused (stored, no trigger), the operator resumed it, and the next message arrives from a click-to-WhatsApp ad.
  // No bot definition is added and no precedence is changed. The matched kind is not persisted, so it is proved by exclusion
  // (the flow has no other trigger that can hold) and by the paired negative below, which differs only by the referral.
  const REFERRAL = {
    source_url: "https://fb.me/FAKE0000",
    source_id: "400000000000001",
    source_type: "ad",
    body: "Join the A/L ICT class",
    headline: "Chat with us",
    media_type: "image",
    image_url: "https://scontent.xx.fbcdn.net/v/FAKE",
    ctwa_clid: "FAKE-ctwa-clid-0000000000000000000000000000000000000001",
  };
  async function earlierThenSecond(x: LoopWorld, second: Record<string, unknown>) {
    const { ctx } = x.w.admin;
    await pauseDeployment(ctx, { deploymentId: x.deployment.id }, { db: t.db });
    await post(x, k.textMessage("Hello, I saw your page"));
    expect((await k.webhookPass()).processed).toBe(1);
    expect(await k.triggersOf(x)).toEqual([]); // no ACTIVE deployment: stored, no trigger, no session
    await resumeDeployment(ctx, { deploymentId: x.deployment.id }, { db: t.db });
    const d = await post(x, second);
    expect((await k.webhookPass()).processed).toBe(1);
    const [tr] = await k.triggersOf(x);
    expect(tr).toMatchObject({ status: "PENDING", attempts: 0 });
    const inbound = await k.inboundOf(x);
    expect(inbound).toHaveLength(2);
    return { wamid: d.wamid, triggerId: tr!.id as string, inbound };
  }

  it("R1. referral_source end to end: a non-first, non-keyword message carrying a recorded ad referral starts the session (signed webhook -> capture -> worker -> dispatcher -> FakeTransport)", async () => {
    const x = await k.world(enquiryFlow());
    const { triggerId, inbound } = await earlierThenSecond(x, {
      ...k.textMessage("Can I get more info about this?"),
      referral: REFERRAL,
    });
    const [m1, m2] = inbound;
    // the three preconditions, from durable rows: first_message is false (an earlier eligible inbound exists, no session yet),
    // the body is no keyword, and the exact message has an attribution for this organization and contact
    expect(m1!.id).not.toBe(m2!.id);
    expect(await k.sessionsOf(x)).toEqual([]);
    const contactId = (await k.one("select contact_id from conversations where id = $1", [
      m2!.conversation_id,
    ]))!.contact_id;
    const attributions = await k.rows(
      "select organization_id, contact_id, message_id, source_type from lead_attributions where message_id = $1",
      [m2!.id],
    );
    expect(attributions).toEqual([
      {
        organization_id: x.w.org.id,
        contact_id: contactId,
        message_id: m2!.id,
        source_type: "META_AD",
      },
    ]);
    expect(await k.rows("select 1 from lead_attributions where message_id = $1", [m1!.id])).toEqual(
      [],
    );

    await k.settle();
    expect(await trigger(triggerId)).toMatchObject({
      status: "PROCESSED",
      outcome_code: "session_started",
      attempts: 1,
    });
    const [s] = await k.sessionsOf(x);
    expect(s).toMatchObject({
      started_by_message_id: m2!.id,
      state: "WAITING_FOR_INPUT",
      current_node_id: "language_menu",
    });
    const sent = k.sentTo(x);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.request.message).toMatchObject(
      expectedPrompt("language_menu", tokenOf(sent[0]!)),
    );
    expect(await counts(x)).toMatchObject({ triggers: 1, sessions: 1, botRequests: 1, calls: 1 });
  });

  it("R2. the paired negative: the same non-first, non-keyword message WITHOUT a referral starts nothing (IGNORED no_trigger_match, no request, no call)", async () => {
    const x = await k.world(enquiryFlow());
    const { triggerId, inbound } = await earlierThenSecond(
      x,
      k.textMessage("Can I get more info about this?"),
    );
    expect(
      await k.rows("select 1 from lead_attributions where message_id = $1", [inbound[1]!.id]),
    ).toEqual([]);
    await k.settle();
    expect(await trigger(triggerId)).toMatchObject({
      status: "IGNORED",
      outcome_code: "no_trigger_match",
    });
    expect(await counts(x)).toMatchObject({ sessions: 0, botRequests: 0, calls: 0 });
  });

  it("H1. staff assign the conversation during the conversation: the student's next real tap ends the session (no notice), nothing more is sent", async () => {
    const x = await k.world(enquiryFlow());
    await atMainList(x);
    const conversationId = (await k.conversationOf(x))!;
    await assignConversation(
      x.w.staff.ctx,
      conversationId,
      { assigneeMembershipId: x.w.staff.membershipId, expectedAssigneeMembershipId: null },
      { db: t.db as never },
    );
    const before = await counts(x);
    await post(x, tapOn(x, "Fees"));
    await k.settle();
    const [s] = await k.sessionsOf(x);
    expect(s).toMatchObject({ state: "HANDED_OVER", terminal_notice_step_seq: null });
    expect(H1_HANDOVER).toContain(s!.handover_reason);
    expect((await k.triggersOf(x)).at(-1)).toMatchObject({
      status: "IGNORED",
      outcome_code: "session_ended",
    });
    expect(await counts(x)).toMatchObject({
      inbound: before.inbound + 1,
      botRequests: before.botRequests,
      calls: before.calls,
    });
  });

  it("H2. staff assign while the bot's prompt is still QUEUED: the dispatcher refuses it (0 BOT calls) and the bot hands over", async () => {
    const x = await k.world(enquiryFlow());
    await captured(x);
    await k.triggerPass();
    await assignConversation(
      x.w.staff.ctx,
      (await k.conversationOf(x))!,
      { assigneeMembershipId: x.w.staff.membershipId, expectedAssigneeMembershipId: null },
      { db: t.db as never },
    );
    await k.settle();
    const [r] = await k.requestsOf(x);
    // The dispatcher's bot rule (bot_request_hold_code) names the staff control; the engine then maps a HELD send to the
    // fixed system hand-over reason send_held (plan F6, J.4 'Failed send'), not to the staff-takeover reasons of a step.
    expect(r).toMatchObject({ origin: "BOT", state: "HELD", hold_reason: "staff_took_over" });
    expect(await counts(x)).toMatchObject({ sessions: 1, botRequests: 1, calls: 0 });
    expect((await k.sessionsOf(x))[0]).toMatchObject({
      state: "HANDED_OVER",
      end_reason: "system_handover",
      handover_reason: "send_held",
    });
  });

  it("H3. operator Stop mid-conversation: the session is handed over (operator_stop); the student's next real tap starts nothing and sends nothing", async () => {
    const x = await k.world(enquiryFlow());
    await atMainList(x);
    const stop = await stopActiveSessions(
      x.w.admin.ctx,
      { deploymentId: x.deployment.id, expectedLiveSessions: 1 },
      { db: t.db as never },
    );
    expect(stop.value).toMatchObject({ sessionsStopped: 1, requestsSuppressed: 0 });
    const before = await counts(x);
    await post(x, tapOn(x, "Fees"));
    await k.settle();
    expect((await k.sessionsOf(x))[0]).toMatchObject({
      state: "HANDED_OVER",
      handover_reason: "operator_stop",
    });
    // Stop left the deployment PAUSED: capture admits no trigger (no ACTIVE deployment); the message stays in the Inbox.
    expect(
      (await k.one("select status from bot_deployments where id = $1", [x.deployment.id]))!.status,
    ).toBe("PAUSED");
    expect(await counts(x)).toMatchObject({
      inbound: before.inbound + 1,
      triggers: before.triggers,
    });
    expect(await counts(x)).toMatchObject({
      sessions: 1,
      botRequests: before.botRequests,
      calls: before.calls,
    });
  });

  it("H4. the accepted window: staff assign AFTER the dispatcher's final authorization; that one message is still sent (1 call, ACCEPTED) and the bot stops at the student's next input", async () => {
    const x = await k.world(enquiryFlow());
    await captured(x);
    await k.triggerPass();
    const inHttp = deferred();
    const go = deferred();
    releases.push(go.resolve);
    k.transport.next(async () => {
      inHttp.resolve();
      await go.promise;
      return accepted("wamid.TEST08E8B.H4");
    });
    const d = k.dispatchPass();
    await inHttp.promise; // past the final authorization
    await assignConversation(
      x.w.staff.ctx,
      (await k.conversationOf(x))!,
      { assigneeMembershipId: x.w.staff.membershipId, expectedAssigneeMembershipId: null },
      { db: t.db as never },
    );
    go.resolve();
    expect(await d).toMatchObject({ accepted: 1 });
    await k.settle();
    const call = k.transport.calls.filter((c) => c.recipient.id === x.phone).at(-1)!;
    await post(x, tapOn(x, "English", { request: call, wamid: "wamid.TEST08E8B.H4" }));
    await k.settle();
    expect((await k.requestsOf(x)).map((r) => r.state)).toEqual(["ACCEPTED"]);
    expect(await counts(x)).toMatchObject({ botRequests: 1, calls: 1 });
    expect((await k.sessionsOf(x))[0]).toMatchObject({ state: "HANDED_OVER" });
  });
});

/** The approved takeover classifier (I.1) code for an assignment. */
const H1_HANDOVER = ["staff_assigned"];

// ------------------------------------------------------------------------------------------------ Phase 08E-8B closed loop
// The CLOSED-LOOP kit (plan N.2 E2E). Every hop is the real application path, configured by EXPLICIT environment objects (never
// process.env), on the disposable database only:
//   signed webhook bytes -> handleWebhookPost (real HMAC verification + ingest) -> processWebhookBatch with the registry built
//   for BOTS_RUNTIME_ENABLED=true (real inbound handler + real trigger capture) -> the bot worker's OWN pool (its J.6 session
//   settings), its preflight, its production step composition and its real trigger and sweep loops -> dispatchBatch (the real
//   dispatcher: recovery, claim, final authorization, fenced record) with a FakeTransport that records every payload.
// The only controlled parts are WHEN each process runs (one pass at a time) and the fake transport's answers. Nothing here can
// reach Meta: there is no transport but the fake, and the live-send gate is only ever set inside this in-memory config.

const CAPTURE_ON = Object.freeze({ BOTS_RUNTIME_ENABLED: "true" });

type SentMessage = { readonly request: SendRequest; readonly wamid: string };

type LoopWorld = {
  readonly w: BotWorld;
  readonly bot: { id: string };
  readonly version: { id: string };
  readonly deployment: { id: string };
  /** The account's trusted routing identifiers (as Meta would address the webhook). */
  readonly pn: string;
  readonly waba: string;
  /** The student's WhatsApp number (a fresh contact: the conversation is created by the first webhook). */
  readonly phone: string;
};

let loopSeq = 0;

function closedLoopKit(t: TestDb) {
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
  const rows = async (text: string, params: unknown[] = []) =>
    (await q(text, params)).rows as Record<string, unknown>[];
  const one = async (text: string, params: unknown[] = []) => (await rows(text, params))[0];

  const handlers = buildWebhookWorkerHandlers(CAPTURE_ON);
  const worker = botWorkerDatabase({ databaseUrl: t.url, concurrency: 2 });
  const workerDb = worker.db as unknown as DbExecutor;
  const production = productionStepDeps(WORKER_ON);
  let preflighted: Promise<void> | null = null;

  // The fake provider: every call is recorded and accepted with a fresh wamid unless a test scripts another answer.
  const transport = new FakeTransport();
  const sent: SentMessage[] = [];
  transport.fallback = (request) => {
    const wamid = `wamid.TEST08E8B.${++loopSeq}.${randomUUID().slice(0, 8)}`;
    sent.push({ request, wamid });
    return { kind: "accepted", wamid, providerStatus: "accepted", httpStatus: 200 };
  };

  /** A send-eligible account with `flow` published and deployed; the student is NOT pre-created. */
  async function world(flow: Record<string, unknown>): Promise<LoopWorld> {
    const w = await botWorld(t.db);
    const account = await one(
      "update whatsapp_accounts set status = 'ACTIVE', credential_ref = 'WA_TOKEN_TEST', archived_at = NULL where id = $1 returning phone_number_id, waba_id",
      [w.account.id],
    );
    const { bot, version } = await publishedBot(t.db, w, flow);
    const deployment = (
      await activateDeployment(
        w.admin.ctx,
        { botId: bot.id, versionId: version.id, whatsappAccountId: w.account.id, priority: 1 },
        { db: t.db },
      )
    ).value;
    const phone = `9477${String(Date.now() % 1e7).padStart(7, "0")}${++loopSeq % 10}`;
    return {
      w,
      bot,
      version,
      deployment,
      pn: account!.phone_number_id as string,
      waba: account!.waba_id as string,
      phone,
    };
  }

  // ---------------------------------------------------------------------------------------- the student's side (webhooks)

  /** Webhook bytes for one student message, exactly as Meta would sign and deliver them. */
  function studentBytes(x: LoopWorld, message: Record<string, unknown>, id?: string) {
    return deliveryBytes({
      pn: x.pn,
      waba: x.waba,
      from: x.phone,
      name: "Student",
      ...(id === undefined ? {} : { id }),
      timestamp: new Date(),
      message,
    });
  }
  const textMessage = (body: string) => ({ type: "text", text: { body } });
  /** A tap on a captured option: the reply id and title are copied from the payload the fake provider received. */
  const tapMessage = (
    option: { id: string; title: string; description?: string },
    subtype: "button_reply" | "list_reply",
    promptWamid: string,
  ) => ({
    type: "interactive",
    interactive: { type: subtype, [subtype]: option },
    context: { from: "15550100001", id: promptWamid },
  });

  /** POSTs the exact bytes through the real signed webhook route handler (requires META_APP_SECRET stubbed). */
  async function post(bytes: Uint8Array): Promise<number> {
    return (await handleWebhookPost(webhookPost(bytes), { db: t.db as never })).status;
  }

  // ---------------------------------------------------------------------------------------- the three processes, one pass each

  const webhookPass = () => processWebhookBatch(t.db, { handlers });

  /**
   * The bot worker's real trigger loop until it finds nothing to claim (its idle sleep ends the pass). `over` replaces parts of
   * the PRODUCTION step composition (test seams for barrier tests only; default: none).
   */
  async function triggerPass(
    over: Partial<StepDeps> = {},
    concurrency = 2,
    processDb: DbExecutor = workerDb,
  ) {
    const stop = new AbortController();
    const deps = { ...production, ...over };
    return runTriggerLoop(
      {
        sleep: async () => stop.abort(),
        now: () => Date.now(),
        random: () => 0.5,
        preflight: () => (preflighted ??= preflight(workerDb)),
        claim: (limit) => claimTriggers(workerDb, limit),
        process: (claim) => processTrigger(processDb, claim, deps),
        concurrency,
      },
      stop.signal,
    );
  }

  /** One sweep of the bot worker's real sweep loop (terminalization, reconciliation, audit). */
  async function sweepPass(over: Partial<StepDeps> = {}) {
    const stop = new AbortController();
    const deps = { ...production, ...over };
    return runSweepLoop(
      {
        sleep: async () => stop.abort(),
        now: () => Date.now(),
        random: () => 0.5,
        preflight: () => (preflighted ??= preflight(workerDb)),
        sweep: () => sweepOnce(workerDb, deps),
      },
      stop.signal,
    );
  }

  /** The real dispatcher (dispatchBatch: recoverStuck, claim, final authorization, fenced record) with the fake transport. */
  const dispatchDeps = (over: Partial<DispatchDeps> = {}): DispatchDeps => ({
    db: t.db as never,
    transport,
    config: BOTS_ON,
    now: () => new Date(),
    random: () => 0.5,
    accountMinIntervalMs: 0,
    conversationMinIntervalMs: 0,
    ...over,
  });
  /**
   * The dispatcher's candidate rule is `next_attempt_at <= its clock`, and the application clock is truncated to the
   * millisecond while the database stamps microseconds. The kit used to compensate with a blind +1 s on the dispatcher's
   * clock (which also hid any host/container clock difference). The invariant is only "every queued request is already due
   * on the dispatcher's own clock", so it is awaited explicitly (bounded) and the dispatcher runs on the real clock.
   */
  async function untilQueuedDue(ms = 5_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const late = await one(
        "select count(*)::int n from outbound_requests where state = 'QUEUED' and next_attempt_at > $1::timestamptz",
        [new Date().toISOString()],
      );
      if (Number(late!.n) === 0) return;
      if (Date.now() > deadline) throw new Error("dispatch: a queued request never became due");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  const dispatchPass = async (over: Partial<DispatchDeps> = {}) => {
    await untilQueuedDue();
    return dispatchBatch(dispatchDeps(over), { batchSize: 20, concurrency: 1 });
  };

  /**
   * Runs webhook worker -> bot worker triggers -> dispatcher -> bot worker sweep until a whole round changes nothing. Fails on
   * any unrecorded or lost work, so a passing settle means every pass ended cleanly.
   */
  async function settle(maxRounds = 30) {
    for (let round = 0; round < maxRounds; round++) {
      const w = await webhookPass();
      const tr = await triggerPass();
      const d = await dispatchPass();
      const s = await sweepPass();
      if (w.failed + w.dead + w.unrecorded + w.leaseLost > 0)
        throw new Error(`settle: webhook pass failed ${JSON.stringify(w)}`);
      if (tr.exit !== "stopped" || tr.totals.failed + tr.totals.lostClaims > 0)
        throw new Error(`settle: trigger pass failed ${JSON.stringify(tr)}`);
      if (s.exit !== "stopped" || s.totals.failed > 0)
        throw new Error(`settle: sweep failed ${JSON.stringify(s)}`);
      if (d.unknown + d.fenceLost + d.recoveredUnknown > 0)
        throw new Error(`settle: dispatch pass failed ${JSON.stringify(d)}`);
      if (
        w.claimed + tr.totals.claimed + d.claimed + s.totals.reconciled + s.totals.terminalized ===
        0
      )
        return round;
    }
    throw new Error("settle: the loop did not quiesce");
  }

  // ---------------------------------------------------------------------------------------- observation

  const conversationOf = async (x: LoopWorld) =>
    (
      await one(
        `select c.id from conversations c join contacts k on k.id = c.contact_id and k.organization_id = c.organization_id
        where c.organization_id = $1 and k.wa_id = $2`,
        [x.w.org.id, x.phone],
      )
    )?.id as string | undefined;
  const sessionsOf = (x: LoopWorld) =>
    rows(
      `select s.* from bot_sessions s join contacts k on k.id = s.contact_id
        where s.organization_id = $1 and k.wa_id = $2 order by s.started_at, s.id`,
      [x.w.org.id, x.phone],
    );
  const requestsOf = (x: LoopWorld) =>
    rows(
      `select r.* from outbound_requests r join conversations c on c.id = r.conversation_id
         join contacts k on k.id = c.contact_id
        where r.organization_id = $1 and k.wa_id = $2 order by r.created_at, r.id`,
      [x.w.org.id, x.phone],
    );
  const triggersOf = (x: LoopWorld) =>
    rows(
      `select b.* from bot_triggers b join conversations c on c.id = b.conversation_id join contacts k on k.id = c.contact_id
        where b.organization_id = $1 and k.wa_id = $2 order by b.created_at, b.id`,
      [x.w.org.id, x.phone],
    );
  const eventsOf = (sessionId: string) =>
    rows(
      "select kind, code, message_id, step_seq from bot_session_events where session_id = $1 order by created_at, id",
      [sessionId],
    );
  const inboundOf = (x: LoopWorld) =>
    rows(
      `select m.* from messages m join conversations c on c.id = m.conversation_id join contacts k on k.id = c.contact_id
        where m.organization_id = $1 and k.wa_id = $2 and m.direction = 'INBOUND' order by m.created_at, m.id`,
      [x.w.org.id, x.phone],
    );
  /** The messages the fake provider received for this student, in order. */
  const sentTo = (x: LoopWorld) => sent.filter((m) => m.request.recipient.id === x.phone);

  /** The options of a captured interactive payload, by title (the real ids the student's app would send back). */
  function optionsOf(m: SentMessage) {
    if (m.request.message.type !== "interactive")
      throw new Error("optionsOf: not an interactive message");
    const p = m.request.message.payload;
    const list =
      p.kind === "buttons"
        ? p.buttons
        : p.sections.flatMap((s) => s.rows as { id: string; title: string }[]);
    return new Map(list.map((o) => [o.title, o]));
  }

  return {
    q,
    rows,
    one,
    world,
    studentBytes,
    textMessage,
    tapMessage,
    post,
    webhookPass,
    triggerPass,
    sweepPass,
    dispatchDeps,
    dispatchPass,
    settle,
    transport,
    sent,
    sentTo,
    optionsOf,
    conversationOf,
    sessionsOf,
    requestsOf,
    triggersOf,
    eventsOf,
    inboundOf,
    workerDb,
    /** The worker pool's own pg Pool (for terminating one of its backends). */
    workerPool: (worker.db as unknown as { $client: TestDb["pool"] }).$client,
    production,
    close: () => worker.close(),
  };
}
