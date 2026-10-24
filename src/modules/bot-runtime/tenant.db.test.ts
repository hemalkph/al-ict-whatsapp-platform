import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestDatabase,
  expectPgError,
  pgError,
  FK_VIOLATION,
  seedAccount,
  type TestDb,
} from "@/db/__tests__/helpers";
import { insertBotTriggerIfAdmitted } from "@/db/ops/bot-trigger";
import {
  deferTrigger,
  finishTrigger,
  recordTriggerFailure,
  wakeConversationTriggers,
  endConversationTriggers,
} from "@/db/ops/bot-trigger-queue";
import type { DbExecutor } from "@/db/ops/executor";
import { getOutboundRequest } from "@/modules/messaging";
import { enqueueAutomatedMessage } from "@/modules/messaging/enqueue";
import { claimNext, executeClaim } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { handleWebhookPost } from "@/modules/whatsapp/handler";
import { deliveryBytes } from "@/modules/whatsapp/inbound/testing";
import { processWebhookBatch } from "@/modules/whatsapp/queue/process";
import { TEST_APP_SECRET, webhookPost } from "@/modules/whatsapp/testing";
import { buildWebhookWorkerHandlers } from "@/modules/whatsapp/worker/registry";
import {
  EMERGENCY_STOP_PHRASE,
  emergencyStop,
  getBot,
  getVersion,
  listBots,
  listDeployments,
  listVersions,
  stopActiveSessions,
  suppressSessionQueuedRequests,
} from "../bot-control";
import { suppressQueuedBotRequests } from "../bot-control/suppression";
import {
  BOTS_ON,
  barrierKit,
  botWorld,
  insertSession,
  type SessionKeys,
} from "../bot-control/testing";
import { insertTrigger, runtimeKit, type RuntimeFx } from "./testing";
import { claimTriggers, terminalizeTrigger } from "./trigger-queue";
import { sweepOnce } from "./reconcile";

// E-TEN (Phase 08E-8C; plan N.2 `tenant.db.test.ts`): two ORGANIZATIONS, each with its own account, staff, student, conversation,
// bot, deployment, session and outbound request, on disposable PostgreSQL 17 with FakeTransport only. Every scenario drives a
// real production path and compares WHOLE-ROW snapshots of both organizations before and after: the organization an operation is
// not meant to touch must be byte-identical, and the one it is meant to touch must have changed exactly as expected. Malformed
// tenant bindings are thrown directly at PostgreSQL's composite foreign keys. Directions A->B and B->A are both exercised.

const TENANT_TABLES = [
  "bot_triggers",
  "bot_sessions",
  "bot_session_events",
  "bot_deployments",
  "bot_deployment_events",
  "outbound_requests",
  "conversations",
  "conversation_events",
  "messages",
  "contacts",
] as const;

describe("multi-tenant isolation of the bot runtime (E-TEN)", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  let k: ReturnType<typeof runtimeKit>;
  let A: RuntimeFx;
  let B: RuntimeFx;

  beforeAll(async () => {
    t = await createTestDatabase({
      sessionTimeouts: {
        lock_timeout: 15_000,
        statement_timeout: 20_000,
        idle_in_transaction_session_timeout: 25_000,
      },
    });
  });
  beforeEach(async () => {
    await t.pool.query("truncate organizations, webhook_requests cascade");
    kit = barrierKit(t);
    k = runtimeKit(t);
    A = await k.fixture();
    B = await k.fixture();
    expect(A.w.org.id).not.toBe(B.w.org.id);
    vi.stubEnv("META_APP_SECRET", TEST_APP_SECRET);
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    k.releaseAll();
    await kit.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await t?.close();
  });

  // ---------------------------------------------------------------------------------------------------- helpers

  /** Every row of every tenant-owned table of one organization, whole-row (jsonb), in a stable order. */
  async function snapshot(f: RuntimeFx) {
    const out: Record<string, unknown> = {};
    for (const table of TENANT_TABLES) {
      const r = await k.one(
        `select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) as rows from ${table} x where x.organization_id = $1`,
        [f.w.org.id],
      );
      out[table] = r.rows;
    }
    return out;
  }
  /** The two organizations' snapshots, taken together. */
  const both = async () => ({ a: await snapshot(A), b: await snapshot(B) });
  const countOf = async (table: string, f: RuntimeFx) =>
    Number(
      (await k.one(`select count(*)::int n from ${table} where organization_id = $1`, [f.w.org.id]))
        .n,
    );
  const convOf = (f: RuntimeFx) => f.w.student.conversation.id;
  const dbx = () => t.db as unknown as DbExecutor;

  // ================================================================================== capture isolation

  describe("capture", () => {
    /** The routing identifiers Meta would use for the fixture's account, and a way to deliver a signed text from `phone`. */
    async function deliverTo(f: RuntimeFx, phone: string, body: string) {
      const acc = await k.one(
        "select phone_number_id, waba_id from whatsapp_accounts where id = $1",
        [f.w.account.id],
      );
      const { bytes } = deliveryBytes({
        pn: acc.phone_number_id as string,
        waba: acc.waba_id as string,
        from: phone,
        name: "Student",
        timestamp: new Date(),
        message: { type: "text", text: { body } },
      });
      expect((await handleWebhookPost(webhookPost(bytes), { db: t.db as never })).status).toBe(200);
      return processWebhookBatch(t.db, {
        handlers: buildWebhookWorkerHandlers({ BOTS_RUNTIME_ENABLED: "true" }),
      });
    }

    it("the SAME student number writing to both organizations: A's webhook creates only A's trigger, then B's only B's; each leaves the other byte-identical", async () => {
      const phone = "94770000111";
      await k.q("update contacts set wa_id = $2 where id = $1", [A.w.student.contact.id, phone]);
      await k.q("update contacts set wa_id = $2 where id = $1", [B.w.student.contact.id, phone]);
      const before = await both();

      expect((await deliverTo(A, phone, "hello A")).processed).toBe(1);
      const afterA = await both();
      expect(afterA.b).toEqual(before.b); // B untouched by A's inbound
      expect(await countOf("bot_triggers", A)).toBe(1);
      expect(await countOf("bot_triggers", B)).toBe(0);
      const [ta] = await k.rows("select * from bot_triggers where organization_id = $1", [
        A.w.org.id,
      ]);
      expect(ta).toMatchObject({
        whatsapp_account_id: A.w.account.id,
        conversation_id: convOf(A),
        status: "PENDING",
      });
      const msg = await k.one(
        "select organization_id, conversation_id from messages where id = $1",
        [ta!.message_id],
      );
      expect(msg).toMatchObject({ organization_id: A.w.org.id, conversation_id: convOf(A) });

      expect((await deliverTo(B, phone, "hello B")).processed).toBe(1);
      const afterB = await both();
      // B's inbound changed B only; A's rows (trigger included) are exactly as the previous step left them
      expect(afterB.a).toEqual(afterA.a);
      expect(await countOf("bot_triggers", A)).toBe(1);
      expect(await countOf("bot_triggers", B)).toBe(1);
    });

    it("another organization's ACTIVE deployment never admits a trigger: an organization with no deployment captures nothing, whatever the neighbour runs", async () => {
      const bare = await botWorld(t.db);
      const m = bare.student.message.id;
      const before = await both();
      const r = await insertBotTriggerIfAdmitted(dbx(), {
        organizationId: bare.org.id,
        whatsappAccountId: bare.account.id,
        conversationId: bare.student.conversation.id,
        messageId: m,
        messageType: "TEXT",
        inputOccurredAt: new Date(),
      });
      expect(r.inserted).toBe(false);
      expect(await both()).toEqual(before);
      expect(
        Number(
          (
            await k.one("select count(*)::int n from bot_triggers where organization_id = $1", [
              bare.org.id,
            ])
          ).n,
        ),
      ).toBe(0);
    });

    it("adversarial references: org, account, conversation and message taken from different organizations never create or modify a trigger", async () => {
      await k.q("update messages set type = 'TEXT' where id = any($1::uuid[])", [
        [A.w.student.message.id, B.w.student.message.id],
      ]);
      const before = await both();
      const mk = (o: { org: RuntimeFx; account: RuntimeFx; conv: RuntimeFx; msg: RuntimeFx }) => ({
        organizationId: o.org.w.org.id,
        whatsappAccountId: o.account.w.account.id,
        conversationId: convOf(o.conv),
        messageId: o.msg.w.student.message.id,
        messageType: "TEXT",
        inputOccurredAt: new Date(),
      });
      const attempts = [
        { org: A, account: B, conv: B, msg: B }, // everything but the organization is B's
        { org: A, account: A, conv: B, msg: B }, // A's organization and account on B's conversation
        { org: A, account: A, conv: A, msg: B }, // B's message on A's conversation
        { org: B, account: A, conv: A, msg: A }, // the reverse directions
        { org: B, account: B, conv: A, msg: A },
        { org: B, account: B, conv: B, msg: A },
        { org: A, account: B, conv: A, msg: A }, // B's account on A's conversation
      ];
      for (const a of attempts) {
        const r = await insertBotTriggerIfAdmitted(dbx(), mk(a));
        expect(r.inserted).toBe(false);
      }
      expect(await both()).toEqual(before);
      // the legitimate pairs still work, each in its own organization only
      expect(
        (await insertBotTriggerIfAdmitted(dbx(), mk({ org: A, account: A, conv: A, msg: A })))
          .inserted,
      ).toBe(true);
      expect(
        (await insertBotTriggerIfAdmitted(dbx(), mk({ org: B, account: B, conv: B, msg: B })))
          .inserted,
      ).toBe(true);
      expect(await countOf("bot_triggers", A)).toBe(1);
      expect(await countOf("bot_triggers", B)).toBe(1);
    });
  });

  // ================================================================================== composite foreign keys

  describe("malformed tenant bindings against PostgreSQL's constraints", () => {
    const keysOf = (f: RuntimeFx): SessionKeys => ({
      organizationId: f.w.org.id,
      botId: f.bot.id,
      versionId: f.version.id,
      deploymentId: f.deployment.id,
      whatsappAccountId: f.w.account.id,
      student: f.w.student,
    });
    /**
     * A rejected cross-organization binding: SQLSTATE 23503 from a named composite key, or from the control-sequence allocator
     * (0007), which refuses a conversation of another organization with the same class before the keys are even checked.
     */
    const fk = async (run: () => Promise<unknown>, allowed: string[]) => {
      let caught: unknown;
      try {
        await run();
      } catch (e) {
        caught = e;
      }
      if (!caught) throw new Error("the cross-organization binding was ACCEPTED");
      const e = pgError(caught);
      expect(e.code).toBe(FK_VIOLATION);
      if (e.constraint === undefined)
        expect(e.message).toMatch(/allocate_conversation_control_seq/);
      else expect(allowed).toContain(e.constraint);
    };

    it("bot_triggers: a conversation, account or message from the other organization is rejected by its composite keys", async () => {
      const before = await both();
      const ctxA = k.ctxOf(A);
      const cases: Array<[() => Promise<unknown>, string[]]> = [
        [
          () =>
            insertTrigger(
              t,
              { ...ctxA, conversationId: convOf(B) },
              { messageId: B.w.student.message.id },
            ),
          ["bot_triggers_conversation_account_fk"],
        ],
        [
          () => insertTrigger(t, ctxA, { messageId: B.w.student.message.id }),
          ["bot_triggers_message_fk"],
        ],
        [
          () =>
            insertTrigger(
              t,
              { ...ctxA, accountId: B.w.account.id },
              { messageId: A.w.student.message.id },
            ),
          ["bot_triggers_conversation_account_fk"],
        ],
        [
          () =>
            insertTrigger(
              t,
              { ...k.ctxOf(B), conversationId: convOf(A) },
              { messageId: A.w.student.message.id },
            ),
          ["bot_triggers_conversation_account_fk"],
        ],
        [
          () => insertTrigger(t, k.ctxOf(B), { messageId: A.w.student.message.id }),
          ["bot_triggers_message_fk"],
        ],
      ];
      for (const [run, allowed] of cases) await fk(run, allowed);
      expect(await both()).toEqual(before);
    });

    it("bot_sessions: deployment, version, bot, account, contact, conversation and message each rejected when they belong to the other organization (both directions)", async () => {
      const before = await both();
      const cases: Array<[string, Partial<SessionKeys>, string[]]> = [
        ["deployment", { deploymentId: B.deployment.id }, ["bot_sessions_deployment_fk"]],
        ["version", { versionId: B.version.id }, ["bot_sessions_bot_version_fk"]],
        ["bot", { botId: B.bot.id }, ["bot_sessions_bot_version_fk", "bot_sessions_deployment_fk"]],
        [
          "account",
          { whatsappAccountId: B.w.account.id },
          ["bot_sessions_conversation_account_fk", "bot_sessions_deployment_fk"],
        ],
        [
          "contact",
          { student: { ...A.w.student, contact: B.w.student.contact } },
          ["bot_sessions_conversation_contact_fk"],
        ],
        [
          "started_by_message",
          { student: { ...A.w.student, message: B.w.student.message } },
          ["bot_sessions_started_by_message_fk"],
        ],
        [
          "conversation",
          { student: { ...A.w.student, conversation: B.w.student.conversation } },
          [
            "bot_sessions_conversation_account_fk",
            "bot_sessions_conversation_contact_fk",
            "bot_sessions_started_by_message_fk",
          ],
        ],
      ];
      for (const [, over, allowed] of cases) {
        await fk(() => insertSession(t.pool, { ...keysOf(A), ...over }), allowed);
        // and in the other direction
        const mirrored: Partial<SessionKeys> = Object.fromEntries(
          Object.entries(over).map(([key]) => [key, keysOf(A)[key as keyof SessionKeys]]),
        );
        await fk(() => insertSession(t.pool, { ...keysOf(B), ...mirrored }), allowed);
      }
      // the organization itself: A's organization id on B's rows
      await fk(
        () => insertSession(t.pool, { ...keysOf(B), organizationId: A.w.org.id }),
        [
          "bot_sessions_deployment_fk",
          "bot_sessions_conversation_account_fk",
          "bot_sessions_conversation_contact_fk",
          "bot_sessions_started_by_message_fk",
          "bot_sessions_bot_version_fk",
        ],
      );
      expect(await both()).toEqual(before);
    });

    it("bot_deployments and bot_session_events: an account, bot, version, session or message from the other organization is rejected", async () => {
      const before = await both();
      const dep = (o: Record<string, string>) =>
        t.pool.query(
          `insert into bot_deployments (organization_id, whatsapp_account_id, bot_id, version_id, status, priority)
           values ($1, $2, $3, $4, 'ACTIVE', 7)`,
          [o.org, o.account, o.bot, o.version],
        );
      const a = { org: A.w.org.id, account: A.w.account.id, bot: A.bot.id, version: A.version.id };
      const b = { org: B.w.org.id, account: B.w.account.id, bot: B.bot.id, version: B.version.id };
      // accounts free of each organization's own deployment, so the version cases reach the keys and not the unique index
      const a2 = await seedAccount(t.db, A.w.org.id);
      const b2 = await seedAccount(t.db, B.w.org.id);
      await fk(() => dep({ ...a, account: b.account }), ["bot_deployments_org_account_fk"]);
      await fk(
        () => dep({ ...a, bot: b.bot }),
        ["bot_deployments_org_bot_fk", "bot_deployments_org_bot_version_fk"],
      );
      await fk(
        () => dep({ ...a, account: a2.id, version: b.version }),
        ["bot_deployments_org_bot_version_fk"],
      );
      await fk(() => dep({ ...b, account: a.account }), ["bot_deployments_org_account_fk"]);
      await fk(
        () => dep({ ...b, account: b2.id, version: a.version }),
        ["bot_deployments_org_bot_version_fk"],
      );

      const { session: sa } = await k.startedPrompt(A);
      const { session: sb } = await k.startedPrompt(B);
      const afterStarts = await both();
      const ev = (
        org: RuntimeFx,
        session: Record<string, unknown>,
        conv: RuntimeFx,
        msg: RuntimeFx,
      ) =>
        t.pool.query(
          `insert into bot_session_events (organization_id, session_id, conversation_id, kind, code, message_id)
           values ($1, $2, $3, 'INPUT_ACCEPTED', 'x', $4)`,
          [org.w.org.id, session.id, convOf(conv), msg.w.student.message.id],
        );
      await fk(() => ev(A, sb, A, A), ["bot_session_events_session_fk"]); // B's session under A's organization
      await fk(() => ev(A, sa, A, B), ["bot_session_events_message_fk"]); // B's message in A's session
      await fk(() => ev(B, sa, B, B), ["bot_session_events_session_fk"]);
      await fk(() => ev(B, sb, B, A), ["bot_session_events_message_fk"]);
      expect(await both()).toEqual(afterStarts);
      expect(before.a.bot_deployments).toEqual(afterStarts.a.bot_deployments);
    });

    it("outbound requests: a BOT enqueue naming the other organization's session, conversation or contact creates nothing; a STAFF submit into the other organization is refused", async () => {
      const { session: sa } = await k.startedPrompt(A);
      const { session: sb } = await k.startedPrompt(B);
      const before = await both();
      const auth = (o: {
        org: RuntimeFx;
        session: Record<string, unknown>;
        conv: RuntimeFx;
        contact: RuntimeFx;
        account?: RuntimeFx;
      }) => ({
        kind: "BOT" as const,
        organizationId: o.org.w.org.id,
        botSessionId: o.session.id as string,
        deploymentId: o.org.deployment.id,
        botVersionId: o.org.version.id,
        whatsappAccountId: (o.account ?? o.org).w.account.id,
        conversationId: convOf(o.conv),
        contactId: o.contact.w.student.contact.id,
        sendEpoch: 1,
      });
      const attempts = [
        auth({ org: A, session: sb, conv: A, contact: A }), // B's session under A's authority
        auth({ org: A, session: sa, conv: B, contact: A }), // A's session writing into B's conversation
        auth({ org: B, session: sa, conv: B, contact: B }),
        auth({ org: B, session: sb, conv: A, contact: B }),
        auth({ org: A, session: sa, conv: A, contact: B }), // B's contact
        auth({ org: A, session: sa, conv: A, contact: A, account: B }), // B's account
      ];
      for (const authority of attempts) {
        await expect(
          t.db.transaction((tx) =>
            enqueueAutomatedMessage(
              tx,
              authority,
              { stepSeq: 9, message: { kind: "text", text: "cross-tenant" } },
              { config: BOTS_ON, now: () => new Date() },
            ),
          ),
        ).rejects.toBeDefined();
      }
      // STAFF: the Inbox actor of A cannot submit into B's conversation
      await expect(k.submit({ ...A, w: { ...A.w, student: B.w.student } })).rejects.toBeDefined();
      expect(await both()).toEqual(before);
    });
  });

  // ================================================================================== claim isolation

  describe("claim", () => {
    it("two workers claiming at once take one trigger each; every claimed tuple equals the stored tenant tuple of that trigger", async () => {
      const ta = await k.trigger(A, { first: true });
      const tb = await k.trigger(B, { first: true });
      const [x, y] = await Promise.all([claimTriggers(dbx(), 1), claimTriggers(dbx(), 1)]);
      const claimed = [...x, ...y];
      expect(claimed.map((c) => c.id).sort()).toEqual([ta.id, tb.id].sort());
      for (const c of claimed) {
        const row = await k.one("select * from bot_triggers where id = $1", [c.id]);
        expect({
          org: c.organizationId,
          account: c.whatsappAccountId,
          conversation: c.conversationId,
          message: c.messageId,
        }).toEqual({
          org: row.organization_id,
          account: row.whatsapp_account_id,
          conversation: row.conversation_id,
          message: row.message_id,
        });
        // the stored tuple is itself consistent: the conversation and message really belong to that organization
        expect(
          (
            await k.one(
              `select count(*)::int n from conversations c join messages m
                 on m.organization_id = c.organization_id and m.conversation_id = c.id
                where c.organization_id = $1 and c.id = $2 and c.whatsapp_account_id = $3 and m.id = $4`,
              [c.organizationId, c.conversationId, c.whatsappAccountId, c.messageId],
            )
          ).n,
        ).toBe(1);
      }
    });

    it("a claim fence carrying the OTHER organization's id changes nothing (finish, failure, deferral), in both directions; the right organization succeeds", async () => {
      const ta = await k.trigger(A, { first: true });
      const tb = await k.trigger(B, { first: true });
      const claims = await claimTriggers(dbx(), 10);
      const ca = claims.find((c) => c.id === ta.id)!;
      const cb = claims.find((c) => c.id === tb.id)!;
      const before = await both();
      const fence = (c: typeof ca, org: string) => ({
        organizationId: org,
        id: c.id,
        claimToken: c.claimToken,
      });
      expect(
        await finishTrigger(dbx(), {
          ...fence(ca, B.w.org.id),
          status: "IGNORED",
          outcomeCode: "x",
        }),
      ).toBe(false);
      expect(
        await finishTrigger(dbx(), {
          ...fence(cb, A.w.org.id),
          status: "IGNORED",
          outcomeCode: "x",
        }),
      ).toBe(false);
      expect(
        await recordTriggerFailure(dbx(), {
          ...fence(ca, B.w.org.id),
          errorCode: "x",
          backoffMs: 0,
        }),
      ).toBe(false);
      expect(
        await recordTriggerFailure(dbx(), {
          ...fence(cb, A.w.org.id),
          errorCode: "x",
          backoffMs: 0,
        }),
      ).toBe(false);
      expect(
        await deferTrigger(dbx(), { ...fence(ca, B.w.org.id), ladderMs: [1000], maxDeferrals: 5 }),
      ).toBeNull();
      expect(
        await deferTrigger(dbx(), { ...fence(cb, A.w.org.id), ladderMs: [1000], maxDeferrals: 5 }),
      ).toBeNull();
      expect(await both()).toEqual(before);
      // a token from the other organization's claim does not fit either
      expect(
        await finishTrigger(dbx(), {
          organizationId: A.w.org.id,
          id: ca.id,
          claimToken: cb.claimToken,
          status: "IGNORED",
          outcomeCode: "x",
        }),
      ).toBe(false);
      expect(await both()).toEqual(before);
      // the right organization and token still finishes its own trigger, and only that one
      expect(
        await finishTrigger(dbx(), {
          ...fence(ca, A.w.org.id),
          status: "IGNORED",
          outcomeCode: "x",
        }),
      ).toBe(true);
      const after = await both();
      expect(after.b).toEqual(before.b);
      expect(after.a).not.toEqual(before.a);
    });

    it("the non-waiting wake and end passes act on one organization's conversation only: a mismatched (organization, conversation) pair matches nothing", async () => {
      await k.trigger(A, { first: true });
      await k.trigger(B, { first: true });
      await k.q("update bot_triggers set next_attempt_at = clock_timestamp() + interval '1 hour'");
      const before = await both();
      for (const [org, conv] of [
        [A, B],
        [B, A],
      ] as const) {
        expect(
          await wakeConversationTriggers(dbx(), {
            organizationId: org.w.org.id,
            conversationId: convOf(conv),
          }),
        ).toBe(0);
        expect(
          await endConversationTriggers(dbx(), {
            organizationId: org.w.org.id,
            conversationId: convOf(conv),
          }),
        ).toBe(0);
      }
      expect(await both()).toEqual(before);
      // the matching pair works and is scoped
      expect(
        await wakeConversationTriggers(dbx(), {
          organizationId: A.w.org.id,
          conversationId: convOf(A),
        }),
      ).toBe(1);
      const after = await both();
      expect(after.b).toEqual(before.b);
    });

    it("terminalizing one organization's exhausted trigger never touches the other organization's live session", async () => {
      const { session: sb } = await k.startedPrompt(B);
      const ta = await k.trigger(A, { first: true });
      await k.q(
        "update bot_triggers set attempts = 6, claim_token = null, claimed_at = null where id = $1",
        [ta.id],
      );
      const before = await both();
      const r = await terminalizeTrigger(dbx(), {
        organizationId: A.w.org.id,
        id: ta.id,
        conversationId: convOf(A),
      });
      expect(r.kind).toBe("dead");
      const after = await both();
      expect(after.b).toEqual(before.b);
      expect((await k.session(sb.id as string)).state).toBe("WAITING_FOR_SEND");
      expect((await k.one("select status from bot_triggers where id = $1", [ta.id])).status).toBe(
        "DEAD",
      );
    });
  });

  // ================================================================================== session execution isolation

  describe("session execution", () => {
    it("a trigger in A with no usable deployment of its own never starts B's deployment; B stays byte-identical", async () => {
      await k.q("update bot_deployments set status = 'PAUSED' where id = $1", [A.deployment.id]);
      const ta = await k.trigger(A, { first: true });
      const before = await both();
      const summary = await k.run(ta.id);
      expect(summary).toMatchObject({ kind: "finished", status: "IGNORED" });
      expect(await countOf("bot_sessions", A)).toBe(0);
      expect(await countOf("bot_sessions", B)).toBe(0);
      expect(await countOf("outbound_requests", B)).toBe(0);
      const after = await both();
      expect(after.b).toEqual(before.b);
    });

    it("a reply that carries the OTHER organization's live prompt token is not applied to either session", async () => {
      const { session: sa } = await k.startedPrompt(A);
      const { session: sb } = await k.startedPrompt(B);
      const tokenA = sa.awaiting_token as string;
      expect(tokenA).not.toBe(sb.awaiting_token);
      const before = await both();
      const rb = await k.replyTrigger(B, tokenA, "a"); // B's student taps a button built from A's token
      await k.run(rb.id);
      const after = await both();
      // A's session, request and conversation are untouched by anything B's step did
      expect(after.a).toEqual(before.a);
      const sbAfter = await k.session(sb.id as string);
      expect(sbAfter.awaiting_token).toBe(sb.awaiting_token); // B's own prompt was not consumed by A's token
      expect(sbAfter.last_consumed_token).not.toBe(tokenA);
      expect((await k.session(sa.id as string)).revision).toBe(sa.revision);
    });

    it("each organization's step uses only its own deployment: both start, and each session, request and event names its own organization", async () => {
      const ta = await k.trigger(A, { first: true });
      const tb = await k.trigger(B, { first: true });
      const claims = await claimTriggers(dbx(), 10); // one batch holds both organizations' claims
      const [ca, cb] = [ta, tb].map((x) => claims.find((c) => c.id === x.id)!);
      expect(await k.runClaim(ca!)).toMatchObject({ outcome: "session_started" });
      const afterA = await both();
      expect(await countOf("bot_sessions", B)).toBe(0);
      expect(await k.runClaim(cb!)).toMatchObject({ outcome: "session_started" });
      const afterB = await both();
      expect(afterB.a).toEqual(afterA.a); // B's step changed nothing of A
      for (const f of [A, B]) {
        const bad = await k.one(
          `select
             (select count(*) from bot_sessions s join bot_deployments d on d.id = s.deployment_id where s.organization_id = $1 and d.organization_id <> s.organization_id)::int
           + (select count(*) from outbound_requests r join bot_sessions s on s.id = r.bot_session_id where r.organization_id = $1 and s.organization_id <> r.organization_id)::int
           + (select count(*) from bot_session_events e join bot_sessions s on s.id = e.session_id where e.organization_id = $1 and s.organization_id <> e.organization_id)::int as n`,
          [f.w.org.id],
        );
        expect(bad.n).toBe(0);
      }
    });
  });

  // ================================================================================== reconciliation isolation

  describe("reconciliation", () => {
    it("reconciling A's accepted prompt moves only A's session; a candidate that names the other organization's session is refused and changes nothing", async () => {
      const x = await k.acceptedPrompt(A);
      const y = await k.acceptedPrompt(B);
      const before = await both();
      // adversarial candidates: organization of one, session/conversation/deployment of the other (both directions)
      await expect(k.reconcile({ ...y.session, organization_id: A.w.org.id })).rejects.toThrow();
      await expect(k.reconcile({ ...x.session, organization_id: B.w.org.id })).rejects.toThrow();
      expect(await both()).toEqual(before);

      expect(await k.reconcile(x.session)).toMatchObject({ kind: "applied" });
      const afterA = await both();
      expect(afterA.b).toEqual(before.b); // B's session, request, trigger, deployment, conversation: untouched
      expect((await k.session(x.session.id as string)).state).toBe("WAITING_FOR_INPUT");
      expect((await k.session(y.session.id as string)).state).toBe("WAITING_FOR_SEND");

      expect(await k.reconcile(y.session)).toMatchObject({ kind: "applied" });
      const afterB = await both();
      expect(afterB.a).toEqual(afterA.a);
    });

    it("the whole-database sweep reconciles each organization's own sessions: with only A due, B is byte-identical", async () => {
      const x = await k.acceptedPrompt(A);
      await k.startedPrompt(B); // B's prompt is still QUEUED: nothing for the sweep to do there
      const before = await both();
      const summary = await sweepOnce(dbx(), k.deps());
      expect(summary.reconciled).toBeGreaterThanOrEqual(1);
      expect((await k.session(x.session.id as string)).state).toBe("WAITING_FOR_INPUT");
      expect((await both()).b).toEqual(before.b);
    });
  });

  // ================================================================================== suppression isolation

  describe("suppression", () => {
    const heldCount = (f: RuntimeFx) =>
      k
        .one(
          "select count(*)::int n from outbound_requests where organization_id = $1 and state = 'HELD'",
          [f.w.org.id],
        )
        .then((r) => Number(r.n));

    it("operator Stop: A's admin cannot stop B's deployment; stopping A's own suppresses only A's session and queued request (both directions)", async () => {
      await k.startedPrompt(A);
      await k.startedPrompt(B);
      const before = await both();
      await expect(
        stopActiveSessions(
          A.w.admin.ctx,
          { deploymentId: B.deployment.id, expectedLiveSessions: 1 },
          { db: t.db },
        ),
      ).rejects.toThrow(/not found/i);
      await expect(
        stopActiveSessions(
          B.w.admin.ctx,
          { deploymentId: A.deployment.id, expectedLiveSessions: 1 },
          { db: t.db },
        ),
      ).rejects.toThrow(/not found/i);
      expect(await both()).toEqual(before);

      const stopped = await stopActiveSessions(
        A.w.admin.ctx,
        { deploymentId: A.deployment.id, expectedLiveSessions: 1 },
        { db: t.db },
      );
      expect(stopped.applied && stopped.value).toMatchObject({
        sessionsStopped: 1,
        requestsSuppressed: 1,
      });
      const afterA = await both();
      expect(afterA.b).toEqual(before.b);
      expect(await heldCount(A)).toBe(1);
      expect(await heldCount(B)).toBe(0);

      const stoppedB = await stopActiveSessions(
        B.w.admin.ctx,
        { deploymentId: B.deployment.id, expectedLiveSessions: 1 },
        { db: t.db },
      );
      expect(stoppedB.applied && stoppedB.value).toMatchObject({
        sessionsStopped: 1,
        requestsSuppressed: 1,
      });
      expect((await both()).a).toEqual(afterA.a);
    });

    it("Emergency Stop of A stops every deployment of A and none of B", async () => {
      await k.startedPrompt(A);
      await k.startedPrompt(B);
      const before = await both();
      const r = await emergencyStop(
        A.w.admin.ctx,
        { expectedDeployments: 1, confirmPhrase: EMERGENCY_STOP_PHRASE },
        { db: t.db },
      );
      expect(r.applied).toBe(true);
      const after = await both();
      expect(after.b).toEqual(before.b);
      expect(
        (await k.one("select status from bot_deployments where id = $1", [A.deployment.id])).status,
      ).toBe("STOPPED");
      expect(
        (await k.one("select status from bot_deployments where id = $1", [B.deployment.id])).status,
      ).toBe("ACTIVE");
    });

    it("the suppression primitives with a mismatched (organization, deployment/session) pair hold nothing, in both directions", async () => {
      const { session: sa } = await k.startedPrompt(A);
      const { session: sb } = await k.startedPrompt(B);
      const before = await both();
      await t.db.transaction(async (tx) => {
        const r1 = await suppressQueuedBotRequests(
          tx as never,
          A.w.org.id,
          [B.deployment.id],
          "bot_stopped",
        );
        const r2 = await suppressQueuedBotRequests(
          tx as never,
          B.w.org.id,
          [A.deployment.id],
          "bot_stopped",
        );
        expect(
          [...r1.suppressed.values(), ...r2.suppressed.values()].reduce((x, y) => x + y, 0),
        ).toBe(0);
        const s1 = await suppressSessionQueuedRequests(
          tx as never,
          A.w.org.id,
          sb.id as string,
          "bot_output_suppressed",
        );
        const s2 = await suppressSessionQueuedRequests(
          tx as never,
          B.w.org.id,
          sa.id as string,
          "bot_output_suppressed",
        );
        expect([s1.heldIds.length, s2.heldIds.length]).toEqual([0, 0]);
      });
      expect(await both()).toEqual(before);
      // matched pair holds exactly its own session's request
      await t.db.transaction(async (tx) => {
        const own = await suppressSessionQueuedRequests(
          tx as never,
          A.w.org.id,
          sa.id as string,
          "bot_output_suppressed",
        );
        expect(own.heldIds).toHaveLength(1);
      });
      expect((await both()).b).toEqual(before.b);
    });

    it("staff takeover in A: A's prompt is refused by the dispatcher, B's prompt in the same dispatcher call is still claimed and sent", async () => {
      const { request: ra } = await k.startedPrompt(A);
      const { request: rb } = await k.startedPrompt(B);
      await k.assign(A);
      const transport = new FakeTransport().next(k.accepted("wamid.TENANT.B"));
      const d = k.dispatchDeps(transport);
      const { claim, held } = await claimNext(d);
      expect(held).toBe(1);
      expect(claim?.requestId).toBe(rb.id);
      expect(await executeClaim(d, claim!)).toBe("accepted");
      expect(transport.calls).toHaveLength(1);
      expect(await k.request(ra.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "staff_took_over",
      });
      expect(await k.request(rb.id as string)).toMatchObject({ state: "ACCEPTED" });
    });

    it("concurrent activity: while A's Stop locks hold A's deployment and conversation, B's step, dispatch and reconciliation complete without waiting", async () => {
      const x = await k.acceptedPrompt(B);
      const { request: rb } = await k.startedPrompt(A);
      expect(rb).toBeDefined();
      // what Stop takes in A: the deployment row and the conversation row, held open
      const stopLocks = await kit.hold(
        "select d.id from bot_deployments d, conversations c where d.id = $1 and c.id = $2 for update",
        [A.deployment.id, convOf(A)],
      );
      const reply = await k.replyTrigger(B, x.session.awaiting_token as string, "a");
      const work = (async () => {
        await k.reconcile(x.session); // B: WAITING_FOR_SEND -> WAITING_FOR_INPUT
        await k.run(reply.id); // B: the student's tap
        return true;
      })();
      expect(await kit.within(work, 10_000)).toBe(true);
      await work;
      // B moved on: its tap was applied (the next prompt is step 2 and was enqueued) while A's locks were held
      expect(Number((await k.session(x.session.id as string)).step_seq)).toBe(2);
      expect(await countOf("outbound_requests", B)).toBe(2);
      // A's locks were never released during B's work, and A's state is as before
      expect(
        (
          await k.session(
            (
              await k.rows("select id from bot_sessions where organization_id = $1", [A.w.org.id])
            )[0]!.id as string,
          )
        ).state,
      ).toBe("WAITING_FOR_SEND");
      await stopLocks.release();
    });
  });

  // ================================================================================== read paths

  describe("read paths", () => {
    it("operator reads are scoped to the caller's organization: lists show only its own bots, versions and deployments; the other organization's ids are not found", async () => {
      const bots = await listBots(A.w.admin.ctx, { db: t.db });
      expect(bots.map((b) => b.id)).toEqual([A.bot.id]);
      expect((await listBots(B.w.admin.ctx, { db: t.db })).map((b) => b.id)).toEqual([B.bot.id]);
      expect((await listDeployments(A.w.admin.ctx, { db: t.db })).map((d) => d.id)).toEqual([
        A.deployment.id,
      ]);
      expect((await listVersions(A.w.admin.ctx, A.bot.id, { db: t.db })).map((v) => v.id)).toEqual([
        A.version.id,
      ]);
      await expect(getBot(A.w.admin.ctx, B.bot.id, { db: t.db })).rejects.toThrow(/not found/i);
      await expect(getVersion(A.w.admin.ctx, B.version.id, { db: t.db })).rejects.toThrow(
        /not found/i,
      );
      expect(await listVersions(A.w.admin.ctx, B.bot.id, { db: t.db })).toEqual([]);
      await expect(getBot(B.w.admin.ctx, A.bot.id, { db: t.db })).rejects.toThrow(/not found/i);
    });

    it("the outbound-request status read of A's staff cannot see B's BOT request, and the other way round", async () => {
      const { request: ra } = await k.startedPrompt(A);
      const { request: rb } = await k.startedPrompt(B);
      expect(
        (await getOutboundRequest(A.w.staff.ctx, ra.id as string, { db: t.db as never })).requestId,
      ).toBe(ra.id);
      await expect(
        getOutboundRequest(A.w.staff.ctx, rb.id as string, { db: t.db as never }),
      ).rejects.toBeDefined();
      await expect(
        getOutboundRequest(B.w.staff.ctx, ra.id as string, { db: t.db as never }),
      ).rejects.toBeDefined();
    });

    it("the runtime's start-fact reads (attribution, first-message history, staff control, hold code) never see the other organization's rows", async () => {
      const { readAttributions, readFirstEligibleRows, readStartFacts } =
        await import("@/db/ops/bot-step");
      await k.q(
        `insert into lead_attributions (organization_id, contact_id, lead_id, message_id, source_type, received_at)
         values ($1, $2, NULL, $3, 'META_AD', clock_timestamp())`,
        [B.w.org.id, B.w.student.contact.id, B.w.student.message.id],
      );
      // B's attribution is invisible through A's organization, and visible through B's
      expect(await readAttributions(dbx(), A.w.org.id, B.w.student.message.id)).toEqual([]);
      expect(await readAttributions(dbx(), B.w.org.id, B.w.student.message.id)).toHaveLength(1);
      // B's message is not first-eligible history of A's conversation, and A's conversation is not read as B's
      const h = await readFirstEligibleRows(dbx(), {
        organizationId: A.w.org.id,
        conversationId: convOf(B),
        messageId: B.w.student.message.id,
      });
      expect(h).toMatchObject({ firstInRecordHistory: true });
      const facts = await readStartFacts(dbx(), {
        organizationId: A.w.org.id,
        conversationId: convOf(B),
        contactId: B.w.student.contact.id,
        decisionClock: new Date(),
        contactWindowMs: 3_600_000,
      });
      expect(facts.maxStaffControlSeq).toBeNull();
      expect(facts.botRequestInFlight).toBe(false);
      // the dispatcher's hold-code function: the other organization's request id is unreadable, not leaked
      const { request: rb } = await k.startedPrompt(B);
      const code = await k.one("select bot_request_hold_code($1, $2) as code", [A.w.org.id, rb.id]);
      expect(code.code).toBe("bot_state_unreadable");
      expect(
        (await k.one("select bot_request_hold_code($1, $2) as code", [B.w.org.id, rb.id])).code,
      ).toBeNull();
    });
  });
});

// ------------------------------------------------------------------------------------------------ redaction isolation

describe("terminal-session privacy redaction is per organization (E-TEN)", () => {
  let t: TestDb;
  let k: ReturnType<typeof runtimeKit>;

  beforeAll(async () => {
    t = await createTestDatabase();
    // the retention period is replaced in THIS disposable database only, so terminal sessions are immediately eligible
    await t.pool.query(
      "create or replace function bot_session_redaction_after() returns interval language sql stable as $$ select interval '0 seconds' $$",
    );
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    k = runtimeKit(t);
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("redact_expired_bot_sessions(A) clears A's terminal session and leaves B's eligible terminal session untouched, and vice versa", async () => {
    const A = await k.fixture();
    const B = await k.fixture();
    const ended: Record<string, string> = {};
    for (const [name, f] of [
      ["A", A],
      ["B", B],
    ] as const) {
      const { session } = await k.startedPrompt(f);
      await k.q(
        'update bot_sessions set variables = \'{"student_name": "secret"}\'::jsonb, revision = revision + 1 where id = $1',
        [session.id],
      );
      await k.q(
        "update bot_sessions set state = 'COMPLETED', end_reason = 'flow_end', awaiting = NULL, awaiting_token = NULL, revision = revision + 1 where id = $1",
        [session.id],
      );
      ended[name] = session.id as string;
    }
    const rowOf = async (id: string) =>
      (await k.one("select * from bot_sessions where id = $1", [id])) as Record<string, unknown>;
    const bBefore = await rowOf(ended.B!);
    expect(bBefore.redacted_at).toBeNull();
    const n = await k.one("select redact_expired_bot_sessions($1, 100) n", [A.w.org.id]);
    expect(Number(n.n)).toBe(1);
    expect((await rowOf(ended.A!)).redacted_at).not.toBeNull();
    expect(await rowOf(ended.B!)).toEqual(bBefore); // B: byte-identical, variables intact
    expect((await rowOf(ended.B!)).variables).toEqual({ student_name: "secret" });
    const aAfter = await rowOf(ended.A!);
    expect(
      Number((await k.one("select redact_expired_bot_sessions($1, 100) n", [B.w.org.id])).n),
    ).toBe(1);
    expect(await rowOf(ended.A!)).toEqual(aAfter);
    expect((await rowOf(ended.B!)).redacted_at).not.toBeNull();
  });
});

// NEGATIVE CONTROL for the foreign-key tests above (Phase 08E-8C, step 6): in a SECOND disposable database one composite key is
// dropped (that database only; no migration file is touched). The very insert the key tests reject must then SUCCEED and
// produce a session whose deployment belongs to another organization, so the rejection above is the key's doing and nothing else.
describe("E-TEN negative control: without bot_sessions_deployment_fk the cross-organization session is accepted", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("MUTATION drop the deployment key: A's session bound to B's deployment commits (and the same insert is rejected while the key exists)", async () => {
    const k = runtimeKit(t);
    const A = await k.fixture();
    const B = await k.fixture();
    const keys: SessionKeys = {
      organizationId: A.w.org.id,
      botId: A.bot.id,
      versionId: A.version.id,
      deploymentId: B.deployment.id,
      whatsappAccountId: A.w.account.id,
      student: A.w.student,
    };
    await expectPgError(insertSession(t.pool, keys), FK_VIOLATION, "bot_sessions_deployment_fk");
    await t.pool.query("alter table bot_sessions drop constraint bot_sessions_deployment_fk");
    const row = await insertSession(t.pool, keys);
    const crossed = await k.one(
      `select s.organization_id as s_org, d.organization_id as d_org from bot_sessions s
         join bot_deployments d on d.id = s.deployment_id where s.id = $1`,
      [row.id],
    );
    expect(crossed.s_org).toBe(A.w.org.id);
    expect(crossed.d_org).toBe(B.w.org.id); // the defect the key prevents
  });
});
