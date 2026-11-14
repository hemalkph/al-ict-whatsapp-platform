import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, seedAccount, type TestDb } from "@/db/__tests__/helpers";
import { faultyDatabase } from "@/db/__tests__/faulty-database";
import { lostCommitAck } from "@/db/__tests__/lost-commit-ack";
import { insertBotTriggerIfAdmitted, type BotTriggerInput } from "@/db/ops/bot-trigger";
import type { DbExecutor } from "@/db/ops/executor";
import { deferred, terminateThenResume, terminationWatch } from "../../bot-runtime/testing";
import {
  addStudent,
  barrierKit,
  botWorld,
  deployedBot,
  insertSession,
  updateSession,
  type BotWorld,
} from "../../bot-control/testing";
import { processWebhookBatch, type WebhookHandler } from "../queue/process";
import { buildWebhookWorkerHandlers } from "../worker/registry";
import { createInboundMessageHandler } from "./handler";
import { handleInboundMessage as preCaptureHandler } from "./__fixtures__/pre-08e2-handler";
import {
  deliver,
  deliveryBytes,
  ingestBytes,
  handlerContext,
  type DeliverOptions,
  type StoredEvent,
} from "./testing";

// E-CAP / E-CAPFAIL: real ingest, real inbound savepoints, real SQL and production guards on disposable PostgreSQL 17.
// The frozen 29913a7 handler is an independent oracle, not a second invocation of the newly edited implementation.
describe("dormant inbound bot-trigger capture", () => {
  let t: TestDb;
  let w: BotWorld;
  let deployment: Awaited<ReturnType<typeof deployedBot>>;
  let barriers: ReturnType<typeof barrierKit>;
  const logs: string[] = [];
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
  const enabled = () => buildWebhookWorkerHandlers({ BOTS_RUNTIME_ENABLED: "true" });
  const count = async (table: string) =>
    (await q(`select count(*)::int n from ${table}`)).rows[0].n as number;
  beforeAll(async () => {
    t = await createTestDatabase({
      sessionTimeouts: {
        lock_timeout: 10_000,
        statement_timeout: 15_000,
        idle_in_transaction_session_timeout: 20_000,
      },
    });
  });
  afterAll(async () => {
    if (t) await t.close();
  });
  beforeEach(async () => {
    logs.length = 0;
    for (const method of ["log", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation((line: unknown) => {
        logs.push(String(line));
      });
    await q("truncate organizations, webhook_requests cascade");
    w = await botWorld(t.db);
    // botWorld seeds a PENDING account; real inbound handlers require ACTIVE before ingest and processing.
    const account = await q(
      "update whatsapp_accounts set status='ACTIVE' where organization_id=$1 and id=$2 returning id,organization_id,status,archived_at",
      [w.org.id, w.account.id],
    );
    expect(account.rows).toEqual([
      { id: w.account.id, organization_id: w.org.id, status: "ACTIVE", archived_at: null },
    ]);
    deployment = await deployedBot(t.db, w);
    barriers = barrierKit(t);
  });
  afterEach(async () => {
    try {
      await barriers?.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
    await q("drop trigger if exists capture_fixture_fail on bot_triggers");
    expect(await count("outbound_requests")).toBe(0);
    expect(await count("bot_session_events")).toBe(0);
  });

  const input = (over: Partial<BotTriggerInput> = {}): BotTriggerInput => ({
    organizationId: w.org.id,
    whatsappAccountId: w.account.id,
    conversationId: w.student.conversation.id,
    messageId: w.student.message.id,
    messageType: "TEXT",
    inputOccurredAt: new Date("2026-10-20T10:00:00Z"),
    ...over,
  });
  const admitted = (value = input()) =>
    t.db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from conversations where organization_id = ${value.organizationId} and id = ${value.conversationId} for update`,
      );
      return insertBotTriggerIfAdmitted(tx, value);
    });
  async function incoming(o: DeliverOptions = {}, accountId = w.account.id): Promise<StoredEvent> {
    const account = (
      await q(
        "select organization_id,phone_number_id,waba_id,status,archived_at from whatsapp_accounts where id=$1",
        [accountId],
      )
    ).rows[0];
    expect(account).toMatchObject({
      organization_id: w.org.id,
      status: "ACTIVE",
      archived_at: null,
    });
    const event = await deliver(t.db, { ...o, pn: account.phone_number_id, waba: account.waba_id });
    expect(event).toMatchObject({ organizationId: w.org.id, whatsappAccountId: accountId });
    expect(
      (await q("select status,last_error from webhook_events where id=$1", [event.id])).rows,
    ).toEqual([{ status: "PENDING", last_error: null }]);
    return event;
  }
  const run = (event: StoredEvent, handler: WebhookHandler = enabled().MESSAGE!) =>
    t.db.transaction((tx) => handler(tx, { ...event, eventType: "MESSAGE" }, handlerContext()));
  const byEvent = async (event: StoredEvent) =>
    (await q("select * from messages where source_webhook_event_id=$1", [event.id])).rows[0];
  async function freshMessage(type = "TEXT", direction = "INBOUND") {
    const r = await q(
      `insert into messages (organization_id, whatsapp_account_id, conversation_id, direction, type, body, occurred_at)
      values ($1,$2,$3,$4,$5,'unmatched content',clock_timestamp()) returning id`,
      [w.org.id, w.account.id, w.student.conversation.id, direction, type],
    );
    return r.rows[0].id as string;
  }
  async function setDeployment(status: string) {
    await q(
      "update bot_deployments set status=$1, send_epoch=send_epoch + case when $1 in ('STOPPED','RETIRED') then 1 else 0 end where id=$2",
      [status, deployment.deployment.id],
    );
  }
  async function session(state: string, student = w.student) {
    const s = await insertSession(
      t.pool,
      {
        organizationId: w.org.id,
        whatsappAccountId: w.account.id,
        botId: deployment.bot.id,
        versionId: deployment.version.id,
        deploymentId: deployment.deployment.id,
        student,
      },
      {
        state: schema.BOT_LIVE_SESSION_STATES.includes(state as never)
          ? state
          : "WAITING_FOR_INPUT",
      },
    );
    if (state === "COMPLETED")
      await updateSession(t.pool, String(s.id), "state='COMPLETED',end_reason='flow_end'");
    if (state === "FAILED")
      await updateSession(t.pool, String(s.id), "state='FAILED',end_reason='error'");
    if (state === "HANDED_OVER")
      await updateSession(
        t.pool,
        String(s.id),
        "state='HANDED_OVER',end_reason='system_handover',handover_reason='staff_takeover'",
      );
    return s;
  }

  it.each(schema.MESSAGE_TYPES)("admission matrix: %s", async (messageType) => {
    const supported = ["TEXT", "INTERACTIVE", "BUTTON"].includes(messageType);
    const messageId = await freshMessage(messageType);
    expect(await admitted(input({ messageId, messageType }))).toEqual({
      inserted: supported,
      reason: supported ? "inserted" : "type",
    });
    expect(await count("bot_triggers")).toBe(supported ? 1 : 0);
  });

  it.each([
    {
      type: "TEXT",
      message: { type: "text", text: { body: "not a configured keyword" } },
      captured: true,
    },
    {
      type: "INTERACTIVE",
      message: {
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "arbitrary_id", title: "Yes" } },
      },
      captured: true,
    },
    {
      type: "BUTTON",
      message: { type: "button", button: { payload: "arbitrary_payload", text: "Yes" } },
      captured: true,
    },
    {
      type: "IMAGE",
      message: { type: "image", image: { id: "900000000000042", mime_type: "image/jpeg" } },
      captured: false,
    },
    {
      type: "REACTION",
      message: { type: "reaction", reaction: { message_id: "wamid.UNKNOWN", emoji: "👍" } },
      captured: false,
    },
    {
      type: "FLOW",
      message: {
        type: "interactive",
        interactive: { type: "nfm_reply", nfm_reply: { response_json: "{}" } },
      },
      captured: false,
    },
  ])("real inbound mapping: $type", async ({ type, message, captured }) => {
    const e = await incoming({ message });
    await run(e);
    const m = await byEvent(e);
    expect(m.type).toBe(type);
    const triggers = (await q("select * from bot_triggers where message_id=$1", [m.id])).rows;
    expect(triggers).toHaveLength(captured ? 1 : 0);
    if (type === "IMAGE") expect(await count("message_attachments")).toBe(1);
  });

  const matrix = schema.BOT_DEPLOYMENT_STATUSES.flatMap((status) =>
    ["none", ...schema.BOT_SESSION_STATES].map((state) => ({ status, state })),
  );
  it.each(matrix)("deployment $status / session $state", async ({ status, state }) => {
    if (state !== "none") await session(state);
    if (status !== "ACTIVE") await setDeployment(status);
    const yes =
      status === "ACTIVE" ||
      (status === "PAUSED" && schema.BOT_LIVE_SESSION_STATES.includes(state as never));
    expect(await admitted()).toEqual({ inserted: yes, reason: yes ? "inserted" : "no_deployment" });
    expect(await count("bot_triggers")).toBe(yes ? 1 : 0);
  });

  it("no deployment, or a live session in a different conversation, cannot admit", async () => {
    const other = await addStudent(t.db, w.org.id, w.account.id);
    await session("WAITING_FOR_INPUT", other);
    await setDeployment("PAUSED");
    expect(await admitted()).toEqual({ inserted: false, reason: "no_deployment" });
    await setDeployment("RETIRED");
    const account = await seedAccount(t.db, w.org.id);
    const student = await addStudent(t.db, w.org.id, account.id);
    expect(
      await admitted(
        input({
          whatsappAccountId: account.id,
          conversationId: student.conversation.id,
          messageId: student.message.id,
        }),
      ),
    ).toEqual({ inserted: false, reason: "no_deployment" });
  });

  it("19 pending admits the twentieth; 20 pending refuses the next and logs only safe capped context", async () => {
    for (let i = 0; i < 19; i++)
      expect((await admitted(input({ messageId: await freshMessage() }))).inserted).toBe(true);
    expect(await admitted()).toEqual({ inserted: true, reason: "inserted" });
    expect(await admitted(input({ messageId: await freshMessage() }))).toEqual({
      inserted: false,
      reason: "pending_cap",
    });
    expect(await count("bot_triggers")).toBe(20);
    // Drive the real registry on this same conversation to exercise its cap log without dropping the inbound message.
    const e = await incoming();
    await run(e);
    const m = await byEvent(e);
    // This new contact has its own conversation; its trigger is independently admissible.
    expect(
      (
        await q("select count(*)::int n from bot_triggers where conversation_id=$1", [
          m.conversation_id,
        ])
      ).rows[0].n,
    ).toBe(1);
    for (let i = 1; i < 20; i++) {
      const more = await incoming();
      await run(more);
    }
    const capped = await incoming({
      message: { type: "text", text: { body: "PRIVATE_CAP_TEXT" } },
    });
    await run(capped);
    expect(await byEvent(capped)).toBeDefined();
    expect(
      (
        await q("select count(*)::int n from bot_triggers where conversation_id=$1", [
          m.conversation_id,
        ])
      ).rows[0].n,
    ).toBe(20);
    const log = logs
      .map((line) => JSON.parse(line))
      .find((line) => line.bots_event === "bots.trigger_capped");
    expect(log).toMatchObject({
      reason: "pending_cap",
      count: 20,
      conversation_id: m.conversation_id,
    });
    expect(JSON.stringify(log)).not.toContain("PRIVATE_CAP_TEXT");
  });

  it.each(["PROCESSED", "IGNORED", "DEAD"])(
    "%s triggers do not consume the pending cap",
    async (status) => {
      for (let i = 0; i < 20; i++) {
        await q(
          `insert into bot_triggers (organization_id,whatsapp_account_id,conversation_id,message_id,input_occurred_at,observed_control_seq,status,processed_at,outcome_code)
        values ($1,$2,$3,$4,clock_timestamp(),0,$5,clock_timestamp(),'fixture_terminal')`,
          [w.org.id, w.account.id, w.student.conversation.id, await freshMessage(), status],
        );
      }
      expect(await admitted()).toEqual({ inserted: true, reason: "inserted" });
    },
  );

  it("the primitive's uniqueness backstop is a no-op, including concurrent duplicate callers under the row lock", async () => {
    const results = await Promise.all([admitted(), admitted()]);
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    expect(results.every((r) => r.reason === "inserted")).toBe(true);
    expect(await admitted()).toEqual({ inserted: false, reason: "inserted" });
    expect(await count("bot_triggers")).toBe(1);
  });

  it("real duplicate delivery and simultaneous handling preserve one message and trigger", async () => {
    const e = await incoming();
    const hold = await barriers.hold("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `wa-message:${w.org.id}:${w.account.id}:${e.providerObjectId}`,
    ]);
    const a = barriers.settle(run(e));
    const b = barriers.settle(run(e));
    await barriers.waitUntilBlocked(hold.pid);
    await hold.release();
    expect((await a).ok).toBe(true);
    expect((await b).ok).toBe(true);
    const account = (
      await q("select phone_number_id,waba_id from whatsapp_accounts where id=$1", [w.account.id])
    ).rows[0];
    const { bytes } = deliveryBytes({
      id: e.providerObjectId,
      pn: account.phone_number_id,
      waba: account.waba_id,
    });
    expect(await ingestBytes(t.db, bytes)).toEqual([]); // duplicate ingest returns no newly inserted event
    await run(e);
    const m = await byEvent(e);
    expect(
      (await q("select count(*)::int n from messages where wamid=$1", [e.providerObjectId])).rows[0]
        .n,
    ).toBe(1);
    expect((await q("select * from bot_triggers where message_id=$1", [m.id])).rows).toHaveLength(
      1,
    );
  });

  it("different concurrent messages at 19 pending serialize the cap using the inbound conversation row lock", async () => {
    const first = await incoming();
    await run(first);
    const m = await byEvent(first);
    for (let i = 1; i < 19; i++) {
      const e = await incoming();
      await run(e);
    }
    const a = await incoming();
    const b = await incoming();
    const hold = await barriers.hold("select id from conversations where id=$1 for update", [
      m.conversation_id,
    ]);
    const ra = barriers.settle(run(a));
    const rb = barriers.settle(run(b));
    await barriers.waitUntilBlocked(hold.pid);
    await hold.release();
    expect((await ra).ok).toBe(true);
    expect((await rb).ok).toBe(true);
    expect(
      (
        await q("select count(*)::int n from bot_triggers where conversation_id=$1", [
          m.conversation_id,
        ])
      ).rows[0].n,
    ).toBe(20);
    expect(await byEvent(a)).toBeDefined();
    expect(await byEvent(b)).toBeDefined();
  });

  it("worker rollback removes both the newly stored message and its trigger", async () => {
    const e = await incoming();
    const rollback = new Error("fixture rollback");
    await expect(
      t.db.transaction(async (tx) => {
        await enabled().MESSAGE!(tx, { ...e, eventType: "MESSAGE" }, handlerContext());
        const triggers = await tx.execute(sql`select id from bot_triggers`);
        expect(triggers.rows).toHaveLength(1);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await byEvent(e)).toBeUndefined();
    expect(await count("bot_triggers")).toBe(0);
  });

  it.each(["inside_insert", "after_insert"])(
    "capture SQL failure %s rolls back only the nested savepoint; message, attribution, activity, reopen and PROCESSED survive without repair on redelivery",
    async (phase) => {
      // S1 (08E-8D3): an EXISTING, RESOLVED conversation, so the outer savepoint performs its activity and reopen writes
      // before capture fails. The prior message uses the frozen pre-capture handler, so it leaves no trigger.
      const prior = await incoming({ timestamp: new Date(Date.now() - 120_000) });
      // through the real worker (so this event is not the one claimed below) with the frozen pre-capture handler (no trigger)
      expect(
        await processWebhookBatch(t.db, { handlers: { MESSAGE: preCaptureHandler }, batchSize: 1 }),
      ).toMatchObject({ processed: 1 });
      const conversationId = (await byEvent(prior)).conversation_id as string;
      await q(
        "update conversations set status='RESOLVED', resolved_at=clock_timestamp() - interval '90 seconds' where id=$1",
        [conversationId],
      );
      const before = (
        await q(
          "select last_inbound_at, last_message_at, control_seq from conversations where id=$1",
          [conversationId],
        )
      ).rows[0];
      const e = await incoming({
        timestamp: new Date(Date.now() - 30_000),
        message: {
          type: "text",
          text: { body: "PRIVATE_CAPTURE_TEXT" },
          referral: { source_type: "ad", source_id: "77", ctwa_clid: "CLID-CAPTURE" },
        },
      });
      if (phase === "inside_insert") {
        await q(`create or replace function capture_fixture_fail() returns trigger language plpgsql as $$
        begin raise exception 'PRIVATE_ERROR_DETAIL' using errcode='22012'; end $$`);
        await q(
          "create trigger capture_fixture_fail before insert on bot_triggers for each row execute function capture_fixture_fail()",
        );
      }
      const calls = vi.fn(async (sp: Parameters<WebhookHandler>[0], value: BotTriggerInput) => {
        expect((await insertBotTriggerIfAdmitted(sp, value)).inserted).toBe(true);
        await sp.execute(sql`select 1 / 0`);
      });
      const handler = createInboundMessageHandler({ captureBotTrigger: calls });
      const result = await processWebhookBatch(t.db, {
        handlers: { MESSAGE: handler },
        batchSize: 1,
      });
      expect(result).toMatchObject({ processed: 1, failed: 0 });
      const m = await byEvent(e);
      expect(m.body).toBe("PRIVATE_CAPTURE_TEXT");
      expect(m.conversation_id).toBe(conversationId);
      expect(await count("bot_triggers")).toBe(0);
      expect(await count("lead_attributions")).toBe(1);
      // the outer savepoint's writes survive: activity advanced to this message's effective time (a past provider time is
      // its own effective time), the RESOLVED conversation reopened, and no control sequence allocated (inbound activity is
      // not a staff control event; capture only READS control_seq, plan D.1)
      expect(new Date(m.occurred_at).getTime()).toBeGreaterThan(
        new Date(before.last_inbound_at).getTime(),
      );
      expect(
        (
          await q(
            "select status, resolved_at, last_inbound_at, last_message_at, control_seq from conversations where id=$1",
            [conversationId],
          )
        ).rows[0],
      ).toEqual({
        status: "OPEN",
        resolved_at: null,
        last_inbound_at: m.occurred_at,
        last_message_at: m.occurred_at,
        control_seq: before.control_seq,
      });
      expect(
        (await q("select status from webhook_events where id=$1", [e.id])).rows[0].status,
      ).toBe("PROCESSED");
      const failure = logs
        .map((line) => JSON.parse(line))
        .filter((line) => line.bots_event === "bots.trigger_capture_failed");
      expect(failure).toHaveLength(1);
      expect(failure[0]).toMatchObject({
        message_id: m.id,
        organization_id: w.org.id,
        whatsapp_account_id: w.account.id,
        conversation_id: m.conversation_id,
        reason: "pg_22012",
      });
      expect(JSON.stringify(failure)).not.toContain("PRIVATE_CAPTURE_TEXT");
      expect(JSON.stringify(failure)).not.toContain("PRIVATE_ERROR_DETAIL");
      await run(e, handler);
      await run(e); // restart with the normal capture dependency still cannot repair this historical omission
      expect(calls).toHaveBeenCalledTimes(1);
      expect(await count("bot_triggers")).toBe(0);
    },
  );

  it("a late message conflict rolls back provisional writes and never calls capture", async () => {
    const e = await incoming();
    const capture = vi.fn(async (sp: Parameters<WebhookHandler>[0], value: BotTriggerInput) => {
      await insertBotTriggerIfAdmitted(sp, value);
    });
    const contacts = await count("contacts");
    const conversations = await count("conversations");
    const hold = await barriers.hold("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `wa-identity:${w.org.id}:wa:15550100123`,
    ]);
    const pending = barriers.settle(
      run(e, createInboundMessageHandler({ captureBotTrigger: capture })),
    );
    try {
      // Identity resolution waits AFTER the duplicate read, without locking the external writer's FK targets.
      await barriers.waitUntilBlocked(hold.pid);
      // Insert the same logical message without taking its advisory lock, exercising the handler's late-conflict savepoint.
      await q(
        `insert into messages (organization_id,whatsapp_account_id,conversation_id,direction,type,body,occurred_at,wamid)
        values ($1,$2,$3,'INBOUND','TEXT','external writer',clock_timestamp(),$4)`,
        [w.org.id, w.account.id, w.student.conversation.id, e.providerObjectId],
      );
    } finally {
      await hold.release();
    }
    expect((await pending).ok).toBe(true);
    expect(await count("bot_triggers")).toBe(0);
    expect(capture).not.toHaveBeenCalled();
    expect(await count("contacts")).toBe(contacts);
    expect(await count("conversations")).toBe(conversations);
  });

  it("observes control_seq after activity/reopening; a new conversation starts at zero; provider time is capped only for effective input", async () => {
    const clock = (await q("select clock_timestamp() at")).rows[0].at as Date;
    const future = new Date(clock.getTime() + 3_600_000);
    const first = await incoming({ timestamp: future });
    await run(first);
    const m = await byEvent(first);
    const trigger = (await q("select * from bot_triggers where message_id=$1", [m.id])).rows[0];
    expect(trigger.observed_control_seq).toBe("0");
    expect(trigger.input_occurred_at).toEqual(new Date(first.receivedAt.getTime() + 300_000));
    expect(m.occurred_at).toEqual(new Date(Math.floor(future.getTime() / 1000) * 1000));
    expect(trigger.enqueued_at.getTime()).toBeGreaterThanOrEqual(clock.getTime());
    expect(trigger.enqueued_at.getTime()).toBeLessThanOrEqual(
      ((await q("select clock_timestamp() at")).rows[0].at as Date).getTime(),
    );
    await q("select allocate_conversation_control_seq($1,$2)", [w.org.id, m.conversation_id]);
    await q(
      "update conversations set status='RESOLVED',resolved_at=clock_timestamp()-interval '1 hour',last_message_at=clock_timestamp()-interval '2 hours',last_inbound_at=clock_timestamp()-interval '2 hours' where id=$1",
      [m.conversation_id],
    );
    const second = await incoming();
    const observed: number[] = [];
    await run(
      second,
      createInboundMessageHandler({
        captureBotTrigger: async (sp, value) => {
          const row = (
            await sp.execute<{ status: string; seq: string; last_inbound_at: string }>(
              sql`select status,control_seq::text seq,last_inbound_at from conversations where id=${value.conversationId}`,
            )
          ).rows[0]!;
          expect(row.status).toBe("OPEN");
          expect(new Date(row.last_inbound_at)).toEqual(value.inputOccurredAt);
          observed.push(Number(row.seq));
          await insertBotTriggerIfAdmitted(sp, value);
        },
      }),
    );
    const secondMessage = await byEvent(second);
    expect(observed).toEqual([1]);
    expect(
      (
        await q("select observed_control_seq from bot_triggers where message_id=$1", [
          secondMessage.id,
        ])
      ).rows[0].observed_control_seq,
    ).toBe("1");
  });

  it.each(["organizationId", "whatsappAccountId", "conversationId", "messageId"] as const)(
    "rejects a mismatched %s without writing a cross-tenant trigger",
    async (field) => {
      const other = await botWorld(t.db);
      const foreign = {
        organizationId: other.org.id,
        whatsappAccountId: other.account.id,
        conversationId: other.student.conversation.id,
        messageId: other.student.message.id,
      };
      expect(await admitted(input({ [field]: foreign[field] }))).toEqual({
        inserted: false,
        reason: "no_deployment",
      });
      expect(await count("bot_triggers")).toBe(0);
      expect(await admitted()).toEqual({ inserted: true, reason: "inserted" });
    },
  );

  it("another account/conversation's deployment and pending count cannot admit or cap this conversation", async () => {
    const account = await seedAccount(t.db, w.org.id);
    const student = await addStudent(t.db, w.org.id, account.id);
    expect(
      await admitted(
        input({
          whatsappAccountId: account.id,
          conversationId: student.conversation.id,
          messageId: student.message.id,
        }),
      ),
    ).toEqual({ inserted: false, reason: "no_deployment" });
    for (let i = 0; i < 20; i++) await admitted(input({ messageId: await freshMessage() }));
    const own = await addStudent(t.db, w.org.id, w.account.id);
    expect(
      await admitted(input({ conversationId: own.conversation.id, messageId: own.message.id })),
    ).toEqual({ inserted: true, reason: "inserted" });
  });

  it("an outbound message or forged supported message type cannot be captured", async () => {
    for (const value of [
      input({ messageId: await freshMessage("TEXT", "OUTBOUND") }),
      input({ messageId: await freshMessage("IMAGE"), messageType: "TEXT" }),
    ]) {
      expect(await admitted(value)).toEqual({ inserted: false, reason: "no_deployment" });
    }
    expect(await count("bot_triggers")).toBe(0);
  });

  it.each(["new", "existing_reopen_referral", "media_reply", "duplicate"])(
    "gate-off SQL equals the frozen pre-08E-2 handler: %s",
    async (branch) => {
      let parent: StoredEvent | undefined;
      if (branch !== "new") {
        parent = await incoming();
        await run(parent, preCaptureHandler);
        if (branch === "existing_reopen_referral") {
          const m = await byEvent(parent);
          await q(
            "update conversations set status='RESOLVED',resolved_at=clock_timestamp()-interval '1 hour' where id=$1",
            [m.conversation_id],
          );
        }
      }
      const e =
        branch === "duplicate"
          ? parent!
          : await incoming({
              message:
                branch === "media_reply"
                  ? {
                      type: "image",
                      image: { id: "900000000000042", mime_type: "image/jpeg" },
                      context: { id: parent!.providerObjectId },
                    }
                  : {
                      type: "text",
                      text: { body: "SQL_ORACLE" },
                      referral: { source_type: "ad", source_id: "77", ctwa_clid: "SQL-ORACLE" },
                    },
            });
      const trace = faultyDatabase(t);
      const rollback = new Error("oracle rollback");
      let stored: Record<string, unknown> | undefined;
      let handlerSql: string[] = [];
      async function statements(handler: WebhookHandler) {
        trace.statements.length = 0;
        stored = undefined;
        handlerSql = [];
        await expect(
          trace.db.transaction(async (tx) => {
            await handler(tx, { ...e, eventType: "MESSAGE" }, handlerContext());
            handlerSql = [...trace.statements]; // capture every handler statement before test-only observations
            stored = (
              await tx.execute(sql`select
              (select count(*)::int from contacts) contacts,
              (select count(*)::int from conversations) conversations,
              (select count(*)::int from messages) messages,
              (select count(*)::int from message_attachments) attachments,
              (select count(*)::int from lead_attributions) attributions,
              (select count(*)::int from bot_triggers) triggers`)
            ).rows[0];
            throw rollback;
          }),
        ).rejects.toBe(rollback);
        expect(trace.statements.at(-1)).toBe("rollback");
        return [...trace.statements];
      }
      try {
        const baseline = await statements(preCaptureHandler);
        const baselineStored = stored;
        expect(baselineStored).toEqual({
          contacts: 2,
          conversations: 2,
          messages: branch === "new" || branch === "duplicate" ? 2 : 3,
          attachments: branch === "media_reply" ? 1 : 0,
          attributions: branch === "new" || branch === "existing_reopen_referral" ? 1 : 0,
          triggers: 0,
        });
        for (const env of [
          {},
          { BOTS_RUNTIME_ENABLED: "false" },
          {
            BOTS_RUNTIME_ENABLED: "TRUE",
            WHATSAPP_OUTBOUND_ENABLED: "true",
            WHATSAPP_LIVE_SEND_ENABLED: "true",
          },
        ]) {
          const off = await statements(buildWebhookWorkerHandlers(env).MESSAGE!);
          expect(off).toEqual(baseline);
          expect(stored).toEqual(baselineStored);
          expect(handlerSql.join("\n")).not.toMatch(
            /bot_triggers|bot_deployments|bot_sessions|savepoint sp2/,
          );
        }
        // Mutation control: forcing capture on must invalidate the oracle for a new supported message.
        if (branch !== "duplicate")
          expect(await statements(enabled().MESSAGE!)).not.toEqual(baseline);
        // A single extra statement must fail equality even with capture OFF and identical stored results.
        const off = buildWebhookWorkerHandlers({}).MESSAGE!;
        const extraSql: WebhookHandler = async (tx, event, context) => {
          await tx.execute(sql`select 1`);
          await off(tx, event, context);
        };
        expect(await statements(extraSql)).not.toEqual(baseline);
        expect(stored).toEqual(baselineStored);
        expect(await count("bot_triggers")).toBe(0);
      } finally {
        await trace.close();
      }
    },
  );

  it.each(["PENDING", "DISABLED", "ARCHIVED", "MISSING"])(
    "gate-off account error and SQL equal the frozen handler: %s",
    async (state) => {
      const e = await incoming();
      if (state === "ARCHIVED")
        await q("update whatsapp_accounts set archived_at=clock_timestamp() where id=$1", [
          w.account.id,
        ]);
      else if (state !== "MISSING")
        await q("update whatsapp_accounts set status=$1 where id=$2", [state, w.account.id]);
      const event = {
        ...e,
        eventType: "MESSAGE" as const,
        whatsappAccountId: state === "MISSING" ? randomUUID() : e.whatsappAccountId,
      };
      const trace = faultyDatabase(t);
      async function refusal(handler: WebhookHandler) {
        trace.statements.length = 0;
        await expect(
          trace.db.transaction((tx) => handler(tx, event, handlerContext())),
        ).rejects.toThrow("account_not_active");
        return [...trace.statements];
      }
      try {
        const baseline = await refusal(preCaptureHandler);
        expect(baseline).toHaveLength(3); // BEGIN, account validation, ROLLBACK
        for (const env of [{}, { BOTS_RUNTIME_ENABLED: "false" }, { BOTS_RUNTIME_ENABLED: "TRUE" }])
          expect(await refusal(buildWebhookWorkerHandlers(env).MESSAGE!)).toEqual(baseline);
        expect(await byEvent(e)).toBeUndefined();
        expect(await count("bot_triggers")).toBe(0);
      } finally {
        await trace.close();
      }
    },
  );

  // ================================================================== 08E-8D3 C1-C3: real interruption of the capture path
  // D.1 atomicity (plan l.319), V3.2 H.4 (message and trigger roll back together), K.3 capture idempotency, O.11 (zero
  // duplicates across crashes). Connection loss is a REAL backend termination (pg_terminate_backend through terminationWatch)
  // while the server transaction is open, never a client-side rejection on a live connection. A lost acknowledgement is a REAL
  // COMMIT whose reply is then discarded (lostCommitAck). Durable state is always read on an independent connection.
  describe("08E-8D3: real connection loss and a lost COMMIT acknowledgement", () => {
    const one1 = { batchSize: 1, concurrency: 1 } as const;
    const eventRow = async (e: StoredEvent) =>
      (
        await q(
          "select status, attempts, last_error, locked_at, locked_by from webhook_events where id=$1",
          [e.id],
        )
      ).rows[0];
    const conversationJson = async (id: string) =>
      (await q("select to_jsonb(c) j from conversations c where id=$1", [id])).rows[0].j;
    const totals = async () => ({
      messages: await count("messages"),
      triggers: await count("bot_triggers"),
      attributions: await count("lead_attributions"),
      contacts: await count("contacts"),
      conversations: await count("conversations"),
      sessions: await count("bot_sessions"),
    });
    const captureFailures = () =>
      logs
        .map((line) => JSON.parse(line))
        .filter((line) => line.bots_event === "bots.trigger_capture_failed");
    const backendState = async (pid: number) =>
      (await q("select state from pg_stat_activity where pid=$1", [pid])).rows[0]?.state;

    /** An existing RESOLVED conversation (its first message captured), and a new delivery with a referral into it. */
    async function existingConversation() {
      const prior = await incoming({ timestamp: new Date(Date.now() - 120_000) });
      // through the real worker, so no earlier PENDING event can be claimed instead of the one under test
      expect(await processWebhookBatch(t.db, { handlers: enabled(), ...one1 })).toMatchObject({
        claimed: 1,
        processed: 1,
      });
      const conversationId = (await byEvent(prior)).conversation_id as string;
      await q(
        "update conversations set status='RESOLVED', resolved_at=clock_timestamp() - interval '90 seconds' where id=$1",
        [conversationId],
      );
      const e = await incoming({
        timestamp: new Date(Date.now() - 30_000),
        message: {
          type: "text",
          text: { body: "D3_CAPTURE_TEXT" },
          referral: { source_type: "ad", source_id: "77", ctwa_clid: "CLID-D3" },
        },
      });
      return {
        e,
        conversationId,
        conversation: await conversationJson(conversationId),
        totals: await totals(),
      };
    }

    /** Runs one real worker pass, terminates the backend once the pause is reached, and returns the pass summary. */
    async function terminatedPass(
      handler: WebhookHandler,
      pause: { reached: Promise<number>; release: () => void },
      whilePaused: (pid: number) => Promise<void>,
    ) {
      const watch = terminationWatch(t.pool);
      const pass = processWebhookBatch(t.db, { handlers: { MESSAGE: handler }, ...one1 });
      try {
        const pid = await Promise.race([
          pause.reached,
          pass.then(() => {
            throw new Error("the pass finished before reaching its pause");
          }),
        ]);
        await whilePaused(pid);
        await terminateThenResume(watch, pid, pause.release);
      } finally {
        pause.release();
      }
      const summary = await pass;
      await watch.verify();
      return summary;
    }

    /** Nothing of the interrupted transaction survives; the event is recoverably FAILED with its claim cleared. */
    async function expectRolledBack(x: Awaited<ReturnType<typeof existingConversation>>) {
      expect(await byEvent(x.e)).toBeUndefined();
      expect(await totals()).toEqual(x.totals);
      expect(await conversationJson(x.conversationId)).toEqual(x.conversation);
      const row = await eventRow(x.e);
      expect(row).toMatchObject({
        status: "FAILED",
        attempts: 1,
        locked_at: null,
        locked_by: null,
      });
      return row.last_error as string;
    }

    /** The legitimate retry stores exactly one message and one trigger; redelivery of the same message changes nothing. */
    async function expectRecoveredOnce(
      x: Awaited<ReturnType<typeof existingConversation>>,
      attempts: number,
    ) {
      const m = await byEvent(x.e);
      expect(m).toBeDefined();
      const triggers = (await q("select * from bot_triggers where message_id=$1", [m.id])).rows;
      const conv = (
        await q("select status, control_seq from conversations where id=$1", [x.conversationId])
      ).rows[0];
      expect(triggers).toHaveLength(1);
      expect(triggers[0]).toMatchObject({
        status: "PENDING",
        attempts: 0,
        conversation_id: x.conversationId,
        observed_control_seq: conv.control_seq,
      });
      expect(conv.status).toBe("OPEN");
      expect(await eventRow(x.e)).toEqual({
        status: "PROCESSED",
        attempts,
        last_error: null,
        locked_at: null,
        locked_by: null,
      });
      const expected = {
        ...x.totals,
        messages: x.totals.messages + 1,
        triggers: x.totals.triggers + 1,
        attributions: x.totals.attributions + 1,
      };
      expect(await totals()).toEqual(expected);
      // Meta redelivers the same message: ingest stores no new event, and handling it again is the duplicate no-op
      const account = (
        await q("select phone_number_id,waba_id from whatsapp_accounts where id=$1", [w.account.id])
      ).rows[0];
      const { bytes } = deliveryBytes({
        id: x.e.providerObjectId,
        pn: account.phone_number_id,
        waba: account.waba_id,
      });
      expect(await ingestBytes(t.db, bytes)).toEqual([]);
      await run(x.e);
      expect(await processWebhookBatch(t.db, { handlers: enabled(), ...one1 })).toMatchObject({
        claimed: 0,
      });
      expect(await totals()).toEqual(expected);
    }

    const makeDue = (e: StoredEvent) =>
      q(
        "update webhook_events set next_attempt_at = clock_timestamp() - interval '1 second' where id=$1 and status='FAILED'",
        [e.id],
      );

    it("C1: the backend is terminated INSIDE the nested capture savepoint: nothing commits, the event is retried, and the retry stores one message and one trigger", async () => {
      const x = await existingConversation();
      const reached = deferred<number>();
      const go = deferred();
      const capture = vi.fn(async (sp: Parameters<WebhookHandler>[0], value: BotTriggerInput) => {
        expect((await insertBotTriggerIfAdmitted(sp, value)).inserted).toBe(true);
        const r = await sp.execute<{ pid: number }>(sql`select pg_backend_pid() pid`);
        reached.resolve(r.rows[0]!.pid);
        await go.promise; // inside savepoint sp2: the trigger row is written, nothing is released or committed
      });
      const summary = await terminatedPass(
        createInboundMessageHandler({ captureBotTrigger: capture }),
        { reached: reached.promise, release: () => go.resolve() },
        async (pid) => {
          // the server transaction is genuinely open (not a client-side fault) and nothing is visible outside it
          expect(await backendState(pid)).toBe("idle in transaction");
          expect(await byEvent(x.e)).toBeUndefined();
          expect(await totals()).toEqual(x.totals);
        },
      );
      expect(capture).toHaveBeenCalledTimes(1);
      expect(summary).toMatchObject({ claimed: 1, processed: 0, failed: 1 });
      const lastError = await expectRolledBack(x);
      expect(lastError).toBe("unexpected_error"); // pinned observation: the dead client's error carries no SQLSTATE

      // 08E-8D3 G (pinned observation): the nested catch DOES log a capture failure, naming a message that never committed
      const failures = captureFailures();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        organization_id: w.org.id,
        conversation_id: x.conversationId,
        reason: "unexpected_error",
      });
      expect(
        (await q("select count(*)::int n from messages where id=$1", [failures[0].message_id]))
          .rows[0].n,
      ).toBe(0);

      await makeDue(x.e);
      expect(await processWebhookBatch(t.db, { handlers: enabled(), ...one1 })).toMatchObject({
        claimed: 1,
        processed: 1,
      });
      await expectRecoveredOnce(x, 2);
      expect(captureFailures()).toHaveLength(1); // the retry logs nothing further
    });

    it("C2: the backend is terminated after every handler write, before the worker's COMMIT: nothing commits and the retry is exact", async () => {
      const x = await existingConversation();
      const reached = deferred<number>();
      const go = deferred();
      const real = enabled().MESSAGE!;
      const afterWrites: WebhookHandler = async (tx, event, context) => {
        await real(tx, event, context);
        const inside = await tx.execute<{ messages: number; triggers: number }>(
          sql`select (select count(*)::int from messages) messages, (select count(*)::int from bot_triggers) triggers`,
        );
        // the writes exist inside the transaction (one message and its trigger) before it is killed
        expect(inside.rows[0]).toEqual({
          messages: x.totals.messages + 1,
          triggers: x.totals.triggers + 1,
        });
        const r = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`);
        reached.resolve(r.rows[0]!.pid);
        await go.promise; // the worker would now run its fenced PROCESSED update and COMMIT
      };
      const summary = await terminatedPass(
        afterWrites,
        { reached: reached.promise, release: () => go.resolve() },
        async (pid) => {
          expect(await backendState(pid)).toBe("idle in transaction");
          expect(await byEvent(x.e)).toBeUndefined();
          expect(await totals()).toEqual(x.totals);
        },
      );
      expect(summary).toMatchObject({ claimed: 1, processed: 0, failed: 1 });
      expect(await expectRolledBack(x)).toBe("unexpected_error");
      expect(captureFailures()).toHaveLength(0); // capture had succeeded: no capture failure is logged
      await makeDue(x.e);
      expect(await processWebhookBatch(t.db, { handlers: enabled(), ...one1 })).toMatchObject({
        claimed: 1,
        processed: 1,
      });
      await expectRecoveredOnce(x, 2);
    });

    it("C3: the worker's COMMIT really commits and its acknowledgement is lost: the fenced failure record changes nothing, nothing is retried or duplicated", async () => {
      const x = await existingConversation();
      const lost = lostCommitAck(t);
      let armedAt = -1;
      let observed: Record<string, unknown> | undefined;
      const real = enabled().MESSAGE!;
      const armed: WebhookHandler = async (tx, event, context) => {
        await real(tx, event, context);
        armedAt = lost.statements.length;
        // armed only now, so the faulted COMMIT is this worker transaction's (the claim is an autocommit statement)
        lost.arm(async () => {
          const m = await byEvent(x.e);
          observed = {
            message: m !== undefined,
            triggers: m
              ? (await q("select count(*)::int n from bot_triggers where message_id=$1", [m.id]))
                  .rows[0].n
              : 0,
            event: (await eventRow(x.e)).status,
          };
        });
      };
      let summary: Awaited<ReturnType<typeof processWebhookBatch>>;
      try {
        summary = await processWebhookBatch(lost.db as unknown as DbExecutor, {
          handlers: { MESSAGE: armed },
          ...one1,
        });
        expect(lost.injected).toBe(1);
        const after = lost.statements.slice(armedAt);
        const commits = after.flatMap((s, i) => (/^commit$/i.test(s) ? [i] : []));
        expect(commits).toHaveLength(1);
        // exactly the fenced PROCESSED update precedes the faulted COMMIT; no savepoint statement is involved
        expect(after.slice(0, commits[0])).toHaveLength(1);
        expect(after[0]).toMatch(/^update "webhook_events" set "status" = \$1/);
        expect(after.some((s) => /savepoint/i.test(s))).toBe(false);
      } finally {
        await lost.close();
      }
      // an independent connection saw the commit before the acknowledgement was discarded
      expect(observed).toEqual({ message: true, triggers: 1, event: "PROCESSED" });
      // the worker's fenced failure record matched no row (the event is no longer PROCESSING): the lease is "lost"
      expect(summary).toMatchObject({ claimed: 1, processed: 0, failed: 0, leaseLost: 1 });
      expect(captureFailures()).toHaveLength(0);
      await expectRecoveredOnce(x, 1);
    });
  });
});
