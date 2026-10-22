import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { insertBotTriggerIfAdmitted } from "@/db/ops/bot-trigger";
import {
  claimTriggersSql,
  endConversationTriggersSql,
  lockTerminalizationCandidateSql,
  terminalizationCandidatesSql,
  wakeConversationTriggersSql,
} from "@/db/ops/bot-trigger-queue";
import { botWorld, deployedBot } from "../bot-control/testing";

// EXPLAIN evidence for the 08E-3 queue statements and the 08E-2 capture-admission statement (plan O-4; Phase 08E-3 task 7).
// OPT-IN: it does nothing unless BOT_QUEUE_EXPLAIN=1, so it never slows or flakes the ordinary database suite. It seeds a
// representative volume into a DISPOSABLE al_ict_test_* database (never al_ict_whatsapp; the harness refuses anything else),
// runs ANALYZE, and prints the real plans produced by EXPLAIN (ANALYZE, BUFFERS) on THIS server. Each statement runs in a
// transaction that is rolled back. The test asserts nothing about timing or plan shape: it records evidence for a human
// decision about migration 0009 (which is NOT authorized). Nothing here is evidence until it has been run.
//
//   BOT_QUEUE_EXPLAIN=1 TEST_DATABASE_ADMIN_URL='postgresql://<user>:<password>@127.0.0.1:55432/postgres' \
//     npm run test:db -- src/modules/bot-runtime/queue-explain.db.test.ts
//
// Volume (override with BOT_QUEUE_EXPLAIN_CONVERSATIONS): 6,000 conversations x 10 inbound messages = 60,000 messages and
// 60,000 triggers, about 0.5 % PENDING and due, 0.1 % PENDING and exhausted, the rest finished (the terminal rows a 14-day
// retention keeps around).

const CONVERSATIONS = Number(process.env.BOT_QUEUE_EXPLAIN_CONVERSATIONS ?? 6_000);
const dialect = new PgDialect();

describe.skipIf(process.env.BOT_QUEUE_EXPLAIN !== "1")("EXPLAIN evidence (opt-in)", () => {
  let t: TestDb;
  let org = "";
  let account = "";
  let conversation = "";
  let message = "";
  const plans: string[] = [];

  async function explain(label: string, statement: SQL | { text: string; params: unknown[] }) {
    const rendered =
      "text" in statement
        ? statement
        : { text: dialect.sqlToQuery(statement).sql, params: dialect.sqlToQuery(statement).params };
    const client = await t.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, SETTINGS) ${rendered.text}`,
        rendered.params,
      );
      const lines = result.rows.map((r) => String((r as Record<string, unknown>)["QUERY PLAN"]));
      plans.push(`\n=== EXPLAIN ${label} ===\n${lines.join("\n")}`);
      expect(lines.length).toBeGreaterThan(0);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  }

  beforeAll(async () => {
    t = await createTestDatabase({
      sessionTimeouts: {
        statement_timeout: 120_000,
        lock_timeout: 10_000,
        idle_in_transaction_session_timeout: 120_000,
      },
    });
    const w = await botWorld(t.db);
    await deployedBot(t.db, w);
    org = w.org.id;
    account = w.account.id;
    const waId = (i: number) => `9477${String(i).padStart(8, "0")}`;
    const now = new Date();
    for (let from = 0; from < CONVERSATIONS; from += 1_000) {
      const n = Math.min(1_000, CONVERSATIONS - from);
      const contacts = await t.db
        .insert(schema.contacts)
        .values(
          Array.from({ length: n }, (_, i) => ({
            organizationId: org,
            waId: waId(from + i + 1),
            firstSeenAt: now,
            lastSeenAt: now,
          })),
        )
        .returning({ id: schema.contacts.id });
      await t.db.insert(schema.conversations).values(
        contacts.map((c) => ({
          organizationId: org,
          whatsappAccountId: account,
          contactId: c.id,
          lastMessageAt: now,
          lastInboundAt: now,
        })),
      );
    }
    await t.pool.query(
      `insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at, wamid)
       select c.organization_id, c.id, c.whatsapp_account_id, 'INBOUND', 'TEXT', 'x',
              clock_timestamp() - (g * interval '1 minute'), 'wamid.' || c.id::text || '.' || g::text
         from conversations c cross join generate_series(1, 10) g
        where c.organization_id = $1`,
      [org],
    );
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
                 from messages m where m.organization_id = $1) x`,
      [org],
    );
    await t.pool.query(
      "analyze bot_triggers, messages, conversations, bot_sessions, bot_deployments, outbound_requests",
    );
    const sample = await t.pool.query(
      `select c.id as conversation_id, m.id as message_id from conversations c join messages m
         on m.organization_id = c.organization_id and m.conversation_id = c.id
        where c.organization_id = $1 order by c.id, m.id limit 1`,
      [org],
    );
    conversation = sample.rows[0].conversation_id as string;
    message = sample.rows[0].message_id as string;
  }, 600_000);

  afterAll(async () => {
    // one block, so the evidence can be copied out of the test output whole
    const version = (await t.pool.query("show server_version")).rows[0].server_version;
    const sizes = await t.pool.query(
      `select relname, reltuples::bigint as rows, pg_size_pretty(pg_total_relation_size(oid)) as size
         from pg_class where relname in ('bot_triggers','messages','conversations') and relkind = 'r' order by relname`,
    );
    const pending = await t.pool.query(
      `select status, attempts = 6 as exhausted, count(*)::int n from bot_triggers group by 1, 2 order by 1, 2`,
    );
    console.log(
      `\n##### BOT QUEUE EXPLAIN EVIDENCE: PostgreSQL ${version}; ${CONVERSATIONS} conversations #####\n` +
        `tables: ${JSON.stringify(sizes.rows)}\ntriggers: ${JSON.stringify(pending.rows)}${plans.join("\n")}\n##### END #####`,
    );
    if (t) await t.close();
  });

  it("claim (T0)", async () => {
    await explain(
      "claim: 10 triggers, 6 claims, 60 s lease",
      claimTriggersSql({ limit: 10, leaseMs: 60_000, maxClaims: 6 }),
    );
  });

  it("terminalization candidates and the candidate lock", async () => {
    await explain(
      "terminalization candidates",
      terminalizationCandidatesSql({ maxClaims: 6, leaseMs: 60_000 }, 10),
    );
    const exhausted = await t.pool.query(
      "select id, organization_id, conversation_id from bot_triggers where status = 'PENDING' and attempts = 6 limit 1",
    );
    const row = exhausted.rows[0] as
      { id: string; organization_id: string; conversation_id: string } | undefined;
    if (row)
      await explain(
        "terminalization candidate lock",
        lockTerminalizationCandidateSql(
          { organizationId: row.organization_id, id: row.id, conversationId: row.conversation_id },
          { maxClaims: 6, leaseMs: 60_000 },
        ),
      );
  });

  it("wake and end for one conversation", async () => {
    await explain(
      "wake",
      wakeConversationTriggersSql({ organizationId: org, conversationId: conversation }),
    );
    await explain(
      "end",
      endConversationTriggersSql({ organizationId: org, conversationId: conversation }),
    );
  });

  it("the 08E-2 capture-admission statement (previously deferred)", async () => {
    let captured: SQL | undefined;
    await insertBotTriggerIfAdmitted(
      {
        execute: async (s: SQL) => {
          captured = s;
          return { rows: [{ inserted: false, reason: "no_deployment" }] };
        },
      } as never,
      {
        organizationId: org,
        whatsappAccountId: account,
        conversationId: conversation,
        messageId: message,
        messageType: "TEXT",
        inputOccurredAt: new Date(),
      },
    );
    expect(captured).toBeDefined();
    await explain(
      "capture admission (executes the INSERT inside a rolled-back transaction)",
      captured!,
    );
  });
});
