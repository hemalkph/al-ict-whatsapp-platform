import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "./helpers";

// Regression tests for the harness lifecycle itself: closing a scratch database must be quiet
// (no unhandled pg errors), complete (the database is gone) and honest (a leaked connection is
// reported instead of being killed underneath its owner).

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres";

async function databaseExists(name: string) {
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    const r = await admin.query("select 1 from pg_database where datname = $1", [name]);
    return r.rowCount === 1;
  } finally {
    await admin.end();
  }
}

describe("test database harness lifecycle", () => {
  it("creates, uses and drops many scratch databases with zero unhandled errors", async () => {
    // Vitest fails the run on any unhandled error raised while this loop is running.
    for (let i = 0; i < 25; i++) {
      const t = await createTestDatabase();
      await Promise.all(Array.from({ length: 8 }, () => t.pool.query("select 1")));
      await t.db.transaction(async (tx) => {
        await tx.execute("select 1" as never);
      });
      await t.close();
      expect(await databaseExists(t.name)).toBe(false);
    }
  });

  it("close() is idempotent", async () => {
    const t = await createTestDatabase();
    await t.close();
    await t.close();
  });

  it("reports a connection leaked by a test instead of killing it", async () => {
    const t = await createTestDatabase({ sessionWaitMs: 500 });
    const rogue = new Client({ connectionString: t.url }); // not owned by the harness; no idle timeout
    await rogue.connect();
    await expect(t.close()).rejects.toThrow(/still connected|leaked/i);
    expect(await databaseExists(t.name)).toBe(true); // not dropped underneath the rogue pool
    await rogue.end();
    await t.close(); // now clean: succeeds and drops the database
    expect(await databaseExists(t.name)).toBe(false);
  });
});
