import { sql } from "drizzle-orm";
import type { Database } from "@/db";
import { pgCode } from "../errors";
import type { Tx } from "../locks";
import type { ReconcileOptions } from "./config";

// EVERY database interaction of the reconciler runs inside a transaction that sets PostgreSQL's own limits first, so a statement is
// cancelled BY THE DATABASE when it waits too long for a lock or runs too long: not by a JavaScript timer while the SQL carries on.
// The limits are `lock_timeout` (waiting for a lock) and `statement_timeout` (running, lock waits included), both set with
// set_config(..., is_local = true), so they end with the transaction and a pooled connection never keeps them: the next user of the
// connection gets the server's own settings back.
//
// The overall run budget (run.ts) only stops STARTING new work. A statement that is already running is bounded by these two limits
// and either finishes or fails; the worst case for one run is therefore its budget plus the in-flight transaction's statements,
// each of which is bounded.

/**
 * Sets the limits for the current transaction and reads the database clock in the same statement. The returned instant is the
 * database's "now" at the start of the transaction's work: it is the trusted first-consideration time of a touch.
 */
export async function applyTimeouts(tx: Tx, options: ReconcileOptions): Promise<string> {
  const result = await tx.execute<{ t: string }>(
    sql`SELECT set_config('lock_timeout', ${`${options.lockTimeoutMs}ms`}, true),
               set_config('statement_timeout', ${`${options.statementTimeoutMs}ms`}, true),
               clock_timestamp()::text AS t`,
  );
  return result.rows[0]!.t;
}

/** Runs `fn` in one transaction whose statements are all bounded by the reconciler's limits. */
export function bounded<T>(
  db: Database,
  options: ReconcileOptions,
  fn: (tx: Tx, startedAt: string) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => fn(tx, await applyTimeouts(tx, options)));
}

/** True for a limit that PostgreSQL itself enforced: the lock timeout (or NOWAIT), or the statement timeout. */
export function isLimitError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (code === "55P03" || code === "57014") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** True when the failure only means "someone holds a lock I would not wait for": not the touch's fault. */
export const isLockTimeout = (error: unknown) => pgCode(error) === "55P03";
