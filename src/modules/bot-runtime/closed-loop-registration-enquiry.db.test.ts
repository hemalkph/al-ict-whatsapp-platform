import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { canonicalFlowJson, validateFlow } from "@/modules/bots";
import {
  REGISTRATION_SYNTHETIC_YEARS,
  enquiryFlow,
  registrationClaimViolations,
  registrationEnquiryFlow,
  type Json,
} from "@/modules/bots/testing";
import { listMessages } from "@/modules/inbox";
import { TEST_APP_SECRET } from "@/modules/whatsapp/testing";
import { activateDeployment } from "../bot-control";
import { publishedBot, shortenRetention } from "../bot-control/testing";
import { reconcileSession } from "./reconcile";
import { closedLoopKit, type LoopWorld, type SentMessage } from "./testing";

// Phase 08G-5, RE-CL-1 .. RE-CL-12 of docs/PHASE_08G-5_ACCEPTANCE.md: the SYNTHETIC Registration Enquiry golden flow
// (registrationEnquiryFlow, src/modules/bots/testing.ts) through the REAL closed loop (closedLoopKit: signed webhook -> ingest
// -> webhook worker -> bot worker -> dispatcher -> FakeTransport) on a disposable PostgreSQL 17 database only. Nothing here can
// reach Meta. WRITTEN BUT NOT YET EXECUTED (needs owner-authorized isolated database validation). Staff takeover, Stop/Pause,
// tenant isolation, version pinning, automation gates, duplicate webhooks and worker recovery are proven once by the Student
// enquiry, General Information and Payment suites and are not repeated here. Nothing here registers, enrols or creates a lead:
// the flow is an enquiry note for staff (V3.2 C.9).

type Node = Json & { type: string };
const FLOW = registrationEnquiryFlow();
const NODES = FLOW.nodes as Record<string, Node>;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const MIN = 60_000;
const YEAR = REGISTRATION_SYNTHETIC_YEARS.min + 1;
const CLASS_ONE = "[TEST] Class one";
const ASK_NAME = NODES.ask_name!.text as string;
const ASK_YEAR = NODES.ask_year!.text as string;

const textOf = (body: string) => ({ type: "text", body, replyToWamid: null });
const confirmBody = (name: string, year: number, cls: string) =>
  (NODES.confirm!.body as string)
    .replace("{{reg_name}}", name)
    .replace("{{al_year}}", String(year))
    .replace("{{class_pref}}", cls);

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

/** The exact interactive payload node `id` must produce for `token` (and `body`), built from the fixture, not the capture. */
function expectedPrompt(id: string, token: string, body = NODES[id]!.body as string) {
  const n = NODES[id]!;
  const options = n.options as Array<Record<string, string>>;
  if (n.type === "BUTTONS")
    return {
      type: "interactive",
      payload: {
        v: 1,
        kind: "buttons",
        body,
        buttons: options.map((o) => ({ id: `b1.${token}.${o.key}`, title: o.title })),
      },
    };
  return {
    type: "interactive",
    payload: {
      v: 1,
      kind: "list",
      body,
      buttonLabel: n.buttonLabel,
      footer: n.footer,
      sections: [
        {
          title: n.buttonLabel,
          rows: options.map((o) => ({
            id: `b1.${token}.${o.key}`,
            title: o.title,
            ...(o.description === undefined ? {} : { description: o.description }),
          })),
        },
      ],
    },
  };
}

describe("closed loop: Registration Enquiry (SYNTHETIC golden flow), 08G-5", () => {
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

  const anotherStudent = (x: LoopWorld): LoopWorld => ({
    ...x,
    phone: `9479${String(Date.now() % 1e7).padStart(7, "0")}${++phoneSeq % 10}`,
  });

  /** The student's text through the real signed route; the whole loop then runs until nothing is left to do. */
  async function say(x: LoopWorld, body: string) {
    const { bytes } = k.studentBytes(x, k.textMessage(body));
    expect(await k.post(bytes)).toBe(200);
    await k.settle();
  }
  /** The first message: the session id once the welcome and the consent buttons were accepted. */
  async function start(x: LoopWorld, body = "register") {
    await say(x, body);
    const [s, ...more] = await k.sessionsOf(x);
    expect(more).toEqual([]);
    return s!.id as string;
  }
  /** Taps the option titled `title` on the LAST captured prompt: its real id and the real prompt wamid go back. */
  async function tap(x: LoopWorld, title: string) {
    const prompt = k.sentTo(x).at(-1)!;
    if (prompt.request.message.type !== "interactive") throw new Error("last send is not a prompt");
    const subtype =
      prompt.request.message.payload.kind === "buttons" ? "button_reply" : "list_reply";
    const option = k.optionsOf(prompt).get(title);
    if (!option) throw new Error(`no option titled ${title}`);
    const { bytes } = k.studentBytes(x, k.tapMessage(option, subtype, prompt.wamid));
    expect(await k.post(bytes)).toBe(200);
    await k.settle();
  }
  /** Consent -> name -> year -> class: the session then waits at `confirm`. */
  async function collect(x: LoopWorld, name = "Test Student", year = YEAR, cls = CLASS_ONE) {
    await tap(x, "Continue");
    await say(x, name);
    await say(x, String(year));
    await tap(x, cls);
  }

  const session = async (x: LoopWorld) => (await k.sessionsOf(x))[0]!;
  const eventRows = async (sessionId: string) =>
    (await k.eventsOf(sessionId)).map((e) => [e.kind, e.code]);
  /** The text or interactive body of every message the fake provider received for this student (no template is sent). */
  const bodies = (x: LoopWorld) =>
    k.sentTo(x).map((m) => {
      const message = m.request.message;
      if (message.type === "text") return message.body;
      if (message.type === "interactive") return message.payload.body;
      throw new Error("unexpected template send");
    });

  /** Every durable count for this student plus the provider calls. */
  async function counts(x: LoopWorld) {
    const requests = await k.requestsOf(x);
    return {
      inbound: (await k.inboundOf(x)).length,
      triggers: (await k.triggersOf(x)).length,
      sessions: (await k.sessionsOf(x)).length,
      botRequests: requests.filter((r) => r.origin === "BOT").length,
      calls: k.transport.calls.filter((c) => c.recipient.id === x.phone).length,
    };
  }

  /** Every persisted OUTBOUND message of this conversation: the stored body and stored interactive content. */
  async function outboundText(x: LoopWorld): Promise<string> {
    const r = await k.rows(
      "select body, content from messages where organization_id = $1 and conversation_id = $2 and direction = 'OUTBOUND'",
      [x.w.org.id, (await k.conversationOf(x))!],
    );
    return JSON.stringify(r);
  }

  /**
   * Non-reflection: no bot-authored text (sent to the provider or stored as OUTBOUND) contains `value`. The student's own
   * INBOUND message with `value` is expected to remain in history; nothing deletes it.
   */
  async function expectNotReflected(x: LoopWorld, value: string) {
    for (const b of bodies(x)) expect(b).not.toContain(value);
    for (const m of k.sentTo(x)) expect(JSON.stringify(m.request.message)).not.toContain(value);
    expect(await outboundText(x)).not.toContain(value);
    expect((await k.inboundOf(x)).some((m) => m.body === value)).toBe(true);
  }

  /** The persisted requests of the session: one per send, in step order, all BOT and ACCEPTED by the fake provider. */
  async function expectRequests(x: LoopWorld, sessionId: string, sends: number) {
    const requests = await k.rows(
      `select r.*, m.wamid, m.body, m.type from outbound_requests r join messages m on m.id = r.message_id
        where r.organization_id = $1 and r.bot_session_id = $2 order by r.bot_step_seq`,
      [x.w.org.id, sessionId],
    );
    expect(requests.map((r) => r.bot_step_seq)).toEqual(
      Array.from({ length: sends }, (_, i) => i + 1),
    );
    expect(requests.map((r) => r.idempotency_key)).toEqual(
      Array.from({ length: sends }, (_, i) => `bot-${sessionId}-${i + 1}`),
    );
    expect(requests.map((r) => [r.origin, r.state, r.attempt_count])).toEqual(
      Array.from({ length: sends }, () => ["BOT", "ACCEPTED", 1]),
    );
    expect(requests.map((r) => r.wamid)).toEqual(k.sentTo(x).map((m) => m.wamid));
    expect(await k.requestsOf(x)).toHaveLength(sends);
    expect(k.transport.calls.filter((c) => c.recipient.id === x.phone)).toHaveLength(sends);
    return requests;
  }

  // ------------------------------------------------------------------------------------------------ RE-CL-1

  it.each(["register", "  REGISTRATION  ", "Join", "rEgIsTeR"])(
    "RE-CL-1: the keyword %j starts Registration Enquiry on its pinned version and deployment",
    async (body) => {
      const x = await k.world(FLOW);
      const sid = await start(x, body);
      const [inbound] = await k.inboundOf(x);
      expect(inbound).toMatchObject({ type: "TEXT", body });
      expect(await k.sessionsOf(x)).toMatchObject([
        {
          id: sid,
          organization_id: x.w.org.id,
          bot_id: x.bot.id,
          bot_version_id: x.version.id,
          deployment_id: x.deployment.id,
          state: "WAITING_FOR_INPUT",
          current_node_id: "consent",
          started_by_message_id: inbound!.id,
        },
      ]);
    },
  );

  it.each(["registering", "join class", "reg", "registration please", "staff"])(
    "RE-CL-1: with only Registration deployed, %j does not start it (no_trigger_match: no session, request or call)",
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

  it("RE-CL-1: with Student Enquiry (first_message) also deployed, 'join' starts Registration and a plain first message starts Student Enquiry", async () => {
    const x = await k.world(FLOW); // Registration, priority 1
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
    const keyword = await start(x, "join");
    const y = anotherStudent(x);
    const plain = await start(y, "Good morning");
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        id: keyword,
        organization_id: x.w.org.id,
        bot_id: x.bot.id,
        bot_version_id: x.version.id,
        deployment_id: x.deployment.id,
      },
    ]);
    expect(await k.sessionsOf(y)).toMatchObject([
      { id: plain, bot_id: se.bot.id, bot_version_id: se.version.id },
    ]);
    expect(k.sentTo(x)[0]!.request.message).toEqual(textOf(NODES.welcome!.text as string));
    expect(k.sentTo(y)[0]!.request.message.type).toBe("interactive"); // Student Enquiry's language menu
  });

  // ------------------------------------------------------------------------------------------------ RE-CL-2

  it("RE-CL-2: before Continue nothing is asked or assigned; the consent states a preliminary enquiry; Continue then asks for the name", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    const sent = k.sentTo(x);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.request.message).toEqual(textOf(NODES.welcome!.text as string));
    const consentToken = tokenOf(sent[1]!);
    expect(consentToken).toMatch(TOKEN);
    expect(sent[1]!.request.message).toEqual(expectedPrompt("consent", consentToken));
    const consent = NODES.consent!.body as string;
    expect(consent).toContain("preliminary enquiry, not a registration");
    expect(consent).toContain("no payment is taken here");
    expect(registrationClaimViolations(consent)).toEqual([]);
    for (const asked of [ASK_NAME, ASK_YEAR, NODES.ask_class!.body as string])
      expect(bodies(x)).not.toContain(asked);
    // Variables, not message absence: the triggering inbound message is already persisted (and stays).
    expect(await session(x)).toMatchObject({ id: sid, variables: {}, current_node_id: "consent" });
    expect((await k.inboundOf(x)).map((m) => m.body)).toEqual(["register"]);

    await tap(x, "Continue");
    expect(bodies(x).at(-1)).toBe(ASK_NAME);
    expect(await session(x)).toMatchObject({
      state: "WAITING_FOR_INPUT",
      current_node_id: "ask_name",
      variables: {},
    });
    expect(await eventRows(sid)).toEqual([["INPUT_ACCEPTED", null]]);
  });

  // ------------------------------------------------------------------------------------------------ RE-CL-3

  it("RE-CL-3: Cancel at consent: COMPLETED flow_end with the approved notice, no variable, no handover; earlier messages remain", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await tap(x, "Cancel");
    expect(k.sentTo(x).at(-1)!.request.message).toEqual(textOf(NODES.cancelled!.message as string));
    expect(NODES.cancelled!.message).toBe(
      "Your registration enquiry has been cancelled. No registration has been completed.",
    );
    expect(await session(x)).toMatchObject({
      id: sid,
      state: "COMPLETED",
      end_reason: "flow_end",
      handover_reason: null,
      current_node_id: "cancelled",
      terminal_notice_step_seq: 3,
      variables: {},
    });
    await expectRequests(x, sid, 3);
    expect(await eventRows(sid)).toEqual([["INPUT_ACCEPTED", null]]);
    // Cancellation deletes nothing: both student messages and all three bot messages are still stored.
    expect(
      await k.one("select count(*)::int as n from messages where conversation_id = $1", [
        (await k.conversationOf(x))!,
      ]),
    ).toEqual({ n: 5 });
  });

  it("RE-CL-3: Cancel at confirmation: COMPLETED flow_end; the collected variables stay on the session until redaction (RE-CL-11), and the summary stays in history", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await collect(x);
    await tap(x, "Cancel");
    expect(bodies(x).at(-1)).toBe(NODES.cancelled!.message);
    expect(await session(x)).toMatchObject({
      id: sid,
      state: "COMPLETED",
      end_reason: "flow_end",
      handover_reason: null,
      variables: { reg_name: "Test Student", al_year: YEAR, class_pref: CLASS_ONE },
    });
    const stored = await k.rows(
      "select body from messages where conversation_id = $1 and direction = 'OUTBOUND'",
      [(await k.conversationOf(x))!],
    );
    expect(stored.map((r) => r.body)).toContain(confirmBody("Test Student", YEAR, CLASS_ONE));
  });

  // ------------------------------------------------------------------------------------------------ RE-CL-4 (values persist)

  it("RE-CL-4: consent, name, year and class through the real engine, in order; exactly the three values are stored and rendered", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await collect(x);
    const sent = k.sentTo(x);
    expect(sent).toHaveLength(6);
    const [consentToken, classToken, confirmToken] = [sent[1]!, sent[4]!, sent[5]!].map(tokenOf);
    expect(new Set([consentToken, classToken, confirmToken]).size).toBe(3); // a fresh token per prompt
    expect(sent.map((m) => m.request.message)).toEqual([
      textOf(NODES.welcome!.text as string),
      expectedPrompt("consent", consentToken!),
      textOf(ASK_NAME),
      textOf(ASK_YEAR),
      expectedPrompt("ask_class", classToken!),
      expectedPrompt("confirm", confirmToken!, confirmBody("Test Student", YEAR, CLASS_ONE)),
    ]);
    await expectRequests(x, sid, 6);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_ACCEPTED", null],
      ["INPUT_ACCEPTED", null],
      ["INPUT_ACCEPTED", null],
      ["INPUT_ACCEPTED", null],
    ]);
    const s = await session(x);
    expect(s).toMatchObject({ state: "WAITING_FOR_INPUT", current_node_id: "confirm" });
    expect(s.variables).toEqual({ reg_name: "Test Student", al_year: YEAR, class_pref: CLASS_ONE });
    // Only the three approved fields: the student was asked nothing else.
    expect(bodies(x).filter((b) => b.endsWith("?"))).toEqual([
      NODES.consent!.body,
      ASK_NAME,
      NODES.ask_class!.body,
      confirmBody("Test Student", YEAR, CLASS_ONE),
    ]);
  });

  // ------------------------------------------------------------------------------------------------ RE-CL-4 (pinned policy)

  it("RE-CL-4: the pinned published version keeps all three sensitive declarations and ask_name rejectLinks: true through canonical serialization and revalidation, and the runtime enforces it", async () => {
    const x = await k.world(FLOW);
    const v = (await k.one(
      `select bot_id, schema_version, config, config_canonical, config_sha256
         from bot_versions where organization_id = $1 and id = $2`,
      [x.w.org.id, x.version.id],
    ))!;
    expect(v.bot_id).toBe(x.bot.id);
    const config = v.config as Json;
    expect(config.variables).toEqual({
      reg_name: { type: "string", sensitive: true, maxLength: 80 },
      al_year: { type: "integer", sensitive: true },
      class_pref: { type: "string", sensitive: true, maxLength: 40 },
    });
    expect((config.nodes as Record<string, Json>).ask_name!.answer).toEqual({
      kind: "text",
      min: 2,
      max: 80,
      rejectLinks: true,
    });
    // The stored canonical text is the canonical form of the stored jsonb, revalidates to itself and matches its hash.
    const canonical = v.config_canonical as string;
    expect(JSON.parse(canonical)).toEqual(config);
    const revalidated = validateFlow(JSON.parse(canonical));
    expect(revalidated.diagnostics).toEqual([]);
    expect(canonicalFlowJson(revalidated.config!)).toBe(canonical);
    expect(canonical).toBe(canonicalFlowJson(validateFlow(FLOW).config!));
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(v.config_sha256);

    // The runtime reads that pinned version: a link-like name is refused there, not merely in the simulator.
    const sid = await start(x);
    await tap(x, "Continue");
    await say(x, "example.school");
    expect(await session(x)).toMatchObject({
      id: sid,
      bot_version_id: x.version.id,
      deployment_id: x.deployment.id,
      current_node_id: "ask_name",
      invalid_attempts: 1,
      variables: {},
    });
  });

  // ------------------------------------------------------------------------------------------------ RE-CL-5

  // What this proves: the rendered summary is a persisted BOT OUTBOUND message, queued through the real messaging path
  // (enqueue writes the message and its request together, before transport acceptance) and accepted by the FAKE provider,
  // and the REAL listMessages() under the staff AccessContext returns it BEFORE "Yes, hand over" is tapped. It does NOT prove
  // WhatsApp delivery or browser rendering. Causal order is not asserted from occurred_at (separate P3 Inbox issue).
  it("RE-CL-5: the confirmation is persisted at enqueue with the rendered values and is returned to staff before any button is tapped", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await collect(x);
    const body = confirmBody("Test Student", YEAR, CLASS_ONE);
    const requests = await expectRequests(x, sid, 6);
    const confirm = requests.at(-1)!;
    expect(confirm).toMatchObject({
      origin: "BOT",
      bot_step_seq: 6,
      type: "INTERACTIVE",
      body,
      organization_id: x.w.org.id,
      whatsapp_account_id: x.w.account.id,
    });
    expect(await session(x)).toMatchObject({
      state: "WAITING_FOR_INPUT",
      current_node_id: "confirm",
    });

    const conversationId = (await k.conversationOf(x))!;
    const { messages } = await listMessages(
      x.w.staff.ctx,
      conversationId,
      { limit: 50 },
      { db: t.db as never },
    );
    const hits = messages.filter((m) => m.id === confirm.message_id);
    expect(hits).toHaveLength(1);
    const shown = hits[0]!;
    expect(shown).toMatchObject({ direction: "OUTBOUND", type: "INTERACTIVE" });
    for (const line of body.split("\n").filter(Boolean)) expect(shown.text).toContain(line);
    expect(shown.text).toContain("Yes, hand over");
    expect(shown.delivery).not.toBeNull();
    expect(
      await k.one(
        "select organization_id, conversation_id, whatsapp_account_id, wamid, body from messages where id = $1",
        [confirm.message_id],
      ),
    ).toEqual({
      organization_id: x.w.org.id,
      conversation_id: conversationId,
      whatsapp_account_id: x.w.account.id,
      wamid: k.sentTo(x).at(-1)!.wamid,
      body,
    });
    // The individual replies are staff-readable too: the summary is consolidated, not the only record.
    for (const reply of ["Test Student", String(YEAR)])
      expect(messages.some((m) => m.direction === "INBOUND" && m.text === reply)).toBe(true);
  });

  // ------------------------------------------------------------------------------------------------ RE-CL-6

  it("RE-CL-6: Change answers replaces all three values; the new summary is returned to staff and the earlier summary and replies remain", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await collect(x);
    await tap(x, "Change answers");
    expect(bodies(x).at(-1)).toBe(ASK_NAME);
    const newYear = REGISTRATION_SYNTHETIC_YEARS.max;
    await say(x, "Second Name");
    await say(x, String(newYear));
    await tap(x, "[TEST] Class three");
    const first = confirmBody("Test Student", YEAR, CLASS_ONE);
    const second = confirmBody("Second Name", newYear, "[TEST] Class three");
    expect(bodies(x).at(-1)).toBe(second);
    expect((await session(x)).variables).toEqual({
      reg_name: "Second Name",
      al_year: newYear,
      class_pref: "[TEST] Class three",
    });
    await expectRequests(x, sid, 10);

    const conversationId = (await k.conversationOf(x))!;
    const stored = await k.rows(
      "select id, body from messages where conversation_id = $1 and direction = 'OUTBOUND' and type = 'INTERACTIVE' and body like 'Please check your details:%'",
      [conversationId],
    );
    expect(stored.map((r) => r.body).sort()).toEqual([first, second].sort());
    const { messages } = await listMessages(
      x.w.staff.ctx,
      conversationId,
      { limit: 50 },
      { db: t.db as never },
    );
    const byId = new Map(messages.map((m) => [m.id, m]));
    for (const r of stored)
      expect(byId.get(r.id as string)?.text).toContain((r.body as string).split("\n")[1]!);
    for (const reply of ["Test Student", "Second Name"])
      expect(messages.some((m) => m.direction === "INBOUND" && m.text === reply)).toBe(true);
    for (const table of ["leads", "lead_attributions"])
      expect(
        await k.one(`select count(*)::int as n from ${table} where organization_id = $1`, [
          x.w.org.id,
        ]),
      ).toEqual({ n: 0 });
  });

  // ------------------------------------------------------------------------------------------------ RE-CL-7

  it("RE-CL-7: Yes, hand over -> HANDED_OVER needs_staff with one non-claiming notice; no one is assigned", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await collect(x);
    await tap(x, "Yes, hand over");
    const notice = NODES.to_review!.message as string;
    expect(k.sentTo(x).at(-1)!.request.message).toEqual(textOf(notice));
    expect(registrationClaimViolations(notice)).toEqual([]);
    expect(await session(x)).toMatchObject({
      id: sid,
      state: "HANDED_OVER",
      end_reason: "flow_handover",
      handover_reason: "needs_staff",
      current_node_id: "to_review",
      terminal_notice_step_seq: 7,
      step_seq: 7,
    });
    await expectRequests(x, sid, 7);
    expect((await eventRows(sid)).at(-1)).toEqual(["HANDED_OVER", "needs_staff"]);
    expect(
      await k.one("select assigned_membership_id from conversations where id = $1", [
        (await k.conversationOf(x))!,
      ]),
    ).toEqual({ assigned_membership_id: null });
  });

  it("RE-CL-7: Talk to staff at the class list -> HANDED_OVER student_requested with the shared notice; no summary is produced", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await tap(x, "Continue");
    await say(x, "Test Student");
    await say(x, String(YEAR));
    await tap(x, "Talk to staff");
    expect(k.sentTo(x).at(-1)!.request.message).toEqual(textOf(NODES.to_staff!.message as string));
    expect(await session(x)).toMatchObject({
      id: sid,
      state: "HANDED_OVER",
      end_reason: "flow_handover",
      handover_reason: "student_requested",
      current_node_id: "to_staff",
      terminal_notice_step_seq: 6,
    });
    await expectRequests(x, sid, 6);
    expect(await outboundText(x)).not.toContain("Please check your details");
    expect(
      await k.one("select assigned_membership_id from conversations where id = $1", [
        (await k.conversationOf(x))!,
      ]),
    ).toEqual({ assigned_membership_id: null });
  });

  // ------------------------------------------------------------------------------------------------ RE-CL-8

  type Prefix = (x: LoopWorld) => Promise<void>;
  const atName: Prefix = async (x) => void (await tap(x, "Continue"));
  const atYear: Prefix = async (x) => {
    await atName(x);
    await say(x, "Test Student");
  };
  const atClass: Prefix = async (x) => {
    await atYear(x);
    await say(x, String(YEAR));
  };
  const atConfirm: Prefix = async (x) => void (await collect(x));

  it.each([
    ["name too short", atName, "ask_name", "A", "Test Student", "ask_year", "answer_invalid"],
    ["year as words", atYear, "ask_year", "next year", String(YEAR), "ask_class", "answer_invalid"],
    [
      "year out of range",
      atYear,
      "ask_year",
      String(REGISTRATION_SYNTHETIC_YEARS.max + 1),
      String(YEAR),
      "ask_class",
      "answer_invalid",
    ],
    ["class typed, not tapped", atClass, "ask_class", "Class one", null, "confirm", "wrong_kind"],
  ] as const)(
    "RE-CL-8: %s: one invalid reply re-prompts, stores nothing for that step, and a valid reply continues",
    async (_label, prefix, node, bad, good, next, code) => {
      const x = await k.world(FLOW);
      const sid = await start(x);
      await prefix(x);
      const before = (await session(x)).variables;
      const sends = k.sentTo(x).length;
      await say(x, bad);
      expect(await session(x)).toMatchObject({
        current_node_id: node,
        invalid_attempts: 1,
        variables: before,
      });
      expect(k.sentTo(x)).toHaveLength(sends + 1); // the same prompt again
      expect(bodies(x).at(-1)).toBe(bodies(x).at(-2));
      expect((await eventRows(sid)).at(-1)).toEqual(["INPUT_REJECTED", code]);
      if (good === null) await tap(x, CLASS_ONE);
      else await say(x, good);
      expect(await session(x)).toMatchObject({ current_node_id: next, state: "WAITING_FOR_INPUT" });
    },
  );

  it.each([
    ["name too long", atName, "A".repeat(81), "B".repeat(81)],
    ["year out of range", atYear, String(REGISTRATION_SYNTHETIC_YEARS.min - 1), "2102.5"],
    ["class typed", atClass, "x", "y"],
    ["confirmation typed", atConfirm, "yes", "send"],
  ] as const)(
    "RE-CL-8: %s twice -> HANDED_OVER invalid_input with the shared notice; the invalid values are not stored",
    async (_label, prefix, first, second) => {
      const x = await k.world(FLOW);
      const sid = await start(x);
      await prefix(x);
      const before = (await session(x)).variables;
      await say(x, first);
      await say(x, second);
      expect(k.sentTo(x).at(-1)!.request.message).toEqual(
        textOf(NODES.invalid_to_staff!.message as string),
      );
      expect(await session(x)).toMatchObject({
        id: sid,
        state: "HANDED_OVER",
        end_reason: "flow_handover",
        handover_reason: "invalid_input",
        variables: before,
      });
      expect((await eventRows(sid)).slice(-3).map((e) => e[0])).toEqual([
        "INPUT_REJECTED",
        "INPUT_REJECTED",
        "HANDED_OVER",
      ]);
    },
  );

  // ------------------------------------------------------------------------------------------------ RE-CL-9

  it.each([
    ["ask_name", atName],
    ["confirm", atConfirm],
  ] as const)(
    "RE-CL-9: waiting at %s, reconciliation with a fixed decision clock: not due 1 ms before expires_at, COMPLETED idle_timeout at expires_at, silently",
    async (node, prefix) => {
      // This proves the reconciler's DECISION (reconcileSession with readClock). It is NOT a sweep candidate-discovery test:
      // listReconcileCandidates filters on the real clock_timestamp(), which a decision clock cannot move.
      const x = await k.world(FLOW);
      const sid = await start(x);
      await prefix(x);
      const before = await counts(x);
      const eventsBefore = await eventRows(sid);
      const live = await session(x);
      expect(live).toMatchObject({ state: "WAITING_FOR_INPUT", current_node_id: node });
      const expiry = (live.expires_at as Date).getTime();
      expect(expiry - Date.now()).toBeGreaterThan(29 * MIN); // the 30-minute idle timeout
      expect(expiry - Date.now()).toBeLessThanOrEqual(30 * MIN);
      const at = (ms: number) => async () => new Date(ms);
      const candidate = {
        organizationId: live.organization_id as string,
        sessionId: sid,
        conversationId: live.conversation_id as string,
        deploymentId: live.deployment_id as string,
      };
      const reconcile = (clock: () => Promise<Date>) =>
        reconcileSession(k.workerDb, candidate, { ...k.production, readClock: clock });
      expect(await reconcile(at(expiry - 1))).toEqual({ kind: "skipped", reason: "not_due" });
      expect(await session(x)).toMatchObject({ id: sid, state: "WAITING_FOR_INPUT" });
      expect(await reconcile(at(expiry))).toMatchObject({
        kind: "applied",
        action: "idle_expired",
      });
      const ended = await session(x);
      expect(ended).toMatchObject({
        id: sid,
        state: "COMPLETED",
        end_reason: "idle_timeout",
        handover_reason: null,
        terminal_notice_step_seq: null,
        variables: live.variables, // kept until redaction (RE-CL-11)
      });
      expect(ended.output_suppressed_at).toBeInstanceOf(Date);
      expect(await counts(x)).toEqual(before);
      expect(await eventRows(sid)).toEqual(eventsBefore);
    },
  );

  // ------------------------------------------------------------------------------------------------ RE-CL-10

  const LINK_NAMES = [
    "example.school",
    "example.website",
    "example.nz",
    "example.school/enrol",
    "例子.中国",
    "T.Co",
    "X.Com",
    "xn--fsqu00a.xn--fiqs8s",
    "XN--FSQU00A.XN--FIQS8S",
    "https://example.org/x",
    "Kamal see https://example.org/x",
  ];

  it.each(LINK_NAMES)(
    "RE-CL-10: the link-like name %j is refused at ask_name: same question again, reg_name unset, no year question, not reflected; a valid name then continues",
    async (bad) => {
      const x = await k.world(FLOW);
      const sid = await start(x);
      await tap(x, "Continue");
      await say(x, bad);
      expect(await session(x)).toMatchObject({
        state: "WAITING_FOR_INPUT",
        current_node_id: "ask_name",
        invalid_attempts: 1,
        variables: {},
      });
      expect(bodies(x).slice(-2)).toEqual([ASK_NAME, ASK_NAME]);
      expect(bodies(x)).not.toContain(ASK_YEAR);
      expect((await eventRows(sid)).at(-1)).toEqual(["INPUT_REJECTED", "answer_invalid"]);
      await expectNotReflected(x, bad);
      await say(x, "Test Student");
      expect(await session(x)).toMatchObject({
        current_node_id: "ask_year",
        variables: { reg_name: "Test Student" },
      });
    },
  );

  it("RE-CL-10: the multi-initial name K.M.Dev is accepted and rendered in the summary", async () => {
    const x = await k.world(FLOW);
    await start(x);
    await collect(x, "K.M.Dev");
    expect((await session(x)).variables).toMatchObject({ reg_name: "K.M.Dev" });
    expect(bodies(x).at(-1)).toBe(confirmBody("K.M.Dev", YEAR, CLASS_ONE));
  });

  it.each([
    ["T.Co", "xn--fsqu00a.xn--fiqs8s"],
    ["example.school/enrol", "例子.中国"],
  ])(
    "RE-CL-10: two link-like names (%j, %j) -> HANDED_OVER invalid_input; nothing stored, neither reflected",
    async (first, second) => {
      const x = await k.world(FLOW);
      const sid = await start(x);
      await tap(x, "Continue");
      await say(x, first);
      await say(x, second);
      expect(k.sentTo(x).at(-1)!.request.message).toEqual(
        textOf(NODES.invalid_to_staff!.message as string),
      );
      expect(await session(x)).toMatchObject({
        id: sid,
        state: "HANDED_OVER",
        handover_reason: "invalid_input",
        variables: {},
      });
      await expectNotReflected(x, first);
      await expectNotReflected(x, second);
    },
  );

  it.each(["example.school/enrol", "T.Co", "XN--FSQU00A.XN--FIQS8S", "例子.中国"])(
    "RE-CL-10: Change answers: the link-like replacement %j does not overwrite the earlier name and is never reflected; a valid replacement reconfirms",
    async (bad) => {
      const x = await k.world(FLOW);
      await start(x);
      await collect(x);
      await tap(x, "Change answers");
      await say(x, bad);
      expect(await session(x)).toMatchObject({
        current_node_id: "ask_name",
        invalid_attempts: 1,
        variables: { reg_name: "Test Student", al_year: YEAR, class_pref: CLASS_ONE },
      });
      await say(x, "Second Name");
      await say(x, String(YEAR));
      await tap(x, "[TEST] Class two");
      expect(bodies(x).at(-1)).toBe(confirmBody("Second Name", YEAR, "[TEST] Class two"));
      expect((await session(x)).variables).toMatchObject({ reg_name: "Second Name" });
      await expectNotReflected(x, bad);
    },
  );

  it("RE-CL-10 (shared renderer-error regression, test-only variant WITHOUT rejectLinks): a name that fails the render check ends HANDED_OVER engine_error with no additional outbound row from the failing step", async () => {
    // Not a Registration path any more (rejectLinks refuses the name first); this keeps the engine's render-failure contract
    // under PostgreSQL. It is not GI-CL-14 (General Information SEND_BUDGET), which stays a separate obligation.
    const legacy = registrationEnquiryFlow();
    delete ((legacy.nodes as Record<string, Json>).ask_name!.answer as Json).rejectLinks;
    const x = await k.world(legacy);
    const sid = await start(x);
    await tap(x, "Continue");
    await say(x, "ftp://example.org/x");
    await say(x, String(YEAR));
    const before = await counts(x);
    expect(before.botRequests).toBe(5); // welcome, consent, name, year, class list
    await tap(x, CLASS_ONE);
    expect(await counts(x)).toEqual({
      ...before,
      inbound: before.inbound + 1,
      triggers: before.triggers + 1,
    });
    expect(await session(x)).toMatchObject({
      id: sid,
      state: "HANDED_OVER",
      end_reason: "error",
      handover_reason: "engine_error",
      current_node_id: "error_to_staff",
      terminal_notice_step_seq: null,
      awaiting: null,
    });
    expect(
      (await eventRows(sid))
        .slice(-3)
        .map((e) => e.join(":"))
        .sort(),
    ).toEqual(["ERROR:render_rejected", "HANDED_OVER:engine_error", "INPUT_ACCEPTED:"].sort());
    expect(await outboundText(x)).not.toContain("something went wrong on our side");
    await expectNotReflected(x, "ftp://example.org/x");
  });

  // ------------------------------------------------------------------------------------------------ RE-CL-11

  it("RE-CL-11: redaction of the terminal session clears populated variables and tokens only after the retention period; lifecycle fields and message history are unchanged", async () => {
    // The database-controlled period (30 days, bot_session_redaction_after) is only shortened in THIS disposable database. In
    // production redaction runs only when an operator invokes the retention CLI; no schedule is proven here.
    const x = await k.world(FLOW);
    const sid = await start(x);
    await collect(x);
    await tap(x, "Yes, hand over");
    const json = async () =>
      (await k.one("select to_jsonb(s) j from bot_sessions s where id = $1", [sid]))!.j as Record<
        string,
        unknown
      >;
    const history = async () =>
      k.rows(
        "select id, direction, type, body, content from messages where organization_id = $1 and conversation_id = $2 order by created_at, id",
        [x.w.org.id, (await k.conversationOf(x))!],
      );
    const before = await json();
    const messagesBefore = await history();
    const eventsBefore = await k.eventsOf(sid);
    expect(before).toMatchObject({
      state: "HANDED_OVER",
      redacted_at: null,
      variables: { reg_name: "Test Student", al_year: YEAR, class_pref: CLASS_ONE },
    });
    expect(before.last_consumed_token).not.toBeNull(); // real data to clear
    expect(messagesBefore.filter((m) => m.direction === "INBOUND")).toHaveLength(6); // register, 3 taps, name, year
    expect(messagesBefore.filter((m) => m.direction === "OUTBOUND")).toHaveLength(7);
    expect(
      messagesBefore.some((m) => m.body === confirmBody("Test Student", YEAR, CLASS_ONE)),
    ).toBe(true);

    // Not yet eligible under the migration's 30-day period: nothing changes.
    expect(
      Number((await k.one("select redact_expired_bot_sessions($1, 100) n", [x.w.org.id]))!.n),
    ).toBe(0);
    expect(await json()).toEqual(before);
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
    expect(keep(after)).toEqual(keep(before)); // state, end/handover reasons, step and notice seqs, version, times
    expect(await history()).toEqual(messagesBefore); // replies and summaries keep their own (unresolved) retention
    expect(await k.eventsOf(sid)).toEqual(eventsBefore);
  });

  // ------------------------------------------------------------------------------------------------ RE-CL-12

  it.each([
    [
      "Yes, hand over",
      async (x: LoopWorld) => {
        await collect(x);
        await tap(x, "Yes, hand over");
      },
    ],
    [
      "Talk to staff",
      async (x: LoopWorld) => {
        await atClass(x);
        await tap(x, "Talk to staff");
      },
    ],
    [
      "Cancel at confirmation",
      async (x: LoopWorld) => {
        await collect(x);
        await tap(x, "Cancel");
      },
    ],
    [
      "invalid_input",
      async (x: LoopWorld) => {
        await atName(x);
        await say(x, "T.Co");
        await say(x, "A");
      },
    ],
  ] as const)(
    "RE-CL-12: %s changes no lead, attribution, tag or assignee (scoped before/after); only the expected messages, BOT requests and session rows exist",
    async (_label, path) => {
      const x = await k.world(FLOW);
      const business = async () =>
        Object.fromEntries(
          await Promise.all(
            ["leads", "lead_attributions", "contact_tags"].map(async (table) => [
              table,
              (await k.one(`select count(*)::int as n from ${table} where organization_id = $1`, [
                x.w.org.id,
              ]))!.n,
            ]),
          ),
        );
      const orgBefore = await business();
      await start(x);
      const conversationId = (await k.conversationOf(x))!;
      const assignee = () =>
        k.one(
          "select assigned_membership_id, assigned_at from conversations where organization_id = $1 and id = $2",
          [x.w.org.id, conversationId],
        );
      const assigneeBefore = await assignee();
      expect(assigneeBefore).toEqual({ assigned_membership_id: null, assigned_at: null });
      await path(x);
      expect(await business()).toEqual(orgBefore);
      expect(await assignee()).toEqual(assigneeBefore);
      expect(
        await k.one(
          `select count(*)::int as n from conversation_events
            where organization_id = $1 and conversation_id = $2
              and (to_assignee_membership_id is not null or from_assignee_membership_id is not null)`,
          [x.w.org.id, conversationId],
        ),
      ).toEqual({ n: 0 });
      // Legitimate records only: every request is the session's own BOT text or interactive send (no payment or other kind).
      const requests = await k.requestsOf(x);
      expect(requests.length).toBeGreaterThan(0);
      for (const r of requests)
        expect(r).toMatchObject({ origin: "BOT", bot_session_id: (await session(x)).id });
      for (const r of requests) expect(["TEXT", "INTERACTIVE"]).toContain(r.message_type);
      expect(await k.sessionsOf(x)).toHaveLength(1);
    },
  );
});
