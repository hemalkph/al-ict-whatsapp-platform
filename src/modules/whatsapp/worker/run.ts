import { createWorkerDatabase, type WorkerDatabase } from "@/db";
import { sql } from "drizzle-orm";
import { emitWebhookLog } from "../logging";
import { processWebhookBatch, type WebhookHandlerRegistry } from "../queue/process";
import { LEASE_SECONDS } from "../queue/policy";
import { readQueueStats } from "../queue/stats";
import { SchemaNotReadyError } from "./errors";
import { readWorkerConfig, type WorkerConfig } from "./config";
import { runWorkerLoop } from "./loop";
import { SHUTDOWN_GRACE_MS } from "./policy";
import { webhookWorkerHandlers } from "./registry";

// Process-level orchestration of the standalone WhatsApp worker: validate configuration, open ITS OWN bounded connection
// pool, verify the database is migrated, poll until told to stop, close the pool. It never calls Meta, never sends
// anything, never runs migrations and never starts unless WHATSAPP_WORKER_ENABLED is exactly "true".

export const EXIT_STOPPED = 0;
export const EXIT_FATAL = 1;
export const EXIT_REFUSED = 2;

/** The tables the registered handlers read and write. Existence only; the migrations themselves are never run here. */
const REQUIRED_TABLES = [
  "webhook_events",
  "whatsapp_accounts",
  "contacts",
  "contact_bsuids",
  "conversations",
  "messages",
  "message_attachments",
  "message_status_events",
  "lead_attributions",
];

export type RunOptions = {
  env: Record<string, string | undefined>;
  /** Abort to begin a graceful shutdown. */
  signal: AbortSignal;
  /** Where explanatory (non-log) messages go. Never receives a value from the environment. */
  print?: (message: string) => void;
  /** Tests only. */
  createDatabase?: (config: WorkerConfig) => WorkerDatabase;
  handlers?: WebhookHandlerRegistry;
  shutdownGraceMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
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

async function assertSchemaReady(db: WorkerDatabase["db"]): Promise<void> {
  const result = await db.execute<{ missing: number }>(sql`
    SELECT count(*)::int AS missing
    FROM unnest(${sql.raw(`ARRAY[${REQUIRED_TABLES.map((t) => `'${t}'`).join(",")}]::text[]`)}) AS t(name)
    WHERE to_regclass(format('public.%I', t.name)) IS NULL
  `);
  if ((result.rows[0]?.missing ?? 1) > 0) throw new SchemaNotReadyError();
}

export async function runWorker(options: RunOptions): Promise<number> {
  const print = options.print ?? ((message: string) => console.error(message));
  const read = readWorkerConfig(options.env);
  if (read.kind === "disabled") {
    print(
      "The WhatsApp worker is disabled. It starts only when WHATSAPP_WORKER_ENABLED=true is set explicitly. Nothing was claimed or changed.",
    );
    return EXIT_REFUSED;
  }
  if (read.kind === "invalid") {
    print(
      `Invalid worker configuration: ${read.problems.join("; ")}. Nothing was claimed or changed.`,
    );
    return EXIT_REFUSED;
  }
  const { config } = read;
  const handlers = options.handlers ?? webhookWorkerHandlers;
  const database = (options.createDatabase ?? defaultDatabase)(config);
  const { db } = database;
  const { signal } = options;

  emitWebhookLog({ event: "worker.started", outcome: "success" });
  const loop = runWorkerLoop(
    {
      processBatch: () =>
        processWebhookBatch(db, {
          handlers,
          batchSize: config.batchSize,
          concurrency: config.concurrency,
          stopSignal: signal,
        }),
      preflight: async () => {
        await db.execute(sql`SELECT 1`);
        await assertSchemaReady(db);
      },
      readStats: () => readQueueStats(db, LEASE_SECONDS, Object.keys(handlers)),
      sleep: options.sleep ?? sleepUnlessAborted,
      now: () => Date.now(),
      random: Math.random,
    },
    signal,
  );

  // Graceful shutdown: the loop stops claiming at once; in-flight handlers finish within their own budget. Past the
  // grace period the process gives up (non-zero); the leases then expire and another worker reclaims the events.
  let deadline: NodeJS.Timeout | undefined;
  const expired = new Promise<"deadline">((resolve) => {
    const arm = () => {
      emitWebhookLog({ event: "worker.stopping", outcome: "success" });
      deadline = setTimeout(
        () => resolve("deadline"),
        options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS,
      );
    };
    if (signal.aborted) arm();
    else signal.addEventListener("abort", arm, { once: true });
  });
  const result = await Promise.race([loop, expired]);
  clearTimeout(deadline);

  if (result === "deadline") {
    emitWebhookLog({ event: "worker.fatal", outcome: "failure", reason: "shutdown_deadline" });
    void database.close().catch(() => undefined);
    return EXIT_FATAL;
  }
  await database.close().catch(() => undefined);
  emitWebhookLog({
    event: "worker.stopped",
    outcome: result.exit === "stopped" ? "success" : "failure",
    reason: result.exit,
    counts: {
      claimed: result.totals.claimed,
      processed: result.totals.processed,
      failed: result.totals.failed,
      dead: result.totals.dead,
      held: result.totals.held,
      ignored: result.totals.ignored,
      leaseLost: result.totals.leaseLost,
      unrecorded: result.totals.unrecorded,
    },
  });
  if (result.exit === "stopped") return EXIT_STOPPED;
  return result.exit === "configuration" ? EXIT_REFUSED : EXIT_FATAL;
}

function defaultDatabase(config: WorkerConfig): WorkerDatabase {
  return createWorkerDatabase(config.databaseUrl, {
    // one connection per lane, one for claiming/stats, one spare for the heartbeat and preflight
    maxConnections: config.concurrency + 2,
    applicationName: "al-ict-whatsapp-worker",
    onPoolError: () =>
      emitWebhookLog({
        event: "worker.database_unavailable",
        outcome: "failure",
        reason: "idle_client_error",
      }),
  });
}
