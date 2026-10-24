import { describe, expect, it } from "vitest";
import { EXPECTED, schemaProblems, type SchemaFacts } from "./schema";

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
    truth: { ...i.truth },
  })),
  constraints: [
    {
      name: EXPECTED.constraint.name,
      table: "outbound_requests",
      type: "c",
      validated: true,
      truth: { ...EXPECTED.constraint.truth },
    },
  ],
  functions: EXPECTED.functions.map((f) => ({ ...f })),
});

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
      (f) => edit(f, "indexes", 1, { truth: { ...EXPECTED.indexes[0]!.truth } }),
      "index outbound_requests_bot_inflight_uidx",
    ],
    [
      "index without a predicate",
      (f) => edit(f, "indexes", 0, { truth: null }),
      "index outbound_requests_bot_step_uidx",
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
      (f) =>
        edit(f, "constraints", 0, { truth: { ...EXPECTED.constraint.truth, bot_other: true } }),
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
