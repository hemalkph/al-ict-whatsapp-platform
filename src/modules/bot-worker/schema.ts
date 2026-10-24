import { sql, TransactionRollbackError } from "drizzle-orm";
import type { DbExecutor } from "@/db/ops/executor";
import { OUTBOUND_REQUEST_STATES } from "@/db/schema/enums";

// The migration 0008 objects the bot worker depends on, verified STRUCTURALLY from the catalog (Phase 08E-7 review): a name
// alone is not enough (a same-name index with other keys, a constraint on another table, a function without its enabled
// trigger, an incompatible overload). Partial-index predicates and the CHECK condition are compared as the server's own
// deparsed text (pg_get_expr, search_path pinned to pg_catalog) against the exact 0008 expressions, and only after pg_depend
// shows they reference no unpinned object other than outbound_requests itself. pg_depend omits PINNED objects (PostgreSQL 17:
// OIDs below FirstUnpinnedObjectId, the bootstrap catalog), so pinned built-ins such as text, = ANY or || are not seen here;
// the exact deparsed-text comparison is what pins those. Not every built-in is pinned (information_schema objects and the
// plpgsql handlers, for example, are not): a reference to one counts as foreign, which only fails closed. Nothing taken from
// the catalog is ever EXECUTED (Phase 08E-8 F-1): a CHECK may call any function, volatile ones included, and a READ ONLY transaction does not stop every
// side effect such a function can have (signals, advisory locks, notifications, external calls). The pure judge is unit-tested.

type RequestState = (typeof OUTBOUND_REQUEST_STATES)[number];

/**
 * EVERY outbound request state, classified (Phase 08E-8 F-2): in flight (holds the session's and the conversation's one BOT
 * send slot) or not. A Record over the state type: a state added to OUTBOUND_REQUEST_STATES fails to compile until classified.
 */
export const IN_FLIGHT_STATES: Readonly<Record<RequestState, boolean>> = Object.freeze({
  QUEUED: true,
  SENDING: true,
  ACCEPTED: false,
  REJECTED: false,
  HELD: false,
  UNKNOWN_OUTCOME: false,
});
const inFlight = OUTBOUND_REQUEST_STATES.filter((s) => IN_FLIGHT_STATES[s]);

// PostgreSQL 17's deparse of the 0008 expressions (non-pretty pg_get_expr): every operator parenthesized, constants typed.
const BOT_ONLY = `(origin = 'BOT'::text)`;
const IN_FLIGHT = `(${BOT_ONLY} AND (state = ANY (ARRAY[${inFlight.map((s) => `'${s}'::text`).join(", ")}])))`;
const BOT_KEY = `(((origin <> 'BOT'::text) OR (idempotency_key = ((('bot-'::text || (bot_session_id)::text) || '-'::text) || (bot_step_seq)::text))) IS TRUE)`;

/** Server-side bound of each catalog read; the pool's transaction_timeout bounds the whole read transaction. */
export const CATALOG_READ_TIMEOUT = "5s";

export const EXPECTED = Object.freeze({
  columns: [
    { table: "outbound_requests", column: "origin", type: "text", notNull: true },
    { table: "outbound_requests", column: "bot_session_id", type: "uuid", notNull: false },
    { table: "outbound_requests", column: "bot_step_seq", type: "integer", notNull: false },
    { table: "outbound_requests", column: "bot_send_epoch", type: "bigint", notNull: false },
    { table: "outbound_requests", column: "control_seq", type: "bigint", notNull: false },
    { table: "conversation_events", column: "control_seq", type: "bigint", notNull: false },
  ],
  /** BEFORE INSERT FOR EACH ROW: pg_trigger.tgtype = ROW(1) | BEFORE(2) | INSERT(4). */
  triggers: [
    {
      name: "outbound_requests_allocate_control_seq_trg",
      table: "outbound_requests",
      fn: "outbound_requests_allocate_control_seq",
      tgtype: 7,
    },
    {
      name: "conversation_events_allocate_control_seq_trg",
      table: "conversation_events",
      fn: "conversation_events_allocate_control_seq",
      tgtype: 7,
    },
  ],
  indexes: [
    {
      name: "outbound_requests_bot_step_uidx",
      columns: ["organization_id", "bot_session_id", "bot_step_seq"],
      predicate: BOT_ONLY,
    },
    {
      name: "outbound_requests_bot_inflight_uidx",
      columns: ["organization_id", "bot_session_id"],
      predicate: IN_FLIGHT,
    },
    {
      name: "outbound_requests_bot_conv_inflight_uidx",
      columns: ["organization_id", "conversation_id"],
      predicate: IN_FLIGHT,
    },
  ],
  constraint: { name: "outbound_requests_bot_key_check", expression: BOT_KEY },
  functions: [
    {
      name: "bot_request_hold_code",
      args: "p_organization_id uuid, p_request_id uuid",
      returns: "text",
    },
    { name: "outbound_requests_allocate_control_seq", args: "", returns: "trigger" },
    { name: "conversation_events_allocate_control_seq", args: "", returns: "trigger" },
  ],
});

export type SchemaFacts = {
  readonly columns: readonly { table: string; column: string; type: string; notNull: boolean }[];
  readonly triggers: readonly {
    name: string;
    table: string;
    enabled: string;
    tgtype: number;
    fnSchema: string;
    fn: string;
    fnArgs: string;
  }[];
  readonly indexes: readonly {
    name: string;
    table: string;
    unique: boolean;
    valid: boolean;
    ready: boolean;
    expressions: boolean;
    columns: readonly string[];
    /** The catalog references nothing but the indexed table (no function, operator, type or collation of its own). */
    selfContained: boolean;
    /** The deparsed predicate (null: none, or not deparsed because the index is not self-contained). */
    predicate: string | null;
  }[];
  readonly constraints: readonly {
    name: string;
    table: string;
    type: string;
    validated: boolean;
    selfContained: boolean;
    expression: string | null;
  }[];
  readonly functions: readonly { name: string; args: string; returns: string }[];
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** PURE: every way the facts differ from migration 0008's objects (empty: compatible). */
export function schemaProblems(f: SchemaFacts): string[] {
  const problems: string[] = [];
  for (const c of EXPECTED.columns) {
    const got = f.columns.find((x) => x.table === c.table && x.column === c.column);
    if (!got || got.type !== c.type || got.notNull !== c.notNull)
      problems.push(`column ${c.table}.${c.column}`);
  }
  for (const t of EXPECTED.triggers) {
    const got = f.triggers.find((x) => x.name === t.name && x.table === t.table);
    if (
      !got ||
      !(got.enabled === "O" || got.enabled === "A") || // origin or always: enabled; D (disabled) and R (replica only) are not
      got.tgtype !== t.tgtype ||
      got.fnSchema !== "public" ||
      got.fn !== t.fn ||
      got.fnArgs !== ""
    )
      problems.push(`trigger ${t.name}`);
  }
  for (const i of EXPECTED.indexes) {
    const got = f.indexes.find((x) => x.name === i.name);
    if (
      !got ||
      got.table !== "outbound_requests" ||
      !got.unique ||
      !got.valid ||
      !got.ready ||
      got.expressions ||
      !same(got.columns, i.columns) ||
      !got.selfContained ||
      got.predicate !== i.predicate
    )
      problems.push(`index ${i.name}`);
  }
  const k = EXPECTED.constraint;
  const con = f.constraints.find((x) => x.name === k.name && x.table === "outbound_requests");
  if (
    !con ||
    con.type !== "c" ||
    !con.validated ||
    !con.selfContained ||
    con.expression !== k.expression
  )
    problems.push(`constraint ${k.name}`);
  for (const fn of EXPECTED.functions)
    if (
      !f.functions.some((x) => x.name === fn.name && x.args === fn.args && x.returns === fn.returns)
    )
      problems.push(`function ${fn.name}(${fn.args})`);
  return problems;
}

/**
 * Reads the catalog facts of the 0008 objects in ONE transaction that is READ ONLY, has a short server-side statement bound,
 * and is always rolled back. Expressions are only deparsed (never evaluated), and only when their dependencies are the table's
 * own columns: deparsing a constant of a foreign type would run that type's output function. Any read failure propagates
 * (the preflight never passes on an error).
 */
export async function readSchemaFacts(db: DbExecutor): Promise<SchemaFacts> {
  let facts: SchemaFacts | undefined;
  try {
    await db.transaction(
      async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${CATALOG_READ_TIMEOUT}'`));
        await tx.execute(sql`SET LOCAL search_path = pg_catalog`); // deparse qualifies anything outside pg_catalog
        facts = await readFacts(tx as unknown as DbExecutor);
        tx.rollback();
      },
      { accessMode: "read only" },
    );
  } catch (error) {
    if (!(error instanceof TransactionRollbackError) || !facts) throw error;
  }
  return facts!;
}

async function readFacts(db: DbExecutor): Promise<SchemaFacts> {
  const columns = await db.execute<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(sql`
    SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name IN ('outbound_requests', 'conversation_events')`);
  const triggers = await db.execute<{
    name: string;
    table_name: string;
    enabled: string;
    tgtype: number;
    fn_schema: string;
    fn: string;
    fn_args: string;
  }>(sql`
    SELECT t.tgname AS name, c.relname AS table_name, t.tgenabled AS enabled, t.tgtype::int AS tgtype,
           pn.nspname AS fn_schema, p.proname AS fn, pg_get_function_identity_arguments(p.oid) AS fn_args
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace cn ON cn.oid = c.relnamespace AND cn.nspname = 'public'
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_namespace pn ON pn.oid = p.pronamespace
     WHERE NOT t.tgisinternal
       AND t.tgname IN ('outbound_requests_allocate_control_seq_trg', 'conversation_events_allocate_control_seq_trg')`);
  // pg_depend records every UNPINNED object an expression uses (pinned bootstrap objects are never recorded; some built-ins are
  // unpinned and so count as foreign, failing closed): anything but the table itself is foreign.
  const indexes = await db.execute<{
    name: string;
    table_name: string;
    unique: boolean;
    valid: boolean;
    ready: boolean;
    expressions: boolean;
    columns: string[];
    self_contained: boolean;
    predicate: string | null;
  }>(sql`
    SELECT x.name, x.table_name, x.unique, x.valid, x.ready, x.expressions, x.columns, x.self_contained,
           CASE WHEN x.self_contained THEN pg_get_expr(x.indpred, x.indrelid) END AS predicate
      FROM (SELECT ix.relname AS name, c.relname AS table_name, i.indisunique AS unique, i.indisvalid AS valid,
                   i.indisready AS ready, i.indexprs IS NOT NULL AS expressions,
                   ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
                   NOT EXISTS (SELECT 1 FROM pg_depend d
                                WHERE d.classid = 'pg_class'::regclass AND d.objid = i.indexrelid
                                  AND NOT (d.refclassid = 'pg_class'::regclass AND d.refobjid = i.indrelid)) AS self_contained,
                   i.indpred, i.indrelid
              FROM pg_index i
              JOIN pg_class ix ON ix.oid = i.indexrelid
              JOIN pg_namespace n ON n.oid = ix.relnamespace AND n.nspname = 'public'
              JOIN pg_class c ON c.oid = i.indrelid
             WHERE ix.relname IN ('outbound_requests_bot_step_uidx', 'outbound_requests_bot_inflight_uidx',
                                  'outbound_requests_bot_conv_inflight_uidx')) x`);
  const constraints = await db.execute<{
    name: string;
    table_name: string;
    type: string;
    validated: boolean;
    self_contained: boolean;
    expression: string | null;
  }>(sql`
    SELECT x.name, x.table_name, x.type, x.validated, x.self_contained,
           CASE WHEN x.self_contained THEN pg_get_expr(x.conbin, x.conrelid) END AS expression
      FROM (SELECT con.conname AS name, c.relname AS table_name, con.contype::text AS type, con.convalidated AS validated,
                   NOT EXISTS (SELECT 1 FROM pg_depend d
                                WHERE d.classid = 'pg_constraint'::regclass AND d.objid = con.oid
                                  AND NOT (d.refclassid = 'pg_class'::regclass AND d.refobjid = con.conrelid)) AS self_contained,
                   con.conbin, con.conrelid
              FROM pg_constraint con
              JOIN pg_class c ON c.oid = con.conrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
             WHERE con.conname = 'outbound_requests_bot_key_check') x`);
  const functions = await db.execute<{ name: string; args: string; returns: string }>(sql`
    SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, p.prorettype::regtype::text AS returns
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
     WHERE p.proname IN ('bot_request_hold_code', 'outbound_requests_allocate_control_seq',
                         'conversation_events_allocate_control_seq')`);
  return {
    columns: columns.rows.map((x) => ({
      table: x.table_name,
      column: x.column_name,
      type: x.data_type,
      notNull: x.is_nullable === "NO",
    })),
    triggers: triggers.rows.map((x) => ({
      name: x.name,
      table: x.table_name,
      enabled: x.enabled,
      tgtype: Number(x.tgtype),
      fnSchema: x.fn_schema,
      fn: x.fn,
      fnArgs: x.fn_args,
    })),
    indexes: indexes.rows.map((x) => ({
      name: x.name,
      table: x.table_name,
      unique: x.unique,
      valid: x.valid,
      ready: x.ready,
      expressions: x.expressions,
      columns: x.columns,
      selfContained: x.self_contained,
      predicate: x.predicate,
    })),
    constraints: constraints.rows.map((x) => ({
      name: x.name,
      table: x.table_name,
      type: x.type,
      validated: x.validated,
      selfContained: x.self_contained,
      expression: x.expression,
    })),
    functions: functions.rows,
  };
}
