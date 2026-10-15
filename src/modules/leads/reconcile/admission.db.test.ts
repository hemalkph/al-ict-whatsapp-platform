import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { world } from "../testing";
import { runReconcileCli } from "./cli";
import { DEFAULT_OPTIONS } from "./config";
import { runReconciliation } from "./run";
import {
  addContact,
  addTouch,
  faultyDatabase,
  fixture,
  minutesAgo,
  waitUntilBlocked,
  type Fixture,
} from "./testing";

// Third review, M2. The run budget (maxRunMs) and the batch size are ADMISSION control: each is checked before every candidate scan,
// every new page and every candidate, and a run that has used one up starts none of them. A statement that was already admitted is
// not interrupted by the budget: PostgreSQL's own lock and statement timeouts bound it. These tests use REAL table locks (what a
// migration takes), a clock the test controls where determinism is needed, and a count of the statements a run really sends.

describe("lead reconciler: the run budget and the batch limit are checked before admitting work", () => {
  let f: Fixture;
  let spy: ReturnType<typeof faultyDatabase>;
  beforeEach(async () => {
    f = await fixture();
    spy = faultyDatabase(f.t);
  });
  afterEach(async () => {
    await spy.close();
    await f.close();
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const scans = () => spy.statements.filter((s) => /WITH held AS/.test(s)).length;
  const attempts = () => spy.statements.filter((s) => /pg_try_advisory_xact_lock/.test(s)).length;

  /** `n` organizations, each with one eligible touch (the fixture's own organization is the first). */
  async function organizations(n: number) {
    const worlds = [f.w];
    for (let i = 1; i < n; i++) worlds.push(await world(f.t.db));
    let k = 0;
    for (const w of worlds) {
      const contact = await addContact(f.t.db, w.org.id);
      await addTouch(f.t.db, w, contact.id, { receivedAt: minutesAgo(30 - k++) });
    }
  }
  /** Holds ACCESS EXCLUSIVE on tables, like a migration, until released. */
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

  it("1-2. the budget is spent while a candidate is handled: no further candidate, page or scan begins (deterministic clock)", async () => {
    await organizations(3);
    let now = 0;
    const report = await runReconciliation(
      spy.db,
      { ...DEFAULT_OPTIONS, maxRunMs: 15_000, pageSize: 1 },
      {
        now: () => now,
        afterCandidate: () => {
          now += 20_000; // the first candidate used up the budget
        },
      },
    );
    expect(report).toMatchObject({
      stopReason: "time_limit",
      processed: 1,
      created: 1,
      scanned: 1,
    });
    expect(scans()).toBe(1); // no second page was fetched
    expect(attempts()).toBe(1); // and no second candidate was attempted
    expect(await f.one<{ n: number }>("select count(*)::int n from leads")).toEqual({ n: 1 });
    expect(report.remaining).toMatchObject({ known: true, due: 2 }); // the final count still ran
  });

  it("3-4. the budget expires DURING a scan: the scan that was admitted finishes, and no further page or candidate begins", async () => {
    await organizations(3);
    const lock = await lockTables("lead_reconcile_decisions"); // the scan reads it: it waits, within the lock timeout
    const running = runReconciliation(spy.db, {
      ...DEFAULT_OPTIONS,
      maxRunMs: 100,
      lockTimeoutMs: 5_000,
      pageSize: 1,
    });
    await waitUntilBlocked(f.t, 1);
    await sleep(250); // the budget is spent while the first scan is still waiting
    await lock.release();
    const report = await running;
    expect(scans()).toBe(1);
    expect(attempts()).toBe(0);
    expect(report).toMatchObject({
      stopReason: "time_limit",
      fetched: 1,
      scanned: 0,
      processed: 0,
    });
    expect(await f.one<{ n: number }>("select count(*)::int n from leads")).toEqual({ n: 0 });
    // the count at the end still ran and is bounded
    expect(report.remaining.known).toBe(true);
  });

  it("5-6. the batch is full: no further page is fetched and no further candidate is attempted", async () => {
    await organizations(3);
    // one candidate per page: after the first is processed the batch is spent
    const paged = await runReconciliation(spy.db, {
      ...DEFAULT_OPTIONS,
      batchSize: 1,
      pageSize: 1,
    });
    expect(paged).toMatchObject({ stopReason: "batch_limit", processed: 1, created: 1 });
    expect(scans()).toBe(1);
    expect(attempts()).toBe(1);
    // one big page: the other two touches are returned but never attempted
    spy.statements.length = 0;
    const big = await runReconciliation(spy.db, { ...DEFAULT_OPTIONS, batchSize: 1 });
    expect(big).toMatchObject({ stopReason: "batch_limit", processed: 1 });
    expect(scans()).toBe(1);
    expect(attempts()).toBe(1);
    expect(await f.one<{ n: number }>("select count(*)::int n from leads")).toEqual({ n: 2 });
  });

  it("7. the database's own timeouts still bound what was admitted: a scan blocked by a table lock ends at the lock timeout, whatever the budget", async () => {
    await organizations(3);
    const lock = await lockTables("organizations"); // the scan locks organization rows: it needs the table
    try {
      const started = Date.now();
      const report = await runReconciliation(spy.db, {
        ...DEFAULT_OPTIONS,
        maxRunMs: 60_000,
        lockTimeoutMs: 400,
      });
      const elapsed = Date.now() - started;
      expect(scans()).toBe(1);
      expect(attempts()).toBe(0);
      expect(report).toMatchObject({ stopReason: "query_failed", scanned: 0, processed: 0 });
      expect(report.errors).toMatchObject({ pg_55p03: expect.any(Number) });
      expect(elapsed).toBeGreaterThanOrEqual(350);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await lock.release();
    }
  });

  it("8. the command reports the stop reason: batch_limit and time_limit", async () => {
    await organizations(3);
    const run = async (env: Record<string, string>) => {
      const out: string[] = [];
      const code = await runReconcileCli({
        env: { LEADS_RECONCILER_ENABLED: "true", DATABASE_URL: f.t.url, ...env },
        output: (l) => out.push(l),
        print: () => undefined,
      });
      return { code, line: JSON.parse(out[0]!) as Record<string, unknown> };
    };
    const batch = await run({ LEADS_RECONCILE_BATCH_SIZE: "1" });
    expect(batch.code).toBe(0);
    expect(batch.line).toMatchObject({
      outcome: "success",
      stopReason: "batch_limit",
      processed: 1,
    });

    // a scan that waits on a table lock for longer than the 1-second budget (but less than the lock timeout) completes, and the
    // run then admits nothing more
    // (messages: the scan reads it, the command's readiness check does not touch it)
    const lock = await lockTables("messages");
    const running = run({
      LEADS_RECONCILE_MAX_SECONDS: "1",
      LEADS_RECONCILE_LOCK_TIMEOUT_SECONDS: "10",
    });
    await waitUntilBlocked(f.t, 1);
    await sleep(1_300);
    await lock.release();
    const timed = await running;
    expect(timed.code).toBe(0);
    expect(timed.line).toMatchObject({
      outcome: "success",
      stopReason: "time_limit",
      processed: 0,
    });
  }, 30_000);
});
