import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { addContact, addTouch, minutesAgo, world, type World } from "../testing";
import { DEFAULT_OPTIONS, type ReconcileOptions } from "./config";
import { runReconciliation, type ReconcileReport } from "./run";

// TEST-ONLY helpers for the reconciler tests (excluded from the boundary scans). Nothing here can reach Meta.

export { addContact, addTouch, minutesAgo };
export const DAY = 24 * 60 * 60_000;
export const daysAgo = (d: number, from = new Date()) => new Date(from.getTime() - d * DAY);

export type Fixture = {
  t: TestDb;
  w: World;
  run: (options?: Partial<ReconcileOptions>) => Promise<ReconcileReport>;
  q: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  one: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T>;
  close: () => Promise<void>;
};

/** A fresh disposable database with one organization, so a run's counts are exact (the reconciler scans every organization). */
export async function fixture(): Promise<Fixture> {
  const t = await createTestDatabase();
  const w = await world(t.db);
  const q = async <T>(sql: string, params: unknown[] = []) =>
    (await t.pool.query(sql, params)).rows as T[];
  return {
    t,
    w,
    run: (options = {}) => runReconciliation(t.db, { ...DEFAULT_OPTIONS, ...options }),
    q,
    one: async <T>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0]!,
    close: () => t.close(),
  };
}

/** Waits until at least `count` backends of this database are blocked on a lock. */
export async function waitUntilBlocked(t: TestDb, count = 1) {
  for (let i = 0; i < 1000; i++) {
    const r = await t.pool.query(
      "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if ((r.rows[0].n as number) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fewer than ${count} statements blocked on a lock`);
}

/** Makes a RETRY row due now. The guard trigger forbids scheduling into the past, so (on this disposable database only) it is switched off for the one UPDATE. */
export async function makeDue(t: TestDb, attributionId: string) {
  const c = await t.pool.connect();
  try {
    await c.query("begin");
    await c.query(
      "alter table lead_reconcile_decisions disable trigger lead_reconcile_decisions_guard_trg",
    );
    await c.query(
      "update lead_reconcile_decisions set next_attempt_at = clock_timestamp() - interval '1 second' where attribution_id = $1 and decision = 'RETRY'",
      [attributionId],
    );
    await c.query(
      "alter table lead_reconcile_decisions enable trigger lead_reconcile_decisions_guard_trg",
    );
    await c.query("commit");
  } catch (error) {
    await c.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

/**
 * A real, selective failure: a trigger that raises on every insert of one kind of lead history row, so the reconciler's
 * transaction really runs part way and really rolls back. Removed with removeFailure().
 */
export async function injectFailure(
  t: TestDb,
  kind: "CREATED" | "TOUCH_LINKED",
  /** Only for this contact, when given. */
  contactId?: string,
) {
  await t.pool.query(`
    create or replace function test_inject_failure() returns trigger language plpgsql as $$
    begin raise exception 'injected failure' using errcode = 'P0001'; end $$;
    drop trigger if exists test_inject_failure_trg on lead_events;
    create trigger test_inject_failure_trg before insert on lead_events
      for each row when (new.kind = '${kind}'${contactId ? ` and new.contact_id = '${contactId}'` : ""})
      execute function test_inject_failure();`);
}
export async function removeFailure(t: TestDb) {
  await t.pool.query("drop trigger if exists test_inject_failure_trg on lead_events");
}

// ------------------------------------------------------------------------------------------------------ a barrier
// A DETERMINISTIC way to hold a reconciler inside its transaction, with all its locks (organization, contact, lead, touch,
// decision) and its first writes already made: a trigger on lead_events (for the rows only the reconciler writes: TOUCH_LINKED
// and CREATED/AD_REFERRAL) that waits for an advisory lock which the test holds. The reconciler never waits for row locks (NOWAIT),
// so this is how a test makes it overlap with another writer. Release the barrier and the reconciler goes on.
const BARRIER_KEY = 7_770_001;

export async function installBarrier(t: TestDb) {
  await t.pool.query(`
    create or replace function test_barrier() returns trigger language plpgsql as $$
    begin perform pg_advisory_xact_lock(${BARRIER_KEY}); return new; end $$;
    drop trigger if exists test_barrier_trg on lead_events;
    create trigger test_barrier_trg before insert on lead_events
      for each row when (new.kind = 'TOUCH_LINKED' or new.origin = 'AD_REFERRAL') execute function test_barrier();`);
}
export async function removeBarrier(t: TestDb) {
  await t.pool.query("drop trigger if exists test_barrier_trg on lead_events");
}
/** Holds the barrier (a session-level advisory lock on its own connection) until released. */
export async function holdBarrier(t: TestDb) {
  const c = await t.pool.connect();
  await c.query("select pg_advisory_lock($1)", [BARRIER_KEY]);
  return {
    async release() {
      await c.query("select pg_advisory_unlock($1)", [BARRIER_KEY]);
      c.release();
    },
  };
}

/** Like injectFailure("CREATED"), but the transaction first works for `seconds` (inside the database) before it fails. */
export async function injectSlowFailure(t: TestDb, seconds: number) {
  await t.pool.query(`
    create or replace function test_inject_failure() returns trigger language plpgsql as $$
    begin perform pg_sleep(${seconds}); raise exception 'injected failure' using errcode = 'P0001'; end $$;
    drop trigger if exists test_inject_failure_trg on lead_events;
    create trigger test_inject_failure_trg before insert on lead_events
      for each row when (new.kind = 'CREATED') execute function test_inject_failure();`);
}

// A second barrier, INSIDE the recording of a failure: it holds the reconciler at the moment it writes its RETRY/PARKED row, after
// the work was rolled back to its savepoint. (The first barrier above sits in the work itself.)
const RECORD_BARRIER_KEY = 7_770_002;

export async function installRecordBarrier(t: TestDb) {
  await t.pool.query(`
    create or replace function test_record_barrier() returns trigger language plpgsql as $$
    begin perform pg_advisory_xact_lock(${RECORD_BARRIER_KEY}); return new; end $$;
    drop trigger if exists test_record_barrier_trg on lead_reconcile_decisions;
    create trigger test_record_barrier_trg before insert or update on lead_reconcile_decisions
      for each row when (new.decision in ('RETRY', 'PARKED')) execute function test_record_barrier();`);
}
export async function removeRecordBarrier(t: TestDb) {
  await t.pool.query("drop trigger if exists test_record_barrier_trg on lead_reconcile_decisions");
}
export async function holdRecordBarrier(t: TestDb) {
  const c = await t.pool.connect();
  await c.query("select pg_advisory_lock($1)", [RECORD_BARRIER_KEY]);
  return {
    async release() {
      await c.query("select pg_advisory_unlock($1)", [RECORD_BARRIER_KEY]);
      c.release();
    },
  };
}

/** Waits until some backend of this database is waiting for the barrier with this key (1 = work barrier, 2 = recording barrier). */
export async function waitUntilWaitingOnBarrier(t: TestDb, which: 1 | 2) {
  const objid = which === 1 ? 7_770_001 : 7_770_002;
  for (let i = 0; i < 2000; i++) {
    const r = await t.pool.query(
      "select count(*)::int n from pg_locks where locktype = 'advisory' and not granted and objid = $1 and database = (select oid from pg_database where datname = current_database())",
      [objid],
    );
    if ((r.rows[0].n as number) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`nobody waits for barrier ${which}`);
}

/** The backend that holds the contact's advisory lock right now: its pid and its transaction's start (null: nobody holds it). */
export async function contactLockHolder(t: TestDb, key: string) {
  const r = await t.pool.query(
    `select l.pid, a.xact_start::text as xact_start
       from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and l.granted and l.objsubid = 1
        and l.database = (select oid from pg_database where datname = current_database())
        and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1, 0)`,
    [key],
  );
  return (r.rows[0] as { pid: number; xact_start: string } | undefined) ?? null;
}

/** How many backends of this database are WAITING for the contact's advisory lock right now. */
export async function waitersOnContact(t: TestDb, key: string) {
  const r = await t.pool.query(
    `select count(*)::int n from pg_locks l
      where l.locktype = 'advisory' and not l.granted and l.objsubid = 1
        and l.database = (select oid from pg_database where datname = current_database())
        and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1, 0)`,
    [key],
  );
  return r.rows[0].n as number;
}

export { faultyDatabase } from "@/db/__tests__/faulty-database";
