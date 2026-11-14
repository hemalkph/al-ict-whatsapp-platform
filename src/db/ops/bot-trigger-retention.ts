import { sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "./executor";

// Terminal bot-trigger retention (Phase 08F-1; V3.2 X decision 8, owner decision D-1 of 2026-10-26): a terminal trigger row
// (PROCESSED, IGNORED or DEAD) whose processed_at is at or before the cutoff may be deleted, in bounded, organization-scoped
// batches. Only the bots:retention job calls this.
//
// Why a terminal row is safe to delete: every writer of bot_triggers fences on status = 'PENDING' (the trigger queue primitives), so a
// terminal row is never written again; no foreign key references bot_triggers; first_message reads message headers and the
// session history, never triggers; and a redelivered message is refused by the inbound handler's duplicate check before any
// write, so a deleted trigger is never captured again.
//
// The approved period is a floor INSIDE the statement: whatever cutoff a caller passes, nothing younger than 14 days (database
// clock) matches. Rows another transaction holds are skipped (SKIP LOCKED); the statement waits on no row.

/** The approved period (D-1). Changing it is a reviewed code change. */
export const TRIGGER_RETENTION_DAYS = 14;
/** Upper bound of one batch. */
export const TRIGGER_RETENTION_BATCH_MAX = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type TriggerRetentionParams = {
  readonly organizationId: string;
  /** A timestamptz read from the database (text); the statement never deletes anything younger than the approved period. */
  readonly cutoff: string;
  readonly limit: number;
};

function checked(p: TriggerRetentionParams) {
  if (!UUID.test(p.organizationId)) throw new TypeError("organizationId must be a UUID");
  if (typeof p.cutoff !== "string" || p.cutoff.length === 0 || p.cutoff.length > 64)
    throw new TypeError("cutoff must be a database timestamp");
  if (!Number.isSafeInteger(p.limit) || p.limit < 1 || p.limit > TRIGGER_RETENTION_BATCH_MAX)
    throw new RangeError(`limit must be an integer in 1..${TRIGGER_RETENTION_BATCH_MAX}`);
  return p;
}

const eligible = (p: TriggerRetentionParams): SQL => sql`
       t.organization_id = ${p.organizationId}
   AND t.status IN ('PROCESSED', 'IGNORED', 'DEAD')
   AND t.claim_token IS NULL
   AND t.processed_at IS NOT NULL
   AND t.processed_at <= LEAST(${p.cutoff}::timestamptz, clock_timestamp() - ${TRIGGER_RETENTION_DAYS} * interval '1 day')`;

/** The database cutoff for one run: now minus the approved period. */
export async function triggerRetentionCutoff(db: DbExecutor): Promise<string> {
  const r = await db.execute<{ cutoff: string }>(
    sql`SELECT (clock_timestamp() - ${TRIGGER_RETENTION_DAYS} * interval '1 day')::text AS cutoff`,
  );
  return r.rows[0]!.cutoff;
}

/** One batch, ONE statement (its own transaction on a pool): deletes at most `limit` eligible rows and returns how many. */
export function deleteExpiredTriggersSql(params: TriggerRetentionParams): SQL {
  const p = checked(params);
  return sql`
    WITH c AS (
      SELECT t.id FROM bot_triggers t
       WHERE ${eligible(p)}
       ORDER BY t.processed_at, t.id
       LIMIT ${p.limit}
       FOR UPDATE SKIP LOCKED)
    DELETE FROM bot_triggers d USING c
     WHERE d.organization_id = ${p.organizationId} AND d.id = c.id
    RETURNING d.id`;
}

export async function deleteExpiredTriggers(
  db: DbExecutor,
  p: TriggerRetentionParams,
): Promise<number> {
  return (await db.execute(deleteExpiredTriggersSql(p))).rows.length;
}

/** Read-only count of what a run would delete now (dry run). */
export async function countExpiredTriggers(
  db: DbExecutor,
  p: Omit<TriggerRetentionParams, "limit">,
): Promise<number> {
  const r = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM bot_triggers t WHERE ${eligible(checked({ ...p, limit: 1 }))}`,
  );
  return r.rows[0]!.n;
}
