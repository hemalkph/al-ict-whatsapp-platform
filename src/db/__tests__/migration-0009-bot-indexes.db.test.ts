import { createHash } from "node:crypto";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFirstEligibleRows, readStartFacts } from "@/db/ops/bot-step";
import {
  addStudent,
  botWorld,
  deployedBot,
  insertSession,
  updateSession,
  type BotWorld,
  type SessionKeys,
} from "../../modules/bot-control/testing"; // test fixtures, imported relatively like every other test
import { createTestDatabase, type TestDb } from "./helpers";

// Migration 0009 (decision O-4, plan L.2): two performance-only bot_sessions indexes, on disposable al_ict_test_* databases
// only. L.2 asks for a pinned-hash test for 0000-0008, an upgrade test from a database at 0008 with representative rows, and
// raw-SQL tests that the indexes exist and are usable by the 08E queries. The fresh path is also covered by every other
// database test (they migrate from empty).

const FULL = fileURLToPath(new URL("../migrations", import.meta.url));
const TAG = "0009_bot_runtime_indexes";
const journal = JSON.parse(readFileSync(join(FULL, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ tag: string; when: number }>;
};
const BEFORE = journal.entries.findIndex((e) => e.tag === TAG);

const PINNED: Record<string, string> = {
  "0000_init_foundation_schema": "f32afe09d834c149dd7d1405ae1d5d4b4392b73b2025d5fc0d3b19e6030ccb8b",
  "0001_auth_and_access_foundation":
    "884f5297d34e213b78fcc0514868fc87e34bb03b4b6edb005833cb234202e98c",
  "0002_whatsapp_webhook_ingest_and_bsuid_identity":
    "9b152887fa4ebdbf49743c761a1494b3274550ce2bcf14da81f0770f373f2ab0",
  "0003_lead_attribution_message_unique":
    "c6dba16be8f5a08806a61ec568e3b63c82bbcf2d8c1b5aace76c9e32e550e17d",
  "0004_outbound_requests_and_templates":
    "fcb82c48950859ede62d5fbdcc10ed7559608291af41109aab50ea32e4e542c4",
  "0005_staff_inbox_workflow": "d875b3221911fc9222f5a582b9cda117bd67eafec683efb6206da83cf204fab3",
  "0006_leads_lifecycle_and_attribution_integrity":
    "27dd6768054d0386418281f8c094ed21259610370343d868104229d4ae4f9bd4",
  "0007_bot_foundation": "98232660a569710ca1dcfe89ce4c59d6d112a9cdf5cb0da25d365e2376dcf6b2",
  "0008_bot_outbound_dispatch": "db4b6428481c5b5e4445832534e2a845f769595f82b332dbb1a2171977fac465",
};

/** The exact definitions PostgreSQL reports for the two approved indexes (pg_indexes.indexdef). */
const INDEXES = {
  bot_sessions_conversation_idx:
    "CREATE INDEX bot_sessions_conversation_idx ON public.bot_sessions USING btree (organization_id, conversation_id)",
  bot_sessions_contact_started_idx:
    "CREATE INDEX bot_sessions_contact_started_idx ON public.bot_sessions USING btree (organization_id, contact_id, started_at)",
};

function folderBefore0009(): string {
  const dir = mkdtempSync(join(tmpdir(), "al-ict-migrations-pre0009-"));
  mkdirSync(join(dir, "meta"));
  const kept = journal.entries.slice(0, BEFORE);
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: kept }, null, 2),
  );
  for (const e of kept) copyFileSync(join(FULL, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

async function catalog(t: TestDb) {
  return (
    await t.pool.query(
      `select i.indexname, i.indexdef, x.indisunique, x.indisvalid, x.indisready, x.indpred is null as no_predicate
         from pg_indexes i
         join pg_class c on c.relname = i.indexname and c.relkind = 'i'
         join pg_index x on x.indexrelid = c.oid
        where i.schemaname = 'public' and i.tablename = 'bot_sessions' and i.indexname = any($1)
        order by i.indexname`,
      [Object.keys(INDEXES)],
    )
  ).rows;
}
const expectedCatalog = Object.entries(INDEXES)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([indexname, indexdef]) => ({
    indexname,
    indexdef,
    indisunique: false,
    indisvalid: true,
    indisready: true,
    no_predicate: true,
  }));

describe("migration 0009: the files", () => {
  it("migrations 0000 to 0008 are byte-for-byte what was committed, and 0009 follows them", () => {
    expect(journal.entries.slice(0, 10).map((e) => e.tag)).toEqual([...Object.keys(PINNED), TAG]);
    for (const [tag, sha] of Object.entries(PINNED))
      expect(
        createHash("sha256")
          .update(readFileSync(join(FULL, `${tag}.sql`)))
          .digest("hex"),
        tag,
      ).toBe(sha);
    expect(journal.entries[BEFORE]!.when).toBeGreaterThan(1792413044845); // F11: later than 0008
  });

  it("0009 is additive only: the lock_timeout preamble and exactly the two approved CREATE INDEX statements", () => {
    const statements = readFileSync(join(FULL, `${TAG}.sql`), "utf8")
      .split("--> statement-breakpoint")
      .map((s) =>
        s
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter(Boolean);
    expect(statements).toEqual([
      "SET LOCAL lock_timeout = '5s';",
      'CREATE INDEX "bot_sessions_conversation_idx" ON "bot_sessions" USING btree ("organization_id","conversation_id");',
      'CREATE INDEX "bot_sessions_contact_started_idx" ON "bot_sessions" USING btree ("organization_id","contact_id","started_at");',
    ]);
  });
});

describe("migration 0009: a fresh database", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase(); // empty database, every committed migration
  });
  afterAll(async () => t.close());

  it("migrates through 0009 and has both indexes with exactly the approved definitions", async () => {
    const applied = (await t.pool.query("select count(*)::int n from drizzle.__drizzle_migrations"))
      .rows[0].n;
    expect(applied).toBe(journal.entries.length);
    expect(await catalog(t)).toEqual(expectedCatalog);
  });
});

describe("migration 0009: upgrading a database at 0008 that already holds bot sessions", () => {
  let before: string;
  let t: TestDb;
  let w: BotWorld;
  let other: Awaited<ReturnType<typeof addStudent>>;
  let keys: SessionKeys;
  const q = (sql: string, params: unknown[] = []) => t.pool.query(sql, params);
  const dialect = new PgDialect();

  /** Every row of every table the upgrade could touch, as JSON, in a stable order. */
  const snapshot = async () => ({
    sessions: (await q("select to_jsonb(s) j from bot_sessions s order by id")).rows,
    events: (await q("select to_jsonb(e) j from bot_session_events e order by id")).rows,
    conversations: (await q("select to_jsonb(c) j from conversations c order by id")).rows,
    messages: (await q("select to_jsonb(m) j from messages m order by id")).rows,
    deployments: (await q("select to_jsonb(d) j from bot_deployments d order by id")).rows,
    otherIndexes: (
      await q(
        "select indexname, indexdef from pg_indexes where schemaname = 'public' and not (indexname = any($1)) order by indexname",
        [Object.keys(INDEXES)],
      )
    ).rows,
    constraints: (
      await q(
        "select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2",
      )
    ).rows,
    triggers: (
      await q(
        "select tgrelid::regclass::text t, tgname from pg_trigger where not tgisinternal order by 1, 2",
      )
    ).rows,
  });

  /** The production statements, run on THIS database with the chosen planner settings (the result must not depend on them). */
  async function productionFacts(settings: string[]) {
    const client = await t.pool.connect();
    try {
      await client.query("begin transaction read only");
      for (const s of settings) await client.query(s);
      const tx = {
        execute: async (s: SQL) => {
          const r = dialect.sqlToQuery(s);
          return { rows: (await client.query(r.sql, r.params)).rows };
        },
      } as never;
      const clock = (await client.query("select clock_timestamp() t")).rows[0].t as Date;
      const facts = await readStartFacts(tx, {
        organizationId: w.org.id,
        conversationId: w.student.conversation.id,
        contactId: w.student.contact.id,
        decisionClock: clock,
        contactWindowMs: 24 * 60 * 60 * 1000,
      });
      const first = await readFirstEligibleRows(tx, {
        organizationId: w.org.id,
        conversationId: w.student.conversation.id,
        messageId: w.student.message.id,
      });
      const otherFirst = await readFirstEligibleRows(tx, {
        organizationId: w.org.id,
        conversationId: other.conversation.id,
        messageId: other.message.id,
      });
      return {
        lastSessionEndedAt: facts.lastSessionEndedAt?.toISOString() ?? null,
        latestHandoverSeq: facts.latestHandoverSeq,
        lastConsumedInputAt: facts.lastConsumedInputAt?.toISOString() ?? null,
        contactStarts: facts.contactSessionStarts.map((d) => d.toISOString()).sort(),
        botRequestInFlight: facts.botRequestInFlight,
        first,
        otherFirst,
      };
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  }

  beforeAll(async () => {
    expect(BEFORE).toBe(9);
    before = folderBefore0009();
    t = await createTestDatabase({ migrate: false });
    await migrate(t.db, { migrationsFolder: before });
    // representative rows at 0008: completed, handed-over and live sessions of one conversation, and an unrelated contact
    w = await botWorld(t.db);
    const d = await deployedBot(t.db, w);
    keys = {
      organizationId: w.org.id,
      botId: d.bot.id,
      versionId: d.version.id,
      deploymentId: d.deployment.id,
      whatsappAccountId: w.account.id,
      student: w.student,
    };
    const s1 = await insertSession(t.pool, keys, {
      last_input_message_id: w.student.message.id,
      last_input_occurred_at: new Date("2026-10-20T10:00:00Z"),
    });
    await updateSession(t.pool, s1.id as string, "state = 'COMPLETED', end_reason = 'flow_end'");
    const s2 = await insertSession(t.pool, keys);
    await updateSession(
      t.pool,
      s2.id as string,
      "state = 'HANDED_OVER', end_reason = 'flow_handover', handover_reason = 'needs_staff', output_suppressed_at = clock_timestamp()",
    );
    await insertSession(t.pool, keys, { expires_at: new Date(Date.now() + 600_000) });
    other = await addStudent(t.db, w.org.id, w.account.id);
    await insertSession(t.pool, { ...keys, student: other });
    expect(await catalog(t)).toEqual([]); // the indexes do not exist before 0009
  });
  afterAll(async () => {
    await t.close();
    rmSync(before, { recursive: true, force: true });
  });

  it("adds exactly the two indexes and keeps every existing row, index, constraint and trigger unchanged", async () => {
    const beforeRows = await snapshot();
    const beforeFacts = await productionFacts([]);
    expect(beforeRows.sessions.map((r) => (r.j as { state: string }).state).sort()).toEqual([
      "COMPLETED",
      "HANDED_OVER",
      "WAITING_FOR_INPUT",
      "WAITING_FOR_INPUT",
    ]);

    await migrate(t.db, { migrationsFolder: FULL });

    expect(await snapshot()).toEqual(beforeRows);
    expect(await catalog(t)).toEqual(expectedCatalog);
    // ownership and references still resolve for every session (same organization, conversation, contact, deployment)
    expect(
      (
        await q(
          `select count(*)::int n from bot_sessions s
             join conversations c on c.organization_id = s.organization_id and c.id = s.conversation_id
                                 and c.contact_id = s.contact_id and c.whatsapp_account_id = s.whatsapp_account_id
             join messages m on m.organization_id = s.organization_id and m.conversation_id = s.conversation_id
                            and m.id = s.started_by_message_id
             join bot_deployments d on d.organization_id = s.organization_id and d.id = s.deployment_id
                                   and d.bot_id = s.bot_id and d.whatsapp_account_id = s.whatsapp_account_id`,
        )
      ).rows[0].n,
    ).toBe(4);
    // the production reads return what they returned at 0008
    expect(await productionFacts([])).toEqual(beforeFacts);
    // re-running the migrator is a no-op
    const n = (await q("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n;
    await migrate(t.db, { migrationsFolder: FULL });
    expect((await q("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n).toBe(n);
    expect(n).toBe(journal.entries.length);
  });

  it("the representative production reads give identical, correct results through the new indexes and without them", async () => {
    const viaIndexes = await productionFacts(["set local enable_seqscan = off"]);
    const withoutIndexes = await productionFacts([
      "set local enable_indexscan = off",
      "set local enable_bitmapscan = off",
      "set local enable_indexonlyscan = off",
    ]);
    expect(viaIndexes).toEqual(withoutIndexes);
    const expected = (
      await q(
        `select max(ended_at) last_ended, max(handover_control_seq)::int handover, max(last_input_occurred_at) last_input
           from bot_sessions where organization_id = $1 and conversation_id = $2`,
        [w.org.id, w.student.conversation.id],
      )
    ).rows[0];
    expect(viaIndexes.lastSessionEndedAt).toBe((expected.last_ended as Date).toISOString());
    expect(viaIndexes.latestHandoverSeq).toBe(expected.handover);
    expect(viaIndexes.lastConsumedInputAt).toBe((expected.last_input as Date).toISOString());
    expect(viaIndexes.contactStarts).toHaveLength(3); // the student's three sessions; the other contact's is not counted
    expect(viaIndexes.first).toEqual({
      firstInRecordHistory: true,
      noPreviousSessionStart: false, // all-state session history fence
      evidenceDefect: false,
    });
    expect(viaIndexes.otherFirst).toMatchObject({ noPreviousSessionStart: false });
  });

  it("EXPLAIN: on a representative distribution PostgreSQL serves the 08E history and cap reads from the new indexes", async () => {
    // Availability, not a fixed plan for every dataset: on the four-row upgrade fixture the planner legitimately prefers an
    // older (organization_id, ...) index. So this transaction adds a representative distribution (500 contacts, one
    // conversation each, 4 sessions per conversation through the normal guard and allocator), ANALYZEs it, disables sequential
    // scans so only index paths compete, and is ROLLED BACK (rows and statistics). Disposable database only.
    const client = await t.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local statement_timeout = '60s'");
      await client.query(
        `with c as (
           insert into contacts (organization_id, wa_id, first_seen_at, last_seen_at)
           select $1, '9479' || lpad(g::text, 8, '0'), now(), now() from generate_series(1, 500) g returning id),
         v as (
           insert into conversations (organization_id, whatsapp_account_id, contact_id, last_message_at, last_inbound_at)
           select $1, $2, c.id, now(), now() from c returning id)
         insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at, wamid)
         select $1, v.id, $2, 'INBOUND', 'TEXT', 'x', now(), 'wamid.0009.' || v.id::text from v`,
        [w.org.id, w.account.id],
      );
      for (let k = 0; k < 4; k++) {
        // two statements: a data-modifying CTE's UPDATE would not see the rows its own INSERT added
        const inserted = await client.query(
          `insert into bot_sessions (organization_id, bot_id, bot_version_id, deployment_id, whatsapp_account_id, contact_id,
               conversation_id, started_by_message_id, state, current_node_id)
           select c.organization_id, $2, $3, $4, c.whatsapp_account_id, c.contact_id, c.id, m.id, 'WAITING_FOR_INPUT', 'welcome'
             from conversations c join messages m on m.organization_id = c.organization_id and m.conversation_id = c.id
                                                 and m.wamid = 'wamid.0009.' || c.id::text
            where c.organization_id = $1
           returning id`,
          [w.org.id, keys.botId, keys.versionId, keys.deploymentId],
        );
        await client.query(
          "update bot_sessions set state = 'COMPLETED', end_reason = 'flow_end', revision = revision + 1 where id = any($1::uuid[])",
          [inserted.rows.map((r) => r.id as string)],
        );
      }
      expect((await client.query("select count(*)::int n from bot_sessions")).rows[0].n).toBe(2004);
      await client.query("analyze bot_sessions");
      await client.query("set local enable_seqscan = off");
      const plan = async (text: string, params: unknown[]) =>
        JSON.stringify((await client.query(`EXPLAIN (FORMAT JSON) ${text}`, params)).rows[0]);
      // the production statement shapes (readStartFacts' per-contact cap and its conversation history aggregate)
      const cap = await plan(
        "SELECT started_at FROM bot_sessions WHERE organization_id = $1 AND contact_id = $2 AND started_at > $3::timestamptz - $4 * interval '1 millisecond'",
        [w.org.id, w.student.contact.id, new Date().toISOString(), 86_400_000],
      );
      expect(cap).toContain('"Index Name":"bot_sessions_contact_started_idx"');
      const history = await plan(
        "SELECT max(ended_at) FROM bot_sessions WHERE organization_id = $1 AND conversation_id = $2",
        [w.org.id, w.student.conversation.id],
      );
      expect(history).toContain('"Index Name":"bot_sessions_conversation_idx"');
      const fence = await plan(
        "SELECT NOT EXISTS (SELECT 1 FROM bot_sessions s WHERE s.organization_id = $1 AND s.conversation_id = $2) AS no_previous",
        [w.org.id, w.student.conversation.id],
      );
      expect(fence).toContain('"Index Name":"bot_sessions_conversation_idx"');
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
    expect((await q("select count(*)::int n from bot_sessions")).rows[0].n).toBe(4); // rolled back
  });
});
