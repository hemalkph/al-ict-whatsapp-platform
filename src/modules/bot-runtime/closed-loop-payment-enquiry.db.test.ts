import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import {
  botAuthoredText,
  enquiryFlow,
  paymentClaimViolations,
  paymentEnquiryFlow,
  type Json,
} from "@/modules/bots/testing";
import { TEST_APP_SECRET } from "@/modules/whatsapp/testing";
import { activateDeployment } from "../bot-control";
import { publishedBot } from "../bot-control/testing";
import { reconcileSession } from "./reconcile";
import { closedLoopKit, type LoopWorld, type SentMessage } from "./testing";

// Phase 08G-3, PE-CL-1 .. PE-CL-9 of docs/PHASE_08G-3_ACCEPTANCE.md: the SYNTHETIC Payment Enquiry golden flow
// (paymentEnquiryFlow, src/modules/bots/testing.ts) through the REAL closed loop of the Student enquiry suite (closedLoopKit:
// signed webhook -> ingest -> webhook worker with capture -> bot worker -> dispatcher -> FakeTransport), on a disposable
// PostgreSQL 17 database only. Nothing here can reach Meta. The tests are WRITTEN BUT NOT YET EXECUTED (they need
// owner-authorized isolated database validation). Staff takeover, Stop/Pause, tenant isolation, version pinning, automation
// gates, redaction and worker recovery are proven once by the Student enquiry and General Information suites and are not
// repeated here.

type Node = Json & { type: string };
const FLOW = paymentEnquiryFlow();
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

/** A persisted outbound_requests row as the message shape botAuthoredText reads (TEXT {body}; INTERACTIVE payload). */
const persistedMessage = (r: Record<string, unknown>): Json =>
  r.message_type === "TEXT"
    ? { type: "text", body: (r.payload as { body: string }).body }
    : { type: "interactive", payload: r.payload };

const CREDENTIAL_WARNING =
  "Please never send card numbers, PINs, passwords or OTP codes in this chat.";

describe("closed loop: Payment Enquiry (SYNTHETIC golden flow), 08G-3", () => {
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
  /** The first message: the session id once the welcome and the payment menu were accepted. */
  async function start(x: LoopWorld, body = "payment") {
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
    return { sent, tokens, requests };
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

  /** A single-notice handover ending at step `notice`, with the given reason. */
  const expectHandover = async (x: LoopWorld, reason: string, notice: number) =>
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        state: "HANDED_OVER",
        end_reason: "flow_handover",
        handover_reason: reason,
        terminal_notice_step_seq: notice,
        variables: {},
      },
    ]);

  // ------------------------------------------------------------------------------------------------ PE-CL-1

  it("PE-CL-1: payment -> How to pay -> Ask another -> Payment dates -> That's all: eight sends in order, one END notice, COMPLETED", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x, "payment");
    expect(await k.sessionsOf(x)).toMatchObject([
      { state: "WAITING_FOR_INPUT", current_node_id: "pay_menu", step_seq: 2, variables: {} },
    ]);
    await tap(x, "How to pay");
    await tap(x, "Ask another");
    await tap(x, "Payment dates");
    await tap(x, "That's all");

    const { tokens, sent } = await expectTranscript(x, sid, [
      T("welcome"),
      P("pay_menu"),
      T("pay_how"), // synthetic instructions only
      P("more"),
      P("pay_menu"), // the SECOND menu, with a fresh token
      T("pay_info"), // synthetic dates only
      P("more"),
      T("bye"),
    ]);
    expect(tokens).toHaveLength(4);
    expect((sent[2]!.request.message as { body: string }).body).toContain(
      "[SYNTHETIC TEST PAYMENT INSTRUCTIONS]",
    );
    expect((sent[5]!.request.message as { body: string }).body).toContain(
      "[SYNTHETIC TEST PAYMENT DATES]",
    );
    await expectTriggers(x, [
      "session_started",
      "input_accepted",
      "input_accepted",
      "input_accepted",
      "input_accepted",
    ]);
    expect((await eventRows(sid)).filter(([kind]) => kind === "INPUT_ACCEPTED")).toHaveLength(4);
    // Bound to this session, organization and pinned flow version; exactly one END notice (the eighth send).
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
        terminal_notice_step_seq: 8,
        step_seq: 8,
        awaiting: null,
        variables: {},
      },
    ]);
  });

  // ------------------------------------------------------------------------------------------------ PE-CL-2

  it.each(["pay", "  PAYMENTS  ", "Payment"])(
    "PE-CL-2: the keyword %j starts the bot (NFC, trimmed, case-insensitive whole-message match)",
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

  it.each(["class", "info", "staff"])(
    "PE-CL-2: with only Payment Enquiry deployed, %j does not start it (no_trigger_match: no session, request or call)",
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

  it("PE-CL-2: with Student Enquiry also deployed (Payment Enquiry at the higher priority 1), 'payment' starts Payment Enquiry on its pinned version and a plain first message starts Student Enquiry", async () => {
    const x = await k.world(FLOW); // Payment Enquiry, priority 1 (world's explicit deployment priority)
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
    const keyword = await start(x, "payment");
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
    // The keyword student got the Payment welcome; the plain first message got Student Enquiry's language menu.
    expect(k.sentTo(x)[0]!.request.message).toEqual(nodeText("welcome"));
    expect(k.sentTo(y)[0]!.request.message.type).toBe("interactive");
  });

  // ------------------------------------------------------------------------------------------------ PE-CL-3, 4, 5

  it("PE-CL-3: 'I have paid' hands over as needs_staff with exactly one notice that confirms nothing and asks for no slip", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await tap(x, "I have paid");
    const { requests } = await expectTranscript(x, sid, [
      T("welcome"),
      P("pay_menu"),
      T("verify_staff"),
    ]);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_ACCEPTED", null],
      ["HANDED_OVER", "needs_staff"],
    ]);
    await expectHandover(x, "needs_staff", 3);
    expect(k.sentTo(x).filter((m) => m.request.message.type === "text")).toHaveLength(2); // welcome and the one notice
    // The ACTUAL persisted notice: no claim, no artefact request.
    const notice = botAuthoredText(persistedMessage(requests[2]!)).join("\n");
    expect(notice).toContain("I can't confirm it");
    expect(paymentClaimViolations(notice)).toEqual([]);
    expect(notice).not.toMatch(/\b(slip|receipt|screenshot|photo|upload|send)\b/i);
  });

  it("PE-CL-4: 'Payment problem' hands over as needs_staff with exactly one notice", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await tap(x, "Payment problem");
    await expectTranscript(x, sid, [T("welcome"), P("pay_menu"), T("problem_staff")]);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_ACCEPTED", null],
      ["HANDED_OVER", "needs_staff"],
    ]);
    await expectHandover(x, "needs_staff", 3);
    expect(k.sentTo(x).filter((m) => m.request.message.type === "text")).toHaveLength(2);
  });

  it("PE-CL-5: Talk to staff from Payment Options and from More Options hands over as student_requested", async () => {
    const a = await k.world(FLOW);
    const sa = await start(a);
    await tap(a, "Talk to staff");
    await expectTranscript(a, sa, [T("welcome"), P("pay_menu"), T("to_staff")]);
    await expectHandover(a, "student_requested", 3);

    const b = await k.world(FLOW);
    const sb = await start(b);
    await tap(b, "How to pay");
    await tap(b, "Talk to staff");
    await expectTranscript(b, sb, [
      T("welcome"),
      P("pay_menu"),
      T("pay_how"),
      P("more"),
      T("to_staff"),
    ]);
    await expectHandover(b, "student_requested", 5);
  });

  // ------------------------------------------------------------------------------------------------ PE-CL-6

  it("PE-CL-6: an invalid reply re-sends the same menu with a different token, and the new token is accepted", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await say(x, "I paid yesterday");
    expect(await k.sessionsOf(x)).toMatchObject([
      { state: "WAITING_FOR_INPUT", current_node_id: "pay_menu", invalid_attempts: 1 },
    ]);
    const [first, reprompt] = k.sentTo(x).slice(1).map(tokenOf); // from the captured payloads, not fabricated
    expect(reprompt).not.toBe(first);
    await tap(x, "Payment dates"); // taps the re-prompt's option ids, i.e. the new token
    const { tokens } = await expectTranscript(x, sid, [
      T("welcome"),
      P("pay_menu"),
      P("pay_menu"), // the re-prompt
      T("pay_info"),
      P("more"),
    ]);
    expect(tokens.slice(0, 2)).toEqual([first, reprompt]);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_REJECTED", "wrong_kind"],
      ["INPUT_ACCEPTED", null],
    ]);
    expect(await k.sessionsOf(x)).toMatchObject([{ current_node_id: "more", invalid_attempts: 0 }]);
  });

  it("PE-CL-6: two invalid replies hand over as invalid_input with the notice (no second re-prompt)", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await say(x, "??");
    await say(x, "!!");
    await expectTranscript(x, sid, [
      T("welcome"),
      P("pay_menu"),
      P("pay_menu"),
      T("invalid_to_staff"),
    ]);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_REJECTED", "wrong_kind"],
      ["INPUT_REJECTED", "wrong_kind"],
      ["HANDED_OVER", "invalid_input"],
    ]);
    await expectHandover(x, "invalid_input", 4);
  });

  // ------------------------------------------------------------------------------------------------ PE-CL-7

  it("PE-CL-7: the keyword 'payment' typed while the menu (and later the buttons) awaits an answer is wrong_kind, keeps the session and starts no other bot", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await say(x, "payment"); // at the LIST
    await expectTriggers(x, ["session_started", "input_rejected"]);
    expect((await eventRows(sid)).at(-1)).toEqual(["INPUT_REJECTED", "wrong_kind"]);
    expect(await k.sessionsOf(x)).toMatchObject([
      { id: sid, state: "WAITING_FOR_INPUT", current_node_id: "pay_menu", invalid_attempts: 1 },
    ]);
    await tap(x, "How to pay"); // the same session is still the one answered; the counter resets
    await say(x, "pay"); // at the BUTTONS
    await expectTriggers(x, [
      "session_started",
      "input_rejected",
      "input_accepted",
      "input_rejected",
    ]);
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        id: sid,
        bot_id: x.bot.id,
        bot_version_id: x.version.id,
        state: "WAITING_FOR_INPUT",
        current_node_id: "more",
        invalid_attempts: 1,
      },
    ]);
    await tap(x, "That's all");
    expect((await k.sessionsOf(x)).map((s) => s.id)).toEqual([sid]); // never a second session
    await expectTranscript(x, sid, [
      T("welcome"),
      P("pay_menu"),
      P("pay_menu"), // re-prompt after the typed keyword
      T("pay_how"),
      P("more"),
      P("more"), // re-prompt after the typed keyword
      T("bye"),
    ]);
  });

  it("PE-CL-7: after END a new keyword inside the 30-minute cooldown is ignored (cooldown): no session, request or call", async () => {
    const x = await k.world(FLOW);
    await start(x);
    await tap(x, "Payment dates");
    await tap(x, "That's all");
    const before = await counts(x);
    expect(before).toMatchObject({ sessions: 1, botRequests: 5, calls: 5 });
    for (const keyword of ["payment", "pay"]) {
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

  // ------------------------------------------------------------------------------------------------ PE-CL-8

  describe("PE-CL-8: persisted payment safety", () => {
    /** The bot's own persisted outbound requests of one session (never the student's inbound rows), as messages. */
    async function persistedBotMessages(x: LoopWorld, sessionId: string) {
      const rows = await k.rows(
        `select message_type, payload, origin from outbound_requests
          where organization_id = $1 and bot_session_id = $2 and origin = 'BOT' order by bot_step_seq`,
        [x.w.org.id, sessionId],
      );
      expect(rows.length).toBeGreaterThan(0);
      return rows.map(persistedMessage);
    }

    /** Every safety rule over the bot-authored text of one finished session. */
    async function expectSafe(x: LoopWorld, sessionId: string) {
      const messages = await persistedBotMessages(x, sessionId);
      const texts = messages.flatMap(botAuthoredText);
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) {
        expect(paymentClaimViolations(text), text).toEqual([]); // no receipt/completion/success/verification claim
        const rest = text.replace(CREDENTIAL_WARNING, ""); // the one "never send" warning is the only credential mention
        expect(rest, text).not.toMatch(
          /\b(slip|receipt|screenshot|photo|upload|card|cvv|pin|otp|password|passcode|bank|account|iban|swift|national id|nic|login|send (us|me)|enter|share your)\b/i,
        );
        expect(text, text).not.toMatch(
          /https?:|www\.|@|\b(rs\.?|lkr|usd)\s?\d|\$\s?\d|\d|\b(fees?|price|cost|amount|due|deadline|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
        );
      }
      // No variable and no QUESTION-based collection: the session holds nothing the student typed.
      expect(await k.sessionsOf(x)).toMatchObject([{ id: sessionId, variables: {} }]);
      // The bot created no lead and no contact tag for this organization (L11).
      for (const table of ["leads", "contact_tags"])
        expect(
          await k.one(`select count(*)::int as n from ${table} where organization_id = $1`, [
            x.w.org.id,
          ]),
        ).toEqual({ n: 0 });
      return messages;
    }

    it("every terminal path leaves only safe persisted bot text and an empty session", async () => {
      const paths: Array<[string, (x: LoopWorld) => Promise<void>]> = [
        [
          "information",
          async (x) => {
            await tap(x, "How to pay");
            await tap(x, "Ask another");
            await tap(x, "Payment dates");
            await tap(x, "That's all");
          },
        ],
        ["verification enquiry", (x) => tap(x, "I have paid").then(() => undefined)],
        ["problem", (x) => tap(x, "Payment problem").then(() => undefined)],
        ["staff", (x) => tap(x, "Talk to staff").then(() => undefined)],
        [
          "invalid",
          async (x) => {
            await say(x, "I have paid, here is my slip");
            await say(x, "my card number is ...");
          },
        ],
      ];
      for (const [name, drive] of paths) {
        const x = await k.world(FLOW);
        const sid = await start(x);
        await drive(x);
        const messages = await expectSafe(x, sid);
        // The student's own words (inbound rows) are not part of the bot's scanned set.
        expect(messages.length, name).toBe(k.sentTo(x).length);
      }
    });

    it("the student's 'I have paid' selection is a persisted INBOUND event, not a bot claim; the bot's reply to it states no receipt", async () => {
      const x = await k.world(FLOW);
      const sid = await start(x);
      await tap(x, "I have paid");
      const inbound = await k.inboundOf(x);
      expect(inbound.at(-1)).toMatchObject({ direction: "INBOUND" });
      const messages = await persistedBotMessages(x, sid);
      // The menu OFFERS the title; scanning it as a bot sentence would be wrong, and the scanner excludes titles.
      const menu = JSON.stringify(messages[1]);
      expect(menu).toContain("I have paid");
      expect(messages.flatMap(botAuthoredText).join("\n")).not.toContain("I have paid");
      expect(messages.flatMap(botAuthoredText).flatMap(paymentClaimViolations)).toEqual([]);
    });

    it("the scanner cannot pass falsely: it flags a claim injected into the ACTUAL persisted payloads (text and interactive)", async () => {
      const x = await k.world(FLOW);
      const sid = await start(x);
      const [welcome, menu] = await persistedBotMessages(x, sid);
      // Sanity: the genuine persisted messages are clean and non-empty.
      expect(botAuthoredText(welcome!).length).toBeGreaterThan(0);
      expect(botAuthoredText(menu!).length).toBeGreaterThan(0);
      expect([welcome!, menu!].flatMap(botAuthoredText).flatMap(paymentClaimViolations)).toEqual(
        [],
      );
      // Injected positives are caught.
      const tamperedText = { ...welcome, body: "We have received your payment." };
      const tamperedMenu = JSON.parse(JSON.stringify(menu)) as {
        payload: { body: string };
      };
      tamperedMenu.payload.body = "Your payment has been confirmed.";
      expect(botAuthoredText(tamperedText).flatMap(paymentClaimViolations)).toHaveLength(1);
      expect(botAuthoredText(tamperedMenu).flatMap(paymentClaimViolations)).toHaveLength(1);
      // Injected safe wording is not.
      const safe = { ...welcome, body: "This payment is not confirmed." };
      expect(botAuthoredText(safe).flatMap(paymentClaimViolations)).toEqual([]);
    });
  });

  // ------------------------------------------------------------------------------------------------ PE-CL-9

  it("PE-CL-9: reconciliation with a fixed decision clock: not due 1 ms before expires_at, COMPLETED idle_timeout at expires_at, silently", async () => {
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
});
