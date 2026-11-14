import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWorkerDatabase } from "@/db";
import {
  CHECK_VIOLATION,
  createTestDatabase,
  expectPgError,
  type TestDb,
} from "@/db/__tests__/helpers";
import {
  claimTriggers as claimOp,
  claimTriggersSql,
  deferTriggerSql,
  finishTriggerSql,
  recordTriggerFailureSql,
  wakeConversationTriggersSql,
} from "@/db/ops/bot-trigger-queue";
import {
  addStudent,
  barrierKit,
  botWorld,
  settledState,
  type BotWorld,
  type Student,
} from "../bot-control/testing";
import {
  claimTriggers,
  deferTrigger,
  endConversationTriggers,
  finishTrigger,
  recordTriggerFailure,
  wakeConversationTriggers,
  type ClaimedTrigger,
} from "./trigger-queue";
import {
  dbNow,
  expireClaim,
  insertTrigger,
  makeDue,
  secondsUntilDue,
  triggerRow,
  type QueueCtx,
} from "./testing";

// E-CLAIM (Phase 08E-3): the trigger queue's claim, fenced failure record (T2), deferral with refund, fenced finish and
// non-waiting wake/end, on real disposable PostgreSQL 17 at the production isolation level (READ COMMITTED). Order between
// sessions is proved by lock OWNERSHIP (pg_blocking_pids), never by sleeping. Each guarantee that rests on a clause has a
// negative control: the same statement WITHOUT the clause, run against the same data, behaves wrongly.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dialect = new PgDialect();
const pgError = (code: string) =>
  Object.assign(new Error("secret@example.com wrote this"), { code });
const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("trigger queue: claim, T2, deferral, finish, wake (E-CLAIM)", () => {
  let t: TestDb;
  let w: BotWorld;
  let barriers: ReturnType<typeof barrierKit>;
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
  const ctxOf = (world: BotWorld, s: Student = world.student): QueueCtx => ({
    organizationId: world.org.id,
    accountId: world.account.id,
    conversationId: s.conversation.id,
  });
  const newStudent = (world: BotWorld = w) => addStudent(t.db, world.org.id, world.account.id);
  /** Renders a builder's statement, applies `edit` to its text and returns it ready for pool.query. */
  const mutated = (s: SQL, edit: (text: string) => string) => {
    const rendered = dialect.sqlToQuery(s);
    const text = edit(rendered.sql);
    expect(text, "the mutation must change the statement").not.toBe(rendered.sql);
    return { text, params: rendered.params };
  };
  /** The same statement with the claim-token comparison turned into a test that is always true (the fence removed). */
  const withoutTokenFence = (s: SQL, token: string) => {
    const rendered = dialect.sqlToQuery(s);
    const n = rendered.params.indexOf(token) + 1;
    expect(n, "the token must be a bound parameter").toBeGreaterThan(0);
    const text = rendered.sql.replace(
      new RegExp(`claim_token = \\$${n}\\b`),
      () => `$${n}::uuid IS NOT NULL`,
    );
    expect(text).not.toBe(rendered.sql);
    return { text, params: rendered.params };
  };
  const fence = (c: ClaimedTrigger) => ({
    organizationId: c.organizationId,
    id: c.id,
    claimToken: c.claimToken,
  });
  const claimOne = async (id: string): Promise<ClaimedTrigger> => {
    const claims = await claimTriggers(t.db);
    const c = claims.find((x) => x.id === id);
    if (!c) throw new Error(`trigger ${id} was not claimed`);
    return c;
  };

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
    w = await botWorld(t.db);
    barriers = barrierKit(t);
  });
  afterEach(async () => {
    await barriers.cleanup();
  });

  // ------------------------------------------------------------------------------------------------------ T0 claim

  describe("T0: the claim", () => {
    it("claims a due PENDING trigger, keeps it PENDING and stamps the claim from the database clock", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const before = await dbNow(t);
      const claims = await claimTriggers(t.db);
      const after = await dbNow(t);
      expect(claims).toHaveLength(1);
      const c = claims[0]!;
      expect(c).toMatchObject({
        id: trig.id,
        organizationId: w.org.id,
        whatsappAccountId: w.account.id,
        conversationId: w.student.conversation.id,
        messageId: trig.messageId,
        attempts: 1,
        deferrals: 0,
        observedControlSeq: 0,
      });
      expect(c.claimToken).toMatch(UUID);
      expect(c.claimedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(c.claimedAt.getTime()).toBeLessThanOrEqual(after.getTime());
      // the returned Date is the stored database timestamp, to the millisecond
      const stored = (await triggerRow(t, trig.id)).claimed_at as Date;
      expect(c.claimedAt).toBeInstanceOf(Date);
      expect(c.claimedAt.getTime()).toBe(stored.getTime());
      expect(await triggerRow(t, trig.id)).toMatchObject({
        status: "PENDING",
        attempts: 1,
        claim_token: c.claimToken,
        processed_at: null,
        outcome_code: null,
        last_error_code: null,
      });
    });

    it("respects next_attempt_at: a trigger due in the future is not claimed, one due a moment ago is", async () => {
      const later = await insertTrigger(t, ctxOf(w), { dueInMs: 2_000 });
      const due = await insertTrigger(t, ctxOf(w, await newStudent()), { dueInMs: -50 });
      const claims = await claimTriggers(t.db);
      expect(claims.map((c) => c.id)).toEqual([due.id]);
      expect(await triggerRow(t, later.id)).toMatchObject({ attempts: 0, claim_token: null });
    });

    it("only claims PENDING triggers: finished and dead ones are never claimed", async () => {
      for (const finished of ["PROCESSED", "IGNORED", "DEAD"] as const)
        await insertTrigger(t, ctxOf(w, await newStudent()), { finished });
      expect(await claimTriggers(t.db)).toEqual([]);
    });

    it("a live claim excludes every other worker; the lease boundary is exact (custom 3 s lease)", async () => {
      const live = await insertTrigger(t, ctxOf(w), { attempts: 1, claimAgeMs: 2_000 });
      const old = await insertTrigger(t, ctxOf(w, await newStudent()), {
        attempts: 1,
        claimAgeMs: 4_000,
      });
      const claims = await claimOp(t.db, { limit: 5, leaseMs: 3_000, maxClaims: 6 });
      expect(claims.map((c) => c.id)).toEqual([old.id]);
      expect(claims[0]).toMatchObject({ attempts: 2 });
      expect(claims[0]!.claimToken).not.toBe(old.claimToken); // a fresh token on every claim
      expect(await triggerRow(t, live.id)).toMatchObject({
        attempts: 1,
        claim_token: live.claimToken,
      });
    });

    it("the real lease is 60 seconds", async () => {
      const inside = await insertTrigger(t, ctxOf(w), { attempts: 1, claimAgeMs: 58_000 });
      const outside = await insertTrigger(t, ctxOf(w, await newStudent()), {
        attempts: 1,
        claimAgeMs: 62_000,
      });
      const ids = (await claimTriggers(t.db)).map((c) => c.id);
      expect(ids).toEqual([outside.id]);
      expect(await triggerRow(t, inside.id)).toMatchObject({ attempts: 1 });
    });

    it("a claim is never repeated for the same live claim, however often workers poll", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const first = await claimOne(trig.id);
      for (let i = 0; i < 3; i++) expect(await claimTriggers(t.db)).toEqual([]);
      expect(await triggerRow(t, trig.id)).toMatchObject({
        attempts: 1,
        claim_token: first.claimToken,
      });
    });

    it("returns at most `limit` claims", async () => {
      for (let i = 0; i < 4; i++) await insertTrigger(t, ctxOf(w, await newStudent()));
      expect(await claimTriggers(t.db, 3)).toHaveLength(3);
      expect(await claimTriggers(t.db, 3)).toHaveLength(1);
    });
  });

  describe("T0: the six-claim limit", () => {
    it("a trigger is claimed while attempts < 6; the sixth claim makes attempts 6; there is never a seventh", async () => {
      const trig = await insertTrigger(t, ctxOf(w), { attempts: 5, claimAgeMs: 120_000 });
      const sixth = await claimOne(trig.id);
      expect(sixth.attempts).toBe(6);
      await expireClaim(t, trig.id);
      expect(await claimTriggers(t.db)).toEqual([]);
      await makeDue(t, trig.id);
      expect(await claimTriggers(t.db)).toEqual([]);
      expect(await triggerRow(t, trig.id)).toMatchObject({ attempts: 6, status: "PENDING" });
    });

    it("an exhausted trigger that nothing claims is also never claimed when unclaimed and due", async () => {
      const trig = await insertTrigger(t, ctxOf(w), { attempts: 6 });
      expect(await claimTriggers(t.db)).toEqual([]);
      expect(await triggerRow(t, trig.id)).toMatchObject({ attempts: 6, claim_token: null });
    });

    it("NEGATIVE CONTROL: without the limit a seventh claim is attempted and the database CHECK refuses it", async () => {
      await insertTrigger(t, ctxOf(w), { attempts: 6 });
      const broken = mutated(
        claimTriggersSql({ limit: 5, leaseMs: 60_000, maxClaims: 6 }),
        (text) => text.replaceAll("t.attempts <", "t.attempts <="),
      );
      await expectPgError(
        q(broken.text, broken.params),
        CHECK_VIOLATION,
        "bot_triggers_attempts_check",
      );
      // the production statement claims nothing
      expect(await claimTriggers(t.db)).toEqual([]);
    });
  });

  describe("T0: conversation head of line", () => {
    it("only the earliest PENDING trigger of a conversation is claimable, even when both are due", async () => {
      const ctx = ctxOf(w);
      const base = Date.now() - 60_000;
      const later = await insertTrigger(t, ctx, { inputOccurredAt: new Date(base + 5_000) });
      const earlier = await insertTrigger(t, ctx, { inputOccurredAt: new Date(base) });
      const claims = await claimTriggers(t.db, 5);
      expect(claims.map((c) => c.id)).toEqual([earlier.id]); // by input time, not by insertion order
      expect(await triggerRow(t, later.id)).toMatchObject({ attempts: 0 });
    });

    it("ties on the input time are broken by id", async () => {
      const ctx = ctxOf(w);
      const at = new Date(Date.now() - 60_000);
      const a = await insertTrigger(t, ctx, { inputOccurredAt: at });
      const b = await insertTrigger(t, ctx, { inputOccurredAt: at });
      const claims = await claimTriggers(t.db, 5);
      expect(claims.map((c) => c.id)).toEqual([[a.id, b.id].sort()[0]]);
    });

    it("a claimed trigger, a not-yet-due trigger and an exhausted trigger each keep every later trigger waiting", async () => {
      const base = Date.now() - 60_000;
      for (const [name, head] of [
        ["claimed", { claimAgeMs: 1_000, attempts: 1 }],
        ["deferred", { dueInMs: 30_000 }],
        ["exhausted", { attempts: 6 }],
      ] as const) {
        const ctx = ctxOf(w, await newStudent());
        const first = await insertTrigger(t, ctx, { ...head, inputOccurredAt: new Date(base) });
        const second = await insertTrigger(t, ctx, { inputOccurredAt: new Date(base + 1_000) });
        expect(await claimTriggers(t.db, 20), name).toEqual([]);
        expect(await triggerRow(t, second.id), name).toMatchObject({ attempts: 0 });
        expect(await triggerRow(t, first.id), name).toMatchObject({ status: "PENDING" });
      }
    });

    it("a finished earlier trigger no longer blocks; other conversations never block each other", async () => {
      const ctx = ctxOf(w);
      const base = Date.now() - 60_000;
      const first = await insertTrigger(t, ctx, { inputOccurredAt: new Date(base) });
      const second = await insertTrigger(t, ctx, { inputOccurredAt: new Date(base + 1_000) });
      const other = await insertTrigger(t, ctxOf(w, await newStudent()), { dueInMs: -10 });
      // the other conversation's trigger is claimable alongside the first
      const firstClaims = await claimTriggers(t.db, 10);
      expect(firstClaims.map((c) => c.id).sort()).toEqual([first.id, other.id].sort());
      expect(
        await finishTrigger(
          t.db,
          firstClaims.find((c) => c.id === first.id)!,
          { status: "PROCESSED", outcomeCode: "processed" },
        ),
      ).toBe(true);
      expect((await claimTriggers(t.db)).map((c) => c.id)).toEqual([second.id]);
    });

    it("one conversation with many due triggers yields exactly one claim across eight concurrent workers", async () => {
      const ctx = ctxOf(w);
      const base = Date.now() - 120_000;
      const ids: string[] = [];
      for (let i = 0; i < 10; i++)
        ids.push((await insertTrigger(t, ctx, { inputOccurredAt: new Date(base + i * 1_000) })).id);
      const results = await Promise.all(Array.from({ length: 8 }, () => claimTriggers(t.db, 10)));
      const claimed = results.flat();
      expect(claimed.map((c) => c.id)).toEqual([ids[0]]);
    });
  });

  describe("T0: SKIP LOCKED and competing claimants", () => {
    it("a trigger row another transaction holds is skipped, never waited for", async () => {
      const a = await insertTrigger(t, ctxOf(w));
      const b = await insertTrigger(t, ctxOf(w, await newStudent()));
      const holder = await barriers.hold("select id from bot_triggers where id = $1 for update", [
        a.id,
      ]);
      const completed = await barriers.within(claimTriggers(t.db), 5_000);
      expect(completed).toBe(true); // it completed while the row was held (a wait would have outlived the barrier)
      const row = await triggerRow(t, b.id);
      expect(row).toMatchObject({ attempts: 1 });
      expect(await triggerRow(t, a.id)).toMatchObject({ attempts: 0, claim_token: null });
      await holder.release();
      expect((await claimTriggers(t.db)).map((c) => c.id)).toEqual([a.id]);
    });

    it("NEGATIVE CONTROL: without SKIP LOCKED the claim WAITS behind the holder", async () => {
      const a = await insertTrigger(t, ctxOf(w));
      const holder = await barriers.hold("select id from bot_triggers where id = $1 for update", [
        a.id,
      ]);
      const broken = mutated(
        claimTriggersSql({ limit: 5, leaseMs: 60_000, maxClaims: 6 }),
        (text) => text.replace(" SKIP LOCKED", ""),
      );
      const blocked = barriers.settle(q(broken.text, broken.params));
      const blockedPid = await barriers.waitUntilBlocked(holder.pid);
      expect(await barriers.blockersOf(blockedPid)).toEqual([holder.pid]);
      await holder.release();
      expect((await blocked).ok).toBe(true);
    });

    it("competing claimants: every trigger is claimed exactly once, none twice", async () => {
      const total = 20;
      for (let i = 0; i < total; i++) await insertTrigger(t, ctxOf(w, await newStudent()));
      const seen = new Map<string, number>();
      for (let round = 0; round < 6; round++) {
        const results = await Promise.all(Array.from({ length: 6 }, () => claimTriggers(t.db, 4)));
        const ids = results.flat().map((c) => c.id);
        expect(new Set(ids).size, `round ${round}`).toBe(ids.length);
        for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
        if (ids.length === 0) break;
      }
      expect(seen.size).toBe(total);
      expect([...seen.values()].every((n) => n === 1)).toBe(true);
      const rows = await q("select attempts, claim_token from bot_triggers");
      expect(rows.rows.every((r) => r.attempts === 1 && UUID.test(r.claim_token))).toBe(true);
      expect(new Set(rows.rows.map((r) => r.claim_token)).size).toBe(total); // every claim has its own token
    });

    it("two statements racing for one trigger: exactly one wins, the other gets nothing", async () => {
      const a = await insertTrigger(t, ctxOf(w));
      const winner = await barriers.hold(
        "update bot_triggers set attempts = attempts + 1, claim_token = gen_random_uuid(), claimed_at = clock_timestamp() where id = $1",
        [a.id],
      );
      // while the first claimant has the row locked (uncommitted), a second claimant finds nothing and does not wait
      expect(await barriers.within(claimTriggers(t.db), 5_000)).toBe(true);
      await winner.release();
      expect(await claimTriggers(t.db)).toEqual([]); // the winner's claim is now committed and live
      expect(await triggerRow(t, a.id)).toMatchObject({ attempts: 1 });
    });
  });

  describe("tenant isolation", () => {
    it("claims span organizations but each claim carries its own organization; every fenced write needs the organization too", async () => {
      const other = await botWorld(t.db);
      const mine = await insertTrigger(t, ctxOf(w));
      const theirs = await insertTrigger(t, ctxOf(other));
      const claims = await claimTriggers(t.db, 10);
      const byId = new Map(claims.map((c) => [c.id, c]));
      expect(byId.get(mine.id)?.organizationId).toBe(w.org.id);
      expect(byId.get(theirs.id)?.organizationId).toBe(other.org.id);
      const myClaim = byId.get(mine.id)!;
      const wrongOrg = { ...myClaim, organizationId: other.org.id };
      expect(await recordTriggerFailure(t.db, wrongOrg, new Error("x"), () => 0.5)).toBe(false);
      expect(await deferTrigger(t.db, wrongOrg)).toBeNull();
      expect(
        await finishTrigger(t.db, wrongOrg, { status: "PROCESSED", outcomeCode: "processed" }),
      ).toBe(false);
      expect(await triggerRow(t, mine.id)).toMatchObject({
        status: "PENDING",
        claim_token: myClaim.claimToken,
        attempts: 1,
      });
    });

    it("wake and end are scoped to the organization and the conversation", async () => {
      const other = await botWorld(t.db);
      const mine = await insertTrigger(t, ctxOf(w), { dueInMs: 30_000 });
      const theirs = await insertTrigger(t, ctxOf(other), { dueInMs: 30_000 });
      // the other organization naming this conversation touches nothing
      expect(
        await wakeConversationTriggers(t.db, {
          organizationId: other.org.id,
          conversationId: w.student.conversation.id,
        }),
      ).toBe(0);
      expect(
        await endConversationTriggers(t.db, {
          organizationId: other.org.id,
          conversationId: w.student.conversation.id,
        }),
      ).toBe(0);
      expect(await secondsUntilDue(t, mine.id)).toBeGreaterThan(20);
      // this organization's wake leaves the other organization alone
      expect(
        await wakeConversationTriggers(t.db, {
          organizationId: w.org.id,
          conversationId: w.student.conversation.id,
        }),
      ).toBe(1);
      expect(await secondsUntilDue(t, theirs.id)).toBeGreaterThan(20);
      expect(
        await endConversationTriggers(t.db, {
          organizationId: w.org.id,
          conversationId: w.student.conversation.id,
        }),
      ).toBe(1);
      expect(await triggerRow(t, theirs.id)).toMatchObject({ status: "PENDING" });
      expect(await triggerRow(t, mine.id)).toMatchObject({
        status: "IGNORED",
        outcome_code: "session_ended",
      });
    });
  });

  // ------------------------------------------------------------------------------------------------- crash / restart

  describe("crash and restart", () => {
    it("a worker that dies after the claim leaves a claim that a restarted worker takes over once the lease is over", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const dead = await claimOne(trig.id); // the worker dies here: no T1, no T2
      const restarted = createWorkerDatabase(t.url, {
        maxConnections: 2,
        applicationName: "test-08e3-restart",
        onPoolError: () => undefined,
      });
      try {
        expect(await claimTriggers(restarted.db as never)).toEqual([]); // the lease still protects the dead worker's claim
        await expireClaim(t, trig.id);
        const next = await claimTriggers(restarted.db as never);
        expect(next).toHaveLength(1);
        expect(next[0]).toMatchObject({ id: trig.id, attempts: 2 });
        expect(next[0]!.claimToken).not.toBe(dead.claimToken);
        // the dead worker's token is worth nothing now, the new one is
        expect(
          await finishTrigger(t.db, dead, { status: "PROCESSED", outcomeCode: "processed" }),
        ).toBe(false);
        expect(
          await finishTrigger(restarted.db as never, next[0]!, {
            status: "PROCESSED",
            outcomeCode: "processed",
          }),
        ).toBe(true);
      } finally {
        await restarted.close();
      }
    });
  });

  // ------------------------------------------------------------------------------------------------------ T2 record

  describe("T2: the fenced failure record", () => {
    it("clears the claim, schedules the 5 s first backoff, records a fixed code and leaves the charged attempt alone", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const c = await claimOne(trig.id);
      expect(await recordTriggerFailure(t.db, c, pgError("55P03"), () => 0.5)).toBe(true);
      expect(await triggerRow(t, trig.id)).toMatchObject({
        status: "PENDING",
        attempts: 1,
        claim_token: null,
        claimed_at: null,
        last_error_code: "lock_timeout",
        processed_at: null,
      });
      const s = await secondsUntilDue(t, trig.id);
      expect(s).toBeGreaterThan(4);
      expect(s).toBeLessThanOrEqual(5);
      expect(await claimTriggers(t.db)).toEqual([]); // not claimable until the backoff has passed
      await makeDue(t, trig.id);
      expect((await claimTriggers(t.db)).map((x) => x.attempts)).toEqual([2]);
    });

    it("the jitter stays within plus or minus 20 % of the backoff", async () => {
      for (const [random, low, high] of [
        [0, 3.5, 4.0],
        [1, 5.5, 6.0],
      ] as const) {
        const trig = await insertTrigger(t, ctxOf(w, await newStudent()));
        const c = await claimOne(trig.id);
        await recordTriggerFailure(t.db, c, new Error("x"), () => random);
        const s = await secondsUntilDue(t, trig.id);
        expect(s).toBeGreaterThan(low);
        expect(s).toBeLessThanOrEqual(high);
      }
    });

    it("follows the approved schedule 5 s, 15 s, 45 s, 2 min, 5 min and then leaves the sixth claim for terminalization", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const expected = [5, 15, 45, 120, 300];
      for (let claim = 1; claim <= 5; claim++) {
        const c = await claimOne(trig.id);
        expect(c.attempts).toBe(claim);
        await recordTriggerFailure(t.db, c, new Error("x"), () => 0.5);
        const s = await secondsUntilDue(t, trig.id);
        const base = expected[claim - 1]!;
        expect(s, `after claim ${claim}`).toBeGreaterThan(base - 1.5);
        expect(s, `after claim ${claim}`).toBeLessThanOrEqual(base);
        await makeDue(t, trig.id);
      }
      const sixth = await claimOne(trig.id);
      expect(sixth.attempts).toBe(6);
      await recordTriggerFailure(t.db, sixth, new Error("x"), () => 0.5);
      expect(await secondsUntilDue(t, trig.id)).toBeLessThanOrEqual(0.5); // no backoff after the sixth
      expect(await claimTriggers(t.db)).toEqual([]); // and no seventh claim
    });

    it("only the current claim holder may modify the trigger: a stale worker cannot overwrite a newer claim", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const stale = await claimOne(trig.id);
      await expireClaim(t, trig.id);
      const current = await claimOne(trig.id);
      expect(await recordTriggerFailure(t.db, stale, new Error("x"), () => 0.5)).toBe(false);
      expect(await triggerRow(t, trig.id)).toMatchObject({
        attempts: 2,
        claim_token: current.claimToken,
        last_error_code: null,
      });
      expect(await recordTriggerFailure(t.db, current, new Error("x"), () => 0.5)).toBe(true);
    });

    it("NEGATIVE CONTROL: without the claim-token fence the stale worker clears the newer claim", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const stale = await claimOne(trig.id);
      await expireClaim(t, trig.id);
      const current = await claimOne(trig.id);
      const broken = withoutTokenFence(
        recordTriggerFailureSql({ ...fence(stale), errorCode: "internal_error", backoffMs: 5_000 }),
        stale.claimToken,
      );
      expect((await q(broken.text, broken.params)).rowCount).toBe(1);
      expect((await triggerRow(t, trig.id)).claim_token).toBeNull(); // the newer claim was destroyed
      expect(current.claimToken).toMatch(UUID);
    });

    it("a finished trigger cannot be recorded as failed, and a replayed record changes nothing (lost acknowledgment)", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const c = await claimOne(trig.id);
      expect(await recordTriggerFailure(t.db, c, new Error("x"), () => 0.5)).toBe(true);
      const afterFirst = await triggerRow(t, trig.id);
      // the worker never saw the acknowledgment and tries again: the claim is already cleared, nothing changes
      expect(await recordTriggerFailure(t.db, c, new Error("x"), () => 0.5)).toBe(false);
      expect(await triggerRow(t, trig.id)).toEqual(afterFirst);
      const done = await insertTrigger(t, ctxOf(w, await newStudent()));
      const d = await claimOne(done.id);
      expect(await finishTrigger(t.db, d, { status: "PROCESSED", outcomeCode: "processed" })).toBe(
        true,
      );
      expect(await recordTriggerFailure(t.db, d, new Error("x"), () => 0.5)).toBe(false);
      expect(await triggerRow(t, done.id)).toMatchObject({
        status: "PROCESSED",
        last_error_code: null,
      });
    });

    it("a T2 that never ran leaves the claim, which the lease then releases (recoverable after lease expiry)", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const c = await claimOne(trig.id);
      // T2 lost: nothing is written
      expect(await claimTriggers(t.db)).toEqual([]);
      await expireClaim(t, trig.id);
      const again = await claimOne(trig.id);
      expect(again.attempts).toBe(c.attempts + 1);
    });

    it("never stores exception text: only a fixed code, whatever the error said", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const c = await claimOne(trig.id);
      await recordTriggerFailure(
        t.db,
        c,
        new Error("duplicate key value violates (student@example.com, 94771234567)"),
        () => 0.5,
      );
      const row = await triggerRow(t, trig.id);
      expect(row.last_error_code).toBe("internal_error");
      expect(JSON.stringify(row)).not.toMatch(/student@example|94771234567|duplicate key/);
    });
  });

  // ------------------------------------------------------------------------------------- deferral, refund and wake

  describe("deferral with an exact refund", () => {
    it("clears the claim, refunds the charged attempt once, counts the deferral and waits 2 s", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const c = await claimOne(trig.id);
      const r = await deferTrigger(t.db, c);
      expect(r).toMatchObject({ attempts: 0, deferrals: 1 });
      expect(r!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() - 5_000); // a real timestamp
      expect(await triggerRow(t, trig.id)).toMatchObject({
        status: "PENDING",
        attempts: 0,
        deferrals: 1,
        claim_token: null,
        claimed_at: null,
        processed_at: null,
      });
      const s = await secondsUntilDue(t, trig.id);
      expect(s).toBeGreaterThan(1);
      expect(s).toBeLessThanOrEqual(2);
    });

    it("a replay with the old token refunds nothing more (no double refund)", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const c = await claimOne(trig.id);
      expect(await deferTrigger(t.db, c)).not.toBeNull();
      const after = await triggerRow(t, trig.id);
      expect(await deferTrigger(t.db, c)).toBeNull();
      expect(await triggerRow(t, trig.id)).toEqual(after);
    });

    it("a stale claim cannot refund the attempt of the claim that replaced it", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const stale = await claimOne(trig.id);
      await expireClaim(t, trig.id);
      const current = await claimOne(trig.id);
      expect(current.attempts).toBe(2);
      expect(await deferTrigger(t.db, stale)).toBeNull();
      expect(await triggerRow(t, trig.id)).toMatchObject({
        attempts: 2,
        deferrals: 0,
        claim_token: current.claimToken,
      });
    });

    it("applies the 2/4/8/15 second ladder, repeating the last rung, selected by the deferrals so far", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const expected = [2, 4, 8, 15, 15, 15];
      for (let i = 0; i < expected.length; i++) {
        const c = await claimOne(trig.id);
        expect(c.deferrals).toBe(i);
        expect(c.attempts).toBe(1); // every deferral refunded the attempt, so each claim is claim number 1 again
        await deferTrigger(t.db, c);
        const s = await secondsUntilDue(t, trig.id);
        expect(s, `deferral ${i + 1}`).toBeGreaterThan(expected[i]! - 1.5);
        expect(s, `deferral ${i + 1}`).toBeLessThanOrEqual(expected[i]!);
        await makeDue(t, trig.id);
      }
      expect(await triggerRow(t, trig.id)).toMatchObject({ deferrals: 6, attempts: 0 });
    });

    it("never charges an attempt for a deferral: deferrals do not move a trigger toward DEAD", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      for (let i = 0; i < 12; i++) {
        const c = await claimOne(trig.id);
        await deferTrigger(t.db, c);
        await makeDue(t, trig.id);
      }
      expect(await triggerRow(t, trig.id)).toMatchObject({
        attempts: 0,
        deferrals: 12,
        status: "PENDING",
      });
    });

    it("uses the freshness clock when the caller passes the one it already read", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const c = await claimOne(trig.id);
      const at = new Date(Date.now() + 3_600_000);
      const r = await deferTrigger(t.db, c, at);
      expect(r!.nextAttemptAt.getTime()).toBe(at.getTime() + 2_000);
    });

    it("is bounded: refuses at the database ceiling of 1000 deferrals, and when no attempt is charged", async () => {
      const full = await insertTrigger(t, ctxOf(w), { deferrals: 1_000 });
      const c = await claimOne(full.id);
      expect(await deferTrigger(t.db, c)).toBeNull();
      expect(await triggerRow(t, full.id)).toMatchObject({
        deferrals: 1_000,
        attempts: 1,
        claim_token: c.claimToken,
      });
      const near = await insertTrigger(t, ctxOf(w, await newStudent()), { deferrals: 999 });
      const n = await claimOne(near.id);
      expect(await deferTrigger(t.db, n)).toMatchObject({ deferrals: 1_000 });
      // a claim whose attempt was already refunded has nothing left to refund
      const zero = await insertTrigger(t, ctxOf(w, await newStudent()));
      const z = await claimOne(zero.id);
      await q("update bot_triggers set attempts = 0 where id = $1", [zero.id]);
      expect(await deferTrigger(t.db, z)).toBeNull();
    });

    it("NEGATIVE CONTROL: without the fence a replay refunds twice; the production statement refunds once", async () => {
      const run = (s: { text: string; params: unknown[] }) => q(s.text, s.params);
      const defer = (id: string, token: string) =>
        deferTriggerSql({
          organizationId: w.org.id,
          id,
          claimToken: token,
          ladderMs: [2_000],
          maxDeferrals: 1_000,
        });
      // production: the first statement refunds (3 -> 2), the replay matches nothing
      const prod = await insertTrigger(t, ctxOf(w), { attempts: 3, claimAgeMs: 1_000 });
      const prodStmt = dialect.sqlToQuery(defer(prod.id, prod.claimToken!));
      expect((await run({ text: prodStmt.sql, params: prodStmt.params })).rowCount).toBe(1);
      expect((await run({ text: prodStmt.sql, params: prodStmt.params })).rowCount).toBe(0);
      expect((await triggerRow(t, prod.id)).attempts).toBe(2);
      // broken: the same statement without the token fence refunds again (3 -> 2 -> 1)
      const bad = await insertTrigger(t, ctxOf(w, await newStudent()), {
        attempts: 3,
        claimAgeMs: 1_000,
      });
      const badStmt = withoutTokenFence(defer(bad.id, bad.claimToken!), bad.claimToken!);
      expect((await run(badStmt)).rowCount).toBe(1);
      expect((await run(badStmt)).rowCount).toBe(1);
      expect((await triggerRow(t, bad.id)).attempts).toBe(1);
    });
  });

  describe("fenced finish", () => {
    it("finishes the current claim as PROCESSED or IGNORED with its outcome and a consistent row", async () => {
      for (const [status, outcomeCode] of [
        ["PROCESSED", "processed"],
        ["IGNORED", "stale_trigger"],
      ] as const) {
        const trig = await insertTrigger(t, ctxOf(w, await newStudent()));
        const c = await claimOne(trig.id);
        expect(await finishTrigger(t.db, c, { status, outcomeCode })).toBe(true);
        expect(await triggerRow(t, trig.id)).toMatchObject({
          status,
          outcome_code: outcomeCode,
          claim_token: null,
          claimed_at: null,
          last_error_code: null,
          attempts: 1,
        });
        expect((await triggerRow(t, trig.id)).processed_at).toBeInstanceOf(Date);
      }
    });

    it("the stale finish writes only the trigger and uses the freshness clock: no refund, no deferral, no session", async () => {
      const trig = await insertTrigger(t, ctxOf(w), { attempts: 0 });
      const c = await claimOne(trig.id);
      const at = new Date("2026-10-22T10:00:00.000Z");
      expect(
        await finishTrigger(t.db, c, { status: "IGNORED", outcomeCode: "stale_trigger", at }),
      ).toBe(true);
      const row = await triggerRow(t, trig.id);
      expect(row).toMatchObject({
        status: "IGNORED",
        outcome_code: "stale_trigger",
        attempts: 1,
        deferrals: 0,
        session_id: null,
        last_error_code: null,
      });
      expect((row.processed_at as Date).toISOString()).toBe(at.toISOString());
    });

    it("a finished trigger is final: no second finish, no failure record, no deferral, no overwrite, no reopening", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const c = await claimOne(trig.id);
      expect(await finishTrigger(t.db, c, { status: "PROCESSED", outcomeCode: "processed" })).toBe(
        true,
      );
      const done = await triggerRow(t, trig.id);
      expect(await finishTrigger(t.db, c, { status: "IGNORED", outcomeCode: "other_code" })).toBe(
        false,
      );
      expect(await deferTrigger(t.db, c)).toBeNull();
      expect(await recordTriggerFailure(t.db, c, new Error("x"), () => 0.5)).toBe(false);
      expect(await triggerRow(t, trig.id)).toEqual(done);
      expect(await claimTriggers(t.db)).toEqual([]);
    });

    it("a stale or mismatched claim has no effect", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const stale = await claimOne(trig.id);
      await expireClaim(t, trig.id);
      const current = await claimOne(trig.id);
      expect(
        await finishTrigger(t.db, stale, { status: "PROCESSED", outcomeCode: "processed" }),
      ).toBe(false);
      expect(
        await finishTrigger(
          t.db,
          { ...current, claimToken: "00000000-0000-4000-8000-000000000000" },
          { status: "PROCESSED", outcomeCode: "processed" },
        ),
      ).toBe(false);
      expect(await triggerRow(t, trig.id)).toMatchObject({
        status: "PENDING",
        claim_token: current.claimToken,
      });
    });

    it("a DEAD trigger cannot be finished or reopened", async () => {
      const dead = await insertTrigger(t, ctxOf(w), { finished: "DEAD", attempts: 6 });
      const fake: ClaimedTrigger = {
        id: dead.id,
        organizationId: w.org.id,
        whatsappAccountId: w.account.id,
        conversationId: w.student.conversation.id,
        messageId: dead.messageId,
        claimToken: "11111111-1111-4111-8111-111111111111",
        claimedAt: new Date(),
        attempts: 6,
        deferrals: 0,
        inputOccurredAt: new Date(),
        enqueuedAt: new Date(),
        observedControlSeq: 0,
      };
      expect(
        await finishTrigger(t.db, fake, { status: "PROCESSED", outcomeCode: "processed" }),
      ).toBe(false);
      expect(await triggerRow(t, dead.id)).toMatchObject({
        status: "DEAD",
        outcome_code: "attempts_exhausted",
      });
    });

    it("the finish records the session it belongs to, which the composite foreign key ties to this conversation", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const c = await claimOne(trig.id);
      await expect(
        finishTrigger(t.db, c, {
          status: "PROCESSED",
          outcomeCode: "processed",
          sessionId: "11111111-1111-4111-8111-111111111111",
        }),
      ).rejects.toThrow(); // no such session: the foreign key refuses, the row is unchanged
      expect(await triggerRow(t, trig.id)).toMatchObject({
        status: "PENDING",
        claim_token: c.claimToken,
      });
    });

    it("NEGATIVE CONTROL: without the fence a stale worker overwrites the outcome of a newer claim", async () => {
      const trig = await insertTrigger(t, ctxOf(w));
      const stale = await claimOne(trig.id);
      await expireClaim(t, trig.id);
      const current = await claimOne(trig.id);
      expect(
        await finishTrigger(t.db, current, { status: "PROCESSED", outcomeCode: "processed" }),
      ).toBe(true);
      const rendered = dialect.sqlToQuery(
        finishTriggerSql({ ...fence(stale), status: "IGNORED", outcomeCode: "late_worker" }),
      );
      const n = rendered.params.indexOf(stale.claimToken) + 1;
      const text = rendered.sql.replace(
        new RegExp(`status = 'PENDING' AND claim_token = \\$${n}\\b`),
        () => `$${n}::uuid IS NOT NULL`,
      );
      expect(text).not.toBe(rendered.sql);
      expect((await q(text, rendered.params)).rowCount).toBe(1); // the late worker replaced the committed outcome
      expect(await triggerRow(t, trig.id)).toMatchObject({ outcome_code: "late_worker" });
      // the production statement does not
      const done = await insertTrigger(t, ctxOf(w, await newStudent()));
      const d = await claimOne(done.id);
      expect(await finishTrigger(t.db, d, { status: "PROCESSED", outcomeCode: "processed" })).toBe(
        true,
      );
      expect(await finishTrigger(t.db, d, { status: "IGNORED", outcomeCode: "late_worker" })).toBe(
        false,
      );
      expect(await triggerRow(t, done.id)).toMatchObject({ outcome_code: "processed" });
    });
  });

  describe("wake and end (J.4a)", () => {
    it("wake makes the conversation's later-scheduled PENDING triggers due now, and only those", async () => {
      const ctx = ctxOf(w);
      const waiting = await insertTrigger(t, ctx, { dueInMs: 30_000 });
      const alreadyDue = await insertTrigger(t, ctx, { dueInMs: -5_000 });
      const finished = await insertTrigger(t, ctx, { finished: "PROCESSED" });
      const otherConv = await insertTrigger(t, ctxOf(w, await newStudent()), { dueInMs: 30_000 });
      expect(
        await wakeConversationTriggers(t.db, {
          organizationId: w.org.id,
          conversationId: ctx.conversationId,
        }),
      ).toBe(1);
      expect(await secondsUntilDue(t, waiting.id)).toBeLessThanOrEqual(0.5);
      expect(await secondsUntilDue(t, alreadyDue.id)).toBeLessThan(-3); // untouched
      expect(await triggerRow(t, finished.id)).toMatchObject({ status: "PROCESSED" });
      expect(await secondsUntilDue(t, otherConv.id)).toBeGreaterThan(20);
    });

    it("an excepted trigger is left alone", async () => {
      const ctx = ctxOf(w);
      const keep = await insertTrigger(t, ctx, { dueInMs: 30_000 });
      const wake = await insertTrigger(t, ctx, { dueInMs: 30_000 });
      expect(
        await wakeConversationTriggers(t.db, {
          organizationId: w.org.id,
          conversationId: ctx.conversationId,
          exceptId: keep.id,
        }),
      ).toBe(1);
      expect(await secondsUntilDue(t, keep.id)).toBeGreaterThan(20);
      expect(await secondsUntilDue(t, wake.id)).toBeLessThanOrEqual(0.5);
      expect(
        await endConversationTriggers(t.db, {
          organizationId: w.org.id,
          conversationId: ctx.conversationId,
          exceptId: keep.id,
        }),
      ).toBe(1);
      expect(await triggerRow(t, keep.id)).toMatchObject({ status: "PENDING" });
    });

    it("end finishes every other PENDING trigger of the conversation as IGNORED session_ended with a consistent row", async () => {
      const ctx = ctxOf(w);
      const a = await insertTrigger(t, ctx);
      const b = await insertTrigger(t, ctx, { claimAgeMs: 1_000, attempts: 1 }); // claimed but its step has not locked it yet
      expect(
        await endConversationTriggers(t.db, {
          organizationId: w.org.id,
          conversationId: ctx.conversationId,
        }),
      ).toBe(2);
      for (const id of [a.id, b.id])
        expect(await triggerRow(t, id)).toMatchObject({
          status: "IGNORED",
          outcome_code: "session_ended",
          claim_token: null,
          claimed_at: null,
        });
      expect((await triggerRow(t, b.id)).processed_at).toBeInstanceOf(Date);
    });

    it("a held trigger row is skipped by wake and end (never waited for) and stays PENDING", async () => {
      const ctx = ctxOf(w);
      const held = await insertTrigger(t, ctx, { dueInMs: 30_000 });
      const free = await insertTrigger(t, ctx, { dueInMs: 30_000 });
      const holder = await barriers.hold("select id from bot_triggers where id = $1 for update", [
        held.id,
      ]);
      expect(
        await barriers.within(
          wakeConversationTriggers(t.db, {
            organizationId: w.org.id,
            conversationId: ctx.conversationId,
          }),
          5_000,
        ),
      ).toBe(true);
      expect(await secondsUntilDue(t, free.id)).toBeLessThanOrEqual(0.5);
      expect(
        await barriers.within(
          endConversationTriggers(t.db, {
            organizationId: w.org.id,
            conversationId: ctx.conversationId,
          }),
          5_000,
        ),
      ).toBe(true);
      await holder.release();
      expect(await triggerRow(t, held.id)).toMatchObject({ status: "PENDING" }); // not abandoned: it is still claimable on its own schedule
      expect(await triggerRow(t, free.id)).toMatchObject({ status: "IGNORED" });
    });

    it("wake never waits on a trigger row held by a step transaction that is itself waiting for the conversation lock the waker holds", async () => {
      const ctx = ctxOf(w);
      const row = await insertTrigger(t, ctx, { dueInMs: 30_000 });
      const swept = deferred<void>();
      const gate = deferred<void>();
      let sweeperPid = 0;
      const sweeper = barriers.settle(
        t.db.transaction(async (tx) => {
          sweeperPid = (
            (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0] as { pid: number }
          ).pid;
          await tx.execute(
            sql`select id from conversations where id = ${ctx.conversationId} for update`,
          );
          swept.resolve();
          await gate.promise;
          return wakeConversationTriggers(tx, {
            organizationId: ctx.organizationId,
            conversationId: ctx.conversationId,
          });
        }),
      );
      await swept.promise;
      // the step transaction: trigger row first, then the conversation lock (it blocks behind the sweeper)
      const step = barriers.settle(
        t.db.transaction(async (tx) => {
          await tx.execute(sql`select id from bot_triggers where id = ${row.id} for update`);
          await tx.execute(
            sql`select id from conversations where id = ${ctx.conversationId} for update`,
          );
        }),
      );
      await barriers.waitUntilBlocked(sweeperPid);
      gate.resolve(); // the sweeper wakes while the step holds the trigger row and waits for it
      const [s, st] = await Promise.all([sweeper, step]);
      expect(s).toMatchObject({ ok: true, value: 0 }); // the held row was skipped, not waited for
      expect(st.ok).toBe(true);
      expect(await secondsUntilDue(t, row.id)).toBeGreaterThan(20); // skipped, not woken, and not lost
    });

    it("NEGATIVE CONTROL: the waiting form of the same wake deadlocks (40P01)", async () => {
      const ctx = ctxOf(w);
      const row = await insertTrigger(t, ctx, { dueInMs: 30_000 });
      const waiting = mutated(
        wakeConversationTriggersSql({
          organizationId: ctx.organizationId,
          conversationId: ctx.conversationId,
        }),
        (text) => text.replace(" SKIP LOCKED", ""),
      );
      const sweeperClient = await t.pool.connect();
      const stepClient = await t.pool.connect();
      try {
        await sweeperClient.query("begin");
        await sweeperClient.query("select id from conversations where id = $1 for update", [
          ctx.conversationId,
        ]);
        const sweeperPid = (
          (await sweeperClient.query("select pg_backend_pid() as pid")).rows[0] as { pid: number }
        ).pid;
        await stepClient.query("begin");
        await stepClient.query("select id from bot_triggers where id = $1 for update", [row.id]);
        const step = barriers.settle(
          stepClient.query("select id from conversations where id = $1 for update", [
            ctx.conversationId,
          ]),
        );
        await barriers.waitUntilBlocked(sweeperPid);
        const wake = barriers.settle(sweeperClient.query(waiting.text, waiting.params));
        // whichever side is chosen as the deadlock victim ends first; its transaction is aborted but still holds its locks, so
        // roll it back to let the survivor finish
        const first = await Promise.race([
          wake.then(() => "wake" as const),
          step.then(() => "step" as const),
        ]);
        await (first === "wake" ? sweeperClient : stepClient)
          .query("rollback")
          .catch(() => undefined);
        const [w1, s1] = await Promise.all([wake, step]);
        const states = [settledState(w1), settledState(s1)];
        expect(states).toContain("40P01"); // one side is chosen as the deadlock victim
      } finally {
        await sweeperClient.query("rollback").catch(() => undefined);
        await stepClient.query("rollback").catch(() => undefined);
        sweeperClient.release();
        stepClient.release();
      }
    });
  });
});
