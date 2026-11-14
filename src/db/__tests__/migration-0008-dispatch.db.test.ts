import { migrate } from "drizzle-orm/node-postgres/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECK_VIOLATION, createTestDatabase, expectPgError, type TestDb } from "./helpers";

// Migration 0008 (Phase 08D, ADR 0020) applied as an UPGRADE to a database at 0007 that already holds staff outbound
// requests in every state and conversation events, on disposable al_ict_test_* databases only. The fresh path is covered by
// every other database test (they migrate from empty); the new rules by src/modules/bot-control/*.db.test.ts.

const FULL = fileURLToPath(new URL("../migrations", import.meta.url));
const TAG = "0008_bot_outbound_dispatch";
const journal = JSON.parse(readFileSync(join(FULL, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ tag: string }>;
};
const BEFORE = journal.entries.findIndex((e) => e.tag === TAG);

function folderBefore0008(): string {
  const dir = mkdtempSync(join(tmpdir(), "al-ict-migrations-pre0008-"));
  mkdirSync(join(dir, "meta"));
  const kept = journal.entries.slice(0, BEFORE);
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: kept }, null, 2),
  );
  for (const e of kept) copyFileSync(join(FULL, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

describe("migration 0008: upgrading a database that already has staff requests and conversation events", () => {
  let before: string;
  let t: TestDb;
  const q = (sql: string, params: unknown[] = []) => t.pool.query(sql, params);

  beforeAll(async () => {
    expect(BEFORE).toBe(8);
    before = folderBefore0008();
    t = await createTestDatabase({ migrate: false });
    await migrate(t.db, { migrationsFolder: before });
  });
  afterAll(async () => {
    await t.close();
    rmSync(before, { recursive: true, force: true });
  });

  it("keeps every existing row byte-for-byte apart from the new columns, which are STAFF / NULL", async () => {
    // Raw SQL on purpose: this database has the schema of its time (0007).
    const org = (
      await q("insert into organizations (name, slug) values ('Org', 'org-0008') returning id")
    ).rows[0].id;
    const account = (
      await q(
        "insert into whatsapp_accounts (organization_id, waba_id, phone_number_id, display_phone_number, status) values ($1,'200000000000801','100000000000801','+94 77 000 0801','ACTIVE') returning id",
        [org],
      )
    ).rows[0].id;
    const user = (
      await q("insert into users (name, email) values ('S', 's0008@example.com') returning id")
    ).rows[0].id;
    const member = (
      await q(
        "insert into organization_memberships (organization_id, user_id, role) values ($1,$2,'ADMIN') returning id",
        [org, user],
      )
    ).rows[0].id;
    const contact = (
      await q(
        "insert into contacts (organization_id, wa_id, first_seen_at, last_seen_at) values ($1,'94770800001', now(), now()) returning id",
        [org],
      )
    ).rows[0].id;
    const conversation = (
      await q(
        "insert into conversations (organization_id, whatsapp_account_id, contact_id, last_message_at, last_inbound_at) values ($1,$2,$3, now(), now()) returning id",
        [org, account, contact],
      )
    ).rows[0].id;
    await q(
      "insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_status, to_status) values ($1,$2,'STATUS',$3,'OPEN','PENDING')",
      [org, conversation, member],
    );
    // one staff request in each state the 0004 lifecycle allows at rest
    const states: Array<[string, string]> = [
      ["QUEUED", ""],
      ["SENDING", ", claimed_by = 'w', claimed_at = now(), send_started_at = now()"],
      [
        "ACCEPTED",
        ", claimed_by = 'w', send_started_at = now(), accepted_at = now(), finished_at = now()",
      ],
      ["HELD", ", hold_reason = 'window_closed', finished_at = now()"],
      [
        "UNKNOWN_OUTCOME",
        ", claimed_by = 'w', send_started_at = now(), failure_code = 'transport_timeout', finished_at = now()",
      ],
    ];
    for (const [i, [state]] of states.entries()) {
      const message = (
        await q(
          "insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at) values ($1,$2,$3,'OUTBOUND','TEXT','m', now()) returning id",
          [org, conversation, account],
        )
      ).rows[0].id;
      await q(
        `insert into outbound_requests (organization_id, whatsapp_account_id, conversation_id, message_id, requested_by_membership_id,
           idempotency_key, request_fingerprint, message_type, recipient_kind, recipient_id, payload, state, dispatch_deadline,
           claimed_by, send_started_at, accepted_at, hold_reason, failure_code, finished_at)
         values ($1,$2,$3,$4,$5,$6, repeat('a',64), 'TEXT','PHONE','94770800001','{"body":"m"}'::jsonb, $7, now() + interval '15 minutes',
           $8, $9, $10, $11, $12, $13)`,
        [
          org,
          account,
          conversation,
          message,
          member,
          `key-0008-${i}-abcdef`,
          state,
          state === "QUEUED" || state === "HELD" ? null : "w",
          state === "QUEUED" || state === "HELD" ? null : new Date(),
          state === "ACCEPTED" ? new Date() : null,
          state === "HELD" ? "window_closed" : null,
          state === "UNKNOWN_OUTCOME" ? "transport_timeout" : null,
          state === "QUEUED" || state === "SENDING" ? null : new Date(),
        ],
      );
    }
    const snapshot = async () =>
      (
        await q(
          `select to_jsonb(r) - 'origin' - 'bot_session_id' - 'bot_step_seq' - 'bot_send_epoch' - 'control_seq' as row
             from outbound_requests r
           union all
           select to_jsonb(e) - 'control_seq' from conversation_events e
           union all
           select to_jsonb(c) from conversations c
           order by 1`,
        )
      ).rows;
    const beforeRows = await snapshot();

    await migrate(t.db, { migrationsFolder: FULL });

    expect(await snapshot()).toEqual(beforeRows);
    expect(
      (
        await q(
          "select origin, bot_session_id, bot_step_seq, bot_send_epoch, control_seq, count(*)::int n from outbound_requests group by 1,2,3,4,5",
        )
      ).rows,
    ).toEqual([
      {
        origin: "STAFF",
        bot_session_id: null,
        bot_step_seq: null,
        bot_send_epoch: null,
        control_seq: null,
        n: 5,
      },
    ]);
    expect((await q("select control_seq from conversation_events")).rows).toEqual([
      { control_seq: null },
    ]);
    expect((await q("select control_seq from conversations")).rows).toEqual([{ control_seq: "0" }]);
    // the 0004 staff idempotency constraint still applies to staff rows
    expect(
      (
        await q(
          "select 1 from pg_constraint where conname = 'outbound_requests_idempotency_unique'",
        )
      ).rowCount,
    ).toBe(1);
    // the guard was replaced, not dropped: an existing staff request's content is still immutable
    await expectPgError(
      q("update outbound_requests set payload = '{\"body\":\"x\"}'::jsonb where state = 'QUEUED'"),
      CHECK_VIOLATION,
    );
    // a new staff event after the upgrade gets the next control sequence of its conversation
    await q(
      "insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_status, to_status) values ($1,$2,'STATUS',$3,'PENDING','OPEN')",
      [org, conversation, member],
    );
    expect(
      (await q("select control_seq from conversation_events where to_status = 'OPEN'")).rows,
    ).toEqual([{ control_seq: "1" }]);
    for (const name of [
      "bot_request_hold_code",
      "outbound_requests_allocate_control_seq",
      "conversation_events_allocate_control_seq",
    ])
      expect((await q("select 1 from pg_proc where proname = $1", [name])).rowCount, name).toBe(1);
    // re-running the migrator is a no-op
    const n = (await q("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n;
    await migrate(t.db, { migrationsFolder: FULL });
    expect((await q("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n).toBe(n);
    expect(n).toBe(journal.entries.length);
  });
});
