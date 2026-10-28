import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { listMessages } from "@/modules/inbox";
import { enquiryFlow, staffRoutingFlow, type Json } from "@/modules/bots/testing";
import { TEST_APP_SECRET } from "@/modules/whatsapp/testing";
import { activateDeployment } from "../bot-control";
import { publishedBot } from "../bot-control/testing";
import { reconcileSession } from "./reconcile";
import { closedLoopKit, type LoopWorld, type SentMessage } from "./testing";

// Phase 08G-4, SR-CL-1 .. SR-CL-8 of docs/PHASE_08G-4_ACCEPTANCE.md: the SYNTHETIC Staff Routing golden flow
// (staffRoutingFlow, src/modules/bots/testing.ts) through the REAL closed loop (closedLoopKit: signed webhook -> ingest ->
// webhook worker -> bot worker -> dispatcher -> FakeTransport) on a disposable PostgreSQL 17 database only. Nothing here can
// reach Meta. WRITTEN BUT NOT YET EXECUTED (needs owner-authorized isolated database validation). Staff takeover, Stop/Pause,
// tenant isolation, version pinning, automation gates, redaction and worker recovery are proven once by the Student enquiry,
// General Information and Payment suites and are not repeated here.

type Node = Json & { type: string };
const FLOW = staffRoutingFlow();
const NODES = FLOW.nodes as Record<string, Node>;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const MIN = 60_000;

const CATEGORIES = [
  ["classes", "Class question", "h_classes", "student_requested"],
  ["payment", "Payment question", "h_payment", "student_requested"],
  ["register", "Registration", "h_register", "student_requested"],
  ["technical", "Problem joining class", "h_technical", "student_requested"],
  ["other", "Something else", "h_other", "other"],
] as const;

const textOf = (body: string) => ({ type: "text", body, replyToWamid: null });
const noticeOf = (nodeId: string) => textOf(NODES[nodeId]!.message as string);

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

/** The exact list payload the reason menu must produce for `token`, built from the fixture, not from the capture. */
function expectedMenu(token: string) {
  const n = NODES.reason_menu!;
  const rows = (n.options as Array<Record<string, string>>).map((o) => ({
    id: `b1.${token}.${o.key}`,
    title: o.title,
  }));
  return {
    type: "interactive",
    payload: {
      v: 1,
      kind: "list",
      body: n.body,
      buttonLabel: n.buttonLabel,
      footer: n.footer,
      sections: [{ title: n.buttonLabel, rows }],
    },
  };
}

describe("closed loop: Staff Routing (SYNTHETIC golden flow), 08G-4", () => {
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
    const { bytes } = k.studentBytes(x, k.textMessage(body));
    expect(await k.post(bytes)).toBe(200);
    await k.settle();
  }
  /** The first message: the session id once the welcome and the category list were accepted. */
  async function start(x: LoopWorld, body = "staff") {
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
    const { bytes } = k.studentBytes(x, k.tapMessage(option, "list_reply", prompt.wamid));
    expect(await k.post(bytes)).toBe(200);
    await k.settle();
  }

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

  /** The welcome, the category list (fresh tokens) and then `rest` notice texts: exactly what the provider received. */
  async function expectTranscript(
    x: LoopWorld,
    sessionId: string,
    shape: Array<"menu" | ReturnType<typeof textOf>>,
  ) {
    const sent = k.sentTo(x);
    expect(sent).toHaveLength(shape.length);
    const tokens: string[] = [];
    sent.forEach((m, i) => {
      expect(m.request).toMatchObject({
        phoneNumberId: x.pn,
        credentialRef: "WA_TOKEN_TEST",
        recipient: { kind: "PHONE", id: x.phone },
      });
      const e = shape[i]!;
      if (e === "menu") {
        const token = tokenOf(m);
        expect(token).toMatch(TOKEN);
        tokens.push(token);
        expect(m.request.message).toEqual(expectedMenu(token));
      } else expect(m.request.message).toEqual(e);
    });
    expect(new Set(tokens).size).toBe(tokens.length); // every prompt has a fresh token
    const requests = await k.rows(
      `select r.*, m.wamid from outbound_requests r join messages m on m.id = r.message_id
        where r.organization_id = $1 and r.bot_session_id = $2 order by r.bot_step_seq`,
      [x.w.org.id, sessionId],
    );
    expect(requests.map((r) => r.bot_step_seq)).toEqual(shape.map((_, i) => i + 1));
    expect(requests.map((r) => r.idempotency_key)).toEqual(
      shape.map((_, i) => `bot-${sessionId}-${i + 1}`),
    );
    expect(requests.map((r) => [r.origin, r.state, r.attempt_count])).toEqual(
      shape.map(() => ["BOT", "ACCEPTED", 1]),
    );
    expect(requests.map((r) => r.wamid)).toEqual(sent.map((m) => m.wamid));
    expect(await k.requestsOf(x)).toHaveLength(shape.length); // no request outside the session
    expect(k.transport.calls.filter((c) => c.recipient.id === x.phone)).toHaveLength(shape.length);
    return { tokens, requests };
  }

  // ------------------------------------------------------------------------------------------------ SR-CL-1

  it.each(CATEGORIES)(
    "SR-CL-1: %s (%s) -> welcome, category list, one category-specific notice; HANDED_OVER as %s",
    async (_key, title, nodeId, reason) => {
      const x = await k.world(FLOW);
      const sid = await start(x);
      await tap(x, title);
      await expectTranscript(x, sid, [
        textOf(NODES.welcome!.text as string),
        "menu",
        noticeOf(nodeId),
      ]);
      expect(await eventRows(sid)).toEqual([
        ["INPUT_ACCEPTED", null],
        ["HANDED_OVER", reason === "other" ? "other" : "student_requested"],
      ]);
      expect(await k.sessionsOf(x)).toMatchObject([
        {
          id: sid,
          organization_id: x.w.org.id,
          bot_id: x.bot.id,
          bot_version_id: x.version.id,
          deployment_id: x.deployment.id,
          state: "HANDED_OVER",
          current_node_id: nodeId,
          end_reason: "flow_handover",
          handover_reason: reason,
          terminal_notice_step_seq: 3,
          step_seq: 3,
          variables: {},
        },
      ]);
      // The fifth notice names the category on its own (the P3 wording refinement).
      if (nodeId === "h_other")
        expect((k.sentTo(x).at(-1)!.request.message as { body: string }).body).toContain(
          "your other question",
        );
    },
  );

  // ------------------------------------------------------------------------------------------------ SR-CL-2

  it.each(["staff", "  AGENT  ", "Human"])(
    "SR-CL-2: the keyword %j starts Staff Routing on its pinned version",
    async (body) => {
      const x = await k.world(FLOW);
      const sid = await start(x, body);
      const [inbound] = await k.inboundOf(x);
      expect(inbound).toMatchObject({ type: "TEXT", body });
      expect(await k.sessionsOf(x)).toMatchObject([
        {
          id: sid,
          bot_id: x.bot.id,
          bot_version_id: x.version.id,
          state: "WAITING_FOR_INPUT",
          current_node_id: "reason_menu",
          started_by_message_id: inbound!.id,
        },
      ]);
    },
  );

  it.each(["staffing", "human please", "pay", "class", "info"])(
    "SR-CL-2: with only Staff Routing deployed, %j does not start it (no_trigger_match: no session, request or call)",
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

  it("SR-CL-2: with Student Enquiry also deployed (Staff Routing at priority 1), 'staff' starts Staff Routing and a plain first message starts Student Enquiry", async () => {
    const x = await k.world(FLOW); // Staff Routing, priority 1
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
    const keyword = await start(x, "staff");
    const y = anotherStudent(x);
    const plain = await start(y, "Good morning");
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        id: keyword,
        bot_id: x.bot.id,
        bot_version_id: x.version.id,
        deployment_id: x.deployment.id,
      },
    ]);
    expect(await k.sessionsOf(y)).toMatchObject([{ id: plain, bot_id: se.bot.id }]);
    expect(k.sentTo(x)[0]!.request.message).toEqual(textOf(NODES.welcome!.text as string));
    expect(k.sentTo(y)[0]!.request.message.type).toBe("interactive"); // Student Enquiry's language menu
  });

  // ------------------------------------------------------------------------------------------------ SR-CL-3

  it("SR-CL-3: an invalid reply re-sends the category list with a different token, and the new token is accepted", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await say(x, "my fees");
    expect(await k.sessionsOf(x)).toMatchObject([
      { state: "WAITING_FOR_INPUT", current_node_id: "reason_menu", invalid_attempts: 1 },
    ]);
    const [first, reprompt] = k.sentTo(x).slice(1).map(tokenOf); // from the captured payloads, not fabricated
    expect(reprompt).not.toBe(first);
    await tap(x, "Payment question"); // taps the re-prompt's option ids, i.e. the new token
    const { tokens } = await expectTranscript(x, sid, [
      textOf(NODES.welcome!.text as string),
      "menu",
      "menu",
      noticeOf("h_payment"),
    ]);
    expect(tokens).toEqual([first, reprompt]);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_REJECTED", "wrong_kind"],
      ["INPUT_ACCEPTED", null],
      ["HANDED_OVER", "student_requested"],
    ]);
  });

  it("SR-CL-3: two invalid replies hand over as invalid_input with the shared notice (no second re-prompt)", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await say(x, "??");
    await say(x, "!!");
    await expectTranscript(x, sid, [
      textOf(NODES.welcome!.text as string),
      "menu",
      "menu",
      noticeOf("invalid_to_staff"),
    ]);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_REJECTED", "wrong_kind"],
      ["INPUT_REJECTED", "wrong_kind"],
      ["HANDED_OVER", "invalid_input"],
    ]);
    expect(await k.sessionsOf(x)).toMatchObject([
      { state: "HANDED_OVER", end_reason: "flow_handover", handover_reason: "invalid_input" },
    ]);
  });

  // ------------------------------------------------------------------------------------------------ SR-CL-4

  // What this proves: the persisted student selection and the persisted bot notice are returned by the REAL listMessages()
  // under the real staff AccessContext (conversation.read), scoped by organization, conversation and account. It does NOT
  // prove browser rendering or WhatsApp delivery (the notice was accepted by the FAKE transport). Authorization itself is
  // enforced by assertCan inside listMessages; cross-tenant refusal is proven by the Inbox suites and is not repeated.
  it.each(CATEGORIES)(
    "SR-CL-4: %s (%s): the staff timeline shows the student's selection and the category-specific notice",
    async (_key, title, nodeId) => {
      const x = await k.world(FLOW);
      await start(x);
      await tap(x, title);
      const conversationId = (await k.conversationOf(x))!;
      const { messages } = await listMessages(
        x.w.staff.ctx,
        conversationId,
        { limit: 50 },
        { db: t.db as never },
      );
      // The timeline contract is occurred_at order (id tiebreak), returned oldest first. Inbound messages carry the provider's
      // whole-second timestamp and bot messages the server's millisecond clock, so a reply in the same second as its prompt may
      // legitimately sort before it (separate P3 Inbox issue). Causal order is therefore NOT asserted, only the contract.
      expect(messages).toHaveLength(5);
      const times = messages.map((m) => Date.parse(m.occurredAt));
      expect(times).toEqual([...times].sort((p, q) => p - q));
      // Identified by direction, type and content, not by array position.
      const found = (pred: (m: (typeof messages)[number]) => boolean) => {
        const hit = messages.filter(pred);
        expect(hit).toHaveLength(1);
        return hit[0]!;
      };
      const keyword = found((m) => m.direction === "INBOUND" && m.type === "TEXT");
      const welcome = found((m) => m.text === NODES.welcome!.text);
      const list = found((m) => m.direction === "OUTBOUND" && m.type === "INTERACTIVE");
      const selection = found((m) => m.direction === "INBOUND" && m.type === "INTERACTIVE");
      const notice = found((m) => m.text === NODES[nodeId]!.message);
      expect(keyword.text).toBe("staff");
      expect(welcome).toMatchObject({ direction: "OUTBOUND", type: "TEXT" });
      // Five distinct persisted messages, exactly the five relevant ones (no extras, none missing).
      expect(new Set([keyword, welcome, list, selection, notice].map((m) => m.id)).size).toBe(5);
      expect(
        await k.one("select count(*)::int as n from messages where conversation_id = $1", [
          conversationId,
        ]),
      ).toEqual({ n: 5 });
      expect(selection).toMatchObject({ type: "INTERACTIVE", text: title });
      expect(notice).toMatchObject({ type: "TEXT", text: NODES[nodeId]!.message });
      expect(notice.delivery).not.toBeNull(); // a real outbound request exists (ACCEPTED), shown with its own status

      // The listed rows are the persisted rows of this organization, conversation and account.
      const rows = await k.rows(
        `select id, organization_id, conversation_id, whatsapp_account_id, direction, type, body
           from messages where id = any($1::uuid[])`,
        [messages.map((m) => m.id)],
      );
      expect(rows).toHaveLength(5);
      for (const r of rows)
        expect(r).toMatchObject({
          organization_id: x.w.org.id,
          conversation_id: conversationId,
          whatsapp_account_id: x.w.account.id,
        });
      expect(rows.find((r) => r.id === selection.id)).toMatchObject({
        direction: "INBOUND",
        body: title,
      });
      expect(rows.find((r) => r.id === notice.id)).toMatchObject({
        direction: "OUTBOUND",
        type: "TEXT",
        body: NODES[nodeId]!.message,
      });
      // The "Something else" notice is distinguishable from the other four by the timeline alone.
      if (nodeId === "h_other") expect(notice.text).toContain("your other question");
    },
  );

  // ------------------------------------------------------------------------------------------------ SR-CL-5

  it("SR-CL-5: after a handover, further bot keywords start nothing (IGNORED handover_unresolved): no session, request or call", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await tap(x, "Something else");
    const before = await counts(x);
    expect(before).toMatchObject({ sessions: 1, botRequests: 3, calls: 3 });
    for (const keyword of ["staff", "human", "agent"]) {
      await say(x, keyword);
      expect((await k.triggersOf(x)).at(-1)).toMatchObject({
        status: "IGNORED",
        outcome_code: "handover_unresolved",
      });
    }
    expect(await counts(x)).toEqual({
      ...before,
      inbound: before.inbound + 3,
      triggers: before.triggers + 3,
    });
    expect(await k.sessionsOf(x)).toMatchObject([
      { id: sid, state: "HANDED_OVER", end_reason: "flow_handover", handover_reason: "other" },
    ]);
    expect(await eventRows(sid)).toEqual([
      ["INPUT_ACCEPTED", null],
      ["HANDED_OVER", "other"],
    ]);
  });

  // ------------------------------------------------------------------------------------------------ SR-CL-6

  it("SR-CL-6: waiting at the category list, reconciliation with a fixed decision clock: not due 1 ms before expires_at, COMPLETED idle_timeout at expires_at, silently", async () => {
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
    expect(await counts(x)).toEqual(before);
    expect(await eventRows(sid)).toEqual([]);
  });

  // ------------------------------------------------------------------------------------------------ SR-CL-7

  it("SR-CL-7: a handover collects nothing and assigns no one: no variables, lead, tag or assignee; the conversation is not assigned", async () => {
    const x = await k.world(FLOW);
    const sid = await start(x);
    await tap(x, "Payment question"); // the most sensitive category: still only a handover
    expect(await k.sessionsOf(x)).toMatchObject([{ id: sid, state: "HANDED_OVER", variables: {} }]);
    // Only the student's keyword and selection were stored for this contact; the flow has no QUESTION node (golden test).
    expect((await k.inboundOf(x)).map((m) => m.type)).toEqual(["TEXT", "INTERACTIVE"]);
    // No lead, attribution or tag. The schema has no payment or registration table: nothing of that kind can exist.
    for (const table of ["leads", "lead_attributions", "contact_tags"])
      expect(
        await k.one(`select count(*)::int as n from ${table} where organization_id = $1`, [
          x.w.org.id,
        ]),
      ).toEqual({ n: 0 });
    // Handover status is not an assignment: no assignee on the row and no assignment in the staff workflow history.
    const conversationId = (await k.conversationOf(x))!;
    expect(
      await k.one(
        "select assigned_membership_id, assigned_at, status from conversations where organization_id = $1 and id = $2",
        [x.w.org.id, conversationId],
      ),
    ).toEqual({ assigned_membership_id: null, assigned_at: null, status: "OPEN" });
    expect(
      await k.one(
        `select count(*)::int as n from conversation_events
          where organization_id = $1 and conversation_id = $2
            and (to_assignee_membership_id is not null or from_assignee_membership_id is not null)`,
        [x.w.org.id, conversationId],
      ),
    ).toEqual({ n: 0 });
  });

  // ------------------------------------------------------------------------------------------------ SR-CL-8

  it("SR-CL-8: identity: every session, request and message belongs to this organization, conversation, account, bot, deployment and pinned version", async () => {
    // The control boundary (staff assignment, takeover, Stop, Pause) is proven once for any bot by closed-loop.db.test.ts H1/H2,
    // staff-takeover-suppression, stop-boundary and pause-drain; Staff Routing adds no control path of its own.
    const x = await k.world(FLOW);
    const sid = await start(x);
    await tap(x, "Class question");
    const conversationId = (await k.conversationOf(x))!;
    expect(await k.sessionsOf(x)).toMatchObject([
      {
        id: sid,
        organization_id: x.w.org.id,
        conversation_id: conversationId,
        whatsapp_account_id: x.w.account.id,
        bot_id: x.bot.id,
        deployment_id: x.deployment.id,
        bot_version_id: x.version.id,
      },
    ]);
    const requests = await k.requestsOf(x);
    expect(requests).toHaveLength(3);
    for (const r of requests)
      expect(r).toMatchObject({
        organization_id: x.w.org.id,
        conversation_id: conversationId,
        whatsapp_account_id: x.w.account.id,
        bot_session_id: sid,
        origin: "BOT",
      });
    for (const m of await k.rows(
      "select organization_id, conversation_id, whatsapp_account_id from messages where conversation_id = $1",
      [conversationId],
    ))
      expect(m).toEqual({
        organization_id: x.w.org.id,
        conversation_id: conversationId,
        whatsapp_account_id: x.w.account.id,
      });
  });
});
