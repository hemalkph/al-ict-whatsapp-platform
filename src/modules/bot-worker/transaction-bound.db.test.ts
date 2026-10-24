import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerDatabase } from "@/db";
import { createTestDatabase, migrateThrough, type TestDb } from "@/db/__tests__/helpers";
import type { DbExecutor } from "@/db/ops/executor";
import { barrierKit } from "../bot-control/testing";
import { expireClaim, makeDue, runtimeKit, triggerRow } from "../bot-runtime/testing";
import { claimFailureBackoffMs } from "../bot-runtime/backoff";
import { claimTriggers } from "../bot-runtime/trigger-queue";
import { processTrigger } from "../bot-runtime/step";
import { SESSION_SETTINGS } from "./policy";
import { botWorkerDatabase, EXIT_REFUSED, preflight, runBotWorker } from "./run";
import { readSchemaFacts, schemaProblems } from "./schema";

// E-TO and the migration preflight (Phase 08E-7 review corrections; plan J.6) on disposable PostgreSQL 17:
//   * preflight refuses a schema migrated only through 0007 (0008 adds no table), and a schema missing one 0008 object, before
//     any claim or write; an unknown startup setting (transaction_timeout below PostgreSQL 17) is a configuration refusal;
//   * a T1 that has WRITTEN (session, request, trigger finish) and then outlives a short transaction_timeout: the server ends the
//     session, every uncommitted effect is gone, T0's charged attempt stays, the dead connection is not reused, T2 is recorded on
//     a healthy connection (or, if it is not, the claim waits for its lease), locks are released, a later run creates exactly once;
//   * lock_timeout cancels a BLOCKING advisory acquisition with 55P03, and bounds each wait separately (not the transaction).
// The observed SQLSTATE / driver error of the termination is printed as an observation, never assumed.
// NOT EXECUTED by the author of this change: no isolated PostgreSQL server was configured.

// TEST-ONLY mutation switch: T2 recording disabled at the runtime's queue module (production files are not edited).
const mutate = vi.hoisted(() => ({ noT2: false }));
vi.mock("../bot-runtime/trigger-queue", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../bot-runtime/trigger-queue")>();
  return {
    ...orig,
    recordTriggerFailure: async (...a: Parameters<typeof orig.recordTriggerFailure>) =>
      mutate.noT2 ? false : orig.recordTriggerFailure(...a),
  };
});

const ON = { BOTS_RUNTIME_ENABLED: "true", WHATSAPP_OUTBOUND_ENABLED: "true" };
const states = (error: unknown): string[] => {
  const out: string[] = [];
  for (let e: unknown = error, i = 0; e && typeof e === "object" && i < 6; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") out.push(code);
    e = (e as { cause?: unknown }).cause;
  }
  return out;
};

describe("E-TO and the migration preflight", () => {
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
    try {
      k.releaseAll();
      await kit.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  });
  afterAll(async () => t.close());

  // ------------------------------------------------------------------------------------------------ preflight (review P2)
  describe("migration preflight", () => {
    it("A: a schema migrated only through 0007 is refused (schema_not_ready) before any claim or write", async () => {
      const t07 = await createTestDatabase({ migrate: false });
      try {
        await migrateThrough(t07, "0007_bot_foundation");
        const tables = await t07.pool.query(
          "select to_regclass('public.bot_triggers') is not null ok",
        );
        expect(tables.rows[0].ok).toBe(true); // every table the old check looked for exists at 0007 ...
        const w = botWorkerDatabase({ databaseUrl: t07.url, concurrency: 1 });
        try {
          await expect(preflight(w.db as unknown as DbExecutor)).rejects.toMatchObject({
            code: "schema_not_ready",
          }); // ... yet refused
        } finally {
          await w.close();
        }
        const migrations = (
          await t07.pool.query("select count(*)::int n from drizzle.__drizzle_migrations")
        ).rows[0].n;
        const code = await runBotWorker({
          env: { ...ON, DATABASE_URL: t07.url },
          signal: new AbortController().signal,
          print: () => undefined,
          shutdownGraceMs: 10_000,
        });
        expect(code).toBe(EXIT_REFUSED);
        expect((await t07.pool.query("select count(*)::int n from bot_triggers")).rows[0].n).toBe(
          0,
        );
        expect(
          (await t07.pool.query("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0]
            .n,
        ).toBe(migrations);
      } finally {
        await t07.close();
      }
    });

    it("B: the fully migrated schema passes preflight; its real catalog facts satisfy the structural judge exactly", async () => {
      const w = botWorkerDatabase({ databaseUrl: t.url, concurrency: 1 });
      try {
        const facts = await readSchemaFacts(w.db as unknown as DbExecutor);
        expect(schemaProblems(facts)).toEqual([]);
        await expect(preflight(w.db as unknown as DbExecutor)).resolves.toBeUndefined();
      } finally {
        await w.close();
      }
    });

    /**
     * A disposable, fully migrated database with ONE structural defect and a real PENDING trigger: preflight is refused, the
     * worker refuses to start (exit 2) before T0, and the trigger is untouched (no claim, no attempt, no write).
     */
    async function refusedWith(defect: readonly string[], problem: string) {
      const db2 = await createTestDatabase();
      try {
        const k2 = runtimeKit(db2);
        const f = await k2.fixture();
        const tr = await k2.trigger(f, { first: true });
        for (const ddl of defect) await db2.pool.query(ddl);
        const before = await triggerRow(db2, tr.id);
        const w = botWorkerDatabase({ databaseUrl: db2.url, concurrency: 1 });
        try {
          expect(schemaProblems(await readSchemaFacts(w.db as unknown as DbExecutor))).toEqual([
            problem,
          ]);
          await expect(preflight(w.db as unknown as DbExecutor)).rejects.toMatchObject({
            code: "schema_not_ready",
          });
        } finally {
          await w.close();
        }
        const code = await runBotWorker({
          env: { ...ON, DATABASE_URL: db2.url },
          signal: new AbortController().signal,
          print: () => undefined,
          shutdownGraceMs: 10_000,
        });
        expect(code).toBe(EXIT_REFUSED);
        expect(await triggerRow(db2, tr.id)).toEqual(before); // no T0: not claimed, not charged
        expect(before).toMatchObject({ status: "PENDING", attempts: 0, claim_token: null });
        expect(await k2.botRequests(f)).toHaveLength(0);
      } finally {
        await db2.close();
      }
    }

    it("C: the outbound allocation trigger missing (its function still exists) is refused", () =>
      refusedWith(
        ["drop trigger outbound_requests_allocate_control_seq_trg on outbound_requests"],
        "trigger outbound_requests_allocate_control_seq_trg",
      ));

    it("D: the conversation-event allocation trigger DISABLED is refused", () =>
      refusedWith(
        [
          "alter table conversation_events disable trigger conversation_events_allocate_control_seq_trg",
        ],
        "trigger conversation_events_allocate_control_seq_trg",
      ));

    it("E: the derived-key constraint replaced by a same-name constraint on ANOTHER table is refused", () =>
      refusedWith(
        [
          "alter table outbound_requests drop constraint outbound_requests_bot_key_check",
          "alter table conversation_events add constraint outbound_requests_bot_key_check check (true)",
        ],
        "constraint outbound_requests_bot_key_check",
      ));

    it("F1: a same-name in-flight index whose predicate covers every BOT state is refused", () =>
      refusedWith(
        [
          "drop index outbound_requests_bot_inflight_uidx",
          "create unique index outbound_requests_bot_inflight_uidx on outbound_requests (organization_id, bot_session_id) where origin = 'BOT'",
        ],
        "index outbound_requests_bot_inflight_uidx",
      ));

    it("F2: a same-name in-flight index that is not unique is refused", () =>
      refusedWith(
        [
          "drop index outbound_requests_bot_conv_inflight_uidx",
          "create index outbound_requests_bot_conv_inflight_uidx on outbound_requests (organization_id, conversation_id) where origin = 'BOT' and state in ('QUEUED', 'SENDING')",
        ],
        "index outbound_requests_bot_conv_inflight_uidx",
      ));

    it("G: the hold-code function replaced by an incompatible overload (text, text) is refused", () =>
      refusedWith(
        [
          "drop function bot_request_hold_code(uuid, uuid)",
          "create function bot_request_hold_code(p_organization_id text, p_request_id text) returns text language sql stable as $$ select null::text $$",
        ],
        "function bot_request_hold_code(p_organization_id uuid, p_request_id uuid)",
      ));

    it("D: a startup setting the server does not accept (as transaction_timeout below 17) is a configuration refusal, not a five-minute outage", async () => {
      const started = Date.now();
      const code = await runBotWorker({
        env: { ...ON, DATABASE_URL: t.url },
        signal: new AbortController().signal,
        print: () => undefined,
        createDatabase: () =>
          createWorkerDatabase(t.url, {
            maxConnections: 2,
            applicationName: "al-ict-bots-badsetting",
            onPoolError: () => undefined,
            sessionSettings: { ...SESSION_SETTINGS, transaction_timeout_unknown: "25s" },
          }),
        shutdownGraceMs: 10_000,
      });
      expect(code).toBe(EXIT_REFUSED);
      expect(Date.now() - started).toBeLessThan(15_000);
    });
  });

  // ------------------------------------------------------------------------------------------------ E-TO post-write
  type Watched = {
    processID?: number | null;
    on(e: "error", l: (err: { code?: string; message?: string }) => void): unknown;
  };

  /**
   * A WAITING_FOR_INPUT session and a claimed reply to its prompt (T0 committed: attempt 1). Applying the reply in T1 writes an
   * INPUT_ACCEPTED event, the next prompt's request, the session update and the trigger finish. A short pool
   * (transaction_timeout 2 s) whose acquired clients are watched for their server errors.
   */
  async function timedOutReply(db: (short: ReturnType<typeof createWorkerDatabase>) => DbExecutor) {
    const f = await k.fixture();
    const { session } = await k.acceptedPrompt(f);
    await k.reconcile(session);
    const s = await k.session(session.id as string);
    const tap = await k.replyTrigger(f, s.awaiting_token as string, "a");
    const claim = await k.claimOf(tap.id);
    expect(claim.attempts).toBe(1);
    const before = {
      session: await k.sessionJson(s.id as string),
      requests: (await k.botRequests(f)).map((r) => r.id),
      events: await k.events(s.id as string),
    };
    const short = createWorkerDatabase(t.url, {
      maxConnections: 2,
      applicationName: "al-ict-bots-eto",
      onPoolError: () => undefined,
      sessionSettings: { transaction_timeout: "2s" },
    });
    const clients: Array<{
      pid: number | null;
      errors: Array<{ code?: string; message?: string }>;
    }> = [];
    (
      short.db as unknown as { $client: { on(e: "acquire", l: (c: Watched) => void): void } }
    ).$client.on("acquire", (c) => {
      const rec = {
        pid: c.processID ?? null,
        errors: [] as Array<{ code?: string; message?: string }>,
      };
      clients.push(rec);
      c.on("error", (err) => void rec.errors.push({ code: err.code, message: err.message }));
    });
    let pid = 0;
    let setting = "";
    let inside: Record<string, number> = {};
    const started = Date.now();
    try {
      const summary = await processTrigger(
        db(short),
        claim,
        k.deps({
          hooks: {
            beforeCommit: async (tx) => {
              const r = await tx.execute<Record<string, number | string>>(sql`
                select pg_backend_pid() pid, current_setting('transaction_timeout') setting,
                       (select count(*)::int from bot_session_events where session_id = ${s.id as string} and kind = 'INPUT_ACCEPTED') events,
                       (select count(*)::int from outbound_requests where conversation_id = ${f.w.student.conversation.id} and origin = 'BOT') requests,
                       (select revision from bot_sessions where id = ${s.id as string}) revision,
                       (select count(*)::int from bot_triggers where id = ${tap.id} and status = 'PROCESSED') finished`);
              pid = Number(r.rows[0]!.pid);
              setting = String(r.rows[0]!.setting);
              inside = {
                events: Number(r.rows[0]!.events),
                requests: Number(r.rows[0]!.requests),
                revision: Number(r.rows[0]!.revision),
                finished: Number(r.rows[0]!.finished),
              };
              await new Promise((res) => setTimeout(res, 3_500)); // outlive the 2 s transaction_timeout
            },
          },
        }),
      );
      const elapsed = Date.now() - started;
      const next = (await short.db.execute<{ pid: number }>(sql`select pg_backend_pid() pid`))
        .rows[0]!.pid;
      return { f, s, tap, claim, before, summary, pid, setting, inside, clients, elapsed, next };
    } finally {
      await short.close();
    }
  }
  type Timed = Awaited<ReturnType<typeof timedOutReply>>;

  /** Every T1 effect is gone, T0's attempt stays, the timed-out backend is gone, locks are released, the pool moved on. */
  async function expectRolledBackAndAttributed(x: Timed) {
    // T1 had written before the timeout: the event, the next prompt's request, the session update, the trigger finish
    expect(x.inside).toEqual({
      events: 1,
      requests: 2,
      revision: Number((x.before.session as { revision: number }).revision) + 1,
      finished: 1,
    });
    expect(x.setting).toBe("2s");
    // attribution: THIS backend was ended by the server, after the 2 s bound, and nothing of it remains
    expect(
      (await t.pool.query("select count(*)::int n from pg_stat_activity where pid = $1", [x.pid]))
        .rows[0].n,
    ).toBe(0);
    expect(x.elapsed).toBeGreaterThanOrEqual(2_000);
    const t1 = x.clients.find((c) => c.pid === x.pid);
    expect(t1, "the T1 client was watched").toBeDefined();
    const exposed = t1!.errors;
    process.stdout.write(
      `\n[08E-7] E-TO backend ${x.pid} setting=${x.setting} client errors=${JSON.stringify(exposed)} T2 code=${x.summary.kind === "failed" ? x.summary.errorCode : "-"}\n`,
    );
    // the driver exposes the server's 25P04 on the idle client, or (if the socket closed first) a termination message
    expect(exposed.some((e) => e.code === "25P04" || /terminat/i.test(e.message ?? ""))).toBe(true);
    // rollback: nothing of T1 committed (event, request, session, trigger)
    expect(await k.events(x.s.id as string)).toEqual(x.before.events);
    expect((await k.botRequests(x.f)).map((r) => r.id)).toEqual(x.before.requests);
    expect(await k.sessionJson(x.s.id as string)).toEqual(x.before.session);
    // locks released with the dead session
    expect(
      (
        await t.pool.query("select pg_try_advisory_xact_lock(hashtextextended($1, 0)) ok", [
          `bot-conv:${x.f.w.org.id}:${x.f.w.student.conversation.id}`,
        ])
      ).rows[0].ok,
    ).toBe(true);
    expect(
      (await t.pool.query("select 1 from bot_triggers where id = $1 for update nowait", [x.tap.id]))
        .rows,
    ).toHaveLength(1);
    // the dead connection is never reused
    expect(x.next).not.toBe(x.pid);
  }

  it("E-TO A (healthy T2): T1 written then timed out rolls back entirely; T2 RECORDS the failure on a healthy connection; one attempt; a later run applies the reply once", async () => {
    const x = await timedOutReply((short) => short.db as unknown as DbExecutor);
    expect(x.summary.kind).toBe("failed");
    if (x.summary.kind !== "failed") return;
    expect(x.summary.recorded).toBe(true); // required in this controlled scenario
    await expectRolledBackAndAttributed(x);
    // T2 ran on ANOTHER, live backend of the pool (the terminated one is gone), and its write is there
    const t2 = x.clients.filter((c) => c.pid !== null && c.pid !== x.pid);
    expect(t2.length).toBeGreaterThan(0);
    const row = await triggerRow(t, x.tap.id);
    expect(row).toMatchObject({
      status: "PENDING",
      attempts: 1, // T0's charge, kept once; never charged again
      claim_token: null,
      claimed_at: null,
      last_error_code: x.summary.errorCode,
    });
    const now = (await t.pool.query("select clock_timestamp() now")).rows[0].now as Date;
    const backoff = claimFailureBackoffMs(1, () => 0.5)!;
    const delay = new Date(row.next_attempt_at as Date).getTime() - now.getTime();
    expect(delay).toBeLessThanOrEqual(backoff + 50);
    expect(delay).toBeGreaterThan(backoff - 4_000);
    // a later healthy run applies the reply exactly once
    await makeDue(t, x.tap.id);
    expect(await k.run(x.tap.id)).toMatchObject({ kind: "finished", outcome: "input_accepted" });
    expect(
      (await k.events(x.s.id as string)).filter((e) => e.kind === "INPUT_ACCEPTED"),
    ).toHaveLength(1);
    expect(await k.botRequests(x.f)).toHaveLength(2);
    expect(await triggerRow(t, x.tap.id)).toMatchObject({ status: "PROCESSED", attempts: 2 });
  });

  it("E-TO B (T2 deliberately failed): no false record; the claim stays until its lease expires, then one reclaim applies the reply once", async () => {
    let t2Calls = 0;
    const x = await timedOutReply(
      (short) =>
        ({
          // T1 runs in short's transactions; T2 (a single statement on the executor) fails, as if the database were down
          transaction: short.db.transaction.bind(short.db),
          execute: async () => {
            t2Calls++;
            throw Object.assign(new Error("connection refused"), { code: "08006" });
          },
        }) as unknown as DbExecutor,
    );
    expect(x.summary).toMatchObject({ kind: "failed", recorded: false });
    expect(t2Calls).toBe(1);
    await expectRolledBackAndAttributed(x);
    const row = await triggerRow(t, x.tap.id);
    expect(row).toMatchObject({
      status: "PENDING",
      attempts: 1,
      claim_token: x.claim.claimToken,
      last_error_code: null,
    });
    expect((await claimTriggers(t.db as unknown as DbExecutor, 50)).map((c) => c.id)).not.toContain(
      x.tap.id,
    ); // lease protects it
    await expireClaim(t, x.tap.id);
    expect(await k.run(x.tap.id)).toMatchObject({ kind: "finished", outcome: "input_accepted" });
    expect(
      (await k.events(x.s.id as string)).filter((e) => e.kind === "INPUT_ACCEPTED"),
    ).toHaveLength(1);
    expect(await k.botRequests(x.f)).toHaveLength(2);
    expect(await triggerRow(t, x.tap.id)).toMatchObject({ status: "PROCESSED", attempts: 2 });
  });

  it("MUTATION (T2 recording disabled): the healthy scenario reports recorded=false and keeps the claim, so scenario A's requirement fails", async () => {
    mutate.noT2 = true;
    try {
      const x = await timedOutReply((short) => short.db as unknown as DbExecutor);
      expect(x.summary).toMatchObject({ kind: "failed", recorded: false });
      expect((await triggerRow(t, x.tap.id)).claim_token).toBe(x.claim.claimToken);
    } finally {
      mutate.noT2 = false;
    }
  });

  // ------------------------------------------------------------------------------------------------ lock_timeout
  describe("lock_timeout on a BLOCKING advisory acquisition (the runtime itself only uses try-locks)", () => {
    const key = (n: string) => `eto-lock:${n}:${Date.now()}`;
    const acquire = (
      tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
      k1: string,
    ) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${k1}, 0))`);

    it("a wait longer than lock_timeout is cancelled with 55P03", async () => {
      const k1 = key("a");
      const holder = await kit.hold("select pg_advisory_xact_lock(hashtextextended($1, 0))", [k1]);
      const started = Date.now();
      const failed = await t.db
        .transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '1s'`);
          await acquire(tx, k1);
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      const elapsed = Date.now() - started;
      await holder.release();
      expect(states(failed)).toContain("55P03");
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(5_000);
    });

    it("two consecutive waits, each shorter than lock_timeout, both succeed although together they exceed it", async () => {
      const k1 = key("b1");
      const k2 = key("b2");
      const h1 = await kit.hold("select pg_advisory_xact_lock(hashtextextended($1, 0))", [k1]);
      const h2 = await kit.hold("select pg_advisory_xact_lock(hashtextextended($1, 0))", [k2]);
      const started = Date.now();
      const waiter = kit.settle(
        t.db.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '1s'`);
          await acquire(tx, k1);
          await acquire(tx, k2);
        }),
      );
      await kit.waitUntilBlocked(h1.pid);
      await new Promise((r) => setTimeout(r, 650));
      await h1.release();
      await kit.waitUntilBlocked(h2.pid);
      await new Promise((r) => setTimeout(r, 650));
      await h2.release();
      const r = await waiter;
      expect(r.ok, String((r as { error?: unknown }).error)).toBe(true);
      expect(Date.now() - started).toBeGreaterThan(1_200); // more than the 1 s lock_timeout in total
    });
  });
});
