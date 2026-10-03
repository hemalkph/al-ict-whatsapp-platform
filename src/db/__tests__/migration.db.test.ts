import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDb } from "./helpers";

const EXPECTED_TABLES = [
  "contact_consents",
  "contact_tags",
  "contacts",
  "conversations",
  "lead_attributions",
  "leads",
  "message_attachments",
  "message_status_events",
  "messages",
  "organizations",
  "tags",
  "webhook_events",
  "webhook_requests",
  "whatsapp_accounts",
];

describe("migration from empty", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase(); // creates an empty database and applies every committed migration
  });
  afterAll(async () => t.close());

  it("creates exactly the planned tables", async () => {
    const r = await t.pool.query(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(r.rows.map((x) => x.table_name)).toEqual(EXPECTED_TABLES);
  });

  it("is recorded once and re-running the migrator is a no-op", async () => {
    const folder = fileURLToPath(new URL("../migrations", import.meta.url));
    await migrate(t.db, { migrationsFolder: folder });
    const r = await t.pool.query("select count(*)::int as n from drizzle.__drizzle_migrations");
    expect(r.rows[0].n).toBe(1);
  });

  it("has no deferred feature tables", async () => {
    const r = await t.pool.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1)",
      [["users", "memberships", "students", "campaigns", "bots", "audit_logs", "payments"]],
    );
    expect(r.rows).toEqual([]);
  });
});
