import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import {
  CLASS_INFO_KEYWORDS,
  GENERAL_INFO_KEYWORDS,
  PAYMENT_ENQUIRY_KEYWORDS,
  REGISTRATION_ENQUIRY_KEYWORDS,
  REGISTRATION_SYNTHETIC_YEARS,
  STAFF_ROUTING_KEYWORDS,
  classInfoFlow,
  enquiryFlow,
  generalInfoFlow,
  paymentEnquiryFlow,
  registrationEnquiryFlow,
  staffRoutingFlow,
  type Json,
} from "@/modules/bots/testing";
import { assignConversation, listMessages } from "@/modules/inbox";
import { MetaTransport, type HttpPost } from "@/modules/messaging/meta-transport";
import {
  DEFAULT_ACCOUNT_MIN_INTERVAL_MS,
  DEFAULT_CONVERSATION_MIN_INTERVAL_MS,
} from "@/modules/messaging/policy";
import { TEST_APP_SECRET } from "@/modules/whatsapp/testing";
import {
  activateDeployment,
  changeDeploymentVersion,
  pauseDeployment,
  publishVersion,
  stopActiveSessions,
  updateDraft,
} from "../bot-control";
import { BOTS_ON, publishedBot } from "../bot-control/testing";
import { closedLoopKit, type LoopWorld } from "./testing";

// Phase 08G-6, SIX-CL-1 .. SIX-CL-13 of docs/PHASE_08G-6_ACCEPTANCE.md: the six SYNTHETIC golden flows deployed TOGETHER on one
// account, through the REAL closed loop (closedLoopKit: signed webhook -> ingest -> webhook worker -> bot worker -> dispatcher
// -> FakeTransport) on a disposable PostgreSQL 17 database only. Nothing here can reach Meta. WRITTEN BUT NOT YET EXECUTED
// (needs owner-authorized isolated database validation). Every bot's own paths are proven by its 08G suite and are not
// repeated; this file proves what only appears when the six coexist. Bot selection is by deployment priority (owner decision
// OD-1): Student Enquiry, the only first_message bot, must be last. Nothing enforces that order at activation; SIX-CL-2
// characterizes the inverted order. GI-CL-14 (SEND_BUDGET in a closed loop) stays OPEN and is not attempted here (OD-2).

type BotKey =
  | "staff_routing"
  | "payment_enquiry"
  | "registration_enquiry"
  | "class_info"
  | "general_info"
  | "student_enquiry";
type Node = Json & { type: string };

const FLOWS: Record<BotKey, () => Json> = {
  staff_routing: staffRoutingFlow,
  payment_enquiry: paymentEnquiryFlow,
  registration_enquiry: registrationEnquiryFlow,
  class_info: classInfoFlow,
  general_info: generalInfoFlow,
  student_enquiry: enquiryFlow,
};
const nodesOf = (key: BotKey) => FLOWS[key]().nodes as Record<string, Node>;

/** 08G-0 section 4: priority 1..6 in this order. */
const APPROVED: BotKey[] = [
  "staff_routing",
  "payment_enquiry",
  "registration_enquiry",
  "class_info",
  "general_info",
  "student_enquiry",
];
/** Test-only, NOT suitable for production: Student Enquiry first, the rest in the approved order. */
const INVERTED: BotKey[] = ["student_enquiry", ...APPROVED.slice(0, 5)];
const KEYWORD_BOTS = APPROVED.slice(0, 5);

const KEYWORDS: Record<Exclude<BotKey, "student_enquiry">, readonly string[]> = {
  staff_routing: STAFF_ROUTING_KEYWORDS,
  payment_enquiry: PAYMENT_ENQUIRY_KEYWORDS,
  registration_enquiry: REGISTRATION_ENQUIRY_KEYWORDS,
  class_info: CLASS_INFO_KEYWORDS,
  general_info: GENERAL_INFO_KEYWORDS,
};
/** One way into each bot: its first keyword, or a plain first message for Student Enquiry. */
const OPENER: Record<BotKey, string> = {
  staff_routing: "staff",
  payment_enquiry: "pay",
  registration_enquiry: "join",
  class_info: "classes",
  general_info: "info",
  student_enquiry: "Good morning",
};

const textOf = (body: string) => ({ type: "text", body, replyToWamid: null });
const welcomeOf = (key: Exclude<BotKey, "student_enquiry">) =>
  textOf(nodesOf(key).welcome!.text as string);
const RE = nodesOf("registration_enquiry");
const YEAR = REGISTRATION_SYNTHETIC_YEARS.min + 1;
const CLASS_ONE = "[TEST] Class one";
const confirmBody = (name: string, year: number, cls: string) =>
  (RE.confirm!.body as string)
    .replace("{{reg_name}}", name)
    .replace("{{al_year}}", String(year))
    .replace("{{class_pref}}", cls);

type Deployed = { bot: { id: string }; version: { id: string }; deployment: { id: string } };
type Six = LoopWorld & { readonly six: Record<BotKey, Deployed> };

/**
 * A test-only characterization of OD-1 (NOT an activation guard; none exists in production): every deployment whose pinned
 * version has a first_message or referral_source trigger must have a higher priority number than every keyword-only one.
 */
function activationOrderViolations(
  rows: ReadonlyArray<{ key: string; priority: number; triggers: Array<{ kind: string }> }>,
): string[] {
  const implicit = rows.filter((r) => r.triggers.some((t) => t.kind !== "keyword"));
  const explicit = rows.filter((r) => r.triggers.every((t) => t.kind === "keyword"));
  return implicit.flatMap((i) =>
    explicit.filter((e) => e.priority > i.priority).map((e) => `${i.key} precedes ${e.key}`),
  );
}

describe("closed loop: six SYNTHETIC bots deployed together, 08G-6", () => {
  let t: TestDb;
  let k: ReturnType<typeof closedLoopKit>;
  let k2: ReturnType<typeof closedLoopKit>;
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
    k2 = closedLoopKit(t); // a second bot worker for SIX-CL-9 (its dispatcher and transport are never used)
  });
  afterAll(async () => {
    await k2?.close();
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

  // ------------------------------------------------------------------------------------------------ six-bot world

  async function deploy(x: LoopWorld, key: BotKey, priority: number): Promise<Deployed> {
    const { bot, version } = await publishedBot(t.db, x.w, FLOWS[key]());
    const deployment = (
      await activateDeployment(
        x.w.admin.ctx,
        { botId: bot.id, versionId: version.id, whatsappAccountId: x.w.account.id, priority },
        { db: t.db },
      )
    ).value;
    return { bot, version, deployment };
  }
  /** One organization and account with the six flows published and deployed ACTIVE at priority 1..6 in `order`. */
  async function sixBotWorld(order: BotKey[] = APPROVED): Promise<Six> {
    const x = await k.world(FLOWS[order[0]!]()); // the kit deploys its flow at priority 1
    const six = {
      [order[0]!]: { bot: x.bot, version: x.version, deployment: x.deployment },
    } as Record<BotKey, Deployed>;
    for (let i = 1; i < order.length; i++) six[order[i]!] = await deploy(x, order[i]!, i + 1);
    return { ...x, six };
  }
  /** A fresh contact in the same organization and account (the first webhook creates the conversation). */
  const student = <X extends LoopWorld>(x: X): X => ({
    ...x,
    phone: `9476${String(Date.now() % 1e7).padStart(7, "0")}${++phoneSeq % 10}`,
  });
  const keyOf = (x: Six, botId: unknown) =>
    (Object.keys(x.six) as BotKey[]).find((key) => x.six[key].bot.id === botId);

  // ------------------------------------------------------------------------------------------------ conversation driver

  function postText(x: LoopWorld, body: string) {
    const { bytes, wamid } = k.studentBytes(x, k.textMessage(body));
    return k.post(bytes).then((status) => {
      expect(status).toBe(200);
      return { bytes, wamid };
    });
  }
  async function say(x: LoopWorld, body: string) {
    const sent = await postText(x, body);
    await k.settle();
    return sent;
  }
  /** Webhook bytes for a tap on the option titled `title` of the LAST captured prompt (its real id and wamid). */
  function tapBytes(x: LoopWorld, title: string) {
    const prompt = k.sentTo(x).at(-1)!;
    if (prompt.request.message.type !== "interactive") throw new Error("last send is not a prompt");
    const subtype =
      prompt.request.message.payload.kind === "buttons" ? "button_reply" : "list_reply";
    const option = k.optionsOf(prompt).get(title);
    if (!option) throw new Error(`no option titled ${title}`);
    return k.studentBytes(x, k.tapMessage(option, subtype, prompt.wamid));
  }
  async function tap(x: LoopWorld, title: string) {
    const { bytes } = tapBytes(x, title);
    expect(await k.post(bytes)).toBe(200);
    await k.settle();
    return bytes;
  }

  const sessions = (x: LoopWorld) => k.sessionsOf(x);
  const lastTrigger = async (x: LoopWorld) => (await k.triggersOf(x)).at(-1)!;
  const eventRows = async (sessionId: string) =>
    (await k.eventsOf(sessionId)).map((e) => [e.kind, e.code]);
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
  /** Sends `body` and asserts it was IGNORED with `code` and changed nothing but the inbound message and its trigger. */
  async function expectIgnored(x: LoopWorld, body: string, code: string) {
    const before = await counts(x);
    const sessionsBefore = await sessions(x);
    await say(x, body);
    expect(await lastTrigger(x), body).toMatchObject({ status: "IGNORED", outcome_code: code });
    expect(await counts(x)).toEqual({
      ...before,
      inbound: before.inbound + 1,
      triggers: before.triggers + 1,
    });
    expect(await sessions(x)).toEqual(sessionsBefore);
  }
  /** Asserts the student has exactly one session, on bot `key` of world `x`, pinned to its version and deployment. */
  async function expectOnlySessionOn(x: Six, y: LoopWorld, key: BotKey) {
    const all = await sessions(y);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      organization_id: x.w.org.id,
      whatsapp_account_id: x.w.account.id,
      bot_id: x.six[key].bot.id,
      bot_version_id: x.six[key].version.id,
      deployment_id: x.six[key].deployment.id,
    });
    return all[0]!;
  }
  const assign = async (x: LoopWorld) =>
    assignConversation(
      x.w.staff.ctx,
      (await k.conversationOf(x))!,
      { assigneeMembershipId: x.w.staff.membershipId, expectedAssigneeMembershipId: null },
      { db: t.db as never },
    );
  const deploymentRows = async (x: Six) =>
    (
      await k.rows(
        `select d.id, d.bot_id, d.version_id, d.status, d.priority, d.organization_id, d.whatsapp_account_id, v.config
           from bot_deployments d join bot_versions v on v.id = d.version_id
          where d.organization_id = $1 order by d.priority`,
        [x.w.org.id],
      )
    ).map((r) => ({
      id: r.id as string,
      bot_id: r.bot_id as string,
      version_id: r.version_id as string,
      status: r.status as string,
      whatsapp_account_id: r.whatsapp_account_id as string,
      key: keyOf(x, r.bot_id)!,
      priority: Number(r.priority),
      triggers: (r.config as Json).triggers as Array<{ kind: string }>,
    }));

  // ------------------------------------------------------------------------------------------------ SIX-CL-1

  it("SIX-CL-1: six synthetic versions are published and deployed ACTIVE on one account of one organization, in the approved priority order, each pinning its own triggers", async () => {
    const x = await sixBotWorld();
    const rows = await deploymentRows(x);
    expect(rows.map((r) => [r.key, r.priority, r.status, r.whatsapp_account_id])).toEqual(
      APPROVED.map((key, i) => [key, i + 1, "ACTIVE", x.w.account.id]),
    );
    for (const r of rows)
      expect(r).toMatchObject({
        id: x.six[r.key].deployment.id,
        version_id: x.six[r.key].version.id,
        triggers: FLOWS[r.key]().triggers,
      });
    expect(new Set(rows.map((r) => r.bot_id)).size).toBe(6);
    expect(new Set(rows.map((r) => r.version_id)).size).toBe(6);
    expect(
      (await k.one("select count(*)::int n from bot_sessions where organization_id = $1", [
        x.w.org.id,
      ]))!.n,
    ).toBe(0);
  });

  it.each(KEYWORD_BOTS)(
    "SIX-CL-1: every keyword of %s, as a student's FIRST message, starts that bot (not Student Enquiry's first_message fallback) on its pinned version",
    async (key) => {
      const x = await sixBotWorld();
      for (const word of KEYWORDS[key as keyof typeof KEYWORDS]) {
        const y = student(x);
        await say(y, word);
        expect((await k.inboundOf(y)).map((m) => m.body)).toEqual([word]); // the first message of the conversation
        await expectOnlySessionOn(x, y, key);
        expect(k.sentTo(y)[0]!.request.message).toEqual(
          welcomeOf(key as Exclude<BotKey, "student_enquiry">),
        );
      }
    },
  );

  it("SIX-CL-1: a plain first message falls back to Student Enquiry (first_message), the last deployment", async () => {
    const x = await sixBotWorld();
    const y = student(x);
    await say(y, "Good morning");
    await expectOnlySessionOn(x, y, "student_enquiry");
    const first = k.sentTo(y)[0]!.request.message;
    expect(first.type).toBe("interactive");
    expect((first as { payload: { body: string } }).payload.body).toBe(
      nodesOf("student_enquiry").language_menu!.body,
    );
  });

  // ------------------------------------------------------------------------------------------------ SIX-CL-2

  it("SIX-CL-2: the first_message fallback applies to the first eligible message only: a later plain message starts nothing, a later keyword still starts its bot", async () => {
    const x = (await k.world(staffRoutingFlow())) as LoopWorld; // Staff Routing alone, priority 1
    await say(x, "Good morning");
    expect(await k.triggersOf(x)).toMatchObject([
      { status: "IGNORED", outcome_code: "no_trigger_match" },
    ]);
    const six = {
      staff_routing: { bot: x.bot, version: x.version, deployment: x.deployment },
    } as Record<BotKey, Deployed>;
    for (let i = 1; i < APPROVED.length; i++)
      six[APPROVED[i]!] = await deploy(x, APPROVED[i]!, i + 1);
    const s: Six = { ...x, six };

    await expectIgnored(s, "Good morning again", "no_trigger_match"); // not the first eligible message any more
    await say(s, "pay");
    await expectOnlySessionOn(s, s, "payment_enquiry");

    const fresh = student(s);
    await say(fresh, "Good morning");
    await expectOnlySessionOn(s, fresh, "student_enquiry");
  });

  it("SIX-CL-2: INVERTED priorities (Student Enquiry 1, test-only): every keyword bot's keyword as a first message starts Student Enquiry instead", async () => {
    const x = await sixBotWorld(INVERTED);
    for (const key of KEYWORD_BOTS) {
      const y = student(x);
      await say(y, OPENER[key]);
      await expectOnlySessionOn(x, y, "student_enquiry");
      expect(k.sentTo(y)[0]!.request.message.type).toBe("interactive"); // the language menu, not the keyword bot's welcome
    }
    expect(
      (await k.one(
        "select count(*)::int n from bot_sessions where organization_id = $1 and bot_id <> $2",
        [x.w.org.id, x.six.student_enquiry.bot.id],
      ))!.n,
    ).toBe(0);
  });

  it("SIX-CL-2: the inverted configuration is recognized as unsuitable for activation; the approved one is not (test-only check: no activation guard exists)", async () => {
    const approved = await deploymentRows(await sixBotWorld());
    const inverted = await deploymentRows(await sixBotWorld(INVERTED));
    expect(activationOrderViolations(approved)).toEqual([]);
    expect(activationOrderViolations(inverted)).toEqual(
      KEYWORD_BOTS.map((key) => `student_enquiry precedes ${key}`),
    );
  });

  // ------------------------------------------------------------------------------------------------ SIX-CL-3

  it("SIX-CL-3: case and surrounding spaces are normalized: each form, as a first message, starts its keyword bot", async () => {
    const x = await sixBotWorld();
    const forms: Array<[string, BotKey]> = [
      ["  PAY  ", "payment_enquiry"],
      ["Join", "registration_enquiry"],
      ["STAFF", "staff_routing"],
      ["Classes", "class_info"],
      ["  iNfO", "general_info"],
    ];
    for (const [body, key] of forms) {
      const y = student(x);
      await say(y, body);
      await expectOnlySessionOn(x, y, key);
    }
  });

  it("SIX-CL-3: near-miss keywords never reach a keyword bot: as a first message they fall back to Student Enquiry", async () => {
    const x = await sixBotWorld();
    for (const body of ["pay now", "info?", "staffs", "registering", "class info"]) {
      const y = student(x);
      await say(y, body);
      await expectOnlySessionOn(x, y, "student_enquiry");
    }
  });

  // ------------------------------------------------------------------------------------------------ SIX-CL-4

  it("SIX-CL-4: another bot's keyword at Student Enquiry's BUTTONS prompt is wrong_kind on the same session; no other bot starts", async () => {
    const x = await sixBotWorld();
    const y = student(x);
    await say(y, OPENER.student_enquiry);
    const s = await expectOnlySessionOn(x, y, "student_enquiry");
    await say(y, "pay");
    expect(await lastTrigger(y)).toMatchObject({ outcome_code: "input_rejected" });
    expect(await expectOnlySessionOn(x, y, "student_enquiry")).toMatchObject({
      id: s.id,
      state: "WAITING_FOR_INPUT",
      current_node_id: "language_menu",
      invalid_attempts: 1,
    });
    expect(await eventRows(s.id as string)).toEqual([["INPUT_REJECTED", "wrong_kind"]]);
  });

  it("SIX-CL-4: another bot's keyword at General Information's LIST prompt is wrong_kind on the same session; no other bot starts", async () => {
    const x = await sixBotWorld();
    const y = student(x);
    await say(y, "info");
    const s = await expectOnlySessionOn(x, y, "general_info");
    await say(y, "register");
    expect(await lastTrigger(y)).toMatchObject({ outcome_code: "input_rejected" });
    expect(await expectOnlySessionOn(x, y, "general_info")).toMatchObject({
      id: s.id,
      current_node_id: "topics",
      invalid_attempts: 1,
    });
    expect(await eventRows(s.id as string)).toEqual([["INPUT_REJECTED", "wrong_kind"]]);
  });

  it("SIX-CL-4: another bot's keyword at Registration's integer QUESTION is an invalid answer on the same session; nothing is stored", async () => {
    const x = await sixBotWorld();
    const y = student(x);
    await say(y, "join");
    await tap(y, "Continue");
    await say(y, "Test Student");
    const s = await expectOnlySessionOn(x, y, "registration_enquiry");
    expect(s).toMatchObject({ current_node_id: "ask_year" });
    await say(y, "pay");
    expect(await lastTrigger(y)).toMatchObject({ outcome_code: "input_rejected" });
    expect(await expectOnlySessionOn(x, y, "registration_enquiry")).toMatchObject({
      id: s.id,
      current_node_id: "ask_year",
      invalid_attempts: 1,
      variables: { reg_name: "Test Student" },
    });
    expect((await eventRows(s.id as string)).at(-1)).toEqual(["INPUT_REJECTED", "answer_invalid"]);
  });

  it("SIX-CL-4: at Registration's free-text name QUESTION, 'staff' is accepted as the name (runtime property L5): Staff Routing does not start", async () => {
    const x = await sixBotWorld();
    const y = student(x);
    await say(y, "join");
    await tap(y, "Continue");
    await say(y, "staff");
    expect(await lastTrigger(y)).toMatchObject({ outcome_code: "input_accepted" });
    expect(await expectOnlySessionOn(x, y, "registration_enquiry")).toMatchObject({
      state: "WAITING_FOR_INPUT",
      current_node_id: "ask_year",
      invalid_attempts: 0,
      variables: { reg_name: "staff" },
    });
    expect(k.sentTo(y).at(-1)!.request.message).toEqual(textOf(RE.ask_year!.text as string));
  });

  // ------------------------------------------------------------------------------------------------ SIX-CL-5

  it("SIX-CL-5: after a Staff Routing handover, every other bot's keyword and a plain message are ignored (handover_unresolved)", async () => {
    const x = await sixBotWorld();
    const y = student(x);
    await say(y, "staff");
    await tap(y, "Class question");
    expect(await expectOnlySessionOn(x, y, "staff_routing")).toMatchObject({
      state: "HANDED_OVER",
      handover_reason: "student_requested",
    });
    for (const body of [
      ...KEYWORD_BOTS.filter((key) => key !== "staff_routing").map((key) => OPENER[key]),
      "hi",
      "Hello?",
    ])
      await expectIgnored(y, body, "handover_unresolved");
  });

  it("SIX-CL-5: after Registration's 'Yes, hand over', other bots' keywords are ignored (handover_unresolved)", async () => {
    const x = await sixBotWorld();
    const y = student(x);
    await say(y, "join");
    await tap(y, "Continue");
    await say(y, "Test Student");
    await say(y, String(YEAR));
    await tap(y, CLASS_ONE);
    await tap(y, "Yes, hand over");
    expect(await expectOnlySessionOn(x, y, "registration_enquiry")).toMatchObject({
      state: "HANDED_OVER",
      handover_reason: "needs_staff",
    });
    for (const body of ["pay", "staff", "info", "register"])
      await expectIgnored(y, body, "handover_unresolved");
  });

  it("SIX-CL-5: staff assignment ends a live Student Enquiry session; afterwards other bots' keywords start nothing", async () => {
    const x = await sixBotWorld();
    const y = student(x);
    await say(y, OPENER.student_enquiry);
    await assign(y);
    await say(y, "pay"); // the live session sees the staff event and hands over; the keyword starts nothing
    expect(await lastTrigger(y)).toMatchObject({
      status: "IGNORED",
      outcome_code: "session_ended",
    });
    expect(await expectOnlySessionOn(x, y, "student_enquiry")).toMatchObject({
      state: "HANDED_OVER",
      handover_reason: "staff_assigned",
    });
    for (const body of ["classes", "join", "staff"])
      await expectIgnored(y, body, "handover_unresolved");
  });

  // ------------------------------------------------------------------------------------------------ SIX-CL-6

  it("SIX-CL-6: after General Information's END, every bot's keyword inside the 30-minute cooldown is ignored (cooldown)", async () => {
    const x = await sixBotWorld();
    const y = student(x);
    await say(y, "info");
    await tap(y, "[TEST] Topic one");
    await tap(y, "That's all");
    expect(await expectOnlySessionOn(x, y, "general_info")).toMatchObject({
      state: "COMPLETED",
      end_reason: "flow_end",
    });
    for (const body of [...KEYWORD_BOTS.map((key) => OPENER[key]), "hi", "Hello again"])
      await expectIgnored(y, body, "cooldown");
  });

  it("SIX-CL-6: after Registration's Cancel (END), every bot's keyword inside the cooldown is ignored (cooldown)", async () => {
    const x = await sixBotWorld();
    const y = student(x);
    await say(y, "join");
    await tap(y, "Cancel");
    expect(await expectOnlySessionOn(x, y, "registration_enquiry")).toMatchObject({
      state: "COMPLETED",
      end_reason: "flow_end",
    });
    for (const body of [...KEYWORD_BOTS.map((key) => OPENER[key]), "menu"])
      await expectIgnored(y, body, "cooldown");
  });

  // ------------------------------------------------------------------------------------------------ SIX-CL-7

  it("SIX-CL-7: two organizations with the same six bots; the same phone number writes to both accounts at once: every row stays in its own organization and account", async () => {
    const a = await sixBotWorld();
    const bWorld = await sixBotWorld();
    const b: Six = { ...bWorld, phone: a.phone };
    expect(a.w.org.id).not.toBe(b.w.org.id);
    await postText(a, "pay");
    await postText(b, "join");
    await k.settle();
    await expectOnlySessionOn(a, a, "payment_enquiry");
    await expectOnlySessionOn(b, b, "registration_enquiry");

    const contacts = await k.rows(
      "select organization_id from contacts where wa_id = $1 order by organization_id",
      [a.phone],
    );
    expect(contacts.map((c) => c.organization_id).sort()).toEqual([a.w.org.id, b.w.org.id].sort());
    for (const [x, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const conversation = (await k.conversationOf(x))!;
      for (const table of ["messages", "outbound_requests", "bot_triggers", "bot_sessions"]) {
        const scoped = await k.rows(
          `select distinct organization_id, whatsapp_account_id from ${table} where conversation_id = $1`,
          [conversation],
        );
        expect(scoped, table).toEqual([
          { organization_id: x.w.org.id, whatsapp_account_id: x.w.account.id },
        ]);
      }
      expect(
        k.transport.calls.filter((c) => c.phoneNumberId === x.pn).map((c) => c.recipient.id),
      ).toEqual([x.phone, x.phone]); // welcome + first prompt, from this account only
      expect(other.pn).not.toBe(x.pn);
    }
  });

  // ------------------------------------------------------------------------------------------------ SIX-CL-8

  it("SIX-CL-8: a General Information version switched mid-session leaves its live session and the live Registration session pinned; a new student gets the new version", async () => {
    const x = await sixBotWorld();
    const gi = student(x);
    const re = student(x);
    await say(gi, "info");
    await say(re, "join");
    const reBefore = await expectOnlySessionOn(x, re, "registration_enquiry");

    const changed = structuredClone(FLOWS.general_info()) as Json;
    (changed.nodes as Record<string, Json>).ans_t1!.text =
      "[SYNTHETIC TEST ANSWER 1 v2] This is placeholder text for automated tests. It is not real A/L ICT information.";
    const deps = { db: t.db };
    const botId = x.six.general_info.bot.id;
    await updateDraft(x.w.admin.ctx, { botId, expectedRevision: 1, config: changed }, deps);
    const v2 = (await publishVersion(x.w.admin.ctx, { botId, expectedRevision: 2 }, deps)).value;
    await changeDeploymentVersion(
      x.w.admin.ctx,
      { deploymentId: x.six.general_info.deployment.id, versionId: v2.id },
      deps,
    );

    await tap(gi, "[TEST] Topic one");
    await expectOnlySessionOn(x, gi, "general_info"); // still the v1 version and the same deployment
    expect((k.sentTo(gi).at(-2)!.request.message as { body: string }).body).toBe(
      nodesOf("general_info").ans_t1!.text,
    );
    await tap(re, "Continue");
    expect(await expectOnlySessionOn(x, re, "registration_enquiry")).toMatchObject({
      id: reBefore.id,
      current_node_id: "ask_name",
    });

    const fresh = student(x);
    await say(fresh, "info");
    await tap(fresh, "[TEST] Topic one");
    expect((await sessions(fresh))[0]).toMatchObject({
      bot_id: botId,
      bot_version_id: v2.id,
      deployment_id: x.six.general_info.deployment.id,
    });
    expect((k.sentTo(fresh).at(-2)!.request.message as { body: string }).body).toContain(
      "ANSWER 1 v2",
    );
  });

  it("SIX-CL-8: pausing Class Information drains its live session; the other five deployments stay ACTIVE and keep starting", async () => {
    const x = await sixBotWorld();
    const ci = student(x);
    await say(ci, "classes");
    await pauseDeployment(
      x.w.admin.ctx,
      { deploymentId: x.six.class_info.deployment.id },
      {
        db: t.db,
      },
    );
    await tap(ci, CLASS_ONE);
    await tap(ci, "That's all");
    expect(await expectOnlySessionOn(x, ci, "class_info")).toMatchObject({
      state: "COMPLETED",
      end_reason: "flow_end",
    });
    expect((await deploymentRows(x)).map((r) => [r.key, r.status])).toEqual(
      APPROVED.map((key) => [key, key === "class_info" ? "PAUSED" : "ACTIVE"]),
    );
    for (const key of APPROVED.filter((key) => key !== "class_info")) {
      const y = student(x);
      await say(y, OPENER[key]);
      await expectOnlySessionOn(x, y, key);
    }
  });

  it("SIX-CL-8: with Class Information paused, its keyword as a first message falls back to Student Enquiry (first_message), never to the paused bot", async () => {
    const x = await sixBotWorld();
    await pauseDeployment(
      x.w.admin.ctx,
      { deploymentId: x.six.class_info.deployment.id },
      {
        db: t.db,
      },
    );
    for (const body of ["classes", "class"]) {
      const y = student(x);
      await say(y, body);
      await expectOnlySessionOn(x, y, "student_enquiry");
    }
  });

  // ------------------------------------------------------------------------------------------------ SIX-CL-9

  /** The six representative journeys: opener, then the taps (one per round), then the expected terminal state. */
  const JOURNEYS: Record<BotKey, { taps: string[]; end: Record<string, unknown> }> = {
    staff_routing: {
      taps: ["Payment question"],
      end: { state: "HANDED_OVER", handover_reason: "student_requested" },
    },
    payment_enquiry: {
      taps: ["I have paid"],
      end: { state: "HANDED_OVER", handover_reason: "needs_staff" },
    },
    registration_enquiry: { taps: ["Cancel"], end: { state: "COMPLETED", end_reason: "flow_end" } },
    class_info: {
      taps: ["Class not listed"],
      end: { state: "HANDED_OVER", handover_reason: "needs_staff" },
    },
    general_info: {
      taps: ["Other question"],
      end: { state: "HANDED_OVER", handover_reason: "needs_staff" },
    },
    student_enquiry: {
      taps: ["English", "Talk to a person"],
      end: { state: "HANDED_OVER", handover_reason: "student_requested" },
    },
  };

  async function concurrentJourneys(round: () => Promise<unknown>) {
    const x = await sixBotWorld();
    const ys = APPROVED.map((key) => [key, student(x)] as const);
    for (const [key, y] of ys) await postText(y, OPENER[key]);
    await round();
    for (let r = 0; r < 2; r++) {
      for (const [key, y] of ys) {
        const title = JOURNEYS[key].taps[r];
        if (title === undefined) continue;
        expect(await k.post(tapBytes(y, title).bytes)).toBe(200);
      }
      await round();
    }
    const wamids: string[] = [];
    for (const [key, y] of ys) {
      const s = await expectOnlySessionOn(x, y, key);
      expect(s, key).toMatchObject(JOURNEYS[key].end);
      const requests = await k.rows(
        `select r.bot_step_seq, r.origin, r.state, r.attempt_count, m.wamid from outbound_requests r
           join messages m on m.id = r.message_id where r.bot_session_id = $1 order by r.bot_step_seq`,
        [s.id],
      );
      expect(
        requests.map((r) => r.bot_step_seq),
        key,
      ).toEqual(requests.map((_, i) => i + 1));
      expect(requests.map((r) => [r.origin, r.state, r.attempt_count])).toEqual(
        requests.map(() => ["BOT", "ACCEPTED", 1]),
      );
      expect(Number(s.terminal_notice_step_seq), key).toBe(requests.length);
      expect(requests.map((r) => r.wamid)).toEqual(k.sentTo(y).map((m) => m.wamid));
      for (const m of k.sentTo(y))
        expect(m.request).toMatchObject({ phoneNumberId: x.pn, recipient: { id: y.phone } });
      expect(
        (await k.triggersOf(y)).every((tr) => tr.status === "PROCESSED"),
        key,
      ).toBe(true);
      wamids.push(...requests.map((r) => r.wamid as string));
    }
    expect(new Set(wamids).size).toBe(wamids.length);
  }

  it("SIX-CL-9: six concurrent conversations, one per bot, delivered together and settled together, each reach their own terminal state without cross-talk", async () => {
    await concurrentJourneys(() => k.settle());
  });

  it("SIX-CL-9: the same six conversations with two bot workers claiming triggers concurrently", async () => {
    await concurrentJourneys(async () => {
      await k.webhookPass();
      await Promise.all([k.triggerPass(), k2.triggerPass()]);
      await k.settle();
    });
  });

  // ------------------------------------------------------------------------------------------------ SIX-CL-10

  /** Six fresh students, one per bot, whose first BOT request is written and still QUEUED (nothing dispatched). */
  async function sixQueued() {
    const x = await sixBotWorld();
    const ys = APPROVED.map(() => student(x));
    await Promise.all(ys.map((y, i) => postText(y, OPENER[APPROVED[i]!])));
    await k.webhookPass();
    await k.triggerPass();
    const queued = async () =>
      k.rows(
        "select id, state, hold_reason, attempt_count, send_started_at from outbound_requests where whatsapp_account_id = $1 and origin = 'BOT' order by send_started_at nulls last, id",
        [x.w.account.id],
      );
    expect((await queued()).map((r) => r.state)).toEqual(Array(6).fill("QUEUED"));
    const calls = () =>
      k.transport.calls.filter((c) => ys.some((y) => y.phone === c.recipient.id)).length;
    return { x, ys, queued, calls };
  }

  // The kit dispatches with zero spacing. Here the PRODUCTION defaults are passed explicitly and the dispatcher is driven pass
  // by pass on the real clock (bounded), never through settle(): a spaced request stays QUEUED and claims nothing, so a settle
  // round could quiesce with work left. Account spacing is what this proves; with one account and both defaults at 1 s, the
  // conversation spacing is not separately observable here (it is covered by messaging/dispatch.db.test.ts).
  it("SIX-CL-10: with the production 1 s pacing, six first prompts on one account are all sent, one per pass, at least 1 s apart; none is dropped or HELD", async () => {
    expect([DEFAULT_ACCOUNT_MIN_INTERVAL_MS, DEFAULT_CONVERSATION_MIN_INTERVAL_MS]).toEqual([
      1_000, 1_000,
    ]);
    const paced = {
      accountMinIntervalMs: DEFAULT_ACCOUNT_MIN_INTERVAL_MS,
      conversationMinIntervalMs: DEFAULT_CONVERSATION_MIN_INTERVAL_MS,
    };
    const { queued, calls } = await sixQueued();
    // Counted on this account's rows, not on the pass summary (which would include any other account's work).
    const accepted = async () => (await queued()).filter((r) => r.state === "ACCEPTED").length;
    await k.dispatchPass(paced);
    expect((await queued()).map((r) => r.state).sort()).toEqual([
      "ACCEPTED",
      ...Array(5).fill("QUEUED"),
    ]);
    expect(calls()).toBe(1);

    const deadline = Date.now() + 15_000; // six sends need about 5 s; bounded, never open-ended
    while ((await queued()).some((r) => r.state === "QUEUED")) {
      if (Date.now() > deadline) throw new Error("paced dispatch did not drain within 15 s");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const before = await accepted();
      await k.dispatchPass(paced);
      expect((await accepted()) - before).toBeLessThanOrEqual(1);
    }
    const done = await queued();
    expect(done.map((r) => [r.state, r.hold_reason, r.attempt_count])).toEqual(
      Array(6).fill(["ACCEPTED", null, 1]),
    );
    const started = done.map((r) => (r.send_started_at as Date).getTime());
    for (let i = 1; i < started.length; i++)
      expect(started[i]! - started[i - 1]!).toBeGreaterThanOrEqual(DEFAULT_ACCOUNT_MIN_INTERVAL_MS);
    expect(calls()).toBe(6);
  }, 30_000);

  it("SIX-CL-10: with the bot dispatch gate off, the six QUEUED first prompts are not candidates: nothing is claimed or sent", async () => {
    const { queued, calls } = await sixQueued();
    const d = await k.dispatchPass({ config: { ...BOTS_ON, botsRuntimeEnabled: false } });
    expect(d.claimed).toBe(0);
    expect((await queued()).map((r) => [r.state, r.attempt_count])).toEqual(
      Array(6).fill(["QUEUED", 0]),
    );
    expect(calls()).toBe(0);
  });

  it("SIX-CL-10: with live sending off (real MetaTransport), the six first prompts are HELD live_send_disabled and no HTTP call is made", async () => {
    const { queued, calls } = await sixQueued();
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
    expect((await queued()).map((r) => [r.state, r.hold_reason])).toEqual(
      Array(6).fill(["HELD", "live_send_disabled"]),
    );
    expect(calls()).toBe(0);
  });

  // ------------------------------------------------------------------------------------------------ SIX-CL-11

  // Proves persistence and the staff-scoped listMessages() result only. Not browser rendering, not display order (P3), not
  // delivery. Messages are found by content, never by position.
  it("SIX-CL-11: staff of the organization read each bot's handover notice, and Registration's summary, through listMessages()", async () => {
    const x = await sixBotWorld();
    const notice: Record<BotKey, string> = {
      staff_routing: nodesOf("staff_routing").h_payment!.message as string,
      payment_enquiry: nodesOf("payment_enquiry").verify_staff!.message as string,
      registration_enquiry: RE.to_review!.message as string,
      class_info: nodesOf("class_info").needs_staff!.message as string,
      general_info: nodesOf("general_info").needs_staff!.message as string,
      student_enquiry: nodesOf("student_enquiry").to_staff!.message as string,
    };
    for (const key of APPROVED) {
      const y = student(x);
      await say(y, OPENER[key]);
      if (key === "registration_enquiry") {
        await tap(y, "Continue");
        await say(y, "Test Student");
        await say(y, String(YEAR));
        await tap(y, CLASS_ONE);
        await tap(y, "Yes, hand over");
      } else for (const title of JOURNEYS[key].taps) await tap(y, title);
      const s = await expectOnlySessionOn(x, y, key);
      expect(s.state, key).toBe("HANDED_OVER");

      const { messages } = await listMessages(
        x.w.staff.ctx,
        (await k.conversationOf(y))!,
        { limit: 50 },
        { db: t.db as never },
      );
      expect(
        messages.filter((m) => m.direction === "OUTBOUND" && m.text === notice[key]),
        key,
      ).toHaveLength(1);
      if (key === "registration_enquiry") {
        const summary = messages.filter(
          (m) =>
            m.direction === "OUTBOUND" &&
            m.type === "INTERACTIVE" &&
            m.text?.includes("Test Student"),
        );
        expect(summary).toHaveLength(1);
        for (const line of confirmBody("Test Student", YEAR, CLASS_ONE).split("\n").filter(Boolean))
          expect(summary[0]!.text).toContain(line);
      }
    }
  });

  it("SIX-CL-11: staff of another organization cannot read any of the six conversations (not found); the owning staff can", async () => {
    const x = await sixBotWorld();
    const other = await k.world(generalInfoFlow());
    for (const key of APPROVED) {
      const y = student(x);
      await say(y, OPENER[key]);
      const conversation = (await k.conversationOf(y))!;
      await expect(
        listMessages(other.w.staff.ctx, conversation, { limit: 50 }, { db: t.db as never }),
      ).rejects.toThrow();
      const own = await listMessages(
        x.w.staff.ctx,
        conversation,
        { limit: 50 },
        {
          db: t.db as never,
        },
      );
      expect(own.messages.length, key).toBeGreaterThan(0);
    }
  });

  // ------------------------------------------------------------------------------------------------ SIX-CL-12

  it("SIX-CL-12: a keyword delivered twice (same bytes) and re-serialized (same wamid) with six bots deployed is one message, one trigger, one session", async () => {
    const x = await sixBotWorld();
    const y = student(x);
    const first = k.studentBytes(y, k.textMessage("pay"));
    expect(await k.post(first.bytes)).toBe(200);
    expect(await k.post(first.bytes)).toBe(200); // Meta redelivers the identical body
    // the same wamid in a re-serialized envelope (another profile name, indented JSON): different bytes, same message
    const envelope = JSON.parse(Buffer.from(first.bytes).toString("utf8")) as {
      entry: Array<{
        changes: Array<{ value: { contacts: Array<{ profile: { name: string } }> } }>;
      }>;
    };
    envelope.entry[0]!.changes[0]!.value.contacts[0]!.profile.name = "Student (renamed)";
    const again = Buffer.from(JSON.stringify(envelope, null, 2));
    expect(Buffer.compare(again, Buffer.from(first.bytes))).not.toBe(0);
    expect(await k.post(again)).toBe(200);
    await k.settle();
    expect(await k.post(first.bytes)).toBe(200); // a late redelivery after the session started
    await k.settle();
    await expectOnlySessionOn(x, y, "payment_enquiry");
    expect(await counts(y)).toEqual({
      inbound: 1,
      triggers: 1,
      sessions: 1,
      botRequests: 2,
      calls: 2,
    });
  });

  it("SIX-CL-12: Registration's 'Yes, hand over' tap delivered three times is one input: one handover, one notice", async () => {
    const x = await sixBotWorld();
    const y = student(x);
    await say(y, "join");
    await tap(y, "Continue");
    await say(y, "Test Student");
    await say(y, String(YEAR));
    await tap(y, CLASS_ONE);
    const { bytes, wamid } = tapBytes(y, "Yes, hand over");
    expect(await k.post(bytes)).toBe(200);
    expect(await k.post(bytes)).toBe(200);
    await k.settle();
    expect(await k.post(bytes)).toBe(200);
    await k.settle();
    const s = await expectOnlySessionOn(x, y, "registration_enquiry");
    expect(s).toMatchObject({ state: "HANDED_OVER", handover_reason: "needs_staff" });
    expect(
      k
        .sentTo(y)
        .filter((m) => JSON.stringify(m.request.message).includes(RE.to_review!.message as string)),
    ).toHaveLength(1);
    const inbound = (await k.inboundOf(y)).filter((m) => m.wamid === wamid);
    expect(inbound).toHaveLength(1);
    expect(
      (await k.eventsOf(s.id as string)).filter(
        (e) => e.kind === "INPUT_ACCEPTED" && e.message_id === inbound[0]!.id,
      ),
    ).toHaveLength(1);
  });

  it("SIX-CL-12: the original keyword redelivered after a Staff Routing handover changes nothing", async () => {
    const x = await sixBotWorld();
    const y = student(x);
    const { bytes } = await say(y, "staff");
    await tap(y, "Something else");
    const before = await counts(y);
    const sessionsBefore = await sessions(y);
    expect(await k.post(bytes)).toBe(200);
    await k.settle();
    expect(await counts(y)).toEqual(before);
    expect(await sessions(y)).toEqual(sessionsBefore);
  });

  // ------------------------------------------------------------------------------------------------ SIX-CL-13

  it("SIX-CL-13: takeover, Stop and Pause in one organization, an archived contact and a disabled account in another, in one run: each effect stays on its target", async () => {
    const a = await sixBotWorld();
    const b = await sixBotWorld();
    const [pe, gi, ci, re, sr] = [student(a), student(a), student(a), student(a), student(a)];
    await say(pe, "pay");
    await say(gi, "info");
    await say(ci, "classes");
    await say(re, "join");

    // org A: staff take over Payment, Stop General Information, Pause Class Information
    await assign(pe);
    const stop = await stopActiveSessions(
      a.w.admin.ctx,
      { deploymentId: a.six.general_info.deployment.id, expectedLiveSessions: 1 },
      { db: t.db as never },
    );
    expect(stop.value).toMatchObject({ sessionsStopped: 1 });
    await pauseDeployment(
      a.w.admin.ctx,
      { deploymentId: a.six.class_info.deployment.id },
      {
        db: t.db,
      },
    );
    const callsBefore = { pe: (await counts(pe)).calls, gi: (await counts(gi)).calls };
    await tap(pe, "How to pay");
    await tap(gi, "[TEST] Topic one");
    await tap(ci, CLASS_ONE);
    await tap(ci, "That's all");
    await tap(re, "Cancel");
    await say(sr, "staff");
    await tap(sr, "Something else");

    expect(await expectOnlySessionOn(a, pe, "payment_enquiry")).toMatchObject({
      state: "HANDED_OVER",
      handover_reason: "staff_assigned",
    });
    expect(await expectOnlySessionOn(a, gi, "general_info")).toMatchObject({
      state: "HANDED_OVER",
      handover_reason: "operator_stop",
    });
    expect((await counts(pe)).calls).toBe(callsBefore.pe);
    expect((await counts(gi)).calls).toBe(callsBefore.gi);
    expect(await expectOnlySessionOn(a, ci, "class_info")).toMatchObject({
      state: "COMPLETED",
      end_reason: "flow_end",
    });
    expect(await expectOnlySessionOn(a, re, "registration_enquiry")).toMatchObject({
      state: "COMPLETED",
      end_reason: "flow_end",
    });
    expect(await expectOnlySessionOn(a, sr, "staff_routing")).toMatchObject({
      state: "HANDED_OVER",
      handover_reason: "other",
    });
    expect((await deploymentRows(a)).map((r) => [r.key, r.status])).toEqual(
      APPROVED.map((key) => [
        key,
        key === "general_info" || key === "class_info" ? "PAUSED" : "ACTIVE",
      ]),
    );

    // org B: an archived contact mid-session, an untouched student, then a disabled account
    const [archived, untouched, late] = [student(b), student(b), student(b)];
    await say(archived, "pay");
    await k.q(
      "update contacts set archived_at = clock_timestamp() where organization_id = $1 and wa_id = $2",
      [b.w.org.id, archived.phone],
    );
    const archivedCalls = (await counts(archived)).calls;
    await tap(archived, "How to pay");
    expect((await counts(archived)).calls).toBe(archivedCalls);
    expect((await sessions(archived))[0]!.state).not.toBe("WAITING_FOR_INPUT");

    await say(untouched, "join");
    await tap(untouched, "Cancel");
    expect(await expectOnlySessionOn(b, untouched, "registration_enquiry")).toMatchObject({
      state: "COMPLETED",
      end_reason: "flow_end",
    });

    await k.q("update whatsapp_accounts set status = 'DISABLED' where id = $1", [b.w.account.id]);
    // Driven pass by pass, not settle(): ingest refuses a disabled account's event (account_not_active), which settle()
    // would report as a failed webhook pass. Only the outcome is asserted: nothing starts and nothing is sent.
    await postText(late, "staff");
    await k.webhookPass();
    await k.triggerPass();
    await k.dispatchPass();
    expect(await counts(late)).toMatchObject({ sessions: 0, botRequests: 0, calls: 0 });

    // org B's controls did not reach org A, and org A's did not reach org B
    expect((await deploymentRows(b)).every((r) => r.status === "ACTIVE")).toBe(true);
    expect(
      (await k.one("select status from whatsapp_accounts where id = $1", [a.w.account.id]))!.status,
    ).toBe("ACTIVE");
  });
});
