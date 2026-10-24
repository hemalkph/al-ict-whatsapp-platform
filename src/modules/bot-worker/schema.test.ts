import { TransactionRollbackError, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { OUTBOUND_REQUEST_STATES } from "@/db/schema/enums";
import {
  EXPECTED,
  IN_FLIGHT_STATES,
  readSchemaFacts,
  schemaProblems,
  type SchemaFacts,
} from "./schema";

// The pure judge of the 0008 catalog facts (Phase 08E-7 review): the exact objects pass; every structural mismatch is named.
// The facts themselves are read from PostgreSQL in transaction-bound.db.test.ts.

const good = (): SchemaFacts => ({
  columns: EXPECTED.columns.map((c) => ({ ...c })),
  triggers: EXPECTED.triggers.map((t) => ({
    name: t.name,
    table: t.table,
    enabled: "O",
    tgtype: 7,
    fnSchema: "public",
    fn: t.fn,
    fnArgs: "",
  })),
  indexes: EXPECTED.indexes.map((i) => ({
    name: i.name,
    table: "outbound_requests",
    unique: true,
    valid: true,
    ready: true,
    expressions: false,
    columns: [...i.columns],
    selfContained: true,
    predicate: i.predicate,
  })),
  constraints: [
    {
      name: EXPECTED.constraint.name,
      table: "outbound_requests",
      type: "c",
      validated: true,
      selfContained: true,
      expression: EXPECTED.constraint.expression,
    },
  ],
  functions: EXPECTED.functions.map((f) => ({ ...f })),
});

const inflight = (states: readonly string[]) =>
  `((origin = 'BOT'::text) AND (state = ANY (ARRAY[${states.map((s) => `'${s}'::text`).join(", ")}])))`;

type Mutation = [string, (f: SchemaFacts & Record<string, unknown>) => SchemaFacts, string];
const edit = <K extends keyof SchemaFacts>(
  f: SchemaFacts,
  key: K,
  i: number,
  patch: Partial<SchemaFacts[K][number]>,
) => ({
  ...f,
  [key]: f[key].map((x, n) => (n === i ? { ...x, ...patch } : x)),
});

describe("migration 0008 structural judge", () => {
  it("the exact 0008 objects pass", () => {
    expect(schemaProblems(good())).toEqual([]);
  });

  it("F-2: every outbound request state is classified, exactly QUEUED and SENDING are in flight, and the predicate lists them", () => {
    expect(Object.keys(IN_FLIGHT_STATES).sort()).toEqual([...OUTBOUND_REQUEST_STATES].sort());
    expect(OUTBOUND_REQUEST_STATES.filter((s) => IN_FLIGHT_STATES[s])).toEqual([
      "QUEUED",
      "SENDING",
    ]);
    expect(EXPECTED.indexes[1]!.predicate).toBe(inflight(["QUEUED", "SENDING"]));
    expect(EXPECTED.indexes[2]!.predicate).toBe(EXPECTED.indexes[1]!.predicate);
  });

  const mutations: Mutation[] = [
    [
      "allocation trigger missing",
      (f) => ({ ...f, triggers: f.triggers.slice(1) }),
      "trigger outbound_requests_allocate_control_seq_trg",
    ],
    [
      "allocation trigger DISABLED",
      (f) => edit(f, "triggers", 1, { enabled: "D" }),
      "trigger conversation_events_allocate_control_seq_trg",
    ],
    [
      "allocation trigger replica-only",
      (f) => edit(f, "triggers", 0, { enabled: "R" }),
      "trigger outbound_requests_allocate_control_seq_trg",
    ],
    [
      "allocation trigger AFTER instead of BEFORE",
      (f) => edit(f, "triggers", 0, { tgtype: 5 }),
      "trigger outbound_requests_allocate_control_seq_trg",
    ],
    [
      "allocation trigger on another table",
      (f) => edit(f, "triggers", 0, { table: "messages" }),
      "trigger outbound_requests_allocate_control_seq_trg",
    ],
    [
      "allocation trigger runs another function",
      (f) => edit(f, "triggers", 0, { fn: "noop" }),
      "trigger outbound_requests_allocate_control_seq_trg",
    ],
    [
      "index not unique",
      (f) => edit(f, "indexes", 1, { unique: false }),
      "index outbound_requests_bot_inflight_uidx",
    ],
    [
      "index invalid",
      (f) => edit(f, "indexes", 1, { valid: false }),
      "index outbound_requests_bot_inflight_uidx",
    ],
    [
      "index not ready",
      (f) => edit(f, "indexes", 1, { ready: false }),
      "index outbound_requests_bot_inflight_uidx",
    ],
    [
      "index with other keys",
      (f) => edit(f, "indexes", 2, { columns: ["organization_id", "bot_session_id"] }),
      "index outbound_requests_bot_conv_inflight_uidx",
    ],
    [
      "index on an expression",
      (f) => edit(f, "indexes", 0, { expressions: true }),
      "index outbound_requests_bot_step_uidx",
    ],
    [
      "index on another table",
      (f) => edit(f, "indexes", 0, { table: "messages" }),
      "index outbound_requests_bot_step_uidx",
    ],
    [
      "same-name index whose predicate covers every BOT state",
      (f) => edit(f, "indexes", 1, { predicate: EXPECTED.indexes[0]!.predicate }),
      "index outbound_requests_bot_inflight_uidx",
    ],
    [
      "index without a predicate",
      (f) => edit(f, "indexes", 0, { predicate: null }),
      "index outbound_requests_bot_step_uidx",
    ],
    [
      "in-flight index that also covers REJECTED",
      (f) => edit(f, "indexes", 1, { predicate: inflight(["QUEUED", "SENDING", "REJECTED"]) }),
      "index outbound_requests_bot_inflight_uidx",
    ],
    [
      "in-flight index that also covers UNKNOWN_OUTCOME",
      (f) =>
        edit(f, "indexes", 2, { predicate: inflight(["QUEUED", "SENDING", "UNKNOWN_OUTCOME"]) }),
      "index outbound_requests_bot_conv_inflight_uidx",
    ],
    [
      "in-flight index that omits SENDING",
      (f) => edit(f, "indexes", 1, { predicate: inflight(["QUEUED"]) }),
      "index outbound_requests_bot_inflight_uidx",
    ],
    [
      "index with the exact predicate text that depends on a foreign object (function, operator, type)",
      (f) => edit(f, "indexes", 2, { selfContained: false }),
      "index outbound_requests_bot_conv_inflight_uidx",
    ],
    [
      "same-name constraint on another table",
      (f) => edit(f, "constraints", 0, { table: "conversation_events" }),
      "constraint outbound_requests_bot_key_check",
    ],
    [
      "constraint not validated",
      (f) => edit(f, "constraints", 0, { validated: false }),
      "constraint outbound_requests_bot_key_check",
    ],
    [
      "constraint of another type",
      (f) => edit(f, "constraints", 0, { type: "u" }),
      "constraint outbound_requests_bot_key_check",
    ],
    [
      "constraint condition that accepts any BOT key",
      (f) => edit(f, "constraints", 0, { expression: "((origin <> 'BOT'::text) IS TRUE)" }),
      "constraint outbound_requests_bot_key_check",
    ],
    [
      "constraint that also calls a function",
      (f) =>
        edit(f, "constraints", 0, {
          expression: `(${EXPECTED.constraint.expression} AND public.side_effect())`,
          selfContained: false,
        }),
      "constraint outbound_requests_bot_key_check",
    ],
    [
      "constraint with the exact text that depends on a foreign object",
      (f) => edit(f, "constraints", 0, { selfContained: false }),
      "constraint outbound_requests_bot_key_check",
    ],
    [
      "constraint not deparsed (null)",
      (f) => edit(f, "constraints", 0, { expression: null }),
      "constraint outbound_requests_bot_key_check",
    ],
    [
      "hold-code function with an incompatible signature",
      (f) => edit(f, "functions", 0, { args: "p_organization_id text, p_request_id text" }),
      "function bot_request_hold_code(p_organization_id uuid, p_request_id uuid)",
    ],
    [
      "allocator returning another type",
      (f) => edit(f, "functions", 1, { returns: "void" }),
      "function outbound_requests_allocate_control_seq()",
    ],
    [
      "column of another type",
      (f) => edit(f, "columns", 2, { type: "bigint" }),
      "column outbound_requests.bot_step_seq",
    ],
    [
      "origin nullable",
      (f) => edit(f, "columns", 0, { notNull: false }),
      "column outbound_requests.origin",
    ],
  ];
  for (const [name, mutate, problem] of mutations)
    it(`refuses: ${name}`, () => {
      expect(schemaProblems(mutate(good() as SchemaFacts & Record<string, unknown>))).toEqual([
        problem,
      ]);
    });

  it("an incompatible overload BESIDE the exact function still passes (the exact signature exists); the overload alone does not", () => {
    const f = good();
    const extra = { name: "bot_request_hold_code", args: "x text", returns: "text" };
    expect(schemaProblems({ ...f, functions: [...f.functions, extra] })).toEqual([]);
    expect(schemaProblems({ ...f, functions: [extra, ...f.functions.slice(1)] })).toHaveLength(1);
  });
});

// The catalog read's transaction, against a stand-in with drizzle's transaction semantics (commit on return, rollback and
// rethrow on throw). The same properties on real PostgreSQL 17 are in transaction-bound.db.test.ts.
describe("readSchemaFacts transaction", () => {
  const dialect = new PgDialect();
  function fakeDb(failAt?: number) {
    const log: string[] = [];
    let config: unknown;
    const tx = {
      execute: async (q: SQL) => {
        const text = dialect.sqlToQuery(q).sql.replace(/\s+/g, " ").trim();
        if (log.length === failAt)
          throw Object.assign(new Error("canceling statement"), { code: "57014" });
        log.push(text);
        return { rows: [] };
      },
      rollback: () => {
        throw new TransactionRollbackError();
      },
    };
    const db = {
      transaction: async (fn: (t: typeof tx) => Promise<unknown>, c: unknown) => {
        config = c;
        log.push("BEGIN");
        try {
          const r = await fn(tx);
          log.push("COMMIT");
          return r;
        } catch (e) {
          log.push("ROLLBACK");
          throw e;
        }
      },
    };
    return {
      db: db as unknown as Parameters<typeof readSchemaFacts>[0],
      log,
      config: () => config,
    };
  }

  it("is READ ONLY, bounds each statement server-side, pins search_path, reads only, and always rolls back", async () => {
    const f = fakeDb();
    await expect(readSchemaFacts(f.db)).resolves.toMatchObject({ indexes: [], constraints: [] });
    expect(f.config()).toEqual({ accessMode: "read only" });
    expect(f.log.slice(0, 3)).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout = '5s'",
      "SET LOCAL search_path = pg_catalog",
    ]);
    expect(f.log.at(-1)).toBe("ROLLBACK");
    expect(f.log).not.toContain("COMMIT");
    expect(f.log.slice(3, -1).every((x) => x.startsWith("SELECT"))).toBe(true);
  });

  it("a failed or timed-out read is never accepted: it propagates, and the transaction is rolled back", async () => {
    for (const at of [1, 3, 6]) {
      const f = fakeDb(at);
      await expect(readSchemaFacts(f.db)).rejects.toMatchObject({ code: "57014" });
      expect(f.log.at(-1)).toBe("ROLLBACK");
    }
  });
});
