import { sql } from "drizzle-orm";
import { createWorkerDatabase, type WorkerDatabase } from "@/db";
import type { DbExecutor } from "@/db/ops/executor";
import { emitBotRuntimeLog } from "@/modules/bot-runtime";
import { sweepOnce } from "@/modules/bot-runtime/reconcile";
import { processTrigger } from "@/modules/bot-runtime/step";
import { claimTriggers } from "@/modules/bot-runtime/trigger-queue";
import { productionStepDeps } from "./compose";
import { readBotWorkerConfig, type BotWorkerConfig } from "./config";
import { WorkerPreflightError } from "./errors";
import { readSchemaFacts, schemaProblems } from "./schema";
import { runSweepLoop, runTriggerLoop, type LoopExit } from "./loops";
import { MIN_SERVER_VERSION_NUM, poolSize, SESSION_SETTINGS, SHUTDOWN_GRACE_MS } from "./policy";

// The bot worker process (Phase 08E-7; plan J.1, J.6, M). DISABLED BY DEFAULT: it refuses, before opening any connection or
// changing anything, unless BOTS_RUNTIME_ENABLED and WHATSAPP_OUTBOUND_ENABLED are both exactly "true". It never sends: it has
// no transport and never calls Meta; a BOT message can only be queued (by T1, through the approved enqueue path) and is sent,
// if ever, by the separately gated outbound worker. It never runs migrations.
//
// One OWN pool (bounded; transaction_timeout / idle_in_transaction_session_timeout / statement_timeout as startup parameters of
// every connection; dead connections discarded) shared by the trigger loop and the sweeper loop. Preflight refuses PostgreSQL
// below 17, a pool whose settings did not apply, and an unmigrated schema. Graceful shutdown: stop claiming and sweeping, let
// started transactions finish within the server's own bound plus a margin, close the pool; past the grace period exit non-zero
// (the process ends, the server rolls back what is left, leases recover the claims).

export const EXIT_STOPPED = 0;
export const EXIT_FATAL = 1;
export const EXIT_REFUSED = 2;

const REQUIRED_TABLES = [
  "bot_triggers",
  "bot_sessions",
  "bot_session_events",
  "bot_deployments",
  "bot_versions",
  "outbound_requests",
  "conversations",
  "messages",
];

export type RunOptions = {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Abort to begin a graceful shutdown. */
  readonly signal: AbortSignal;
  /** Where explanatory (non-log) messages go. Never receives a value from the environment. */
  readonly print?: (message: string) => void;
  /** Tests only: the pool factory (default: the worker's own pool with SESSION_SETTINGS). */
  readonly createDatabase?: (config: BotWorkerConfig) => WorkerDatabase;
  /** Tests only: timing. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly shutdownGraceMs?: number;
};

const sleepUnlessAborted = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/** J.6 preflight on a pooled connection: PostgreSQL >= 17, the pool's settings in force, the schema migrated. */
export async function preflight(db: DbExecutor): Promise<void> {
  const v = await db.execute<{ v: number }>(
    sql`SELECT current_setting('server_version_num')::int AS v`,
  );
  if (Number(v.rows[0]?.v ?? 0) < MIN_SERVER_VERSION_NUM)
    throw new WorkerPreflightError("server_version_unsupported");
  const s = await db.execute<Record<string, string>>(sql`
    SELECT current_setting('transaction_timeout') AS transaction_timeout,
           current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout,
           current_setting('statement_timeout') AS statement_timeout`);
  for (const [name, value] of Object.entries(SESSION_SETTINGS))
    if (s.rows[0]?.[name] !== value) throw new WorkerPreflightError("session_settings_not_applied");
  const t = await db.execute<{ missing: number }>(sql`
    SELECT count(*)::int AS missing
      FROM unnest(${sql.raw(`ARRAY[${REQUIRED_TABLES.map((x) => `'${x}'`).join(",")}]::text[]`)}) AS t(name)
     WHERE to_regclass(format('public.%I', t.name)) IS NULL`);
  if ((t.rows[0]?.missing ?? 1) > 0) throw new WorkerPreflightError("schema_not_ready");
  // Migration 0008 (BOT dispatch) adds no table, so table checks alone accept a 0007 schema: verify its objects structurally.
  if (schemaProblems(await readSchemaFacts(db)).length > 0)
    throw new WorkerPreflightError("schema_not_ready");
}

export async function runBotWorker(options: RunOptions): Promise<number> {
  const print = options.print ?? ((message: string) => console.error(message));
  const read = readBotWorkerConfig(options.env);
  if (read.kind !== "ready") {
    print(
      read.kind === "refused"
        ? `The bot worker is disabled: ${read.problems.join("; ")}. Nothing was claimed or changed.`
        : `Invalid bot worker configuration: ${read.problems.join("; ")}. Nothing was claimed or changed.`,
    );
    return EXIT_REFUSED;
  }
  const { config } = read;
  const database = (options.createDatabase ?? botWorkerDatabase)(config);
  const db = database.db as unknown as DbExecutor;
  const stepDeps = productionStepDeps(options.env);
  const sleep = options.sleep ?? sleepUnlessAborted;
  const timing = { sleep, now: () => Date.now(), random: Math.random };

  // One internal stop signal: the operator's, or either loop ending fatally (then the other loop stops too).
  const stop = new AbortController();
  const onStop = () => stop.abort();
  if (options.signal.aborted) stop.abort();
  else options.signal.addEventListener("abort", onStop, { once: true });

  let ready: Promise<void> | null = null;
  const preflightOnce = () => {
    ready ??= preflight(db).catch((error: unknown) => {
      ready = null; // retried (and classified) on the next iteration
      throw error;
    });
    return ready;
  };

  emitBotRuntimeLog({
    event: "bots.worker_started",
    outcome: "success",
    count: config.concurrency,
  });
  const stopOnFatal = <T extends { exit: LoopExit }>(r: T) => {
    if (r.exit !== "stopped") stop.abort();
    return r;
  };
  const loops = Promise.all([
    runTriggerLoop(
      {
        ...timing,
        preflight: preflightOnce,
        claim: (limit) => claimTriggers(db, limit),
        process: (claim) => processTrigger(db, claim, stepDeps),
        concurrency: config.concurrency,
      },
      stop.signal,
    ).then(stopOnFatal),
    runSweepLoop(
      { ...timing, preflight: preflightOnce, sweep: () => sweepOnce(db, stepDeps) },
      stop.signal,
    ).then(stopOnFatal),
  ]);

  // ONE deadline covers the whole shutdown: the loops settling AND the pool closing. A close that rejects is a failure; a close
  // that never settles is cut off by the deadline (the script then exits; the server rolls back and releases every lock).
  let closing: Promise<void> | null = null;
  const close = () => (closing ??= database.close());
  const shutdown = loops.then(async (r) => {
    try {
      await close();
      return { loops: r, closed: true };
    } catch {
      return { loops: r, closed: false };
    }
  });
  let deadline: NodeJS.Timeout | undefined;
  const expired = new Promise<"deadline">((resolve) => {
    const arm = () => {
      emitBotRuntimeLog({ event: "bots.worker_stopping", outcome: "success" });
      deadline = setTimeout(
        () => resolve("deadline"),
        options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS,
      );
    };
    if (stop.signal.aborted) arm();
    else stop.signal.addEventListener("abort", arm, { once: true });
  });
  const result = await Promise.race([shutdown, expired]);
  clearTimeout(deadline);
  options.signal.removeEventListener("abort", onStop);

  if (result === "deadline") {
    emitBotRuntimeLog({
      event: "bots.worker_fatal",
      outcome: "failure",
      reason: "shutdown_deadline",
    });
    void close().catch(() => undefined); // best effort; the exit does not wait for it
    return EXIT_FATAL;
  }
  if (!result.closed) {
    emitBotRuntimeLog({
      event: "bots.worker_fatal",
      outcome: "failure",
      reason: "pool_close_failed",
    });
    return EXIT_FATAL;
  }
  const [triggers, sweeper] = result.loops;
  const exits = [triggers.exit, sweeper.exit];
  const exit: LoopExit = exits.includes("configuration")
    ? "configuration"
    : exits.includes("outage_limit")
      ? "outage_limit"
      : "stopped";
  emitBotRuntimeLog({
    event: "bots.worker_stopped",
    outcome: exit === "stopped" ? "success" : "failure",
    reason: exit,
    count: triggers.totals.claimed,
  });
  if (exit === "stopped") return EXIT_STOPPED;
  return exit === "configuration" ? EXIT_REFUSED : EXIT_FATAL;
}

/** The worker's own pool (exported for its database tests, which must exercise the real settings). */
export function botWorkerDatabase(config: BotWorkerConfig): WorkerDatabase {
  return createWorkerDatabase(config.databaseUrl, {
    maxConnections: poolSize(config.concurrency),
    applicationName: "al-ict-bots-worker",
    sessionSettings: SESSION_SETTINGS,
    onPoolError: () =>
      emitBotRuntimeLog({
        event: "bots.database_unavailable",
        outcome: "failure",
        reason: "idle_client_error",
      }),
  });
}
