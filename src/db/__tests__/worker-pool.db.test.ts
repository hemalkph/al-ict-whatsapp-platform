import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerDatabase } from "../client";
import { createTestDatabase, type TestDb } from "./helpers";

// The worker's own connection pool, against real PostgreSQL: bounded, named, survives dead connections, and never keeps a
// pool slot forever after a connection dies at the start of a transaction (a drizzle-orm 0.45.3 leak).

describe("worker database pool", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });

  const open = (maxConnections = 2) => {
    const errors: unknown[] = [];
    const w = createWorkerDatabase(t.url, {
      maxConnections,
      applicationName: "al-ict-pool-test",
      onPoolError: (e) => errors.push(e),
    });
    return { ...w, pool: (w.db as unknown as { $client: Pool }).$client, errors };
  };
  const waitFor = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("condition not reached in time");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const killBackend = (pid: number) => t.pool.query("select pg_terminate_backend($1)", [pid]);

  it("names its sessions and never opens more than its bound", async () => {
    const w = open(2);
    const names = new Set<string>();
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        await w.db.transaction(async (tx) => {
          const r = await tx.execute<{ n: string }>(
            (await import("drizzle-orm"))
              .sql`select current_setting('application_name') n, pg_sleep(0.05)`,
          );
          names.add(r.rows[0]!.n);
        });
      }),
    );
    expect([...names]).toEqual(["al-ict-pool-test"]);
    expect(w.pool.totalCount).toBeLessThanOrEqual(2);
    await w.close();
  });

  it("a connection that dies when a transaction starts does not leak its pool slot, and close() still completes", async () => {
    const w = open(1); // one slot: a leaked client would starve every later query
    const connect = w.pool.connect.bind(w.pool) as () => Promise<import("pg").PoolClient>;
    let first = true;
    (w.pool as unknown as { connect: () => Promise<import("pg").PoolClient> }).connect =
      async () => {
        const client = await connect();
        if (first) {
          first = false;
          await killBackend((client as unknown as { processID: number }).processID);
          await new Promise((r) => setTimeout(r, 100)); // the server's FATAL reaches the client before BEGIN is sent
        }
        return client;
      };
    await expect(w.db.transaction(async () => undefined)).rejects.toThrow();
    // without the guard the failed BEGIN leaves the client checked out forever: totalCount stays 1
    await waitFor(() => w.pool.totalCount === 0, 4000);
    // and the single slot is usable again
    const rows = await w.db.transaction(
      async (tx) => (await tx.execute((await import("drizzle-orm")).sql`select 1 as ok`)).rows,
    );
    expect(rows).toEqual([{ ok: 1 }]);
    const closed = await Promise.race([
      w.close().then(() => "closed"),
      new Promise((r) => setTimeout(() => r("hung"), 5000)),
    ]);
    expect(closed).toBe("closed");
  });

  it("a connection killed while idle in the pool is reported (not thrown) and replaced", async () => {
    const w = open(2);
    await w.db.execute((await import("drizzle-orm")).sql`select 1`);
    const sessions = await t.pool.query(
      "select pid from pg_stat_activity where datname = current_database() and application_name = 'al-ict-pool-test'",
    );
    for (const row of sessions.rows) await killBackend(row.pid);
    await waitFor(() => w.errors.length > 0);
    const r = await w.db.execute<{ ok: number }>((await import("drizzle-orm")).sql`select 1 as ok`);
    expect(r.rows[0]!.ok).toBe(1);
    await w.close();
  });

  it("a connection killed in the middle of a transaction rejects the transaction and releases the slot", async () => {
    const w = open(1);
    const sql = (await import("drizzle-orm")).sql;
    await expect(
      w.db.transaction(async (tx) => {
        const r = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        await killBackend(r.rows[0]!.pid);
        await new Promise((res) => setTimeout(res, 100));
        await tx.execute(sql`select 1`);
      }),
    ).rejects.toThrow();
    await waitFor(() => w.pool.totalCount === 0, 4000);
    expect((await w.db.execute<{ ok: number }>(sql`select 1 as ok`)).rows[0]!.ok).toBe(1);
    await w.close();
  });
});
