import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, seedAccount, type TestDb } from "@/db/__tests__/helpers";
import { readFirstEligibleRows, readStartFacts } from "@/db/ops/bot-step";
import { countRecentBotRequests, reconcileCandidatesSql } from "@/db/ops/bot-session-store";
import { insertBotTriggerIfAdmitted } from "@/db/ops/bot-trigger";
import {
  claimTriggersSql,
  endConversationTriggersSql,
  lockTerminalizationCandidateSql,
  terminalizationCandidatesSql,
  wakeConversationTriggersSql,
} from "@/db/ops/bot-trigger-queue";
import { botWorld, deployedBot, type BotWorld } from "../bot-control/testing";
import { RUNTIME_POLICY } from "./policy";

// EXPLAIN evidence for the 08E queue statements, the 08E-2 capture-admission statement and the plan L.2 / O-4 candidate queries
// (per-contact session cap, cooldown / latest session end, session sweeper, hourly BOT request cap, and the first_message
// session fence), with a BEFORE/AFTER comparison of two candidate bot_sessions indexes. OPT-IN: it does nothing unless
// BOT_QUEUE_EXPLAIN=1, so it never slows or flakes the ordinary database suite. It seeds a bounded synthetic two-tenant volume
// into a DISPOSABLE al_ict_test_<12 hex> database (createTestDatabase creates it, applies the unchanged migrations 0000-0008
// to it alone, and drops only that database), runs ANALYZE, and prints the plans. It asserts nothing about timing or plan
// shape: it records evidence for a human decision about migration 0009 (which is NOT authorized). The candidate indexes exist
// only inside this run's own database, created after an exact current_database() check, and vanish with it.
//
//   BOT_QUEUE_EXPLAIN=1 TEST_DATABASE_ADMIN_URL='postgresql://<user>:<password>@127.0.0.1:55432/postgres' \
//     npm run test:db -- src/modules/bot-runtime/queue-explain.db.test.ts --silent=false
//   (--silent=false only prints the evidence block, which vitest hides for passing tests; BOT_QUEUE_EXPLAIN_CONVERSATIONS
//   overrides the size, default 6,000)
//
// EXPLAIN SAFETY (owner decision, Batch 5). Every EXPLAIN runs inside a READ ONLY transaction that is rolled back.
//  - "analyze": EXPLAIN (ANALYZE, BUFFERS, SETTINGS), ONLY for reviewed plain SELECTs that take no row lock and call no
//    side-effecting function (clock_timestamp() is volatile but has no side effect). READ ONLY makes any write an error.
//  - "plan": plain EXPLAIN (SETTINGS), never executed, for every data-modifying statement (claim, wake, end, capture admission)
//    and every SELECT ... FOR UPDATE (the terminalization candidate lock). A rollback does NOT make an executed write read-only.
// The write-overhead measurement is NOT an EXPLAIN: it executes a bounded batch of session INSERT/UPDATE statements through the
// normal guard and allocator in a transaction of this disposable database that is always rolled back.
//
// EXACT QUERY SHAPES. The L.2 statements are the production statements themselves: readStartFacts, readFirstEligibleRows and
// countRecentBotRequests are called with a recording executor that captures each SQL object (and returns a minimal row so the
// function completes); reconcileCandidatesSql is the production builder with the production parameters of listCandidates. The
// statements are captured ONCE (one frozen decision clock) and the identical SQL and parameters run before and after the
// candidate indexes. The sweeper evaluates clock_timestamp() itself, so its "now" moves by the seconds between the two phases.
// Phase order: fingerprint -> baseline reads -> baseline write batches (rolled back) -> VACUUM (ANALYZE) bot_sessions (reclaims
// only the dead tuples of those rolled-back batches) -> candidate indexes -> ANALYZE -> same fingerprint asserted -> indexed
// reads -> indexed write batches. Read timings are a median of 3 warm executions; buffers are those of the last execution.
//
// DATASET (bounded, synthetic; N = BOT_QUEUE_EXPLAIN_CONVERSATIONS):
//  - tenant A: N conversations (one contact each) x 10 inbound TEXT messages; tenant B: N/4 conversations, same shape.
//  - bot_triggers: one per inbound message, about 0.6 % PENDING (0.1 % exhausted), the rest finished.
//  - bot_sessions: 4 per conversation, except about 5 % of the conversations, which have NO session (the "empty" probe).
//    Session 1 started 0-48 h ago (about 5 % live: half WAITING_FOR_INPUT expiring 10 minutes after start, half
//    WAITING_FOR_SEND), sessions 2-4 terminal, about 7, 14 and 21 days old; 70 % COMPLETED, 30 % HANDED_OVER.
//  - one HEAVY tenant A contact with one conversation on each of three WhatsApp accounts (two extra accounts, each with its own
//    deployment), 10 inbound messages and HEAVY_SESSIONS terminal sessions per conversation, started 43 h apart (the newest
//    30 minutes ago), so the contact has 3 x HEAVY_SESSIONS sessions across conversations and 3 inside the 24 h window.
//  - outbound_requests: BOT, 3 per session 1 and 2 per session 2, created 20 s apart from the session start, ACCEPTED except
//    the latest request of a WAITING_FOR_SEND session (QUEUED); STAFF, 1 per tenant A conversation, created 0-1,000 minutes ago.
//    Each request has its own OUTBOUND message. Only requests of sessions started within the last hour are in the hourly window.
//  Session and request times are not correlated with the inbound message times; no L.2 statement joins them.
//
// REPLICA-MODE SEED. The bot_sessions guard stamps started_at/ended_at with the database clock, so the varied session history is
// inserted with session_replication_role = replica, set LOCAL to one seeding transaction of this disposable database. That
// skips EVERY trigger on the inserted rows: the guard, the FK (RI) triggers and the control-sequence allocator. Consequently:
//  - foreign keys are NOT enforced during the seed (CHECK and UNIQUE constraints are, but they prove nothing about references);
//    every bot_sessions foreign key is therefore re-verified afterwards, row by row, from the catalog (checkSessionReferences);
//  - started_control_seq / handover_control_seq are synthetic constants, conversations.control_seq is NOT advanced for them,
//    and seeded control sequences are not representative of operational allocations. No E-CTL (control-sequence) property
//    holds for this fixture, and no statement here reads control sequences of bot_sessions for its decision.
// Everything seeded after the replica transaction (requests, messages) goes through the normal triggers and foreign keys.

const CONVERSATIONS = Number(process.env.BOT_QUEUE_EXPLAIN_CONVERSATIONS ?? 6_000);
const OTHER_CONVERSATIONS = Math.ceil(CONVERSATIONS / 4);
const HEAVY_SESSIONS = 100;
/** Write-overhead batch: sessions inserted, updated (live) and ended per repetition, always rolled back. */
const WRITE_BATCH = 2_000;
const WRITE_REPS = 3;
const MEASURE_REPS = 3;
const CANDIDATES = [
  "CREATE INDEX bot_sessions_conversation_idx ON bot_sessions (organization_id, conversation_id)",
  "CREATE INDEX bot_sessions_contact_started_idx ON bot_sessions (organization_id, contact_id, started_at DESC)",
] as const;
const dialect = new PgDialect();

type Mode = "analyze" | "plan";
type Row = Record<string, unknown>;
type Statement = SQL | { text: string; params: unknown[] };
type Phase = "baseline" | "indexed";
type PlanNode = Row & { Plans?: PlanNode[] };
type Measured = {
  planMs: number;
  execMs: number;
  execRuns: number[];
  estRows: number;
  actRows: number;
  hit: number;
  read: number;
  indexes: string[];
  outline: string[];
};
type Probe = { role: string; conversation: string; contact: string; message: string };

describe.skipIf(process.env.BOT_QUEUE_EXPLAIN !== "1")("EXPLAIN evidence (opt-in)", () => {
  let t: TestDb;
  let a: BotWorld;
  let ownDatabase = "";
  let org = "";
  let account = "";
  let deploymentA: Awaited<ReturnType<typeof deployedBot>>;
  let conversation = "";
  let message = "";
  let probes: Probe[] = [];
  /** The L.2 statements, captured once and replayed identically in both phases. */
  const l2: { key: string; statement: Statement }[] = [];
  const results = new Map<string, Partial<Record<Phase, Measured>>>();
  const writes: Partial<Record<Phase, Row[]>> = {};
  const plans: string[] = [];
  const facts: string[] = [];

  const render = (statement: Statement) => {
    if ("text" in statement) return statement;
    const q = dialect.sqlToQuery(statement);
    return { text: q.sql, params: q.params };
  };
  /** Reviewed read-only SELECTs only: no data-modifying statement and no row lock may reach EXPLAIN ANALYZE. */
  function assertReadOnlySelect(text: string) {
    expect(text).toMatch(/^\s*(WITH\b[\s\S]*?\)\s*)?SELECT\b/i);
    expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|FOR\s+(UPDATE|SHARE|NO KEY|KEY))\b/i);
  }
  async function readOnly<T>(
    body: (q: (s: string, p?: unknown[]) => Promise<Row[]>) => Promise<T>,
  ) {
    const client = await t.pool.connect();
    try {
      await client.query("begin transaction read only");
      await client.query("set local statement_timeout = '60s'");
      return await body(async (s, p = []) => (await client.query(s, p)).rows as Row[]);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  }

  /** Queue and capture evidence (text plans). */
  async function explain(label: string, mode: Mode, statement: Statement) {
    const rendered = render(statement);
    if (mode === "analyze") assertReadOnlySelect(rendered.text);
    const options = mode === "analyze" ? "ANALYZE, BUFFERS, SETTINGS" : "SETTINGS";
    const lines = await readOnly(async (q) =>
      (await q(`EXPLAIN (${options}) ${rendered.text}`, rendered.params)).map((r) =>
        String(r["QUERY PLAN"]),
      ),
    );
    plans.push(
      `\n=== EXPLAIN [${mode === "analyze" ? "ANALYZE, read-only SELECT" : "plan only, not executed"}] ${label} ===\n` +
        `-- params: ${JSON.stringify(rendered.params)}\n${rendered.text.replace(/\s+/g, " ").trim()}\n${lines.join("\n")}`,
    );
    expect(lines.length).toBeGreaterThan(0);
  }

  /** One L.2 statement, MEASURE_REPS executions of EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON); the last plan is kept. */
  async function measure(statement: Statement): Promise<Measured> {
    const rendered = render(statement);
    assertReadOnlySelect(rendered.text);
    const runs: Row[] = [];
    for (let i = 0; i < MEASURE_REPS; i++)
      runs.push(
        await readOnly(async (q) => {
          const [r] = await q(
            `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) ${rendered.text}`,
            rendered.params,
          );
          return (r!["QUERY PLAN"] as Row[])[0]!;
        }),
      );
    const last = runs[runs.length - 1]!;
    const root = last.Plan as PlanNode;
    const indexes = new Set<string>();
    const outline: string[] = [];
    const walk = (n: PlanNode, depth: number) => {
      if (typeof n["Index Name"] === "string") indexes.add(n["Index Name"]);
      const target = [n["Relation Name"], n["Index Name"]].filter(Boolean).join(" / ");
      outline.push(
        `${"  ".repeat(depth)}${n["Parent Relationship"] === "InitPlan" || n["Parent Relationship"] === "SubPlan" ? `[${String(n["Subplan Name"] ?? n["Parent Relationship"])}] ` : ""}` +
          `${String(n["Node Type"])}${n["Scan Direction"] === "Backward" ? " Backward" : ""}${target ? ` on ${target}` : ""}` +
          ` est=${String(n["Plan Rows"])} act=${String(n["Actual Rows"])}x${String(n["Actual Loops"])}` +
          ` hit=${String(n["Shared Hit Blocks"])} read=${String(n["Shared Read Blocks"])}` +
          (n["Rows Removed by Filter"] ? ` removed=${String(n["Rows Removed by Filter"])}` : ""),
      );
      for (const c of n.Plans ?? []) walk(c, depth + 1);
    };
    walk(root, 0);
    const exec = runs.map((r) => Number(r["Execution Time"])).sort((x, y) => x - y);
    return {
      planMs: Number(last["Planning Time"]),
      execMs: exec[Math.floor(exec.length / 2)]!,
      execRuns: runs.map((r) => Number(r["Execution Time"])),
      estRows: Number(root["Plan Rows"]),
      actRows: Number(root["Actual Rows"]),
      hit: Number(root["Shared Hit Blocks"]),
      read: Number(root["Shared Read Blocks"]),
      indexes: [...indexes].sort(),
      outline,
    };
  }

  /** Runs a production read function against a recording executor and returns the SQL objects it would execute. */
  async function capture(run: (tx: never) => Promise<unknown>, rows: Row[][]): Promise<SQL[]> {
    const captured: SQL[] = [];
    await run({
      execute: async (s: SQL) => {
        captured.push(s);
        return { rows: rows[captured.length - 1] ?? [] };
      },
    } as never);
    return captured;
  }

  const one = async (text: string, params: unknown[] = []) =>
    (await t.pool.query(text, params)).rows[0] as Row;

  /** Contacts, conversations, inbound messages (created_at = occurred_at) and triggers of one tenant. */
  async function seedTenant(w: BotWorld, n: number, waPrefix: string) {
    const now = new Date();
    for (let from = 0; from < n; from += 1_000) {
      const size = Math.min(1_000, n - from);
      const contacts = await t.db
        .insert(schema.contacts)
        .values(
          Array.from({ length: size }, (_, i) => ({
            organizationId: w.org.id,
            waId: `${waPrefix}${String(from + i + 1).padStart(8, "0")}`,
            firstSeenAt: now,
            lastSeenAt: now,
          })),
        )
        .returning({ id: schema.contacts.id });
      await t.db.insert(schema.conversations).values(
        contacts.map((c) => ({
          organizationId: w.org.id,
          whatsappAccountId: w.account.id,
          contactId: c.id,
          lastMessageAt: now,
          lastInboundAt: now,
        })),
      );
    }
    await inboundMessages(w.org.id);
    await t.pool.query(
      `insert into bot_triggers (organization_id, whatsapp_account_id, conversation_id, message_id, input_occurred_at,
          observed_control_seq, enqueued_at, next_attempt_at, status, outcome_code, attempts, processed_at)
       select x.organization_id, x.whatsapp_account_id, x.conversation_id, x.id, x.occurred_at, 0, x.occurred_at, x.occurred_at,
              x.st, case x.st when 'PENDING' then null when 'PROCESSED' then 'processed' else 'ignored' end,
              case when x.r = 5 then 6 else 0 end,
              case when x.st = 'PENDING' then null else x.occurred_at + interval '1 second' end
         from (select m.*, abs(hashtext(m.id::text)) % 1000 as r,
                      case when abs(hashtext(m.id::text)) % 1000 < 6 then 'PENDING'
                           when abs(hashtext(m.id::text)) % 1000 < 500 then 'PROCESSED' else 'IGNORED' end as st
                 from messages m where m.organization_id = $1 and m.direction = 'INBOUND') x`,
      [w.org.id],
    );
  }
  /** 10 inbound TEXT messages for every conversation of the organization that has none yet. */
  async function inboundMessages(orgId: string) {
    await t.pool.query(
      `insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at, created_at, wamid)
       select c.organization_id, c.id, c.whatsapp_account_id, 'INBOUND', 'TEXT', 'x',
              clock_timestamp() - (g * interval '1 minute'), clock_timestamp() - (g * interval '1 minute'),
              'wamid.' || c.id::text || '.' || g::text
         from conversations c cross join generate_series(1, 10) g
        where c.organization_id = $1
          and not exists (select 1 from messages x where x.organization_id = c.organization_id and x.conversation_id = c.id
                                                    and x.wamid like 'wamid.' || c.id::text || '.%')`,
      [orgId],
    );
  }

  /** One replica-mode seeding transaction (see REPLICA-MODE SEED); the setting is LOCAL and ends with the transaction. */
  async function replicaSeed(text: string, params: unknown[]) {
    const client = await t.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      await client.query(text, params);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    expect((await one("show session_replication_role")).session_replication_role).toBe("origin");
  }

  /** 4 sessions per conversation of the tenant's main account (about 5 % of the conversations get none; see DATASET). */
  async function seedSessions(d: Awaited<ReturnType<typeof deployedBot>>, w: BotWorld) {
    await replicaSeed(
      `insert into bot_sessions (organization_id, bot_id, bot_version_id, deployment_id, whatsapp_account_id, contact_id,
          conversation_id, started_by_message_id, state, current_node_id, step_seq, revision, last_input_message_id,
          last_input_occurred_at, started_control_seq, handover_control_seq, started_at, expires_at, send_wait_expires_at,
          ended_at, end_reason, handover_reason)
       select c.organization_id, $2, $3, $4, c.whatsapp_account_id, c.contact_id, c.id, m.id, x.state, 'welcome', 3, 3, m.id,
              x.started_at, k, case when x.state = 'HANDED_OVER' then 1000 + k end, x.started_at,
              case when x.state = 'WAITING_FOR_INPUT' then x.started_at + interval '10 minutes' end,
              case when x.state = 'WAITING_FOR_SEND' then x.started_at + interval '2 minutes' end,
              case when x.state in ('COMPLETED', 'HANDED_OVER') then x.started_at + interval '3 minutes' end,
              case x.state when 'COMPLETED' then 'flow_end' when 'HANDED_OVER' then 'system_handover' end,
              case when x.state = 'HANDED_OVER' then 'bot_error' end
         from conversations c
         cross join generate_series(1, 4) k
         join messages m on m.organization_id = c.organization_id and m.whatsapp_account_id = c.whatsapp_account_id
                        and m.wamid = 'wamid.' || c.id::text || '.' || k::text
         cross join lateral (
           select case when k = 1 then clock_timestamp() - (h.v * interval '172.8 seconds')
                       else clock_timestamp() - ((k - 1) * interval '7 days') - (h.v * interval '1 minute') end as started_at,
                  case when k = 1 and h.w < 25 then 'WAITING_FOR_INPUT'
                       when k = 1 and h.w < 50 then 'WAITING_FOR_SEND'
                       when h.w % 10 < 7 then 'COMPLETED' else 'HANDED_OVER' end as state
             from (select abs(hashtext(c.id::text || '/' || k::text)) % 1000 as v,
                          abs(hashtext(c.id::text || '#' || k::text)) % 1000 as w) h) x
        where c.organization_id = $1 and c.whatsapp_account_id = $5
          and abs(hashtext(c.id::text || '!')) % 20 <> 0`,
      [w.org.id, d.bot.id, d.version.id, d.deployment.id, w.account.id],
    );
  }

  /** The HEAVY contact: one conversation on each of three accounts (main + two extra, each deployed), HEAVY_SESSIONS each. */
  async function seedHeavyContact(w: BotWorld, d: Awaited<ReturnType<typeof deployedBot>>) {
    const now = new Date();
    const [contact] = await t.db
      .insert(schema.contacts)
      .values({ organizationId: w.org.id, waId: "947900000001", firstSeenAt: now, lastSeenAt: now })
      .returning({ id: schema.contacts.id });
    const lanes: { account: string; deployment: Awaited<ReturnType<typeof deployedBot>> }[] = [
      { account: w.account.id, deployment: d },
    ];
    for (let i = 0; i < 2; i++) {
      const extra = await seedAccount(t.db, w.org.id);
      lanes.push({
        account: extra.id,
        deployment: await deployedBot(t.db, { ...w, account: extra } as BotWorld),
      });
    }
    const conversations: string[] = [];
    for (const lane of lanes) {
      const [c] = await t.db
        .insert(schema.conversations)
        .values({
          organizationId: w.org.id,
          whatsappAccountId: lane.account,
          contactId: contact!.id,
          lastMessageAt: now,
          lastInboundAt: now,
        })
        .returning({ id: schema.conversations.id });
      conversations.push(c!.id);
    }
    await inboundMessages(w.org.id);
    for (const [i, lane] of lanes.entries())
      await replicaSeed(
        `insert into bot_sessions (organization_id, bot_id, bot_version_id, deployment_id, whatsapp_account_id, contact_id,
            conversation_id, started_by_message_id, state, current_node_id, step_seq, revision, last_input_message_id,
            last_input_occurred_at, started_control_seq, handover_control_seq, started_at, ended_at, end_reason, handover_reason)
         select c.organization_id, $2, $3, $4, c.whatsapp_account_id, c.contact_id, c.id, m.id, x.state, 'welcome', 3, 3, m.id,
                x.started_at, k, case when x.state = 'HANDED_OVER' then 1000 + k end, x.started_at,
                x.started_at + interval '3 minutes',
                case x.state when 'COMPLETED' then 'flow_end' else 'system_handover' end,
                case when x.state = 'HANDED_OVER' then 'bot_error' end
           from conversations c
           cross join generate_series(1, ${HEAVY_SESSIONS}) k
           join messages m on m.organization_id = c.organization_id and m.whatsapp_account_id = c.whatsapp_account_id
                          and m.wamid = 'wamid.' || c.id::text || '.' || (1 + (k - 1) % 10)::text
           cross join lateral (
             select clock_timestamp() - interval '30 minutes' - (k - 1) * interval '43 hours' as started_at,
                    case when abs(hashtext(c.id::text || '#' || k::text)) % 10 < 7 then 'COMPLETED'
                         else 'HANDED_OVER' end as state) x
          where c.organization_id = $1 and c.id = $5`,
        [
          w.org.id,
          lane.deployment.bot.id,
          lane.deployment.version.id,
          lane.deployment.deployment.id,
          conversations[i],
        ],
      );
    return { contact: contact!.id, conversations };
  }

  /** BOT requests of sessions 1 (3 steps) and 2 (2 steps), each with its own OUTBOUND message; normal triggers and FKs apply. */
  async function seedBotRequests(orgId: string) {
    const steps = `from bot_sessions s cross join generate_series(1, 3) step
                    where s.organization_id = $1 and s.started_control_seq <= 2
                      and step <= case when s.started_control_seq = 1 then 3 else 2 end`;
    await t.pool.query(
      `insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at, created_at, wamid)
       select s.organization_id, s.conversation_id, s.whatsapp_account_id, 'OUTBOUND', 'TEXT', 'bot',
              s.started_at + step * interval '20 seconds', s.started_at + step * interval '20 seconds',
              'wamid.bot.' || s.id::text || '.' || step::text ${steps}`,
      [orgId],
    );
    await t.pool.query(
      `insert into outbound_requests (organization_id, whatsapp_account_id, conversation_id, message_id, idempotency_key,
          request_fingerprint, message_type, recipient_kind, recipient_id, payload, state, dispatch_deadline, created_at,
          origin, bot_session_id, bot_step_seq, bot_send_epoch, send_started_at, accepted_at, finished_at)
       select s.organization_id, s.whatsapp_account_id, s.conversation_id, m.id, 'bot-' || s.id::text || '-' || step::text,
              encode(sha256(convert_to(s.id::text || '/' || step::text, 'UTF8')), 'hex'), 'TEXT', 'PHONE', ct.wa_id,
              '{"text":"bot"}'::jsonb, q.state, m.occurred_at + interval '5 minutes', m.occurred_at, 'BOT', s.id, step, 1,
              case when q.state = 'ACCEPTED' then m.occurred_at end, case when q.state = 'ACCEPTED' then m.occurred_at end,
              case when q.state = 'ACCEPTED' then m.occurred_at end
         from bot_sessions s
         join contacts ct on ct.organization_id = s.organization_id and ct.id = s.contact_id
         cross join generate_series(1, 3) step
         join messages m on m.organization_id = s.organization_id and m.whatsapp_account_id = s.whatsapp_account_id
                        and m.wamid = 'wamid.bot.' || s.id::text || '.' || step::text
         cross join lateral (
           select case when s.state = 'WAITING_FOR_SEND' and step = 3 then 'QUEUED' else 'ACCEPTED' end as state) q
        where s.organization_id = $1`,
      [orgId],
    );
  }

  /** One STAFF request per tenant A main-account conversation (BOT-origin selectivity for the hourly cap and in-flight check). */
  async function seedStaffRequests(w: BotWorld) {
    await t.pool.query(
      `insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at, created_at, wamid)
       select c.organization_id, c.id, c.whatsapp_account_id, 'OUTBOUND', 'TEXT', 'staff',
              clock_timestamp() - (abs(hashtext(c.id::text)) % 1000) * interval '1 minute',
              clock_timestamp() - (abs(hashtext(c.id::text)) % 1000) * interval '1 minute',
              'wamid.staff.' || c.id::text
         from conversations c where c.organization_id = $1 and c.whatsapp_account_id = $2`,
      [w.org.id, w.account.id],
    );
    await t.pool.query(
      `insert into outbound_requests (organization_id, whatsapp_account_id, conversation_id, message_id, requested_by_membership_id,
          idempotency_key, request_fingerprint, message_type, recipient_kind, recipient_id, payload, state, dispatch_deadline,
          created_at, origin, send_started_at, accepted_at, finished_at)
       select c.organization_id, c.whatsapp_account_id, c.id, m.id, $2, 'staff-' || c.id::text,
              encode(sha256(convert_to('staff/' || c.id::text, 'UTF8')), 'hex'), 'TEXT', 'PHONE', ct.wa_id,
              '{"text":"staff"}'::jsonb, 'ACCEPTED', m.occurred_at + interval '5 minutes', m.occurred_at, 'STAFF',
              m.occurred_at, m.occurred_at, m.occurred_at
         from conversations c
         join contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
         join messages m on m.organization_id = c.organization_id and m.whatsapp_account_id = c.whatsapp_account_id
                        and m.wamid = 'wamid.staff.' || c.id::text
        where c.organization_id = $1`,
      [w.org.id, w.staff.membershipId],
    );
  }

  /**
   * Every foreign key of bot_sessions, read from the catalog, re-verified row by row (MATCH SIMPLE: a row with a NULL key column
   * is not checked, as PostgreSQL does). Returns the per-constraint count of violating rows. All but the plain organization FK
   * include organization_id, so a reference into another tenant is a violation too.
   */
  async function checkSessionReferences(): Promise<
    { name: string; cols: string[]; bad: number }[]
  > {
    const fks = (
      await t.pool.query(
        `select c.conname, c.confrelid::regclass::text as ref,
                array(select a.attname from unnest(c.conkey) with ordinality k(n, i)
                        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.i)::text[] as cols,
                array(select a.attname from unnest(c.confkey) with ordinality k(n, i)
                        join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by k.i)::text[] as refcols
           from pg_constraint c where c.conrelid = 'bot_sessions'::regclass and c.contype = 'f' order by c.conname`,
      )
    ).rows as { conname: string; ref: string; cols: string[]; refcols: string[] }[];
    const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
    const out: { name: string; cols: string[]; bad: number }[] = [];
    for (const fk of fks) {
      const notNull = fk.cols.map((c) => `s.${q(c)} is not null`).join(" and ");
      const match = fk.cols.map((c, i) => `r.${q(fk.refcols[i]!)} = s.${q(c)}`).join(" and ");
      const r = await one(
        `select count(*)::int as n from bot_sessions s where ${notNull}
           and not exists (select 1 from ${fk.ref} r where ${match})`,
      );
      out.push({ name: fk.conname, cols: fk.cols, bad: Number(r.n) });
    }
    return out;
  }

  beforeAll(async () => {
    t = await createTestDatabase({
      sessionTimeouts: {
        statement_timeout: 120_000,
        lock_timeout: 10_000,
        idle_in_transaction_session_timeout: 120_000,
      },
    });
    // the harness refuses anything but a generated al_ict_test_<hex> database; re-check before writing a single row
    const db = await one(
      "select current_database() d, current_setting('server_version_num')::int v",
    );
    ownDatabase = db.d as string;
    expect(ownDatabase).toMatch(/^al_ict_test_[0-9a-f]{12}$/);
    expect(ownDatabase).toBe(t.target.database);
    expect(db.v as number).toBeGreaterThanOrEqual(170_000);

    a = await botWorld(t.db);
    deploymentA = await deployedBot(t.db, a);
    org = a.org.id;
    account = a.account.id;
    const b = await botWorld(t.db);
    const db2 = await deployedBot(t.db, b);
    await seedTenant(a, CONVERSATIONS, "9477");
    await seedTenant(b, OTHER_CONVERSATIONS, "9478");
    // planner statistics before the set-based seeding joins (without them the session seed join is a nested-loop scan)
    await t.pool.query("analyze messages, conversations, contacts");
    await seedSessions(deploymentA, a);
    await seedSessions(db2, b);
    const heavy = await seedHeavyContact(a, deploymentA);
    await t.pool.query("analyze bot_sessions, messages, conversations");
    await seedBotRequests(a.org.id);
    await seedBotRequests(b.org.id);
    await seedStaffRequests(a);

    // the replica-mode seed skipped the RI triggers: every bot_sessions foreign key is verified here, by name
    const references = await checkSessionReferences();
    facts.push(
      `bot_sessions foreign keys re-verified (violating rows): ${JSON.stringify(references)}`,
    );
    expect(references.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        "bot_sessions_organization_id_organizations_id_fk",
        "bot_sessions_conversation_account_fk",
        "bot_sessions_conversation_contact_fk",
        "bot_sessions_started_by_message_fk",
        "bot_sessions_last_input_message_fk",
        "bot_sessions_bot_version_fk",
        "bot_sessions_deployment_fk",
      ]),
    );
    for (const r of references) {
      expect(r.bad, r.name).toBe(0);
      if (r.name !== "bot_sessions_organization_id_organizations_id_fk")
        expect(r.cols, r.name).toContain("organization_id"); // tenant-scoped reference
    }
    // the start message is an eligible INBOUND message (a runtime rule, not a foreign key)
    expect(
      (
        await one(
          `select count(*)::int n from bot_sessions s join messages m on m.organization_id = s.organization_id
              and m.conversation_id = s.conversation_id and m.id = s.started_by_message_id
            where not (m.direction = 'INBOUND' and m.type in ('TEXT','INTERACTIVE','BUTTON'))`,
        )
      ).n,
    ).toBe(0);

    await t.pool.query(
      "analyze bot_triggers, messages, conversations, contacts, bot_sessions, bot_deployments, outbound_requests, conversation_events",
    );
    const sample = await t.pool.query(
      `select c.id as conversation_id, m.id as message_id from conversations c join messages m
         on m.organization_id = c.organization_id and m.conversation_id = c.id
        where c.organization_id = $1 order by c.id, m.id limit 1`,
      [org],
    );
    conversation = sample.rows[0].conversation_id as string;
    message = sample.rows[0].message_id as string;

    const g5 = (conv: string) =>
      `(select id from messages where organization_id = $1 and conversation_id = ${conv} and wamid like 'wamid.%.5')`;
    const recent = await one(
      `select s.conversation_id, s.contact_id, ${g5("s.conversation_id")} as message_id from bot_sessions s
        where s.organization_id = $1 and s.started_control_seq = 1 and s.state = 'COMPLETED' and s.whatsapp_account_id = $2
          and s.started_at between clock_timestamp() - interval '50 minutes' and clock_timestamp() - interval '2 minutes'
        order by s.started_at desc, s.id limit 1`,
      [org, account],
    );
    const empty = await one(
      `select c.id as conversation_id, c.contact_id, ${g5("c.id")} as message_id from conversations c
        where c.organization_id = $1 and c.whatsapp_account_id = $2
          and not exists (select 1 from bot_sessions s where s.organization_id = c.organization_id and s.contact_id = c.contact_id)
          and exists (select 1 from messages m where m.organization_id = c.organization_id and m.conversation_id = c.id)
        order by c.id limit 1`,
      [org, account],
    );
    const heavyMain = heavy.conversations[0]!;
    const heavyMessage = await one(`select ${g5("$2")} as message_id`, [org, heavyMain]);
    probes = [
      {
        role: "recent (matching conversation, latest session 2-50 min ago)",
        conversation: recent.conversation_id as string,
        contact: recent.contact_id as string,
        message: recent.message_id as string,
      },
      {
        role: "empty (no session history for the conversation or the contact)",
        conversation: empty.conversation_id as string,
        contact: empty.contact_id as string,
        message: empty.message_id as string,
      },
      {
        role: `heavy (conversation with ${HEAVY_SESSIONS} sessions; contact with ${3 * HEAVY_SESSIONS} sessions across 3 conversations)`,
        conversation: heavyMain,
        contact: heavy.contact,
        message: heavyMessage.message_id as string,
      },
    ];
    for (const p of probes)
      expect(Object.values(p).every((v) => typeof v === "string" && v !== "")).toBe(true);
  }, 600_000);

  afterAll(async () => {
    if (!t) return;
    try {
      if (probes.length > 0) await collectEvidence();
    } finally {
      // always: the harness drops the database it created (no FORCE). If sessions remain it refuses; the name is reported.
      await t.close().catch((e: unknown) => {
        console.error(`test-owned database ${t.target.database} was NOT dropped: ${String(e)}`);
        throw e;
      });
    }
  });

  async function collectEvidence() {
    const q = async (text: string, params: unknown[] = []) =>
      JSON.stringify((await t.pool.query(text, params)).rows);
    const version = (await t.pool.query("show server_version")).rows[0].server_version;
    facts.push(
      `database: ${ownDatabase}`,
      `tables: ${await q(
        `select relname, reltuples::bigint as rows, pg_size_pretty(pg_total_relation_size(oid)) as size
           from pg_class where relname in ('bot_triggers','messages','conversations','contacts','bot_sessions','outbound_requests')
            and relkind = 'r' order by relname`,
      )}`,
      `triggers: ${await q("select status, attempts = 6 as exhausted, count(*)::int n from bot_triggers group by 1, 2 order by 1, 2")}`,
      `sessions by tenant/state: ${await q(
        `select organization_id = $1 as tenant_a, state, count(*)::int n,
                count(*) filter (where started_at > clock_timestamp() - interval '24 hours')::int started_24h,
                count(*) filter (where state = 'WAITING_FOR_INPUT' and expires_at <= clock_timestamp())::int input_expired
           from bot_sessions group by 1, 2 order by 1 desc, 2`,
        [org],
      )}`,
      `session history distribution (tenant A conversations by session count): ${await q(
        `select n_sessions, count(*)::int conversations from (
           select c.id, (select count(*) from bot_sessions s where s.organization_id = c.organization_id
                                                             and s.conversation_id = c.id)::int n_sessions
             from conversations c where c.organization_id = $1) x group by 1 order by 1`,
        [org],
      )}`,
      `requests by tenant/origin/state: ${await q(
        `select organization_id = $1 as tenant_a, origin, state, count(*)::int n,
                count(*) filter (where created_at > clock_timestamp() - interval '1 hour')::int last_hour
           from outbound_requests group by 1, 2, 3 order by 1 desc, 2, 3`,
        [org],
      )}`,
    );
    for (const p of probes)
      facts.push(
        `probe ${p.role}: ${JSON.stringify(p)} conversation_sessions=${await q(
          "select count(*)::int n, max(ended_at) last_ended from bot_sessions where organization_id = $1 and conversation_id = $2",
          [org, p.conversation],
        )} contact_sessions=${await q(
          `select count(*)::int n, count(distinct conversation_id)::int conversations,
                  count(*) filter (where started_at > clock_timestamp() - interval '24 hours')::int in_24h
             from bot_sessions where organization_id = $1 and contact_id = $2`,
          [org, p.contact],
        )} bot_requests_last_hour=${await q(
          "select count(*)::int n from outbound_requests where organization_id = $1 and conversation_id = $2 and origin = 'BOT' and created_at > clock_timestamp() - interval '1 hour'",
          [org, p.conversation],
        )}`,
      );
    facts.push(
      `indexes:\n${(
        await t.pool.query(
          `select tablename || ': ' || indexdef as d from pg_indexes
            where tablename in ('bot_sessions','outbound_requests','bot_triggers','messages') order by tablename, indexname`,
        )
      ).rows
        .map((r) => (r as Row).d)
        .join("\n")}`,
    );
    const table: string[] = [
      "\n=== L.2 BASELINE vs INDEXED (median of 3 executions; buffers and rows of the last run; root totals) ===",
      "key | phase | plan ms | exec ms (runs) | est/act rows | shared hit/read | indexes used",
    ];
    const outlines: string[] = [];
    for (const [key, r] of results)
      for (const phase of ["baseline", "indexed"] as const) {
        const m = r[phase];
        if (!m) continue;
        table.push(
          `${key} | ${phase} | ${m.planMs.toFixed(3)} | ${m.execMs.toFixed(3)} (${m.execRuns.map((x) => x.toFixed(3)).join(", ")}) | ` +
            `${m.estRows}/${m.actRows} | ${m.hit}/${m.read} | ${m.indexes.join(", ")}`,
        );
        outlines.push(`\n--- ${key} [${phase}] ---\n${m.outline.join("\n")}`);
      }
    const writeLines = (["baseline", "indexed"] as const).map(
      (phase) => `write overhead ${phase}: ${JSON.stringify(writes[phase] ?? [])}`,
    );
    console.log(
      `\n##### BOT QUEUE EXPLAIN EVIDENCE: PostgreSQL ${version}; tenant A ${CONVERSATIONS} conversations, tenant B ${OTHER_CONVERSATIONS} #####\n` +
        `${facts.join("\n")}${plans.join("\n")}\n${table.join("\n")}\n${writeLines.join("\n")}${outlines.join("\n")}\n##### END #####`,
    );
  }

  /** Every L.2 statement of every probe, captured once from the production functions (one frozen decision clock). */
  async function captureL2() {
    const decisionClock = (await one("select clock_timestamp() t")).t as Date;
    for (const [i, p] of probes.entries()) {
      const label = `P${i + 1}`;
      const start = await capture(
        (tx) =>
          readStartFacts(tx, {
            organizationId: org,
            conversationId: p.conversation,
            contactId: p.contact,
            decisionClock,
            contactWindowMs: RUNTIME_POLICY.contactSessionWindowMs,
          }),
        [
          [
            {
              max_staff: null,
              latest_non_resolution: null,
              legacy_non_resolution: false,
              latest_handover: null,
            },
          ],
          [],
          [{ in_flight: false, last_ended: null, last_input: null, contact_archived: false }],
          [],
        ],
      );
      expect(start).toHaveLength(4);
      const [first] = await capture(
        (tx) =>
          readFirstEligibleRows(tx, {
            organizationId: org,
            conversationId: p.conversation,
            messageId: p.message,
          }),
        [[{ first_in_record: true, no_previous: true, defect: false }]],
      );
      const [hourly] = await capture(
        (tx) =>
          countRecentBotRequests(
            tx,
            org,
            p.conversation,
            decisionClock,
            RUNTIME_POLICY.hourlyWindowMs,
          ),
        [[{ n: 0 }]],
      );
      l2.push(
        { key: `${label} start facts 1 (staff seqs + latest handover)`, statement: start[0]! },
        {
          key: `${label} start facts 3 (cooldown: max ended_at, last input, in-flight)`,
          statement: start[2]!,
        },
        { key: `${label} start facts 4 (per-contact cap, 24 h)`, statement: start[3]! },
        {
          key: `${label} first_message facts (record order + session fence + defect)`,
          statement: first!,
        },
        { key: `${label} hourly BOT cap`, statement: hourly! },
      );
    }
    l2.push({
      key: "sweeper (reconcileCandidatesSql, limit 50)",
      statement: reconcileCandidatesSql({
        queuedGraceMs: RUNTIME_POLICY.queuedDeadlineGraceMs,
        limit: 50,
      }),
    });
  }

  async function measureAll(phase: Phase) {
    for (const s of l2) {
      const r = results.get(s.key) ?? {};
      r[phase] = await measure(s.statement);
      results.set(s.key, r);
    }
  }

  /**
   * Write overhead, NOT an EXPLAIN: WRITE_REPS repetitions of one transaction that inserts WRITE_BATCH live sessions through the
   * normal guard and allocator, updates them once while live (revision/step only) and then ends them (COMPLETED), and is ROLLED
   * BACK. Elapsed time and WAL bytes per step, plus this transaction's own n_tup_upd / n_tup_hot_upd for bot_sessions.
   */
  async function writeOverhead(phase: Phase) {
    const out: Row[] = [];
    for (let rep = 0; rep < WRITE_REPS; rep++) {
      const client = await t.pool.connect();
      try {
        await client.query("begin");
        await client.query("set local statement_timeout = '120s'");
        const mark = async () =>
          (
            await client.query(
              "select clock_timestamp() t, pg_current_wal_insert_lsn()::text l, (select n_tup_upd from pg_stat_xact_user_tables where relname = 'bot_sessions') upd, (select n_tup_hot_upd from pg_stat_xact_user_tables where relname = 'bot_sessions') hot",
            )
          ).rows[0] as { t: Date; l: string; upd: string; hot: string };
        const diff = async (x: { l: string }, y: { l: string }) =>
          Number(
            (await client.query("select pg_wal_lsn_diff($2, $1)::bigint d", [x.l, y.l])).rows[0].d,
          );
        const m0 = await mark();
        const inserted = await client.query(
          `insert into bot_sessions (organization_id, bot_id, bot_version_id, deployment_id, whatsapp_account_id, contact_id,
              conversation_id, started_by_message_id, state, current_node_id, expires_at)
           select c.organization_id, $2, $3, $4, c.whatsapp_account_id, c.contact_id, c.id, m.id, 'WAITING_FOR_INPUT', 'welcome',
                  clock_timestamp() + interval '10 minutes'
             from conversations c
             join messages m on m.organization_id = c.organization_id and m.whatsapp_account_id = c.whatsapp_account_id
                            and m.wamid = 'wamid.' || c.id::text || '.6'
            where c.organization_id = $1 and c.whatsapp_account_id = $5
              and not exists (select 1 from bot_sessions s where s.organization_id = c.organization_id and s.conversation_id = c.id
                                and s.state in ('ACTIVE','WAITING_FOR_SEND','WAITING_FOR_INPUT'))
            order by c.id limit ${WRITE_BATCH}
           returning id`,
          [org, deploymentA.bot.id, deploymentA.version.id, deploymentA.deployment.id, account],
        );
        const ids = inserted.rows.map((r) => (r as Row).id as string);
        const m1 = await mark();
        await client.query(
          "update bot_sessions set revision = revision + 1, step_seq = step_seq + 1 where id = any($1::uuid[])",
          [ids],
        );
        const m2 = await mark();
        await client.query(
          "update bot_sessions set revision = revision + 1, state = 'COMPLETED', end_reason = 'flow_end', expires_at = null where id = any($1::uuid[])",
          [ids],
        );
        const m3 = await mark();
        const ms = (x: { t: Date }, y: { t: Date }) => y.t.getTime() - x.t.getTime();
        out.push({
          rep,
          rows: ids.length,
          insertMs: ms(m0, m1),
          insertWal: await diff(m0, m1),
          liveUpdateMs: ms(m1, m2),
          liveUpdateWal: await diff(m1, m2),
          liveUpdates: Number(m2.upd) - Number(m1.upd),
          liveHot: Number(m2.hot) - Number(m1.hot),
          endUpdateMs: ms(m2, m3),
          endUpdateWal: await diff(m2, m3),
          endUpdates: Number(m3.upd) - Number(m2.upd),
          endHot: Number(m3.hot) - Number(m2.hot),
        });
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }
    }
    expect(out.every((r) => r.rows === WRITE_BATCH)).toBe(true);
    writes[phase] = out;
  }

  /** The seeded rows themselves: identical in both phases (only rolled-back write batches ever touch bot_sessions). */
  const fixtureFingerprint = async () =>
    one(
      "select count(*)::int as n, md5(string_agg(id::text || ':' || state || ':' || revision::text, ',' order by id)) as h from bot_sessions",
    );
  let baselineFingerprint: Row = {};

  const sessionIndexSizes = async () =>
    (
      await t.pool.query(
        `select indexrelid::regclass::text as name, pg_relation_size(indexrelid)::bigint as bytes
           from pg_index where indrelid = 'bot_sessions'::regclass order by 1`,
      )
    ).rows as { name: string; bytes: string }[];

  // ------------------------------------------------------------------------------------------- queue (08E-3) and capture (08E-2)

  it("claim (T0)", async () => {
    await explain(
      "claim: 10 triggers, 6 claims, 60 s lease (UPDATE ... FOR UPDATE SKIP LOCKED)",
      "plan",
      claimTriggersSql({ limit: 10, leaseMs: 60_000, maxClaims: 6 }),
    );
  });

  it("terminalization candidates and the candidate lock", async () => {
    await explain(
      "terminalization candidates",
      "analyze",
      terminalizationCandidatesSql({ maxClaims: 6, leaseMs: 60_000 }, 10),
    );
    const exhausted = await t.pool.query(
      "select id, organization_id, conversation_id from bot_triggers where status = 'PENDING' and attempts = 6 limit 1",
    );
    const row = exhausted.rows[0] as
      { id: string; organization_id: string; conversation_id: string } | undefined;
    if (row)
      await explain(
        "terminalization candidate lock (SELECT ... FOR UPDATE SKIP LOCKED)",
        "plan",
        lockTerminalizationCandidateSql(
          { organizationId: row.organization_id, id: row.id, conversationId: row.conversation_id },
          { maxClaims: 6, leaseMs: 60_000 },
        ),
      );
  });

  it("wake and end for one conversation", async () => {
    await explain(
      "wake (UPDATE)",
      "plan",
      wakeConversationTriggersSql({ organizationId: org, conversationId: conversation }),
    );
    await explain(
      "end (UPDATE)",
      "plan",
      endConversationTriggersSql({ organizationId: org, conversationId: conversation }),
    );
  });

  it("the 08E-2 capture-admission statement", async () => {
    const [captured] = await capture(
      (tx) =>
        insertBotTriggerIfAdmitted(tx, {
          organizationId: org,
          whatsappAccountId: account,
          conversationId: conversation,
          messageId: message,
          messageType: "TEXT",
          inputOccurredAt: new Date(),
        }),
      [[{ inserted: false, reason: "no_deployment" }]],
    );
    expect(captured).toBeDefined();
    await explain("capture admission (INSERT ... ON CONFLICT)", "plan", captured!);
  });

  // ------------------------------------------------------------------------------------------- L.2 / O-4 candidates

  it("L.2 baseline: every probe and statement without the candidate indexes, plus the write overhead", async () => {
    await captureL2();
    baselineFingerprint = await fixtureFingerprint();
    facts.push(
      `fixture fingerprint (baseline): ${JSON.stringify(baselineFingerprint)}`,
      `bot_sessions index sizes (baseline, before any write batch): ${JSON.stringify(await sessionIndexSizes())}`,
    );
    await measureAll("baseline");
    await writeOverhead("baseline");
    // the rolled-back write batches left dead heap tuples and index entries; reclaim them so the indexed phase reads the same
    // live rows through equally clean existing indexes (VACUUM removes only tuples no transaction can see; live rows unchanged)
    await t.pool.query("vacuum (analyze) bot_sessions");
    facts.push(
      `bot_sessions index sizes (after the baseline write batches and VACUUM; pages are reused, not returned): ${JSON.stringify(await sessionIndexSizes())}`,
    );
  }, 300_000);

  it("candidate indexes, created only in this run's own disposable database", async () => {
    const client = await t.pool.connect();
    try {
      const db = (await client.query("select current_database() d")).rows[0].d as string;
      expect(db).toBe(ownDatabase);
      expect(db).toBe(t.target.database);
      expect(db).toMatch(/^al_ict_test_[0-9a-f]{12}$/);
      for (const ddl of CANDIDATES) {
        const t0 = Date.now();
        await client.query(ddl);
        facts.push(`created in ${db} (${Date.now() - t0} ms): ${ddl}`);
      }
      await client.query("analyze bot_sessions");
    } finally {
      client.release();
    }
    facts.push(
      `bot_sessions index sizes (candidates just built): ${JSON.stringify(await sessionIndexSizes())}`,
    );
  });

  it("L.2 indexed: the identical statements and parameters with the candidate indexes, plus the write overhead", async () => {
    const fingerprint = await fixtureFingerprint();
    facts.push(`fixture fingerprint (indexed): ${JSON.stringify(fingerprint)}`);
    expect(fingerprint).toEqual(baselineFingerprint); // no fixture row changed between the phases
    await measureAll("indexed");
    await writeOverhead("indexed");
  }, 300_000);
});
