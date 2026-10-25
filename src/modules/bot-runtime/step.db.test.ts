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
import { submitOutboundMessage } from "@/modules/messaging/submit";
import { FakeTransport, ON, textInput } from "@/modules/messaging/testing";
import { step, validateFlow } from "@/modules/bots";
import { assignConversation, changeConversationStatus } from "@/modules/inbox";
import {
  deliver,
  deliveryBytes,
  handlerContext,
  ingestBytes,
  type DeliverOptions,
  type StoredEvent,
} from "@/modules/whatsapp/inbound/testing";
import { buildWebhookWorkerHandlers } from "@/modules/whatsapp/worker/registry";
import { pauseDeployment } from "../bot-control";
import { FlowCache } from "./flow-cache";
import { reconcileSession } from "./reconcile";
import { processTrigger } from "./step";
import {
  deferred,
  endFirstFlow,
  handoverFirstFlow,
  insertTrigger,
  makeDue,
  menuFlow,
  messageFlow,
  terminateThenResume,
  terminationWatch,
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
    // 08E-9 R7 MUTATION "v3_rules" (V3.2 O.10 R7, "Failure if V3 restored"): V3 used the SMALLEST resolution after the
    // handover and did not compare later staff events with t. The real statement runs; its staff facts are then replaced by
    // V3's: no later-staff supersession (rule 1), no staff engagement mark (only a handover opens ownership), and the earliest
    // resolution after the latest handover (none at all without a handover). The status check is dropped in the evaluator below.
    readStartFacts: async (...a: Parameters<typeof orig.readStartFacts>) => {
      const r = await orig.readStartFacts(...a);
      if (mutate.name !== "v3_rules") return r;
      const [tx, p] = a;
      let latestResolution: typeof r.latestResolution = null;
      if (r.latestHandoverSeq !== null) {
        const x = await tx.execute<{ control_seq: string; created_at: string | Date }>(
          sql`SELECT control_seq, created_at FROM conversation_events
               WHERE organization_id = ${p.organizationId} AND conversation_id = ${p.conversationId}
                 AND kind = 'STATUS' AND to_status = 'RESOLVED' AND control_seq > ${r.latestHandoverSeq}
               ORDER BY control_seq ASC LIMIT 1`,
        );
        const row = x.rows[0];
        if (row)
          latestResolution = {
            seq: Number(row.control_seq),
            createdAt: queue.timestampToDate(row.created_at),
          };
      }
      return {
        ...r,
        maxStaffControlSeq: null,
        latestNonResolutionStaffSeq: null,
        hasLegacyNonResolutionStaffRow: false,
        latestResolution,
      };
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
    evaluateStartEligibility: (facts: Parameters<typeof orig.evaluateStartEligibility>[0]) => {
      if (mutate.name === "stale_after_defer" && facts.botRequestInFlight && !facts.hasLiveSession)
        return { outcome: "defer", code: "bot_request_in_flight" } as const;
      // 08E-9 R4 MUTATION "v2_restart_rule" (V3.2 O.10 R4): V2 rejected any conversation with a resolution after the latest
      // handover, so the legitimate restart of case C is denied
      if (
        mutate.name === "v2_restart_rule" &&
        facts.latestHandoverSeq !== null &&
        facts.latestResolution !== null &&
        facts.latestResolution.seq > facts.latestHandoverSeq
      )
        return { outcome: "ignore", code: "handover_unresolved" } as const;
      // 08E-9 R7 MUTATION "v3_rules" (with the readStartFacts half above): V3 checked only the current assignee, not the status
      if (mutate.name === "v3_rules")
        return orig.evaluateStartEligibility({ ...facts, conversationStatus: "OPEN" });
      return orig.evaluateStartEligibility(facts);
    },
  };
});
vi.mock("./policy", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./policy")>();
  return {
    ...orig,
    // 08E-9 R9b MUTATION "continuation_exemption" (plan G.4: Revision 1's withdrawn exemption). The scenarios that set it are
    // continuations on a WAITING_FOR_INPUT session with no busy try-lock, so the continuation's own check (continue.ts) is the
    // only staleness evaluation reached: "never stale" there is exactly the exemption being reinstated.
    isStaleInput: (...a: Parameters<typeof orig.isStaleInput>) =>
      mutate.name === "continuation_exemption" ? false : orig.isStaleInput(...a),
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

  // ================================================================== Phase 08E-9 Batch 1: runtime acceptance completion
  //
  // V3.2 O.10 R4 and R7, plan N.2 R9b, E-HOURLY (AC-5) and ENG. Staff actions are the real Inbox services; inbound messages
  // that the cases are about (duplicate deliveries, reopening, older provider times) go through the real ingest and the real
  // webhook-worker handler with trigger capture built from an explicit { BOTS_RUNTIME_ENABLED: "true" } object.
  //
  // LOGICAL CLOCK (plan N.2a: a test-only clock that advances logical time, bound consistently to the receipt input and the
  // runtime's decision-clock seam). The 30-minute cooldown after a session end or resolution cannot be waited out, and ended_at
  // and resolution times are database-stamped and immutable. Where a case needs the cooldown to have passed, the trigger's input
  // time and the decision clock advance TOGETHER by SHIFT (advance() + later(SHIFT)); control sequences, record order and every
  // database-stamped time stay real. Production reads plain clock_timestamp() with no offset.

  describe("Phase 08E-9 Batch 1", () => {
    const SHIFT = 31 * MIN;
    const later = (ms: number) => async (tx: DbExecutor) =>
      new Date((await dbClock(tx)).getTime() + ms);
    const truncate = () => q("truncate organizations, webhook_requests cascade");
    const conv = (fx: Fx) => fx.w.student.conversation.id;
    const conversationStatus = async (fx: Fx) =>
      (await one("select status from conversations where id = $1", [conv(fx)])).status as string;
    const lastResolution = async (fx: Fx) => {
      const r = await one(
        `select control_seq::int seq, (extract(epoch from created_at) * 1000)::float8 ms from conversation_events
          where conversation_id = $1 and kind = 'STATUS' and to_status = 'RESOLVED' order by control_seq desc limit 1`,
        [conv(fx)],
      );
      return { seq: Number(r.seq), ms: Number(r.ms) };
    };
    const staffStatus = (fx: Fx, to: "OPEN" | "RESOLVED", expected: "OPEN" | "RESOLVED") =>
      changeConversationStatus(fx.w.staff.ctx, conv(fx), { to, expected }, { db: t.db as never });
    /** The logical clock (see above): the captured trigger's input advances with the decision clock. */
    const advance = (triggerId: string, ms: number) =>
      q(
        "update bot_triggers set input_occurred_at = input_occurred_at + $2 * interval '1 millisecond' where id = $1 and status = 'PENDING'",
        [triggerId, ms],
      );

    // ---------------------------------------------------------------- real inbound (ingest + capture-enabled handler)
    const FROM = "15550100123";
    const captureHandlers = buildWebhookWorkerHandlers({ BOTS_RUNTIME_ENABLED: "true" });
    type Real = {
      event: StoredEvent;
      options: DeliverOptions;
      message: Json & { id: string; conversation_id: string };
      trigger: (Json & { id: string; observed_control_seq: string }) | null;
    };
    const handle = (event: StoredEvent) =>
      t.db.transaction((tx) =>
        captureHandlers.MESSAGE!(tx, { ...event, eventType: "MESSAGE" }, handlerContext()),
      );
    /**
     * One student message through the real ingest and the real handler. The provider timestamp defaults to one second after the
     * DATABASE clock, so a message sent after a staff resolution is newer than resolved_at (the handler reopens the conversation).
     */
    async function realInbound(
      fx: Fx,
      o: { body?: string; message?: Json; timestamp?: Date } = {},
    ): Promise<Real> {
      const account = await one(
        "select phone_number_id, waba_id from whatsapp_accounts where id = $1",
        [fx.w.account.id],
      );
      const dbMs = ((await one("select clock_timestamp() t")).t as Date).getTime();
      const options: DeliverOptions = {
        id: `wamid.TEST08E9.${randomUUID()}`,
        from: FROM,
        pn: account.phone_number_id as string,
        waba: account.waba_id as string,
        timestamp: o.timestamp ?? new Date(dbMs + 1_000),
        message: o.message ?? { type: "text", text: { body: o.body ?? "hi" } },
      };
      const event = await deliver(t.db, options);
      await handle(event);
      const message = (await one("select * from messages where wamid = $1", [
        event.providerObjectId,
      ])) as Real["message"];
      const trigger =
        ((await one("select * from bot_triggers where message_id = $1", [message.id])) as
          Real["trigger"] | undefined) ?? null;
      return { event, options, message, trigger };
    }
    /** The world as seen from the conversation the real handler created for FROM. */
    async function realFx(fx: Fx, r: Real): Promise<Fx> {
      const c = await one("select id, contact_id from conversations where id = $1", [
        r.message.conversation_id,
      ]);
      return {
        ...fx,
        w: {
          ...fx.w,
          student: {
            contact: { id: c.contact_id as string },
            conversation: { id: c.id as string },
            message: { id: r.message.id },
          },
        },
      };
    }
    const durable = async (fx: Fx) => ({
      inboundMessages: await count("messages", "conversation_id = $1 and direction = 'INBOUND'", [
        conv(fx),
      ]),
      triggers: await count("bot_triggers", "conversation_id = $1", [conv(fx)]),
      sessions: (await sessionsOf(fx)).length,
      botRequests: (await requestsOf(fx)).length,
    });

    /** A first-node HANDOVER session started by a real "menu", its notice ACCEPTED (nothing in flight), then a real resolution. */
    async function handedOverThenResolved() {
      const f0 = await fixture(handoverFirstFlow());
      const first = await realInbound(f0, { body: "menu" });
      const f = await realFx(f0, first);
      ok(await run(first.trigger!.id), "PROCESSED", "session_started");
      const handed = await liveSession(f);
      expect(handed).toMatchObject({ state: "HANDED_OVER", handover_reason: "needs_staff" });
      await dispatchAccepted();
      await staffStatus(f, "RESOLVED", "OPEN");
      return { f, first, h: Number(handed.handover_control_seq), r: await lastResolution(f) };
    }

    // ============================================================================================ R4 (V3.2 O.10 R4)

    describe("R4: restart after handover (cases F, G, restart, V2 mutation)", () => {
      /** R4-C's world (as the existing R4-C test builds it): handover, a real staff resolution, the conversation open again. */
      async function resolvedAndReopened() {
        const f = await fixture(handoverFirstFlow());
        ok(await run((await trigger(f, { body: "menu" })).id), "PROCESSED", "session_started");
        await dispatchAccepted();
        await staffStatus(f, "RESOLVED", "OPEN");
        const r = await lastResolution(f);
        // FIXTURE: the conversation is reopened directly, as R4-C does (the real reopen by a newer inbound message is proved
        // through the handler in R4-G and R7 below); no control sequence is allocated by a reopen either way
        await q("update conversations set status = 'OPEN' where id = $1", [conv(f)]);
        return { f, r };
      }

      it("F: after the handover and resolution a DIFFERENT deployment, activated later, decides: input enqueued before its activation is before_activation; input enqueued after starts on it", async () => {
        const { f, r } = await resolvedAndReopened();
        // captured while the first deployment was still ACTIVE (the only way capture admits a start trigger)
        const early = await trigger(f, { body: "join", observed: r.seq, inputAt: freshAt(SHIFT) });
        await pauseDeployment(f.w.admin.ctx, { deploymentId: f.deployment.id }, { db: t.db });
        const other = await publishedBot(
          t.db,
          f.w,
          messageFlow({ kind: "keyword", words: ["join"] }),
          "other_bot",
        );
        const d2 = (
          await activateDeployment(
            f.w.admin.ctx,
            {
              botId: other.bot.id,
              versionId: other.version.id,
              whatsappAccountId: f.w.account.id,
              priority: 2,
            },
            { db: t.db },
          )
        ).value;
        expect(
          (
            await one(
              "select t.enqueued_at < d.start_eligible_from before from bot_triggers t, bot_deployments d where t.id = $1 and d.id = $2",
              [early.id, d2.id],
            )
          ).before,
        ).toBe(true);
        ok(await run(early.id, { readClock: later(SHIFT) }), "IGNORED", "before_activation");
        expect(await sessionsOf(f)).toHaveLength(1);

        const after = await trigger(f, { body: "join", observed: r.seq, inputAt: freshAt(SHIFT) });
        ok(await run(after.id, { readClock: later(SHIFT) }), "PROCESSED", "session_started");
        const sessions = await sessionsOf(f);
        expect(sessions).toHaveLength(2);
        expect(sessions[1]).toMatchObject({
          deployment_id: d2.id,
          bot_id: other.bot.id,
          bot_version_id: other.version.id,
          started_by_message_id: after.messageId,
        });
        expect(Number(sessions[1]!.started_control_seq)).toBe(r.seq + 1);
        // both requests are step 1 of their own session, so requestsOf's bot_step_seq order ties: identify each by its session
        const requests = await requestsOf(f);
        expect(requests).toHaveLength(2);
        const ofSession = (id: unknown) => requests.filter((x) => x.bot_session_id === id);
        // the first session's HANDOVER notice, sent by dispatchAccepted: ACCEPTED, authorized as its terminal notice
        expect(ofSession(sessions[0]!.id)).toEqual([
          expect.objectContaining({
            bot_step_seq: Number(sessions[0]!.terminal_notice_step_seq),
            state: "ACCEPTED",
          }),
        ]);
        // the new session's first message on the new deployment: exactly one, QUEUED, for its current step
        expect(ofSession(sessions[1]!.id)).toEqual([
          expect.objectContaining({
            bot_step_seq: Number(sessions[1]!.step_seq),
            state: "QUEUED",
            hold_reason: null,
          }),
        ]);
      });

      it("G: after the handover and resolution, a duplicate webhook of the earlier message creates nothing, and a message older than maxInputAge ends stale_trigger; no new session", async () => {
        const { f, first } = await handedOverThenResolved();
        const before = await durable(f);
        expect(before).toEqual({ inboundMessages: 1, triggers: 1, sessions: 1, botRequests: 1 });
        // the same webhook delivered again: ingest stores no new event, and the stored event handled again (a worker retry)
        // exits at the existing wamid: no message, no trigger, no reopen
        expect(await ingestBytes(t.db, deliveryBytes(first.options).bytes)).toEqual([]);
        await handle(first.event);
        expect(await durable(f)).toEqual(before);
        expect(await conversationStatus(f)).toBe("RESOLVED");

        // a fresh message reopens the conversation and is captured after the resolution; the worker reaches it only when it
        // is more than maxInputAge old (an outage): staleness decides before rule 5 and before the cooldown (rule 6)
        const late = await realInbound(f, { body: "menu" });
        expect(await conversationStatus(f)).toBe("OPEN");
        const input = (await triggerRow(t, late.trigger!.id)).input_occurred_at as Date;
        ok(
          await run(late.trigger!.id, {
            readClock: async () => new Date(input.getTime() + 10 * MIN + 1),
          }),
          "IGNORED",
          "stale_trigger",
        );
        expect(await triggerRow(t, late.trigger!.id)).toMatchObject({
          attempts: 1,
          deferrals: 0,
          last_error_code: null,
        });
        expect(await durable(f)).toEqual({
          inboundMessages: 2,
          triggers: 2,
          sessions: 1,
          botRequests: 1,
        });
      });

      it("restart: the worker's T1 for C's input is killed after its decision clock; nothing survives; the restarted worker decides the same from the database", async () => {
        const { f, r } = await resolvedAndReopened();
        const c = await trigger(f, { body: "menu", observed: r.seq, inputAt: freshAt(SHIFT) });
        const claim = await claimOf(c.id);
        const watch = terminationWatch(t.pool);
        const reached = deferred<number>();
        const go = deferred();
        const running = processTrigger(
          t.db as never,
          claim,
          deps({
            readClock: later(SHIFT),
            hooks: {
              afterDecisionClock: async (tx) => {
                reached.resolve(
                  (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`)).rows[0]!
                    .pid,
                );
                await go.promise;
              },
            },
          }),
        );
        const pid = await Promise.race([
          reached.promise,
          running.then(() => {
            throw new Error("T1 finished before reaching its decision clock");
          }),
        ]);
        await terminateThenResume(watch, pid, () => go.resolve());
        const summary = await running;
        await watch.verify();
        expect(summary).toMatchObject({ kind: "failed", recorded: true });
        expect(await sessionsOf(f)).toHaveLength(1);
        expect(await requestsOf(f)).toHaveLength(1);
        expect(await triggerRow(t, c.id)).toMatchObject({
          status: "PENDING",
          attempts: 1,
          claim_token: null,
          session_id: null,
        });

        await makeDue(t, c.id);
        ok(await run(c.id, { readClock: later(SHIFT) }), "PROCESSED", "session_started");
        const sessions = await sessionsOf(f);
        expect(sessions).toHaveLength(2);
        expect(Number(sessions[1]!.started_control_seq)).toBe(r.seq + 1);
        expect(await triggerRow(t, c.id)).toMatchObject({
          attempts: 2,
          session_id: sessions[1]!.id,
        });
        // the dead worker's claim can change nothing afterwards
        expect(await processTrigger(t.db as never, claim, deps())).toEqual({ kind: "lost_claim" });
        expect(await sessionsOf(f)).toHaveLength(2);
      });

      it("MUTATION (V2 restart rule restored): case C is denied (no new session); the real rules start it", async () => {
        async function caseC(mutation: string | null) {
          await truncate();
          const { f, r } = await resolvedAndReopened();
          const tr = await trigger(f, { body: "menu", observed: r.seq, inputAt: freshAt(SHIFT) });
          mutate.name = mutation;
          const summary = await run(tr.id, { readClock: later(SHIFT) });
          mutate.name = null;
          return { summary, sessions: (await sessionsOf(f)).length };
        }
        const control = await caseC(null);
        ok(control.summary, "PROCESSED", "session_started");
        expect(control.sessions).toBe(2);
        const mutant = await caseC("v2_restart_rule");
        ok(mutant.summary, "IGNORED", "handover_unresolved"); // DETECTED: the legitimate restart is refused
        expect(mutant.sessions).toBe(1);
      });
    });

    // ============================================================================================ R7 (V3.2 O.10 R7)

    describe("R7: staff intervention before the start (C in full, G, V3 mutation)", () => {
      /**
       * R7-C: handover h; staff resolution (11); a real inbound reopens the conversation and is captured with t = 11; optionally a
       * second staff resolution (12); then the claimed trigger runs ("T1 released"). Sequences are relative to h (V3.2 R7: shown
       * relative to the conversation's control_seq), so 10/11/12 are h / h+1 / h+2.
       */
      async function caseC(o: { secondResolution: boolean; mutation?: string }) {
        const { f, h, r: r11 } = await handedOverThenResolved();
        const reopen = await realInbound(f, { body: "menu" });
        expect(await conversationStatus(f)).toBe("OPEN"); // the real handler reopened it (newer than resolved_at)
        expect(Number(reopen.trigger!.observed_control_seq)).toBe(r11.seq);
        let r12: { seq: number; ms: number } | null = null;
        if (o.secondResolution) {
          await staffStatus(f, "RESOLVED", "OPEN");
          r12 = await lastResolution(f);
        }
        // only the control-sequence rules may decide this trigger: the logical clock clears the cooldown and staleness
        await advance(reopen.trigger!.id, SHIFT);
        mutate.name = o.mutation ?? null;
        const summary = await run(reopen.trigger!.id, { readClock: later(SHIFT) });
        mutate.name = null;
        return { f, h, r11, r12, reopen, summary };
      }

      it("C: resolutions 11 and 12 around a reopening input (t = 11): superseded; an older-provider-time message after 12 is input_before_resolution without reopening; the fresh input after the cooldown (t' = 12) starts the session with started_control_seq 13", async () => {
        const x = await caseC({ secondResolution: true });
        expect(x.r11.seq).toBe(x.h + 1);
        expect(x.r12!.seq).toBe(x.h + 2);
        ok(x.summary, "IGNORED", "superseded_by_staff");
        expect(await sessionsOf(x.f)).toHaveLength(1);
        expect(await triggerRow(t, x.reopen.trigger!.id)).toMatchObject({ session_id: null });

        // variant: a message whose provider time precedes resolution 12, delivered after it
        const old = await realInbound(x.f, {
          body: "menu",
          timestamp: new Date(x.r12!.ms - 1_500),
        });
        expect(await conversationStatus(x.f)).toBe("RESOLVED"); // older than resolved_at: not reopened
        expect(Number(old.trigger!.observed_control_seq)).toBe(x.r12!.seq);
        // V3.2 allows "input_before_resolution (or conversation_resolved, since it did not reopen)"; the evaluator's order puts
        // rule 3 (freshness against the latest resolution) before rule 4 (status), so the code is input_before_resolution
        ok(await run(old.trigger!.id), "IGNORED", "input_before_resolution");
        expect(await sessionsOf(x.f)).toHaveLength(1);

        // the fresh enquiry after the cooldown, t' = 12: L = 12 > O = 10, t' >= 12, effective time after resolution 12
        const fresh = await realInbound(x.f, { body: "menu" });
        expect(await conversationStatus(x.f)).toBe("OPEN");
        expect(Number(fresh.trigger!.observed_control_seq)).toBe(x.r12!.seq);
        await advance(fresh.trigger!.id, SHIFT);
        ok(
          await run(fresh.trigger!.id, { readClock: later(SHIFT) }),
          "PROCESSED",
          "session_started",
        );
        const sessions = await sessionsOf(x.f);
        expect(sessions).toHaveLength(2);
        expect(sessions[1]).toMatchObject({ started_by_message_id: fresh.message.id });
        expect(Number(sessions[1]!.started_control_seq)).toBe(x.h + 3);
        // the first session's notice and the new (first-node HANDOVER) session's notice; nothing else
        expect((await requestsOf(x.f)).map((r) => r.bot_session_id).sort()).toEqual(
          sessions.map((s) => s.id).sort(),
        );
      });

      it("C variant: with only resolution 11, the reopening input (t = 11) starts a session after the cooldown, sequenced after 11", async () => {
        const x = await caseC({ secondResolution: false });
        ok(x.summary, "PROCESSED", "session_started");
        const sessions = await sessionsOf(x.f);
        expect(sessions).toHaveLength(2);
        expect(sessions[1]).toMatchObject({ started_by_message_id: x.reopen.message.id });
        expect(Number(sessions[1]!.started_control_seq)).toBe(x.r11.seq + 1);
      });

      it("G: after a resolution, a duplicate webhook creates no trigger, a message with an older provider time does not reopen and is input_before_resolution, and a message older than maxInputAge is stale_trigger; never a session", async () => {
        const f0 = await fixture(messageFlow()); // keyword "menu"
        const hello = await realInbound(f0, { body: "hello" });
        const f = await realFx(f0, hello);
        ok(await run(hello.trigger!.id), "IGNORED", "no_trigger_match");
        await staffStatus(f, "RESOLVED", "OPEN");
        const r = await lastResolution(f);
        const before = await durable(f);

        // (i) the same webhook delivered twice after the resolution
        expect(await ingestBytes(t.db, deliveryBytes(hello.options).bytes)).toEqual([]);
        await handle(hello.event);
        expect(await durable(f)).toEqual(before);
        expect(await conversationStatus(f)).toBe("RESOLVED");

        // (ii) a provider time before the latest resolution, arriving after it
        const old = await realInbound(f, { body: "menu", timestamp: new Date(r.ms - 1_500) });
        expect(await conversationStatus(f)).toBe("RESOLVED");
        expect(Number(old.trigger!.observed_control_seq)).toBe(r.seq);
        ok(await run(old.trigger!.id), "IGNORED", "input_before_resolution");

        // (iii) a fresh message after the resolution (it reopens) that the worker reaches only after maxInputAge
        const late = await realInbound(f, { body: "menu" });
        expect(await conversationStatus(f)).toBe("OPEN");
        const input = (await triggerRow(t, late.trigger!.id)).input_occurred_at as Date;
        ok(
          await run(late.trigger!.id, {
            readClock: async () => new Date(input.getTime() + 10 * MIN + 1),
          }),
          "IGNORED",
          "stale_trigger",
        );
        expect(await durable(f)).toEqual({
          inboundMessages: before.inboundMessages + 2,
          triggers: before.triggers + 2,
          sessions: 0,
          botRequests: 0,
        });
      });

      it("MUTATION (V3 restored): A (staff reply), B (resolution), E (assign then unassign) and C's first trigger each start a session; the real rules supersede all four", async () => {
        const staff: Record<string, (fx: Fx) => Promise<unknown>> = {
          A: (fx) =>
            submitOutboundMessage(fx.w.staff.ctx, textInput(conv(fx), "staff reply"), {
              db: t.db as never,
              config: ON,
              now: () => new Date(),
            }),
          B: (fx) => staffStatus(fx, "RESOLVED", "OPEN"),
          E: async (fx) => {
            const assign = (to: string | null, expected: string | null) =>
              assignConversation(
                fx.w.staff.ctx,
                conv(fx),
                { assigneeMembershipId: to, expectedAssigneeMembershipId: expected },
                { db: t.db as never },
              );
            await assign(fx.w.staff.membershipId, null);
            await assign(null, fx.w.staff.membershipId);
          },
        };
        for (const [name, act] of Object.entries(staff))
          for (const mutation of [null, "v3_rules"]) {
            await truncate();
            const f = await fixture(messageFlow());
            const tr = await trigger(f, { body: "menu" }); // observed t = 0: captured before the staff action
            await act(f);
            mutate.name = mutation;
            const summary = await run(tr.id);
            mutate.name = null;
            if (mutation === null) ok(summary, "IGNORED", "superseded_by_staff");
            else
              expect(summary, `${name} is not detected by the V3 mutation`).toMatchObject({
                kind: "finished",
                status: "PROCESSED",
                outcome: "session_started",
              });
          }

        await truncate();
        const control = await caseC({ secondResolution: true });
        ok(control.summary, "IGNORED", "superseded_by_staff");
        await truncate();
        const mutant = await caseC({ secondResolution: true, mutation: "v3_rules" });
        ok(mutant.summary, "PROCESSED", "session_started"); // DETECTED: V3 matched resolution 11
        expect(await sessionsOf(mutant.f)).toHaveLength(2);
      });
    });

    // ================================================================================ R9b: a stale repeat of a consumed tap

    describe("R9b: a stale repeat of an already-consumed tap", () => {
      /** menuFlow: the first tap (token K1) consumed, the second prompt (K2) ACCEPTED and reconciled: WAITING_FOR_INPUT on K2. */
      async function consumedTapWorld() {
        const f = await fixture();
        const { session } = await startMenu(f);
        const k1 = session.awaiting_token as string;
        await dispatchAccepted();
        const tap = await trigger(f, {
          type: "INTERACTIVE",
          body: "a",
          content: replyContent(k1, "a"),
        });
        ok(await run(tap.id), "PROCESSED", "input_accepted");
        await dispatchAccepted();
        const live = await liveSession(f);
        expect(
          await reconcileSession(
            t.db as never,
            {
              organizationId: f.w.org.id,
              sessionId: live.id as string,
              conversationId: conv(f),
              deploymentId: f.deployment.id,
            },
            deps(),
          ),
        ).toMatchObject({ kind: "applied", finalState: "WAITING_FOR_INPUT" });
        const s = await liveSession(f);
        expect(s).toMatchObject({ state: "WAITING_FOR_INPUT", last_consumed_token: k1 });
        return { f, session: s, k1, k2: s.awaiting_token as string };
      }
      const at = (ms: number) => async () => new Date(ms);
      /** A tap carrying `token` whose input is a second old now, run at `input + ageMs`. */
      async function tapAt(fx: Fx, token: string, key: string, ageMs: number, mutation?: string) {
        const input = new Date(Date.now() - 1_000);
        const tr = await trigger(fx, {
          type: "INTERACTIVE",
          body: key,
          content: replyContent(token, key),
          inputAt: input,
        });
        mutate.name = mutation ?? null;
        const summary = await run(tr.id, { readClock: at(input.getTime() + ageMs) });
        mutate.name = null;
        return { tr, summary };
      }
      const LIMIT = 10 * MIN;

      it("ends stale_trigger (not duplicate_reply) and writes nothing; at exactly maxInputAge the same repeat is an ordinary duplicate; the valid tap still works", async () => {
        const { f, session, k1, k2 } = await consumedTapWorld();
        const s0 = await rowJson("bot_sessions", session.id as string);
        const events0 = await eventsOf(session.id as string);

        const stale = await tapAt(f, k1, "a", LIMIT + 1);
        ok(stale.summary, "IGNORED", "stale_trigger");
        expect(await rowJson("bot_sessions", session.id as string)).toEqual(s0);
        expect(await eventsOf(session.id as string)).toEqual(events0);
        expect(await requestsOf(f)).toHaveLength(2);
        expect(await triggerRow(t, stale.tr.id)).toMatchObject({
          status: "IGNORED",
          attempts: 1,
          deferrals: 0,
          claim_token: null,
          last_error_code: null,
        });

        const boundary = await tapAt(f, k1, "a", LIMIT);
        ok(boundary.summary, "IGNORED", "duplicate_reply"); // exactly 10:00 is processed: an ordinary duplicate, uncounted
        expect(await rowJson("bot_sessions", session.id as string)).toEqual(s0);
        expect(await eventsOf(session.id as string)).toEqual(events0);

        const valid = await tapAt(f, k2, "ok", 1_000);
        ok(valid.summary, "PROCESSED", "input_accepted");
        expect(await liveSession(f)).toMatchObject({
          state: "COMPLETED",
          end_reason: "flow_end",
          last_consumed_token: k2,
        });
      });

      it("MUTATION (the WAITING_FOR_INPUT exemption reinstated): the stale repeat becomes duplicate_reply, and a stale valid tap is consumed; the real check ends both stale_trigger", async () => {
        async function scenario(mutation?: string) {
          await truncate();
          const w = await consumedTapWorld();
          const repeat = await tapAt(w.f, w.k1, "a", LIMIT + 1, mutation);
          const s1 = await rowJson("bot_sessions", w.session.id as string);
          const validTap = await tapAt(w.f, w.k2, "ok", LIMIT + 1, mutation);
          return { repeat: repeat.summary, validTap: validTap.summary, w, s1 };
        }
        const control = await scenario();
        ok(control.repeat, "IGNORED", "stale_trigger");
        ok(control.validTap, "IGNORED", "stale_trigger");
        expect(await rowJson("bot_sessions", control.w.session.id as string)).toEqual(control.s1);

        const mutant = await scenario("continuation_exemption");
        ok(mutant.repeat, "IGNORED", "duplicate_reply"); // DETECTED
        ok(mutant.validTap, "PROCESSED", "input_accepted"); // DETECTED: a stale tap consumed the token
        expect(await liveSession(mutant.w.f)).toMatchObject({ last_consumed_token: mutant.w.k2 });
      });
    });

    // ===================================================================== E-HOURLY: created_at is the transaction start

    describe("E-HOURLY: created_at is the creating transaction's start (AC-5)", () => {
      const DEFAULT_SQL =
        "select pg_get_expr(d.adbin, d.adrelid) e from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'outbound_requests'::regclass and a.attname = 'created_at'";

      /**
       * A real T1 start whose request insert is held back by a real PostgreSQL lock: another transaction holds the account row
       * FOR UPDATE, so T1 (which takes it FOR SHARE at K.1 step 7, before its decision clock and before the insert) waits. The
       * marker is the database clock read while T1 is provably blocked.
       */
      async function delayedStart() {
        const f = await fixture();
        const tr = await trigger(f);
        const account = await barriers.hold(
          "select id from whatsapp_accounts where id = $1 for update",
          [f.w.account.id],
        );
        let txStart = "";
        let decision: Date | null = null;
        const running = barriers.settle(
          run(tr.id, {
            hooks: {
              afterTriggerLock: async (tx) => {
                txStart = (
                  await tx.execute<{ t: string }>(sql`select transaction_timestamp()::text t`)
                ).rows[0]!.t;
              },
              afterDecisionClock: async (_tx, clock) => {
                decision = clock;
              },
            },
          }),
        );
        const blocked = await barriers.waitUntilBlocked(account.pid);
        expect(await barriers.blockersOf(blocked)).toEqual([account.pid]);
        const marker = (await one("select clock_timestamp()::text t")).t as string;
        await account.release();
        const result = await running;
        expect(result.ok && result.value).toMatchObject({
          kind: "finished",
          outcome: "session_started",
        });
        const session = await liveSession(f);
        const [request] = await requestsOf(f);
        const facts = await one(
          `select r.created_at = $2::timestamptz created_is_tx_start,
                  r.created_at < $3::timestamptz created_before_marker,
                  extract(epoch from ($3::timestamptz - r.created_at)) * 1000 gap_ms,
                  floor(extract(epoch from r.created_at) * 1000)::float8 created_ms,
                  floor(extract(epoch from $3::timestamptz) * 1000)::float8 marker_ms,
                  r.dispatch_deadline - interval '120 seconds' >= date_trunc('milliseconds', $3::timestamptz) deadline_after_marker,
                  r.next_attempt_at >= date_trunc('milliseconds', $3::timestamptz) next_attempt_after_marker,
                  s.send_wait_expires_at - interval '330 seconds' >= date_trunc('milliseconds', $3::timestamptz) send_wait_after_marker
             from outbound_requests r, bot_sessions s where r.id = $1 and s.id = $4`,
          [request.id, txStart, marker, session.id],
        );
        return { f, request, decision: decision as Date | null, facts };
      }
      const countAt = (f: Fx, clockMs: number) =>
        t.db.transaction((tx) =>
          countRecentBotRequests(tx as never, f.w.org.id, conv(f), new Date(clockMs), 60 * MIN),
        );

      it("a request whose insert waited behind a lock carries its transaction's START time, before the decision clock; the rolling hour ages it out by that persisted time", async () => {
        const x = await delayedStart();
        expect(x.facts.created_is_tx_start).toBe(true);
        expect(x.facts.created_before_marker).toBe(true);
        expect(
          Number(x.facts.gap_ms),
          "barrier invalid: no measurable wait",
        ).toBeGreaterThanOrEqual(2);
        // the decision clock and every value derived from it come AFTER the wait
        expect(x.decision!.getTime()).toBeGreaterThanOrEqual(Number(x.facts.marker_ms));
        expect(x.facts).toMatchObject({
          deadline_after_marker: true,
          next_attempt_after_marker: true,
          send_wait_after_marker: true,
        });
        // counted by created_at: included until created_at + 60 min (exclusive lower bound), excluded at marker + 60 min even
        // though the row was physically inserted after the marker
        expect(await countAt(x.f, Number(x.facts.created_ms) + 60 * MIN - 1)).toBe(1);
        expect(await countAt(x.f, Number(x.facts.marker_ms) + 60 * MIN)).toBe(0);
      });

      it("MUTATION (created_at defaulted to the insert time, in the disposable database only): the same delayed insert is stamped after the wait and counted in the later window", async () => {
        const original = (await one(DEFAULT_SQL)).e as string;
        expect(original).toBe("now()");
        await q(
          "alter table outbound_requests alter column created_at set default clock_timestamp()",
        );
        try {
          const x = await delayedStart();
          expect(x.facts.created_is_tx_start).toBe(false); // DETECTED
          expect(x.facts.created_before_marker).toBe(false);
          expect(await countAt(x.f, Number(x.facts.marker_ms) + 60 * MIN)).toBe(1); // DETECTED
        } finally {
          await q(`alter table outbound_requests alter column created_at set default ${original}`);
        }
        expect((await one(DEFAULT_SQL)).e).toBe("now()");
      });
    });

    // ====================================================================================== ENG: engine result shapes

    describe("ENG: engine result shapes map to rows the database guards accept", () => {
      const flow = (start: string, nodes: Json, variables?: Json): Json => ({
        schemaVersion: 1,
        name: "Test flow",
        startNodeId: start,
        errorNodeId: "fallback",
        triggers: [{ kind: "keyword", words: ["menu"] }],
        ...(variables ? { variables } : {}),
        nodes: {
          fallback: { type: "HANDOVER", reason: "needs_staff", message: "A person will reply." },
          ...nodes,
        },
      });
      /** A MESSAGE, then a QUESTION, then an END whose notice interpolates the answer. */
      const askNameFlow = () =>
        flow(
          "welcome",
          {
            welcome: { type: "MESSAGE", text: "Hello", next: "ask_name" },
            ask_name: {
              type: "QUESTION",
              text: "Your name?",
              variable: "name",
              answer: { kind: "text", min: 1, max: 50 },
              next: "done",
              onInvalid: "fallback",
            },
            done: { type: "END", message: "Thanks {{name}}" },
          },
          { name: { type: "string", maxLength: 50 } },
        );
      /** `n` SET_VARIABLE nodes in a row, then an END with a notice: n + 1 nodes entered in the start step. */
      const chainFlow = (n: number) => {
        const nodes: Json = { done: { type: "END", message: "Done" } };
        for (let i = 1; i <= n; i++)
          nodes[`s${i}`] = {
            type: "SET_VARIABLE",
            variable: "v",
            value: i,
            next: i === n ? "done" : `s${i + 1}`,
          };
        return flow("s1", nodes, { v: { type: "integer" } });
      };
      /** The start MESSAGE interpolates a declared variable that no node assigns (a validator warning, publishable). */
      const missingVariableFlow = () =>
        flow(
          "welcome",
          {
            welcome: { type: "MESSAGE", text: "Hi {{nick}}", next: "done" },
            done: { type: "END" },
          },
          { nick: { type: "string", maxLength: 20 } },
        );
      /** Events of one transaction share created_at (their ids are random), so they are compared as a sorted set. */
      const eventSet = async (sessionId: string) =>
        (await eventsOf(sessionId)).map((e) => `${e.kind}:${e.code ?? ""}`).sort();
      /** The engine's own result for a start of `json` (the shape the runtime receives). */
      const engineStart = (json: Json) => {
        const v = validateFlow(json);
        if (!v.ok || v.config === null) throw new Error("fixture flow invalid");
        return step(
          v.config,
          null,
          { type: "start" },
          { nowMs: Date.now(), promptToken: "A".repeat(22) },
        );
      };

      it("deferred + changed (F.4): an input arriving while an accepted MESSAGE leads to the next send commits the step and the new request, defers the input, and applies it once after that request is accepted", async () => {
        const f = await fixture(askNameFlow());
        const start = await trigger(f, { body: "menu" });
        ok(await run(start.id), "PROCESSED", "session_started");
        await dispatchAccepted(); // R1 (the MESSAGE) ACCEPTED, not yet reconciled: S still WAITING_FOR_SEND at step 1
        const s0 = await liveSession(f);
        expect(s0).toMatchObject({ state: "WAITING_FOR_SEND", step_seq: 1 });

        const answer = await trigger(f, { body: "Ada" });
        expect(await run(answer.id)).toMatchObject({ kind: "deferred" });
        const s1 = await liveSession(f);
        expect(s1).toMatchObject({
          state: "WAITING_FOR_SEND",
          step_seq: 2,
          revision: Number(s0.revision) + 1,
          current_node_id: "ask_name",
          last_input_message_id: start.messageId, // the deferred input is not consumed
          awaiting: { nodeId: "ask_name", kind: "QUESTION", phase: "QUEUED", optionKeys: [] },
        });
        expect((await requestsOf(f)).map((r) => [r.bot_step_seq, r.state])).toEqual([
          [1, "ACCEPTED"],
          [2, "QUEUED"],
        ]);
        expect(await eventsOf(s1.id as string)).toEqual([]); // a text answer carries no prompt token: no PROMPT_INTERACTION
        expect(await triggerRow(t, answer.id)).toMatchObject({
          status: "PENDING",
          attempts: 0,
          deferrals: 1,
          claim_token: null,
        });

        await dispatchAccepted(); // R2 (the QUESTION) ACCEPTED
        await makeDue(t, answer.id);
        ok(await run(answer.id), "PROCESSED", "input_accepted");
        const end = await liveSession(f);
        expect(end).toMatchObject({
          state: "COMPLETED",
          end_reason: "flow_end",
          step_seq: 3,
          terminal_notice_step_seq: 3,
          last_input_message_id: answer.messageId,
          variables: { name: "Ada" },
        });
        const requests = await requestsOf(f);
        expect(requests.map((r) => [r.bot_step_seq, r.state])).toEqual([
          [1, "ACCEPTED"],
          [2, "ACCEPTED"],
          [3, "QUEUED"],
        ]);
        expect(
          (await one("select body from messages where id = $1", [requests[2]!.message_id])).body,
        ).toBe("Thanks Ada");
        expect((await eventsOf(end.id as string)).map((e) => [e.kind, e.message_id])).toEqual([
          ["INPUT_ACCEPTED", answer.messageId],
        ]);
      });

      it("budget exhausted: 20 automatic nodes plus the END exceed the per-step transition budget; the session ends at the error node with no request and no notice (noticeSkipped ENGINE_ERROR); 19 plus the END complete normally", async () => {
        const over = engineStart(chainFlow(20));
        expect(over).toMatchObject({
          changed: true,
          outcome: "HANDED_OVER",
          error: "STEP_TRANSITION_BUDGET",
          noticeSkipped: "ENGINE_ERROR",
          effects: [],
          renderFailures: [],
        });
        const f = await fixture(chainFlow(20));
        ok(await run((await trigger(f, { body: "menu" })).id), "PROCESSED", "session_started");
        const s = await liveSession(f);
        expect(s).toMatchObject({
          state: "HANDED_OVER",
          end_reason: "error",
          handover_reason: "engine_error",
          current_node_id: "fallback",
          terminal_notice_step_seq: null,
          awaiting: null,
          awaiting_token: null,
        });
        expect(s.ended_at).toBeTruthy();
        expect(await requestsOf(f)).toHaveLength(0);
        expect(await eventSet(s.id as string)).toEqual([
          "ERROR:step_transition_budget",
          "HANDED_OVER:engine_error",
        ]);

        await truncate();
        expect(engineStart(chainFlow(19))).toMatchObject({ outcome: "COMPLETED" });
        const g = await fixture(chainFlow(19));
        ok(await run((await trigger(g, { body: "menu" })).id), "PROCESSED", "session_started");
        expect(await liveSession(g)).toMatchObject({
          state: "COMPLETED",
          end_reason: "flow_end",
          terminal_notice_step_seq: 1,
        });
        expect(await requestsOf(g)).toHaveLength(1);
      });

      it("renderFailures: a start MESSAGE whose placeholder has no value is rejected at render; the session ends at the error node, nothing is queued and no text is stored", async () => {
        expect(engineStart(missingVariableFlow())).toMatchObject({
          outcome: "HANDED_OVER",
          error: "RENDER_REJECTED",
          noticeSkipped: "ENGINE_ERROR",
          effects: [],
          renderFailures: [{ nodeId: "welcome", field: "text", reason: "VARIABLE_MISSING" }],
        });
        const f = await fixture(missingVariableFlow());
        ok(await run((await trigger(f, { body: "menu" })).id), "PROCESSED", "session_started");
        const s = await liveSession(f);
        expect(s).toMatchObject({
          state: "HANDED_OVER",
          end_reason: "error",
          handover_reason: "engine_error",
          terminal_notice_step_seq: null,
          variables: {},
        });
        expect(await requestsOf(f)).toHaveLength(0);
        expect(
          await count("messages", "conversation_id = $1 and direction = 'OUTBOUND'", [conv(f)]),
        ).toBe(0);
        // renderFailures have no column: the durable record is the ERROR code, never the template or a value
        expect(await eventSet(s.id as string)).toEqual([
          "ERROR:render_rejected",
          "HANDED_OVER:engine_error",
        ]);
      });

      /**
       * menuFlow at prompt `node` WAITING_FOR_INPUT with the session's send budget used up. FIXTURE: send_count is set to the
       * engine's 60-send limit directly (sending 60 real messages would also hit the 30-per-hour cap); every other column is the
       * real session's, reconciled to WAITING_FOR_INPUT by the real reconciler.
       */
      async function exhaustedAt(node: "ask" | "ask2") {
        const f = await fixture();
        const { session } = await startMenu(f);
        let token = session.awaiting_token as string;
        await dispatchAccepted();
        if (node === "ask2") {
          const tap = await trigger(f, {
            type: "INTERACTIVE",
            body: "a",
            content: replyContent(token, "a"),
          });
          ok(await run(tap.id), "PROCESSED", "input_accepted");
          await dispatchAccepted();
        }
        const live = await liveSession(f);
        await reconcileSession(
          t.db as never,
          {
            organizationId: f.w.org.id,
            sessionId: live.id as string,
            conversationId: conv(f),
            deploymentId: f.deployment.id,
          },
          deps(),
        );
        const s = await updateSession(t.pool, live.id as string, "send_count = 60");
        expect(s).toMatchObject({
          state: "WAITING_FOR_INPUT",
          current_node_id: node,
          send_count: 60,
        });
        token = s.awaiting_token as string;
        return { f, s, token, requests: (await requestsOf(f)).length };
      }

      it("budget exhausted by sends: the next prompt is refused by SEND_BUDGET; the input is consumed and the session ends at the error node with no request (noticeSkipped ENGINE_ERROR)", async () => {
        const x = await exhaustedAt("ask");
        const tap = await trigger(x.f, {
          type: "INTERACTIVE",
          body: "a",
          content: replyContent(x.token, "a"),
        });
        ok(await run(tap.id), "PROCESSED", "input_accepted");
        const s = await liveSession(x.f);
        expect(s).toMatchObject({
          state: "HANDED_OVER",
          end_reason: "error",
          handover_reason: "engine_error",
          terminal_notice_step_seq: null,
          send_count: 60,
          last_consumed_token: x.token,
        });
        expect(await requestsOf(x.f)).toHaveLength(x.requests);
        // the earlier tap of exhaustedAt is not this session's concern here: only this step's events are new
        expect((await eventSet(s.id as string)).filter((e) => e !== "INPUT_ACCEPTED:")).toEqual([
          "ERROR:send_budget",
          "HANDED_OVER:engine_error",
        ]);
        expect(
          await count(
            "bot_session_events",
            "session_id = $1 and message_id = $2 and kind = 'INPUT_ACCEPTED'",
            [s.id, tap.messageId],
          ),
        ).toBe(1);
      });

      it("noticeSkipped SEND_BUDGET: a valid input reaching an END with a message but no send left completes normally with no notice and no request (not an assessment refusal: no TERMINAL_NOTICE_NOT_QUEUED, no ERROR)", async () => {
        const x = await exhaustedAt("ask2");
        const tap = await trigger(x.f, {
          type: "INTERACTIVE",
          body: "ok",
          content: replyContent(x.token, "ok"),
        });
        ok(await run(tap.id), "PROCESSED", "input_accepted");
        const s = await liveSession(x.f);
        expect(s).toMatchObject({
          state: "COMPLETED",
          end_reason: "flow_end",
          handover_reason: null,
          current_node_id: "done",
          terminal_notice_step_seq: null,
          send_count: 60,
        });
        expect(await requestsOf(x.f)).toHaveLength(x.requests);
        // this step wrote exactly its INPUT_ACCEPTED: no TERMINAL_NOTICE_NOT_QUEUED, no ERROR, no HANDED_OVER
        expect(
          (await eventsOf(s.id as string))
            .filter((e) => e.message_id !== tap.messageId)
            .every((e) => e.kind === "INPUT_ACCEPTED"),
        ).toBe(true);
        expect(
          (await eventsOf(s.id as string)).filter((e) => e.message_id === tap.messageId),
        ).toEqual([
          { kind: "INPUT_ACCEPTED", code: null, message_id: tap.messageId, step_seq: s.step_seq },
        ]);
      });
    });
  });
});
