import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestDatabase,
  seedAccount,
  seedConversation,
  type TestDb,
} from "@/db/__tests__/helpers";
import { dbClock } from "@/db/ops/bot-step";
import type { DbExecutor } from "@/db/ops/executor";
import { DEFAULT_SETTINGS } from "@/modules/bots/limits";
import { BOT_DISPATCH_DEADLINE_MS } from "@/modules/messaging/policy";
import { activateDeployment } from "../bot-control";
import { barrierKit, insertSession, type Student } from "../bot-control/testing";
import { claimFailureBackoffMs, deferralDelayMs } from "./backoff";
import type { StepDeps } from "./outbound";
import { RUNTIME_POLICY, sendWaitExpiresAtMs } from "./policy";
import {
  dbNow,
  insertTrigger,
  makeDue,
  menuFlow,
  runtimeKit,
  triggerRow,
  type RuntimeFx,
} from "./testing";
import { claimTriggers, type ClaimedTrigger } from "./trigger-queue";

// E-CLK (plan N.2; K.1 NB-E, K.1 skew guard, K.1a post-enqueue row; N.2a clock fixture) on disposable PostgreSQL 17.
// The decision clock is the database clock read after the LAST blocking lock (the account FOR SHARE, K.1 step 7); a
// post-enqueue skew above 2 s rolls the step back and a separate transaction re-locks the trigger under the same claim fence,
// reads a fresh clock and finishes (stale) or defers (fresh) it. Order between sessions is proved by lock ownership
// (pg_blocking_pids through barrierKit) and by waiting for the DATABASE clock to pass a value, never by sleeping.

// TEST-ONLY seams at the module boundary (the production files are never edited; every wrapper is a pass-through unless a test
// sets a field, and all fields are reset before every test):
// - mutation "clock_before_locks": the clock is read right after the trigger-row lock (step 0), BEFORE the advisory, deployment,
//   conversation, session and account locks, and that pre-lock value is what the step's next dbClock call returns, i.e. the
//   value production uses as its decision clock (the restored-defect design E-CLK's mutation names).
// - lockCalls / beforeRecoveryLock: observe the fence of each trigger lock and interpose between T1's rollback and the
//   recovery's (real, fenced) lock statement.
// - failAfterRecoveryDefer: the recovery's real fenced deferral runs, then the transaction fails.
const seam = vi.hoisted(() => ({
  mutation: null as "clock_before_locks" | null,
  preLock: null as Date | null,
  lockCalls: [] as Array<{
    organizationId: string;
    id: string;
    claimToken: string;
    startGuardMs: number;
  }>,
  beforeRecoveryLock: null as (() => Promise<void>) | null,
  failAfterRecoveryDefer: false,
}));
vi.mock("@/db/ops/bot-step", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/db/ops/bot-step")>();
  const { RUNTIME_POLICY: P } = await import("@/modules/bot-runtime/policy");
  return {
    ...orig,
    lockStepTrigger: async (...a: Parameters<typeof orig.lockStepTrigger>) => {
      const [tx, fence, startGuardMs] = a;
      seam.lockCalls.push({ ...fence, startGuardMs });
      const recovery = startGuardMs !== P.t1StartGuardMs;
      if (recovery && seam.beforeRecoveryLock) await seam.beforeRecoveryLock();
      const row = await orig.lockStepTrigger(...a);
      if (seam.mutation === "clock_before_locks" && !recovery && row !== null)
        seam.preLock = await orig.dbClock(tx);
      return row;
    },
    dbClock: async (...a: Parameters<typeof orig.dbClock>) => {
      if (seam.preLock !== null) {
        const v = seam.preLock;
        seam.preLock = null;
        return v;
      }
      return orig.dbClock(...a);
    },
  };
});
vi.mock("./trigger-queue", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./trigger-queue")>();
  return {
    ...orig,
    deferTrigger: async (...a: Parameters<typeof orig.deferTrigger>) => {
      const r = await orig.deferTrigger(...a);
      if (seam.failAfterRecoveryDefer)
        throw new Error("injected failure after the recovery deferral");
      return r;
    },
  };
});

const MIN = 60_000;
const HOUR = 60 * MIN;
type Row = Record<string, unknown>;
const ms = (v: unknown) => (v as Date).getTime();

describe("E-CLK: the decision clock and the post-enqueue skew guard (08E-8D2)", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  let k: ReturnType<typeof runtimeKit>;

  beforeAll(async () => {
    t = await createTestDatabase({
      sessionTimeouts: {
        lock_timeout: 10_000,
        statement_timeout: 15_000,
        idle_in_transaction_session_timeout: 20_000,
      },
    });
  });
  beforeEach(async () => {
    await t.pool.query("truncate organizations, webhook_requests cascade");
    kit = barrierKit(t);
    k = runtimeKit(t);
    seam.mutation = null;
    seam.preLock = null;
    seam.lockCalls = [];
    seam.beforeRecoveryLock = null;
    seam.failAfterRecoveryDefer = false;
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    k.releaseAll();
    try {
      await kit.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  });
  afterAll(async () => {
    if (t) await t.close();
  });

  // ------------------------------------------------------------------------------------------------------ helpers

  const count = async (sql: string, params: unknown[]) => Number((await k.one(sql, params)).n);
  /** Polls the DATABASE clock until it reads at least `atLeastMs` (a condition on the clock, not a sleep). */
  async function dbClockAtLeast(atLeastMs: number): Promise<Date> {
    for (let i = 0; i < 100_000; i++) {
      const now = await dbNow(t);
      if (now.getTime() >= atLeastMs) return now;
    }
    throw new Error("the database clock did not advance");
  }
  /** Epoch milliseconds of a timestamptz column at full precision (fractional). */
  const exactMs = async (table: string, column: string, id: string) =>
    Number(
      (
        await k.one(
          `select (extract(epoch from ${column}) * 1000)::float8 v from ${table} where id = $1`,
          [id],
        )
      ).v,
    );
  const locked = (text: string, params: unknown[]) =>
    t.pool.query(text, params).then(
      () => false,
      (e: { code?: string }) => {
        if (e.code === "55P03") return true;
        throw e;
      },
    );
  const keysFor = (
    f: RuntimeFx,
    student: Student,
    deploymentId = f.deployment.id,
    accountId = f.w.account.id,
  ) => ({
    organizationId: f.w.org.id,
    botId: f.bot.id,
    versionId: f.version.id,
    deploymentId,
    whatsappAccountId: accountId,
    student,
  });
  /** A COMPLETED session (start and end stamped by the database guard; never backdated). */
  async function completedSession(keys: ReturnType<typeof keysFor>) {
    const s = await insertSession(t.pool, keys);
    await k.q(
      "update bot_sessions set state = 'COMPLETED', end_reason = 'flow_end', revision = revision + 1 where id = $1",
      [s.id],
    );
    return {
      id: s.id as string,
      startedMs: await exactMs("bot_sessions", "started_at", s.id as string),
      endedMs: await exactMs("bot_sessions", "ended_at", s.id as string),
    };
  }
  /** The seeded first eligible message as a TEXT trigger, with exact counters and input time. */
  async function seededTrigger(
    f: RuntimeFx,
    o: { attempts?: number; deferrals?: number; inputAt?: Date } = {},
  ) {
    await k.q("update messages set type = 'TEXT', body = 'hi' where id = $1", [
      f.w.student.message.id,
    ]);
    return insertTrigger(t, k.ctxOf(f), {
      messageId: f.w.student.message.id,
      ...(o.attempts === undefined ? {} : { attempts: o.attempts }),
      ...(o.deferrals === undefined ? {} : { deferrals: o.deferrals }),
      inputOccurredAt: o.inputAt ?? new Date((await dbNow(t)).getTime() - 1_000),
    });
  }
  /** Everything a step of this conversation could have written. */
  async function effects(f: RuntimeFx) {
    const c = f.w.student.conversation.id;
    return {
      sessions: await count("select count(*)::int n from bot_sessions where conversation_id = $1", [
        c,
      ]),
      botRequests: await count(
        "select count(*)::int n from outbound_requests where conversation_id = $1 and origin = 'BOT'",
        [c],
      ),
      outboundMessages: await count(
        "select count(*)::int n from messages where conversation_id = $1 and direction = 'OUTBOUND'",
        [c],
      ),
      sessionEvents: await count(
        "select count(*)::int n from bot_session_events where conversation_id = $1",
        [c],
      ),
      controlSeq: await k.controlSeq(f),
    };
  }

  /**
   * Runs one claim while a separate connection holds the account row FOR UPDATE (T1's last blocking lock is the account
   * FOR SHARE). Proves T1 is blocked by that holder (and already holds the conversation row), takes a DATABASE clock marker
   * at least 2 ms after the block was observed, waits until the database clock is at least 2 ms past the marker, releases,
   * and returns the decision clock T1 actually used (its afterDecisionClock hook receives the production value).
   */
  async function behindAccountHold(
    f: RuntimeFx,
    claim: ClaimedTrigger,
    over: Partial<StepDeps> = {},
    onMarker?: (marker: Date) => void,
  ) {
    let decision: Date | null = null;
    const holder = await kit.hold("select id from whatsapp_accounts where id = $1 for update", [
      f.w.account.id,
    ]);
    const running = kit.settle(
      k.runClaim(claim, {
        ...over,
        hooks: {
          afterDecisionClock: async (_tx, at) => {
            decision = at;
          },
        },
      }),
    );
    const t1Pid = await kit.waitUntilBlocked(holder.pid);
    const blockers = await kit.blockersOf(t1Pid);
    const conversationHeldByT1 = await locked(
      "select 1 from conversations where id = $1 for update nowait",
      [f.w.student.conversation.id],
    );
    const seen = await dbNow(t);
    const marker = await dbClockAtLeast(seen.getTime() + 2);
    onMarker?.(marker);
    await dbClockAtLeast(marker.getTime() + 2);
    await holder.release();
    const settled = await running;
    if (!settled.ok) throw settled.error;
    if (decision === null) throw new Error("T1 never reached its decision clock");
    return {
      summary: settled.value,
      decision: decision as Date,
      marker,
      blockers,
      holderPid: holder.pid,
      conversationHeldByT1,
    };
  }
  type Held = Awaited<ReturnType<typeof behindAccountHold>>;
  const expectBlockedByHolder = (o: Held) => {
    expect(o.blockers).toEqual([o.holderPid]);
    expect(o.conversationHeldByT1, "T1 waits at the account, after its conversation lock").toBe(
      true,
    );
  };

  // ======================================================================================= E-CLK-1 / E-CLK-2

  /** A fresh first_message start behind the account hold, production clock (no seam). */
  async function freshStartScenario() {
    const f = await k.fixture();
    const tr = await k.trigger(f, { first: true });
    const o = await behindAccountHold(f, await k.claimOf(tr.id));
    const session = (
      await k.rows("select * from bot_sessions where conversation_id = $1", [
        f.w.student.conversation.id,
      ])
    )[0];
    const [request] = await k.botRequests(f);
    const message = request
      ? await k.one("select * from messages where id = $1", [request.message_id])
      : undefined;
    return { f, tr, o, session, request, message };
  }

  /** A start that is in cooldown before the account wait and out of it after (DB-clock offset fixture, N.2a). */
  async function cooldownScenario() {
    const f = await k.fixture(menuFlow());
    const prior = await completedSession(keysFor(f, f.w.student));
    const boundaryMs = Math.ceil(prior.endedMs) + RUNTIME_POLICY.cooldownMs;
    const messageId = await k.inbound(f, { body: "menu" });
    // the student's message is one second old at the boundary (logical time); fresh whichever clock decides
    const tr = await insertTrigger(t, k.ctxOf(f), {
      messageId,
      inputOccurredAt: new Date(boundaryMs - 1_000),
    });
    let offset: number | null = null;
    const readClock = async (tx: DbExecutor) => {
      if (offset === null) throw new Error("decision clock read before the marker");
      return new Date((await dbClock(tx)).getTime() + offset);
    };
    const o = await behindAccountHold(f, await k.claimOf(tr.id), { readClock }, (m) => {
      offset = boundaryMs - m.getTime(); // the marker maps exactly onto the end of the cooldown
    });
    return { f, tr, o, boundaryMs, offset: offset! };
  }

  /** A start whose per-contact 24 h window drops the oldest of three sessions only after the account wait. */
  async function capScenario() {
    const f = await k.fixture(menuFlow());
    const acc2 = await seedAccount(t.db, f.w.org.id);
    await k.q(
      "update whatsapp_accounts set status = 'ACTIVE', credential_ref = 'WA_TOKEN_TEST', archived_at = NULL where id = $1",
      [acc2.id],
    );
    const conv2 = await seedConversation(t.db, {
      organizationId: f.w.org.id,
      whatsappAccountId: acc2.id,
      contactId: f.w.student.contact.id,
    });
    const m2 = await k.one(
      "insert into messages (organization_id, conversation_id, whatsapp_account_id, wamid, direction, type, body, occurred_at) values ($1,$2,$3,$4,'INBOUND','TEXT','hi',clock_timestamp()) returning id",
      [f.w.org.id, conv2.id, acc2.id, `wamid.${randomUUID()}`],
    );
    const dep2 = (
      await activateDeployment(
        f.w.admin.ctx,
        { botId: f.bot.id, versionId: f.version.id, whatsappAccountId: acc2.id, priority: 1 },
        { db: t.db },
      )
    ).value;
    const other: Student = {
      contact: f.w.student.contact,
      conversation: conv2,
      message: { id: m2.id as string },
    } as Student;
    const keys = keysFor(f, other, dep2.id, acc2.id);
    const oldest = await completedSession(keys);
    // fixture margin: the two later sessions start at least 1 s (database clock) after the oldest
    await dbClockAtLeast(Math.ceil(oldest.startedMs) + 1_000);
    const later = [await completedSession(keys), await completedSession(keys)];
    const boundaryMs = Math.ceil(oldest.startedMs) + RUNTIME_POLICY.contactSessionWindowMs;
    // the service window is open at the logical decision time (enqueue assesses it with the decision clock)
    await k.q("update conversations set last_inbound_at = $2 where id = $1", [
      f.w.student.conversation.id,
      new Date(boundaryMs - MIN).toISOString(),
    ]);
    const tr = await seededTrigger(f, { inputAt: new Date(boundaryMs - 1_000) });
    let offset: number | null = null;
    const readClock = async (tx: DbExecutor) => {
      if (offset === null) throw new Error("decision clock read before the marker");
      return new Date((await dbClock(tx)).getTime() + offset);
    };
    const o = await behindAccountHold(f, await k.claimOf(tr.id), { readClock }, (m) => {
      offset = boundaryMs - m.getTime(); // the marker maps exactly onto oldest.started_at + 24 h
    });
    const contactSessions = await count(
      "select count(*)::int n from bot_sessions where contact_id = $1",
      [f.w.student.contact.id],
    );
    return { f, tr, o, oldest, later, boundaryMs, contactSessions };
  }

  /** A duplicate tap on an ACCEPTED, not yet reconciled prompt: T1 applies the acceptance (writes expires_at) behind the hold. */
  async function expiresScenario() {
    const f = await k.fixture(menuFlow());
    const x = await k.acceptedPrompt(f);
    const token1 = x.session.awaiting_token as string;
    const first = await k.replyTrigger(f, token1, "a");
    expect(await k.run(first.id)).toMatchObject({ kind: "finished", outcome: "input_accepted" });
    const [, r2] = await k.botRequests(f);
    const { outcome } = await k.dispatchWith(
      k.accepted(`wamid.ECLK.${randomUUID()}`),
      r2!.id as string,
    );
    expect(outcome).toBe("accepted");
    const before = await k.session(x.session.id as string);
    expect(before).toMatchObject({
      state: "WAITING_FOR_SEND",
      step_seq: 2,
      expires_at: null,
      last_consumed_token: token1,
    });
    const dup = await k.replyTrigger(f, token1, "a");
    const o = await behindAccountHold(f, await k.claimOf(dup.id));
    return {
      f,
      dup,
      o,
      before,
      after: await k.session(x.session.id as string),
      requests: await k.botRequests(f),
    };
  }

  describe("E-CLK-1: T1 waits at the account row; every decision value comes from the clock read after the wait", () => {
    it("fresh start: decision clock after the marker; trigger, session and request times all derive from it", async () => {
      const { tr, o, session, request, message } = await freshStartScenario();
      expectBlockedByHolder(o);
      expect(o.summary).toMatchObject({
        kind: "finished",
        status: "PROCESSED",
        outcome: "session_started",
      });
      const D = o.decision.getTime();
      expect(D).toBeGreaterThanOrEqual(o.marker.getTime() + 2);
      const trig = await triggerRow(t, tr.id);
      expect(ms(trig.processed_at)).toBe(D);
      expect(ms(session!.send_wait_expires_at)).toBe(sendWaitExpiresAtMs(D));
      expect(ms(session!.send_wait_expires_at)).toBe(D + 5 * MIN + 30_000);
      expect(ms(session!.started_at)).toBeGreaterThanOrEqual(D); // stamped by the guard at insert, after the clock
      expect(ms(request!.next_attempt_at)).toBe(D);
      expect(ms(request!.dispatch_deadline)).toBe(D + BOT_DISPATCH_DEADLINE_MS);
      expect(ms(message!.occurred_at)).toBe(D);
      // AC-5: created_at keeps the transaction-start default, which is BEFORE the wait; it is never the decision clock
      expect(ms(request!.created_at)).toBeLessThan(o.marker.getTime());
    });

    it("cooldown: the post-wait clock is past the cooldown, so the start proceeds at that clock", async () => {
      const { f, tr, o, boundaryMs, offset } = await cooldownScenario();
      expectBlockedByHolder(o);
      expect(o.marker.getTime() + offset).toBe(boundaryMs);
      expect(o.decision.getTime()).toBeGreaterThanOrEqual(boundaryMs + 2);
      expect(o.summary).toMatchObject({
        kind: "finished",
        status: "PROCESSED",
        outcome: "session_started",
      });
      expect(ms((await triggerRow(t, tr.id)).processed_at)).toBe(o.decision.getTime());
      expect((await effects(f)).sessions).toBe(2);
    });

    it("per-contact 24 h cap: the post-wait window excludes the oldest of three sessions, so a fourth may start", async () => {
      const { tr, o, oldest, later, boundaryMs, contactSessions } = await capScenario();
      expectBlockedByHolder(o);
      const windowStart = o.decision.getTime() - RUNTIME_POLICY.contactSessionWindowMs;
      expect(o.decision.getTime()).toBeGreaterThanOrEqual(boundaryMs + 2);
      // fixture preconditions, asserted (never assumed): oldest outside, the two later sessions inside the window
      expect(windowStart).toBeGreaterThan(oldest.startedMs);
      for (const s of later) expect(Math.floor(s.startedMs)).toBeGreaterThan(windowStart);
      expect(o.summary).toMatchObject({
        kind: "finished",
        status: "PROCESSED",
        outcome: "session_started",
      });
      expect(ms((await triggerRow(t, tr.id)).processed_at)).toBe(o.decision.getTime());
      expect(contactSessions).toBe(4);
    });

    it("expires_at: a duplicate tap on an ACCEPTED prompt makes T1 apply the acceptance; expires_at = post-wait clock + idle timeout", async () => {
      const { dup, o, before, after, requests } = await expiresScenario();
      expectBlockedByHolder(o);
      const D = o.decision.getTime();
      expect(D).toBeGreaterThanOrEqual(o.marker.getTime() + 2);
      expect(o.summary).toMatchObject({
        kind: "finished",
        status: "IGNORED",
        outcome: "duplicate_reply",
      });
      expect(after).toMatchObject({
        state: "WAITING_FOR_INPUT",
        step_seq: 2,
        send_wait_expires_at: null,
      });
      expect((after.awaiting as Row).phase).toBe("SENT");
      expect(ms(after.expires_at)).toBe(D + DEFAULT_SETTINGS.idleTimeoutMinutes * MIN);
      expect(Number(after.revision)).toBe(Number(before.revision) + 1);
      expect(requests).toHaveLength(2); // no new request
      expect(ms((await triggerRow(t, dup.id)).processed_at)).toBe(D);
    });
  });

  describe("E-CLK-2 MUTATION: reading the decision clock before the locks (the pre-lock value becomes the decision value)", () => {
    beforeEach(() => {
      seam.mutation = "clock_before_locks";
    });

    it("fresh start: the decision clock precedes the marker and every derived time moves with it", async () => {
      const { tr, o, session } = await freshStartScenario();
      expectBlockedByHolder(o);
      const D = o.decision.getTime();
      expect(D).toBeLessThanOrEqual(o.marker.getTime() - 2); // what E-CLK-1 rejects
      expect(ms((await triggerRow(t, tr.id)).processed_at)).toBe(D);
      expect(ms(session!.send_wait_expires_at)).toBe(sendWaitExpiresAtMs(D));
    });

    it("cooldown: the pre-lock clock is still inside the cooldown: IGNORED cooldown, no session", async () => {
      const { f, o, boundaryMs } = await cooldownScenario();
      expect(o.decision.getTime()).toBeLessThanOrEqual(boundaryMs - 2);
      expect(o.summary).toMatchObject({ kind: "finished", status: "IGNORED", outcome: "cooldown" });
      expect((await effects(f)).sessions).toBe(1);
    });

    it("cap: the pre-lock window still contains all three sessions: IGNORED session_cap", async () => {
      const { o, boundaryMs, contactSessions } = await capScenario();
      expect(o.decision.getTime()).toBeLessThanOrEqual(boundaryMs - 2);
      expect(o.summary).toMatchObject({
        kind: "finished",
        status: "IGNORED",
        outcome: "session_cap",
      });
      expect(contactSessions).toBe(3);
    });

    it("expires_at derives from the pre-lock clock", async () => {
      const { o, after } = await expiresScenario();
      expect(o.decision.getTime()).toBeLessThanOrEqual(o.marker.getTime() - 2);
      expect(ms(after.expires_at)).toBe(
        o.decision.getTime() + DEFAULT_SETTINGS.idleTimeoutMinutes * MIN,
      );
      expect(ms(after.expires_at)).toBeLessThan(
        o.marker.getTime() + DEFAULT_SETTINGS.idleTimeoutMinutes * MIN,
      );
    });
  });

  // ======================================================================================= skew guard and recovery

  /**
   * Decision clock = the database clock; post-enqueue read = decision + `postMs` EXACTLY (no second real reading, so the gap
   * is exact); recovery read = the database clock + `recoveryOffsetMs` (the N.2a offset fixture), or a thrown error.
   */
  function skewClock(o: { postMs: number; recoveryOffsetMs?: number; failRecoveryRead?: boolean }) {
    const values: Date[] = [];
    const raw: Date[] = [];
    const readClock = async (tx: DbExecutor) => {
      const n = values.length + 1;
      let v: Date;
      if (n === 2) v = new Date(values[0]!.getTime() + o.postMs);
      else {
        if (n >= 3 && o.failRecoveryRead)
          throw new Error("injected failure of the recovery clock read");
        const r = await dbClock(tx);
        raw.push(r);
        v = new Date(r.getTime() + (n >= 3 ? (o.recoveryOffsetMs ?? 0) : 0));
      }
      values.push(v);
      return v;
    };
    return { readClock, values, raw };
  }
  const expectFenceRelocked = (claim: ClaimedTrigger) => {
    const fence = {
      organizationId: claim.organizationId,
      id: claim.id,
      claimToken: claim.claimToken,
    };
    expect(seam.lockCalls).toEqual([
      { ...fence, startGuardMs: RUNTIME_POLICY.t1StartGuardMs },
      { ...fence, startGuardMs: RUNTIME_POLICY.claimLeaseMs },
    ]);
  };
  const triggerJson = async (id: string) =>
    (await k.one("select to_jsonb(x) j from bot_triggers x where id = $1", [id])).j as Row;

  describe("E-CLK-3: fresh input after a post-enqueue skew", () => {
    for (const [attempts, deferrals] of [
      [0, 0],
      [2, 2],
    ] as const)
      it(`rolls back fully, re-locks under the same fence and defers once (attempts ${attempts}, deferrals ${deferrals})`, async () => {
        const f = await k.fixture();
        const tr = await seededTrigger(f, { attempts, deferrals });
        const before = await effects(f);
        const claim = await k.claimOf(tr.id);
        expect(claim.attempts).toBe(attempts + 1);
        const clock = skewClock({ postMs: 3_000 });
        const summary = await k.runClaim(claim, { readClock: clock.readClock });
        expect(summary).toEqual({ kind: "deferred", reason: "clock_skew" });
        expect(clock.values).toHaveLength(3);
        expectFenceRelocked(claim);
        expect(await effects(f)).toEqual(before);
        expect(before).toMatchObject({
          sessions: 0,
          botRequests: 0,
          outboundMessages: 0,
          sessionEvents: 0,
        });
        const row = await triggerRow(t, tr.id);
        expect(row).toMatchObject({
          status: "PENDING",
          outcome_code: null,
          processed_at: null,
          attempts, // the claim-time attempt refunded exactly once
          deferrals: deferrals + 1,
          claim_token: null,
          claimed_at: null,
          last_error_code: null,
          session_id: null,
        });
        expect(ms(row.next_attempt_at)).toBe(
          clock.values[2]!.getTime() + deferralDelayMs(deferrals),
        );
        expect(
          await count("select count(*)::int n from messages where id = $1", [tr.messageId]),
        ).toBe(1);

        // repeating with the old claim changes nothing (no second refund, no effect)
        const snapshot = await triggerJson(tr.id);
        expect(await k.runClaim(claim)).toEqual({ kind: "lost_claim" });
        expect(await triggerJson(tr.id)).toEqual(snapshot);
        expect(await effects(f)).toEqual(before);

        // a later legitimate claim processes the input exactly once
        await makeDue(t, tr.id);
        expect(await k.run(tr.id)).toMatchObject({ kind: "finished", outcome: "session_started" });
        expect(await effects(f)).toMatchObject({
          sessions: 1,
          botRequests: 1,
          outboundMessages: 1,
        });
      });
  });

  describe("E-CLK-4: input fresh at the decision clock, stale at the recovery clock", () => {
    it("finishes IGNORED stale_trigger at the recovery clock, without refund or counter change and without effects", async () => {
      const f = await k.fixture();
      const p0 = (await dbNow(t)).getTime();
      const inputAt = new Date(p0 - RUNTIME_POLICY.maxInputAgeMs + MIN); // nine minutes old now
      const tr = await seededTrigger(f, { inputAt });
      const before = await effects(f);
      const claim = await k.claimOf(tr.id);
      const clock = skewClock({ postMs: 3_000, recoveryOffsetMs: 2 * MIN });
      const summary = await k.runClaim(claim, { readClock: clock.readClock });
      expect(summary).toMatchObject({
        kind: "finished",
        status: "IGNORED",
        outcome: "stale_trigger",
      });
      const [decision, , recovery] = clock.values.map((d) => d.getTime());
      expect(decision! - inputAt.getTime()).toBeLessThanOrEqual(RUNTIME_POLICY.maxInputAgeMs); // fresh in T1
      expect(recovery! - inputAt.getTime()).toBeGreaterThan(RUNTIME_POLICY.maxInputAgeMs); // stale at recovery
      expect(recovery).toBe(clock.raw[1]!.getTime() + 2 * MIN);
      expectFenceRelocked(claim);
      const row = await triggerRow(t, tr.id);
      expect(row).toMatchObject({
        status: "IGNORED",
        outcome_code: "stale_trigger",
        attempts: 1, // the claim's attempt stays charged: no refund
        deferrals: 0,
        claim_token: null,
        claimed_at: null,
        last_error_code: null,
        session_id: null,
      });
      expect(ms(row.processed_at)).toBe(recovery);
      expect(await effects(f)).toEqual(before);
      expect(
        await count("select count(*)::int n from messages where id = $1", [tr.messageId]),
      ).toBe(1);
      expect(await k.runClaim(claim)).toEqual({ kind: "lost_claim" });
    });
  });

  describe("E-CLK-5: another worker re-claims between the rollback and the recovery", () => {
    it("the old token cannot touch the new claim: lost_claim, no refund, no effect; the replacement claim runs once", async () => {
      const f = await k.fixture();
      const tr = await seededTrigger(f);
      const before = await effects(f);
      const claim = await k.claimOf(tr.id);
      let replacement: ClaimedTrigger | null = null;
      seam.beforeRecoveryLock = async () => {
        // T1 has rolled back (its row lock is gone); its lease expires and a second worker claims through the real claim
        await k.q(
          "update bot_triggers set claimed_at = clock_timestamp() - interval '2 minutes' where id = $1",
          [tr.id],
        );
        replacement = (await claimTriggers(t.db, 50)).find((c) => c.id === tr.id) ?? null;
      };
      const clock = skewClock({ postMs: 3_000 });
      expect(await k.runClaim(claim, { readClock: clock.readClock })).toEqual({
        kind: "lost_claim",
      });
      expect(replacement).not.toBeNull();
      const r = replacement! as ClaimedTrigger;
      expect(r.claimToken).not.toBe(claim.claimToken);
      expectFenceRelocked(claim); // the recovery used the OLD fence, and the real statement matched no row
      expect(clock.values).toHaveLength(2); // no recovery clock: nothing was decided
      const row = await triggerRow(t, tr.id);
      expect(row).toMatchObject({
        status: "PENDING",
        attempts: 2, // one per claim; never refunded
        deferrals: 0,
        claim_token: r.claimToken,
        last_error_code: null,
        processed_at: null,
      });
      expect(ms(row.claimed_at)).toBe(r.claimedAt.getTime());
      expect(await effects(f)).toEqual(before);

      seam.beforeRecoveryLock = null;
      const snapshot = await triggerJson(tr.id);
      expect(await k.runClaim(claim)).toEqual({ kind: "lost_claim" });
      expect(await triggerJson(tr.id)).toEqual(snapshot);
      expect(await k.runClaim(r)).toMatchObject({ kind: "finished", outcome: "session_started" });
      expect(await effects(f)).toMatchObject({ sessions: 1, botRequests: 1, outboundMessages: 1 });
    });
  });

  /** A live session WAITING_FOR_SEND whose prompt R was ACCEPTED, plus a reply trigger that would enqueue R2. */
  async function continuationWorld() {
    const f = await k.fixture(menuFlow());
    const x = await k.acceptedPrompt(f);
    const reply = await k.replyTrigger(f, x.session.awaiting_token as string, "a");
    const s = x.session.id as string;
    const snap = async () => ({
      session: await k.sessionJson(s),
      events: await k.events(s),
      requests: (await k.botRequests(f)).map((r) => [r.id, r.state, r.bot_step_seq]),
      effects: await effects(f),
      conversation: (
        await k.one("select to_jsonb(c) j from conversations c where id = $1", [
          f.w.student.conversation.id,
        ])
      ).j,
    });
    seam.lockCalls = []; // the fixture's own T1 (the session start) is not the step under test
    return { f, x, reply, s, snap };
  }

  describe("E-CLK-6: skew rollback on a live session (continuation)", () => {
    it("the session row, its events, requests and the conversation's control sequence are byte-identical; the trigger defers", async () => {
      const w = await continuationWorld();
      const before = await w.snap();
      const claim = await k.claimOf(w.reply.id);
      const clock = skewClock({ postMs: 3_000 });
      expect(await k.runClaim(claim, { readClock: clock.readClock })).toEqual({
        kind: "deferred",
        reason: "clock_skew",
      });
      expectFenceRelocked(claim);
      expect(await w.snap()).toEqual(before);
      expect(
        await count("select count(*)::int n from messages where id = $1", [w.reply.messageId]),
      ).toBe(1);
      expect(await triggerRow(t, w.reply.id)).toMatchObject({
        status: "PENDING",
        attempts: 0,
        deferrals: 1,
        claim_token: null,
        last_error_code: null,
      });
      // the deferred input is applied once on its next claim
      await makeDue(t, w.reply.id);
      expect(await k.run(w.reply.id)).toMatchObject({
        kind: "finished",
        outcome: "input_accepted",
      });
      expect((await k.botRequests(w.f)).map((r) => r.bot_step_seq)).toEqual([1, 2]);
    });
  });

  describe("E-CLK-7: the skew threshold is strictly greater than 2000 ms", () => {
    it("exactly 2000 ms after the decision clock: no rollback, the step commits", async () => {
      expect(RUNTIME_POLICY.postEnqueueSkewMs).toBe(2_000);
      const f = await k.fixture();
      const tr = await seededTrigger(f);
      const clock = skewClock({ postMs: 2_000 });
      expect(await k.run(tr.id, { readClock: clock.readClock })).toMatchObject({
        kind: "finished",
        outcome: "session_started",
      });
      expect(clock.values[1]!.getTime() - clock.values[0]!.getTime()).toBe(2_000);
      expect(clock.values).toHaveLength(2);
      expect(seam.lockCalls).toHaveLength(1);
      expect(await effects(f)).toMatchObject({ sessions: 1, botRequests: 1 });
    });

    it("2001 ms: the step rolls back and is re-decided", async () => {
      const f = await k.fixture();
      const tr = await seededTrigger(f);
      const clock = skewClock({ postMs: 2_001 });
      expect(await k.run(tr.id, { readClock: clock.readClock })).toEqual({
        kind: "deferred",
        reason: "clock_skew",
      });
      expect(clock.values[1]!.getTime() - clock.values[0]!.getTime()).toBe(2_001);
      expect(clock.values).toHaveLength(3);
      expect(seam.lockCalls).toHaveLength(2);
      expect(await effects(f)).toMatchObject({ sessions: 0, botRequests: 0 });
    });
  });

  describe("E-CLK-8: the recovery needs no conversation, deployment or session lock", () => {
    it("completes while other connections hold the conversation, deployment, session (and account) rows FOR UPDATE", async () => {
      const w = await continuationWorld();
      const before = await w.snap();
      const claim = await k.claimOf(w.reply.id);
      const holders: Array<{ pid: number }> = [];
      const rowsHeld = [
        ["conversations", w.f.w.student.conversation.id],
        ["bot_deployments", w.f.deployment.id],
        ["bot_sessions", w.s],
        ["whatsapp_accounts", w.f.w.account.id],
      ] as const;
      seam.beforeRecoveryLock = async () => {
        for (const [table, id] of rowsHeld)
          holders.push(await kit.hold(`select id from ${table} where id = $1 for update`, [id]));
        // each row is demonstrably locked by its holder
        for (const [table, id] of rowsHeld)
          expect(
            await locked(`select 1 from ${table} where id = $1 for update nowait`, [id]),
            table,
          ).toBe(true);
      };
      const clock = skewClock({ postMs: 3_000 });
      const summary = await k.runClaim(claim, { readClock: clock.readClock });
      // a recovery that waited on any of them would have failed with lock_timeout (55P03) instead
      expect(summary).toEqual({ kind: "deferred", reason: "clock_skew" });
      expect(holders).toHaveLength(4);
      const open = await k.rows(
        "select pid from pg_stat_activity where pid = any($1::int[]) and state = 'idle in transaction'",
        [holders.map((h) => h.pid)],
      );
      expect(open, "every holder still has its transaction (and its row lock) open").toHaveLength(
        4,
      );
      for (const [table, id] of rowsHeld)
        expect(
          await locked(`select 1 from ${table} where id = $1 for update nowait`, [id]),
          table,
        ).toBe(true);
      expect(await triggerRow(t, w.reply.id)).toMatchObject({
        status: "PENDING",
        attempts: 0,
        deferrals: 1,
        claim_token: null,
      });
      await kit.cleanup(); // releases the holders (rollback)
      expect(await w.snap()).toEqual(before);
    });
  });

  describe("E-CLK-9: a failure inside the recovery transaction takes the charged T2 path", () => {
    const backoff = () => claimFailureBackoffMs(1, () => 0.5)!;

    it("the recovery clock read fails: T2 records internal_error, the attempt stays charged, no effect", async () => {
      const f = await k.fixture();
      const tr = await seededTrigger(f);
      const before = await effects(f);
      const claim = await k.claimOf(tr.id);
      const clock = skewClock({ postMs: 3_000, failRecoveryRead: true });
      const t0 = (await dbNow(t)).getTime();
      const summary = await k.runClaim(claim, { readClock: clock.readClock });
      const t1 = (await dbNow(t)).getTime();
      expect(summary).toEqual({ kind: "failed", errorCode: "internal_error", recorded: true });
      expectFenceRelocked(claim);
      const row = await triggerRow(t, tr.id);
      expect(row).toMatchObject({
        status: "PENDING",
        attempts: 1,
        deferrals: 0,
        claim_token: null,
        claimed_at: null,
        processed_at: null,
        last_error_code: "internal_error",
      });
      expect(ms(row.next_attempt_at)).toBeGreaterThanOrEqual(t0 + backoff());
      expect(ms(row.next_attempt_at)).toBeLessThanOrEqual(t1 + backoff());
      expect(await effects(f)).toEqual(before);
    });

    it("a failure after the recovery's fenced deferral: the refund is rolled back, T2 records the charged failure", async () => {
      const f = await k.fixture();
      const tr = await seededTrigger(f);
      const before = await effects(f);
      const claim = await k.claimOf(tr.id);
      seam.failAfterRecoveryDefer = true; // T1 itself never defers on this path: the only deferral is the recovery's
      const summary = await k.runClaim(claim, {
        readClock: skewClock({ postMs: 3_000 }).readClock,
      });
      expect(summary).toEqual({ kind: "failed", errorCode: "internal_error", recorded: true });
      expectFenceRelocked(claim);
      expect(await triggerRow(t, tr.id)).toMatchObject({
        status: "PENDING",
        attempts: 1, // not refunded
        deferrals: 0, // not counted
        claim_token: null,
        last_error_code: "internal_error",
      });
      expect(await effects(f)).toEqual(before);
    });
  });

  it("the full-hour arithmetic constants used above are the approved ones", () => {
    expect(RUNTIME_POLICY.cooldownMs).toBe(30 * MIN);
    expect(RUNTIME_POLICY.contactSessionWindowMs).toBe(24 * HOUR);
    expect(RUNTIME_POLICY.maxInputAgeMs).toBe(10 * MIN);
    expect(RUNTIME_POLICY.claimLeaseMs).toBe(60_000);
    expect(RUNTIME_POLICY.t1StartGuardMs).toBe(20_000);
  });
});
