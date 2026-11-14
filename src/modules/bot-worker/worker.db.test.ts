import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerDatabase } from "@/db";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import type { DbExecutor } from "@/db/ops/executor";
import { barrierKit } from "../bot-control/testing";
import {
  expireClaim,
  insertTrigger,
  runtimeKit,
  triggerRow,
  type RuntimeFx,
} from "../bot-runtime/testing";
import { claimTriggers } from "../bot-runtime/trigger-queue";
import { WorkerPreflightError } from "./errors";
import { SESSION_SETTINGS } from "./policy";
import { botWorkerDatabase, EXIT_REFUSED, EXIT_STOPPED, preflight } from "./run";
import { startWorker, until, WORKER_APP, workerConnections } from "./testing";

// The bot worker on disposable PostgreSQL 17 (Phase 08E-7; plan J.1, J.2, J.6): its own pool and session settings, the
// transaction bound, connection eviction, exactly-once processing (one and two workers), the busy-conversation deferral, crash
// and lease recovery, the sweeper loop, clean shutdown, and refusal with no writes. The worker NEVER sends: no transport exists
// in it; BOT requests it queues stay QUEUED here. NOT EXECUTED by the author of this change: no isolated PostgreSQL server was
// configured.

describe("the bot worker (08E-7)", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  let k: ReturnType<typeof runtimeKit>;
  const workers: Array<ReturnType<typeof startWorker>> = [];
  const start = (env: Record<string, string> = {}) => {
    const w = startWorker(t, env);
    workers.push(w);
    return w;
  };

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
    try {
      for (const w of workers.splice(0)) await w.stop();
      k.releaseAll();
      await kit.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  });
  afterAll(async () => t.close());

  const db = () => t.db as unknown as DbExecutor;
  const status = async (id: string) => (await triggerRow(t, id)).status as string;
  const sessionsOf = (f: RuntimeFx) =>
    k.rows("select * from bot_sessions where conversation_id = $1", [f.w.student.conversation.id]);

  // ------------------------------------------------------------------------------------------------ pool (J.6)
  describe("the dedicated pool", () => {
    it("every connection carries transaction_timeout 25 s, idle_in_transaction 10 s, statement_timeout 15 s and the worker's name; preflight passes", async () => {
      const w = botWorkerDatabase({ databaseUrl: t.url, concurrency: 2 });
      try {
        const seen = await Promise.all(
          Array.from({ length: 4 }, () =>
            w.db.transaction(async (tx) => {
              const r = await tx.execute<Record<string, string>>(sql`
                select current_setting('transaction_timeout') transaction_timeout,
                       current_setting('idle_in_transaction_session_timeout') idle_in_transaction_session_timeout,
                       current_setting('statement_timeout') statement_timeout,
                       current_setting('application_name') application_name,
                       current_setting('transaction_isolation') isolation, pg_sleep(0.05)`);
              return r.rows[0]!;
            }),
          ),
        );
        for (const s of seen)
          expect(s).toMatchObject({
            ...SESSION_SETTINGS,
            application_name: WORKER_APP,
            isolation: "read committed",
          });
        await expect(preflight(w.db as unknown as DbExecutor)).resolves.toBeUndefined();
      } finally {
        await w.close();
      }
    });

    it("preflight refuses a pool whose settings did not apply (fail closed)", async () => {
      await expect(preflight(db())).rejects.toBeInstanceOf(WorkerPreflightError);
      await expect(preflight(db())).rejects.toMatchObject({ code: "session_settings_not_applied" });
    });

    it("transaction_timeout terminates an over-long transaction: nothing commits, its locks are released, the dead connection is evicted, the pool recovers", async () => {
      // the same mechanism as the worker's 25 s bound, with a small value so the test is quick (recorded as an observation)
      const w = createWorkerDatabase(t.url, {
        maxConnections: 1,
        applicationName: "al-ict-bots-timeout-test",
        onPoolError: () => undefined,
        sessionSettings: { transaction_timeout: "1s" },
      });
      try {
        const key = `bot-timeout-test:${Date.now()}`;
        const failed = await w.db
          .transaction(async (tx) => {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
            await tx.execute(sql`select pg_sleep(3)`);
          })
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(failed).not.toBeNull();
        const states: string[] = [];
        for (let e: unknown = failed, i = 0; e && typeof e === "object" && i < 5; i++) {
          const code = (e as { code?: unknown }).code;
          if (typeof code === "string") states.push(code);
          e = (e as { cause?: unknown }).cause;
        }
        process.stdout.write(`\n[08E-7] transaction_timeout observed: ${JSON.stringify(states)}\n`);
        // the lock died with the session
        expect(
          (
            await t.pool.query("select pg_try_advisory_xact_lock(hashtextextended($1, 0)) ok", [
              key,
            ])
          ).rows[0].ok,
        ).toBe(true);
        // the single slot is usable again (the dead client was discarded, not reused)
        const ok = await w.db.execute(sql`select 1 as ok`);
        expect(ok.rows).toEqual([{ ok: 1 }]);
      } finally {
        await w.close();
      }
    });
  });

  // ------------------------------------------------------------------------------------------------ refusal
  it("refused (a gate not exactly 'true'): exit 2, no connection, no write; the pending trigger is untouched", async () => {
    const f = await k.fixture();
    const tr = await k.trigger(f, { first: true });
    const before = await triggerRow(t, tr.id);
    const w = start({ BOTS_RUNTIME_ENABLED: "TRUE" });
    expect(await w.running).toBe(EXIT_REFUSED);
    expect(await triggerRow(t, tr.id)).toEqual(before);
    expect(await workerConnections(t)).toEqual([]);
    expect(await k.botRequests(f)).toHaveLength(0);
  });

  // ------------------------------------------------------------------------------------------------ processing
  it("processes an eligible trigger exactly once (one session, one QUEUED request, nothing sent), then stops cleanly", async () => {
    const f = await k.fixture();
    const tr = await k.trigger(f, { first: true });
    const w = start();
    await until(async () => (await status(tr.id)) === "PROCESSED", 20_000, "trigger processed");
    expect(await w.stop()).toBe(EXIT_STOPPED);
    expect(await triggerRow(t, tr.id)).toMatchObject({
      outcome_code: "session_started",
      attempts: 1,
      claim_token: null,
    });
    expect(await sessionsOf(f)).toHaveLength(1);
    const reqs = await k.botRequests(f);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ state: "QUEUED", send_started_at: null }); // the bot worker never sends
    // clean shutdown: no connection (and so no open transaction or advisory lock) of the worker remains
    await until(
      async () => (await workerConnections(t)).length === 0,
      10_000,
      "worker connections closed",
    );
  });

  it("two workers on many conversations: every trigger exactly once, no duplicate session or request, bounded lanes", async () => {
    const worlds: RuntimeFx[] = [];
    const triggers: string[] = [];
    for (let i = 0; i < 6; i++) {
      const f = await k.fixture();
      worlds.push(f);
      triggers.push((await k.trigger(f, { first: true })).id);
    }
    start();
    start();
    await until(
      async () => {
        for (const id of triggers) if ((await status(id)) !== "PROCESSED") return false;
        return true;
      },
      30_000,
      "all triggers processed",
    );
    for (const id of triggers)
      expect(await triggerRow(t, id)).toMatchObject({
        attempts: 1,
        outcome_code: "session_started",
      });
    for (const f of worlds) {
      expect(await sessionsOf(f)).toHaveLength(1);
      expect(await k.botRequests(f)).toHaveLength(1);
    }
    // each worker's pool stays within its bound (2 lanes + 3)
    expect((await workerConnections(t)).length).toBeLessThanOrEqual(10);
  });

  it("a busy conversation (its advisory lock held) is deferred without waiting, then processed once the lock is free", async () => {
    const f = await k.fixture();
    const tr = await k.trigger(f, { first: true });
    const busy = await kit.hold("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `bot-conv:${f.w.org.id}:${f.w.student.conversation.id}`,
    ]);
    start();
    await until(
      async () => Number((await triggerRow(t, tr.id)).deferrals) >= 1,
      20_000,
      "deferred",
    );
    expect(await triggerRow(t, tr.id)).toMatchObject({ status: "PENDING", attempts: 0 }); // refunded, not charged
    await busy.release();
    await until(
      async () => (await status(tr.id)) === "PROCESSED",
      30_000,
      "processed after release",
    );
    expect(await sessionsOf(f)).toHaveLength(1);
  });

  it("a worker that died after its claim (T0): the lease expires and a worker processes the trigger once (attempt 2)", async () => {
    const f = await k.fixture();
    const tr = await k.trigger(f, { first: true });
    expect((await claimTriggers(db(), 50)).map((c) => c.id)).toContain(tr.id); // the dead worker's T0
    await expireClaim(t, tr.id);
    start();
    await until(async () => (await status(tr.id)) === "PROCESSED", 20_000, "recovered");
    expect(await triggerRow(t, tr.id)).toMatchObject({ attempts: 2 });
    expect(await k.botRequests(f)).toHaveLength(1);
  });

  it("a committed result is never replayed: a trigger already processed is not claimed again by a starting worker", async () => {
    const f = await k.fixture();
    const tr = await k.trigger(f, { first: true });
    await k.run(tr.id);
    const before = await triggerRow(t, tr.id);
    const w = start();
    await until(async () => (await workerConnections(t)).length > 0, 10_000, "worker connected");
    await new Promise((r) => setTimeout(r, 1_500)); // a few idle polls: there must be nothing to do
    expect(await w.stop()).toBe(EXIT_STOPPED);
    expect(await triggerRow(t, tr.id)).toEqual(before);
    expect(await k.botRequests(f)).toHaveLength(1);
  });

  it("its connections killed mid-run: the dead ones are evicted, the worker recovers and processes later triggers once", async () => {
    const f = await k.fixture();
    const w = start();
    await until(async () => (await workerConnections(t)).length > 0, 10_000, "worker connected");
    await t.pool.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and application_name = $1",
      [WORKER_APP],
    );
    const tr = await k.trigger(f, { first: true });
    await until(
      async () => (await status(tr.id)) === "PROCESSED",
      30_000,
      "processed after reconnection",
    );
    expect(await w.stop()).toBe(EXIT_STOPPED);
    expect(await k.botRequests(f)).toHaveLength(1);
  });

  it("the sweeper loop reconciles an ACCEPTED prompt (WAITING_FOR_INPUT) and terminalizes an exhausted trigger", async () => {
    const f = await k.fixture();
    const { session } = await k.acceptedPrompt(f);
    const g = await k.fixture();
    const exhausted = await insertTrigger(t, k.ctxOf(g), { attempts: 6 });
    start();
    await until(
      async () => (await k.session(session.id as string)).state === "WAITING_FOR_INPUT",
      20_000,
      "reconciled",
    );
    await until(async () => (await status(exhausted.id)) === "DEAD", 20_000, "terminalized");
    expect(await k.botRequests(f)).toHaveLength(1);
  });
});
