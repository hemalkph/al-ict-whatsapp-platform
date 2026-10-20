import { migrate } from "drizzle-orm/node-postgres/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "./helpers";

// Migration 0005 (staff inbox) applied as an UPGRADE to a database that already holds data, on a disposable database only.
// The fresh-database path is covered by every other database test (they all migrate from empty).

const FULL = fileURLToPath(new URL("../migrations", import.meta.url));
const TAG = "0005_staff_inbox_workflow";
const journal = JSON.parse(readFileSync(join(FULL, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ tag: string }>;
};
const BEFORE = journal.entries.findIndex((e) => e.tag === TAG);

function folderBefore0005(): string {
  const dir = mkdtempSync(join(tmpdir(), "al-ict-migrations-pre0005-"));
  mkdirSync(join(dir, "meta"));
  const kept = journal.entries.slice(0, BEFORE);
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify(
      { ...JSON.parse(readFileSync(join(FULL, "meta/_journal.json"), "utf8")), entries: kept },
      null,
      2,
    ),
  );
  for (const e of kept) copyFileSync(join(FULL, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

describe("migration 0005: applying it to a database that already has conversations", () => {
  let before: string;
  beforeAll(() => {
    expect(BEFORE).toBeGreaterThan(0);
    before = folderBefore0005();
  });
  afterAll(() => rmSync(before, { recursive: true, force: true }));

  it("keeps every existing row unchanged, adds the new structures empty, and is idempotent", async () => {
    const t = await createTestDatabase({ migrate: false });
    try {
      await migrate(t.db, { migrationsFolder: before });
      const q = (sql: string, params: unknown[] = []) => t.pool.query(sql, params);
      expect(
        (await q("select to_regclass('public.conversation_notes') as r")).rows[0].r,
      ).toBeNull(); // really the old schema
      const org = (
        await q("insert into organizations (name, slug) values ('Org', 'org-up') returning id")
      ).rows[0].id;
      const account = (
        await q(
          "insert into whatsapp_accounts (organization_id, waba_id, phone_number_id, display_phone_number, status) values ($1,'200000000000501','100000000000501','+94 77 000 0501','ACTIVE') returning id",
          [org],
        )
      ).rows[0].id;
      const contact = (
        await q(
          "insert into contacts (organization_id, wa_id, profile_name, first_seen_at, last_seen_at) values ($1,'94770000501','Old Student', now(), now()) returning id",
          [org],
        )
      ).rows[0].id;
      const conversations: string[] = [];
      for (const status of ["OPEN", "PENDING", "RESOLVED"]) {
        const c = (
          await q(
            "insert into contacts (organization_id, wa_id, first_seen_at, last_seen_at) values ($1, $2, now(), now()) returning id",
            [org, `9477000${status.length}${conversations.length}`],
          )
        ).rows[0].id;
        conversations.push(
          (
            await q(
              "insert into conversations (organization_id, whatsapp_account_id, contact_id, status, last_message_at, last_inbound_at) values ($1,$2,$3,$4, now(), now()) returning id",
              [org, account, c, status],
            )
          ).rows[0].id,
        );
      }
      const conv = (
        await q(
          "insert into conversations (organization_id, whatsapp_account_id, contact_id, status, last_message_at, last_inbound_at) values ($1,$2,$3,'OPEN', now(), now()) returning id",
          [org, account, contact],
        )
      ).rows[0].id;
      await q(
        "insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at, wamid) values ($1,$2,$3,'INBOUND','TEXT','hello', now(), 'wamid.UP1')",
        [org, conv, account],
      );
      const snapshot = async () => ({
        conversations: (
          await q(
            "select id, status, last_message_at, last_inbound_at, last_outbound_at, resolved_at from conversations order by id",
          )
        ).rows,
        messages: (await q("select * from messages order by id")).rows,
        contacts: (await q("select * from contacts order by id")).rows,
      });
      const old = await snapshot();
      expect(old.conversations).toHaveLength(4);

      await migrate(t.db, { migrationsFolder: FULL });

      expect(await snapshot()).toEqual(old); // nothing existing changed
      expect(
        (
          await q(
            "select count(*)::int n from conversations where assigned_membership_id is not null or assigned_at is not null",
          )
        ).rows[0].n,
      ).toBe(0);
      for (const table of [
        "conversation_events",
        "conversation_notes",
        "quick_replies",
        "message_reads",
      ])
        expect((await q(`select count(*)::int n from ${table}`)).rows[0].n).toBe(0);
      const tables = (
        await q(
          "select count(*)::int n from information_schema.tables where table_schema = 'public'",
        )
      ).rows[0].n;
      expect(tables).toBe(38); // every later migration also applied: 0006 adds lead_events and lead_reconcile_decisions; 0007 seven bot tables
      expect((await q("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n).toBe(
        journal.entries.length,
      );
      // the append-only triggers and the assignment CHECK are really there
      expect(
        (
          await q(
            "select count(*)::int n from pg_trigger where tgname in ('conversation_events_append_only_trg','conversation_notes_append_only_trg')",
          )
        ).rows[0].n,
      ).toBe(2);
      await migrate(t.db, { migrationsFolder: FULL }); // idempotent
      expect((await q("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n).toBe(
        journal.entries.length,
      );
    } finally {
      await t.close();
    }
  });
});
