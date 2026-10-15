import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDb } from "./helpers";

const EXPECTED_TABLES = [
  "accounts",
  "contact_bsuids",
  "contact_consents",
  "contact_tags",
  "contacts",
  "conversation_events",
  "conversation_notes",
  "conversations",
  "lead_attributions",
  "lead_events",
  "lead_reconcile_decisions",
  "leads",
  "message_attachments",
  "message_reads",
  "message_status_events",
  "messages",
  "organization_memberships",
  "organizations",
  "outbound_requests",
  "quick_replies",
  "rate_limits",
  "sessions",
  "staff_provisioning_intents",
  "tags",
  "user_security_state",
  "users",
  "verifications",
  "webhook_events",
  "webhook_requests",
  "whatsapp_accounts",
  "whatsapp_templates",
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

  it("records every committed migration once and re-running the migrator is a no-op", async () => {
    const folder = fileURLToPath(new URL("../migrations", import.meta.url));
    await migrate(t.db, { migrationsFolder: folder });
    const r = await t.pool.query("select count(*)::int as n from drizzle.__drizzle_migrations");
    expect(r.rows[0].n).toBe(readdirSync(folder).filter((f) => f.endsWith(".sql")).length);
  });

  it("has no deferred feature tables", async () => {
    const r = await t.pool.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1)",
      [
        [
          "students",
          "campaigns",
          "bots",
          "audit_logs",
          "payments",
          "invitations",
          "roles",
          "permissions",
        ],
      ],
    );
    expect(r.rows).toEqual([]);
  });
});
