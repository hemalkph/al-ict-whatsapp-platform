import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import type { DbExecutor } from "@/db/ops/executor";
import {
  TRIGGER_RETENTION_DAYS,
  countExpiredTriggers,
  deleteExpiredTriggers,
  triggerRetentionCutoff,
} from "@/db/ops/bot-trigger-retention";
import { logger } from "@/shared/logging/logger";

// The bots:retention system job (Phase 08F-1; V3.2 K.11 and P 08F, X decision 8, owner decision D-1). For every organization,
// independently and in bounded batches:
//   1. redact terminal bot sessions past the approved period through redact_expired_bot_sessions() (0007, unchanged: the
//      function and the database guard own the 30-day period and the one-way, whole-row-checked redaction);
//   2. delete terminal bot-trigger rows processed at or before now minus 14 days (db/ops/bot-trigger-retention.ts).
// Each batch is ONE statement, committed on its own: a failed batch rolls back only itself, and the job goes on with the next
// organization. Nothing here sends, starts a worker, reads a gate or touches messages, requests, events or conversations.
// It is the ONLY production caller of redact_expired_bot_sessions (static boundary test). A dry run (the default) only counts.

export const RETENTION_BATCH_SIZE = 500;
export const RETENTION_MAX_BATCHES = 20;

export type RetentionOptions = {
  readonly apply: boolean;
  readonly batchSize?: number;
  readonly maxBatches?: number;
};

export type OrganizationRetention = {
  readonly organizationId: string;
  /** Redacted (apply) or eligible now (dry run). Null when that part failed. */
  readonly sessions: number | null;
  readonly triggers: number | null;
  /** True when the batch budget ran out with work possibly left (run again). */
  readonly sessionsRemaining: boolean;
  readonly triggersRemaining: boolean;
  /** SQLSTATE of a failed part (never error text). */
  readonly sessionsError?: string;
  readonly triggersError?: string;
};

export type RetentionReport = {
  readonly dryRun: boolean;
  readonly sessionRedactionAfter: string;
  readonly triggerRetentionDays: number;
  readonly triggerCutoff: string;
  readonly organizations: OrganizationRetention[];
};

const INTERVAL = /^[0-9a-z :.+-]{1,64}$/i;

/** The SQLSTATE of a database error (Drizzle wraps the driver error), or a fixed code. */
function sqlState(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "unknown";
}

async function batches(
  run: () => Promise<number>,
  size: number,
  max: number,
): Promise<{ total: number; remaining: boolean }> {
  let total = 0;
  for (let i = 0; i < max; i++) {
    const n = await run();
    total += n;
    if (n < size) return { total, remaining: false };
  }
  return { total, remaining: true };
}

const redactBatch = async (db: DbExecutor, organizationId: string, limit: number) =>
  (
    await db.execute<{ n: number }>(
      sql`SELECT redact_expired_bot_sessions(${organizationId}::uuid, ${limit}) AS n`,
    )
  ).rows[0]!.n;

const countEligibleSessions = async (db: DbExecutor, organizationId: string) =>
  (
    await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM bot_sessions
       WHERE organization_id = ${organizationId}::uuid
         AND state IN ('COMPLETED', 'HANDED_OVER', 'FAILED') AND redacted_at IS NULL
         AND ended_at <= clock_timestamp() - bot_session_redaction_after()`)
  ).rows[0]!.n;

export async function runRetention(
  db: DbExecutor,
  options: RetentionOptions,
): Promise<RetentionReport> {
  const size = options.batchSize ?? RETENTION_BATCH_SIZE;
  const max = options.maxBatches ?? RETENTION_MAX_BATCHES;
  if (!Number.isSafeInteger(size) || size < 1 || size > 10_000)
    throw new RangeError("batchSize must be an integer in 1..10000");
  if (!Number.isSafeInteger(max) || max < 1 || max > 1_000)
    throw new RangeError("maxBatches must be an integer in 1..1000");

  const policy = (
    await db.execute<{ i: string }>(sql`SELECT bot_session_redaction_after()::text AS i`)
  ).rows[0]!.i;
  const interval = INTERVAL.test(policy) ? policy : "invalid";
  const cutoff = await triggerRetentionCutoff(db);
  const orgs = (
    await db.execute<{ id: string }>(sql`SELECT id FROM organizations ORDER BY id`)
  ).rows.map((r) => r.id);

  const organizations: OrganizationRetention[] = [];
  for (const organizationId of orgs) {
    let sessions: number | null = null;
    let triggers: number | null = null;
    let sessionsRemaining = false;
    let triggersRemaining = false;
    let sessionsError: string | undefined;
    let triggersError: string | undefined;
    try {
      if (options.apply) {
        const r = await batches(() => redactBatch(db, organizationId, size), size, max);
        sessions = r.total;
        sessionsRemaining = r.remaining;
        logger.info("bots.sessions_redacted", {
          bots_event: "bots.sessions_redacted",
          outcome: "success",
          organization_id: organizationId,
          count: sessions,
          interval,
        });
      } else sessions = await countEligibleSessions(db, organizationId);
    } catch (error) {
      sessionsError = sqlState(error);
      logger.warn("bots.sessions_redacted", {
        bots_event: "bots.sessions_redacted",
        outcome: "failure",
        organization_id: organizationId,
        reason: `sqlstate_${sessionsError.toLowerCase()}`,
        count: sessions ?? undefined,
      });
    }
    try {
      if (options.apply) {
        const r = await batches(
          () => deleteExpiredTriggers(db, { organizationId, cutoff, limit: size }),
          size,
          max,
        );
        triggers = r.total;
        triggersRemaining = r.remaining;
        logger.info("bots.triggers_deleted", {
          bots_event: "bots.triggers_deleted",
          outcome: "success",
          organization_id: organizationId,
          count: triggers,
          retention_days: TRIGGER_RETENTION_DAYS,
        });
      } else triggers = await countExpiredTriggers(db, { organizationId, cutoff });
    } catch (error) {
      triggersError = sqlState(error);
      logger.warn("bots.triggers_deleted", {
        bots_event: "bots.triggers_deleted",
        outcome: "failure",
        organization_id: organizationId,
        reason: `sqlstate_${triggersError.toLowerCase()}`,
      });
    }
    organizations.push({
      organizationId,
      sessions,
      triggers,
      sessionsRemaining,
      triggersRemaining,
      ...(sessionsError ? { sessionsError } : {}),
      ...(triggersError ? { triggersError } : {}),
    });
  }
  return {
    dryRun: !options.apply,
    sessionRedactionAfter: interval,
    triggerRetentionDays: TRIGGER_RETENTION_DAYS,
    triggerCutoff: cutoff,
    organizations,
  };
}

export const RETENTION_EXIT = { OK: 0, PARTIAL_FAILURE: 1, USAGE: 2 } as const;

/** `bots:retention [--apply]`: prints ONE JSON document; exit 1 when any organization's part failed. */
export async function runRetentionCli(
  argv: string[],
  db: DbExecutor,
  out: (value: unknown) => void,
): Promise<number> {
  let apply: boolean;
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: { apply: { type: "boolean" } },
    });
    apply = values.apply === true;
  } catch {
    out({
      ok: false,
      problem: "unknown or malformed option",
      usage: "bots:retention [--apply]",
      note: "a dry run (counts only) unless --apply is given",
    });
    return RETENTION_EXIT.USAGE;
  }
  const report = await runRetention(db, { apply });
  const failed = report.organizations.some((o) => o.sessionsError || o.triggersError);
  out({ ok: !failed, ...report });
  return failed ? RETENTION_EXIT.PARTIAL_FAILURE : RETENTION_EXIT.OK;
}
