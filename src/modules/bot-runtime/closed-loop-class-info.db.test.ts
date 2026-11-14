import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { classInfoFlow, enquiryFlow, generalInfoFlow } from "@/modules/bots/testing";
import { TEST_APP_SECRET } from "@/modules/whatsapp/testing";
import { activateDeployment } from "../bot-control";
import { publishedBot } from "../bot-control/testing";
import { reconcileSession } from "./reconcile";
import { closedLoopKit, type LoopWorld, type SentMessage } from "./testing";

// Phase 08G-2, CI-CL-1 .. CI-CL-8 of docs/PHASE_08G-2_ACCEPTANCE.md: the SYNTHETIC Class Information golden flow
// (classInfoFlow, src/modules/bots/testing.ts) through the REAL closed loop of the Student enquiry suite (closedLoopKit: signed
// webhook -> ingest -> webhook worker with capture -> bot worker -> dispatcher -> FakeTransport), on a disposable PostgreSQL 17
// database only. Nothing here can reach Meta. The tests are WRITTEN BUT NOT YET EXECUTED (they need owner-authorized isolated
// database validation). Staff takeover, Stop/Pause, tenant isolation, version pinning, automation gates, redaction and worker
// recovery are proven once by the Student enquiry and General Information suites and are not repeated here.

type Node = Record<string, unknown> & { type: string };
const FLOW = classInfoFlow();
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

const CLASS_ONE = "[TEST] Class one";
const CLASS_THREE = "[TEST] Class three";

describe("closed loop: Class Information (SYNTHETIC golden flow), 08G-2", () => {
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
  /** The first message: the session id once the welcome and the class list were accepted. */
  async function start(x: LoopWorld, body = "classes") {
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

  // ------------------------------------------------------------------------------------------------ CI-CL-1

  it("CI-CL-1: classes -> class one -> Another class -> class three (second LIST) -> That's all: eight sends in order, one END notice, COMPLETED", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x, "classes");
    expect(await k.sessionsOf(x)).toMatchObject([
      { state: "WAITING_FOR_INPUT", current_node_id: "class_list", step_seq: 2, variables: {} },
    ]);
    await tap(x, CLASS_ONE);
    await tap(x, "Another class");
    await tap(x, CLASS_THREE);
    await tap(x, "That's all");

    const { tokens } = await expectTranscript(x, sid, [
      T("welcome"),
      P("class_list"),
      T("cls_c1"), // exactly the first selected class
      P("more"),
      P("class_list"), // the SECOND list, with a fresh token
      T("cls_c3"), // exactly the second selected class
      P("more"),
      T("bye"),
    ]);
    expect(tokens).toHaveLength(4);
    expect(nodeText("bye")).toEqual(textOf("Thank you. This enquiry is complete."));
    await expectTriggers(x, [
      "session_started",
      "input_accepted",
      "input_accepted",
      "input_accepted",
      "input_accepted",
    ]);
    expect((await eventRows(sid)).filter(([kind]) => kind === "INPUT_ACCEPTED")).toHaveLength(4);
    // Bound to this session, organization and pinned flow version.
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        id: sid,
        organization_id: x.w.org.id,
        bot_id: x.bot.id,
        bot_version_id: x.version.id,
        deployment_id: x.deployment.id,
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

  // ------------------------------------------------------------------------------------------------ CI-CL-2

  it.each(["class", "  CLASSES  ", "Class"])(
    "CI-CL-2: the keyword %j starts the bot (NFC, trimmed, case-insensitive whole-message match)",
    async (body) => {
      const x = await k.world(FLOW);
      const sid = await start(x, body);
      const [inbound] = await k.inboundOf(x);
      expect(inbound).toMatchObject({ type: "TEXT", body });
      expect(await k.sessionsOf(x)).toMatchObject([
        {
          id: sid,
          bot_version_id: x.version.id,
          state: "WAITING_FOR_INPUT",
          started_by_message_id: inbound!.id,
        },
      ]);
      expect(k.sentTo(x)[0]!.request.message).toEqual(nodeText("welcome"));
      await expectTriggers(x, ["session_started"]);
    },
  );

  it.each(["info", "faq"])(
    "CI-CL-2: with only Class Information deployed, %j does not start it (no_trigger_match: no session, request or call)",
    async (body) => {
      const x = await k.world(FLOW);
      await say(x, body);
      expect((await k.triggersOf(x)).map((tr) => [tr.status, tr.outcome_code])).toEqual([
        ["IGNORED", "no_trigger_match"],
      ]);
      expect(await counts(x)).toEqual({
        inbound: 1,
        triggers: 1,
        sessions: 0,
        botRequests: 0,
        calls: 0,
      });
    },
  );

  it("CI-CL-2: with Student Enquiry also deployed (Class Information at the higher priority 1), 'classes' starts Class Information on its pinned version and a plain first message starts Student Enquiry", async () => {
    const x = await k.world(FLOW); // Class Information, priority 1 (world's explicit deployment priority)
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
    // Separate fresh students: no cooldown or live session can interfere.
    const keyword = await start(x, "classes");
    const y = anotherStudent(x);
    const plain = await start(y, "Good morning");
    expect(keyword).not.toBe(plain);
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        id: keyword,
        bot_id: x.bot.id,
        bot_version_id: x.version.id,
        deployment_id: x.deployment.id,
      },
    ]);
    expect(await k.sessionsOf(y)).toMatchObject([{ id: plain, bot_id: se.bot.id }]);
    expect((await k.sessionsOf(y))[0]!.bot_id).not.toBe(x.bot.id);
    // The keyword student got the Class Information welcome; the plain first message got Student Enquiry's language menu.
    expect(k.sentTo(x)[0]!.request.message).toEqual(nodeText("welcome"));
    expect(k.sentTo(y)[0]!.request.message.type).toBe("interactive");
  });

  // ------------------------------------------------------------------------------------------------ CI-CL-3, 4

  it("CI-CL-3: Class not listed hands over as needs_staff with exactly one notice", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await tap(x, "Class not listed");
    await expectTranscript(x, sid, [T("welcome"), P("class_list"), T("needs_staff")]);
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
    expect(k.sentTo(x).filter((m) => m.request.message.type === "text")).toHaveLength(2); // welcome and the one notice
  });

  it("CI-CL-4: Talk to staff from the class list and from the buttons hands over as student_requested", async () => {
    const a = await k.world(FLOW);
    const sa = await start(a);
    await tap(a, "Talk to staff");
    await expectTranscript(a, sa, [T("welcome"), P("class_list"), T("to_staff")]);
    expect(await k.sessionsOf(a)).toMatchObject([
      {
        state: "HANDED_OVER",
        end_reason: "flow_handover",
        handover_reason: "student_requested",
        terminal_notice_step_seq: 3,
      },
    ]);

    const b = await k.world(FLOW);
    const sb = await start(b);
    await tap(b, "[TEST] Class two");
    await tap(b, "Talk to staff");
    await expectTranscript(b, sb, [
      T("welcome"),
      P("class_list"),
      T("cls_c2"),
      P("more"),
      T("to_staff"),
    ]);
    expect(await k.sessionsOf(b)).toMatchObject([
      {
        state: "HANDED_OVER",
        end_reason: "flow_handover",
        handover_reason: "student_requested",
        terminal_notice_step_seq: 5,
      },
    ]);
  });

  // ------------------------------------------------------------------------------------------------ CI-CL-5

  it("CI-CL-5: an invalid reply re-sends the same list with a different token, and the new token is accepted", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await say(x, "when is the class?");
    expect(await k.sessionsOf(x)).toMatchObject([
      { state: "WAITING_FOR_INPUT", current_node_id: "class_list", invalid_attempts: 1 },
    ]);
    const [first, reprompt] = k.sentTo(x).slice(1).map(tokenOf); // from the captured payloads, not fabricated
    expect(reprompt).not.toBe(first);
    await tap(x, CLASS_ONE); // taps the re-prompt's option ids, i.e. the new token
    const { tokens } = await expectTranscript(x, sid, [
      T("welcome"),
      P("class_list"),
      P("class_list"), // the re-prompt
      T("cls_c1"),
      P("more"),
    ]);
    expect(tokens.slice(0, 2)).toEqual([first, reprompt]);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_REJECTED", "wrong_kind"],
      ["INPUT_ACCEPTED", null],
    ]);
    expect(await k.sessionsOf(x)).toMatchObject([{ current_node_id: "more", invalid_attempts: 0 }]);
  });

  it("CI-CL-5: two invalid replies hand over as invalid_input with the notice (no second re-prompt)", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await say(x, "??");
    await say(x, "!!");
    await expectTranscript(x, sid, [
      T("welcome"),
      P("class_list"),
      P("class_list"),
      T("invalid_to_staff"),
    ]);
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

  // ------------------------------------------------------------------------------------------------ CI-CL-6

  it("CI-CL-6: Another class returns to the class list; the keyword 'class' typed while that list awaits an answer is wrong_kind, keeps the session and starts no other bot", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await tap(x, CLASS_ONE);
    await tap(x, "Another class");
    expect(await k.sessionsOf(x)).toMatchObject([
      { id: sid, state: "WAITING_FOR_INPUT", current_node_id: "class_list", invalid_attempts: 0 },
    ]);
    await say(x, "class");
    await expectTriggers(x, [
      "session_started",
      "input_accepted",
      "input_accepted",
      "input_rejected",
    ]);
    expect((await eventRows(sid)).at(-1)).toEqual(["INPUT_REJECTED", "wrong_kind"]);
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        id: sid,
        bot_id: x.bot.id,
        bot_version_id: x.version.id,
        state: "WAITING_FOR_INPUT",
        current_node_id: "class_list",
        invalid_attempts: 1,
      },
    ]);
    await tap(x, CLASS_THREE); // the same session is still the one answered
    expect((await k.sessionsOf(x)).map((s) => s.id)).toEqual([sid]);
    await expectTranscript(x, sid, [
      T("welcome"),
      P("class_list"),
      T("cls_c1"),
      P("more"),
      P("class_list"),
      P("class_list"), // the re-prompt after the typed keyword
      T("cls_c3"),
      P("more"),
    ]);
  });

  // ------------------------------------------------------------------------------------------------ CI-CL-7

  it("CI-CL-7: reconciliation with a fixed decision clock: not due 1 ms before expires_at, COMPLETED idle_timeout at expires_at, silently", async () => {
    // This proves the reconciler's DECISION (reconcileSession with readClock). It is NOT a sweep candidate-discovery test:
    // listReconcileCandidates filters on the real clock_timestamp(), which a decision clock cannot move.
    const x = await k.world(FLOW);
    const sid = await start(x);
    const before = await counts(x);
    const [live] = await k.sessionsOf(x);
    expect(live!.expires_at).toBeInstanceOf(Date);
    const expiry = (live!.expires_at as Date).getTime();
    expect(expiry - Date.now()).toBeGreaterThan(29 * MIN); // set from the 30-minute idle timeout
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
    expect(await k.sessionsOf(x)).toMatchObject([{ id: sid, state: "WAITING_FOR_INPUT" }]);
    expect(await reconcile(at(expiry))).toMatchObject({ kind: "applied", action: "idle_expired" });
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        id: sid,
        state: "COMPLETED",
        end_reason: "idle_timeout",
        handover_reason: null,
        terminal_notice_step_seq: null,
      },
    ]);
    expect((await k.sessionsOf(x))[0]!.output_suppressed_at).toBeInstanceOf(Date);
    expect(await counts(x)).toMatchObject({ botRequests: before.botRequests, calls: before.calls });
    expect(await eventRows(sid)).toEqual([]);
  });

  // ------------------------------------------------------------------------------------------------ CI-CL-8

  it("CI-CL-8: with General Information also deployed, a live Class Information session cannot switch bots, and after END a keyword inside the 30-minute cooldown is ignored", async () => {
    const x = await k.world(FLOW); // Class Information, priority 1
    const gi = await publishedBot(t.db, x.w, generalInfoFlow());
    await activateDeployment(
      x.w.admin.ctx,
      {
        botId: gi.bot.id,
        versionId: gi.version.id,
        whatsappAccountId: x.w.account.id,
        priority: 2,
      },
      { db: t.db },
    );
    const sid = await start(x, "classes");
    await say(x, "info"); // General Information's keyword, mid-session
    expect((await k.triggersOf(x)).map((tr) => tr.outcome_code)).toEqual([
      "session_started",
      "input_rejected",
    ]);
    expect((await k.sessionsOf(x)).map((s) => [s.id, s.bot_id])).toEqual([[sid, x.bot.id]]);
    await tap(x, CLASS_ONE);
    await tap(x, "That's all");
    expect(await k.sessionsOf(x)).toMatchObject([
      { id: sid, state: "COMPLETED", end_reason: "flow_end" },
    ]);

    const before = await counts(x);
    expect(before).toMatchObject({ sessions: 1, calls: before.botRequests });
    for (const keyword of ["classes", "info"]) {
      await say(x, keyword);
      expect((await k.triggersOf(x)).at(-1)).toMatchObject({
        status: "IGNORED",
        outcome_code: "cooldown",
      });
    }
    expect(await counts(x)).toEqual({
      ...before,
      inbound: before.inbound + 2,
      triggers: before.triggers + 2,
    });
  });
});
