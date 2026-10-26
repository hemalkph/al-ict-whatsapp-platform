import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_VIOLATION,
  FK_VIOLATION,
  createTestDatabase,
  expectPgError,
  pgError,
  seedWebhookEvent,
  type TestDb,
} from "@/db/__tests__/helpers";
import { readFirstEligibleRows } from "@/db/ops/bot-step";
import type { DbExecutor } from "@/db/ops/executor";
import { runRetention } from "../bot-control/retention";
import { shortenRetention } from "../bot-control/testing";
import type { StepSummary } from "./context";
import { sweepOnce } from "./reconcile";
import {
  endFirstFlow,
  handoverFirstFlow,
  insertTrigger,
  makeDue,
  messageFlow,
  runtimeKit,
  terminateThenResume,
  terminationWatch,
  triggerRow,
  type RuntimeFx,
} from "./testing";

// E-FIRST (Phase 08E-8D3): plan F8 (interrupted first-message processing, l.1100) and F6 (retention and immutable history,
// l.1098) under D.4a (l.384-410). Disposable PostgreSQL 17 only, real T1/T2, real claims and guards, FakeTransport only.
// Interruption is a REAL backend termination (terminationWatch). Logical time is the test-only DB clock fixture of N.2a
// (l.1091): the decision clock is the database clock plus an offset (`readClock` seam); production reads clock_timestamp().

// TEST-ONLY mutation seam, the same pattern as step.db.test.ts: a pass-through unless a test sets `mutate.name`. It removes the
// first_message predicates from the real statement's RESULT, so a positive control proves that every OTHER H.2 rule passes
// and that firstness alone stops the later message. Production files are never edited.
const mutate = vi.hoisted(() => ({ name: null as string | null }));
vi.mock("@/db/ops/bot-step", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/db/ops/bot-step")>();
  return {
    ...orig,
    readFirstEligibleRows: async (...a: Parameters<typeof orig.readFirstEligibleRows>) => {
      const r = await orig.readFirstEligibleRows(...a);
      if (mutate.name === "no_first_checks")
        return { firstInRecordHistory: true, noPreviousSessionStart: true, evidenceDefect: false };
      if (mutate.name === "no_record_order") return { ...r, firstInRecordHistory: true };
      return r;
    },
  };
});

type Json = Record<string, unknown>;
const MIN = 60_000;
const FIRST: Json = { kind: "first_message" };

describe("E-FIRST: interrupted first-message processing (F8) and historical retention (F6)", () => {
  let t: TestDb;
  let k: ReturnType<typeof runtimeKit>;

  beforeAll(async () => {
    t = await createTestDatabase({
      sessionTimeouts: {
        lock_timeout: 10_000,
        statement_timeout: 15_000,
        idle_in_transaction_session_timeout: 20_000,
      },
    });
    k = runtimeKit(t);
  });
  afterAll(async () => {
    if (t) await t.close();
  });
  beforeEach(async () => {
    await k.q("truncate organizations, webhook_requests cascade");
    mutate.name = null;
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    k.releaseAll();
    mutate.name = null;
    vi.restoreAllMocks();
    await shortenRetention(t.pool, "30 days"); // the migration's value; restored even if a test failed midway
  });

  // ------------------------------------------------------------------------------------------------ helpers

  /** A decision clock `ms` after the database clock (cooldown and staleness without sleeping). */
  const later = (ms: number) => k.shifted(ms);
  const conv = (f: RuntimeFx) => f.w.student.conversation.id;
  const sessionsOf = (f: RuntimeFx) =>
    k.rows(
      "select * from bot_sessions where organization_id = $1 and conversation_id = $2 order by started_control_seq",
      [f.w.org.id, conv(f)],
    );
  const counts = async (f: RuntimeFx) => ({
    sessions: (await sessionsOf(f)).length,
    botRequests: (await k.botRequests(f)).length,
    events: Number((await k.one("select count(*)::int n from bot_session_events")).n),
    outboundMessages: Number(
      (
        await k.one(
          "select count(*)::int n from messages where conversation_id = $1 and direction = 'OUTBOUND'",
          [conv(f)],
        )
      ).n,
    ),
  });
  /** The two D.4a facts plus the defect flag, read by the real statement (not under mutation). */
  const firstFacts = (f: RuntimeFx, messageId: string) =>
    t.db.transaction((tx) =>
      readFirstEligibleRows(tx as never, {
        organizationId: f.w.org.id,
        conversationId: conv(f),
        messageId,
      }),
    );
  /** A later eligible inbound message whose input is one second old at a decision clock shifted by `shiftMs`. */
  async function laterTrigger(f: RuntimeFx, shiftMs: number, observed?: number) {
    const messageId = await k.inbound(f, { body: `later ${randomUUID()}` });
    const tr = await insertTrigger(t, k.ctxOf(f), {
      messageId,
      inputOccurredAt: new Date(Date.now() + shiftMs - 1_000),
    });
    if (observed !== undefined)
      await k.q("update bot_triggers set observed_control_seq = $2 where id = $1", [
        tr.id,
        observed,
      ]);
    return tr;
  }
  function finished(summary: StepSummary, status: "PROCESSED" | "IGNORED", outcome: string) {
    expect(summary).toMatchObject({ kind: "finished", status, outcome });
  }
  /** The real staff resolution, then the conversation open again (as R4-C does). */
  async function resolveByStaff(f: RuntimeFx) {
    await k.q(
      "insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_status, to_status) values ($1,$2,'STATUS',$3,'OPEN','RESOLVED')",
      [f.w.org.id, conv(f), f.w.staff.membershipId],
    );
    await k.q("update conversations set status = 'OPEN' where id = $1", [conv(f)]);
  }
  /** Every durable record of the conversation's bot history, for byte-identical before/after comparison. */
  const history = async (f: RuntimeFx) => ({
    sessions: await k.rows(
      "select to_jsonb(s) j from bot_sessions s where conversation_id = $1 order by started_control_seq",
      [conv(f)],
    ),
    requests: await k.rows(
      "select to_jsonb(r) j from outbound_requests r where conversation_id = $1 order by created_at, id",
      [conv(f)],
    ),
    events: await k.rows(
      "select to_jsonb(e) j from bot_session_events e where conversation_id = $1 order by created_at, id",
      [conv(f)],
    ),
    controlSeq: await k.controlSeq(f),
  });

  /**
   * Starts A's T1 and terminates its backend after the session insert and the initial enqueue (the afterEnqueue test hook),
   * before COMMIT. Returns the T1 summary after T2 has run on a fresh connection.
   */
  async function interruptedStart(f: RuntimeFx, triggerId: string) {
    const watch = terminationWatch(t.pool);
    const p = k.pause();
    const running = k.run(triggerId, { hooks: { afterEnqueue: p.hook } });
    const pid = await Promise.race([
      p.reached,
      running.then(() => {
        throw new Error("T1 finished before reaching afterEnqueue");
      }),
    ]);
    // inside the open transaction the session and request exist; outside it nothing is visible
    expect(await counts(f)).toEqual({
      sessions: 0,
      botRequests: 0,
      events: 0,
      outboundMessages: 0,
    });
    expect((await k.one("select state from pg_stat_activity where pid = $1", [pid])).state).toBe(
      "idle in transaction",
    );
    await terminateThenResume(watch, pid, p.release);
    const summary = await running;
    await watch.verify();
    return summary;
  }
  /** P1/P2 shared post-conditions: nothing of the interrupted T1 survives; T2 recorded the failure and cleared the claim. */
  async function expectNothingSurvived(f: RuntimeFx, triggerId: string, summary: StepSummary) {
    expect(summary).toMatchObject({ kind: "failed", recorded: true });
    const errorCode = (summary as { errorCode: string }).errorCode;
    expect(await counts(f)).toEqual({
      sessions: 0,
      botRequests: 0,
      events: 0,
      outboundMessages: 0,
    });
    expect(await triggerRow(t, triggerId)).toMatchObject({
      status: "PENDING",
      attempts: 1,
      claim_token: null,
      claimed_at: null,
      processed_at: null,
      session_id: null,
      last_error_code: errorCode,
    });
    return errorCode;
  }

  // ============================================================================================== F8 (plan l.1100)

  describe("F8: interrupted first-message processing", () => {
    it("P1: A's T1 is killed after the session insert and initial enqueue: nothing survives, T2 records it, and the retry starts A's session with exactly one request", async () => {
      const f = await k.fixture(messageFlow(FIRST));
      const a = await k.trigger(f, { first: true });
      const summary = await interruptedStart(f, a.id);
      expect(await expectNothingSurvived(f, a.id, summary)).toBe("internal_error"); // pinned observation
      // A is still the first eligible message, with no session history
      expect(await firstFacts(f, a.messageId)).toEqual({
        firstInRecordHistory: true,
        noPreviousSessionStart: true,
        evidenceDefect: false,
      });

      await makeDue(t, a.id);
      finished(await k.run(a.id), "PROCESSED", "session_started");
      const [s, ...more] = await sessionsOf(f);
      expect(more).toEqual([]);
      expect(s).toMatchObject({ started_by_message_id: a.messageId, step_seq: 1 });
      const requests = await k.botRequests(f);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        bot_session_id: s!.id,
        bot_step_seq: 1,
        state: "QUEUED",
        origin: "BOT",
      });
      expect(await k.events(s!.id as string)).toEqual([]); // the starting message is never replayed as an input
      expect(await triggerRow(t, a.id)).toMatchObject({
        status: "PROCESSED",
        outcome_code: "session_started",
        attempts: 2,
        session_id: s!.id,
      });
      expect(await counts(f)).toEqual({
        sessions: 1,
        botRequests: 1,
        events: 0,
        outboundMessages: 1,
      });
    });

    it("P2: the interrupted A turns stale and finishes stale_trigger; a later fresh B does NOT inherit firstness (retained record history, no session needed)", async () => {
      const f = await k.fixture(messageFlow(FIRST));
      const a = await k.trigger(f, { first: true });
      await expectNothingSurvived(f, a.id, await interruptedStart(f, a.id));

      // A processed at a decision clock past maxInputAge (10 min): stale, finished without any session effect
      await makeDue(t, a.id);
      finished(await k.run(a.id, { readClock: later(11 * MIN) }), "IGNORED", "stale_trigger");
      expect(await triggerRow(t, a.id)).toMatchObject({
        status: "IGNORED",
        outcome_code: "stale_trigger",
        claim_token: null,
        session_id: null,
      });
      expect(await counts(f)).toEqual({
        sessions: 0,
        botRequests: 0,
        events: 0,
        outboundMessages: 0,
      });

      // B, fresh at that clock: no session has ever started, yet A's retained eligible header precedes it
      const b = await laterTrigger(f, 11 * MIN);
      expect(await firstFacts(f, b.messageId)).toEqual({
        firstInRecordHistory: false,
        noPreviousSessionStart: true,
        evidenceDefect: false,
      });
      finished(await k.run(b.id, { readClock: later(11 * MIN) }), "IGNORED", "no_trigger_match");
      expect(await counts(f)).toEqual({
        sessions: 0,
        botRequests: 0,
        events: 0,
        outboundMessages: 0,
      });

      // positive control (TEST-ONLY mutation): without the record-order predicate an identical later message starts, so
      // the retained history of A, and nothing else, is what stops B
      const b2 = await laterTrigger(f, 11 * MIN);
      mutate.name = "no_record_order";
      finished(await k.run(b2.id, { readClock: later(11 * MIN) }), "PROCESSED", "session_started");
      mutate.name = null;
      expect(await sessionsOf(f)).toMatchObject([{ started_by_message_id: b2.messageId }]);
    });

    const terminalFirstNodes = [
      { name: "END without a notice", flow: () => endFirstFlow(undefined, FIRST), notice: false },
      { name: "END with a notice", flow: () => endFirstFlow("Bye", FIRST), notice: true },
      { name: "HANDOVER with a notice", flow: () => handoverFirstFlow(FIRST), notice: true },
      // 08E-9 Batch 6 (plan F8 l.1100 "END/HANDOVER (including no notice)"): the silent first-node HANDOVER
      {
        name: "HANDOVER without a notice",
        flow: () => handoverFirstFlow(FIRST, null),
        notice: false,
      },
    ] as const;

    it.each(terminalFirstNodes)(
      "P3: a committed first-node $name consumes the first-message opportunity; after every other restart condition holds, B is no_trigger_match",
      async ({ name, flow, notice }) => {
        const handover = name.startsWith("HANDOVER");
        const f = await k.fixture(flow());
        const seq0 = await k.controlSeq(f);
        const a = await k.trigger(f, { first: true });
        finished(await k.run(a.id), "PROCESSED", "session_started");
        const [s] = await sessionsOf(f);
        expect(s).toMatchObject({
          started_by_message_id: a.messageId,
          state: handover ? "HANDED_OVER" : "COMPLETED",
          end_reason: handover ? "flow_handover" : "flow_end",
          handover_reason: handover ? "needs_staff" : null,
          step_seq: 1,
          terminal_notice_step_seq: notice ? 1 : null,
        });
        // control sequence, one commit: the session insert, then its notice request (every outbound request allocates one,
        // migration 0008), then the handover
        expect(Number(s!.started_control_seq)).toBe(seq0 + 1);
        const requests = await k.botRequests(f);
        expect(requests).toHaveLength(notice ? 1 : 0);
        if (notice)
          expect(requests[0]).toMatchObject({
            bot_session_id: s!.id,
            bot_step_seq: 1,
            state: "QUEUED",
          });
        if (notice) expect(Number(requests[0]!.control_seq)).toBe(seq0 + 2);
        const afterStart = seq0 + 1 + (notice ? 1 : 0) + (handover ? 1 : 0);
        if (handover) expect(Number(s!.handover_control_seq)).toBe(afterStart);
        else expect(s!.handover_control_seq).toBeNull();
        expect(await k.controlSeq(f)).toBe(afterStart);
        expect((await k.events(s!.id as string)).map((e) => e.kind)).toEqual(
          handover ? ["HANDED_OVER"] : [],
        );
        if (handover)
          expect(await k.events(s!.id as string)).toMatchObject([
            { kind: "HANDED_OVER", code: "needs_staff", step_seq: 1, message_id: null },
          ]);
        // a real reconciliation sweep afterwards creates, recreates or changes nothing: no notice appears later
        const settled = await k.sessionJson(s!.id as string);
        await sweepOnce(t.db as unknown as DbExecutor, k.deps());
        expect(await k.botRequests(f)).toHaveLength(notice ? 1 : 0);
        expect(await k.sessionJson(s!.id as string)).toEqual(settled);
        // the notice is delivered, so no BOT output is in flight (H.2 rule 5)
        if (notice)
          await k.dispatchWith(
            k.accepted(`wamid.TEST08E8D3.${randomUUID()}`),
            requests[0]!.id as string,
          );
        if (handover) {
          await resolveByStaff(f); // H.2 rules 2-4 for a handover; the resolution is sequenced after the handover
          expect(await k.controlSeq(f)).toBe(afterStart + 1);
        }

        // B after the cooldown (31 min logical), observed after every control event, fresh, unassigned, OPEN
        const before = await history(f);
        const b = await laterTrigger(f, 31 * MIN, before.controlSeq);
        expect(await firstFacts(f, b.messageId)).toEqual({
          firstInRecordHistory: false,
          noPreviousSessionStart: false,
          evidenceDefect: false,
        });
        finished(await k.run(b.id, { readClock: later(31 * MIN) }), "IGNORED", "no_trigger_match");
        expect(await history(f)).toEqual(before); // byte-identical sessions, requests, events and control sequence

        // positive control (TEST-ONLY mutation): with both first_message predicates removed, an identical B2 starts, so every
        // other H.2 rule (cooldown, staff, resolution, freshness, in-flight output, caps) passes and only firstness stops B
        const b2 = await laterTrigger(f, 31 * MIN, before.controlSeq);
        mutate.name = "no_first_checks";
        finished(
          await k.run(b2.id, { readClock: later(31 * MIN) }),
          "PROCESSED",
          "session_started",
        );
        mutate.name = null;
        const all = await sessionsOf(f);
        expect(all).toHaveLength(2);
        expect(all[1]).toMatchObject({ started_by_message_id: b2.messageId });
        expect(Number(all[1]!.started_control_seq)).toBe(before.controlSeq + 1);
      },
    );
  });

  // ============================================================================================== F6 (plan l.1098)

  describe("F6: retention and immutable history", () => {
    /** A conversation whose first eligible message A started a first_message session that completed at once (no request). */
    async function completedFirst() {
      const f = await k.fixture(endFirstFlow(undefined, FIRST));
      const a = await k.trigger(f, { first: true });
      finished(await k.run(a.id), "PROCESSED", "session_started");
      const [s] = await sessionsOf(f);
      expect(s).toMatchObject({ state: "COMPLETED", started_by_message_id: a.messageId });
      return { f, a, session: s! };
    }

    it("H1: after the real redaction of A's completed session, the org/conversation/started_by evidence persists and B cannot regain firstness", async () => {
      const { f, a, session } = await completedFirst();
      const before = await k.sessionJson(session.id as string);
      await shortenRetention(t.pool); // disposable database only; afterEach restores the migration's 30 days
      expect(
        Number((await k.one("select redact_expired_bot_sessions($1, 100) n", [f.w.org.id])).n),
      ).toBe(1);
      await shortenRetention(t.pool, "30 days");
      const after = await k.sessionJson(session.id as string);
      expect(after.redacted_at).not.toBeNull();
      // only the approved sensitive fields changed; the start evidence is untouched
      const keep = (j: Json) => {
        const { variables, awaiting, awaiting_token, last_consumed_token, redacted_at, ...rest } =
          j;
        void [variables, awaiting, awaiting_token, last_consumed_token, redacted_at];
        return rest;
      };
      expect(keep(after)).toEqual(keep(before));
      expect(after).toMatchObject({
        organization_id: f.w.org.id,
        conversation_id: conv(f),
        started_by_message_id: a.messageId,
      });

      const b = await laterTrigger(f, 31 * MIN);
      expect(await firstFacts(f, b.messageId)).toEqual({
        firstInRecordHistory: false,
        noPreviousSessionStart: false,
        evidenceDefect: false,
      });
      finished(await k.run(b.id, { readClock: later(31 * MIN) }), "IGNORED", "no_trigger_match");
      // the REDACTED session alone is enough: with the record-order predicate removed, B2 still cannot start
      const b2 = await laterTrigger(f, 31 * MIN);
      mutate.name = "no_record_order";
      finished(await k.run(b2.id, { readClock: later(31 * MIN) }), "IGNORED", "no_trigger_match");
      // and with both predicates removed an identical B3 starts: every other H.2 rule passes
      const b3 = await laterTrigger(f, 31 * MIN);
      mutate.name = "no_first_checks";
      finished(await k.run(b3.id, { readClock: later(31 * MIN) }), "PROCESSED", "session_started");
      mutate.name = null;
      expect((await sessionsOf(f)).map((s) => s.started_by_message_id)).toEqual([
        a.messageId,
        b3.messageId,
      ]);
    });

    it("H2: deleting the session, rewriting its start message and deleting the referenced start message are all rejected; nothing changes", async () => {
      const { f, a, session } = await completedFirst();
      const other = await k.inbound(f); // another eligible message of the same conversation
      const sessionBefore = await k.sessionJson(session.id as string);
      const messageJson = async () =>
        (await k.one("select to_jsonb(m) j from messages m where id = $1", [a.messageId])).j;
      const messageBefore = await messageJson();
      const rejected = async (text: string, params: unknown[]) => {
        try {
          await k.q(text, params);
        } catch (e) {
          return pgError(e);
        }
        throw new Error(`expected a rejection: ${text}`);
      };

      expect(await rejected("delete from bot_sessions where id = $1", [session.id])).toMatchObject({
        code: CHECK_VIOLATION,
        message: "bot_sessions: a session is never deleted",
      });
      expect(
        await rejected("update bot_sessions set started_by_message_id = $2 where id = $1", [
          session.id,
          other,
        ]),
      ).toMatchObject({ code: CHECK_VIOLATION, message: "bot_session_terminal_immutable" });
      // the start message is referenced by the session (and by its own trigger): prune the terminal trigger first, so the
      // session's foreign key is the one that refuses
      expect(
        (
          await k.q("delete from bot_triggers where message_id = $1 and status <> 'PENDING'", [
            a.messageId,
          ])
        ).rowCount,
      ).toBe(1);
      await expectPgError(
        k.q("delete from messages where id = $1", [a.messageId]),
        FK_VIOLATION,
        "bot_sessions_started_by_message_fk",
      );

      expect(await k.sessionJson(session.id as string)).toEqual(sessionBefore);
      expect(await messageJson()).toEqual(messageBefore);
      expect(await firstFacts(f, other)).toEqual({
        firstInRecordHistory: false,
        noPreviousSessionStart: false,
        evidenceDefect: false,
      });
    });

    it("H3: pruning A's terminal trigger and its source webhook evidence (references nulled first, no FK bypassed) leaves the first-message facts and B's outcome unchanged", async () => {
      const f = await k.fixture(endFirstFlow(undefined, FIRST));
      // A's provenance: a real webhook event row, linked through the existing composite FK
      const ev = await seedWebhookEvent(t.db, {
        organizationId: f.w.org.id,
        whatsappAccountId: f.w.account.id,
      });
      await k.q("update messages set source_webhook_event_id = $2 where id = $1", [
        f.w.student.message.id,
        ev.id,
      ]);
      const a = await k.trigger(f, { first: true });
      finished(await k.run(a.id), "PROCESSED", "session_started");
      const b = await laterTrigger(f, 31 * MIN);
      const factsBefore = await firstFacts(f, b.messageId);
      expect(factsBefore).toEqual({
        firstInRecordHistory: false,
        noPreviousSessionStart: false,
        evidenceDefect: false,
      });

      // the FK refuses deleting referenced webhook evidence; the permitted order nulls the reference first
      await expectPgError(
        k.q("delete from webhook_events where id = $1", [ev.id]),
        FK_VIOLATION,
        "messages_org_source_webhook_event_fk",
      );
      expect(
        (await k.q("delete from bot_triggers where id = $1 and status <> 'PENDING'", [a.id]))
          .rowCount,
      ).toBe(1);
      await k.q(
        "update messages set source_webhook_event_id = null where source_webhook_event_id = $1",
        [ev.id],
      );
      expect((await k.q("delete from webhook_events where id = $1", [ev.id])).rowCount).toBe(1);

      expect(await firstFacts(f, b.messageId)).toEqual(factsBefore);
      finished(await k.run(b.id, { readClock: later(31 * MIN) }), "IGNORED", "no_trigger_match");
      expect((await sessionsOf(f)).map((s) => s.started_by_message_id)).toEqual([a.messageId]);
    });

    it("H3-job (08F-1): the bots:retention job deleting A's aged terminal trigger leaves the first-message facts, the history and B's outcome unchanged", async () => {
      const f = await k.fixture(endFirstFlow(undefined, FIRST));
      const a = await k.trigger(f, { first: true });
      finished(await k.run(a.id), "PROCESSED", "session_started");
      const b = await laterTrigger(f, 31 * MIN);
      const factsBefore = await firstFacts(f, b.messageId);
      expect(factsBefore).toEqual({
        firstInRecordHistory: false,
        noPreviousSessionStart: false,
        evidenceDefect: false,
      });
      const history = async () =>
        k.one(
          `select (select jsonb_agg(to_jsonb(m) order by m.id) from messages m where m.conversation_id = $1) messages,
                  (select jsonb_agg(to_jsonb(s) order by s.id) from bot_sessions s where s.conversation_id = $1) sessions`,
          [conv(f)],
        );
      const historyBefore = await history();
      // A's trigger is terminal; age it past the approved 14 days (the table has no guard; only the job's statement deletes)
      await k.q(
        "update bot_triggers set processed_at = clock_timestamp() - interval '15 days' where id = $1 and status <> 'PENDING'",
        [a.id],
      );
      const report = await runRetention(t.db, { apply: true });
      expect(report.organizations.find((o) => o.organizationId === f.w.org.id)).toMatchObject({
        triggers: 1,
        sessions: 0, // the 30-day session period has not passed
      });
      expect(await k.q("select 1 from bot_triggers where id = $1", [a.id])).toMatchObject({
        rowCount: 0,
      });
      expect(await history()).toEqual(historyBefore);
      expect(await firstFacts(f, b.messageId)).toEqual(factsBefore);
      finished(await k.run(b.id, { readClock: later(31 * MIN) }), "IGNORED", "no_trigger_match");
      expect((await sessionsOf(f)).map((s) => s.started_by_message_id)).toEqual([a.messageId]);
    });

    /** A world whose seeded eligible A never had a trigger or a session, with A's content and provenance cleared. */
    async function unstartedA() {
      const f = await k.fixture(messageFlow(FIRST));
      const a = f.w.student.message.id;
      await k.q("update messages set type = 'TEXT' where id = $1", [a]);
      const ev = await seedWebhookEvent(t.db, {
        organizationId: f.w.org.id,
        whatsappAccountId: f.w.account.id,
      });
      await k.q("update messages set source_webhook_event_id = $2 where id = $1", [a, ev.id]);
      const header = () =>
        k.one("select id, type, direction, created_at from messages where id = $1", [a]);
      const headerBefore = await header();
      // clear only content and provenance (what message retention may remove); the header stays
      await k.q(
        "update messages set body = null, content = null, source_webhook_event_id = null where id = $1",
        [a],
      );
      expect(
        await k.one("select body, content, source_webhook_event_id from messages where id = $1", [
          a,
        ]),
      ).toEqual({ body: null, content: null, source_webhook_event_id: null });
      expect(await header()).toEqual(headerBefore);
      expect(headerBefore).toMatchObject({ type: "TEXT", direction: "INBOUND" });
      return { f, a };
    }

    it("H4: an unstarted eligible A with its content and source cleared but its header retained still precedes B; the header is causal", async () => {
      const { f } = await unstartedA();
      const b = await k.trigger(f);
      expect(await firstFacts(f, b.messageId)).toEqual({
        firstInRecordHistory: false,
        noPreviousSessionStart: true,
        evidenceDefect: false,
      });
      finished(await k.run(b.id), "IGNORED", "no_trigger_match");
      expect(await counts(f)).toEqual({
        sessions: 0,
        botRequests: 0,
        events: 0,
        outboundMessages: 0,
      });

      // positive control in an identical second conversation. NOT a permitted production operation: a test-only
      // reclassification of A's retained header (H5 pins that production code never rewrites or deletes message headers)
      // makes the same B first, so the retained header is what stops B above.
      await k.q("truncate organizations, webhook_requests cascade");
      const g = await unstartedA();
      await k.q("update messages set type = 'IMAGE' where id = $1", [g.a]);
      const gb = await k.trigger(g.f);
      expect(await firstFacts(g.f, gb.messageId)).toEqual({
        firstInRecordHistory: true,
        noPreviousSessionStart: true,
        evidenceDefect: false,
      });
      finished(await k.run(gb.id), "PROCESSED", "session_started");
    });
  });
});
