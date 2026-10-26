import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_VIOLATION,
  createTestDatabase,
  expectPgError,
  type TestDb,
} from "@/db/__tests__/helpers";
import {
  TRIGGER_RETENTION_DAYS,
  deleteExpiredTriggers,
  deleteExpiredTriggersSql,
} from "@/db/ops/bot-trigger-retention";
import { insertTrigger } from "@/modules/bot-runtime/testing";
import { buildWebhookWorkerHandlers } from "@/modules/whatsapp/worker/registry";
import {
  deliver,
  deliveryBytes,
  handlerContext,
  ingestBytes,
} from "@/modules/whatsapp/inbound/testing";
import { runRetention, runRetentionCli } from "./retention";
import {
  addStudent,
  barrierKit,
  botWorld,
  deployedBot,
  insertSession,
  rowOf,
  shortenRetention,
  updateSession,
  type BotWorld,
  type SessionKeys,
} from "./testing";

// Phase 08F-1: the bots:retention job on disposable al_ict_test_* PostgreSQL 17 databases only (never al_ict_whatsapp).
// R10 A, H, K and L re-run THROUGH THE JOB (V3.2 O.10 l.986), plus the terminal-trigger retention of owner decision D-1
// (14 days from processed_at; PROCESSED, IGNORED and DEAD only). Every outcome is real PostgreSQL behaviour: real guards, real
// row locks held by a second connection, real statement rollback. Sessions are made eligible by shortening
// bot_session_redaction_after() in this database (restored to the migration's 30 days after each test); triggers by moving
// processed_at back (the table has no guard).

const CLEARED = ["variables", "awaiting", "awaiting_token", "last_consumed_token", "redacted_at"];
const without = (row: Record<string, unknown> | undefined, keys: string[]) =>
  Object.fromEntries(Object.entries(row ?? {}).filter(([k]) => !keys.includes(k)));
const STUDENT_NAME = "Nimal Perera";
const DAY = 86_400_000;

describe("bots:retention (08F-1)", () => {
  let t: TestDb;
  let a: BotWorld;
  let b: BotWorld;
  let keysA: SessionKeys;
  let keysB: SessionKeys;
  let barriers: ReturnType<typeof barrierKit>;
  const logs: string[] = [];
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
  const one = async (text: string, params: unknown[] = []) => (await q(text, params)).rows[0];
  const keysFor = async (w: BotWorld): Promise<SessionKeys> => {
    const d = await deployedBot(t.db, w);
    return {
      organizationId: w.org.id,
      botId: d.bot.id,
      versionId: d.version.id,
      deploymentId: d.deployment.id,
      whatsappAccountId: w.account.id,
      student: w.student,
    };
  };
  const fresh = async (k: SessionKeys) => ({
    ...k,
    student: await addStudent(t.db, k.organizationId, k.whatsappAccountId),
  });
  const tokens: string[] = [];
  /** A terminal session holding a student's values, tokens and pending-prompt data. */
  async function terminal(
    k: SessionKeys,
    set = "state = 'COMPLETED', end_reason = 'idle_timeout'",
  ) {
    const awaitingToken = `a${Math.random().toString(36).slice(2, 10).padEnd(21, "0")}`;
    const consumed = `c${Math.random().toString(36).slice(2, 10).padEnd(21, "0")}`;
    tokens.push(awaitingToken, consumed);
    const s = await insertSession(t.pool, await fresh(k), {
      variables: JSON.stringify({ student_name: STUDENT_NAME, grade: 12 }),
      awaiting: JSON.stringify({
        nodeId: "menu",
        kind: "BUTTONS",
        phase: "SENT",
        optionKeys: ["yes"],
      }),
      awaiting_token: awaitingToken,
      last_consumed_token: consumed,
      step_seq: 4,
    });
    return updateSession(t.pool, s.id as string, set);
  }
  const ctx = (w: BotWorld) => ({
    organizationId: w.org.id,
    accountId: w.account.id,
    conversationId: w.student.conversation.id,
  });
  /** A terminal trigger on its own message, processed `days` ago. */
  async function oldTrigger(
    w: BotWorld,
    days = TRIGGER_RETENTION_DAYS + 1,
    finished: "PROCESSED" | "IGNORED" | "DEAD" = "PROCESSED",
  ) {
    const tr = await insertTrigger(t, ctx(w), { finished });
    await q(
      "update bot_triggers set processed_at = clock_timestamp() - $2 * interval '1 day' where id = $1",
      [tr.id, days],
    );
    return tr;
  }
  const exists = async (id: string) =>
    (await q("select 1 from bot_triggers where id = $1", [id])).rowCount === 1;
  const orgOf = (r: Awaited<ReturnType<typeof runRetention>>, w: BotWorld) =>
    r.organizations.find((o) => o.organizationId === w.org.id)!;
  const snapshot = async () => {
    const tables = [
      "messages",
      "bot_sessions",
      "outbound_requests",
      "bot_session_events",
      "bot_deployment_events",
      "bot_deployments",
      "conversations",
      "conversation_events",
      "webhook_events",
      "webhook_requests",
    ];
    const out: Record<string, unknown> = {};
    for (const table of tables)
      out[table] = (
        await one(`select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') j from ${table} x`)
      ).j;
    return out;
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
    logs.length = 0;
    tokens.length = 0;
    for (const m of ["log", "info", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation((line: unknown) => {
        logs.push(String(line));
      });
    await q("truncate organizations, webhook_requests cascade");
    a = await botWorld(t.db);
    b = await botWorld(t.db);
    keysA = await keysFor(a);
    keysB = await keysFor(b);
    barriers = barrierKit(t);
  });
  afterEach(async () => {
    try {
      await barriers?.cleanup();
    } finally {
      vi.restoreAllMocks();
      await q("drop trigger if exists zz_fixture_fail on bot_triggers");
      await q("drop trigger if exists zz_fixture_fail on bot_sessions");
      await q("drop function if exists zz_fixture_fail()");
      await shortenRetention(t.pool, "30 days"); // the migration's value
    }
  });

  // ============================================================================== R10 through the job (V3.2 O.10 l.986)

  describe("R10 A, H, K, L through runRetention", () => {
    beforeEach(() => shortenRetention(t.pool));

    it("A. an expired COMPLETED session: only the approved fields are cleared by the job; everything else is byte-identical", async () => {
      const s = await terminal(keysA);
      const before = await rowOf(t.pool, "bot_sessions", s.id as string);
      const r = await runRetention(t.db, { apply: true });
      expect(orgOf(r, a)).toMatchObject({ sessions: 1, sessionsRemaining: false });
      const after = await rowOf(t.pool, "bot_sessions", s.id as string);
      expect(after).toMatchObject({
        variables: {},
        awaiting: null,
        awaiting_token: null,
        last_consumed_token: null,
      });
      expect(after!.redacted_at).not.toBeNull();
      expect(without(after, CLEARED)).toEqual(without(before, CLEARED));
    });

    it("H. repeated runs change nothing: the second run redacts 0 and redacted_at keeps its first value", async () => {
      const s = await terminal(keysA);
      expect(orgOf(await runRetention(t.db, { apply: true }), a).sessions).toBe(1);
      const once = await rowOf(t.pool, "bot_sessions", s.id as string);
      const second = await runRetention(t.db, { apply: true });
      expect(second.organizations.map((o) => o.sessions)).toEqual([0, 0]);
      expect(await rowOf(t.pool, "bot_sessions", s.id as string)).toEqual(once);
    });

    it("K. organizations are processed independently: each run touches only its own organization's rows", async () => {
      const sa = await terminal(keysA);
      const sa2 = await terminal(
        keysA,
        "state = 'HANDED_OVER', end_reason = 'flow_handover', handover_reason = 'needs_staff', terminal_notice_step_seq = 4",
      );
      const liveB = await insertSession(t.pool, await fresh(keysB));
      const liveBefore = await rowOf(t.pool, "bot_sessions", liveB.id as string);
      const r = await runRetention(t.db, { apply: true });
      expect(orgOf(r, a).sessions).toBe(2);
      expect(orgOf(r, b).sessions).toBe(0);
      expect(await rowOf(t.pool, "bot_sessions", liveB.id as string)).toEqual(liveBefore);
      // the per-organization primitive matches nothing of A when called for B
      const s3 = await terminal(keysA);
      const before = await rowOf(t.pool, "bot_sessions", s3.id as string);
      expect((await one("select redact_expired_bot_sessions($1, 100) n", [b.org.id])).n).toBe(0);
      expect(await rowOf(t.pool, "bot_sessions", s3.id as string)).toEqual(before);
      for (const s of [sa, sa2])
        expect((await rowOf(t.pool, "bot_sessions", s.id as string))!.redacted_at).not.toBeNull();
    });

    it("L. no sensitive value is exposed: one bots.sessions_redacted line per organization with id, count and interval only; no event, no control sequence", async () => {
      const s = await terminal(keysA);
      const events = await one("select count(*)::int n from bot_session_events");
      const seq = await one("select control_seq from conversations where id = $1", [
        s.conversation_id,
      ]);
      const out: unknown[] = [];
      expect(await runRetentionCli(["--apply"], t.db, (v) => out.push(v))).toBe(0);
      const lines = logs.map((l) => JSON.parse(l) as Record<string, unknown>);
      const redacted = lines.filter((l) => l.message === "bots.sessions_redacted");
      expect(redacted).toHaveLength(2); // one per organization, including the one with nothing to redact
      for (const l of redacted)
        expect(Object.keys(l).sort()).toEqual(
          [
            "level",
            "message",
            "time",
            "bots_event",
            "outcome",
            "organization_id",
            "count",
            "interval",
          ].sort(),
        );
      expect(redacted.find((l) => l.organization_id === a.org.id)).toMatchObject({
        count: 1,
        interval: "00:00:00",
        outcome: "success",
      });
      // nothing sensitive in any log line or in the printed report
      const everything = JSON.stringify([logs, out]);
      for (const secret of [STUDENT_NAME, "student_name", "grade", "optionKeys", "menu", ...tokens])
        expect(everything).not.toContain(secret);
      expect(await one("select count(*)::int n from bot_session_events")).toEqual(events);
      expect(
        await one("select control_seq from conversations where id = $1", [s.conversation_id]),
      ).toEqual(seq);
    });

    it("a dry run (the default) counts what is eligible and changes nothing", async () => {
      const s = await terminal(keysA);
      const tr = await oldTrigger(a);
      const before = await snapshot();
      const out: unknown[] = [];
      expect(await runRetentionCli([], t.db, (v) => out.push(v))).toBe(0);
      expect(out[0]).toMatchObject({ ok: true, dryRun: true, triggerRetentionDays: 14 });
      expect(orgOf(out[0] as never, a)).toMatchObject({ sessions: 1, triggers: 1 });
      expect(await snapshot()).toEqual(before);
      expect(await exists(tr.id)).toBe(true);
      expect((await rowOf(t.pool, "bot_sessions", s.id as string))!.redacted_at).toBeNull();
      expect(logs.filter((l) => l.includes("bots.sessions_redacted"))).toEqual([]);
    });

    it("an unknown option is a usage error before any database access", async () => {
      const out: unknown[] = [];
      expect(await runRetentionCli(["--aply"], t.db, (v) => out.push(v))).toBe(2);
      expect(out[0]).toMatchObject({ ok: false, usage: "bots:retention [--apply]" });
    });
  });

  it("with the 30-day policy, a recently ended session is not redacted by the job", async () => {
    const s = await terminal(keysA);
    const before = await rowOf(t.pool, "bot_sessions", s.id as string);
    const r = await runRetention(t.db, { apply: true });
    expect(r.sessionRedactionAfter).toBe("30 days");
    expect(orgOf(r, a).sessions).toBe(0);
    expect(await rowOf(t.pool, "bot_sessions", s.id as string)).toEqual(before);
  });

  // ================================================================================ terminal-trigger retention (D-1)

  describe("terminal-trigger retention", () => {
    it("the exact boundary: processed_at at or before the cutoff is deleted, one microsecond later is kept", async () => {
      const cutoff = (await one("select (clock_timestamp() - interval '20 days')::text c"))
        .c as string;
      const at = await insertTrigger(t, ctx(a), { finished: "PROCESSED" });
      const earlier = await insertTrigger(t, ctx(a), { finished: "IGNORED" });
      const after = await insertTrigger(t, ctx(a), { finished: "DEAD" });
      await q("update bot_triggers set processed_at = $2::timestamptz where id = $1", [
        at.id,
        cutoff,
      ]);
      await q(
        "update bot_triggers set processed_at = $2::timestamptz - interval '1 microsecond' where id = $1",
        [earlier.id, cutoff],
      );
      await q(
        "update bot_triggers set processed_at = $2::timestamptz + interval '1 microsecond' where id = $1",
        [after.id, cutoff],
      );
      expect(
        await deleteExpiredTriggers(t.db, { organizationId: a.org.id, cutoff, limit: 100 }),
      ).toBe(2);
      expect([await exists(at.id), await exists(earlier.id), await exists(after.id)]).toEqual([
        false,
        false,
        true,
      ]);
    });

    it("the 14-day period is a floor inside the statement: a later cutoff never deletes a younger row", async () => {
      const now = (await one("select clock_timestamp()::text c")).c as string;
      const young = await oldTrigger(a, TRIGGER_RETENTION_DAYS - 1 / 24); // 13 days 23 hours
      const old = await oldTrigger(a, TRIGGER_RETENTION_DAYS + 1 / 1440); // 14 days and a minute
      expect(
        await deleteExpiredTriggers(t.db, { organizationId: a.org.id, cutoff: now, limit: 100 }),
      ).toBe(1);
      expect([await exists(young.id), await exists(old.id)]).toEqual([true, false]);
      // the job's own cutoff is the database clock minus 14 days
      const r = await runRetention(t.db, { apply: true });
      expect(orgOf(r, a).triggers).toBe(0);
      expect(await exists(young.id)).toBe(true);
      const gap = await one(
        "select extract(epoch from (clock_timestamp() - $1::timestamptz))::float8 s",
        [r.triggerCutoff],
      );
      expect(Math.abs(gap.s - 14 * 86_400)).toBeLessThan(60);
    });

    it("all three terminal states are eligible; PENDING rows (unclaimed, claimed, lease-expired, exhausted) never are, however old", async () => {
      const terminals = await Promise.all(
        (["PROCESSED", "IGNORED", "DEAD"] as const).map((s) => oldTrigger(a, 30, s)),
      );
      const pending = [
        await insertTrigger(t, ctx(a)),
        await insertTrigger(t, ctx(a), { claimAgeMs: 1_000 }),
        await insertTrigger(t, ctx(a), { claimAgeMs: 30 * DAY }),
        await insertTrigger(t, ctx(a), { attempts: 6, claimAgeMs: 30 * DAY }),
      ];
      await q(
        "update bot_triggers set created_at = now() - interval '90 days', enqueued_at = clock_timestamp() - interval '90 days' where status = 'PENDING'",
      );
      const pendingBefore = await Promise.all(
        pending.map((p) => rowOf(t.pool, "bot_triggers", p.id)),
      );
      const r = await runRetention(t.db, { apply: true });
      expect(orgOf(r, a).triggers).toBe(3);
      for (const tr of terminals) expect(await exists(tr.id)).toBe(false);
      expect(await Promise.all(pending.map((p) => rowOf(t.pool, "bot_triggers", p.id)))).toEqual(
        pendingBefore,
      );
      // a terminal row cannot hold a claim at all (lifecycle CHECK), so "claimed and terminal" is unreachable
      await expectPgError(
        q(
          "update bot_triggers set status = 'PROCESSED', processed_at = clock_timestamp() where id = $1",
          [pending[1]!.id],
        ),
        CHECK_VIOLATION,
        "bot_triggers_lifecycle_check",
      );
    });

    it("SKIP LOCKED under real contention: a row held by another transaction is skipped without waiting, and deleted by a later run", async () => {
      const held = await oldTrigger(a);
      const free = await oldTrigger(a);
      const lock = await barriers.hold("select id from bot_triggers where id = $1 for update", [
        held.id,
      ]);
      const run = barriers.settle(runRetention(t.db, { apply: true }));
      expect(await barriers.within(run, 5_000)).toBe(true); // it never waits for the held row
      const r = await run;
      expect(r.ok).toBe(true);
      expect(
        orgOf((r as { value: Awaited<ReturnType<typeof runRetention>> }).value, a).triggers,
      ).toBe(1);
      expect([await exists(held.id), await exists(free.id)]).toEqual([true, false]);
      await lock.release();
      expect(orgOf(await runRetention(t.db, { apply: true }), a).triggers).toBe(1);
      expect(await exists(held.id)).toBe(false);
    });

    it("a trigger a running step is finishing (uncommitted PROCESSED) is neither waited for nor deleted; after commit it ages normally", async () => {
      const tr = await insertTrigger(t, ctx(a), { claimAgeMs: 1_000 });
      const step = await barriers.hold(
        "update bot_triggers set status = 'PROCESSED', outcome_code = 'processed', processed_at = clock_timestamp() - interval '30 days', claim_token = NULL, claimed_at = NULL where id = $1",
        [tr.id],
      );
      const run = barriers.settle(runRetention(t.db, { apply: true }));
      expect(await barriers.within(run, 5_000)).toBe(true);
      expect(await barriers.blockersOf(step.pid)).toEqual([]);
      expect(
        orgOf(((await run) as { value: Awaited<ReturnType<typeof runRetention>> }).value, a)
          .triggers,
      ).toBe(0);
      await step.release();
      expect(orgOf(await runRetention(t.db, { apply: true }), a).triggers).toBe(1);
      expect(await exists(tr.id)).toBe(false);
    });

    it("a session row held by a step is skipped by redaction (SKIP LOCKED) and redacted by a later run", async () => {
      await shortenRetention(t.pool);
      const s = await terminal(keysA);
      const lock = await barriers.hold("select id from bot_sessions where id = $1 for update", [
        s.id,
      ]);
      const run = barriers.settle(runRetention(t.db, { apply: true }));
      expect(await barriers.within(run, 5_000)).toBe(true);
      expect(
        orgOf(((await run) as { value: Awaited<ReturnType<typeof runRetention>> }).value, a)
          .sessions,
      ).toBe(0);
      await lock.release();
      expect(orgOf(await runRetention(t.db, { apply: true }), a).sessions).toBe(1);
    });

    it("multi-organization isolation: each organization's batch deletes only its own rows", async () => {
      const ta = [await oldTrigger(a), await oldTrigger(a)];
      const tb = [await oldTrigger(b)];
      const cutoff = (await one("select (clock_timestamp() - interval '14 days')::text c"))
        .c as string;
      const outsider = (await one("select gen_random_uuid()::text id")).id as string;
      expect(
        await deleteExpiredTriggers(t.db, { organizationId: outsider, cutoff, limit: 100 }),
      ).toBe(0);
      expect(
        await deleteExpiredTriggers(t.db, { organizationId: b.org.id, cutoff, limit: 100 }),
      ).toBe(1);
      for (const tr of ta) expect(await exists(tr.id)).toBe(true);
      const r = await runRetention(t.db, { apply: true });
      expect([orgOf(r, a).triggers, orgOf(r, b).triggers]).toEqual([2, 0]);
      for (const tr of [...ta, ...tb]) expect(await exists(tr.id)).toBe(false);
    });

    it("bounded batches: the batch size and batch budget cap one run; a later run continues; then nothing is left", async () => {
      await shortenRetention(t.pool);
      for (let i = 0; i < 7; i++) await oldTrigger(a);
      for (let i = 0; i < 5; i++) await terminal(keysA);
      const first = orgOf(
        await runRetention(t.db, { apply: true, batchSize: 2, maxBatches: 2 }),
        a,
      );
      expect(first).toMatchObject({
        triggers: 4,
        triggersRemaining: true,
        sessions: 4,
        sessionsRemaining: true,
      });
      const second = orgOf(
        await runRetention(t.db, { apply: true, batchSize: 2, maxBatches: 2 }),
        a,
      );
      expect(second).toMatchObject({
        triggers: 3,
        triggersRemaining: false,
        sessions: 1,
        sessionsRemaining: false,
      });
      const third = orgOf(
        await runRetention(t.db, { apply: true, batchSize: 2, maxBatches: 2 }),
        a,
      );
      expect(third).toMatchObject({ triggers: 0, sessions: 0 });
      // one statement never deletes more than its limit
      const cutoff = (await one("select clock_timestamp()::text c")).c as string;
      for (let i = 0; i < 3; i++) await oldTrigger(b);
      expect(
        await deleteExpiredTriggers(t.db, { organizationId: b.org.id, cutoff, limit: 2 }),
      ).toBe(2);
      expect(() =>
        deleteExpiredTriggersSql({ organizationId: b.org.id, cutoff, limit: 0 }),
      ).toThrow(RangeError);
      expect(() =>
        deleteExpiredTriggersSql({ organizationId: b.org.id, cutoff, limit: 10_001 }),
      ).toThrow(RangeError);
      expect(() => deleteExpiredTriggersSql({ organizationId: "x", cutoff, limit: 1 })).toThrow(
        TypeError,
      );
      await expect(runRetention(t.db, { apply: true, batchSize: 0 })).rejects.toThrow(RangeError);
    });

    it("concurrent runs are safe: two jobs at once delete every eligible row exactly once and never wait for each other", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) ids.push((await oldTrigger(a)).id);
      const [r1, r2] = await Promise.all([
        runRetention(t.db, { apply: true, batchSize: 5, maxBatches: 10 }),
        runRetention(t.db, { apply: true, batchSize: 5, maxBatches: 10 }),
      ]);
      expect(orgOf(r1, a).triggers! + orgOf(r2, a).triggers!).toBe(30);
      expect(
        (
          await one("select count(*)::int n from bot_triggers where organization_id = $1", [
            a.org.id,
          ])
        ).n,
      ).toBe(0);
    });

    it("a failing batch rolls back whole, earlier batches stay committed, other organizations and the session part still run", async () => {
      await shortenRetention(t.pool);
      const ta: string[] = [];
      for (let i = 0; i < 4; i++) ta.push((await oldTrigger(a, 20 - i)).id); // deleted oldest first
      const tb = await oldTrigger(b);
      const sa = await terminal(keysA);
      // a test-only trigger refuses deleting A's third-oldest row: the second batch (rows 3 and 4) must roll back whole
      await q(`create function zz_fixture_fail() returns trigger language plpgsql as $$
               begin if old.id = '${ta[2]}' then raise exception 'fixture refusal'; end if; return old; end $$`);
      await q(
        "create trigger zz_fixture_fail before delete on bot_triggers for each row execute function zz_fixture_fail()",
      );
      const report = await runRetention(t.db, { apply: true, batchSize: 2 });
      expect(orgOf(report, a)).toMatchObject({
        triggers: null,
        triggersError: "P0001",
        sessions: 1,
      });
      expect(orgOf(report, b)).toMatchObject({ triggers: 1 });
      expect(await Promise.all(ta.map(exists))).toEqual([false, false, true, true]);
      expect(await exists(tb.id)).toBe(false);
      expect((await rowOf(t.pool, "bot_sessions", sa.id as string))!.redacted_at).not.toBeNull();
      const failure = logs
        .map((l) => JSON.parse(l))
        .find((l) => l.message === "bots.triggers_deleted" && l.outcome === "failure");
      expect(failure).toMatchObject({ organization_id: a.org.id, reason: "sqlstate_p0001" });
      expect(JSON.stringify(logs)).not.toContain("fixture refusal"); // error text is never logged
    });

    it("a failing redaction rolls back whole for that organization; its triggers and other organizations are still processed; exit 1", async () => {
      await shortenRetention(t.pool);
      const sa = await terminal(keysA);
      const sb = await terminal(keysB);
      const ta = await oldTrigger(a);
      await q(`create function zz_fixture_fail() returns trigger language plpgsql as $$
               begin if new.organization_id = '${a.org.id}' then raise exception 'fixture refusal'; end if; return new; end $$`);
      await q(
        "create trigger zz_fixture_fail before update on bot_sessions for each row execute function zz_fixture_fail()",
      );
      const before = await rowOf(t.pool, "bot_sessions", sa.id as string);
      const out: unknown[] = [];
      expect(await runRetentionCli(["--apply"], t.db, (v) => out.push(v))).toBe(1);
      const r = out[0] as Awaited<ReturnType<typeof runRetention>> & { ok: boolean };
      expect(r.ok).toBe(false);
      expect(orgOf(r, a)).toMatchObject({ sessions: null, sessionsError: "P0001", triggers: 1 });
      expect(orgOf(r, b)).toMatchObject({ sessions: 1 });
      expect(await rowOf(t.pool, "bot_sessions", sa.id as string)).toEqual(before);
      expect((await rowOf(t.pool, "bot_sessions", sb.id as string))!.redacted_at).not.toBeNull();
      expect(await exists(ta.id)).toBe(false);
    });

    it("trigger cleanup changes no message, session, request, event, conversation, deployment or webhook row", async () => {
      await terminal(keysA); // recent: not eligible under the 30-day policy
      for (let i = 0; i < 3; i++) await oldTrigger(a);
      await oldTrigger(b, 40, "DEAD");
      const before = await snapshot();
      const r = await runRetention(t.db, { apply: true });
      expect([orgOf(r, a).triggers, orgOf(r, b).triggers]).toEqual([3, 1]);
      expect(await snapshot()).toEqual(before);
    });
  });

  // ============================================================== duplicate delivery after the trigger was deleted

  it("a redelivered message whose terminal trigger was deleted creates no new trigger and no second message", async () => {
    const account = await one(
      "update whatsapp_accounts set status = 'ACTIVE' where id = $1 returning phone_number_id, waba_id",
      [a.account.id],
    );
    const handler = buildWebhookWorkerHandlers({ BOTS_RUNTIME_ENABLED: "true" }).MESSAGE!;
    const run = (event: Awaited<ReturnType<typeof deliver>>) =>
      t.db.transaction((tx) => handler(tx, { ...event, eventType: "MESSAGE" }, handlerContext()));
    const first = await deliver(t.db, { pn: account.phone_number_id, waba: account.waba_id });
    await run(first);
    const message = await one("select id from messages where source_webhook_event_id = $1", [
      first.id,
    ]);
    const trigger = await one("select id from bot_triggers where message_id = $1", [message.id]);
    expect(trigger).toBeDefined(); // the real capture stored it (dormant capture switched on for the test only)
    await q(
      "update bot_triggers set status = 'IGNORED', outcome_code = 'no_trigger_match', processed_at = clock_timestamp() - interval '15 days' where id = $1",
      [trigger.id],
    );
    expect(orgOf(await runRetention(t.db, { apply: true }), a).triggers).toBe(1);
    expect(await exists(trigger.id)).toBe(false);

    // layer 1: the same wamid in a re-sent envelope (new bytes) is refused at ingest; no new event is stored
    const again = await ingestBytes(
      t.db,
      deliveryBytes({
        id: first.providerObjectId,
        pn: account.phone_number_id,
        waba: account.waba_id,
        timestamp: new Date(Date.now() - 30_000),
      }).bytes,
    );
    expect(again).toEqual([]);
    // layer 2: the stored event handled again (a worker retry) reaches the real handler, whose duplicate check runs before
    // any write, so no trigger is captured although the old one is gone
    logs.length = 0;
    await run(first);
    expect(logs.some((l) => l.includes("webhook.message_duplicate"))).toBe(true);
    expect(
      (await one("select count(*)::int n from messages where wamid = $1", [first.providerObjectId]))
        .n,
    ).toBe(1);
    expect(
      (await one("select count(*)::int n from bot_triggers where message_id = $1", [message.id])).n,
    ).toBe(0);
    expect(
      (await one("select count(*)::int n from bot_triggers where organization_id = $1", [a.org.id]))
        .n,
    ).toBe(0);
  });
});
