import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { DbExecutor } from "@/db/ops/executor";
import {
  claimTriggers,
  deferTrigger,
  recordTriggerFailure,
  triggerErrorCode,
  type ClaimedTrigger,
} from "./trigger-queue";

// The runtime's binding of the queue primitives to the approved policy, and the fixed error codes (Phase 08E-3). No database.

const dialect = new PgDialect();
/** A stand-in executor that records the statements it is given and answers with no rows. */
function recorder(rows: unknown[] = []) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    execute: async (s: SQL) => {
      const q = dialect.sqlToQuery(s);
      seen.push({ sql: q.sql, params: q.params });
      return { rows };
    },
  } as unknown as DbExecutor;
  return { db, seen };
}
const claim = (over: Partial<ClaimedTrigger> = {}): ClaimedTrigger => ({
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: "11111111-1111-4111-8111-111111111111",
  whatsappAccountId: "55555555-5555-4555-8555-555555555555",
  conversationId: "44444444-4444-4444-8444-444444444444",
  messageId: "66666666-6666-4666-8666-666666666666",
  claimToken: "33333333-3333-4333-8333-333333333333",
  claimedAt: new Date(0),
  attempts: 1,
  deferrals: 0,
  inputOccurredAt: new Date(0),
  enqueuedAt: new Date(0),
  observedControlSeq: 0,
  ...over,
});
const pg = (code: string, cause?: unknown) =>
  Object.assign(new Error(`detail for ${code}`), { code, cause });

describe("the fixed error codes", () => {
  it.each([
    ["55P03", "lock_timeout"],
    ["57014", "statement_timeout"],
    ["40P01", "deadlock_detected"],
    ["40001", "serialization_failure"],
    ["25P03", "idle_in_transaction_timeout"],
    ["25P04", "transaction_timeout"],
    ["57P01", "connection_lost"],
    ["08006", "connection_lost"],
    ["23505", "constraint_violation"],
    ["23514", "constraint_violation"],
    ["22P02", "data_exception"],
    ["XX000", "db_xx000"],
    ["42P01", "db_42p01"],
  ])("SQLSTATE %s is %s", (state, expected) => {
    expect(triggerErrorCode(pg(state))).toBe(expected);
  });

  it("reads the SQLSTATE through the driver wrapper", () => {
    expect(triggerErrorCode(Object.assign(new Error("Failed query"), { cause: pg("40P01") }))).toBe(
      "deadlock_detected",
    );
  });

  it("anything without a SQLSTATE is internal_error, and the message, name and stack are never consulted", () => {
    for (const e of [
      new Error("student said: my number is 94771234567"),
      Object.assign(new Error("x"), { name: "SecretName" }),
      "plain string",
      null,
      undefined,
      42,
      { message: "token AbCdEfGhIjKlMnOpQrStUv" },
    ])
      expect(triggerErrorCode(e)).toBe("internal_error");
  });

  it("whatever the error, the code is a short snake_case code that cannot carry content", () => {
    for (const e of [pg("23505"), pg("55P03"), new Error("secret"), pg("ZZZZZ"), pg("123")])
      expect(triggerErrorCode(e)).toMatch(/^[a-z0-9_]{1,64}$/);
    // a malformed state (not 5 characters) is ignored, not echoed
    expect(triggerErrorCode(pg("secret text"))).toBe("internal_error");
  });
});

describe("policy binding", () => {
  it("claims with the approved batch, 60 s lease and six-claim limit", async () => {
    const { db, seen } = recorder();
    await claimTriggers(db);
    expect(seen[0]!.params).toEqual([6, 60_000, 10, 6]);
    await claimTriggers(db, 3);
    expect(seen[1]!.params).toEqual([6, 60_000, 3, 6]);
  });

  it("records a failure with the approved backoff for the claim number, jittered by the injected random source", async () => {
    const { db, seen } = recorder([{ id: "x" }]);
    expect(await recordTriggerFailure(db, claim({ attempts: 1 }), pg("55P03"), () => 0.5)).toBe(
      true,
    );
    expect(seen[0]!.params).toContain(5_000);
    expect(seen[0]!.params).toContain("lock_timeout");
    await recordTriggerFailure(db, claim({ attempts: 3 }), new Error("x"), () => 0);
    expect(seen[1]!.params).toContain(Math.round(45_000 * 0.8));
    await recordTriggerFailure(db, claim({ attempts: 5 }), new Error("x"), () => 1);
    expect(seen[2]!.params).toContain(Math.round(300_000 * 1.2));
  });

  it("after the sixth claim there is no backoff: the trigger is left for terminalization", async () => {
    const { db, seen } = recorder([{ id: "x" }]);
    await recordTriggerFailure(db, claim({ attempts: 6 }), new Error("x"), () => 0.5);
    expect(seen[0]!.params).toContain(0);
  });

  it("a fenced-out failure record reports false", async () => {
    const { db } = recorder([]);
    expect(await recordTriggerFailure(db, claim(), new Error("x"), () => 0.5)).toBe(false);
  });

  it("defers with the 2/4/8/15 s ladder and the database ceiling of 1000 deferrals", async () => {
    const { db, seen } = recorder([
      { attempts: 0, deferrals: 1, next_attempt_at: new Date(2_000) },
    ]);
    const r = await deferTrigger(db, claim());
    expect(r).toEqual({ attempts: 0, deferrals: 1, nextAttemptAt: new Date(2_000) });
    expect(seen[0]!.params).toContain("{2000,4000,8000,15000}");
    expect(seen[0]!.params).toContain(1_000);
  });

  it("a fenced-out deferral returns null", async () => {
    expect(await deferTrigger(recorder([]).db, claim())).toBeNull();
  });
});
