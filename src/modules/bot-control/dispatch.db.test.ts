import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerDatabase } from "@/db";
import { recordMessageStatus } from "@/db/ops/message-status";
import {
  CHECK_VIOLATION,
  UNIQUE_VIOLATION,
  createTestDatabase,
  expectPgError,
  type TestDb,
} from "@/db/__tests__/helpers";
import {
  claimNext,
  executeClaim,
  recoverStuck,
  type DispatchDeps,
} from "@/modules/messaging/dispatch";
import { enqueueAutomatedMessage } from "@/modules/messaging/enqueue";
import { IdempotencyConflictError, OutboundRefusedError } from "@/modules/messaging/errors";
import type { BotOutboundMessage } from "@/modules/messaging/interactive";
import { buildPayload } from "@/modules/messaging/meta-transport";
import { SERVICE_WINDOW_MS, SERVICE_WINDOW_SAFETY_MARGIN_MS } from "@/modules/messaging/policy";
import { submitOutboundMessage } from "@/modules/messaging/submit";
import { FakeTransport, ON, minutesAgo, textInput } from "@/modules/messaging/testing";
import {
  BOTS_ON,
  authorityOf,
  dispatchWorld,
  liveSessionFor,
  queueBotStep,
  textMessage,
  windowStudent,
  type DispatchFixture,
  type LiveSession,
  holdLeftoverQueued,
} from "./testing";

// BOT outbound dispatch on disposable al_ict_test_* PostgreSQL with a FAKE transport (Phase 08D, ADR 0020): two-stage
// authorization (claim, then the final pre-HTTP read with a fresh clock), lossless interactive payloads, the runtime gate,
// staff takeover holds, the BOT "never re-queued" rule, idempotent enqueue and the in-flight indexes, and the bounded
// acceptance-record retry. No test can reach Meta.

const T0 = new Date("2026-06-01T12:00:00Z");
const token = "AAAAAAAAAAAAAAAAAAAAAA";
const replyId = (key: string) => `b1.${token}.${key}`;

describe("BOT outbound dispatch", () => {
  let t: TestDb;
  let clock: Date;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await holdLeftoverQueued(t);
    clock = T0;
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.pool.query("drop trigger if exists test_record_fault on messages");
    await t.pool.query("drop function if exists test_record_fault()");
    await t.pool.query("drop sequence if exists test_record_faults");
    await t.pool.query("drop table if exists test_fault_config");
  });

  const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
  const deps = (transport: FakeTransport, over: Partial<DispatchDeps> = {}): DispatchDeps => ({
    db: t.db as never,
    transport,
    config: BOTS_ON,
    now: () => clock,
    random: () => 0.5,
    accountMinIntervalMs: 0,
    conversationMinIntervalMs: 0,
    ...over,
  });
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
  const row = async (id: string) =>
    (await q("select * from outbound_requests where id = $1", [id])).rows[0];
  const conversationOf = async (id: string) =>
    (await q("select to_jsonb(c) - 'control_seq' AS c from conversations c where id = $1", [id]))
      .rows[0].c;
  const waIdOf = async (contactId: string) =>
    (await q("select wa_id from contacts where id = $1", [contactId])).rows[0].wa_id as string;
  const messageOf = async (id: string) =>
    (await q("select * from messages where id = $1", [id])).rows[0];
  const accepted = (wamid = "wamid.TEST08D.0001") => ({
    kind: "accepted" as const,
    wamid,
    providerStatus: "accepted",
    httpStatus: 200,
  });

  /** A deployed bot, a live session, and one queued BOT request at step 1 (window open since 30 minutes before T0). */
  async function botRequest(
    o: {
      message?: BotOutboundMessage;
      lastInboundAt?: Date;
      terminal?: "COMPLETED" | "HANDED_OVER";
      before?: (f: DispatchFixture) => Promise<void>;
    } = {},
  ) {
    const f = await dispatchWorld(t, { lastInboundAt: o.lastInboundAt ?? minutesAgo(30, T0) });
    await o.before?.(f);
    const s = await liveSessionFor(t, f);
    const r = await queueBotStep(t, f, s, {
      stepSeq: 1,
      message: o.message ?? textMessage(),
      now: clock,
      ...(o.terminal ? { terminal: o.terminal } : {}),
    });
    return { f, s, r };
  }

  // ------------------------------------------------------------------------------------------------ the happy path
  describe("sending", () => {
    it("a BOT text request is claimed with every gate on and sent exactly once; the database allocated its control sequence", async () => {
      const { r } = await botRequest();
      const queued = await row(r.requestId);
      expect(queued).toMatchObject({
        origin: "BOT",
        state: "QUEUED",
        requested_by_membership_id: null,
        bot_step_seq: 1,
        bot_send_epoch: "1",
        message_type: "TEXT",
      });
      expect(Number(queued.control_seq)).toBeGreaterThan(0);
      expect(queued.dispatch_deadline.getTime() - T0.getTime()).toBe(120_000);
      const transport = new FakeTransport().next(accepted());
      const { claim } = await claimNext(deps(transport));
      expect(claim).toMatchObject({ requestId: r.requestId, origin: "BOT" });
      expect(await executeClaim(deps(transport), claim!)).toBe("accepted");
      expect(transport.calls).toHaveLength(1);
      expect(await row(r.requestId)).toMatchObject({ state: "ACCEPTED", attempt_count: 1 });
      expect((await messageOf(r.messageId)).wamid).toBe("wamid.TEST08D.0001");
    });

    const buttons: BotOutboundMessage = {
      kind: "buttons",
      body: "ඔබට උදව් අවශ්‍යද? / உங்களுக்கு உதவி வேண்டுமா? / Need help? 🙂",
      footer: "A/L ICT 🎓",
      buttons: [
        { id: replyId("yes"), title: "ඔව් ✅" },
        { id: replyId("no"), title: "இல்லை" },
        { id: replyId("later"), title: "Later" },
      ],
    };
    const list: BotOutboundMessage = {
      kind: "list",
      body: "Choose a class / வகுப்பைத் தேர்ந்தெடுக்கவும்",
      buttonLabel: "Classes",
      footer: "සිංහල / தமிழ் / English",
      rows: [
        { id: replyId("theory"), title: "Theory 📘", description: "Saturday 8 am / සෙනසුරාදා" },
        { id: replyId("revision"), title: "Revision" },
      ],
    };
    const golden = (m: BotOutboundMessage, to: string) =>
      m.kind === "buttons"
        ? {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "interactive",
            interactive: {
              type: "button",
              body: { text: m.body },
              footer: { text: m.footer },
              action: {
                buttons: m.buttons.map((b) => ({
                  type: "reply",
                  reply: { id: b.id, title: b.title },
                })),
              },
            },
          }
        : m.kind === "list"
          ? {
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to,
              type: "interactive",
              interactive: {
                type: "list",
                body: { text: m.body },
                footer: { text: m.footer },
                action: {
                  button: m.buttonLabel,
                  sections: [{ title: m.buttonLabel, rows: m.rows }],
                },
              },
            }
          : null;

    for (const m of [buttons, list])
      it(`${m.kind}: enqueue → persistence → claim → reconstruction → fake transport is lossless (multilingual and emoji)`, async () => {
        const { f, r } = await botRequest({ message: m });
        const req = await row(r.requestId);
        const msg = await messageOf(r.messageId);
        expect(req.message_type).toBe("INTERACTIVE");
        expect(msg).toMatchObject({
          type: "INTERACTIVE",
          direction: "OUTBOUND",
          body: (m as { body: string }).body,
        });
        expect(msg.content).toEqual({ interactive: req.payload });
        const transport = new FakeTransport().next(accepted());
        const { claim } = await claimNext(deps(transport));
        expect(await executeClaim(deps(transport), claim!)).toBe("accepted");
        expect(transport.calls).toHaveLength(1);
        expect(buildPayload(transport.calls[0]!, false)).toEqual(
          golden(m, await waIdOf(f.w.student.contact.id)),
        );
      });

    it("reconstruction with a NEW database pool (a restarted worker) sends exactly what was stored", async () => {
      const { f, r } = await botRequest({ message: list });
      const worker = createWorkerDatabase(t.url, {
        maxConnections: 2,
        applicationName: "test-08d-restart",
        onPoolError: () => undefined,
      });
      try {
        const transport = new FakeTransport().next(accepted());
        const restarted = deps(transport, { db: worker.db as never });
        const { claim } = await claimNext(restarted);
        expect(claim?.requestId).toBe(r.requestId);
        expect(await executeClaim(restarted, claim!)).toBe("accepted");
        expect(buildPayload(transport.calls[0]!, false)).toEqual(
          golden(list, await waIdOf(f.w.student.contact.id)),
        );
      } finally {
        await worker.close();
      }
    });

    it("a worker that dies after the claim: recovery marks it UNKNOWN_OUTCOME and it is never sent", async () => {
      const { r } = await botRequest({ message: buttons });
      const transport = new FakeTransport();
      const { claim } = await claimNext(deps(transport));
      expect(claim).not.toBeNull();
      advance(6 * 60_000);
      expect(await recoverStuck(deps(transport))).toBe(1);
      expect(await row(r.requestId)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "process_died_after_dispatch_start",
      });
      expect((await claimNext(deps(transport))).claim).toBeNull();
      expect(transport.calls).toHaveLength(0);
    });

    it("a malformed stored interactive payload (inserted directly) is HELD payload_invalid at claim and never sent", async () => {
      const f = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
      const s = await liveSessionFor(t, f);
      await q(
        "update bot_sessions set state = 'WAITING_FOR_SEND', step_seq = 1, revision = revision + 1 where id = $1",
        [s.id],
      );
      const message = (
        await q(
          "insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at) values ($1,$2,$3,'OUTBOUND','INTERACTIVE','b',$4) returning id",
          [f.w.org.id, s.student.conversation.id, f.w.account.id, T0],
        )
      ).rows[0].id;
      const malformed = { v: 1, kind: "buttons", body: "b", buttons: [] }; // no button: not a valid payload
      const id = (
        await q(
          `insert into outbound_requests (organization_id, whatsapp_account_id, conversation_id, message_id, origin, bot_session_id,
             bot_step_seq, bot_send_epoch, idempotency_key, request_fingerprint, message_type, recipient_kind, recipient_id, payload,
             state, next_attempt_at, dispatch_deadline)
           values ($1,$2,$3,$4,'BOT',$5,1,1,$6, repeat('a',64),'INTERACTIVE','PHONE',$7,$8,'QUEUED',$9,$10) returning id`,
          [
            f.w.org.id,
            f.w.account.id,
            s.student.conversation.id,
            message,
            s.id,
            `bot-${s.id}-1`,
            await waIdOf(s.student.contact.id),
            JSON.stringify(malformed),
            T0,
            new Date(T0.getTime() + 120_000),
          ],
        )
      ).rows[0].id;
      const transport = new FakeTransport();
      expect(await claimNext(deps(transport))).toMatchObject({ claim: null, held: 1 });
      expect(await row(id)).toMatchObject({ state: "HELD", hold_reason: "payload_invalid" });
      expect(transport.calls).toHaveLength(0);
    });

    it("limits are enforced at enqueue: the maximum is stored, one above is refused and nothing is written", async () => {
      const max = await botRequest({
        message: {
          kind: "buttons",
          body: "x".repeat(1024),
          buttons: [{ id: replyId("a"), title: "y".repeat(20) }],
        },
      });
      expect((await row(max.r.requestId)).state).toBe("QUEUED");
      const f = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
      const s = await liveSessionFor(t, f);
      for (const message of [
        { kind: "buttons", body: "x".repeat(1025), buttons: [{ id: replyId("a"), title: "t" }] },
        { kind: "buttons", body: "b", buttons: [{ id: replyId("a"), title: "y".repeat(21) }] },
        {
          kind: "buttons",
          body: "b",
          buttons: ["a", "b", "c", "d"].map((k) => ({ id: replyId(k), title: k })),
        },
        {
          kind: "list",
          body: "b",
          buttonLabel: "L",
          rows: Array.from({ length: 11 }, (_, i) => ({ id: replyId(`r${i}`), title: "t" })),
        },
      ] as BotOutboundMessage[])
        await expect(queueBotStep(t, f, s, { stepSeq: 1, message, now: clock })).rejects.toThrow(
          OutboundRefusedError,
        );
      expect(
        (await q("select count(*)::int n from outbound_requests where bot_session_id = $1", [s.id]))
          .rows[0],
      ).toEqual({ n: 0 });
    });
  });

  // ------------------------------------------------------------------------------------------------ gates
  describe("default-off gate", () => {
    it("with BOTS_RUNTIME_ENABLED off nothing can be enqueued and an existing BOT row is never claimed", async () => {
      const f = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
      const s = await liveSessionFor(t, f);
      await expect(
        queueBotStep(t, f, s, { stepSeq: 1, message: textMessage(), now: clock, config: ON }),
      ).rejects.toThrow(/bots_runtime_disabled/);
      const { r } = await botRequest();
      const transport = new FakeTransport();
      expect(await claimNext(deps(transport, { config: ON }))).toEqual({ claim: null, held: 0 });
      expect((await row(r.requestId)).state).toBe("QUEUED");
      expect(transport.calls).toHaveLength(0);
    });

    it("queued BOT rows never starve staff rows while the gate is off (25 BOT rows ahead of one staff row)", async () => {
      const f = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
      for (let i = 0; i < 25; i++) {
        const student = await windowStudent(t, f.w, minutesAgo(30, T0));
        const s = await liveSessionFor(t, f, student);
        await queueBotStep(t, f, s, { stepSeq: 1, message: textMessage(), now: minutesAgo(1, T0) });
      }
      const staff = await submitOutboundMessage(
        f.w.staff.ctx,
        textInput(f.w.student.conversation.id),
        { db: t.db as never, config: ON, now: () => clock },
      );
      const transport = new FakeTransport().next(accepted("wamid.STAFF.1"));
      const { claim } = await claimNext(deps(transport, { config: ON }));
      expect(claim).toMatchObject({ requestId: staff.requestId, origin: "STAFF" });
      expect(await executeClaim(deps(transport, { config: ON }), claim!)).toBe("accepted");
    });

    it("a gate switched off between claim and final authorization: SENDING -> HELD bots_runtime_disabled, no call", async () => {
      const { r } = await botRequest();
      const transport = new FakeTransport();
      const { claim } = await claimNext(deps(transport));
      expect(await executeClaim(deps(transport, { config: ON }), claim!)).toBe("held");
      expect(await row(r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "bots_runtime_disabled",
      });
      expect(transport.calls).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------------------ account eligibility
  describe("account eligibility is enforced, not bypassed", () => {
    it("an account that is not ACTIVE (PENDING, the schema default) refuses the enqueue with account_inactive; nothing is written", async () => {
      const f = await dispatchWorld(t, {
        lastInboundAt: minutesAgo(30, T0),
        accountStatus: "PENDING",
      });
      const s = await liveSessionFor(t, f);
      await expect(
        queueBotStep(t, f, s, { stepSeq: 1, message: textMessage(), now: clock }),
      ).rejects.toThrow(/account_inactive/);
      expect(
        (await q("select count(*)::int n from outbound_requests where bot_session_id = $1", [s.id]))
          .rows[0],
      ).toEqual({ n: 0 });
    });

    it("an account disabled after the enqueue: the claim holds the request account_inactive; disabled after the claim: the final authorization holds it", async () => {
      const a = await botRequest();
      await q("update whatsapp_accounts set status = 'DISABLED' where id = $1", [a.f.w.account.id]);
      const transport = new FakeTransport();
      expect(await claimNext(deps(transport))).toMatchObject({ claim: null, held: 1 });
      expect(await row(a.r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "account_inactive",
      });
      const b = await botRequest();
      const { claim } = await claimNext(deps(transport));
      expect(claim?.requestId).toBe(b.r.requestId);
      await q("update whatsapp_accounts set status = 'DISABLED' where id = $1", [b.f.w.account.id]);
      expect(await executeClaim(deps(transport), claim!)).toBe("held");
      expect(await row(b.r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "account_inactive_before_dispatch",
      });
      expect(transport.calls).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------------------ claim-time bot rule
  describe("stage 1: the bot rule at claim (QUEUED -> HELD, no call)", () => {
    const staffEvent = (f: DispatchFixture, s: LiveSession, from: string, to: string) =>
      q(
        "insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_status, to_status) values ($1,$2,'STATUS',$3,$4,$5)",
        [f.w.org.id, s.student.conversation.id, f.w.admin.membershipId, from, to],
      );
    const cases: Array<[string, (x: { f: DispatchFixture; s: LiveSession }) => Promise<unknown>]> =
      [
        [
          "bot_epoch_superseded",
          ({ f }) =>
            q("update bot_deployments set send_epoch = send_epoch + 1 where id = $1", [
              f.d.deployment.id,
            ]),
        ],
        [
          "bot_stopped",
          ({ f }) =>
            q(
              "update bot_deployments set status = 'STOPPED', send_epoch = send_epoch + 1 where id = $1",
              [f.d.deployment.id],
            ),
        ],
        [
          "bot_deployment_inactive",
          ({ f }) =>
            q(
              "update bot_deployments set status = 'RETIRED', send_epoch = send_epoch + 1 where id = $1",
              [f.d.deployment.id],
            ),
        ],
        [
          "bot_archived",
          ({ f }) => q("update bots set archived_at = now() where id = $1", [f.d.bot.id]),
        ],
        [
          "bot_output_suppressed",
          ({ s }) =>
            q(
              "update bot_sessions set output_suppressed_at = now(), revision = revision + 1 where id = $1",
              [s.id],
            ),
        ],
        [
          "bot_step_superseded",
          ({ s }) =>
            q("update bot_sessions set step_seq = 2, revision = revision + 1 where id = $1", [
              s.id,
            ]),
        ],
        [
          "bot_session_ended",
          ({ s }) =>
            q(
              "update bot_sessions set state = 'COMPLETED', end_reason = 'idle_timeout', revision = revision + 1 where id = $1",
              [s.id],
            ),
        ],
        [
          "staff_took_over",
          ({ f, s }) =>
            submitOutboundMessage(f.w.staff.ctx, textInput(s.student.conversation.id), {
              db: t.db as never,
              config: ON,
              now: () => clock,
            }),
        ],
        [
          "staff_took_over",
          ({ f, s }) =>
            q(
              "insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_assignee_membership_id, to_assignee_membership_id) values ($1,$2,'ASSIGNMENT',$3,NULL,$4)",
              [
                f.w.org.id,
                s.student.conversation.id,
                f.w.admin.membershipId,
                f.w.staff.membershipId,
              ],
            ),
        ],
        ["staff_took_over", ({ f, s }) => staffEvent(f, s, "OPEN", "PENDING")],
        ["conversation_resolved", ({ f, s }) => staffEvent(f, s, "OPEN", "RESOLVED")],
      ];
    for (const [code, change] of cases)
      it(`${code} (${change.toString().slice(0, 60).replace(/\s+/g, " ")}…)`, async () => {
        const x = await botRequest();
        await change(x);
        const transport = new FakeTransport();
        // drain every candidate (a staff row queued by the change may be examined first); the BOT row is never claimed
        for (let i = 0; i < 5; i++) {
          const result = await claimNext(deps(transport));
          expect(result.claim?.requestId === x.r.requestId).toBe(false);
          if (!result.claim && result.held === 0) break;
        }
        expect(await row(x.r.requestId)).toMatchObject({ state: "HELD", hold_reason: code });
        expect(transport.calls).toHaveLength(0);
      });

    it("a staff event sequenced BEFORE the session start is not a takeover (control_seq, not time)", async () => {
      const x = await botRequest({
        before: async (f) => {
          await q(
            "insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_status, to_status) values ($1,$2,'STATUS',$3,'OPEN','PENDING')",
            [f.w.org.id, f.w.student.conversation.id, f.w.admin.membershipId],
          );
        },
      });
      const transport = new FakeTransport().next(accepted());
      const { claim } = await claimNext(deps(transport));
      expect(await executeClaim(deps(transport), claim!)).toBe("accepted");
      expect((await row(x.r.requestId)).state).toBe("ACCEPTED");
    });

    for (const terminal of ["COMPLETED", "HANDED_OVER"] as const)
      it(`the terminal notice of a ${terminal} session is the one request it may still send`, async () => {
        const x = await botRequest({ terminal });
        const transport = new FakeTransport().next(accepted());
        const { claim } = await claimNext(deps(transport));
        expect(await executeClaim(deps(transport), claim!)).toBe("accepted");
        expect((await row(x.r.requestId)).state).toBe("ACCEPTED");
      });
  });

  // ------------------------------------------------------------------------------------------------ final authorization
  describe("stage 2: the final authorization re-reads everything and uses a fresh clock (W1-W9)", () => {
    /** Window still open at T0 for 30 s (it closes at lastInbound + 24 h - 10 min). */
    const closingSoon = new Date(
      T0.getTime() - SERVICE_WINDOW_MS + SERVICE_WINDOW_SAFETY_MARGIN_MS + 30_000,
    );

    async function claimed(o: Parameters<typeof botRequest>[0] = {}) {
      const x = await botRequest(o);
      const transport = new FakeTransport().next(accepted());
      const { claim } = await claimNext(deps(transport));
      expect(claim, "the initial claim succeeds").toMatchObject({
        requestId: x.r.requestId,
        origin: "BOT",
      });
      const conversation = await conversationOf(x.s.student.conversation.id);
      return { ...x, transport, claim: claim!, conversation };
    }
    async function expectHeld(x: Awaited<ReturnType<typeof claimed>>, code: string) {
      expect(await executeClaim(deps(x.transport), x.claim)).toBe("held");
      expect(await row(x.r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: code,
        attempt_count: 1,
      });
      expect(x.transport.calls).toHaveLength(0);
      expect((await messageOf(x.r.messageId)).wamid).toBeNull();
      // no activity timestamp moved (only a staff control event's allocation may have changed control_seq)
      expect(await conversationOf(x.s.student.conversation.id)).toEqual(x.conversation);
    }

    it("W1: eligible at claim, the window closes 31 s later, the final check refuses: HELD window_closed", async () => {
      const x = await claimed({ lastInboundAt: closingSoon });
      advance(31_000);
      await expectHeld(x, "window_closed");
    });

    it("W2: the contact is archived after the claim: HELD contact_archived", async () => {
      const x = await claimed();
      await q("update contacts set archived_at = now() where id = $1", [x.s.student.contact.id]);
      await expectHeld(x, "contact_archived");
    });

    it("W3: a BSUID alias appears after the claim (BSUID sending off): HELD bsuid_send_unavailable", async () => {
      const x = await claimed();
      await q(
        "insert into contact_bsuids (organization_id, contact_id, bsuid, first_seen_at, last_seen_at) values ($1,$2,'IN.w3alias',now(),now())",
        [x.f.w.org.id, x.s.student.contact.id],
      );
      await expectHeld(x, "bsuid_send_unavailable");
    });

    it("W4: the contact's phone identity changes after the claim: HELD recipient_changed", async () => {
      const x = await claimed();
      await q("update contacts set wa_id = $2 where id = $1", [
        x.s.student.contact.id,
        `9477${Date.now()}`.slice(0, 13),
      ]);
      await expectHeld(x, "recipient_changed");
    });

    it("W5: two current aliases after the claim: HELD identity_ambiguous", async () => {
      const x = await claimed();
      for (const b of ["IN.w5a", "IN.w5b"])
        await q(
          "insert into contact_bsuids (organization_id, contact_id, bsuid, first_seen_at, last_seen_at) values ($1,$2,$3,now(),now())",
          [x.f.w.org.id, x.s.student.contact.id, b],
        );
      await expectHeld(x, "identity_ambiguous");
    });

    it("W6: a terminal notice whose window closes after the claim: HELD window_closed", async () => {
      const x = await claimed({ lastInboundAt: closingSoon, terminal: "COMPLETED" });
      advance(31_000);
      await expectHeld(x, "window_closed");
    });

    it("W7: a terminal notice whose recipient changes after the claim: HELD recipient_changed", async () => {
      const x = await claimed({ terminal: "HANDED_OVER" });
      await q("update contacts set wa_id = $2 where id = $1", [
        x.s.student.contact.id,
        `9478${Date.now()}`.slice(0, 13),
      ]);
      await expectHeld(x, "recipient_changed");
    });

    it("W8: nothing changes: sent once and ACCEPTED", async () => {
      const x = await claimed({ lastInboundAt: closingSoon });
      advance(10_000);
      expect(await executeClaim(deps(x.transport), x.claim)).toBe("accepted");
      expect(x.transport.calls).toHaveLength(1);
    });

    it("a staff reply or a Stop committed between claim and final read: SENDING -> HELD, no call", async () => {
      const a = await claimed();
      await submitOutboundMessage(a.f.w.staff.ctx, textInput(a.s.student.conversation.id), {
        db: t.db as never,
        config: ON,
        now: () => clock,
      });
      await expectHeld(a, "staff_took_over");
      await holdLeftoverQueued(t); // the staff reply of `a` is still QUEUED: it must not be the row the next claim takes
      const b = await claimed();
      await q("update bot_deployments set send_epoch = send_epoch + 1 where id = $1", [
        b.f.d.deployment.id,
      ]);
      await expectHeld(b, "bot_epoch_superseded");
    });

    it("W9: STAFF behaviour is unchanged — no window re-check at the final read, and a pre-HTTP refusal is re-queued", async () => {
      const f = await dispatchWorld(t, { lastInboundAt: closingSoon });
      const staff = (body: string) =>
        submitOutboundMessage(f.w.staff.ctx, textInput(f.w.student.conversation.id, body), {
          db: t.db as never,
          config: ON,
          now: () => clock,
        });
      const first = await staff("one");
      const transport = new FakeTransport().next(accepted("wamid.W9.1"));
      const c1 = (await claimNext(deps(transport, { config: ON }))).claim;
      expect(c1, "the initial claim succeeds").toMatchObject({
        requestId: first.requestId,
        origin: "STAFF",
      });
      advance(31_000); // the window has closed: a STAFF final read does not re-check it (unchanged behaviour)
      expect(await executeClaim(deps(transport, { config: ON }), c1!)).toBe("accepted");
      clock = T0;
      const second = await staff("two");
      const c2 = (await claimNext(deps(transport, { config: ON }))).claim;
      expect(c2?.requestId).toBe(second.requestId);
      await q("update whatsapp_accounts set status = 'DISABLED' where id = $1", [f.w.account.id]);
      expect(await executeClaim(deps(transport, { config: ON }), c2!)).toBe("retry_scheduled");
      expect(await row(second.requestId)).toMatchObject({ state: "QUEUED", claimed_by: null });
      expect(transport.calls).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------------------------ never re-queued
  describe("a BOT request is never re-queued after its claim", () => {
    it("a transport result proving nothing was sent makes it HELD, not QUEUED", async () => {
      const { r } = await botRequest();
      const transport = new FakeTransport().next({
        kind: "not_sent",
        reason: "credential_missing",
      });
      const { claim } = await claimNext(deps(transport));
      expect(await executeClaim(deps(transport), claim!)).toBe("held");
      expect(await row(r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "credential_missing",
      });
    });

    it("the database refuses BOT SENDING -> QUEUED and still allows it for STAFF", async () => {
      const { f, r } = await botRequest();
      await claimNext(deps(new FakeTransport()));
      await expectPgError(
        q(
          "update outbound_requests set state = 'QUEUED', claimed_by = null, claimed_at = null where id = $1",
          [r.requestId],
        ),
        CHECK_VIOLATION,
      );
      const staff = await submitOutboundMessage(
        f.w.staff.ctx,
        textInput(f.w.student.conversation.id),
        {
          db: t.db as never,
          config: ON,
          now: () => clock,
        },
      );
      await claimNext(deps(new FakeTransport(), { config: ON }));
      await q(
        "update outbound_requests set state = 'QUEUED', claimed_by = null, claimed_at = null where id = $1",
        [staff.requestId],
      );
      expect((await row(staff.requestId)).state).toBe("QUEUED");
    });
  });

  // ------------------------------------------------------------------------------------------------ enqueue idempotency
  describe("enqueue: idempotency and the in-flight indexes", () => {
    it("the same step and content replays; different content for the step conflicts; a second step in flight is refused", async () => {
      const { f, s, r } = await botRequest();
      const again = await queueBotStep(t, f, s, { stepSeq: 1, message: textMessage(), now: clock });
      expect(again).toEqual({ ...r, replayed: true });
      await expect(
        queueBotStep(t, f, s, { stepSeq: 1, message: textMessage("other"), now: clock }),
      ).rejects.toThrow(IdempotencyConflictError);
      await expectPgError(
        queueBotStep(t, f, s, { stepSeq: 2, message: textMessage(), now: clock }),
        UNIQUE_VIOLATION,
        "outbound_requests_bot_inflight_uidx",
      );
    });

    it("a new session cannot queue in a conversation while the previous session's terminal notice is in flight", async () => {
      const { f, s } = await botRequest({ terminal: "COMPLETED" });
      const next = await liveSessionFor(t, f, s.student);
      await expectPgError(
        queueBotStep(t, f, next, { stepSeq: 1, message: textMessage(), now: clock }),
        UNIQUE_VIOLATION,
        "outbound_requests_bot_conv_inflight_uidx",
      );
    });

    it("the authority is re-verified from the database: a wrong epoch, a stopped bot or a staff takeover refuses the enqueue", async () => {
      const f = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
      const s = await liveSessionFor(t, f);
      await expect(
        queueBotStep(t, f, s, { stepSeq: 1, message: textMessage(), now: clock, sendEpoch: 2 }),
      ).rejects.toThrow(/bot_epoch_superseded/);
      await submitOutboundMessage(f.w.staff.ctx, textInput(s.student.conversation.id), {
        db: t.db as never,
        config: ON,
        now: () => clock,
      });
      await expect(
        queueBotStep(t, f, s, { stepSeq: 1, message: textMessage(), now: clock }),
      ).rejects.toThrow(/staff_took_over/);
      // a forged authority for another organization's session finds nothing
      const other = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
      await expect(
        t.db.transaction((tx) =>
          enqueueAutomatedMessage(
            tx,
            { ...authorityOf(f, s), organizationId: other.w.org.id },
            { stepSeq: 1, message: textMessage() },
            { config: BOTS_ON, now: () => clock },
          ),
        ),
      ).rejects.toThrow(/bot_state_unreadable/);
    });
  });

  // ------------------------------------------------------------------------------------------------ acceptance retry
  describe("acceptance-record retry (RT1-RT6, RT8, RT9): database-only, bounded, fenced", () => {
    /** Raises `code` from inside the record transaction (on the message wamid update) the first `n` times. */
    async function injectRecordFault(code: string, n: number) {
      await q("create table test_fault_config (code text not null, n int not null)");
      await q("insert into test_fault_config values ($1, $2)", [code, n]);
      await q("create sequence test_record_faults");
      await q(`create function test_record_fault() returns trigger language plpgsql as $$
        declare c text; m int;
        begin
          select code, n into c, m from test_fault_config;
          if nextval('test_record_faults') <= m then
            if c = 'TERMINATE' then perform pg_terminate_backend(pg_backend_pid()); end if;
            raise exception 'injected record fault' using errcode = c;
          end if;
          return new;
        end $$`);
      await q(
        "create trigger test_record_fault before update of wamid on messages for each row when (new.wamid is not null) execute function test_record_fault()",
      );
    }
    async function run(o: {
      origin?: "BOT" | "STAFF";
      code: string;
      n: number;
      hook?: (attempt: number, outcome: string | null, requestId: string) => Promise<void>;
    }) {
      let requestId: string;
      let conversationId: string;
      if (o.origin === "STAFF") {
        const f = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
        requestId = (
          await submitOutboundMessage(f.w.staff.ctx, textInput(f.w.student.conversation.id), {
            db: t.db as never,
            config: ON,
            now: () => clock,
          })
        ).requestId;
        conversationId = f.w.student.conversation.id;
      } else {
        const x = await botRequest();
        requestId = x.r.requestId;
        conversationId = x.s.student.conversation.id;
      }
      await injectRecordFault(o.code, o.n);
      const attempts: Array<[number, string | null]> = [];
      const worker = createWorkerDatabase(t.url, {
        maxConnections: 3,
        applicationName: "test-08d-retry",
        onPoolError: () => undefined,
      });
      try {
        const transport = new FakeTransport().next(accepted("wamid.RETRY.1"));
        const d = deps(transport, {
          db: worker.db as never,
          config: o.origin === "STAFF" ? ON : BOTS_ON,
          onRecordAttempt: async (attempt, outcome) => {
            attempts.push([attempt, outcome]);
            await o.hook?.(attempt, outcome, requestId);
          },
        });
        const { claim } = await claimNext(d);
        const outcome = await executeClaim(d, claim!);
        return { outcome, attempts, transport, requestId, conversationId };
      } finally {
        await worker.close();
      }
    }

    it("RT1: one deadlock inside the transaction is retried once; ACCEPTED; one transport call", async () => {
      const r = await run({ code: "40P01", n: 1 });
      expect(r.attempts).toEqual([
        [1, "40P01"],
        [2, "ok"],
      ]);
      expect(r.outcome).toBe("accepted");
      expect(await row(r.requestId)).toMatchObject({ state: "ACCEPTED" });
      expect(r.transport.calls).toHaveLength(1);
    });

    it("RT2: two serialization failures are retried; the third transaction commits", async () => {
      const r = await run({ code: "40001", n: 2 });
      expect(r.attempts.map(([, o]) => o)).toEqual(["40001", "40001", "ok"]);
      expect(r.outcome).toBe("accepted");
      expect(r.transport.calls).toHaveLength(1);
    });

    it("RT3: three deadlocks exhaust the retries: UNKNOWN_OUTCOME accepted_but_not_recorded, never a fourth attempt", async () => {
      const r = await run({ code: "40P01", n: 5 });
      expect(r.attempts.map(([, o]) => o)).toEqual(["40P01", "40P01", "40P01"]);
      expect(r.outcome).toBe("unknown");
      expect(await row(r.requestId)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "accepted_but_not_recorded",
      });
      expect(r.transport.calls).toHaveLength(1);
    });

    it("RT4: the fence lost between attempts stops at once (no further attempt, state left as found)", async () => {
      const r = await run({
        code: "40P01",
        n: 1,
        hook: async (attempt, _outcome, requestId) => {
          if (attempt === 1)
            await q(
              "update outbound_requests set state = 'UNKNOWN_OUTCOME', failure_code = 'process_died_after_dispatch_start', finished_at = now() where id = $1",
              [requestId],
            );
        },
      });
      expect(r.attempts.map(([, o]) => o)).toEqual(["40P01", "fence_lost"]);
      expect(r.outcome).toBe("fence_lost");
      expect(await row(r.requestId)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "process_died_after_dispatch_start",
      });
      expect(r.transport.calls).toHaveLength(1);
    });

    it("RT5: a terminated connection is never retried; the fallback records UNKNOWN_OUTCOME", async () => {
      const r = await run({ code: "TERMINATE", n: 1 });
      expect(r.attempts).toHaveLength(1);
      expect(r.attempts[0]![1]).not.toBe("40P01");
      expect(r.attempts[0]![1]).not.toBe("40001");
      expect(r.outcome).toBe("unknown");
      expect(await row(r.requestId)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "accepted_but_not_recorded",
      });
      expect(r.transport.calls).toHaveLength(1);
    });

    it("RT6: any other SQLSTATE is not retried", async () => {
      const r = await run({ code: "23505", n: 1 });
      expect(r.attempts).toEqual([[1, "23505"]]);
      expect(r.outcome).toBe("unknown");
    });

    it("RT8: a retry never duplicates status reconciliation (an early status links exactly once)", async () => {
      const x = await botRequest();
      await t.db.transaction((tx) =>
        recordMessageStatus(tx, {
          organizationId: x.f.w.org.id,
          whatsappAccountId: x.f.w.account.id,
          wamid: "wamid.RT8.1",
          status: "DELIVERED",
          occurredAt: T0,
          webhookEventId: null,
        }),
      );
      const before = (await q("select count(*)::int n from message_status_events")).rows[0];
      await injectRecordFault("40P01", 1);
      const transport = new FakeTransport().next(accepted("wamid.RT8.1"));
      const attempts: string[] = [];
      const d = deps(transport, { onRecordAttempt: (_a, o) => void attempts.push(String(o)) });
      const { claim } = await claimNext(d);
      expect(await executeClaim(d, claim!)).toBe("accepted");
      expect(attempts).toEqual(["40P01", "ok"]);
      expect((await q("select count(*)::int n from message_status_events")).rows[0]).toEqual(
        before,
      );
      expect(
        (
          await q("select count(*)::int n from message_status_events where message_id = $1", [
            x.r.messageId,
          ])
        ).rows[0],
      ).toEqual({ n: 1 });
      expect((await messageOf(x.r.messageId)).latest_status).toBe("DELIVERED");
    });

    it("RT9: STAFF requests get the same bounded retry (RT1 and RT3)", async () => {
      const ok = await run({ origin: "STAFF", code: "40P01", n: 1 });
      expect(ok.attempts.map(([, o]) => o)).toEqual(["40P01", "ok"]);
      expect(ok.outcome).toBe("accepted");
      await t.pool.query("drop trigger if exists test_record_fault on messages");
      await t.pool.query("drop function if exists test_record_fault()");
      await t.pool.query("drop sequence if exists test_record_faults");
      await t.pool.query("drop table if exists test_fault_config");
      const exhausted = await run({ origin: "STAFF", code: "40P01", n: 5 });
      expect(exhausted.attempts).toHaveLength(3);
      expect(exhausted.outcome).toBe("unknown");
      expect(exhausted.transport.calls).toHaveLength(1);
    });
  });
});
