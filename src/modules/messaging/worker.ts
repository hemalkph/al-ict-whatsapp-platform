import { sql } from "drizzle-orm";
import { createWorkerDatabase, type WorkerDatabase } from "@/db";
import { sqlState } from "@/modules/whatsapp/ingest";
import { emitWebhookLog } from "@/modules/whatsapp/logging";
import { readOutboundConfig, type OutboundConfig } from "./config";
import { dispatchBatch, type BatchSummary, type DispatchDeps } from "./dispatch";
import {
  HTTP_TIMEOUT_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
} from "./policy";
import type { OutboundTransport } from "./transport";

// The standalone outbound worker. DISABLED BY DEFAULT and never started by the web application, the build, a migration or a
// test. It refuses to start unless BOTH gates are exactly "true" (WHATSAPP_OUTBOUND_ENABLED and WHATSAPP_LIVE_SEND_ENABLED),
// and the HTTP transport checks the same gates again on every request. Started only by `npm run whatsapp:outbound-worker`.
//
// Failure model, deliberately different from the inbound worker: a failed poll is retried with a backoff (the worker's own
// database trouble) but an individual REQUEST is never retried by this loop; its fate is decided by dispatch.ts.

export const EXIT_STOPPED = 0;
export const EXIT_FATAL = 1;
export const EXIT_REFUSED = 2;

const IDLE = { base: 500, max: 5_000 };
const OUTAGE = { base: 1_000, max: 30_000, giveUpMs: 5 * 60_000 };
const SHUTDOWN_GRACE_MS = HTTP_TIMEOUT_MS + 15_000;
const jitter = (ms: number, random: () => number) =>
  Math.round(ms * (0.8 + 0.4 * Math.min(Math.max(random(), 0), 1)));
export const idleDelay = (n: number, random: () => number) =>
  Math.min(jitter(Math.min(IDLE.base * 2 ** Math.max(n - 1, 0), IDLE.max), random), IDLE.max);
export const outageDelay = (n: number, random: () => number) =>
  Math.min(jitter(Math.min(OUTAGE.base * 2 ** Math.max(n - 1, 0), OUTAGE.max), random), OUTAGE.max);

type Env = Record<string, string | undefined>;
export type WorkerConfig = {
  databaseUrl: string;
  batchSize: number;
  concurrency: number;
  outbound: OutboundConfig;
};

function int(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= max ? n : null;
}

/** Pure. `requireLiveGate` is false only when a test injects its own (fake) transport. */
export function readWorkerConfig(
  env: Env,
  requireLiveGate: boolean,
): { kind: "ready"; config: WorkerConfig } | { kind: "refused"; problems: string[] } {
  const outbound = readOutboundConfig(env);
  const problems: string[] = [];
  if (!outbound.outboundEnabled) problems.push("WHATSAPP_OUTBOUND_ENABLED (must be exactly true)");
  if (requireLiveGate && !outbound.liveSendEnabled)
    problems.push("WHATSAPP_LIVE_SEND_ENABLED (must be exactly true)");
  let databaseUrl = "";
  try {
    const url = new URL(env.DATABASE_URL ?? "");
    if (!/^postgres(ql)?:$/.test(url.protocol) || url.hostname === "" || url.pathname.length <= 1)
      throw new Error();
    databaseUrl = env.DATABASE_URL as string;
  } catch {
    problems.push("DATABASE_URL (missing or not a postgres connection URL)");
  }
  const batchSize = int(env.WHATSAPP_OUTBOUND_BATCH_SIZE, DEFAULT_BATCH_SIZE, 100);
  if (batchSize === null) problems.push("WHATSAPP_OUTBOUND_BATCH_SIZE (integer 1 to 100)");
  const concurrency = int(env.WHATSAPP_OUTBOUND_CONCURRENCY, DEFAULT_CONCURRENCY, MAX_CONCURRENCY);
  if (concurrency === null)
    problems.push(`WHATSAPP_OUTBOUND_CONCURRENCY (integer 1 to ${MAX_CONCURRENCY})`);
  if (problems.length > 0 || batchSize === null || concurrency === null)
    return { kind: "refused", problems };
  return { kind: "ready", config: { databaseUrl, batchSize, concurrency, outbound } };
}

const REQUIRED_TABLES = [
  "outbound_requests",
  "whatsapp_templates",
  "messages",
  "conversations",
  "whatsapp_accounts",
  "contacts",
  "contact_bsuids",
  "message_status_events",
];

export type RunOptions = {
  readonly env: Env;
  readonly signal: AbortSignal;
  readonly print?: (message: string) => void;
  /** Production passes a MetaTransport. Tests pass a fake, which makes the live-send gate unnecessary for the worker itself. */
  readonly transport: OutboundTransport;
  readonly injectedTransport?: boolean;
  readonly createDatabase?: (config: WorkerConfig) => WorkerDatabase;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => Date;
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

function classify(error: unknown): "configuration" | "transient" {
  const state = sqlState(error);
  if (state && ["28000", "28P01", "3D000", "42P01", "42703", "42501"].includes(state))
    return "configuration";
  return "transient";
}

export async function runOutboundWorker(options: RunOptions): Promise<number> {
  const print = options.print ?? ((m: string) => console.error(m));
  const read = readWorkerConfig(options.env, !options.injectedTransport);
  if (read.kind === "refused") {
    print(
      `The outbound worker did not start: ${read.problems.join("; ")}. Nothing was claimed or sent.`,
    );
    return EXIT_REFUSED;
  }
  const { config } = read;
  const database = (
    options.createDatabase ??
    ((c) =>
      createWorkerDatabase(c.databaseUrl, {
        maxConnections: c.concurrency + 2,
        applicationName: "al-ict-outbound-worker",
        onPoolError: () =>
          emitWebhookLog({
            event: "outbound.worker_database_unavailable",
            outcome: "failure",
            reason: "idle_client_error",
          }),
      }))
  )(config);
  const deps: DispatchDeps = {
    db: database.db,
    transport: options.transport,
    config: config.outbound,
    now: options.now,
  };
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? sleepUnlessAborted;
  const { signal } = options;
  emitWebhookLog({ event: "outbound.worker_started", outcome: "success" });

  const totals: BatchSummary = {
    claimed: 0,
    accepted: 0,
    rejected: 0,
    retryScheduled: 0,
    unknown: 0,
    held: 0,
    recoveredUnknown: 0,
    fenceLost: 0,
  };
  const loop = (async (): Promise<"stopped" | "configuration" | "outage"> => {
    let ready = false;
    let empty = 0;
    let failures = 0;
    let since: number | null = null;
    while (!signal.aborted) {
      try {
        if (!ready) {
          await database.db.execute(sql`SELECT 1`);
          const missing = await database.db.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM unnest(${sql.raw(`ARRAY[${REQUIRED_TABLES.map((x) => `'${x}'`).join(",")}]::text[]`)}) AS t(name) WHERE to_regclass(format('public.%I', t.name)) IS NULL`,
          );
          if ((missing.rows[0]?.n ?? 1) > 0) {
            emitWebhookLog({
              event: "outbound.worker_fatal",
              outcome: "failure",
              reason: "schema_not_ready",
            });
            return "configuration";
          }
          ready = true;
        }
        const batch = await dispatchBatch(deps, {
          batchSize: config.batchSize,
          concurrency: config.concurrency,
          stopSignal: signal,
        });
        for (const k of Object.keys(totals) as (keyof BatchSummary)[]) totals[k] += batch[k];
        failures = 0;
        since = null;
        if (batch.claimed === 0 && batch.held === 0) {
          empty++;
          await sleep(idleDelay(empty, random), signal);
        } else empty = 0;
      } catch (error) {
        if (classify(error) === "configuration") {
          emitWebhookLog({
            event: "outbound.worker_fatal",
            outcome: "failure",
            reason: "database_configuration",
          });
          return "configuration";
        }
        failures++;
        since ??= Date.now();
        if (Date.now() - since >= OUTAGE.giveUpMs) {
          emitWebhookLog({
            event: "outbound.worker_fatal",
            outcome: "failure",
            reason: "outage_limit_reached",
          });
          return "outage";
        }
        emitWebhookLog({
          event: "outbound.worker_database_unavailable",
          outcome: "failure",
          reason: "poll_failed",
          counts: { consecutiveFailures: failures },
        });
        await sleep(outageDelay(failures, random), signal);
      }
    }
    return "stopped";
  })();

  let deadline: NodeJS.Timeout | undefined;
  const expired = new Promise<"deadline">((resolve) => {
    const arm = () => {
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
    emitWebhookLog({
      event: "outbound.worker_fatal",
      outcome: "failure",
      reason: "shutdown_deadline",
    });
    void database.close().catch(() => undefined);
    return EXIT_FATAL; // an in-flight send stays SENDING and is declared UNKNOWN_OUTCOME by recovery; it is never re-sent
  }
  await database.close().catch(() => undefined);
  emitWebhookLog({
    event: "outbound.worker_stopped",
    outcome: result === "stopped" ? "success" : "failure",
    reason: result,
    counts: {
      claimed: totals.claimed,
      processed: totals.accepted,
      failed: totals.rejected,
      dead: totals.unknown,
      held: totals.held,
    },
  });
  return result === "stopped"
    ? EXIT_STOPPED
    : result === "configuration"
      ? EXIT_REFUSED
      : EXIT_FATAL;
}
