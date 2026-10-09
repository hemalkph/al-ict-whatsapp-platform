import { migrate } from "drizzle-orm/node-postgres/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, pgError, type TestDb } from "./helpers";

// Migration 0002 adds `webhook_requests.raw_body bytea NOT NULL` BEFORE dropping `raw_payload jsonb`. That is safe
// only while webhook_requests is empty, and it is empty everywhere because no runtime code writes it yet. The
// migration must therefore be deployed before any real webhook data exists. It deliberately does NOT backfill:
// serializing the jsonb would fabricate bytes that were never on the wire and could never re-verify a signature.
// These tests prove both halves of that assumption with the real drizzle migrator.

const FULL = fileURLToPath(new URL("../migrations", import.meta.url));
const TOTAL = (
  JSON.parse(readFileSync(join(FULL, "meta/_journal.json"), "utf8")) as { entries: unknown[] }
).entries.length;
const TAG_0002 = "0002_whatsapp_webhook_ingest_and_bsuid_identity";

/** A copy of the migrations folder whose journal stops before 0002 (the schema every database had before Phase 04). */
function folderBefore0002(): string {
  const dir = mkdtempSync(join(tmpdir(), "al-ict-migrations-pre0002-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(FULL, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  // everything BEFORE 0002 is kept; 0002 and every later migration is withheld
  const at = journal.entries.findIndex((e) => e.tag === TAG_0002);
  expect(at).toBeGreaterThan(0);
  const kept = journal.entries.slice(0, at);
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: kept }, null, 2),
  );
  for (const e of kept) copyFileSync(join(FULL, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

describe("migration 0002 precondition: webhook_requests must be empty", () => {
  let before: string;
  beforeAll(() => {
    before = folderBefore0002();
  });
  afterAll(() => rmSync(before, { recursive: true, force: true }));

  async function preMigrationDatabase() {
    const t = await createTestDatabase({ migrate: false });
    await migrate(t.db, { migrationsFolder: before });
    return t;
  }
  const columns = async (t: TestDb, table: string) =>
    (
      await t.pool.query(
        "select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position",
        [table],
      )
    ).rows.map((r) => r.column_name as string);
  const tableCount = async (t: TestDb) =>
    (
      await t.pool.query(
        "select count(*)::int n from information_schema.tables where table_schema = 'public'",
      )
    ).rows[0].n as number;
  const recorded = async (t: TestDb) =>
    (await t.pool.query("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0]
      .n as number;

  it("applies cleanly to a pre-0002 database whose webhook_requests table is empty", async () => {
    const t = await preMigrationDatabase();
    try {
      expect(await tableCount(t)).toBe(22);
      expect(await columns(t, "webhook_requests")).toEqual([
        "id",
        "received_at",
        "raw_payload",
        "payload_sha256",
        "created_at",
      ]);
      await migrate(t.db, { migrationsFolder: FULL }); // applies 0002 and every later migration
      expect(await tableCount(t)).toBe(23);
      expect(await recorded(t)).toBe(TOTAL);
      const cols = await columns(t, "webhook_requests");
      expect(cols).toContain("raw_body");
      expect(cols).not.toContain("raw_payload");
    } finally {
      await t.close();
    }
  });

  it("FAILS SAFELY on a pre-0002 database that already holds a webhook_requests row: nothing is half-applied and nothing is backfilled", async () => {
    const t = await preMigrationDatabase();
    try {
      await t.pool.query(
        `insert into webhook_requests (raw_payload, payload_sha256) values ('{"x":1}'::jsonb, '00')`,
      );

      let caught: unknown;
      try {
        await migrate(t.db, { migrationsFolder: FULL });
      } catch (e) {
        caught = e;
      }
      expect(caught, "the migration must refuse a non-empty webhook_requests").toBeDefined();
      const err = pgError(caught);
      expect(err.code).toBe("23502"); // not_null_violation from ADD COLUMN raw_body ... NOT NULL
      expect(err.message).toMatch(/raw_body/);

      // all-or-nothing: the database is exactly as it was before the attempt
      expect(await tableCount(t)).toBe(22);
      expect(await recorded(t)).toBe(2); // 0002 was not recorded as applied
      expect(await columns(t, "webhook_requests")).toEqual([
        "id",
        "received_at",
        "raw_payload",
        "payload_sha256",
        "created_at",
      ]);
      const wa = await t.pool.query(
        "select is_nullable from information_schema.columns where table_name='contacts' and column_name='wa_id'",
      );
      expect(wa.rows[0].is_nullable).toBe("NO"); // the contacts change of 0002 was rolled back too
      const reg = await t.pool.query("select to_regclass('public.contact_bsuids') as r");
      expect(reg.rows[0].r).toBeNull();

      // no silent backfill: the original row and its jsonb are untouched
      const row = await t.pool.query("select raw_payload, payload_sha256 from webhook_requests");
      expect(row.rows).toEqual([{ raw_payload: { x: 1 }, payload_sha256: "00" }]);
    } finally {
      await t.close();
    }
  });

  it("the only blocker is the data: once webhook_requests is empty the same migration applies", async () => {
    const t = await preMigrationDatabase();
    try {
      await t.pool.query(
        `insert into webhook_requests (raw_payload, payload_sha256) values ('{"x":1}'::jsonb, '00')`,
      );
      await expect(migrate(t.db, { migrationsFolder: FULL })).rejects.toBeDefined();
      await t.pool.query("delete from webhook_requests"); // an operator decision, never done by the migration
      await migrate(t.db, { migrationsFolder: FULL });
      expect(await tableCount(t)).toBe(23);
      expect(await recorded(t)).toBe(TOTAL);
    } finally {
      await t.close();
    }
  });
});
