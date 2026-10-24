import { sql } from "drizzle-orm";
import type { DbExecutor } from "@/db/ops/executor";

// The migration 0008 objects the bot worker depends on, verified STRUCTURALLY from the catalog (Phase 08E-7 review): a name
// alone is not enough (a same-name index with other keys, a constraint on another table, a function without its enabled
// trigger, an incompatible overload). Partial-index predicates and the CHECK condition are judged by EVALUATING the catalog's own
// expression over a fixed truth table, not by comparing deparsed text. Reads only; the pure judge below is unit-tested.

type Case = { readonly id: string; readonly origin: string; readonly state: string };
const PREDICATE_CASES: readonly Case[] = [
  { id: "bot_queued", origin: "BOT", state: "QUEUED" },
  { id: "bot_sending", origin: "BOT", state: "SENDING" },
  { id: "bot_accepted", origin: "BOT", state: "ACCEPTED" },
  { id: "bot_held", origin: "BOT", state: "HELD" },
  { id: "staff_queued", origin: "STAFF", state: "QUEUED" },
  { id: "staff_sending", origin: "STAFF", state: "SENDING" },
];
const IN_FLIGHT = {
  bot_queued: true,
  bot_sending: true,
  bot_accepted: false,
  bot_held: false,
  staff_queued: false,
  staff_sending: false,
};
const BOT_ONLY = {
  bot_queued: true,
  bot_sending: true,
  bot_accepted: true,
  bot_held: true,
  staff_queued: false,
  staff_sending: false,
};

const SESSION = "00000000-0000-4000-8000-000000000001";
const KEY_CASES = [
  { id: "bot_derived", origin: "BOT", key: `bot-${SESSION}-3`, session: SESSION, step: 3 },
  { id: "bot_other", origin: "BOT", key: "staff-chosen-key", session: SESSION, step: 3 },
  { id: "bot_wrong_step", origin: "BOT", key: `bot-${SESSION}-4`, session: SESSION, step: 3 },
  { id: "staff_any", origin: "STAFF", key: "staff-chosen-key", session: null, step: null },
] as const;
const KEY_TRUTH = { bot_derived: true, bot_other: false, bot_wrong_step: false, staff_any: true };

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
      truth: BOT_ONLY,
    },
    {
      name: "outbound_requests_bot_inflight_uidx",
      columns: ["organization_id", "bot_session_id"],
      truth: IN_FLIGHT,
    },
    {
      name: "outbound_requests_bot_conv_inflight_uidx",
      columns: ["organization_id", "conversation_id"],
      truth: IN_FLIGHT,
    },
  ],
  constraint: { name: "outbound_requests_bot_key_check", truth: KEY_TRUTH },
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
    /** The predicate's value for each case, or null when there is no predicate or it cannot be evaluated over the cases. */
    truth: Readonly<Record<string, boolean>> | null;
  }[];
  readonly constraints: readonly {
    name: string;
    table: string;
    type: string;
    validated: boolean;
    truth: Readonly<Record<string, boolean>> | null;
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
      !same(got.truth, i.truth)
    )
      problems.push(`index ${i.name}`);
  }
  const k = EXPECTED.constraint;
  const con = f.constraints.find((x) => x.name === k.name && x.table === "outbound_requests");
  if (!con || con.type !== "c" || !con.validated || !same(con.truth, k.truth))
    problems.push(`constraint ${k.name}`);
  for (const fn of EXPECTED.functions)
    if (
      !f.functions.some((x) => x.name === fn.name && x.args === fn.args && x.returns === fn.returns)
    )
      problems.push(`function ${fn.name}(${fn.args})`);
  return problems;
}

const lit = (v: string | number | null) =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`;

/**
 * Evaluates a catalog expression (a partial-index predicate or a CHECK condition of outbound_requests) over the fixed cases.
 * The expression text comes from THIS database's catalog (pg_get_expr), which the worker already trusts to run in; PostgreSQL
 * only accepts immutable expressions there. An expression that references anything else fails to evaluate: null (incompatible).
 */
async function evaluate(
  db: DbExecutor,
  expression: string | null,
  kind: "predicate" | "key",
): Promise<Record<string, boolean> | null> {
  if (expression === null) return null;
  const rows =
    kind === "predicate"
      ? PREDICATE_CASES.map((c) => `(${lit(c.id)}, ${lit(c.origin)}, ${lit(c.state)})`).join(", ")
      : KEY_CASES.map(
          (c) =>
            `(${lit(c.id)}, ${lit(c.origin)}, ${lit(c.key)}, ${lit(c.session)}::uuid, ${lit(c.step)}::integer)`,
        ).join(", ");
  const alias =
    kind === "predicate"
      ? "outbound_requests(case_id, origin, state)"
      : "outbound_requests(case_id, origin, idempotency_key, bot_session_id, bot_step_seq)";
  try {
    const r = await db.execute<{ case_id: string; hit: boolean | null }>(
      sql.raw(`SELECT case_id, (${expression}) AS hit FROM (VALUES ${rows}) AS ${alias}`),
    );
    return Object.fromEntries(r.rows.map((x) => [x.case_id, x.hit === true]));
  } catch {
    return null;
  }
}

/** Reads the catalog facts of the 0008 objects (plain reads; nothing is changed). */
export async function readSchemaFacts(db: DbExecutor): Promise<SchemaFacts> {
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
  const indexes = await db.execute<{
    name: string;
    table_name: string;
    unique: boolean;
    valid: boolean;
    ready: boolean;
    expressions: boolean;
    columns: string[];
    predicate: string | null;
  }>(sql`
    SELECT ix.relname AS name, c.relname AS table_name, i.indisunique AS unique, i.indisvalid AS valid, i.indisready AS ready,
           i.indexprs IS NOT NULL AS expressions,
           ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
           pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i
      JOIN pg_class ix ON ix.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = ix.relnamespace AND n.nspname = 'public'
      JOIN pg_class c ON c.oid = i.indrelid
     WHERE ix.relname IN ('outbound_requests_bot_step_uidx', 'outbound_requests_bot_inflight_uidx',
                          'outbound_requests_bot_conv_inflight_uidx')`);
  const constraints = await db.execute<{
    name: string;
    table_name: string;
    type: string;
    validated: boolean;
    expression: string | null;
  }>(sql`
    SELECT con.conname AS name, c.relname AS table_name, con.contype::text AS type, con.convalidated AS validated,
           pg_get_expr(con.conbin, con.conrelid) AS expression
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE con.conname = 'outbound_requests_bot_key_check'`);
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
    indexes: await Promise.all(
      indexes.rows.map(async (x) => ({
        name: x.name,
        table: x.table_name,
        unique: x.unique,
        valid: x.valid,
        ready: x.ready,
        expressions: x.expressions,
        columns: x.columns,
        truth:
          x.table_name === "outbound_requests"
            ? await evaluate(db, x.predicate, "predicate")
            : null,
      })),
    ),
    constraints: await Promise.all(
      constraints.rows.map(async (x) => ({
        name: x.name,
        table: x.table_name,
        type: x.type,
        validated: x.validated,
        truth:
          x.table_name === "outbound_requests" && x.type === "c"
            ? await evaluate(db, x.expression, "key")
            : null,
      })),
    ),
    functions: functions.rows,
  };
}
