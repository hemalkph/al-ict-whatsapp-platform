import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { readFirstEligibleRows } from "@/db/ops/bot-step";
import { insertBotTriggerIfAdmitted } from "@/db/ops/bot-trigger";
import { createInboundMessageHandler } from "@/modules/whatsapp/inbound/handler";
import {
  deliver,
  handlerContext,
  type DeliverOptions,
  type StoredEvent,
} from "@/modules/whatsapp/inbound/testing";
import { until } from "@/modules/whatsapp/queue/testing";
import type { WebhookHandler } from "@/modules/whatsapp/queue/process";
import { buildWebhookWorkerHandlers } from "@/modules/whatsapp/worker/registry";
import type { StepSummary } from "./context";
import { deferred, endFirstFlow, runtimeKit, type RuntimeFx } from "./testing";
import { claimTriggers } from "./trigger-queue";

// E-FIRST historical inbound ordering (Phase 08E-9 Batch 4; plan N.2a F1, F2, F3 and the F4 mutations that belong to them,
// D.4a). Disposable PostgreSQL 17 only, FakeTransport only, bot gates are explicit test objects (never the environment).
//
// What is real here: verified-delivery ingest (ingestVerifiedDelivery called directly on the raw bytes: the HTTP route and its
// signature check are NOT exercised), the capture-enabled inbound handler (real mapInboundMessage, real
// effectiveActivityTime, real savepoints and conversation locks), the real T1 start path, claims, the dispatcher and the
// production first_message statement. What is a fixture: the logical clock of plan N.2a (the receipt time handed to the handler
// and the T1 decision clock advance together by SHIFT so the 30 minute cooldown needs no sleeping), and the scheduling order
// of two already-captured triggers (F3-1). messages.created_at is NEVER rewritten: it is the transaction start the database
// stamped, and every ordering claim below is proved from the persisted rows, held transactions and pg_blocking_pids.

// TEST-ONLY mutation seam (the pattern of step.db.test.ts): a pass-through unless `mutate.name` is set. Each mutant replaces the
// RESULT of the production statement with the answer a defective matcher would give, so the scenario, not the seam, decides.
const mutate = vi.hoisted(() => ({ name: null as string | null }));
vi.mock("@/db/ops/bot-step", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/db/ops/bot-step")>();
  const { sql: s } = await import("drizzle-orm");
  type Args = Parameters<typeof orig.readFirstEligibleRows>;
  /** "No earlier candidate-eligible row", ordered by `key` over `types` (the real statement orders by created_at over TEXT/INTERACTIVE/BUTTON). */
  const none = async (tx: Args[0], a: Args[1], key: "occurred_at" | "created_at", all: boolean) => {
    const k = s.raw(key);
    const kinds = all ? s`TRUE` : s`m.type IN ('TEXT', 'INTERACTIVE', 'BUTTON')`;
    const r = await tx.execute<{ ok: boolean }>(s`
      SELECT NOT EXISTS (
        SELECT 1 FROM messages m
         WHERE m.organization_id = ${a.organizationId} AND m.conversation_id = ${a.conversationId}
           AND m.direction = 'INBOUND' AND ${kinds}
           AND (m.${k}, m.id) < (SELECT c.${k}, c.id FROM messages c
                                  WHERE c.organization_id = ${a.organizationId} AND c.conversation_id = ${a.conversationId}
                                    AND c.id = ${a.messageId})) AS ok`);
    return r.rows[0]!.ok === true;
  };
  return {
    ...orig,
    readFirstEligibleRows: async (...a: Args) => {
      const r = await orig.readFirstEligibleRows(...a);
      switch (mutate.name) {
        case "legacy_raw": // the pre-D.4a matcher: provider occurred_at order and no previous-session fence
          return {
            ...r,
            firstInRecordHistory: await none(a[0], a[1], "occurred_at", false),
            noPreviousSessionStart: true,
          };
        case "raw_keep_fence": // provider order restored, the session fence kept
          return { ...r, firstInRecordHistory: await none(a[0], a[1], "occurred_at", false) };
        case "no_session_fence": // created_at order kept, the all-state session fence removed
          return { ...r, noPreviousSessionStart: true };
        case "no_record_order": // session fence kept, the earliest-eligible (created_at, id) predicate removed
          return { ...r, firstInRecordHistory: true };
        case "no_first_checks": // both predicates removed: every OTHER H.2 rule alone decides
          return { ...r, firstInRecordHistory: true, noPreviousSessionStart: true };
        case "count_ineligible": // every inbound type counts as a prior message (media included)
          return { ...r, firstInRecordHistory: await none(a[0], a[1], "created_at", true) };
        default:
          return r;
      }
    },
  };
});

// ACCEPTANCE RECONCILIATION (F3, plan l.1095, against D.5 / J.4a sibling cleanup, trigger freshness and cooldown):
//  - F3 transaction and record order (F3-1b, F3-2, F3-3): which message is "first" is decided by (created_at, id) of the retained
//    messages plus the all-state session fence, never by arrival, commit or provider time.
//  - J.4a / D.5 sibling cleanup (apply.ts endConversationTriggers): when a step leaves a session ended, every OTHER PENDING trigger
//    of the conversation is ended IGNORED / session_ended in the same transaction, `FOR UPDATE SKIP LOCKED`. A loser that was
//    already captured and whose row is not locked therefore ends session_ended and is NEVER evaluated for first_message (F3-1a,
//    F3-2). That is genuine runtime behaviour, not a missing evaluation.
//  - Freshness vs cooldown (eligibility.ts rules 7a and 6): staleness (> 10 minutes) is checked BEFORE cooldown (30 minutes). An
//    already-captured loser keeps its real input time, so at any decision clock past the cooldown it is stale_trigger, never
//    no_trigger_match (F3-4a). Only a message whose input time is itself >= 20 minutes after the winner's end can be both
//    fresh and past the cooldown: a message that did not exist when the winner committed (F1's B, F3-3's O), or, in the
//    logical-clock fixture, a surviving loser whose input time advances with the clock (F3-4b).
//  - A pre-existing loser can survive cleanup if its row is locked (SKIP LOCKED). One possible production interleaving is:
//    L is claimed and its T1 pauses after locking its trigger, before taking the conversation lock; an older-started inbound
//    transaction then commits W with an earlier input/record key. W becomes claimable, completes, and skips L's held row.
//    This is a source-level analysis, not an independently reproduced result. F3-4 instead uses an unrelated transaction as a
//    disclosed SYNTHETIC locker; it tests the skipped-trigger path without proving production reachability.
//  - Eligibility queried for a message is not the same as a terminalized trigger being processed: the original F3-1a loser stays
//    terminal and is never processed twice.

type Row = Record<string, unknown>;
type Real = {
  event: StoredEvent;
  message: Row & { id: string };
  trigger: (Row & { id: string }) | null;
};
const MIN = 60_000;
const SHIFT = 31 * MIN; // > the 30 minute cooldown, < the 10 minute input age only because input and clock advance together
const FROM = "15550100123";
const FIRST = { kind: "first_message" } as const;
const text = (body: string) => ({ type: "text", text: { body } });
const image = { type: "image", image: { id: "MEDIA08E9B4001", mime_type: "image/jpeg" } };

describe("E-FIRST ordering: historical inbound message order (F1, F2, F3, F4 mutations)", () => {
  let t: TestDb;
  let k: ReturnType<typeof runtimeKit>;
  const capture = buildWebhookWorkerHandlers({ BOTS_RUNTIME_ENABLED: "true" }).MESSAGE!;
  const gates: Array<() => void> = [];

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
    gates.splice(0).forEach((open) => open());
    k.releaseAll();
    mutate.name = null;
    vi.restoreAllMocks();
    // a held transaction must never outlive its test (its connection would hang the pool close)
    await until(
      async () =>
        (
          await k.one(
            "select count(*)::int n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'",
          )
        ).n === 0,
    );
  });

  // ------------------------------------------------------------------------------------------------ helpers

  const conv = (f: RuntimeFx) => f.w.student.conversation.id;
  const dbMs = async () => ((await k.one("select clock_timestamp() t")).t as Date).getTime();
  function finished(summary: StepSummary, status: "PROCESSED" | "IGNORED", outcome: string) {
    expect(summary).toMatchObject({ kind: "finished", status, outcome });
  }
  const sessionsOf = (f: RuntimeFx) =>
    k.rows("select * from bot_sessions where conversation_id = $1 order by started_control_seq", [
      conv(f),
    ]);
  const firstFacts = (f: RuntimeFx, messageId: string) =>
    t.db.transaction((tx) =>
      readFirstEligibleRows(tx as never, {
        organizationId: f.w.org.id,
        conversationId: conv(f),
        messageId,
      }),
    );
  /** The conversation's inbound history in database record order (created_at, id): the order first_message uses. */
  const recordOrder = async (f: RuntimeFx) =>
    (
      await k.rows(
        "select id from messages where conversation_id = $1 and direction = 'INBOUND' order by created_at, id",
        [conv(f)],
      )
    ).map((m) => m.id as string);
  /** Every durable record of the conversation's bot history, for before/after comparison. */
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
    messages: await k.rows(
      "select id, type, direction, created_at, occurred_at from messages where conversation_id = $1 order by created_at, id",
      [conv(f)],
    ),
    controlSeq: await k.controlSeq(f),
  });

  /**
   * Verified-delivery ingest (ingestVerifiedDelivery, no HTTP signature check) of one student message. `shiftMs` is the plan's logical clock: the receipt time (the stored event's
   * received_at AND the value handed to the handler) is the database clock plus the shift; the provider time defaults to that
   * receipt time. Nothing else is touched: messages.created_at stays the real transaction start.
   */
  async function stage(
    f: RuntimeFx,
    message: Row,
    o: { shiftMs?: number; providerMs?: number } = {},
  ): Promise<{ event: StoredEvent; receivedAt: Date; providerAt: Date }> {
    const account = await k.one(
      "select phone_number_id, waba_id from whatsapp_accounts where id = $1",
      [f.w.account.id],
    );
    const base = await dbMs();
    const logical = new Date(base + (o.shiftMs ?? 0));
    const providerAt = new Date(o.providerMs ?? logical.getTime());
    const options: DeliverOptions = {
      id: `wamid.TEST08E9B4.${randomUUID()}`,
      from: FROM,
      pn: account.phone_number_id as string,
      waba: account.waba_id as string,
      timestamp: providerAt,
      message,
    };
    let event = await deliver(t.db, options);
    if (o.shiftMs) {
      await k.q("update webhook_events set received_at = $2 where id = $1", [event.id, logical]);
      event = { ...event, receivedAt: logical };
    }
    return { event, receivedAt: event.receivedAt as Date, providerAt };
  }
  const handleWith = (impl: WebhookHandler, event: StoredEvent) =>
    t.db.transaction((tx) =>
      impl(tx as never, { ...event, eventType: "MESSAGE" } as never, handlerContext()),
    );
  async function read(event: StoredEvent): Promise<Real> {
    const message = (await k.one("select * from messages where wamid = $1", [
      event.providerObjectId,
    ])) as Real["message"];
    const trigger =
      ((await k.rows("select * from bot_triggers where message_id = $1", [message.id]))[0] as
        Real["trigger"] | undefined) ?? null;
    return { event, message, trigger };
  }
  /** One student message through the real ingest and the real capture-enabled handler, committed. */
  async function realInbound(
    f: RuntimeFx,
    message: Row,
    o: { shiftMs?: number; providerMs?: number } = {},
  ): Promise<Real> {
    const { event } = await stage(f, message, o);
    await handleWith(capture, event);
    return read(event);
  }
  /**
   * A handler transaction held open: BEGIN (so created_at is fixed), then it waits at `go` BEFORE touching the contact,
   * conversation or message tables. `started` carries the backend pid and the database transaction timestamp that will be the
   * message's created_at.
   */
  function held(event: StoredEvent, impl: WebhookHandler = capture) {
    const started = deferred<{ pid: number; startedAt: Date }>();
    const go = deferred();
    gates.push(go.resolve);
    const done = t.db.transaction(async (tx) => {
      const r = (
        await tx.execute<{ pid: number; ts: Date }>(
          sql`select pg_backend_pid() as pid, transaction_timestamp() as ts`,
        )
      ).rows[0]!;
      started.resolve({ pid: r.pid, startedAt: new Date(r.ts) });
      await go.promise;
      await impl(tx as never, { ...event, eventType: "MESSAGE" } as never, handlerContext());
    });
    done.catch(() => undefined); // surfaced by the awaiting test; never an unhandled rejection while it is held
    return { started: started.promise, release: go.resolve, done };
  }
  /** The conversation the real handler created for the first message, as a fixture world (the button-start pattern). */
  async function bind(f0: RuntimeFx, first: Real): Promise<RuntimeFx> {
    const c = await k.one("select id, contact_id from conversations where id = $1", [
      first.message.conversation_id,
    ]);
    return {
      ...f0,
      w: {
        ...f0.w,
        student: {
          contact: { id: c.contact_id as string },
          conversation: { id: c.id as string },
          message: { id: first.message.id },
        },
      },
    };
  }
  /** The first IMAGE (not capturable, never prior history) creates the conversation; the deployed world is bound to it. */
  async function mediaFirst(flow: Record<string, unknown>) {
    const f0 = await k.fixture(flow);
    const media = await realInbound(f0, image);
    expect(media.trigger).toBeNull();
    return { f: await bind(f0, media), media };
  }
  async function dispatchNotice(f: RuntimeFx) {
    const [r, ...more] = await k.botRequests(f);
    expect(more).toEqual([]);
    const { outcome } = await k.dispatchWith(
      k.accepted(`wamid.TEST08E9B4.${randomUUID()}`),
      r!.id as string,
    );
    expect(outcome).toBe("accepted");
  }
  const blockers = async (pid: number) =>
    (await k.one("select pg_blocking_pids($1) b", [pid])).b as number[];
  const backendState = async (pid: number) =>
    (await k.one("select state from pg_stat_activity where pid = $1", [pid])).state as string;
  const visible = async (wamid: unknown) =>
    Number((await k.one("select count(*)::int n from messages where wamid = $1", [wamid])).n);
  /** True when the conversation row AND the bot conversation advisory lock are both held by someone else. */
  async function conversationLocked(f: RuntimeFx) {
    const rowFree = await k
      .q("select 1 from conversations where id = $1 for update nowait", [conv(f)])
      .then(
        () => true,
        () => false,
      );
    const advisoryFree = (
      await k.one("select pg_try_advisory_xact_lock(hashtextextended($1, 0)) ok", [
        `bot-conv:${f.w.org.id}:${conv(f)}`,
      ])
    ).ok as boolean;
    return { rowFree, advisoryFree };
  }

  // ============================================================================================== F1 (plan l.1093)

  /**
   * A: provider time anchor+60 min, receipt anchor, so the stored raw occurred_at is 60 minutes ahead and the effective input is
   * receipt+5 min. A is the first eligible stored message, starts via first_message, completes at once (first-node END).
   * B: logical receipt 31 minutes later, provider time that moment (RAW B < RAW A), created key A < B.
   */
  async function f1(mutation: string | null) {
    await k.q("truncate organizations, webhook_requests cascade");
    const f0 = await k.fixture(endFirstFlow("Bye", FIRST));
    const anchor = await dbMs();
    const a = await realInbound(f0, text("hello A"), { providerMs: anchor + 60 * MIN });
    const f = await bind(f0, a);
    const aReceived = new Date(a.event.receivedAt as Date);
    // real mapping: raw provider time kept, effective input/activity capped at receipt + 5 minutes (ADR 0013 decision 6)
    expect((a.message.occurred_at as Date).getTime()).toBe(
      Math.floor((anchor + 60 * MIN) / 1000) * 1000,
    );
    expect((a.trigger!.input_occurred_at as Date).getTime()).toBe(aReceived.getTime() + 5 * MIN);
    expect((a.message.occurred_at as Date).getTime()).toBeGreaterThan(
      aReceived.getTime() + 50 * MIN,
    );
    expect(await firstFacts(f, a.message.id)).toEqual({
      firstInRecordHistory: true,
      noPreviousSessionStart: true,
      evidenceDefect: false,
    });

    finished(await k.run(a.trigger!.id), "PROCESSED", "session_started");
    const [s, ...more] = await sessionsOf(f);
    expect(more).toEqual([]);
    expect(s).toMatchObject({
      started_by_message_id: a.message.id,
      last_input_message_id: a.message.id,
      state: "COMPLETED",
    });
    expect(await k.events(s!.id as string)).toEqual([]); // no INPUT_* replay of the starting message
    const [aReq, ...moreReq] = await k.botRequests(f);
    expect(moreReq).toEqual([]);
    expect(aReq).toMatchObject({ bot_session_id: s!.id });
    await dispatchNotice(f);
    expect(
      await k.rows("select id, state from outbound_requests where id = $1", [aReq!.id]),
    ).toEqual([{ id: aReq!.id, state: "ACCEPTED" }]);
    const before = await history(f);

    // B at the logical receipt time anchor' + 31 min; the worker has no in-memory state (every k.run builds fresh deps and flow cache)
    const b = await realInbound(f, text("hello B"), { shiftMs: SHIFT });
    expect((b.message.occurred_at as Date).getTime()).toBeLessThan(
      (a.message.occurred_at as Date).getTime(),
    ); // raw B < raw A
    expect(await recordOrder(f)).toEqual([a.message.id, b.message.id]); // created key A < B
    expect(await firstFacts(f, b.message.id)).toEqual({
      firstInRecordHistory: false, // A precedes B by (created_at, id)
      noPreviousSessionStart: false, // and A's session already exists
      evidenceDefect: false,
    });
    // every other H.2 rule would permit a start: no live session, cooldown elapsed, cap far below 30, no staff activity
    const decisionFloor = (await dbMs()) + SHIFT;
    expect(decisionFloor - new Date(s!.ended_at as Date).getTime()).toBeGreaterThanOrEqual(
      30 * MIN,
    );
    expect((await sessionsOf(f)).map((x) => x.state)).toEqual(["COMPLETED"]); // no live session
    expect((await k.botRequests(f)).length).toBe(1); // far below the hourly cap of 30
    expect(
      await k.rows("select 1 from conversation_events where conversation_id = $1", [conv(f)]),
    ).toEqual([]); // no staff activity

    mutate.name = mutation;
    const summary = await k.run(b.trigger!.id, { readClock: k.shifted(SHIFT) });
    mutate.name = null;
    return { f, a, b, s: s!, aReq: aReq!, before, summary, history: await history(f) };
  }

  it("F1: the future-timestamp A starts and completes; B (raw provider time earlier, created key later, valid and fresh) cannot match first_message", async () => {
    const r = await f1(null);
    finished(r.summary, "IGNORED", "no_trigger_match");
    expect((await sessionsOf(r.f)).length).toBe(1);
    expect((await k.botRequests(r.f)).length).toBe(1);
    expect(r.history.sessions).toEqual(r.before.sessions); // A's session row is byte-identical
    expect(r.history.requests).toEqual(r.before.requests);
    expect(r.history.events).toEqual(r.before.events);
    expect(
      await k.rows("select status, outcome_code, session_id from bot_triggers where id = $1", [
        r.b.trigger!.id,
      ]),
    ).toEqual([{ status: "IGNORED", outcome_code: "no_trigger_match", session_id: null }]);

    // restart and redelivery: the stored webhooks are handled again (duplicates), the queue is polled again; nothing reopens
    const counts = await history(r.f);
    await handleWith(capture, r.a.event);
    await handleWith(capture, r.b.event);
    expect(await claimTriggers(t.db, 50)).toEqual([]);
    expect(await history(r.f)).toEqual(counts);
    expect(
      Number(
        (
          await k.one(
            "select count(*)::int n from messages where conversation_id = $1 and direction = 'INBOUND'",
            [conv(r.f)],
          )
        ).n,
      ),
    ).toBe(2);
    expect(
      Number(
        (
          await k.one("select count(*)::int n from bot_triggers where conversation_id = $1", [
            conv(r.f),
          ])
        ).n,
      ),
    ).toBe(2);
  });

  it("F1 mutation (F4): the legacy raw occurred_at matcher without the session fence starts a second first_message session after the cooldown", async () => {
    const r = await f1("legacy_raw");
    finished(r.summary, "PROCESSED", "session_started"); // DETECTED
    expect((await sessionsOf(r.f)).length).toBe(2);
    expect((await k.botRequests(r.f)).length).toBe(2);
  });

  // ============================================================================================== F2 (plan l.1094)

  /** Deployment paused while the pre-deployment messages arrive: capture admits nothing (no_deployment), the messages remain. */
  async function withoutDeployment<T>(f: RuntimeFx, body: () => Promise<T>): Promise<T> {
    await k.q("update bot_deployments set status = 'PAUSED' where id = $1", [f.deployment.id]);
    try {
      return await body();
    } finally {
      await k.q("update bot_deployments set status = 'ACTIVE' where id = $1", [f.deployment.id]);
    }
  }

  async function f2(mutation: string | null) {
    await k.q("truncate organizations, webhook_requests cascade");
    const f0 = await k.fixture(endFirstFlow("Bye", FIRST));
    const anchor = await dbMs();
    // A: the anomalous future raw timestamp, stored while no deployment is active, never starts any session
    const a = await withoutDeployment(f0, () =>
      realInbound(f0, text("hello A"), { providerMs: anchor + 60 * MIN }),
    );
    const f = await bind(f0, a);
    expect(a.trigger).toBeNull(); // no bot_triggers row for A: the history holds a message without any trigger
    expect(await sessionsOf(f)).toEqual([]);
    const b = await realInbound(f, text("hello B")); // fresh, raw B << raw A, created key A < B
    expect((b.message.occurred_at as Date).getTime()).toBeLessThan(
      (a.message.occurred_at as Date).getTime(),
    );
    expect(await recordOrder(f)).toEqual([a.message.id, b.message.id]);
    expect(await firstFacts(f, b.message.id)).toEqual({
      firstInRecordHistory: false,
      noPreviousSessionStart: true, // no session exists: only the record-order predicate can stop B
      evidenceDefect: false,
    });
    mutate.name = mutation;
    const summary = await k.run(b.trigger!.id);
    mutate.name = null;
    return { f, a, b, summary };
  }

  it("F2: an earlier eligible message that never started a session (stored before the deployment, future raw time) keeps first_message from a later fresh B", async () => {
    const r = await f2(null);
    finished(r.summary, "IGNORED", "no_trigger_match");
    expect(await sessionsOf(r.f)).toEqual([]);
    expect(await k.botRequests(r.f)).toEqual([]);
  });

  it("F2 mutation (F4): restoring provider-time order while keeping the session fence starts B, so the record-order predicate is what stops it", async () => {
    const r = await f2("raw_keep_fence");
    finished(r.summary, "PROCESSED", "session_started"); // DETECTED
    expect((await sessionsOf(r.f)).length).toBe(1);
  });

  async function f2Companion(mutation: string | null) {
    const anchor = await dbMs();
    await k.q("truncate organizations, webhook_requests cascade");
    const f0 = await k.fixture(endFirstFlow("Bye", FIRST));
    const media = await withoutDeployment(f0, () =>
      realInbound(f0, image, { providerMs: anchor + 60 * MIN }),
    );
    const f = await bind(f0, media);
    expect(media.trigger).toBeNull();
    const b = await realInbound(f, text("hello B"));
    expect(await firstFacts(f, b.message.id)).toEqual({
      firstInRecordHistory: true, // media is not eligible history
      noPreviousSessionStart: true,
      evidenceDefect: false,
    });
    mutate.name = mutation;
    const summary = await k.run(b.trigger!.id);
    mutate.name = null;
    return { f, summary };
  }
  it("F2 companion: a media-only pre-deployment conversation lets its first eligible B start after the deployment; counting media as prior (F4) stops it", async () => {
    const control = await f2Companion(null);
    finished(control.summary, "PROCESSED", "session_started");
    expect((await sessionsOf(control.f)).length).toBe(1);
    const mutant = await f2Companion("count_ineligible");
    finished(mutant.summary, "IGNORED", "no_trigger_match"); // DETECTED: media wrongly counted as prior history
    expect(await sessionsOf(mutant.f)).toEqual([]);
  });

  // ============================================================================================== F3 (plan l.1095)

  /**
   * F3-1. Two eligible messages persisted before evaluation by ONE transaction: equal created_at, the order is decided by the
   * UUID alone. `winnerFirst` chooses the head-of-line polling order through the triggers' input times (a scheduling fixture;
   * record order is never touched): true = the record-first message is polled first, false = the record-later one is.
   */
  async function tieScenario(winnerFirst: boolean) {
    await k.q("truncate organizations, webhook_requests cascade");
    const { f } = await mediaFirst(endFirstFlow("Bye", FIRST));
    const one = await stage(f, text("first?"));
    const two = await stage(f, text("second?"));
    await t.db.transaction(async (tx) => {
      await capture(tx as never, { ...one.event, eventType: "MESSAGE" } as never, handlerContext());
      await capture(tx as never, { ...two.event, eventType: "MESSAGE" } as never, handlerContext());
    });
    const m1 = await read(one.event);
    const m2 = await read(two.event);
    const tie = await k.one(
      "select a.created_at = b.created_at as same, (a.created_at, a.id) < (b.created_at, b.id) as a_first from messages a, messages b where a.id = $1 and b.id = $2",
      [m1.message.id, m2.message.id],
    );
    expect(tie.same).toBe(true); // one transaction: one created_at, the UUID decides
    const [recFirst, recLater] = tie.a_first ? [m1, m2] : [m2, m1];
    expect((await recordOrder(f)).slice(-2)).toEqual([recFirst.message.id, recLater.message.id]);
    expect(await firstFacts(f, recFirst.message.id)).toMatchObject({
      firstInRecordHistory: true,
      noPreviousSessionStart: true,
    });
    expect(await firstFacts(f, recLater.message.id)).toMatchObject({
      firstInRecordHistory: false,
      noPreviousSessionStart: true,
    });
    // head-of-line scheduling: input time then id, both fresh; only this fixture decides who is polled first
    const base = (await dbMs()) - 5_000;
    const polled = winnerFirst ? [recFirst, recLater] : [recLater, recFirst];
    for (const [i, x] of polled.entries())
      await k.q("update bot_triggers set input_occurred_at = $2 where id = $1", [
        x.trigger!.id,
        new Date(base + i * 1_000),
      ]);
    return { f, recFirst, recLater, polled };
  }

  it("F3-1a: record-first message polled first wins under the paused conversation lock; the deferred loser is ended by the winner and starts nothing", async () => {
    const { f, recFirst, recLater } = await tieScenario(true);
    const p = k.pause();
    const winner = k.run(recFirst.trigger!.id, { hooks: { afterRowLocks: p.hook } });
    const pid = await Promise.race([
      p.reached,
      winner.then(() => {
        throw new Error("the winner finished before its pause point");
      }),
    ]);
    expect(await backendState(pid)).toBe("idle in transaction");
    expect(await conversationLocked(f)).toEqual({ rowFree: false, advisoryFree: false });
    // head of line: the loser's trigger is not claimable while the winner's PENDING claim holds the conversation
    expect(await claimTriggers(t.db, 50)).toEqual([]);
    expect(await sessionsOf(f)).toEqual([]); // the winner has not committed
    p.release();
    finished(await winner, "PROCESSED", "session_started");
    expect((await sessionsOf(f)).length).toBe(1);
    expect((await sessionsOf(f))[0]).toMatchObject({ started_by_message_id: recFirst.message.id });
    // the winner's own T1 ended the session, which atomically ends the conversation's other PENDING triggers (D.5): the deferred
    // loser is never evaluated for first_message and can never start; its trigger is durably IGNORED / session_ended
    expect(await claimTriggers(t.db, 50)).toEqual([]);
    expect(
      await k.rows("select status, outcome_code, session_id from bot_triggers where id = $1", [
        recLater.trigger!.id,
      ]),
    ).toEqual([{ status: "IGNORED", outcome_code: "session_ended", session_id: null }]);
    expect((await sessionsOf(f)).length).toBe(1);
    expect((await k.botRequests(f)).length).toBe(1);
  });

  it("F3-1b: record-later message polled first cannot become first; the actual first, evaluated later, starts exactly one session", async () => {
    const { f, recFirst, recLater } = await tieScenario(false);
    finished(await k.run(recLater.trigger!.id), "IGNORED", "no_trigger_match");
    expect(await sessionsOf(f)).toEqual([]);
    expect(await k.botRequests(f)).toEqual([]);
    finished(await k.run(recFirst.trigger!.id), "PROCESSED", "session_started");
    const sessions = await sessionsOf(f);
    expect(sessions.length).toBe(1);
    expect(sessions[0]).toMatchObject({ started_by_message_id: recFirst.message.id });
    expect((await k.botRequests(f)).length).toBe(1);
  });

  /**
   * F3-4. The loser survives the sibling cleanup only because an UNRELATED transaction holds its trigger row when the winner
   * commits (SKIP LOCKED skips it; synthetic stand-in, see the reconciliation above). It is then evaluated after the cooldown.
   * `advanceInput` is the plan's logical clock for the trigger's input time (the decision clock always advances by SHIFT).
   */
  async function survivingLoser(mutation: string | null, advanceInput: boolean) {
    await k.q("truncate organizations, webhook_requests cascade");
    const { f, recFirst, recLater } = await tieScenario(true);
    const lockHeld = deferred<number>();
    const unlock = deferred();
    gates.push(unlock.resolve);
    const locker = t.db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from bot_triggers where id = ${recLater.trigger!.id} for update`,
      );
      lockHeld.resolve(
        (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
      );
      await unlock.promise;
    });
    locker.catch(() => undefined);
    const lockerPid = await lockHeld.promise;
    expect(await backendState(lockerPid)).toBe("idle in transaction");

    finished(await k.run(recFirst.trigger!.id), "PROCESSED", "session_started");
    const [winner] = await sessionsOf(f);
    expect(winner).toMatchObject({
      started_by_message_id: recFirst.message.id,
      state: "COMPLETED",
    });
    // SKIP LOCKED skipped the locked loser: it is still PENDING, unclaimed and unprocessed
    expect(
      await k.rows(
        "select status, outcome_code, attempts, claim_token from bot_triggers where id = $1",
        [recLater.trigger!.id],
      ),
    ).toEqual([{ status: "PENDING", outcome_code: null, attempts: 0, claim_token: null }]);
    unlock.resolve();
    await locker;
    await dispatchNotice(f); // rule 5: no BOT request of the winner may still be in flight

    // the durable keys: winner precedes the loser by (created_at, id) (same created_at: the UUID decides)
    expect(await recordOrder(f)).toEqual(
      expect.arrayContaining([recFirst.message.id, recLater.message.id]),
    );
    expect((await recordOrder(f)).slice(-2)).toEqual([recFirst.message.id, recLater.message.id]);
    const facts = await firstFacts(f, recLater.message.id);
    expect(facts).toEqual({
      firstInRecordHistory: false, // the record-order predicate rejects it on its own
      noPreviousSessionStart: false, // and so does the session fence
      evidenceDefect: false,
    });
    const before = await history(f);
    const cooldownOver =
      (await dbMs()) + SHIFT - new Date(winner!.ended_at as Date).getTime() >= 30 * MIN;
    expect(cooldownOver).toBe(true);
    if (advanceInput)
      await k.q(
        "update bot_triggers set input_occurred_at = input_occurred_at + $2 * interval '1 millisecond' where id = $1 and status = 'PENDING'",
        [recLater.trigger!.id, SHIFT],
      );
    mutate.name = mutation;
    const summary = await k.run(recLater.trigger!.id, { readClock: k.shifted(SHIFT) });
    mutate.name = null;
    return { f, summary, before, after: await history(f), loser: recLater.trigger!.id };
  }

  it("F3-4a: a surviving loser whose input time is real is stale_trigger after the cooldown: freshness is decided before cooldown and history", async () => {
    const r = await survivingLoser(null, false);
    finished(r.summary, "IGNORED", "stale_trigger");
    expect(r.after).toEqual(r.before);
  });

  it("F3-4b: a surviving loser evaluated after the cooldown with a fresh input still fails first_message; each predicate rejects it alone, both removed starts it", async () => {
    const control = await survivingLoser(null, true);
    finished(control.summary, "IGNORED", "no_trigger_match");
    expect(control.after.sessions).toEqual(control.before.sessions); // the winner's session stays authoritative
    expect(control.after.requests).toEqual(control.before.requests);
    expect(control.after.events).toEqual(control.before.events);
    expect((await sessionsOf(control.f)).length).toBe(1);
    expect(
      await k.rows("select status, outcome_code, attempts from bot_triggers where id = $1", [
        control.loser,
      ]),
    ).toEqual([{ status: "IGNORED", outcome_code: "no_trigger_match", attempts: 1 }]); // processed exactly once
    expect(await claimTriggers(t.db, 50)).toEqual([]);
    expect(
      Number(
        (
          await k.one("select count(*)::int n from bot_triggers where conversation_id = $1", [
            conv(control.f),
          ])
        ).n,
      ),
    ).toBe(2); // no trigger was created by the check

    // neither predicate is the proof of the other: removing one leaves the loser rejected by the other
    const noFence = await survivingLoser("no_session_fence", true);
    finished(noFence.summary, "IGNORED", "no_trigger_match");
    expect((await sessionsOf(noFence.f)).length).toBe(1);
    const noOrder = await survivingLoser("no_record_order", true);
    finished(noOrder.summary, "IGNORED", "no_trigger_match");
    expect((await sessionsOf(noOrder.f)).length).toBe(1);
    // and with both removed every OTHER rule (fresh, cooldown, caps, staff, deployment) lets it start: an isolated test
    const neither = await survivingLoser("no_first_checks", true);
    finished(neither.summary, "PROCESSED", "session_started");
    expect((await sessionsOf(neither.f)).length).toBe(2);
    expect((await k.botRequests(neither.f)).length).toBe(2);
  });

  /**
   * F3-2. Real row-lock serialization of two separate inbound transactions on one conversation: O is older, inserts its message
   * and then waits (holding the conversation row lock its activity update took) in the capture step; A starts later and blocks
   * on that row. The commit order O then A is forced by the lock, so record order and commit order agree.
   */
  it("F3-2: a later inbound transaction blocks on the older one's conversation lock; commit order is forced O then A and only O can be first", async () => {
    const { f } = await mediaFirst(endFirstFlow("Bye", FIRST));
    const base = await dbMs();
    const reachedCapture = deferred<void>();
    const proceed = deferred();
    gates.push(proceed.resolve);
    const holdingCapture = createInboundMessageHandler({
      captureBotTrigger: async (sp, input) => {
        reachedCapture.resolve();
        await proceed.promise;
        await insertBotTriggerIfAdmitted(sp, input);
      },
    });
    const o = await stage(f, text("older O"), { providerMs: base - 2_000 });
    const a = await stage(f, text("later A"), { providerMs: base });
    const oTx = held(o.event, holdingCapture);
    const oStart = await oTx.started;
    oTx.release();
    await reachedCapture.promise; // O has inserted its message and holds the conversation row lock
    expect(await visible(o.event.providerObjectId)).toBe(0); // not committed
    expect(await backendState(oStart.pid)).toBe("idle in transaction");

    const aTx = held(a.event);
    const aStart = await aTx.started;
    expect(aStart.startedAt.getTime()).toBeGreaterThan(oStart.startedAt.getTime()); // A is the LATER transaction
    aTx.release();
    await until(async () => (await blockers(aStart.pid)).includes(oStart.pid)); // A waits on O's lock (not on a sleep)
    expect(await visible(a.event.providerObjectId)).toBe(0);

    proceed.resolve();
    await oTx.done;
    await aTx.done;
    const oR = await read(o.event);
    const aR = await read(a.event);
    expect((oR.message.created_at as Date).getTime()).toBe(oStart.startedAt.getTime()); // created_at IS the transaction start
    expect((aR.message.created_at as Date).getTime()).toBe(aStart.startedAt.getTime());
    expect(await recordOrder(f)).toEqual([f.w.student.message.id, oR.message.id, aR.message.id]);
    expect(await firstFacts(f, oR.message.id)).toMatchObject({ firstInRecordHistory: true });
    expect(await firstFacts(f, aR.message.id)).toMatchObject({ firstInRecordHistory: false });

    finished(await k.run(oR.trigger!.id), "PROCESSED", "session_started");
    // O's T1 ended the session and with it the conversation's other PENDING triggers: A never starts anything
    expect(
      await k.rows("select status, outcome_code, session_id from bot_triggers where id = $1", [
        aR.trigger!.id,
      ]),
    ).toEqual([{ status: "IGNORED", outcome_code: "session_ended", session_id: null }]);
    const sessions = await sessionsOf(f);
    expect(sessions.length).toBe(1);
    expect(sessions[0]).toMatchObject({ started_by_message_id: oR.message.id });
    expect((await k.botRequests(f)).length).toBe(1);
  });

  /**
   * F3-3. The delayed inbound transaction (plan l.1095): O's transaction STARTS first and is held before the handler touches any
   * table. A is handled, captured, started and completed meanwhile. O then commits a message whose created_at (its transaction
   * start) sorts BEFORE A's, at the later logical receipt time. Only the all-state session fence stops it.
   */
  async function f33(mutation: string | null) {
    await k.q("truncate organizations, webhook_requests cascade");
    const { f } = await mediaFirst(endFirstFlow("Bye", FIRST));
    const o = await stage(f, text("delayed O"), { shiftMs: SHIFT });
    const oTx = held(o.event);
    const oStart = await oTx.started;
    // O holds no lock any other transaction could need: its handler has not touched a table
    expect(
      Number(
        (
          await k.one(
            "select count(*)::int n from pg_locks where pid = $1 and locktype in ('relation','tuple','advisory')",
            [oStart.pid],
          )
        ).n,
      ),
    ).toBe(0);

    const a = await realInbound(f, text("hello A"));
    expect(a.trigger).not.toBeNull();
    expect((a.message.created_at as Date).getTime()).toBeGreaterThan(oStart.startedAt.getTime()); // O started earlier
    expect(await blockers(oStart.pid)).toEqual([]);
    finished(await k.run(a.trigger!.id), "PROCESSED", "session_started"); // A is the first VISIBLE eligible message
    const [s] = await sessionsOf(f);
    expect(s).toMatchObject({ started_by_message_id: a.message.id, state: "COMPLETED" });
    await dispatchNotice(f);
    // commit order, proved: A's session is committed and visible while O's message is still uncommitted
    expect(await visible(o.event.providerObjectId)).toBe(0);
    expect(await backendState(oStart.pid)).toBe("idle in transaction");
    const before = await history(f);

    oTx.release();
    await oTx.done; // O commits now, after A's session
    const oR = await read(o.event);
    expect((oR.message.created_at as Date).getTime()).toBe(oStart.startedAt.getTime()); // the real transaction start, never rewritten
    expect(await recordOrder(f)).toEqual([f.w.student.message.id, oR.message.id, a.message.id]);
    expect(await firstFacts(f, oR.message.id)).toEqual({
      firstInRecordHistory: true, // the record-order predicate alone would allow it
      noPreviousSessionStart: false, // only the all-state session fence stops it
      evidenceDefect: false,
    });
    // fresh, newer than the last consumed input, trigger valid
    expect((oR.trigger!.input_occurred_at as Date).getTime()).toBeGreaterThan(
      (a.trigger!.input_occurred_at as Date).getTime(),
    );
    mutate.name = mutation;
    const summary = await k.run(oR.trigger!.id, { readClock: k.shifted(SHIFT) });
    mutate.name = null;
    return { f, a, oR, summary, before, after: await history(f) };
  }

  it("F3-3: an older-started inbound transaction that commits after the first session cannot reopen first_message, although its created_at key sorts earlier", async () => {
    const r = await f33(null);
    finished(r.summary, "IGNORED", "no_trigger_match");
    expect(r.after.sessions).toEqual(r.before.sessions);
    expect(r.after.requests).toEqual(r.before.requests);
    expect(r.after.events).toEqual(r.before.events);
    expect((await sessionsOf(r.f)).length).toBe(1);
    expect((await k.botRequests(r.f)).length).toBe(1);
    expect(
      await k.rows("select status, session_id from bot_triggers where id = $1", [r.oR.trigger!.id]),
    ).toEqual([{ status: "IGNORED", session_id: null }]);
  });

  it("F3-3 mutation (F4): removing the all-state session fence (created_at order kept) starts a second session for the delayed message", async () => {
    const r = await f33("no_session_fence");
    finished(r.summary, "PROCESSED", "session_started"); // DETECTED
    expect((await sessionsOf(r.f)).length).toBe(2);
    expect((await k.botRequests(r.f)).length).toBe(2);
  });
});
