import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import {
  dispatchWorld,
  liveSessionFor,
  queueBotStep,
  windowStudent,
  type DispatchFixture,
  type LiveSession,
} from "./testing";
import type { BotOutboundMessage } from "@/modules/messaging/interactive";
import { NotFoundError } from "@/shared/errors/http-errors";
import { listConversations, listMessages } from "@/modules/inbox";
import { addMessage, forceRequestState } from "@/modules/inbox/testing";

// LOCATION NOTE: the owner asked for src/modules/inbox/interactive.db.test.ts, but bot-control/boundaries.test.ts pins that
// nothing outside the bot-control module (tests included) imports @/modules/bot-control, and this test needs its fixtures
// (deployed bot, live session, queueBotStep). The file therefore lives here, with every pin intact; it exercises the Inbox
// through its public API (listMessages, listConversations) exactly as an inbox test would.
//
// Phase 08E-0.4 (the third outstanding Phase 08D condition): how a bot's interactive messages and the customer's replies
// appear in the staff Inbox, on real PostgreSQL (disposable al_ict_test_* databases only). Bot messages are created through
// the approved queue function (enqueueAutomatedMessage, via the bot-control fixture `queueBotStep`), so the stored rows are
// exactly what the 08E runtime will write. Request states are reached only through LEGAL lifecycle transitions
// (`forceRequestState`, the same walk the existing Inbox tests use).
//
// Intentionally NOT covered here, because the data model cannot produce them: a provider delivery status (SENT, DELIVERED,
// READ, FAILED) on a request that was never ACCEPTED (Meta's message id is stored only at acceptance, and statuses attach by
// that id). The pure display contract for that impossible mix is pinned in unit.test.ts instead. Also excluded: states the
// dispatcher can never write to a BOT request (BOT SENDING -> QUEUED is refused by the database).

describe("inbox display of bot interactive messages", () => {
  let t: TestDb;
  let f: DispatchFixture;
  const db = () => ({ db: t.db as never });
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);

  beforeAll(async () => {
    t = await createTestDatabase();
    f = await dispatchWorld(t, { lastInboundAt: new Date() });
  });
  afterAll(async () => t.close());

  // ------------------------------------------------------------------------------------------------------- fixtures

  const token = () => randomBytes(16).toString("base64url"); // 22 characters: the bot reply-id token grammar
  const buttonsMessage = (body = "Choose a topic"): BotOutboundMessage => {
    const tok = token();
    return {
      kind: "buttons",
      body,
      footer: "Reply to continue",
      buttons: [
        { id: `b1.${tok}.fees`, title: "Fees" },
        { id: `b1.${tok}.timetable`, title: "Timetable" },
        { id: `b1.${tok}.staff`, title: "Talk to staff" },
      ],
    };
  };
  const listMessage = (body = "Pick a class"): BotOutboundMessage => {
    const tok = token();
    return {
      kind: "list",
      body,
      buttonLabel: "Menu",
      footer: "Tap Menu",
      rows: [
        { id: `b1.${tok}.theory`, title: "ICT Theory", description: "Tuesday evening" },
        { id: `b1.${tok}.practical`, title: "ICT Practical" },
      ],
    };
  };
  const idsOf = (m: BotOutboundMessage) =>
    m.kind === "buttons"
      ? m.buttons.map((b) => b.id)
      : m.kind === "list"
        ? m.rows.map((r) => r.id)
        : [];

  type Made = {
    fx: DispatchFixture;
    s: LiveSession;
    requestId: string;
    messageId: string;
    message: BotOutboundMessage;
  };

  /** A new student with a live session and one real QUEUED BOT request carrying `message`, made by the approved queue function. */
  async function bot(message: BotOutboundMessage, fx: DispatchFixture = f): Promise<Made> {
    const s = await liveSessionFor(t, fx, await windowStudent(t, fx.w, new Date()));
    const r = await queueBotStep(t, fx, s, { stepSeq: 1, message, now: new Date() });
    return { fx, s, requestId: r.requestId, messageId: r.messageId, message };
  }

  const timeline = async (x: Pick<Made, "fx" | "s">) =>
    (await listMessages(x.fx.w.staff.ctx, x.s.student.conversation.id, { limit: 50 }, db()))
      .messages;
  const shown = async (x: Made) => (await timeline(x)).find((m) => m.id === x.messageId)!;

  /** Records the id Meta returns at acceptance and, optionally, a delivery status for it. */
  const accept = async (
    x: Made,
    status: "SENT" | "DELIVERED" | "READ" | "FAILED" | null = null,
    errorCode: string | null = null,
  ) => {
    await forceRequestState(t.pool, x.requestId, "ACCEPTED");
    const wamid = `wamid.BOT.${randomUUID()}`;
    await q(
      `update messages set wamid = $2, latest_status = $3, latest_status_at = case when $3::text is null then null else now() end,
         error_code = $4 where id = $1`,
      [x.messageId, wamid, status, errorCode],
    );
    return wamid;
  };

  // ------------------------------------------------------------------------------------------------ what staff see

  it("buttons and list messages made by the queue function show their body and option titles, as an outbound, queued message", async () => {
    const b = await bot(buttonsMessage());
    const l = await bot(listMessage());
    expect(await shown(b)).toMatchObject({
      direction: "OUTBOUND",
      type: "INTERACTIVE",
      text: "Choose a topic · Fees / Timetable / Talk to staff",
      placeholder: "Interactive message",
      reply: null,
      unseen: false,
      delivery: { phase: "QUEUED", label: "Queued", severity: "neutral" },
    });
    expect(await shown(l)).toMatchObject({
      text: "Pick a class · ICT Theory / ICT Practical", // descriptions, footer and button label are not shown
      placeholder: "Interactive message",
      delivery: { phase: "QUEUED" },
    });
    // what is stored is the approved payload shape (the display reads exactly this)
    const stored = (await q("select content from messages where id = $1", [b.messageId])).rows[0]
      .content as { interactive: { kind: string; buttons: unknown[] } };
    expect(stored.interactive).toMatchObject({ kind: "buttons" });
    expect(stored.interactive.buttons).toHaveLength(3);
  });

  describe("request states reached by legal transitions", () => {
    it.each([
      ["SENDING", "SENDING", "Sending…", "neutral"],
      ["ACCEPTED", "ACCEPTED", "Accepted by WhatsApp", "neutral"],
      ["REJECTED", "REJECTED", "Rejected by WhatsApp", "error"],
      ["UNKNOWN_OUTCOME", "UNKNOWN_OUTCOME", "Outcome unknown", "warning"],
    ] as const)("%s", async (state, phase, label, severity) => {
      const x = await bot(buttonsMessage());
      await forceRequestState(t.pool, x.requestId, state);
      const m = await shown(x);
      expect(m.delivery).toMatchObject({ phase, label, severity });
      // the message text does not depend on the delivery state
      expect(m.text).toBe("Choose a topic · Fees / Timetable / Talk to staff");
    });

    it("a rejection shows its plain reason; an unknown outcome never invites a resend", async () => {
      const rejected = await bot(buttonsMessage());
      await forceRequestState(t.pool, rejected.requestId, "REJECTED", {
        failureCode: "invalid_request",
      });
      expect((await shown(rejected)).delivery?.detail).toBe("invalid request");
      const unknown = await bot(buttonsMessage());
      await forceRequestState(t.pool, unknown.requestId, "UNKNOWN_OUTCOME");
      const detail = (await shown(unknown)).delivery!.detail!;
      expect(detail).toMatch(/may or may not have been sent/);
      expect(detail).toMatch(/Do not send it again/);
    });

    // Every code a bot request can be held with today (migration 0008's hold function, the claim, the final authorization
    // and enqueue), plus bot_send_deadline, which the 08E reconciler will write (V3.2 N.1).
    it.each([
      "bot_stopped",
      "bot_epoch_superseded",
      "bot_deployment_inactive",
      "bot_archived",
      "bot_output_suppressed",
      "bot_session_ended",
      "bot_step_superseded",
      "staff_took_over",
      "conversation_resolved",
      "bot_state_unreadable",
      "bots_runtime_disabled",
      "payload_invalid",
      "bot_send_deadline",
      "window_closed",
      "deadline_passed",
    ])("HELD (%s): a warning that nothing was sent", async (code) => {
      const x = await bot(buttonsMessage());
      await forceRequestState(t.pool, x.requestId, "HELD", { holdReason: code });
      const d = (await shown(x)).delivery!;
      expect(d).toMatchObject({ phase: "HELD", label: "Not sent", severity: "warning" });
      expect(d.detail).toMatch(/^Not sent: /);
      expect(d.detail).not.toMatch(/_/); // never the raw code
    });
  });

  describe("an accepted message and the provider's delivery statuses", () => {
    it.each([
      [null, "ACCEPTED", "Accepted by WhatsApp", "neutral"],
      ["SENT", "SENT", "Sent", "neutral"],
      ["DELIVERED", "DELIVERED", "Delivered", "good"],
      ["READ", "READ", "Read", "good"],
    ] as const)("status %s", async (status, phase, label, severity) => {
      const x = await bot(buttonsMessage());
      await accept(x, status);
      expect((await shown(x)).delivery).toMatchObject({ phase, label, severity });
    });

    it("FAILED names the WhatsApp error code only", async () => {
      const x = await bot(listMessage());
      await accept(x, "FAILED", "131026");
      expect((await shown(x)).delivery).toMatchObject({
        phase: "FAILED",
        label: "Delivery failed",
        severity: "error",
        detail: "WhatsApp error 131026",
      });
    });
  });

  // ------------------------------------------------------------------------------------------------------ replies

  describe("customer replies and their previews", () => {
    it("a button reply to the bot's message shows the tapped title and previews the message it answers", async () => {
      const x = await bot(buttonsMessage("Choose a topic"));
      const wamid = await accept(x, "DELIVERED");
      const reply = await addMessage(
        t.db,
        { org: x.fx.w.org, account: x.fx.w.account, conversation: x.s.student.conversation },
        {
          direction: "INBOUND",
          type: "INTERACTIVE",
          body: "Fees",
          content: { subtype: "button_reply", id: idsOf(x.message)[0], title: "Fees" },
          occurredAt: new Date(Date.now() + 1_000),
          replyToMessageId: x.messageId,
          replyToWamid: wamid,
        },
      );
      const m = (await timeline(x)).find((r) => r.id === reply.id)!;
      expect(m).toMatchObject({
        direction: "INBOUND",
        type: "INTERACTIVE",
        text: "Fees",
        placeholder: "Interactive reply",
        delivery: null,
        reply: { resolved: true, direction: "OUTBOUND", preview: "Choose a topic" },
      });
    });

    it("a list reply shows the tapped row title, not its description or id", async () => {
      const x = await bot(listMessage("Pick a class"));
      const wamid = await accept(x);
      const reply = await addMessage(
        t.db,
        { org: x.fx.w.org, account: x.fx.w.account, conversation: x.s.student.conversation },
        {
          direction: "INBOUND",
          type: "INTERACTIVE",
          body: "ICT Theory",
          content: {
            subtype: "list_reply",
            id: idsOf(x.message)[0],
            title: "ICT Theory",
            description: "Tuesday evening",
          },
          occurredAt: new Date(Date.now() + 1_000),
          replyToMessageId: x.messageId,
          replyToWamid: wamid,
        },
      );
      const m = (await timeline(x)).find((r) => r.id === reply.id)!;
      expect(m).toMatchObject({
        text: "ICT Theory",
        placeholder: "Interactive reply",
        reply: { resolved: true, direction: "OUTBOUND", preview: "Pick a class" },
      });
      expect(JSON.stringify(m)).not.toContain("Tuesday evening");
    });

    it("a template quick-reply BUTTON shows its text and never its payload", async () => {
      const x = await bot(buttonsMessage());
      const reply = await addMessage(
        t.db,
        { org: x.fx.w.org, account: x.fx.w.account, conversation: x.s.student.conversation },
        {
          direction: "INBOUND",
          type: "BUTTON",
          body: "Yes, I am interested",
          content: { payload: "CAMPAIGN_4471_YES", text: "Yes, I am interested" },
          occurredAt: new Date(Date.now() + 1_000),
        },
      );
      const m = (await timeline(x)).find((r) => r.id === reply.id)!;
      expect(m).toMatchObject({ text: "Yes, I am interested", placeholder: "Button reply" });
      expect(JSON.stringify(m)).not.toContain("CAMPAIGN_4471");
    });

    it("an unresolved reply (the bot message's id was never stored) shows as unresolved without a preview", async () => {
      const x = await bot(buttonsMessage());
      const reply = await addMessage(
        t.db,
        { org: x.fx.w.org, account: x.fx.w.account, conversation: x.s.student.conversation },
        {
          direction: "INBOUND",
          type: "INTERACTIVE",
          body: "Fees",
          content: { subtype: "button_reply", id: idsOf(x.message)[0], title: "Fees" },
          occurredAt: new Date(Date.now() + 1_000),
          replyToWamid: "wamid.NOT.YET.STORED",
        },
      );
      const m = (await timeline(x)).find((r) => r.id === reply.id)!;
      expect(m.reply).toEqual({ resolved: false, direction: null, preview: null });
    });
  });

  // ------------------------------------------------------------------------------------------- conversation list

  describe("conversation list previews", () => {
    it("the preview of a conversation whose last message is the bot's menu is its body; after a reply it is the reply's title", async () => {
      const g = await dispatchWorld(t, { lastInboundAt: new Date() });
      const x = await bot(buttonsMessage("Choose a topic"), g);
      const find = async () =>
        (await listConversations(g.w.staff.ctx, { limit: 50 }, db())).items.find(
          (i) => i.id === x.s.student.conversation.id,
        )!;
      expect((await find()).preview).toEqual({ direction: "OUTBOUND", text: "Choose a topic" });
      await addMessage(
        t.db,
        { org: g.w.org, account: g.w.account, conversation: x.s.student.conversation },
        {
          direction: "INBOUND",
          type: "INTERACTIVE",
          body: "Fees",
          content: { subtype: "button_reply", id: idsOf(x.message)[0], title: "Fees" },
          occurredAt: new Date(Date.now() + 2_000),
        },
      );
      expect((await find()).preview).toEqual({ direction: "INBOUND", text: "Fees" });
      await addMessage(
        t.db,
        { org: g.w.org, account: g.w.account, conversation: x.s.student.conversation },
        {
          direction: "INBOUND",
          type: "BUTTON",
          body: "Yes, I am interested",
          content: { payload: "CAMPAIGN_4471_YES", text: "Yes, I am interested" },
          occurredAt: new Date(Date.now() + 3_000),
        },
      );
      const last = await find();
      expect(last.preview).toEqual({ direction: "INBOUND", text: "Yes, I am interested" });
      expect(JSON.stringify(last)).not.toContain("CAMPAIGN_4471");
    });

    it("a bot message is not customer activity: it adds no unread count", async () => {
      const g = await dispatchWorld(t, { lastInboundAt: new Date() });
      const x = await bot(listMessage(), g);
      const item = (await listConversations(g.w.staff.ctx, { limit: 50 }, db())).items.find(
        (i) => i.id === x.s.student.conversation.id,
      )!;
      // the only unseen message is the student's seeded inbound one; the outbound bot message never counts
      expect(item.unreadCount).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------------ isolation and leakage

  describe("organization isolation and no leakage", () => {
    it("another organization never sees this one's bot messages, in a timeline or a list, and asking for them is a 404", async () => {
      const a = await dispatchWorld(t, { lastInboundAt: new Date() });
      const b = await dispatchWorld(t, { lastInboundAt: new Date() });
      const secret = `ORG-A-SECRET-${randomUUID()}`;
      const xa = await bot(buttonsMessage(secret), a);
      const xb = await bot(buttonsMessage("Only for organization B"), b);
      await expect(
        listMessages(b.w.staff.ctx, xa.s.student.conversation.id, { limit: 50 }, db()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        listMessages(a.w.staff.ctx, xb.s.student.conversation.id, { limit: 50 }, db()),
      ).rejects.toBeInstanceOf(NotFoundError);
      const listB = JSON.stringify(await listConversations(b.w.staff.ctx, { limit: 50 }, db()));
      const listA = JSON.stringify(await listConversations(a.w.staff.ctx, { limit: 50 }, db()));
      expect(listB).not.toContain(secret);
      expect(listA).not.toContain("Only for organization B");
      expect(listA).toContain(secret);
    });

    it("no identifier, token, key or raw payload reaches the staff API output", async () => {
      const g = await dispatchWorld(t, { lastInboundAt: new Date() });
      const x = await bot(buttonsMessage("Choose a topic"), g);
      const y = await bot(listMessage("Pick a class"), g);
      for (const m of [x, y]) {
        await accept(m, "DELIVERED");
        await addMessage(
          t.db,
          { org: g.w.org, account: g.w.account, conversation: m.s.student.conversation },
          {
            direction: "INBOUND",
            type: "INTERACTIVE",
            body: "Fees",
            content: { subtype: "button_reply", id: idsOf(m.message)[0], title: "Fees" },
            occurredAt: new Date(Date.now() + 1_000),
            replyToMessageId: m.messageId,
          },
        );
      }
      const output = JSON.stringify([
        await timeline(x),
        await timeline(y),
        await listConversations(g.w.staff.ctx, { limit: 50 }, db()),
      ]);
      const secrets = [
        ...idsOf(x.message),
        ...idsOf(y.message),
        ...idsOf(x.message).map((id) => id.split(".")[1]!), // the prompt tokens
        ...idsOf(y.message).map((id) => id.split(".")[1]!),
        "b1.",
        x.s.id,
        y.s.id, // bot session ids
        x.requestId,
        y.requestId, // outbound request ids
        g.d.bot.id,
        g.d.version.id,
        g.d.deployment.id,
        `bot-${x.s.id}-1`, // the derived idempotency key
        g.w.org.id,
        g.w.staff.membershipId,
        g.w.admin.membershipId,
        '"sections"',
        '"buttons"',
        '"kind"',
        "Reply to continue", // the footer is not displayed
        "Tap Menu",
        "Tuesday evening", // a row description is not displayed
      ];
      for (const secret of secrets) expect(output, secret).not.toContain(secret);
    });
  });

  // ------------------------------------------------------------------------------------------- malformed stored data

  describe("malformed stored content is shown safely", () => {
    const stored = async (
      type: "INTERACTIVE" | "BUTTON",
      body: string | null,
      content: unknown,
      direction: "OUTBOUND" | "INBOUND" = "OUTBOUND",
    ) => {
      const g = await dispatchWorld(t, { lastInboundAt: new Date() });
      const s = await liveSessionFor(t, g, await windowStudent(t, g.w, new Date()));
      const m = await addMessage(
        t.db,
        { org: g.w.org, account: g.w.account, conversation: s.student.conversation },
        { direction, type, body, content, occurredAt: new Date(Date.now() + 1_000) },
      );
      const row = (await timeline({ fx: g, s })).find((r) => r.id === m.id)!;
      const preview = (await listConversations(g.w.staff.ctx, { limit: 50 }, db())).items.find(
        (i) => i.id === s.student.conversation.id,
      )!.preview;
      return { row, preview };
    };

    it.each([
      ["a string", "oops"],
      ["an array", ["a"]],
      ["a number", 42],
      ["null", null],
      ["interactive: a string", { interactive: "oops" }],
      ["interactive: {}", { interactive: {} }],
      ["buttons that are not a list", { interactive: { buttons: "x" } }],
      ["junk inside sections", { interactive: { sections: [null, 5, { rows: "x" }] } }],
    ])("content that is %s: no error, the body is shown, no raw JSON", async (_n, content) => {
      const { row, preview } = await stored("INTERACTIVE", "Hello there", content);
      expect(row.text).toBe("Hello there");
      expect(JSON.stringify(row)).not.toMatch(/oops|"sections"|"buttons"|"interactive"/);
      expect(preview).toEqual({ direction: "OUTBOUND", text: "Hello there" });
    });

    it("titles with control characters, bidirectional overrides or excessive length are cleaned and cut", async () => {
      // BEL (not NUL: jsonb cannot store U+0000), a bidirectional override and a zero-width space
      const dirty = `A${String.fromCharCode(7, 0x202e, 0x200b)}B`;
      const { row } = await stored("INTERACTIVE", "Menu", {
        interactive: { buttons: [{ title: dirty }, { title: "T".repeat(80) }] },
      });
      expect(row.text).toBe(`Menu · AB / ${"T".repeat(24)}`);
    });

    // PINNED CURRENT BEHAVIOUR (reported, not changed): a stored outbound bot message with no body and unusable content is
    // labelled "Interactive reply", the wording for a CUSTOMER's reply, in the timeline placeholder and the list preview.
    // Unreachable through the approved queue function (a valid payload always has a non-empty body); reachable for a damaged row.
    it("pins: a body-less outbound bot message with unusable content carries the customer-reply label", async () => {
      const { row, preview } = await stored("INTERACTIVE", null, null);
      expect(row).toMatchObject({
        direction: "OUTBOUND",
        text: null,
        placeholder: "Interactive reply",
      });
      expect(row.delivery?.phase).toBe("NONE"); // no request row, so no delivery indicator is invented
      expect(preview).toEqual({ direction: "OUTBOUND", text: "Interactive reply" });
    });

    it("a stored button reply with only a payload shows no text and never the payload", async () => {
      const { row } = await stored("BUTTON", null, { payload: "CAMPAIGN_4471_YES" }, "INBOUND");
      expect(row).toMatchObject({ text: null, placeholder: "Button reply" });
      expect(JSON.stringify(row)).not.toContain("CAMPAIGN_4471");
    });
  });
});
