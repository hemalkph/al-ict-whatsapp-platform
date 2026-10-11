import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { recordMessageStatus } from "@/db/ops/message-status";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import {
  claimNext,
  dispatchBatch,
  executeClaim,
  recoverStuck,
  type DispatchDeps,
} from "./dispatch";
import { MAX_NOT_SENT_ATTEMPTS, SENDING_RECOVERY_AFTER_MS } from "./policy";
import { submitOutboundMessage } from "./submit";
import {
  FakeTransport,
  ON,
  addTemplate,
  minutesAgo,
  textInput,
  world,
  type WorldOptions,
} from "./testing";

// The dispatcher on real PostgreSQL with a FAKE transport (no network exists in these tests). The properties under test:
// a request is sent at most once unless it provably never left the process; every uncertain outcome is UNKNOWN_OUTCOME
// and stays that way; the window, consent, recipient and account are re-checked at dispatch; the wamid is recorded exactly,
// in one transaction with the status reconciliation, and never fabricated.

describe("outbound dispatch", () => {
  let t: TestDb;
  let clock: Date;
  const T0 = new Date("2026-06-01T12:00:00Z");
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());
  beforeEach(() => {
    clock = T0;
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.pool.query("drop trigger if exists test_fail_messages on messages");
    await t.pool.query("drop trigger if exists test_fail_requests on outbound_requests");
    await t.pool.query("drop function if exists test_fail()");
  });

  type W = Awaited<ReturnType<typeof world>>;
  const w = (o: WorldOptions = {}) => world(t.db, { lastInboundAt: minutesAgo(30, T0), ...o });
  const deps = (transport: FakeTransport, over: Partial<DispatchDeps> = {}): DispatchDeps => ({
    db: t.db as never,
    transport,
    config: ON,
    now: () => clock,
    random: () => 0.5,
    accountMinIntervalMs: 0,
    conversationMinIntervalMs: 0,
    ...over,
  });
  const queue = async (x: W, body = "Hello", key?: string) =>
    submitOutboundMessage(x.actor.ctx, textInput(x.conversation.id, body, key), {
      db: t.db as never,
      config: ON,
      now: () => clock,
    });
  const row = async (id: string) =>
    (await t.pool.query("select * from outbound_requests where id = $1", [id])).rows[0];
  const message = async (id: string) =>
    (await t.pool.query("select * from messages where id = $1", [id])).rows[0];
  const conversation = async (id: string) =>
    (await t.pool.query("select * from conversations where id = $1", [id])).rows[0];
  const run = (transport: FakeTransport, over: Partial<DispatchDeps> = {}) =>
    dispatchBatch(deps(transport, over), { batchSize: 10, concurrency: 1 });
  const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

  // ------------------------------------------------------------------------------------------- acceptance
  describe("accepted", () => {
    it("sends once, records Meta's id exactly, and moves only the outbound conversation timestamps", async () => {
      const x = await w({ lastInboundAt: minutesAgo(10, T0) });
      await t.db
        .update(schema.conversations)
        .set({ status: "RESOLVED", resolvedAt: minutesAgo(3, T0) })
        .where(eq(schema.conversations.id, x.conversation.id));
      const before = await conversation(x.conversation.id);
      const r = await queue(x, "Hello සිංහල");
      const transport = new FakeTransport().next({
        kind: "accepted",
        wamid: "wamid.HBgLEXACT==_1",
        providerStatus: "accepted",
        httpStatus: 200,
      });
      advance(5_000);
      const summary = await run(transport);
      expect(summary).toMatchObject({ claimed: 1, accepted: 1, unknown: 0, rejected: 0 });
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]).toEqual({
        phoneNumberId: x.account.phoneNumberId,
        credentialRef: "WA_TOKEN_TEST",
        recipient: { kind: "PHONE", id: x.contact.waId },
        message: { type: "text", body: "Hello සිංහල", replyToWamid: null },
      });
      expect(await row(r.requestId)).toMatchObject({
        state: "ACCEPTED",
        attempt_count: 1,
        provider_http_status: 200,
        provider_message_status: "accepted",
        claimed_by: expect.any(String),
      });
      expect((await message(r.messageId)).wamid).toBe("wamid.HBgLEXACT==_1");
      expect((await message(r.messageId)).latest_status).toBeNull(); // acceptance is not delivery
      const after = await conversation(x.conversation.id);
      expect(after.last_inbound_at).toEqual(before.last_inbound_at);
      expect(after.status).toBe("RESOLVED");
      expect(after.resolved_at).toEqual(before.resolved_at);
      expect(after.last_outbound_at).toEqual(clock);
      expect(after.last_message_at.getTime()).toBeGreaterThanOrEqual(
        before.last_message_at.getTime(),
      );
    });

    it("a reply sends the parent's wamid as context, and a template sends its name, language and parameters", async () => {
      const x = await w();
      const [parent] = await t.db
        .insert(schema.messages)
        .values({
          organizationId: x.org.id,
          conversationId: x.conversation.id,
          whatsappAccountId: x.account.id,
          direction: "INBOUND",
          type: "TEXT",
          occurredAt: T0,
          wamid: "wamid.PARENTXYZ",
        })
        .returning();
      await submitOutboundMessage(
        x.actor.ctx,
        {
          ...textInput(x.conversation.id, "re"),
          message: { type: "text", body: "re", replyToMessageId: parent!.id },
        },
        { db: t.db as never, config: ON, now: () => clock },
      );
      const template = await addTemplate(t.db, x, {
        name: "order_update",
        language: "si",
        params: 2,
      });
      await submitOutboundMessage(
        x.actor.ctx,
        {
          idempotencyKey: "tpl-key-000001",
          conversationId: x.conversation.id,
          message: { type: "template", templateId: template.id, parameters: ["Nimal", "Fri"] },
        },
        { db: t.db as never, config: ON, now: () => clock },
      );
      const transport = new FakeTransport().acceptAll();
      await run(transport);
      expect(transport.calls.map((c) => c.message)).toHaveLength(2);
      expect(transport.calls.map((c) => c.message)).toEqual(
        expect.arrayContaining([
          { type: "text", body: "re", replyToWamid: "wamid.PARENTXYZ" },
          {
            type: "template",
            name: "order_update",
            languageCode: "si",
            bodyParameters: ["Nimal", "Fri"],
          },
        ]),
      );
    });

    it("a request is dispatched exactly once however many times the dispatcher runs", async () => {
      const x = await w();
      await queue(x);
      const transport = new FakeTransport().acceptAll();
      for (let i = 0; i < 4; i++) {
        advance(60_000);
        await run(transport);
      }
      expect(transport.calls).toHaveLength(1);
    });
  });

  // ----------------------------------------------------------------------------------- status correlation
  describe("status reconciliation", () => {
    const record = (
      x: W,
      wamid: string,
      status: "SENT" | "DELIVERED" | "READ" | "FAILED",
      at: number,
      account = x.account.id,
      org = x.org.id,
    ) =>
      t.db.transaction((tx) =>
        recordMessageStatus(tx, {
          organizationId: org,
          whatsappAccountId: account,
          wamid,
          status,
          occurredAt: new Date(T0.getTime() + at * 1000),
          webhookEventId: null,
        }),
      );

    it("a status that arrives after acceptance links to the outbound message through the existing STATUS operation", async () => {
      const x = await w();
      const r = await queue(x);
      await run(
        new FakeTransport().next({
          kind: "accepted",
          wamid: "wamid.AFTER1",
          providerStatus: null,
          httpStatus: 200,
        }),
      );
      expect(await record(x, "wamid.AFTER1", "DELIVERED", 5)).toMatchObject({
        duplicate: false,
        messageId: r.messageId,
      });
      expect((await message(r.messageId)).latest_status).toBe("DELIVERED");
    });

    it("statuses stored BEFORE the response is persisted (several, out of order) are reconciled when the id is recorded", async () => {
      const x = await w();
      const r = await queue(x);
      const transport = new FakeTransport().next(async () => {
        // Meta's webhooks overtake our response: the STATUS handler stores them as orphans (message_id NULL)
        expect(await record(x, "wamid.EARLY1", "READ", 30)).toMatchObject({ messageId: null });
        await record(x, "wamid.EARLY1", "SENT", 1);
        await record(x, "wamid.EARLY1", "DELIVERED", 10);
        return {
          kind: "accepted",
          wamid: "wamid.EARLY1",
          providerStatus: "accepted",
          httpStatus: 200,
        };
      });
      await run(transport);
      const history = (
        await t.pool.query(
          "select status, message_id from message_status_events where wamid = 'wamid.EARLY1' order by occurred_at",
        )
      ).rows;
      expect(history.map((h) => h.status)).toEqual(["SENT", "DELIVERED", "READ"]);
      expect(history.every((h) => h.message_id === r.messageId)).toBe(true);
      const m = await message(r.messageId);
      expect(m.latest_status).toBe("READ"); // the highest-priority status wins; nothing regressed
    });

    it("a duplicate status webhook after acceptance adds nothing", async () => {
      const x = await w();
      await queue(x);
      await run(
        new FakeTransport().next({
          kind: "accepted",
          wamid: "wamid.DUP1",
          providerStatus: null,
          httpStatus: 200,
        }),
      );
      await record(x, "wamid.DUP1", "DELIVERED", 5);
      expect(await record(x, "wamid.DUP1", "DELIVERED", 5)).toMatchObject({ duplicate: true });
      expect(
        (await t.pool.query("select 1 from message_status_events where wamid = 'wamid.DUP1'"))
          .rowCount,
      ).toBe(1);
    });

    it("the same wamid on another WhatsApp account is never linked to this message", async () => {
      const x = await w();
      const other = await w();
      await record(other, "wamid.SHARED1", "READ", 5, other.account.id, other.org.id); // an orphan on someone else's account
      const r = await queue(x);
      await run(
        new FakeTransport().next({
          kind: "accepted",
          wamid: "wamid.SHARED1",
          providerStatus: null,
          httpStatus: 200,
        }),
      );
      expect((await message(r.messageId)).latest_status).toBeNull();
      const foreign = (
        await t.pool.query(
          "select message_id, whatsapp_account_id from message_status_events where wamid = 'wamid.SHARED1'",
        )
      ).rows;
      expect(foreign).toEqual([{ message_id: null, whatsapp_account_id: other.account.id }]);
    });

    it("a wamid that already belongs to an INBOUND message is never attached to the outbound one: the request becomes UNKNOWN_OUTCOME and nothing is fabricated", async () => {
      const x = await w();
      const [inbound] = await t.db
        .insert(schema.messages)
        .values({
          organizationId: x.org.id,
          conversationId: x.conversation.id,
          whatsappAccountId: x.account.id,
          direction: "INBOUND",
          type: "TEXT",
          occurredAt: T0,
          wamid: "wamid.CLASH1",
        })
        .returning();
      const r = await queue(x);
      await run(
        new FakeTransport().next({
          kind: "accepted",
          wamid: "wamid.CLASH1",
          providerStatus: null,
          httpStatus: 200,
        }),
      );
      expect(await row(r.requestId)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "accepted_but_not_recorded",
      });
      expect((await message(r.messageId)).wamid).toBeNull();
      expect((await message(inbound!.id)).latest_status).toBeNull();
    });

    it("if recording the id fails, the whole acceptance rolls back: no wamid, no status linking, no conversation change, UNKNOWN_OUTCOME", async () => {
      const x = await w();
      await record(x, "wamid.BOOM1", "DELIVERED", 5); // an orphan that must stay unlinked
      const r = await queue(x);
      const before = await conversation(x.conversation.id);
      await t.pool.query(
        `create function test_fail() returns trigger language plpgsql as $$ begin raise exception 'injected' using errcode = '23514'; end $$`,
      );
      await t.pool.query(
        "create trigger test_fail_messages before update on messages for each row when (NEW.wamid = 'wamid.BOOM1') execute function test_fail()",
      );
      await run(
        new FakeTransport().next({
          kind: "accepted",
          wamid: "wamid.BOOM1",
          providerStatus: null,
          httpStatus: 200,
        }),
      );
      expect(await row(r.requestId)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "accepted_but_not_recorded",
      });
      expect((await message(r.messageId)).wamid).toBeNull();
      expect(
        (
          await t.pool.query(
            "select message_id from message_status_events where wamid = 'wamid.BOOM1'",
          )
        ).rows[0].message_id,
      ).toBeNull();
      expect(await conversation(x.conversation.id)).toEqual(before);
    });
  });

  // --------------------------------------------------------------------------------------------- failures
  describe("conclusive rejection", () => {
    it("is final: recorded on the request and the message, and never retried", async () => {
      const x = await w();
      const r = await queue(x);
      const transport = new FakeTransport().next({
        kind: "rejected",
        reason: "recipient_unreachable",
        httpStatus: 400,
        providerErrorCode: "131026",
      });
      await run(transport);
      expect(await row(r.requestId)).toMatchObject({
        state: "REJECTED",
        failure_code: "recipient_unreachable",
        provider_error_code: "131026",
        provider_http_status: 400,
      });
      expect(await message(r.messageId)).toMatchObject({
        error_code: "131026",
        error_message: "recipient_unreachable",
        wamid: null,
      });
      advance(3_600_000);
      await run(transport);
      expect(transport.calls).toHaveLength(1);
    });
  });

  describe("Meta throttling answers are terminal; only provably-not-sent attempts are retried", () => {
    it("by default a throttled result is UNKNOWN_OUTCOME after ONE call: never queued, never repeated, even after a restart", async () => {
      const x = await w();
      const r = await queue(x);
      const transport = new FakeTransport();
      transport.fallback = {
        kind: "throttled",
        retryAfterMs: 1_000,
        httpStatus: 429,
        providerErrorCode: "130429",
      };
      await run(transport);
      expect(await row(r.requestId)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "rate_limited_semantics_unverified",
        provider_error_code: "130429",
        provider_http_status: 429,
        attempt_count: 1,
      });
      for (let i = 0; i < 3; i++) {
        advance(60 * 60_000);
        await run(transport, { newOwner: () => `restarted-${i}` });
      }
      expect(transport.calls).toHaveLength(1);
      expect((await row(r.requestId)).state).toBe("UNKNOWN_OUTCOME");
    });
  });

  // The throttle-retry machinery is kept (policy.ts THROTTLE_RETRY_VERIFIED) for the day Meta's contract is verified; these
  // tests switch it on explicitly through the test-only dependency to prove the preserved backoff and bounds still work.
  describe("preserved retry machinery (switched on only in tests)", () => {
    it("a rate limit is retried later, honouring Retry-After, with attempts counted", async () => {
      const x = await w();
      const r = await queue(x);
      const transport = new FakeTransport().next({
        kind: "throttled",
        retryAfterMs: 120_000,
        httpStatus: 429,
        providerErrorCode: "130429",
      });
      await run(transport, { throttleRetryVerified: true });
      const queued = await row(r.requestId);
      expect(queued).toMatchObject({
        state: "QUEUED",
        attempt_count: 1,
        claimed_by: null,
        provider_error_code: "130429",
      });
      expect(new Date(queued.next_attempt_at).getTime() - clock.getTime()).toBeGreaterThanOrEqual(
        120_000,
      );
      await run(transport, { throttleRetryVerified: true }); // not due yet
      expect(transport.calls).toHaveLength(1);
      advance(121_000);
      await run(transport.acceptAll(), { throttleRetryVerified: true });
      expect(transport.calls).toHaveLength(2);
      expect(await row(r.requestId)).toMatchObject({ state: "ACCEPTED", attempt_count: 2 });
    });

    it.each([
      [
        "throttled",
        {
          kind: "throttled",
          retryAfterMs: null,
          httpStatus: 429,
          providerErrorCode: "130429",
        } as const,
        "rate_limited_exhausted",
      ],
      [
        "not_sent",
        { kind: "not_sent", reason: "connect_failed_econnrefused" } as const,
        "send_failed_before_dispatch",
      ],
    ])(
      "%s forever: after the maximum number of attempts the request is HELD, not retried for ever",
      async (_n, result, hold) => {
        const x = await w();
        const r = await queue(x);
        const transport = new FakeTransport();
        transport.fallback = result;
        for (let i = 0; i < MAX_NOT_SENT_ATTEMPTS + 3; i++) {
          await run(transport, { throttleRetryVerified: true });
          // make the scheduled retry due again (the clock stays inside the deadline and the window)
          await t.pool.query(
            "update outbound_requests set next_attempt_at = $2 where id = $1 and state = 'QUEUED'",
            [r.requestId, new Date(clock.getTime() - 1000)],
          );
        }
        expect(await row(r.requestId)).toMatchObject({
          state: "HELD",
          hold_reason: hold,
          attempt_count: MAX_NOT_SENT_ATTEMPTS,
        });
        expect(transport.calls).toHaveLength(MAX_NOT_SENT_ATTEMPTS);
      },
    );
  });

  describe("uncertain outcomes", () => {
    it.each([
      [
        "a timeout after the request may have left",
        {
          kind: "unknown",
          reason: "transport_error_after_possible_send",
          httpStatus: null,
        } as const,
      ],
      [
        "a server error response",
        { kind: "unknown", reason: "provider_server_error", httpStatus: 503 } as const,
      ],
      [
        "a malformed success response (the message may exist)",
        { kind: "unknown", reason: "malformed_success_response", httpStatus: 200 } as const,
      ],
    ])("%s is UNKNOWN_OUTCOME and is never sent again", async (_n, result) => {
      const x = await w();
      const r = await queue(x);
      const transport = new FakeTransport().next(result);
      await run(transport);
      expect(await row(r.requestId)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: result.reason,
        provider_http_status: result.httpStatus,
      });
      expect((await message(r.messageId)).wamid).toBeNull(); // no wamid is guessed
      for (let i = 0; i < 3; i++) {
        advance(SENDING_RECOVERY_AFTER_MS * 3);
        await run(transport);
      }
      expect(transport.calls).toHaveLength(1);
    });

    it("a transport that throws is treated as UNKNOWN, not as 'not sent'", async () => {
      const x = await w();
      const r = await queue(x);
      const transport = new FakeTransport().next(new Error("socket hang up"));
      await run(transport);
      expect(await row(r.requestId)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "transport_threw",
      });
    });

    it("a lost response (the send happened, the answer never came) stays UNKNOWN_OUTCOME across restarts", async () => {
      const x = await w();
      const r = await queue(x);
      const transport = new FakeTransport().next({
        kind: "unknown",
        reason: "send_deadline",
        httpStatus: null,
      });
      await run(transport);
      for (let restart = 0; restart < 3; restart++) {
        advance(10 * SENDING_RECOVERY_AFTER_MS);
        await run(new FakeTransport().acceptAll()); // a brand-new dispatcher with a transport that would accept anything
      }
      expect(await row(r.requestId)).toMatchObject({ state: "UNKNOWN_OUTCOME" });
    });
  });

  // ---------------------------------------------------------------------------------------------- crashes
  describe("crashes", () => {
    it("a claim that fails to commit leaves the request QUEUED and sends nothing; the next run sends it once", async () => {
      const x = await w();
      const r = await queue(x);
      await t.pool.query(
        `create function test_fail() returns trigger language plpgsql as $$ begin raise exception 'crash' using errcode = '57P01'; end $$`,
      );
      await t.pool.query(
        "create trigger test_fail_requests before update on outbound_requests for each row when (NEW.state = 'SENDING') execute function test_fail()",
      );
      const transport = new FakeTransport().acceptAll();
      await expect(run(transport)).rejects.toThrow();
      expect(transport.calls).toHaveLength(0);
      expect(await row(r.requestId)).toMatchObject({
        state: "QUEUED",
        attempt_count: 0,
        send_started_at: null,
      });
      await t.pool.query("drop trigger test_fail_requests on outbound_requests");
      await run(transport);
      expect(transport.calls).toHaveLength(1);
      expect(await row(r.requestId)).toMatchObject({ state: "ACCEPTED" });
    });

    it("a crash right after the claim (before or during the HTTP call) leaves SENDING; recovery makes it UNKNOWN_OUTCOME and it is never sent", async () => {
      const x = await w();
      const r = await queue(x);
      const { claim } = await claimNext(deps(new FakeTransport()));
      expect(claim).not.toBeNull();
      expect(await row(r.requestId)).toMatchObject({ state: "SENDING", attempt_count: 1 });
      const transport = new FakeTransport().acceptAll();
      await run(transport); // a live worker meanwhile: the SENDING row is not its to touch yet
      expect(await row(r.requestId)).toMatchObject({ state: "SENDING" });
      advance(SENDING_RECOVERY_AFTER_MS + 1_000);
      expect(await recoverStuck(deps(transport))).toBe(1);
      expect(await row(r.requestId)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        failure_code: "process_died_after_dispatch_start",
      });
      await run(transport);
      expect(transport.calls).toHaveLength(0);
    });

    it("a crash after Meta answered but before the answer was stored: SENDING, then UNKNOWN_OUTCOME, no wamid, no resend", async () => {
      const x = await w();
      const r = await queue(x);
      await t.pool.query(
        `create function test_fail() returns trigger language plpgsql as $$ begin raise exception 'db down' using errcode = '57P01'; end $$`,
      );
      await t.pool.query(
        "create trigger test_fail_requests before update on outbound_requests for each row when (NEW.state in ('ACCEPTED', 'UNKNOWN_OUTCOME')) execute function test_fail()",
      );
      const transport = new FakeTransport().next({
        kind: "accepted",
        wamid: "wamid.LOSTWRITE",
        providerStatus: null,
        httpStatus: 200,
      });
      const summary = await run(transport);
      expect(summary.unknown).toBe(1);
      expect(await row(r.requestId)).toMatchObject({ state: "SENDING" }); // nothing could be written
      expect((await message(r.messageId)).wamid).toBeNull();
      await t.pool.query("drop trigger test_fail_requests on outbound_requests");
      advance(SENDING_RECOVERY_AFTER_MS + 1_000);
      await run(transport);
      expect(await row(r.requestId)).toMatchObject({ state: "UNKNOWN_OUTCOME" });
      expect(transport.calls).toHaveLength(1);
    });

    it("a stale claimer whose row was already declared UNKNOWN_OUTCOME cannot overwrite it (fence)", async () => {
      const x = await w();
      const r = await queue(x);
      const { claim } = await claimNext(deps(new FakeTransport()));
      advance(SENDING_RECOVERY_AFTER_MS + 1_000);
      await recoverStuck(deps(new FakeTransport()));
      const transport = new FakeTransport().next({
        kind: "accepted",
        wamid: "wamid.TOOLATE",
        providerStatus: null,
        httpStatus: 200,
      });
      expect(await executeClaim(deps(transport), claim!)).toBe("fence_lost");
      expect(await row(r.requestId)).toMatchObject({ state: "UNKNOWN_OUTCOME" });
      expect((await message(r.messageId)).wamid).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------------------- revalidation
  describe("re-validation at dispatch", () => {
    it("a free-form message whose window closes while it waits is HELD, not sent and not turned into a template", async () => {
      const x = await w({ lastInboundAt: new Date(T0.getTime() - (23 * 60 + 40) * 60_000) }); // window closes ~10 minutes from T0
      const r = await queue(x);
      await addTemplate(t.db, x);
      advance(11 * 60_000);
      const transport = new FakeTransport().acceptAll();
      expect(await run(transport)).toMatchObject({ claimed: 0, held: 1 });
      expect(await row(r.requestId)).toMatchObject({ state: "HELD", hold_reason: "window_closed" });
      expect(transport.calls).toHaveLength(0);
      expect((await message(r.messageId)).wamid).toBeNull();
      expect(
        (
          await t.pool.query("select 1 from outbound_requests where conversation_id = $1", [
            x.conversation.id,
          ])
        ).rowCount,
      ).toBe(1);
    });

    it("a request past its dispatch deadline is HELD (deadline_passed)", async () => {
      const x = await w();
      const r = await queue(x);
      advance(16 * 60_000);
      const transport = new FakeTransport().acceptAll();
      await run(transport);
      expect(await row(r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "deadline_passed",
      });
      expect(transport.calls).toHaveLength(0);
    });

    it.each([
      [
        "the account is disabled",
        async (x: W): Promise<void> =>
          void (await t.db
            .update(schema.whatsappAccounts)
            .set({ status: "DISABLED" })
            .where(eq(schema.whatsappAccounts.id, x.account.id))),
        "account_inactive",
      ],
      [
        "the account is archived",
        async (x: W): Promise<void> =>
          void (await t.db
            .update(schema.whatsappAccounts)
            .set({ archivedAt: T0 })
            .where(eq(schema.whatsappAccounts.id, x.account.id))),
        "account_inactive",
      ],
      [
        "the contact is archived",
        async (x: W): Promise<void> =>
          void (await t.db
            .update(schema.contacts)
            .set({ archivedAt: T0 })
            .where(eq(schema.contacts.id, x.contact.id))),
        "contact_archived",
      ],
      [
        "the contact's phone id changes",
        async (x: W): Promise<void> =>
          void (await t.db
            .update(schema.contacts)
            .set({ waId: "94779999999" })
            .where(eq(schema.contacts.id, x.contact.id))),
        "recipient_changed",
      ],
      [
        "the contact's phone id is removed",
        async (x: W): Promise<void> =>
          void (await t.db
            .update(schema.contacts)
            .set({ waId: null })
            .where(eq(schema.contacts.id, x.contact.id))),
        "no_identity",
      ],
    ] as const)("when %s while queued, nothing is sent (%s)", async (_n, change, code) => {
      const x = await w();
      const r = await queue(x);
      await change(x);
      const transport = new FakeTransport().acceptAll();
      await run(transport);
      expect(await row(r.requestId)).toMatchObject({ state: "HELD", hold_reason: code });
      expect(transport.calls).toHaveLength(0);
    });

    it("an alias rotation to a new BSUID after queuing holds a BSUID request (recipient_changed)", async () => {
      const x = await w({ waId: null, bsuids: [{ bsuid: "LK.First1" }] });
      const cfg = { ...ON, bsuidRecipientEnabled: true };
      const r = await submitOutboundMessage(x.actor.ctx, textInput(x.conversation.id), {
        db: t.db as never,
        config: cfg,
        now: () => clock,
      });
      await t.pool.query("update contact_bsuids set retired_at = now() where bsuid = 'LK.First1'");
      await t.db.insert(schema.contactBsuids).values({
        organizationId: x.org.id,
        contactId: x.contact.id,
        bsuid: "LK.Second2",
        firstSeenAt: T0,
        lastSeenAt: T0,
      });
      const transport = new FakeTransport().acceptAll();
      await run(transport, { config: cfg });
      expect(await row(r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "recipient_changed",
      });
      expect(transport.calls).toHaveLength(0);
    });

    it("a BSUID request is held if BSUID sending is switched off before dispatch", async () => {
      const x = await w({ waId: null, bsuids: [{ bsuid: "LK.Only111" }] });
      const r = await submitOutboundMessage(x.actor.ctx, textInput(x.conversation.id), {
        db: t.db as never,
        config: { ...ON, bsuidRecipientEnabled: true },
        now: () => clock,
      });
      const transport = new FakeTransport().acceptAll();
      await run(transport); // ON has bsuidRecipientEnabled false
      expect(await row(r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "bsuid_send_unavailable",
      });
      expect(transport.calls).toHaveLength(0);
    });

    it("a BSUID is sent exactly as stored when BSUID sending is on", async () => {
      const x = await w({ waId: null, bsuids: [{ bsuid: "US.13491208655302741918" }] });
      const cfg = { ...ON, bsuidRecipientEnabled: true };
      await submitOutboundMessage(x.actor.ctx, textInput(x.conversation.id), {
        db: t.db as never,
        config: cfg,
        now: () => clock,
      });
      const transport = new FakeTransport().acceptAll();
      await run(transport, { config: cfg });
      expect(transport.calls[0]!.recipient).toEqual({
        kind: "BSUID",
        id: "US.13491208655302741918",
      });
    });

    it("marketing consent withdrawn while queued, or the template disabled, stops the send", async () => {
      const x = await w({ consent: "GRANTED" });
      const marketing = await addTemplate(t.db, x, { category: "MARKETING" });
      const r1 = await submitOutboundMessage(
        x.actor.ctx,
        {
          idempotencyKey: "mkt-key-000001",
          conversationId: x.conversation.id,
          message: { type: "template", templateId: marketing.id, parameters: [] },
        },
        { db: t.db as never, config: ON, now: () => clock },
      );
      await t.db
        .update(schema.contacts)
        .set({ marketingConsentStatus: "WITHDRAWN" })
        .where(eq(schema.contacts.id, x.contact.id));
      const utility = await addTemplate(t.db, x, { category: "UTILITY" });
      const r2 = await submitOutboundMessage(
        x.actor.ctx,
        {
          idempotencyKey: "utl-key-000001",
          conversationId: x.conversation.id,
          message: { type: "template", templateId: utility.id, parameters: [] },
        },
        { db: t.db as never, config: ON, now: () => clock },
      );
      await t.db
        .update(schema.whatsappTemplates)
        .set({ status: "DISABLED" })
        .where(eq(schema.whatsappTemplates.id, utility.id));
      const transport = new FakeTransport().acceptAll();
      await run(transport);
      expect(await row(r1.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "marketing_consent_missing",
      });
      expect(await row(r2.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "template_not_approved",
      });
      expect(transport.calls).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------------- concurrency
  describe("concurrency", () => {
    it("two dispatchers racing for the same requests send each exactly once (repeated rounds)", async () => {
      const x = await w();
      for (let round = 0; round < 5; round++) {
        const ids = await Promise.all(
          Array.from({ length: 4 }, (_, i) =>
            queue(x, `m${round}-${i}`, `race-${round}-${i}-abcdef`),
          ),
        );
        const transport = new FakeTransport().acceptAll();
        await Promise.all([run(transport, {}), run(transport, {}), run(transport, {})]);
        expect(transport.calls, `round ${round}`).toHaveLength(4);
        for (const id of ids)
          expect(await row(id.requestId), `round ${round}`).toMatchObject({
            state: "ACCEPTED",
            attempt_count: 1,
          });
        const wamids = (
          await t.pool.query(
            "select wamid from messages where direction = 'OUTBOUND' and wamid is not null and conversation_id = $1",
            [x.conversation.id],
          )
        ).rows.map((r) => r.wamid);
        expect(new Set(wamids).size).toBe(wamids.length);
      }
    });

    it("two claims of the same request: only one obtains it", async () => {
      const x = await w();
      await queue(x);
      const claims = await Promise.all([
        claimNext(deps(new FakeTransport())),
        claimNext(deps(new FakeTransport())),
        claimNext(deps(new FakeTransport())),
      ]);
      expect(claims.filter((c) => c.claim !== null)).toHaveLength(1);
    });

    it("an account is paced: while one send is within the spacing interval the next stays QUEUED", async () => {
      const x = await w();
      const a = await queue(x, "one");
      const b = await queue(x, "two");
      const transport = new FakeTransport().acceptAll();
      const paced = { accountMinIntervalMs: 1_000, conversationMinIntervalMs: 1_000 };
      await run(transport, paced);
      expect(transport.calls).toHaveLength(1);
      expect([await row(a.requestId), await row(b.requestId)].map((r) => r.state).sort()).toEqual([
        "ACCEPTED",
        "QUEUED",
      ]);
      advance(1_500);
      await run(transport, paced);
      expect(transport.calls).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------------------------- gating
  describe("gates", () => {
    it("with outbound disabled the dispatcher claims nothing and never calls the transport", async () => {
      const x = await w();
      const r = await queue(x);
      const transport = new FakeTransport().acceptAll();
      const summary = await dispatchBatch(
        deps(transport, { config: { ...ON, outboundEnabled: false } }),
        {},
      );
      expect(summary.claimed).toBe(0);
      expect(transport.calls).toHaveLength(0);
      expect(await row(r.requestId)).toMatchObject({ state: "QUEUED", attempt_count: 0 });
    });

    it("once the stop signal is aborted nothing more is claimed", async () => {
      const x = await w();
      await queue(x);
      const controller = new AbortController();
      controller.abort();
      const transport = new FakeTransport().acceptAll();
      await dispatchBatch(deps(transport), { stopSignal: controller.signal });
      expect(transport.calls).toHaveLength(0);
    });

    it("tenant isolation: a dispatcher sends each request from ITS account with ITS credential only", async () => {
      const a = await w({ credentialRef: "TOKEN_ORG_A" });
      const b = await w({ credentialRef: "TOKEN_ORG_B" });
      await queue(a, "from a");
      await queue(b, "from b");
      const transport = new FakeTransport().acceptAll();
      await run(transport);
      const byBody = new Map(
        transport.calls.map((c) => [c.message.type === "text" ? c.message.body : "", c]),
      );
      expect(byBody.get("from a")).toMatchObject({
        phoneNumberId: a.account.phoneNumberId,
        credentialRef: "TOKEN_ORG_A",
        recipient: { id: a.contact.waId },
      });
      expect(byBody.get("from b")).toMatchObject({
        phoneNumberId: b.account.phoneNumberId,
        credentialRef: "TOKEN_ORG_B",
        recipient: { id: b.contact.waId },
      });
    });
  });
});
