import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkerDatabase } from "@/db";
import { runReconcileCli } from "./cli";
import { bounded, isLimitError } from "./bounded";
import { DEFAULT_OPTIONS } from "./config";
import { runReconciliation } from "./run";
import { UNKNOWN_REMAINING, readRemaining, scanCandidates } from "./scan";
import {
  addContact,
  addTouch,
  fixture,
  holdBarrier,
  installBarrier,
  minutesAgo,
  removeBarrier,
  waitUntilBlocked,
  type Fixture,
} from "./testing";

// Review C-M3. EVERY database interaction of the reconciler runs under PostgreSQL's own lock and statement timeouts, set
// transaction-locally. The proof is a REAL ACCESS EXCLUSIVE lock (what a migration takes) held by the test for the whole time:
// the reconciler's queries end at their configured limit, without waiting for the lock holder to let go.

const SETTINGS = sql`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement`;
const TABLE_LOCKED = "55P03";
const STATEMENT_TIMEOUT = "57014";

describe("lead reconciler: every query is bounded by the database", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => f.close());

  /** Holds ACCESS EXCLUSIVE locks on the given tables, like a migration would, until released. */
  async function lockTables(...tables: string[]) {
    const c = await f.t.pool.connect();
    await c.query("begin");
    for (const table of tables) await c.query(`lock table ${table} in access exclusive mode`);
    return {
      async release() {
        await c.query("commit");
        c.release();
      },
    };
  }
  const codeOf = (error: unknown) =>
    ((error as { cause?: { code?: string } }).cause?.code ??
      (error as { code?: string }).code) as string;
  async function failsWith<T>(p: Promise<T>) {
    try {
      await p;
    } catch (error) {
      return error;
    }
    throw new Error("expected the query to fail");
  }
  const quick = { ...DEFAULT_OPTIONS, lockTimeoutMs: 400 };

  it("a candidate scan blocked by a table lock ends at the LOCK timeout, while the lock is still held", async () => {
    await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(5) });
    const lock = await lockTables("lead_attributions");
    try {
      const started = Date.now();
      const error = await failsWith(scanCandidates(f.t.db, null, 10, quick));
      const took = Date.now() - started;
      expect(codeOf(error)).toBe(TABLE_LOCKED);
      expect(isLimitError(error)).toBe(true);
      expect(took).toBeGreaterThanOrEqual(350);
      expect(took).toBeLessThan(3_000); // the default lock timeout is 3 s and the holder never let go
    } finally {
      await lock.release();
    }
    // free again: the same scan works
    expect(await scanCandidates(f.t.db, null, 10, quick)).toHaveLength(1);
  });

  it("a scan that runs (or waits) too long ends at the STATEMENT timeout, even when the lock timeout would allow much longer", async () => {
    const lock = await lockTables("lead_attributions");
    try {
      const started = Date.now();
      const error = await failsWith(
        scanCandidates(f.t.db, null, 10, {
          ...DEFAULT_OPTIONS,
          lockTimeoutMs: 30_000,
          statementTimeoutMs: 400,
        }),
      );
      expect(codeOf(error)).toBe(STATEMENT_TIMEOUT);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await lock.release();
    }
  });

  it("the remaining-work count is bounded the same way", async () => {
    const lock = await lockTables("lead_reconcile_decisions");
    try {
      const started = Date.now();
      const error = await failsWith(readRemaining(f.t.db, quick));
      expect(codeOf(error)).toBe(TABLE_LOCKED);
      expect(Date.now() - started).toBeLessThan(3_000);
      const slow = await failsWith(
        readRemaining(f.t.db, {
          ...DEFAULT_OPTIONS,
          lockTimeoutMs: 30_000,
          statementTimeoutMs: 400,
        }),
      );
      expect(codeOf(slow)).toBe(STATEMENT_TIMEOUT);
    } finally {
      await lock.release();
    }
    expect(await readRemaining(f.t.db, quick)).toMatchObject({ known: true, due: 0 });
  });

  it("a whole RUN against a locked table stops with query_failed at the limit, reports the count as unknown, and exposes only a fixed code", async () => {
    await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(5) });
    const lock = await lockTables("lead_attributions", "lead_reconcile_decisions");
    try {
      const started = Date.now();
      const report = await runReconciliation(f.t.db, quick);
      expect(Date.now() - started).toBeLessThan(5_000); // the scan and the count each ended at the lock timeout
      expect(report).toMatchObject({
        stopReason: "query_failed",
        scanned: 0,
        processed: 0,
        remaining: UNKNOWN_REMAINING,
      });
      expect(report.errors).toEqual({ pg_55p03: 2 }); // the scan and the count
      const text = JSON.stringify(report);
      expect(text).not.toMatch(/select|from |lead_attributions|postgres|password/i);
    } finally {
      await lock.release();
    }
    expect((await runReconciliation(f.t.db, quick)).created).toBe(1);
  });

  it("handling a touch and recording its failure are bounded too: a blocked statement ends at the limit, not at the holder", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const candidate = {
      organizationId: f.w.org.id,
      attributionId: touch.id,
      contactId: contact.id,
      receivedKey: "",
    };
    const { processCandidate } = await import("./process");
    const { recordFailure } = await import("./failure");
    const lock = await lockTables("lead_reconcile_decisions");
    try {
      const started = Date.now();
      // handling: the table lock on the decisions table is hit by the touch's decision read; it is "busy" (55P03), not a failure
      expect(await processCandidate(f.t.db, candidate, quick)).toEqual({ kind: "busy" });
      expect(Date.now() - started).toBeLessThan(3_000);
      const second = Date.now();
      expect(await recordFailure(f.t.db, candidate, "pg_p0001", quick)).toEqual({
        kind: "busy",
      });
      expect(Date.now() - second).toBeLessThan(3_000);
    } finally {
      await lock.release();
    }
    // nothing was recorded, charged or changed by the timeouts
    expect(await f.q("select 1 from lead_reconcile_decisions")).toHaveLength(0);
    expect(await f.q("select 1 from leads")).toHaveLength(0);
  });

  it("the READINESS check of the command is bounded: a migration's table lock gives 'database_timeout' after the configured lock timeout, with nothing else printed", async () => {
    const lock = await lockTables("leads");
    try {
      const out: string[] = [];
      const err: string[] = [];
      const started = Date.now();
      const code = await runReconcileCli({
        env: {
          LEADS_RECONCILER_ENABLED: "true",
          DATABASE_URL: f.t.url,
          LEADS_RECONCILE_LOCK_TIMEOUT_SECONDS: "1",
        },
        output: (l) => out.push(l),
        print: (m) => err.push(m),
      });
      const took = Date.now() - started;
      expect(code).toBe(1);
      expect(took).toBeGreaterThanOrEqual(900);
      expect(took).toBeLessThan(5_000);
      expect(out.map((l) => JSON.parse(l))).toEqual([
        { event: "leads.reconcile.run", outcome: "failure", reason: "database_timeout" },
      ]);
      expect(out.join(" ") + err.join(" ")).not.toMatch(
        /select |postgres|password|ACCESS|lock table/i,
      );
    } finally {
      await lock.release();
    }
  });

  it("limits are transaction-local: a pooled connection never keeps them, and inside a bounded transaction they are in force", async () => {
    // ONE connection, used by everything below, so any setting that leaked would be seen on the next use
    const own = createWorkerDatabase(f.t.url, {
      maxConnections: 1,
      applicationName: "reconcile-limits-test",
      onPoolError: () => undefined,
    });
    try {
      const options = { ...DEFAULT_OPTIONS, lockTimeoutMs: 1_234, statementTimeoutMs: 5_678 };
      const inside = await bounded(own.db, options, async (tx) => {
        const r = await tx.execute<{ lock: string; statement: string }>(SETTINGS);
        return r.rows[0]!;
      });
      expect(inside).toEqual({ lock: "1234ms", statement: "5678ms" });
      await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(5) });
      await runReconciliation(own.db, options);
      const after = await own.db.execute<{ lock: string; statement: string }>(SETTINGS);
      expect(after.rows[0]).toEqual({ lock: "0", statement: "0" }); // the server's own defaults: nothing leaked
    } finally {
      await own.close();
    }
  });

  it("the run budget stops NEW work only: a transaction already in flight finishes (it is bounded by the database), then the run stops", async () => {
    const contacts = [await addContact(f.t.db, f.w.org.id), await addContact(f.t.db, f.w.org.id)];
    const first = await addTouch(f.t.db, f.w, contacts[0]!.id, { receivedAt: minutesAgo(20) });
    const second = await addTouch(f.t.db, f.w, contacts[1]!.id, { receivedAt: minutesAgo(10) });
    await installBarrier(f.t);
    const barrier = await holdBarrier(f.t);
    try {
      // a budget of 300 ms; the first transaction is held at the barrier for longer than that
      const running = runReconciliation(f.t.db, { ...DEFAULT_OPTIONS, maxRunMs: 300 });
      await waitUntilBlocked(f.t, 1);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await barrier.release();
      const report = await running;
      expect(report).toMatchObject({ created: 1, processed: 1, stopReason: "time_limit" });
    } finally {
      await removeBarrier(f.t);
    }
    const linked = async (id: string) =>
      (
        await f.one<{ lead_id: string | null }>(
          "select lead_id from lead_attributions where id = $1",
          [id],
        )
      ).lead_id;
    expect(await linked(first.id)).not.toBeNull(); // the in-flight one completed
    expect(await linked(second.id)).toBeNull(); // no new one was started
    expect((await runReconciliation(f.t.db, DEFAULT_OPTIONS)).created).toBe(1);
  });
});
