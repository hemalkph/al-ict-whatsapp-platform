import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, expectPgError, type TestDb } from "@/db/__tests__/helpers";
import { changeConversationStatus } from "@/modules/inbox";
import { claimNext } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { addStudent, barrierKit, settledState } from "../bot-control/testing";
import { makeDue, runtimeKit, type RuntimeFx } from "./testing";

// E-CTL (Phase 08E-8C; plan N.2 `control-sequence.db.test.ts`, V3.2 J.1/K.10) on disposable PostgreSQL 17, READ COMMITTED.
// Invariant: conversations.control_seq equals the number of COMMITTED allocations, across every writer the migrations wire to
// allocate_conversation_control_seq (conversation_events, outbound_requests of both origins, bot_sessions start and
// live -> HANDED_OVER). Every assertion reads committed ROWS (the ledger below), never only a function's return value; the
// ledger must be exactly 1..N with no gap and no duplicate, so a rolled-back allocation can neither leave a gap nor a value.
// Concurrency is ordered by lock ownership (pg_blocking_pids via barrierKit.waitUntilBlocked), never by sleeping.

const STATUS_EVENT = `insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_status, to_status)
  values ($1, $2, 'STATUS', $3, 'OPEN', 'PENDING') returning control_seq`;

type Kit = ReturnType<typeof runtimeKit>;

/** Every allocated value of a conversation, from the committed rows of all four writers, with the counter itself. */
async function ledgerOf(kk: Kit, conversationId: string) {
  const r = await kk.rows(
    `select kind, v from (
       select 'event' as kind, control_seq as v from conversation_events where conversation_id = $1
       union all select 'request:' || origin, control_seq from outbound_requests where conversation_id = $1
       union all select 'session_start', started_control_seq from bot_sessions where conversation_id = $1
       union all select 'session_handover', handover_control_seq from bot_sessions
         where conversation_id = $1 and handover_control_seq is not null) s
     order by v`,
    [conversationId],
  );
  const counter = Number(
    (await kk.one("select control_seq from conversations where id = $1", [conversationId]))
      .control_seq,
  );
  return {
    values: r.map((x) => (x.v === null ? null : Number(x.v))),
    kinds: r.map((x) => x.kind as string),
    counter,
  };
}
const isContiguous = (l: { values: Array<number | null>; counter: number }) =>
  JSON.stringify(l.values) === JSON.stringify(Array.from({ length: l.counter }, (_, i) => i + 1));

const staffEventOf = (kk: Kit, f: RuntimeFx) =>
  kk.q(STATUS_EVENT, [f.w.org.id, f.w.student.conversation.id, f.w.staff.membershipId]);

/** Five staff writers queue on the conversation row behind one holder; resolves with the ledger once all have committed. */
async function fiveWritersBehindAHolder(kk: Kit, kb: ReturnType<typeof barrierKit>) {
  const f = await kk.fixture();
  const conv = f.w.student.conversation.id;
  const holder = await kb.hold(STATUS_EVENT, [f.w.org.id, conv, f.w.staff.membershipId]);
  const writers = Array.from({ length: 5 }, () => kb.settle(staffEventOf(kk, f)));
  // the barrier: all five are waiting on a lock before the holder is allowed to commit
  for (let i = 0; i < 1_000; i++) {
    const w = await kk.one(
      "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if (Number(w.n) === 5) break;
    await new Promise((r) => setTimeout(r, 10));
    if (i === 999) throw new Error("the five writers never all waited");
  }
  await holder.release();
  expect((await Promise.all(writers)).every((r) => r.ok)).toBe(true);
  return ledgerOf(kk, conv);
}

/** One committed allocation, one ROLLED-BACK allocation, one more committed allocation. */
async function rollbackBetweenCommits(kk: Kit, tt: TestDb) {
  const f = await kk.fixture();
  const conv = f.w.student.conversation.id;
  await staffEventOf(kk, f);
  const c = await tt.pool.connect();
  try {
    await c.query("begin");
    await c.query(STATUS_EVENT, [f.w.org.id, conv, f.w.staff.membershipId]);
    await c.query("rollback");
  } finally {
    c.release();
  }
  await staffEventOf(kk, f);
  return ledgerOf(kk, conv);
}

describe("conversations.control_seq across staff and bot writers (E-CTL)", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  let k: ReturnType<typeof runtimeKit>;

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
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    k.releaseAll();
    await kit.cleanup();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await t?.close();
  });

  const ledger = (conversationId: string) => ledgerOf(k, conversationId);
  /** The principal invariant: the counter equals the number of committed allocations, and they are exactly 1..counter. */
  async function expectLedger(conversationId: string) {
    const l = await ledger(conversationId);
    expect(l.values.every((v) => v !== null)).toBe(true);
    expect(l.values).toEqual(Array.from({ length: l.counter }, (_, i) => i + 1));
    return l;
  }
  const staffEvent = (f: RuntimeFx) => staffEventOf(k, f);
  const convOf = (f: RuntimeFx) => f.w.student.conversation.id;

  it("sequential: session start, BOT request, assignment, STAFF request and resolution allocate 1..5 in operation order", async () => {
    const f = await k.fixture();
    expect(await ledger(convOf(f))).toMatchObject({ values: [], counter: 0 });
    const { session, request } = await k.startedPrompt(f); // session insert, then the BOT request
    await k.assign(f);
    await k.submit(f);
    await changeConversationStatus(
      f.w.staff.ctx,
      convOf(f),
      { to: "RESOLVED", expected: "OPEN" },
      { db: t.db as never },
    );
    const l = await expectLedger(convOf(f));
    expect(l.kinds).toEqual(["session_start", "request:BOT", "event", "request:STAFF", "event"]);
    expect(l.counter).toBe(5);
    expect(Number(session.started_control_seq)).toBe(1);
    expect(Number((await k.request(request.id as string)).control_seq)).toBe(2);
  });

  it("application-supplied values are overwritten by the allocator (events and requests)", async () => {
    const f = await k.fixture();
    const e = await k.q(
      `insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_status, to_status, control_seq)
       values ($1, $2, 'STATUS', $3, 'OPEN', 'PENDING', 999) returning control_seq`,
      [f.w.org.id, convOf(f), f.w.staff.membershipId],
    );
    expect(Number(e.rows[0].control_seq)).toBe(1);
    await expectLedger(convOf(f));
  });

  it("a rolled-back allocation leaves no row, no gap and no lock; the next allocation continues from the committed count", async () => {
    const f = await k.fixture();
    await staffEvent(f); // committed: 1
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      const uncommitted = await c.query(STATUS_EVENT, [
        f.w.org.id,
        convOf(f),
        f.w.staff.membershipId,
      ]);
      expect(Number(uncommitted.rows[0].control_seq)).toBe(2); // allocated inside the open transaction
      // an outside reader still sees only the committed count
      expect(
        Number(
          (await k.one("select control_seq from conversations where id = $1", [convOf(f)]))
            .control_seq,
        ),
      ).toBe(1);
      await c.query("rollback");
    } finally {
      c.release();
    }
    expect(await expectLedger(convOf(f))).toMatchObject({ values: [1], counter: 1 });
    // lock released, and the next committed allocation takes 2 (not 3)
    await k.q("select 1 from conversations where id = $1 for update nowait", [convOf(f)]);
    expect(Number((await staffEvent(f)).rows[0].control_seq)).toBe(2);
    await expectLedger(convOf(f));
    const again = await rollbackBetweenCommits(k, t);
    expect(again).toMatchObject({ values: [1, 2], counter: 2 });
  });

  it("a failing statement inside an allocating transaction rolls the allocation back with it (error injected after the trigger ran)", async () => {
    const f = await k.fixture();
    await staffEvent(f);
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      await c.query(STATUS_EVENT, [f.w.org.id, convOf(f), f.w.staff.membershipId]); // allocates 2
      // injected failure: the BEFORE INSERT trigger allocates, then the shape CHECK rejects the row (statement and transaction)
      await expect(
        c.query(
          `insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_status, to_status)
           values ($1, $2, 'STATUS', $3, 'OPEN', NULL)`,
          [f.w.org.id, convOf(f), f.w.staff.membershipId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await c.query("rollback");
    } finally {
      c.release();
    }
    expect(await expectLedger(convOf(f))).toMatchObject({ values: [1], counter: 1 });
    await k.q("select 1 from conversations where id = $1 for update nowait", [convOf(f)]);
    expect(Number((await staffEvent(f)).rows[0].control_seq)).toBe(2);
    await expectLedger(convOf(f));
  });

  it("a BOT step that fails after it allocated (session + request) rolls both back; the retry allocates 1 and 2", async () => {
    const f = await k.fixture();
    const tr = await k.trigger(f, { first: true });
    const summary = await k.run(tr.id, {
      hooks: {
        beforeCommit: async () => {
          throw new Error("injected failure after the allocations");
        },
      },
    });
    expect(summary.kind).not.toBe("finished");
    expect(await ledger(convOf(f))).toMatchObject({ values: [], counter: 0 });
    expect(
      await k.rows("select 1 from bot_sessions where conversation_id = $1", [convOf(f)]),
    ).toEqual([]);
    await makeDue(t, tr.id);
    const retry = await k.run(tr.id);
    expect(retry).toMatchObject({ kind: "finished", outcome: "session_started" });
    const l = await expectLedger(convOf(f));
    expect(l.kinds).toEqual(["session_start", "request:BOT"]);
  });

  it("many concurrent staff writers on one conversation: all queue behind one holder and commit as distinct values 1..N", async () => {
    const l = await fiveWritersBehindAHolder(k, kit);
    expect(l.counter).toBe(6);
    expect(l.values).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("staff writer blocked behind a running bot step: the step takes 1 and 2, the staff event takes 3 and the dispatcher refuses the prompt (staff_took_over)", async () => {
    const f = await k.fixture();
    const tr = await k.trigger(f, { first: true });
    const claim = await k.claimOf(tr.id);
    const p = k.pause();
    const step = kit.settle(k.runClaim(claim, { hooks: { afterRowLocks: p.hook } }));
    const botPid = await p.reached; // the step holds the conversation lock and has written nothing yet
    const staff = kit.settle(staffEvent(f));
    await kit.waitUntilBlocked(botPid); // the staff allocation waits for the step
    expect(await ledger(convOf(f))).toMatchObject({ values: [], counter: 0 });
    p.release();
    const stepResult = await step;
    expect(stepResult.ok && stepResult.value).toMatchObject({ outcome: "session_started" });
    expect((await staff).ok).toBe(true);
    const l = await expectLedger(convOf(f));
    expect(l.kinds).toEqual(["session_start", "request:BOT", "event"]);
    // the later staff control is sequenced after the session start, so the bot's queued prompt is not sendable
    const transport = new FakeTransport();
    const { claim: sent, held } = await claimNext(k.dispatchDeps(transport));
    expect(sent).toBeNull();
    expect(held).toBe(1);
    expect(transport.calls).toHaveLength(0);
    expect((await k.botRequests(f))[0]).toMatchObject({
      state: "HELD",
      hold_reason: "staff_took_over",
    });
  });

  it("bot step blocked behind a staff writer: the staff event takes 1, the step sees it after its locks and starts nothing (no allocation by the bot)", async () => {
    const f = await k.fixture();
    const tr = await k.trigger(f, { first: true });
    const claim = await k.claimOf(tr.id);
    const holder = await kit.hold(STATUS_EVENT, [f.w.org.id, convOf(f), f.w.staff.membershipId]);
    const step = kit.settle(k.runClaim(claim));
    await kit.waitUntilBlocked(holder.pid); // the step reached the conversation lock and waits
    await holder.release();
    const stepResult = await step;
    expect(stepResult.ok && stepResult.value).toMatchObject({
      kind: "finished",
      status: "IGNORED",
      outcome: "superseded_by_staff",
      sessionId: null,
    });
    const l = await expectLedger(convOf(f));
    expect(l).toMatchObject({ kinds: ["event"], counter: 1 });
    expect(
      await k.rows("select 1 from bot_sessions where conversation_id = $1", [convOf(f)]),
    ).toEqual([]);
    expect(await k.botRequests(f)).toEqual([]);
  });

  it("assignment during an active session: the event is sequenced after the start, the student's next tap ends the session handed over and the handover takes the next value", async () => {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    await k.assign(f);
    const event = await k.one(
      "select control_seq from conversation_events where conversation_id = $1 and kind = 'ASSIGNMENT'",
      [convOf(f)],
    );
    expect(Number(event.control_seq)).toBeGreaterThan(Number(session.started_control_seq));
    // the prompt cannot be sent, whatever the student does: the dispatcher's rule reads the same control sequence
    const hold = await k.one("select bot_request_hold_code($1, $2) as code", [
      f.w.org.id,
      request.id,
    ]);
    expect(hold.code).toBe("staff_took_over");
    const token = session.awaiting_token as string | null;
    expect(token).toBeTruthy();
    const reply = await k.replyTrigger(f, token!, "a");
    const summary = await k.run(reply.id);
    expect(summary.kind).toBe("finished");
    const ended = await k.session(session.id as string);
    expect(ended).toMatchObject({
      state: "HANDED_OVER",
      end_reason: "system_handover",
      handover_reason: "staff_assigned",
    });
    expect(Number(ended.handover_control_seq)).toBeGreaterThan(Number(event.control_seq));
    const l = await expectLedger(convOf(f));
    expect(l.kinds).toEqual(["session_start", "request:BOT", "event", "session_handover"]);
  });

  it("staff reply: the STAFF request is sequenced after the start, ends the session handed over (staff_replied) and the BOT prompt is refused", async () => {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    await k.submit(f);
    const staffReq = await k.one(
      "select control_seq from outbound_requests where conversation_id = $1 and origin = 'STAFF'",
      [convOf(f)],
    );
    expect(Number(staffReq.control_seq)).toBeGreaterThan(Number(session.started_control_seq));
    expect(
      (await k.one("select bot_request_hold_code($1, $2) as code", [f.w.org.id, request.id])).code,
    ).toBe("staff_took_over");
    const reply = await k.replyTrigger(f, session.awaiting_token as string, "a");
    await k.run(reply.id);
    const ended = await k.session(session.id as string);
    expect(ended).toMatchObject({ state: "HANDED_OVER", handover_reason: "staff_replied" });
    expect(Number(ended.handover_control_seq)).toBeGreaterThan(Number(staffReq.control_seq));
    expect((await expectLedger(convOf(f))).kinds).toEqual([
      "session_start",
      "request:BOT",
      "request:STAFF",
      "session_handover",
    ]);
  });

  it("resolution: the RESOLVED event is sequenced after the start; the prompt is refused (conversation_resolved) and the session completes without a handover value", async () => {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    await changeConversationStatus(
      f.w.staff.ctx,
      convOf(f),
      { to: "RESOLVED", expected: "OPEN" },
      { db: t.db as never },
    );
    const resolved = await k.one(
      "select control_seq from conversation_events where conversation_id = $1 and to_status = 'RESOLVED'",
      [convOf(f)],
    );
    expect(Number(resolved.control_seq)).toBeGreaterThan(Number(session.started_control_seq));
    expect(
      (await k.one("select bot_request_hold_code($1, $2) as code", [f.w.org.id, request.id])).code,
    ).toBe("conversation_resolved");
    const reply = await k.replyTrigger(f, session.awaiting_token as string, "a");
    await k.run(reply.id);
    const ended = await k.session(session.id as string);
    expect(ended).toMatchObject({ state: "COMPLETED", end_reason: "conversation_resolved" });
    expect(ended.handover_control_seq).toBeNull(); // COMPLETED is not a handover: no allocation
    expect((await expectLedger(convOf(f))).kinds).toEqual([
      "session_start",
      "request:BOT",
      "event",
    ]);
  });

  it("independent counters: two conversations of one organization and a conversation of another organization never share or disturb a sequence", async () => {
    const a = await k.fixture();
    const b = await k.fixture(); // another organization, same shape
    const second = await addStudent(t.db, a.w.org.id, a.w.account.id);
    const secondConv = second.conversation.id;
    const ev = (f: RuntimeFx, conv: string) =>
      k.q(STATUS_EVENT, [f.w.org.id, conv, f.w.staff.membershipId]);
    // interleaved writers
    await ev(a, convOf(a));
    await ev(b, convOf(b));
    await ev(a, secondConv);
    await ev(a, convOf(a));
    await ev(b, convOf(b));
    await ev(b, convOf(b));
    expect(await expectLedger(convOf(a))).toMatchObject({ counter: 2 });
    expect(await expectLedger(secondConv)).toMatchObject({ counter: 1 });
    expect(await expectLedger(convOf(b))).toMatchObject({ counter: 3 });
    // an allocation naming another organization's conversation is refused and changes neither counter
    await expectPgError(
      t.pool.query("select allocate_conversation_control_seq($1, $2)", [b.w.org.id, convOf(a)]),
      "23503",
    );
    await expectPgError(
      t.pool.query(STATUS_EVENT, [b.w.org.id, convOf(a), b.w.staff.membershipId]),
      "23503",
    );
    expect((await expectLedger(convOf(a))).counter).toBe(2);
    expect((await expectLedger(convOf(b))).counter).toBe(3);
  });

  it("a concurrent allocation on one conversation does not block an allocation on another (the lock is per conversation row)", async () => {
    const a = await k.fixture();
    const b = await k.fixture();
    const holder = await kit.hold(STATUS_EVENT, [a.w.org.id, convOf(a), a.w.staff.membershipId]);
    const other = await kit.within(staffEvent(b), 5_000);
    expect(other).toBe(true);
    await holder.release();
    expect((await expectLedger(convOf(a))).counter).toBe(1);
    expect((await expectLedger(convOf(b))).counter).toBe(1);
  });

  it("an allocating insert refused by a foreign key (unknown actor) allocates nothing", async () => {
    const f = await k.fixture();
    const r = await kit.settle(
      k.q(STATUS_EVENT, [f.w.org.id, convOf(f), "00000000-0000-0000-0000-000000000000"]),
    );
    expect(settledState(r)).toBe("23503");
    expect((await ledger(convOf(f))).counter).toBe(0);
  });
});

// NEGATIVE CONTROLS (Phase 08E-8C, step 6). The same scenarios run on a SECOND disposable database whose allocator has been
// replaced, inside that database only (the migration files are never touched), by an unsafe one. Each scenario must then be
// DETECTED by the ledger check that the real tests above rely on, for the stated reason, so a passing real test is not vacuous.
describe("E-CTL negative controls: the ledger check detects an unsafe allocator", () => {
  let tm: TestDb;
  let kb: ReturnType<typeof barrierKit>;
  let km: Kit;

  beforeAll(async () => {
    tm = await createTestDatabase({
      sessionTimeouts: {
        lock_timeout: 15_000,
        statement_timeout: 20_000,
        idle_in_transaction_session_timeout: 25_000,
      },
    });
  });
  beforeEach(async () => {
    await tm.pool.query("truncate organizations, webhook_requests cascade");
    kb = barrierKit(tm);
    km = runtimeKit(tm);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await kb.cleanup();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await tm?.close();
  });

  it("MUTATION no-lock read-modify-write allocator: concurrent writers receive DUPLICATE values and the counter undercounts", async () => {
    await tm.pool
      .query(`create or replace function allocate_conversation_control_seq(p_organization_id uuid, p_conversation_id uuid) returns bigint language plpgsql as $$
      declare v bigint; begin
        select control_seq + 1 into v from conversations where organization_id = p_organization_id and id = p_conversation_id;
        update conversations set control_seq = v where organization_id = p_organization_id and id = p_conversation_id;
        return v; end $$`);
    const l = await fiveWritersBehindAHolder(km, kb);
    expect(isContiguous(l)).toBe(false);
    expect(new Set(l.values).size).toBeLessThan(l.values.length); // duplicates, not merely a gap
    expect(l.counter).toBeLessThan(l.values.length); // the counter no longer equals the number of allocations
  });

  it("MUTATION sequence-object allocator: a rolled-back allocation leaves a GAP (counter 3 after two committed events, values 1 and 3)", async () => {
    await tm.pool.query("create sequence ctl_mutation_seq");
    await tm.pool
      .query(`create or replace function allocate_conversation_control_seq(p_organization_id uuid, p_conversation_id uuid) returns bigint language plpgsql as $$
      declare v bigint; begin
        v := nextval('ctl_mutation_seq');
        update conversations set control_seq = v where organization_id = p_organization_id and id = p_conversation_id;
        return v; end $$`);
    const l = await rollbackBetweenCommits(km, tm);
    expect(l.values).toEqual([1, 3]);
    expect(isContiguous(l)).toBe(false);
  });

  it("MUTATION event trigger that does not allocate: the staff event is committed WITHOUT a control sequence (NULL), which the ledger refuses", async () => {
    await tm.pool
      .query(`create or replace function conversation_events_allocate_control_seq() returns trigger language plpgsql as $$
      begin NEW.control_seq := NULL; return NEW; end $$`);
    const f = await km.fixture();
    const r = await staffEventOf(km, f);
    expect(r.rows[0].control_seq).toBeNull();
    const l = await ledgerOf(km, f.w.student.conversation.id);
    expect(l.values).toEqual([null]);
    expect(isContiguous(l)).toBe(false);
  });
});
