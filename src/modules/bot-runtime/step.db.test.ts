import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestDatabase,
  seedAccount,
  seedContact,
  seedConversation,
  type TestDb,
} from "@/db/__tests__/helpers";
import { countRecentBotRequests } from "@/db/ops/bot-session-store";
import { dbClock, readFirstEligibleRows } from "@/db/ops/bot-step";
import type { DbExecutor } from "@/db/ops/executor";
import { activateDeployment } from "../bot-control";
import {
  BOTS_ON,
  barrierKit,
  botWorld,
  insertSession,
  liveSessionFor,
  publishedBot,
  queueBotStep,
  textMessage,
  updateSession,
  type BotWorld,
  type Student,
} from "../bot-control/testing";
import { claimNext, executeClaim } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { FlowCache } from "./flow-cache";
import { processTrigger } from "./step";
import {
  endFirstFlow,
  handoverFirstFlow,
  insertTrigger,
  makeDue,
  menuFlow,
  messageFlow,
  triggerRow,
} from "./testing";
import { claimTriggers, type ClaimedTrigger } from "./trigger-queue";
import { enqueueEffect, type StepDeps, type StepHooks } from "./outbound";
import type { StepSummary } from "./context";

// Phase 08E-4 on disposable PostgreSQL 17 (READ COMMITTED, the production level): the step transaction T1, session creation
// and continuation, applyEngineResult, terminal notices, staleness, lock-busy freshness, the per-contact cap, first_message
// durability, rollback, restart and claim fencing. The dispatcher runs only with a FakeTransport. Order between sessions is
// proved by lock OWNERSHIP (barrierKit), never by sleeping. NOT EXECUTED by the author of this change: no isolated test server
// was configured (see the 08E-4 report for the owner's commands).

// TEST-ONLY mutation seam (08E-4 mutation evidence). Every wrapper below is a pass-through unless a test sets `mutate.name`;
// the mutations substitute ONE behaviour at the module boundary (the production files are never edited) so that the
// regressions can be shown to fail when a safety mechanism is removed. `mutate.name` is reset before every test.
const mutate = vi.hoisted(() => ({ name: null as string | null }));
vi.mock("@/db/ops/bot-step", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/db/ops/bot-step")>();
  const queue = await import("@/db/ops/bot-trigger-queue");
  return {
    ...orig,
    // removes ONE of the two independent first_message predicates from the (otherwise real) statement's result
    readFirstEligibleRows: async (...a: Parameters<typeof orig.readFirstEligibleRows>) => {
      const r = await orig.readFirstEligibleRows(...a);
      if (mutate.name === "no_session_fence")
        return { ...r, noPreviousSessionStart: true, evidenceDefect: false };
      if (mutate.name === "no_record_order") return { ...r, firstInRecordHistory: true };
      return r;
    },
    // omits the contact-level serialization only (the conversation try-lock stays)
    tryAdvisoryLock: async (...a: Parameters<typeof orig.tryAdvisoryLock>) =>
      mutate.name === "no_contact_lock" && a[1].startsWith("bot-contact:")
        ? true
        : orig.tryAdvisoryLock(...a),
    // removes the claim-token condition from the first statement of T1
    lockStepTrigger: async (...a: Parameters<typeof orig.lockStepTrigger>) => {
      if (mutate.name !== "no_claim_fence") return orig.lockStepTrigger(...a);
      const [tx, fence] = a;
      const r = await tx.execute<{
        id: string;
        organization_id: string;
        whatsapp_account_id: string;
        conversation_id: string;
        message_id: string;
        input_occurred_at: string;
        enqueued_at: string;
        observed_control_seq: string;
        attempts: number;
        deferrals: number;
      }>(sql`SELECT id, organization_id, whatsapp_account_id, conversation_id, message_id, input_occurred_at, enqueued_at,
                    observed_control_seq, attempts, deferrals FROM bot_triggers
              WHERE organization_id = ${fence.organizationId} AND id = ${fence.id} AND status = 'PENDING' FOR UPDATE`);
      const x = r.rows[0];
      return x
        ? {
            id: x.id,
            organizationId: x.organization_id,
            whatsappAccountId: x.whatsapp_account_id,
            conversationId: x.conversation_id,
            messageId: x.message_id,
            inputOccurredAt: queue.timestampToDate(x.input_occurred_at),
            enqueuedAt: queue.timestampToDate(x.enqueued_at),
            observedControlSeq: Number(x.observed_control_seq),
            attempts: x.attempts,
            deferrals: x.deferrals,
          }
        : null;
    },
  };
});
vi.mock("@/db/ops/bot-session-store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/db/ops/bot-session-store")>();
  return {
    ...orig,
    // the replay pre-check finds no existing request for the step, so the rolling-hour count is taken for a replay too
    // (enqueueEffect skips the count only when this lookup finds the step's request; the pure evaluator's replay flag is a
    // second, redundant guard, so flipping it alone is equivalent and was NOT a valid mutation)
    readStepRequest: async (...a: Parameters<typeof orig.readStepRequest>) =>
      mutate.name === "cap_ignores_replay" ? null : orig.readStepRequest(...a),
    // removes the idempotence guards (NOT EXISTS / ON CONFLICT DO NOTHING) of the event insert
    insertSessionEvent: async (...a: Parameters<typeof orig.insertSessionEvent>) => {
      if (mutate.name !== "event_no_guard") return orig.insertSessionEvent(...a);
      const [tx, e] = a;
      const r =
        await tx.execute(sql`INSERT INTO bot_session_events (organization_id, session_id, conversation_id, kind, message_id, step_seq, code)
        VALUES (${e.organizationId}, ${e.sessionId}, ${e.conversationId}, ${e.kind}, ${e.messageId ?? null}, ${e.stepSeq ?? null}, ${e.code ?? null}) RETURNING id`);
      return r.rows.length === 1;
    },
  };
});
vi.mock("./eligibility", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./eligibility")>();
  return {
    ...orig,
    // staleness checked only AFTER the in-flight deferral: the deferral wins whenever a BOT request is in flight
    evaluateStartEligibility: (facts: Parameters<typeof orig.evaluateStartEligibility>[0]) =>
      mutate.name === "stale_after_defer" && facts.botRequestInFlight && !facts.hasLiveSession
        ? ({ outcome: "defer", code: "bot_request_in_flight" } as const)
        : orig.evaluateStartEligibility(facts),
  };
});

type Json = Record<string, unknown>;
const MIN = 60_000;
/** An input that is one second old at a decision clock advanced by `shiftMs` (the tests advance the DB clock past the cooldown). */
const freshAt = (shiftMs: number) => new Date(Date.now() + shiftMs - 1000);

describe("bot step transaction T1 (08E-4)", () => {
  let t: TestDb;
  let barriers: ReturnType<typeof barrierKit>;
  let tokens = 0;
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
  const rows = async (text: string, params: unknown[] = []) => (await q(text, params)).rows;
  const one = async (text: string, params: unknown[] = []) => (await rows(text, params))[0];
  const count = async (table: string, where = "true", params: unknown[] = []) =>
    Number((await one(`select count(*)::int n from ${table} where ${where}`, params)).n);

  const deps = (over: Partial<StepDeps> = {}): StepDeps => ({
    config: BOTS_ON,
    flows: new FlowCache(),
    newPromptToken: () => `T${String(++tokens).padStart(21, "A")}`,
    random: () => 0.5,
    ...over,
  });

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
    // the claim is global: a trigger left PENDING by an earlier test must not be claimed by this one
    await q("truncate organizations, webhook_requests cascade");
    barriers = barrierKit(t);
    mutate.name = null;
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await barriers.cleanup();
  });

  // ------------------------------------------------------------------------------------------------------ fixtures

  type Fx = {
    w: BotWorld;
    bot: { id: string };
    version: { id: string };
    deployment: { id: string };
  };

  async function activateAccount(accountId: string) {
    await q(
      "update whatsapp_accounts set status = 'ACTIVE', credential_ref = 'WA_TOKEN_TEST', archived_at = NULL where id = $1",
      [accountId],
    );
  }
  async function openWindow(conversationId: string) {
    await q(
      "update conversations set last_inbound_at = clock_timestamp() - interval '1 minute' where id = $1",
      [conversationId],
    );
  }
  /** A world with a send-eligible account and `flow` published and deployed on it. */
  async function fixture(flow: Json = menuFlow(), w?: BotWorld): Promise<Fx> {
    const world = w ?? (await botWorld(t.db));
    await activateAccount(world.account.id);
    await openWindow(world.student.conversation.id);
    const { bot, version } = await publishedBot(t.db, world, flow);
    const deployment = (
      await activateDeployment(
        world.admin.ctx,
        { botId: bot.id, versionId: version.id, whatsappAccountId: world.account.id, priority: 1 },
        { db: t.db },
      )
    ).value;
    return { w: world, bot, version, deployment };
  }

  async function inbound(
    f: Fx,
    o: { student?: Student; type?: string; body?: string | null; content?: Json | null } = {},
  ): Promise<string> {
    const s = o.student ?? f.w.student;
    const r = await q(
      `insert into messages (organization_id, conversation_id, whatsapp_account_id, wamid, direction, type, body, content, occurred_at)
       values ($1, $2, $3, $4, 'INBOUND', $5, $6, $7::jsonb, clock_timestamp()) returning id`,
      [
        f.w.org.id,
        s.conversation.id,
        f.w.account.id,
        `wamid.${randomUUID()}`,
        o.type ?? "TEXT",
        o.body === undefined ? "hi" : o.body,
        o.content ? JSON.stringify(o.content) : null,
      ],
    );
    return r.rows[0].id as string;
  }

  const usedSeeded = new Set<string>();
  async function trigger(
    f: Fx,
    o: {
      student?: Student;
      messageId?: string;
      body?: string;
      type?: string;
      content?: Json;
      observed?: number;
      inputAt?: Date;
    } = {},
  ): Promise<{ id: string; messageId: string }> {
    const s = o.student ?? f.w.student;
    let messageId = o.messageId;
    if (messageId === undefined) {
      // The student's seeded inbound message is the conversation's FIRST eligible message: the first trigger uses it (reshaped as asked).
      if (!usedSeeded.has(s.message.id)) {
        usedSeeded.add(s.message.id);
        messageId = s.message.id;
        await q("update messages set type = $2, body = $3, content = $4::jsonb where id = $1", [
          messageId,
          o.type ?? "TEXT",
          o.body ?? "hi",
          o.content ? JSON.stringify(o.content) : null,
        ]);
      } else
        messageId = await inbound(f, {
          student: s,
          ...(o.body !== undefined ? { body: o.body } : {}),
          ...(o.type ? { type: o.type } : {}),
          ...(o.content ? { content: o.content } : {}),
        });
    }
    const seeded = await insertTrigger(
      t,
      {
        organizationId: f.w.org.id,
        accountId: s === f.w.student ? f.w.account.id : f.w.account.id,
        conversationId: s.conversation.id,
      },
      { messageId, ...(o.inputAt ? { inputOccurredAt: o.inputAt } : {}) },
    );
    if (o.observed !== undefined)
      await q("update bot_triggers set observed_control_seq = $2 where id = $1", [
        seeded.id,
        o.observed,
      ]);
    return { id: seeded.id, messageId };
  }

  const claimOf = async (id: string): Promise<ClaimedTrigger> => {
    const c = (await claimTriggers(t.db, 50)).find((x) => x.id === id);
    if (!c) throw new Error(`trigger ${id} was not claimed`);
    return c;
  };
  const run = async (id: string, over: Partial<StepDeps> = {}): Promise<StepSummary> =>
    processTrigger(t.db as unknown as DbExecutor, await claimOf(id), deps(over));
  const ok = (s: StepSummary, status: string, outcome: string) =>
    expect(s).toMatchObject({ kind: "finished", status, outcome });

  const sessionsOf = (f: Fx, s: Student = f.w.student) =>
    rows(
      "select * from bot_sessions where organization_id = $1 and conversation_id = $2 order by started_at",
      [f.w.org.id, s.conversation.id],
    );
  const liveSession = async (f: Fx) => (await sessionsOf(f)).at(-1)!;
  const requestsOf = (f: Fx, s: Student = f.w.student) =>
    rows(
      "select * from outbound_requests where organization_id = $1 and conversation_id = $2 and origin = 'BOT' order by bot_step_seq",
      [f.w.org.id, s.conversation.id],
    );
  const eventsOf = (sessionId: string) =>
    rows(
      "select kind, code, message_id, step_seq from bot_session_events where session_id = $1 order by created_at, id",
      [sessionId],
    );
  const rowJson = async (table: string, id: string) =>
    (await one(`select to_jsonb(x) j from ${table} x where id = $1`, [id])).j as Json;

  /** A real dispatcher pass with a fake transport: the next QUEUED request is claimed and ACCEPTED. */
  async function dispatchAccepted() {
    const transport = new FakeTransport().next({
      kind: "accepted",
      wamid: `wamid.OUT.${randomUUID()}`,
      providerStatus: "accepted",
      httpStatus: 200,
    });
    const d = {
      db: t.db as never,
      transport,
      config: BOTS_ON,
      random: () => 0.5,
      accountMinIntervalMs: 0,
      conversationMinIntervalMs: 0,
    };
    const { claim } = await claimNext(d);
    expect(claim, "a QUEUED BOT request must be claimable").toBeTruthy();
    expect(await executeClaim(d, claim!)).toBe("accepted");
    expect(transport.calls).toHaveLength(1);
  }
  const replyContent = (token: string, key: string) => ({
    subtype: "button_reply",
    id: `b1.${token}.${key}`,
    title: key,
  });

  /** Starts a session for the world's student with the menu flow and returns its live row. */
  async function startMenu(f: Fx) {
    const tr = await trigger(f);
    ok(await run(tr.id), "PROCESSED", "session_started");
    return { tr, session: await liveSession(f) };
  }

  // ===================================================================================== start: creation (ENG, E.2)

  describe("session creation", () => {
    it("first_message starts a pinned session, enqueues its one request and never replays the starting message", async () => {
      const f = await fixture();
      const tr = await trigger(f);
      const summary = await run(tr.id);
      ok(summary, "PROCESSED", "session_started");

      const [s, ...rest] = await sessionsOf(f);
      expect(rest).toEqual([]);
      expect(s).toMatchObject({
        organization_id: f.w.org.id,
        bot_id: f.bot.id,
        bot_version_id: f.version.id,
        deployment_id: f.deployment.id,
        started_by_message_id: tr.messageId,
        last_input_message_id: tr.messageId,
        state: "WAITING_FOR_SEND",
        step_seq: 1,
        revision: 1,
        send_count: 1,
      });
      expect(s.awaiting_token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(s.send_wait_expires_at).toBeTruthy();
      const reqs = await requestsOf(f);
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({
        origin: "BOT",
        state: "QUEUED",
        bot_session_id: s.id,
        bot_step_seq: 1,
      });
      expect(Number(reqs[0].control_seq)).toBeGreaterThan(Number(s.started_control_seq));
      expect(await eventsOf(s.id as string)).toEqual([]); // no INPUT_* for the starting message
      expect(await triggerRow(t, tr.id)).toMatchObject({
        status: "PROCESSED",
        outcome_code: "session_started",
        session_id: s.id,
        claim_token: null,
      });
    });

    it("keyword matches the whole trimmed message case-insensitively; a different word does not start", async () => {
      const f = await fixture(messageFlow());
      const miss = await trigger(f, { body: "menu please" });
      ok(await run(miss.id), "IGNORED", "no_trigger_match");
      expect(await sessionsOf(f)).toHaveLength(0);
      const hit = await trigger(f, { body: "  MeNu " });
      ok(await run(hit.id), "PROCESSED", "session_started");
    });

    it("a first-node END with a notice completes in one commit with the notice request (R8-I)", async () => {
      const f = await fixture(endFirstFlow("Bye"));
      const tr = await trigger(f, { body: "menu" });
      ok(await run(tr.id), "PROCESSED", "session_started");
      const s = await liveSession(f);
      expect(s).toMatchObject({
        state: "COMPLETED",
        end_reason: "flow_end",
        step_seq: 1,
        terminal_notice_step_seq: 1,
      });
      expect(await requestsOf(f)).toHaveLength(1);
    });

    it("a first-node END without a message completes with no request (R8-I)", async () => {
      const f = await fixture(endFirstFlow());
      const tr = await trigger(f, { body: "menu" });
      ok(await run(tr.id), "PROCESSED", "session_started");
      expect(await liveSession(f)).toMatchObject({
        state: "COMPLETED",
        end_reason: "flow_end",
        terminal_notice_step_seq: null,
      });
      expect(await requestsOf(f)).toHaveLength(0);
    });

    it("a first-node HANDOVER with a notice hands over with its control sequence, one request, and blocks a restart until staff resolve (R8-I, R4-B)", async () => {
      const f = await fixture(handoverFirstFlow());
      ok(await run((await trigger(f, { body: "menu" })).id), "PROCESSED", "session_started");
      const s = await liveSession(f);
      expect(s).toMatchObject({
        state: "HANDED_OVER",
        end_reason: "flow_handover",
        handover_reason: "needs_staff",
        terminal_notice_step_seq: 1,
      });
      expect(Number(s.handover_control_seq)).toBeGreaterThan(Number(s.started_control_seq));
      expect(await requestsOf(f)).toHaveLength(1);
      expect((await eventsOf(s.id as string)).map((e) => e.kind)).toEqual(["HANDED_OVER"]);
      ok(await run((await trigger(f, { body: "menu" })).id), "IGNORED", "handover_unresolved");
    });

    it("the pinned version survives a later deployment change", async () => {
      const f = await fixture();
      const { session } = await startMenu(f);
      const other = await publishedBot(t.db, f.w, messageFlow(), "other_bot");
      expect(other.version.id).not.toBe(f.version.id);
      expect(session.bot_version_id).toBe(f.version.id);
    });
  });

  // ============================================================================ rollback, restart, duplicates, fencing

  describe("atomicity, restart, duplicate delivery and claim fencing", () => {
    it("a failure before commit leaves no session, request or event; T2 records it and the attempt stays charged", async () => {
      const f = await fixture();
      const tr = await trigger(f);
      const hooks: StepHooks = {
        beforeCommit: async () => {
          throw new Error("boom secret@example.com");
        },
      };
      const summary = await run(tr.id, { hooks });
      expect(summary).toMatchObject({
        kind: "failed",
        errorCode: "internal_error",
        recorded: true,
      });
      expect(await sessionsOf(f)).toHaveLength(0);
      expect(await requestsOf(f)).toHaveLength(0);
      expect(await count("bot_session_events")).toBe(0);
      const row = await triggerRow(t, tr.id);
      expect(row).toMatchObject({
        status: "PENDING",
        attempts: 1,
        claim_token: null,
        last_error_code: "internal_error",
      });
      // a later attempt, from nothing, succeeds exactly once
      await makeDue(t, tr.id);
      ok(await run(tr.id), "PROCESSED", "session_started");
      expect(await sessionsOf(f)).toHaveLength(1);
    });

    it("a replay of the same claim after it committed finds nothing to do (duplicate delivery / lost acknowledgement)", async () => {
      const f = await fixture();
      const tr = await trigger(f);
      const claim = await claimOf(tr.id);
      ok(await processTrigger(t.db as never, claim, deps()), "PROCESSED", "session_started");
      expect(await processTrigger(t.db as never, claim, deps())).toEqual({ kind: "lost_claim" });
      expect(await sessionsOf(f)).toHaveLength(1);
      expect(await requestsOf(f)).toHaveLength(1);
    });

    it("a worker whose claim expired and was re-claimed cannot change anything (claim-token fence)", async () => {
      const f = await fixture();
      const tr = await trigger(f);
      const old = await claimOf(tr.id);
      await q(
        "update bot_triggers set claimed_at = clock_timestamp() - interval '2 minutes' where id = $1",
        [tr.id],
      );
      const fresh = await claimOf(tr.id);
      expect(fresh.claimToken).not.toBe(old.claimToken);
      expect(await processTrigger(t.db as never, old, deps())).toEqual({ kind: "lost_claim" });
      expect(await sessionsOf(f)).toHaveLength(0);
      ok(await processTrigger(t.db as never, fresh, deps()), "PROCESSED", "session_started");
    });

    it("a claim older than the 20 s start guard does no work (J.6)", async () => {
      const f = await fixture();
      const tr = await trigger(f);
      const c = await claimOf(tr.id);
      await q(
        "update bot_triggers set claimed_at = clock_timestamp() - interval '25 seconds' where id = $1",
        [tr.id],
      );
      expect(await processTrigger(t.db as never, c, deps())).toEqual({ kind: "lost_claim" });
      expect(await sessionsOf(f)).toHaveLength(0);
    });

    it("both gates are required: with either off T1 reads and writes nothing", async () => {
      const f = await fixture();
      const tr = await trigger(f);
      const c = await claimOf(tr.id);
      for (const config of [
        { ...BOTS_ON, botsRuntimeEnabled: false },
        { ...BOTS_ON, outboundEnabled: false },
      ])
        expect(await processTrigger(t.db as never, c, deps({ config }))).toEqual({
          kind: "gates_off",
        });
      expect(await triggerRow(t, tr.id)).toMatchObject({ status: "PENDING", attempts: 1 });
      expect(await sessionsOf(f)).toHaveLength(0);
    });

    it("tenant isolation: another organization's claim token or ids can neither finish nor read this trigger", async () => {
      const a = await fixture();
      const b = await fixture();
      const tr = await trigger(a);
      const c = await claimOf(tr.id);
      expect(
        await processTrigger(t.db as never, { ...c, organizationId: b.w.org.id }, deps()),
      ).toEqual({ kind: "lost_claim" });
      expect(await triggerRow(t, tr.id)).toMatchObject({ status: "PENDING" });
    });

    it("a post-enqueue clock skew rolls the whole step back and re-decides the trigger alone (E-CLK)", async () => {
      const f = await fixture();
      const tr = await trigger(f);
      let reads = 0;
      // reads: 1 = decision clock, 2 = post-enqueue check (skewed by +3 s), 3 = recovery clock
      const skewed = async (tx: DbExecutor) => {
        const now = await dbClock(tx);
        reads++;
        return reads === 2 ? new Date(now.getTime() + 3_000) : now;
      };
      const summary = await run(tr.id, { readClock: skewed });
      expect(summary).toMatchObject({ kind: "deferred" });
      expect(await sessionsOf(f)).toHaveLength(0);
      expect(await requestsOf(f)).toHaveLength(0);
      expect(await triggerRow(t, tr.id)).toMatchObject({
        status: "PENDING",
        attempts: 0,
        deferrals: 1,
        claim_token: null,
      });
    });
  });

  // ===================================================================================== continuation (R2, ENG)

  describe("continuation and the apply path (R2)", () => {
    it("early reply while the prompt is SENDING is deferred once: one PROMPT_INTERACTION, refund, no second request; then applied once after ACCEPTED", async () => {
      const f = await fixture();
      const { session } = await startMenu(f);
      const token = session.awaiting_token as string;
      // the dispatcher claims the prompt (SENDING) and has not finished
      const transport = new FakeTransport().next({
        kind: "accepted",
        wamid: "wamid.OUT.1",
        providerStatus: "accepted",
        httpStatus: 200,
      });
      const d = {
        db: t.db as never,
        transport,
        config: BOTS_ON,
        random: () => 0.5,
        accountMinIntervalMs: 0,
        conversationMinIntervalMs: 0,
      };
      const { claim } = await claimNext(d);
      expect((await requestsOf(f))[0]).toMatchObject({ state: "SENDING" });

      const reply = await trigger(f, {
        type: "INTERACTIVE",
        body: "A",
        content: replyContent(token, "a"),
      });
      expect(await run(reply.id)).toMatchObject({ kind: "deferred" });
      expect(await triggerRow(t, reply.id)).toMatchObject({
        status: "PENDING",
        attempts: 0,
        deferrals: 1,
        claim_token: null,
      });
      expect((await eventsOf(session.id as string)).map((e) => e.kind)).toEqual([
        "PROMPT_INTERACTION",
      ]);
      expect(await liveSession(f)).toMatchObject({
        revision: 1,
        invalid_attempts: 0,
        awaiting_token: token,
      });
      expect(await requestsOf(f)).toHaveLength(1);

      // the same deferral again adds no second interaction event (unique per session and message)
      await makeDue(t, reply.id);
      expect(await run(reply.id)).toMatchObject({ kind: "deferred" });
      expect(await count("bot_session_events", "kind = 'PROMPT_INTERACTION'")).toBe(1);

      expect(await executeClaim(d, claim!)).toBe("accepted");
      await makeDue(t, reply.id);
      ok(await run(reply.id), "PROCESSED", "input_accepted");
      const after = await liveSession(f);
      expect(after).toMatchObject({
        state: "WAITING_FOR_SEND",
        step_seq: 2,
        last_consumed_token: token,
        last_input_message_id: reply.messageId,
      });
      const reqs = await requestsOf(f);
      expect(reqs.map((r) => [r.bot_step_seq, r.state])).toEqual([
        [1, "ACCEPTED"],
        [2, "QUEUED"],
      ]);
      expect((await eventsOf(session.id as string)).map((e) => e.kind).sort()).toEqual([
        "INPUT_ACCEPTED",
        "PROMPT_INTERACTION",
      ]);
    });

    it("a reply after acceptance is applied exactly once; the same tap again is a duplicate (uncounted, no event)", async () => {
      const f = await fixture();
      const { session } = await startMenu(f);
      const token = session.awaiting_token as string;
      await dispatchAccepted();
      const first = await trigger(f, {
        type: "INTERACTIVE",
        body: "A",
        content: replyContent(token, "a"),
      });
      ok(await run(first.id), "PROCESSED", "input_accepted");
      // the next prompt is queued and accepted; the same tap arriving again (a new message carrying the consumed token) is a duplicate
      await dispatchAccepted();
      const again = await trigger(f, {
        type: "INTERACTIVE",
        body: "A",
        content: replyContent(token, "a"),
      });
      ok(await run(again.id), "IGNORED", "duplicate_reply");
      expect(await count("bot_session_events", "kind = 'INPUT_ACCEPTED'")).toBe(1);
      expect(await count("bot_session_events", "kind = 'INPUT_REJECTED'")).toBe(0);
      expect(await liveSession(f)).toMatchObject({
        state: "WAITING_FOR_INPUT",
        invalid_attempts: 0,
      });
      expect(await requestsOf(f)).toHaveLength(2);
    });

    it("HELD prompt: the reply hands the session over (send_held), the request is untouched, the trigger is IGNORED session_ended", async () => {
      const f = await fixture();
      const { session } = await startMenu(f);
      await q(
        "update outbound_requests set state = 'HELD', hold_reason = 'bot_stopped', finished_at = clock_timestamp() where bot_session_id = $1",
        [session.id],
      );
      const reply = await trigger(f, {
        type: "INTERACTIVE",
        body: "A",
        content: replyContent(session.awaiting_token as string, "a"),
      });
      ok(await run(reply.id), "IGNORED", "session_ended");
      expect(await liveSession(f)).toMatchObject({
        state: "HANDED_OVER",
        end_reason: "system_handover",
        handover_reason: "send_held",
      });
      expect((await eventsOf(session.id as string)).map((e) => [e.kind, e.code])).toEqual([
        ["HANDED_OVER", "send_held_bot_stopped"],
      ]);
      expect((await requestsOf(f))[0]).toMatchObject({ state: "HELD", hold_reason: "bot_stopped" });
    });

    it("REJECTED and UNKNOWN_OUTCOME prompts hand over without touching the request", async () => {
      for (const [result, reason, state] of [
        [
          { kind: "rejected", reason: "bad", httpStatus: 400, providerErrorCode: "131" },
          "send_rejected",
          "REJECTED",
        ],
        [new Error("socket"), "send_outcome_unknown", "UNKNOWN_OUTCOME"],
      ] as const) {
        const f = await fixture();
        const { session } = await startMenu(f);
        const transport = new FakeTransport().next(result as never);
        const d = {
          db: t.db as never,
          transport,
          config: BOTS_ON,
          random: () => 0.5,
          accountMinIntervalMs: 0,
          conversationMinIntervalMs: 0,
        };
        const { claim } = await claimNext(d);
        await executeClaim(d, claim!);
        expect((await requestsOf(f))[0].state).toBe(state);
        const reply = await trigger(f, {
          type: "INTERACTIVE",
          body: "A",
          content: replyContent(session.awaiting_token as string, "a"),
        });
        ok(await run(reply.id), "IGNORED", "session_ended");
        expect(await liveSession(f)).toMatchObject({
          state: "HANDED_OVER",
          handover_reason: reason,
        });
        expect((await requestsOf(f))[0].state).toBe(state);
        expect(await requestsOf(f)).toHaveLength(1);
        await q("truncate organizations, webhook_requests cascade");
      }
    });

    it("END notice (R8-A) and HANDOVER notice (R8-B) are enqueued with the terminal session in one commit", async () => {
      for (const [path, finalState, endReason] of [
        [["a", "ok"], "COMPLETED", "flow_end"],
        [["b"], "HANDED_OVER", "flow_handover"],
      ] as const) {
        const f = await fixture();
        let { session } = await startMenu(f);
        for (const key of path) {
          await dispatchAccepted();
          const tr = await trigger(f, {
            type: "INTERACTIVE",
            body: key,
            content: replyContent(session.awaiting_token as string, key),
          });
          ok(await run(tr.id), "PROCESSED", "input_accepted");
          session = await liveSession(f);
        }
        const end = await liveSession(f);
        expect(end).toMatchObject({ state: finalState, end_reason: endReason });
        expect(end.terminal_notice_step_seq).toBe(end.step_seq);
        const last = (await requestsOf(f)).at(-1)!;
        expect(last).toMatchObject({ state: "QUEUED", bot_step_seq: end.step_seq });
        await q("truncate organizations, webhook_requests cascade");
      }
    });

    it("a missing pinned version hands the session over (bot_error) and finishes the trigger without a retry", async () => {
      const f = await fixture();
      const { session } = await startMenu(f);
      await dispatchAccepted();
      // a version row can never be deleted; make the session's version unreadable to the runtime by a cache that reports it invalid
      const flows = {
        load: async () => ({ ok: false, reason: "missing" }),
      } as unknown as FlowCache;
      const tr = await trigger(f, {
        type: "INTERACTIVE",
        body: "A",
        content: replyContent(session.awaiting_token as string, "a"),
      });
      ok(await run(tr.id, { flows }), "PROCESSED", "flow_invalid");
      expect(await liveSession(f)).toMatchObject({
        state: "HANDED_OVER",
        handover_reason: "bot_error",
      });
      expect((await eventsOf(session.id as string)).map((e) => e.code).sort()).toEqual([
        "bot_error",
        "flow_missing",
      ]);
    });

    it("a malformed session row goes to the engine's SESSION_INVALID error node and is not repaired", async () => {
      const f = await fixture();
      const { session } = await startMenu(f);
      await dispatchAccepted();
      await updateSession(t.pool, session.id as string, "awaiting = NULL"); // WAITING_FOR_SEND must have awaiting
      const tr = await trigger(f, {
        type: "INTERACTIVE",
        body: "A",
        content: replyContent(session.awaiting_token as string, "a"),
      });
      ok(await run(tr.id), "PROCESSED", "engine_error");
      const s = await liveSession(f);
      expect(s).toMatchObject({ state: "HANDED_OVER", end_reason: "error", variables: {} });
      expect((await eventsOf(session.id as string)).map((e) => e.code)).toContain(
        "session_invalid",
      );
    });

    it("a staff reply after the session started ends it (staff_replied) before the engine runs; nothing is consumed", async () => {
      const f = await fixture();
      const { session } = await startMenu(f);
      await q(
        "insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_assignee_membership_id, to_assignee_membership_id) values ($1,$2,'ASSIGNMENT',$3,NULL,$3)",
        [f.w.org.id, f.w.student.conversation.id, f.w.staff.membershipId],
      );
      const tr = await trigger(f, {
        type: "INTERACTIVE",
        body: "A",
        content: replyContent(session.awaiting_token as string, "a"),
      });
      ok(await run(tr.id), "IGNORED", "session_ended");
      expect(await liveSession(f)).toMatchObject({
        state: "HANDED_OVER",
        handover_reason: "staff_assigned",
      });
      expect(await requestsOf(f)).toHaveLength(1);
      expect((await eventsOf(session.id as string)).map((e) => e.kind)).toEqual(["HANDED_OVER"]);
    });
  });

  // =============================================================================== staleness (R9, R9b) and lock-busy (R9c)

  describe("staleness first", () => {
    const at = (ms: number) => async () => new Date(ms);

    it("a continuation older than maxInputAge is IGNORED stale_trigger and writes nothing to the session (R9b), boundary exactly 10:00 vs +1 ms", async () => {
      const f = await fixture();
      const { session } = await startMenu(f);
      await dispatchAccepted();
      const input = new Date(Date.now() - 1000);
      const before = await rowJson("bot_sessions", session.id as string);
      const stale = await trigger(f, {
        type: "INTERACTIVE",
        body: "A",
        content: replyContent(session.awaiting_token as string, "a"),
        inputAt: input,
      });
      ok(
        await run(stale.id, { readClock: at(input.getTime() + 10 * MIN + 1) }),
        "IGNORED",
        "stale_trigger",
      );
      expect(await rowJson("bot_sessions", session.id as string)).toEqual(before);
      expect(await count("bot_session_events")).toBe(0);
      expect(await triggerRow(t, stale.id)).toMatchObject({
        attempts: 1,
        deferrals: 0,
        last_error_code: null,
        claim_token: null,
      });

      // exactly ten minutes is still processed; a stale tap left the token unconsumed
      const fresh = await trigger(f, {
        type: "INTERACTIVE",
        body: "A",
        content: replyContent(session.awaiting_token as string, "a"),
        inputAt: input,
      });
      ok(
        await run(fresh.id, { readClock: at(input.getTime() + 10 * MIN) }),
        "PROCESSED",
        "input_accepted",
      );
    });

    it("a start trigger deferred behind an in-flight notice becomes IGNORED stale_trigger, never DEAD (R9)", async () => {
      const f = await fixture(endFirstFlow("Bye"));
      ok(await run((await trigger(f, { body: "menu" })).id), "PROCESSED", "session_started");
      expect((await requestsOf(f))[0].state).toBe("QUEUED"); // the notice, in flight
      const input = new Date(Date.now() - 1000);
      const next = await trigger(f, { body: "menu", inputAt: input });
      expect(await run(next.id, { readClock: at(input.getTime() + 2000) })).toMatchObject({
        kind: "deferred",
        reason: "bot_request_in_flight",
      });
      expect(await triggerRow(t, next.id)).toMatchObject({
        status: "PENDING",
        attempts: 0,
        deferrals: 1,
      });
      await makeDue(t, next.id);
      ok(
        await run(next.id, { readClock: at(input.getTime() + 11 * MIN) }),
        "IGNORED",
        "stale_trigger",
      );
      expect(await triggerRow(t, next.id)).toMatchObject({
        status: "IGNORED",
        last_error_code: null,
      });
      expect(await requestsOf(f)).toHaveLength(1);
    });
  });

  describe("lock-busy freshness (R9c A-D)", () => {
    const hold = (key: string) =>
      barriers.hold("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);

    for (const kind of ["conversation", "contact"] as const)
      for (const stale of [true, false])
        it(`${kind} lock busy, ${stale ? "stale" : "fresh"} input`, async () => {
          const f = await fixture();
          const contactId = f.w.student.contact.id;
          const key =
            kind === "conversation"
              ? `bot-conv:${f.w.org.id}:${f.w.student.conversation.id}`
              : `bot-contact:${f.w.org.id}:${contactId}`;
          const input = new Date(Date.now() - (stale ? 11 * MIN : 1000));
          const tr = await trigger(f, { inputAt: input });
          const h = await hold(key);
          expect(h.pid).toBeGreaterThan(0);
          const summary = await run(tr.id);
          const row = await triggerRow(t, tr.id);
          if (stale) {
            expect(summary).toMatchObject({
              kind: "finished",
              status: "IGNORED",
              outcome: "stale_trigger",
            });
            expect(row).toMatchObject({
              status: "IGNORED",
              attempts: 1,
              deferrals: 0,
              claim_token: null,
              last_error_code: null,
            });
          } else {
            expect(summary).toMatchObject({ kind: "deferred" });
            expect(row).toMatchObject({
              status: "PENDING",
              attempts: 0,
              deferrals: 1,
              claim_token: null,
              processed_at: null,
            });
            expect(
              Number(
                await one(
                  "select extract(epoch from (next_attempt_at - clock_timestamp()))::float8 s from bot_triggers where id = $1",
                  [tr.id],
                ).then((r) => r.s),
              ),
            ).toBeGreaterThan(0);
          }
          expect(await sessionsOf(f)).toHaveLength(0);
          expect(await requestsOf(f)).toHaveLength(0);
          expect(await count("bot_session_events")).toBe(0);
          await h.abort();
        });
  });

  // ========================================================================================== R4 restart after handover

  describe("restart after handover (R4)", () => {
    const resolve = (f: Fx) =>
      q(
        "insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_status, to_status) values ($1,$2,'STATUS',$3,'OPEN','RESOLVED')",
        [f.w.org.id, f.w.student.conversation.id, f.w.staff.membershipId],
      );
    const controlSeq = async (f: Fx) =>
      Number(
        (
          await one("select control_seq from conversations where id = $1", [
            f.w.student.conversation.id,
          ])
        ).control_seq,
      );
    /** A handed-over session whose end is far enough in the past for the cooldown, with the conversation reopened. */
    async function handedOver(f: Fx) {
      ok(await run((await trigger(f, { body: "menu" })).id), "PROCESSED", "session_started");
      await dispatchAccepted(); // the notice is delivered, so nothing is in flight
      return liveSession(f);
    }
    const later = (ms: number) => async (tx: DbExecutor) =>
      new Date((await dbClock(tx)).getTime() + ms);

    it("A: a new conversation with a keyword starts; B: an unresolved handover ignores a fresh keyword", async () => {
      const f = await fixture(handoverFirstFlow());
      ok(await run((await trigger(f, { body: "menu" })).id), "PROCESSED", "session_started");
      ok(await run((await trigger(f, { body: "menu" })).id), "IGNORED", "handover_unresolved");
    });

    it("C: after the handover, a staff resolution and the cooldown, a fresh input committed after the resolution starts a new session", async () => {
      const f = await fixture(handoverFirstFlow());
      const first = await handedOver(f);
      await resolve(f);
      await q("update conversations set status = 'OPEN' where id = $1", [
        f.w.student.conversation.id,
      ]);
      const tr = await trigger(f, {
        body: "menu",
        observed: await controlSeq(f),
        inputAt: freshAt(31 * MIN),
      });
      ok(await run(tr.id, { readClock: later(31 * MIN) }), "PROCESSED", "session_started");
      const all = await sessionsOf(f);
      expect(all).toHaveLength(2);
      expect(Number(all[1]!.started_control_seq)).toBeGreaterThan(
        Number(first.handover_control_seq),
      );
    });

    it("D: an input older than the resolution is IGNORED input_before_resolution", async () => {
      const f = await fixture(handoverFirstFlow());
      await handedOver(f);
      const old = await trigger(f, { body: "menu", inputAt: new Date(Date.now() - 5000) });
      await resolve(f);
      await q("update conversations set status = 'OPEN' where id = $1", [
        f.w.student.conversation.id,
      ]);
      await q("update bot_triggers set observed_control_seq = $2 where id = $1", [
        old.id,
        await controlSeq(f),
      ]);
      ok(await run(old.id, { readClock: later(31 * MIN) }), "IGNORED", "input_before_resolution");
    });

    it("E: still assigned after the resolution is IGNORED conversation_assigned; restart changes nothing", async () => {
      const f = await fixture(handoverFirstFlow());
      await handedOver(f);
      await resolve(f);
      await q(
        "update conversations set status = 'OPEN', assigned_membership_id = $2, assigned_at = clock_timestamp() where id = $1",
        [f.w.student.conversation.id, f.w.staff.membershipId],
      );
      const tr = await trigger(f, {
        body: "menu",
        observed: await controlSeq(f),
        inputAt: freshAt(31 * MIN),
      });
      const c1 = await claimOf(tr.id);
      // a worker that dies after T0 and a restarted one decide the same thing from the database alone
      await q(
        "update bot_triggers set claimed_at = clock_timestamp() - interval '2 minutes' where id = $1",
        [tr.id],
      );
      ok(
        await processTrigger(
          t.db as never,
          await claimOf(tr.id),
          deps({ readClock: later(31 * MIN) }),
        ),
        "IGNORED",
        "conversation_assigned",
      );
      expect(await processTrigger(t.db as never, c1, deps())).toEqual({ kind: "lost_claim" });
    });
  });

  // ============================================================================================ R7 staff before start

  describe("staff intervention before the bot starts (R7 A-E)", () => {
    const event = (f: Fx, kind: "ASSIGNMENT" | "STATUS", to?: string) =>
      kind === "ASSIGNMENT"
        ? q(
            "insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_assignee_membership_id, to_assignee_membership_id) values ($1,$2,'ASSIGNMENT',$3,$4,$5)",
            [
              f.w.org.id,
              f.w.student.conversation.id,
              f.w.staff.membershipId,
              to ? null : f.w.staff.membershipId,
              to ? f.w.staff.membershipId : null,
            ],
          )
        : q(
            "insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_status, to_status) values ($1,$2,'STATUS',$3,'OPEN',$4)",
            [f.w.org.id, f.w.student.conversation.id, f.w.staff.membershipId, to],
          );

    it("A: a staff action committed between the inbound and the start decision supersedes it; no session, no request", async () => {
      const f = await fixture(messageFlow());
      const tr = await trigger(f, { body: "menu", observed: 0 });
      await event(f, "ASSIGNMENT", "x"); // control_seq 1 > t = 0
      await q("update conversations set assigned_membership_id = NULL where id = $1", [
        f.w.student.conversation.id,
      ]);
      ok(await run(tr.id), "IGNORED", "superseded_by_staff");
      expect(await sessionsOf(f)).toHaveLength(0);
      expect(await requestsOf(f)).toHaveLength(0);
    });

    it("B: a resolution before the start decision supersedes it", async () => {
      const f = await fixture(messageFlow());
      const tr = await trigger(f, { body: "menu", observed: 0 });
      await event(f, "STATUS", "RESOLVED");
      ok(await run(tr.id), "IGNORED", "superseded_by_staff");
      expect(await sessionsOf(f)).toHaveLength(0);
    });

    it("E: assignment then unassignment: the first trigger is superseded, a later fresh one is staff_engaged until a resolution", async () => {
      const f = await fixture(messageFlow());
      const first = await trigger(f, { body: "menu", observed: 0 });
      await event(f, "ASSIGNMENT", "x");
      await event(f, "ASSIGNMENT");
      await q("update conversations set assigned_membership_id = NULL where id = $1", [
        f.w.student.conversation.id,
      ]);
      ok(await run(first.id), "IGNORED", "superseded_by_staff");
      const seq = Number(
        (
          await one("select control_seq from conversations where id = $1", [
            f.w.student.conversation.id,
          ])
        ).control_seq,
      );
      const second = await trigger(f, { body: "menu", observed: seq });
      ok(await run(second.id), "IGNORED", "staff_engaged");
    });

    it("C/D: after a resolution (and cooldown) a fresh enquiry starts a new session whose control sequence follows it", async () => {
      const f = await fixture(messageFlow());
      await event(f, "ASSIGNMENT", "x");
      await event(f, "STATUS", "RESOLVED");
      await q(
        "update conversations set status = 'OPEN', assigned_membership_id = NULL where id = $1",
        [f.w.student.conversation.id],
      );
      const seq = Number(
        (
          await one("select control_seq from conversations where id = $1", [
            f.w.student.conversation.id,
          ])
        ).control_seq,
      );
      const tr = await trigger(f, { body: "menu", observed: seq, inputAt: freshAt(31 * MIN) });
      ok(
        await run(tr.id, {
          readClock: async (tx) => new Date((await dbClock(tx)).getTime() + 31 * MIN),
        }),
        "PROCESSED",
        "session_started",
      );
      const s = await liveSession(f);
      expect(Number(s.started_control_seq)).toBeGreaterThan(seq);
      expect(await requestsOf(f)).toHaveLength(1);
    });
  });

  // =============================================================================== first_message durability (D.4a)

  describe("first_message durability", () => {
    const later = (ms: number) => async (tx: DbExecutor) =>
      new Date((await dbClock(tx)).getTime() + ms);
    it("after a first_message session completes and the cooldown passes, a later message whose record key sorts EARLIER cannot start first_message again", async () => {
      const f = await fixture(messageFlow({ kind: "first_message" }));
      const a = await trigger(f);
      ok(await run(a.id), "PROCESSED", "session_started");
      await dispatchAccepted();
      // finish the session through a student input on the MESSAGE: acceptance applies, END, notice
      const probe = await trigger(f, { body: "anything" });
      ok(await run(probe.id), "IGNORED", "session_ended");
      await dispatchAccepted(); // the notice
      expect(await liveSession(f)).toMatchObject({ state: "COMPLETED" });
      // a delayed transaction: its record key sorts before A's, yet it arrives afterwards
      const b = await trigger(f, { inputAt: freshAt(31 * MIN) });
      await q(
        "update messages set created_at = (select created_at from messages where id = $1) - interval '1 hour' where id = $2",
        [a.messageId, b.messageId],
      );
      ok(await run(b.id, { readClock: later(31 * MIN) }), "IGNORED", "no_trigger_match");
      expect(await sessionsOf(f)).toHaveLength(1);
    });

    it("an earlier eligible message that never started a session prevents first_message; media do not count", async () => {
      const f = await fixture(messageFlow({ kind: "first_message" }));
      // the seeded inbound message is eligible history that never started anything (no trigger was ever captured for it)
      // the candidate is a LATER message; the seeded one must not be the candidate (it would itself be the first eligible message)
      const candidate = await trigger(f, { messageId: await inbound(f) });
      const rowsFor = (messageId: string, fx: Fx) =>
        t.db.transaction((tx) =>
          readFirstEligibleRows(tx as never, {
            organizationId: fx.w.org.id,
            conversationId: fx.w.student.conversation.id,
            messageId,
          }),
        );
      expect(await rowsFor(candidate.messageId, f)).toEqual({
        firstInRecordHistory: false,
        noPreviousSessionStart: true,
        evidenceDefect: false,
      });
      expect((await rowsFor(f.w.student.message.id, f)).firstInRecordHistory).toBe(true);
      ok(await run(candidate.id), "IGNORED", "no_trigger_match");
      // positive control: a conversation whose only earlier message is media
      const g = await fixture(messageFlow({ kind: "first_message" }));
      await q("update messages set type = 'IMAGE', body = NULL where id = $1", [
        g.w.student.message.id,
      ]);
      const gCandidate = await trigger(g, { messageId: await inbound(g) });
      ok(await run(gCandidate.id), "PROCESSED", "session_started");
    });

    it("INTERACTIVE and BUTTON may be the first eligible message; an interactive start consumes no token and writes no INPUT event", async () => {
      for (const [type, content] of [
        ["INTERACTIVE", { subtype: "button_reply", id: "b1.AAAAAAAAAAAAAAAAAAAAAA.a", title: "A" }],
        ["BUTTON", { payload: "p", text: "t" }],
      ] as const) {
        const f = await fixture(messageFlow({ kind: "first_message" }));
        const tr = await trigger(f, { type, body: "x", content });
        ok(await run(tr.id), "PROCESSED", "session_started");
        const s = await liveSession(f);
        expect(await eventsOf(s.id as string)).toEqual([]);
        await q("truncate organizations, webhook_requests cascade");
      }
    });

    it("referral_source needs an attribution for the exact message AND the conversation's contact", async () => {
      const f = await fixture(messageFlow({ kind: "referral_source" }));
      const wrong = await trigger(f);
      const other = await seedContact(t.db, f.w.org.id);
      await q(
        "insert into lead_attributions (organization_id, contact_id, message_id, source_type, received_at) values ($1,$2,$3,'META_AD', clock_timestamp())",
        [f.w.org.id, other.id, wrong.messageId],
      );
      ok(await run(wrong.id), "IGNORED", "no_trigger_match");
      const right = await trigger(f);
      await q(
        "insert into lead_attributions (organization_id, contact_id, message_id, source_type, received_at) values ($1,$2,$3,'META_AD', clock_timestamp())",
        [f.w.org.id, f.w.student.contact.id, right.messageId],
      );
      ok(await run(right.id), "PROCESSED", "session_started");
    });
  });

  // ========================================================================================== per-contact cap (R-CAP)

  /** One contact, three WhatsApp accounts: two recent ended sessions on the third; a start trigger on each of the first two. */
  async function capWorld() {
    const w = await botWorld(t.db);
    const base = await fixture(messageFlow({ kind: "first_message" }), w);
    const contact = w.student.contact;
    const accounts = [w.account.id];
    for (let i = 0; i < 2; i++) {
      const acc = await seedAccount(t.db, w.org.id);
      await activateAccount(acc.id);
      accounts.push(acc.id);
    }
    const convs: Student[] = [w.student];
    for (const id of accounts.slice(1)) {
      const conversation = await seedConversation(t.db, {
        organizationId: w.org.id,
        whatsappAccountId: id,
        contactId: contact.id,
      });
      await openWindow(conversation.id);
      const m = await q(
        "insert into messages (organization_id, conversation_id, whatsapp_account_id, wamid, direction, type, body, occurred_at) values ($1,$2,$3,$4,'INBOUND','TEXT','hi',clock_timestamp()) returning id",
        [w.org.id, conversation.id, id, `wamid.${randomUUID()}`],
      );
      convs.push({ contact, conversation, message: { id: m.rows[0].id } });
      await activateDeployment(
        w.admin.ctx,
        { botId: base.bot.id, versionId: base.version.id, whatsappAccountId: id, priority: 1 },
        { db: t.db },
      );
    }
    // two recent sessions of the contact on the third account's conversation (each ended)
    const third = convs[2]!;
    const dep3 = (
      await one("select id from bot_deployments where whatsapp_account_id = $1", [accounts[2]])
    ).id as string;
    for (let i = 0; i < 2; i++) {
      const s = await insertSession(t.pool, {
        organizationId: w.org.id,
        botId: base.bot.id,
        versionId: base.version.id,
        deploymentId: dep3,
        whatsappAccountId: accounts[2]!,
        student: third,
      });
      await q(
        "update bot_sessions set state = 'COMPLETED', end_reason = 'flow_end', revision = revision + 1 where id = $1",
        [s.id],
      );
    }
    const t1 = await trigger({ ...base, w: { ...w, account: { id: accounts[0]! } } } as Fx, {
      student: convs[0]!,
    });
    const t2Fx = { ...base, w: { ...w, account: { id: accounts[1]! } } } as Fx;
    const t2 = await trigger(t2Fx, { student: convs[1]!, messageId: convs[1]!.message.id });
    return { w, contact, t1, t2 };
  }

  describe("per-contact session cap across accounts (R-CAP)", () => {
    it("two concurrent starts of one contact with two recent sessions create at most one more; the loser defers, then ends session_cap", async () => {
      const { w, contact, t1, t2 } = await capWorld();

      // worker A takes the contact lock and pauses; worker B must not wait
      let release!: () => void;
      const paused = new Promise<void>((r) => (release = r));
      let reached!: () => void;
      const atLock = new Promise<void>((r) => (reached = r));
      // ONE claim statement takes every due trigger (limit 50): claim both together, then pick each worker's claim
      const claimed = await claimTriggers(t.db, 50);
      const claimA = claimed.find((c) => c.id === t1.id)!;
      const claimB = claimed.find((c) => c.id === t2.id)!;
      expect(claimA && claimB, "both triggers must be claimed by the one statement").toBeTruthy();
      const a = barriers.settle(
        processTrigger(
          t.db as never,
          claimA,
          deps({
            hooks: {
              afterAdvisoryLocks: async () => {
                reached();
                await paused;
              },
            },
          }),
        ),
      );
      await atLock;
      const b = await processTrigger(t.db as never, claimB, deps());
      expect(b).toMatchObject({ kind: "deferred", reason: "contact_busy" });
      expect(await triggerRow(t, t2.id)).toMatchObject({
        status: "PENDING",
        attempts: 0,
        deferrals: 1,
      });
      release();
      const resA = await a;
      expect(resA.ok && resA.value).toMatchObject({ kind: "finished", outcome: "session_started" });
      await makeDue(t, t2.id);
      ok(
        await processTrigger(t.db as never, await claimOf(t2.id), deps()),
        "IGNORED",
        "session_cap",
      );
      expect(
        await count("bot_sessions", "organization_id = $1 and contact_id = $2", [
          w.org.id,
          contact.id,
        ]),
      ).toBe(3);
    });
  });

  // ============================================================================================ E-HOURLY (C-4)

  describe("hourly cap window (C-4)", () => {
    it("counts BOT requests created in (clock - 60 min, clock] in any state; boundaries are exact", async () => {
      const f = await fixture();
      const { session } = await startMenu(f);
      const created = (
        await one(
          "select created_at, extract(epoch from created_at) * 1000 ms from outbound_requests where bot_session_id = $1",
          [session.id],
        )
      ).ms as number;
      const ms = Math.floor(Number(created));
      const c = (clock: number) =>
        t.db.transaction((tx) =>
          countRecentBotRequests(
            tx as never,
            f.w.org.id,
            f.w.student.conversation.id,
            new Date(clock),
            60 * MIN,
          ),
        );
      expect(await c(ms)).toBe(1); // at the clock: included
      expect(await c(ms - 1)).toBe(0); // created after the clock: excluded
      expect(await c(ms + 60 * MIN - 1)).toBe(1); // 59:59.999 old: included
      expect(await c(ms + 60 * MIN + 1)).toBe(0); // beyond 60:00: excluded
      await q(
        "update outbound_requests set state = 'HELD', hold_reason = 'test_isolation', finished_at = clock_timestamp() where bot_session_id = $1",
        [session.id],
      );
      expect(await c(ms)).toBe(1); // any state counts
    });
  });

  // ================================================================================== hourly cap: refusal and replay (C-4)

  type HourlyWorld = Awaited<ReturnType<typeof hourlyWorld>>;
  const HTOKEN = "H".repeat(22);
  /** A live session of the menu flow waiting for input at step `existing`, with `existing` BOT requests (all HELD) in the last hour. */
  async function hourlyWorld(existing: number) {
    const f = await fixture(menuFlow());
    const df = { w: f.w, d: { bot: f.bot, version: f.version, deployment: f.deployment } } as never;
    const s = await liveSessionFor(t, df, f.w.student);
    for (let i = 1; i <= existing; i++) {
      await queueBotStep(t, df, s, { stepSeq: i, message: textMessage(), now: new Date() });
      await q(
        "update outbound_requests set state = 'HELD', hold_reason = 'test_isolation', finished_at = clock_timestamp() where bot_session_id = $1 and bot_step_seq = $2",
        [s.id, i],
      );
    }
    await updateSession(
      t.pool,
      s.id,
      "state = 'WAITING_FOR_INPUT', current_node_id = 'ask', awaiting = $1::jsonb, awaiting_token = $2, step_seq = $3, send_count = 3, transition_count = 1, expires_at = clock_timestamp() + interval '10 minutes', send_wait_expires_at = NULL",
      [
        JSON.stringify({ nodeId: "ask", kind: "BUTTONS", phase: "SENT", optionKeys: ["a", "b"] }),
        HTOKEN,
        existing,
      ],
    );
    return { f, sessionId: s.id };
  }
  const authorityFor = (h: HourlyWorld) => ({
    kind: "BOT" as const,
    organizationId: h.f.w.org.id,
    botSessionId: h.sessionId,
    deploymentId: h.f.deployment.id,
    botVersionId: h.f.version.id,
    whatsappAccountId: h.f.w.account.id,
    conversationId: h.f.w.student.conversation.id,
    contactId: h.f.w.student.contact.id,
    sendEpoch: 1,
  });
  const textEffect = (stepSeq: number) => ({
    type: "SEND" as const,
    stepSeq,
    nodeId: "welcome",
    terminalNotice: false,
    message: { kind: "text" as const, text: "Hello from the bot" },
  });
  const enqueueDirect = (h: HourlyWorld, stepSeq: number) =>
    t.db.transaction((tx) =>
      enqueueEffect(tx as never, deps(), authorityFor(h), textEffect(stepSeq), new Date()),
    );

  describe("hourly cap: refusal handover and replay exemption (C-4)", () => {
    it("the 30th request of the hour is allowed; the 31st is refused and hands the session over (send_refused) without consuming the input", async () => {
      // 29 existing: the next send (the 30th) is allowed
      const allowed = await hourlyWorld(29);
      const reply = await trigger(allowed.f, {
        type: "INTERACTIVE",
        body: "A",
        content: replyContent(HTOKEN, "a"),
      });
      ok(await run(reply.id), "PROCESSED", "input_accepted");
      expect(await liveSession(allowed.f)).toMatchObject({
        state: "WAITING_FOR_SEND",
        step_seq: 30,
      });
      expect(await requestsOf(allowed.f)).toHaveLength(30);
      await q("truncate organizations, webhook_requests cascade");

      // 30 existing: the next send is refused
      const h = await hourlyWorld(30);
      const before = await rowJson("bot_sessions", h.sessionId);
      const tr = await trigger(h.f, {
        type: "INTERACTIVE",
        body: "A",
        content: replyContent(HTOKEN, "a"),
      });
      ok(await run(tr.id), "PROCESSED", "send_refused");
      const after = await liveSession(h.f);
      expect(after).toMatchObject({
        state: "HANDED_OVER",
        end_reason: "system_handover",
        handover_reason: "send_refused",
        awaiting: null,
        awaiting_token: null,
        last_consumed_token: null, // the engine's consumption was discarded with its result
        step_seq: 30,
        revision: Number(before.revision) + 1,
      });
      expect(after.output_suppressed_at).toBeTruthy();
      expect(Number(after.handover_control_seq)).toBeGreaterThan(Number(after.started_control_seq));
      expect(await requestsOf(h.f)).toHaveLength(30); // no new request, none in flight
      expect(
        (await requestsOf(h.f)).filter((r) => ["QUEUED", "SENDING"].includes(r.state as string)),
      ).toEqual([]);
      expect((await eventsOf(h.sessionId)).map((e) => [e.kind, e.code])).toEqual([
        ["HANDED_OVER", "bot_hourly_cap"],
      ]);
      expect(await triggerRow(t, tr.id)).toMatchObject({
        status: "PROCESSED",
        outcome_code: "send_refused",
        claim_token: null,
      });
    });

    it("an idempotent replay at the cap is neither refused nor counted again; a genuinely new step is refused", async () => {
      const h = await hourlyWorld(30);
      const first = await enqueueDirect(h, 30); // step 30 already has its request, with identical content
      expect(first).toMatchObject({ ok: true, replayed: true });
      expect(await requestsOf(h.f)).toHaveLength(30);
      expect(await enqueueDirect(h, 31)).toEqual({ ok: false, reason: "bot_hourly_cap" });
      expect(await requestsOf(h.f)).toHaveLength(30);
    });
  });

  // ========================================================================================= mutation evidence (08E-4)
  //
  // Each test runs the regression scenario against the REAL implementation (the control, which must pass the invariant), then
  // against the same scenario with exactly one safety mechanism substituted through the mock seam at the top of this file, and
  // asserts the observable violation the mutant produces. The control's isolation checks prove the scenario is decided by the
  // mechanism under test and not by another rule. Production code is never edited.

  describe("mutation evidence", () => {
    const later = (ms: number) => async (tx: DbExecutor) =>
      new Date((await dbClock(tx)).getTime() + ms);
    const readRows = (f: Fx, messageId: string) =>
      t.db.transaction((tx) =>
        readFirstEligibleRows(tx as never, {
          organizationId: f.w.org.id,
          conversationId: f.w.student.conversation.id,
          messageId,
        }),
      );

    /** A completed first_message session, then a delayed message whose record key sorts EARLIER (only the session fence stops it). */
    async function sessionFenceScenario(mutation: string | null) {
      await q("truncate organizations, webhook_requests cascade");
      const f = await fixture(messageFlow({ kind: "first_message" }));
      const a = await trigger(f);
      ok(await run(a.id), "PROCESSED", "session_started");
      await dispatchAccepted();
      ok(await run((await trigger(f, { body: "anything" })).id), "IGNORED", "session_ended");
      await dispatchAccepted(); // the notice
      expect(await liveSession(f)).toMatchObject({ state: "COMPLETED" });
      const b = await trigger(f, { inputAt: freshAt(31 * MIN) });
      await q(
        "update messages set created_at = (select created_at from messages where id = $1) - interval '1 hour' where id = $2",
        [a.messageId, b.messageId],
      );
      const isolation = await readRows(f, b.messageId); // production statement (mutation not yet set)
      mutate.name = mutation;
      const summary = await run(b.id, { readClock: later(31 * MIN) });
      mutate.name = null;
      return { summary, sessions: (await sessionsOf(f)).length, isolation };
    }

    it("A: removing the previous-session-history fence lets a completed first_message conversation start again; the real implementation does not", async () => {
      const control = await sessionFenceScenario(null);
      // the OTHER predicate alone would allow it: the delayed message is first by record order; only the fence stops it
      expect(control.isolation).toEqual({
        firstInRecordHistory: true,
        noPreviousSessionStart: false,
        evidenceDefect: false,
      });
      ok(control.summary, "IGNORED", "no_trigger_match");
      expect(control.sessions).toBe(1);

      const mutant = await sessionFenceScenario("no_session_fence");
      ok(mutant.summary, "PROCESSED", "session_started"); // DETECTED: a second first_message session after completion + cooldown
      expect(mutant.sessions).toBe(2);
    });

    /** An earlier eligible message that never started a session; only the record-order predicate stops the later one. */
    async function recordOrderScenario(mutation: string | null) {
      await q("truncate organizations, webhook_requests cascade");
      const f = await fixture(messageFlow({ kind: "first_message" }));
      const candidate = await trigger(f, { messageId: await inbound(f) }); // the seeded message is earlier, never captured
      const isolation = await readRows(f, candidate.messageId);
      mutate.name = mutation;
      const summary = await run(candidate.id);
      mutate.name = null;
      return { summary, sessions: (await sessionsOf(f)).length, isolation };
    }

    it("B: removing the earliest-eligible-message predicate lets a later message start first_message; the real implementation does not", async () => {
      const control = await recordOrderScenario(null);
      // the OTHER predicate alone would allow it: the conversation has no session at all
      expect(control.isolation).toEqual({
        firstInRecordHistory: false,
        noPreviousSessionStart: true,
        evidenceDefect: false,
      });
      ok(control.summary, "IGNORED", "no_trigger_match");
      expect(control.sessions).toBe(0);

      const mutant = await recordOrderScenario("no_record_order");
      ok(mutant.summary, "PROCESSED", "session_started"); // DETECTED
      expect(mutant.sessions).toBe(1);
    });

    it("C: omitting the contact-level lock lets two overlapping starts of one contact (two recent sessions) both commit: four sessions; the real lock yields three (see R-CAP)", async () => {
      const { w, contact, t1, t2 } = await capWorld();
      const claimed = await claimTriggers(t.db, 50);
      const claimA = claimed.find((c) => c.id === t1.id)!;
      const claimB = claimed.find((c) => c.id === t2.id)!;
      expect(claimA && claimB).toBeTruthy();
      // both transactions reach the point where the start was decided (both have read "two recent sessions") before either writes
      let arrived = 0;
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      const hooks: StepHooks = {
        afterStartDecision: async () => {
          if (++arrived === 2) open();
          await Promise.race([gate, new Promise<void>((r) => setTimeout(r, 15_000))]);
        },
      };
      mutate.name = "no_contact_lock";
      const [ra, rb] = await Promise.all([
        processTrigger(t.db as never, claimA, deps({ hooks })),
        processTrigger(t.db as never, claimB, deps({ hooks })),
      ]);
      mutate.name = null;
      expect(arrived, "genuinely overlapping transactions").toBe(2);
      ok(ra, "PROCESSED", "session_started");
      ok(rb, "PROCESSED", "session_started");
      expect(
        await count("bot_sessions", "organization_id = $1 and contact_id = $2", [
          w.org.id,
          contact.id,
        ]),
      ).toBe(4); // DETECTED: the cap of three is exceeded
    });

    it("D: without the claim-token fence a worker that lost its claim still enters the step (and only the second fence stops its writes)", async () => {
      const f = await fixture();
      const tr = await trigger(f);
      const old = await claimOf(tr.id);
      await q(
        "update bot_triggers set claimed_at = clock_timestamp() - interval '2 minutes' where id = $1",
        [tr.id],
      );
      const fresh = await claimOf(tr.id);
      expect(fresh.claimToken).not.toBe(old.claimToken);
      let entered = 0;
      const hooks: StepHooks = { afterTriggerLock: async () => void entered++ };
      expect(await processTrigger(t.db as never, old, deps({ hooks }))).toEqual({
        kind: "lost_claim",
      });
      expect(entered).toBe(0); // control: the fence stops it before any lock or read

      mutate.name = "no_claim_fence";
      const mutant = await processTrigger(t.db as never, old, deps({ hooks }));
      mutate.name = null;
      expect(entered).toBe(1); // DETECTED: the stale worker took the locks and ran the step
      expect(mutant).toMatchObject({ kind: "failed", recorded: false }); // the finish fence rolled it back; T2 is fenced too
      expect(await sessionsOf(f)).toHaveLength(0);
      expect(await triggerRow(t, tr.id)).toMatchObject({
        status: "PENDING",
        claim_token: fresh.claimToken,
      });
    });

    it("E: checking staleness only after the in-flight deferral leaves an old start trigger deferred forever; the real order ends it stale_trigger", async () => {
      const f = await fixture(endFirstFlow("Bye"));
      ok(await run((await trigger(f, { body: "menu" })).id), "PROCESSED", "session_started"); // the notice is in flight
      const input = new Date(Date.now() - 1000);
      const old = await trigger(f, { body: "menu", inputAt: input });
      const lateClock = async () => new Date(input.getTime() + 11 * MIN);
      mutate.name = "stale_after_defer";
      expect(await run(old.id, { readClock: lateClock })).toMatchObject({ kind: "deferred" }); // DETECTED
      mutate.name = null;
      expect(await triggerRow(t, old.id)).toMatchObject({ status: "PENDING", deferrals: 1 });
      await makeDue(t, old.id);
      ok(await run(old.id, { readClock: lateClock }), "IGNORED", "stale_trigger"); // control
    });

    it("F: without the event idempotence guard a repeated deferral of the same tap fails (the unique index is only the backstop); with it the event is written once", async () => {
      const f = await fixture();
      const { session } = await startMenu(f);
      const transport = new FakeTransport().next({
        kind: "accepted",
        wamid: "wamid.OUT.1",
        providerStatus: "accepted",
        httpStatus: 200,
      });
      const d = {
        db: t.db as never,
        transport,
        config: BOTS_ON,
        random: () => 0.5,
        accountMinIntervalMs: 0,
        conversationMinIntervalMs: 0,
      };
      await claimNext(d); // the prompt is SENDING
      const reply = await trigger(f, {
        type: "INTERACTIVE",
        body: "A",
        content: replyContent(session.awaiting_token as string, "a"),
      });
      expect(await run(reply.id)).toMatchObject({ kind: "deferred" });
      await makeDue(t, reply.id);
      mutate.name = "event_no_guard";
      expect(await run(reply.id)).toMatchObject({
        kind: "failed",
        errorCode: "constraint_violation",
      }); // DETECTED
      mutate.name = null;
      await makeDue(t, reply.id);
      expect(await run(reply.id)).toMatchObject({ kind: "deferred" });
      expect(await count("bot_session_events", "kind = 'PROMPT_INTERACTION'")).toBe(1);
      expect(await requestsOf(f)).toHaveLength(1);
    });

    it("G: if the replay pre-check does not find the step's existing request, the replay is counted against the cap and refused; the real implementation replays it", async () => {
      const h = await hourlyWorld(30);
      const requests = async () => (await requestsOf(h.f)).map((r) => r.id);
      const before = await requests();
      expect(before).toHaveLength(30);
      expect(await enqueueDirect(h, 30)).toMatchObject({ ok: true, replayed: true }); // control
      expect(await requests()).toEqual(before); // replay inserted nothing
      mutate.name = "cap_ignores_replay";
      expect(await enqueueDirect(h, 30)).toEqual({ ok: false, reason: "bot_hourly_cap" }); // DETECTED
      mutate.name = null;
      expect(await requests()).toEqual(before);
      expect(await enqueueDirect(h, 31)).toEqual({ ok: false, reason: "bot_hourly_cap" }); // a new 31st request stays refused
      expect(await requests()).toEqual(before);
    });
  });
});
