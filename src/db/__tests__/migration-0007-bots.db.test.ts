import { migrate } from "drizzle-orm/node-postgres/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDb } from "./helpers";

// Migration 0007 (bot foundation) applied as an UPGRADE to a database that already holds organizations, accounts, contacts,
// conversations and messages, on disposable al_ict_test_* databases only. The fresh path is covered by every other database
// test (they migrate from empty) and the guarantees by src/modules/bot-control/*.db.test.ts.

const FULL = fileURLToPath(new URL("../migrations", import.meta.url));
const TAG = "0007_bot_foundation";
const journal = JSON.parse(readFileSync(join(FULL, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ tag: string }>;
};
const BEFORE = journal.entries.findIndex((e) => e.tag === TAG);

/** A copy of the migrations folder that stops before 0007 (what a database has today). */
function folderBefore0007(): string {
  const dir = mkdtempSync(join(tmpdir(), "al-ict-migrations-pre0007-"));
  mkdirSync(join(dir, "meta"));
  const kept = journal.entries.slice(0, BEFORE);
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: kept }, null, 2),
  );
  for (const e of kept) copyFileSync(join(FULL, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

describe("migration 0007: applying it to a database that already has conversations and messages", () => {
  let before: string;
  let t: TestDb;
  const q = (sql: string, params: unknown[] = []) => t.pool.query(sql, params);

  beforeAll(async () => {
    expect(BEFORE).toBe(7);
    before = folderBefore0007();
    t = await createTestDatabase({ migrate: false });
    await migrate(t.db, { migrationsFolder: before });
  });
  afterAll(async () => {
    await t.close();
    rmSync(before, { recursive: true, force: true });
  });

  it("adds control_seq = 0 to existing conversations, keeps every row, and creates the bot tables", async () => {
    expect((await q("select to_regclass('public.bots') r")).rows[0].r).toBeNull();
    // Raw SQL on purpose: this database has the schema of its time (before 0007).
    const org = (
      await q("insert into organizations (name, slug) values ('Org', 'org-0007') returning id")
    ).rows[0].id;
    const account = (
      await q(
        "insert into whatsapp_accounts (organization_id, waba_id, phone_number_id, display_phone_number, status) values ($1,'200000000000701','100000000000701','+94 77 000 0701','ACTIVE') returning id",
        [org],
      )
    ).rows[0].id;
    const contact = (
      await q(
        "insert into contacts (organization_id, wa_id, first_seen_at, last_seen_at) values ($1, '94770700001', now(), now()) returning id",
        [org],
      )
    ).rows[0].id;
    const conversation = (
      await q(
        "insert into conversations (organization_id, whatsapp_account_id, contact_id, last_message_at, status) values ($1,$2,$3, '2026-01-01', 'RESOLVED') returning id",
        [org, account, contact],
      )
    ).rows[0].id;
    await q(
      "insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at, wamid) values ($1,$2,$3,'INBOUND','TEXT','m', now(), 'wamid.U7a')",
      [org, conversation, account],
    );
    const snapshot = async () =>
      (
        await q(
          "select to_jsonb(c) - 'control_seq' as c from conversations c union all select to_jsonb(m) from messages m order by 1",
        )
      ).rows;
    const beforeRows = await snapshot();

    await migrate(t.db, { migrationsFolder: FULL });

    expect(await snapshot()).toEqual(beforeRows);
    expect(
      (await q("select control_seq from conversations where id = $1", [conversation])).rows[0],
    ).toEqual({
      control_seq: "0",
    });
    for (const table of [
      "bots",
      "bot_versions",
      "bot_deployments",
      "bot_deployment_events",
      "bot_sessions",
      "bot_session_events",
      "bot_triggers",
    ])
      expect(
        (await q("select to_regclass($1) r", [`public.${table}`])).rows[0].r,
        table,
      ).not.toBeNull();
    expect(
      (await q("select 1 from pg_constraint where conname = 'conversations_org_id_contact_unique'"))
        .rowCount,
    ).toBe(1);
    // Re-running the migrator is a no-op.
    const n = (await q("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n;
    await migrate(t.db, { migrationsFolder: FULL });
    expect((await q("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n).toBe(n);
  });
});
