import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  claimTriggersSql,
  deferTriggerSql,
  endConversationTriggersSql,
  finishTriggerSql,
  lockTerminalizationCandidateSql,
  markTriggerDeadSql,
  recordTriggerFailureSql,
  timestampToDate,
  terminalizationCandidatesSql,
  wakeConversationTriggersSql,
} from "./bot-trigger-queue";

// The shape of the queue SQL (Phase 08E-3), checked without a database: the clauses that carry the guarantees, the fences, the
// database clock, and the refusal of malformed input before it can reach a statement. The behaviour itself is proved on
// PostgreSQL in bot-runtime/trigger-claim.db.test.ts and trigger-dead.db.test.ts.

const render = (s: SQL) => new PgDialect().sqlToQuery(s);
const O = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const K = "33333333-3333-4333-8333-333333333333";
const C = "44444444-4444-4444-8444-444444444444";
const fence = { organizationId: O, id: I, claimToken: K };
const norm = (s: string) => s.replace(/\s+/g, " ");

describe("claim", () => {
  const q = render(claimTriggersSql({ limit: 5, leaseMs: 60_000, maxClaims: 6 }));
  const text = norm(q.sql);
  it("locks candidates without waiting and enforces due time, the claim limit, the lease and head of line", () => {
    expect(text).toContain("FOR UPDATE OF t SKIP LOCKED");
    expect(text).toMatch(/t\.status = 'PENDING' AND t\.attempts < \$\d+/);
    expect(text).toContain("t.next_attempt_at <= clock_timestamp()");
    expect(text).toMatch(
      /t\.claim_token IS NULL OR t\.claimed_at < clock_timestamp\(\) - \$\d+ \* interval '1 millisecond'/,
    );
    expect(text).toContain(
      "e.status = 'PENDING' AND (e.input_occurred_at, e.id) < (t.input_occurred_at, t.id)",
    );
    expect(text).toContain(
      "e.organization_id = t.organization_id AND e.conversation_id = t.conversation_id",
    );
  });
  it("charges the attempt, issues a fresh token and stamps the claim atomically, re-checking the limit on the locked row", () => {
    expect(text).toContain(
      "SET attempts = t.attempts + 1, claim_token = gen_random_uuid(), claimed_at = clock_timestamp()",
    );
    expect(text).toMatch(
      /WHERE t\.id = c\.id AND t\.status = 'PENDING' AND t\.attempts < \$\d+ RETURNING/,
    );
  });
  it("binds the approved numbers as parameters", () => {
    expect(q.params).toEqual([6, 60_000, 5, 6]);
  });
  it.each([
    [{ limit: 0, leaseMs: 60_000, maxClaims: 6 }],
    [{ limit: 1, leaseMs: 0, maxClaims: 6 }],
    [{ limit: 1, leaseMs: 60_000, maxClaims: 7 }],
    [{ limit: 1, leaseMs: 60_000, maxClaims: 0 }],
    [{ limit: 1.5, leaseMs: 60_000, maxClaims: 6 }],
    [{ limit: Number.NaN, leaseMs: 60_000, maxClaims: 6 }],
  ])("refuses %j", (p) => {
    expect(() => claimTriggersSql(p)).toThrow(RangeError);
  });
});

describe("T2 failure record", () => {
  const q = render(
    recordTriggerFailureSql({ ...fence, errorCode: "lock_timeout", backoffMs: 5_000 }),
  );
  it("is fenced on organization, id, PENDING and the exact claim token, and clears the claim", () => {
    const text = norm(q.sql);
    expect(text).toContain("SET claim_token = NULL, claimed_at = NULL");
    expect(text).toMatch(
      /WHERE organization_id = \$\d+ AND id = \$\d+ AND status = 'PENDING' AND claim_token = \$\d+ RETURNING id/,
    );
    expect(text).not.toMatch(/attempts/); // the claim-time attempt stays charged
    expect(q.params).toContain(O);
    expect(q.params).toContain(I);
    expect(q.params).toContain(K);
  });
  it("schedules from the database clock plus the backoff, and records only a fixed code", () => {
    expect(norm(q.sql)).toContain("next_attempt_at = clock_timestamp() + $");
    expect(q.params).toContain(5_000);
    expect(q.params).toContain("lock_timeout");
  });
  it("a null backoff is immediate, and anything that is not a short code is stored as internal_error", () => {
    expect(
      render(recordTriggerFailureSql({ ...fence, errorCode: "ok_code", backoffMs: null })).params,
    ).toContain(0);
    for (const bad of [
      "Has Spaces",
      "a".repeat(65),
      "",
      "ERROR: duplicate key value (secret@example.com)",
      "x;DROP",
    ])
      expect(
        render(recordTriggerFailureSql({ ...fence, errorCode: bad, backoffMs: 1 })).params,
        bad,
      ).toContain("internal_error");
  });
  it("refuses a malformed fence or a negative backoff before any statement", () => {
    expect(() =>
      recordTriggerFailureSql({ ...fence, claimToken: "x", errorCode: "a", backoffMs: 1 }),
    ).toThrow(TypeError);
    expect(() =>
      recordTriggerFailureSql({ ...fence, id: "1 OR 1=1", errorCode: "a", backoffMs: 1 }),
    ).toThrow(TypeError);
    expect(() => recordTriggerFailureSql({ ...fence, errorCode: "a", backoffMs: -1 })).toThrow(
      RangeError,
    );
  });
});

describe("deferral with refund", () => {
  const p = { ...fence, ladderMs: [2_000, 4_000, 8_000, 15_000], maxDeferrals: 1_000 };
  const q = render(deferTriggerSql(p));
  const text = norm(q.sql);
  it("refunds exactly once, counts the deferral, and is fenced and bounded", () => {
    expect(text).toContain("attempts = attempts - 1, deferrals = deferrals + 1");
    expect(text).toMatch(
      /AND status = 'PENDING' AND claim_token = \$\d+ AND attempts >= 1 AND deferrals < \$\d+ RETURNING/,
    );
  });
  it("selects the ladder rung by the deferrals BEFORE the update and repeats the last rung", () => {
    expect(text).toMatch(
      /\(\$\d+::int\[\]\)\[LEAST\(deferrals, \$\d+\) \+ 1\] \* interval '1 millisecond'/,
    );
    expect(q.params).toContain("{2000,4000,8000,15000}");
    expect(q.params).toContain(3); // the last index
    expect(q.params).toContain(1_000);
  });
  it("uses the freshness clock when given, else the database clock", () => {
    expect(text).toContain("COALESCE($");
    expect(text).toContain("clock_timestamp()");
    const at = new Date("2026-10-22T10:00:00.000Z");
    expect(render(deferTriggerSql({ ...p, at })).params).toContain("2026-10-22T10:00:00.000Z");
    expect(q.params).toContain(null);
  });
  it("refuses an empty or malformed ladder and an invalid freshness clock", () => {
    expect(() => deferTriggerSql({ ...p, ladderMs: [] })).toThrow(RangeError);
    expect(() => deferTriggerSql({ ...p, ladderMs: [2_000, -1] })).toThrow(RangeError);
    expect(() => deferTriggerSql({ ...p, maxDeferrals: 1_001 })).toThrow(RangeError);
    expect(() => deferTriggerSql({ ...p, at: new Date("nope") })).toThrow(RangeError);
  });
});

describe("finish", () => {
  const p = { ...fence, status: "PROCESSED" as const, outcomeCode: "processed" };
  it("is fenced like every write, clears the claim and the error, and stamps processed_at", () => {
    const text = norm(render(finishTriggerSql(p)).sql);
    expect(text).toContain("claim_token = NULL, claimed_at = NULL, last_error_code = NULL");
    expect(text).toMatch(
      /WHERE organization_id = \$\d+ AND id = \$\d+ AND status = 'PENDING' AND claim_token = \$\d+ RETURNING id/,
    );
    expect(text).toContain("processed_at = COALESCE(");
  });
  it("can only finish as PROCESSED or IGNORED, with a short code", () => {
    for (const status of ["DEAD", "PENDING", "processed", ""])
      expect(() => finishTriggerSql({ ...p, status: status as never }), status).toThrow(TypeError);
    expect(() => finishTriggerSql({ ...p, outcomeCode: "Bad Code" })).toThrow(TypeError);
    expect(() => finishTriggerSql({ ...p, sessionId: "nope" })).toThrow(TypeError);
    expect(() =>
      finishTriggerSql({ ...p, status: "IGNORED", outcomeCode: "stale_trigger", sessionId: C }),
    ).not.toThrow();
  });
});

describe("wake and end never wait on a held trigger row", () => {
  const c = { organizationId: O, conversationId: C };
  for (const [name, sql] of [
    ["wake", wakeConversationTriggersSql(c)],
    ["end", endConversationTriggersSql(c)],
  ] as const)
    it(`${name}: FOR UPDATE SKIP LOCKED, scoped to the organization and conversation, PENDING only`, () => {
      const text = norm(render(sql).sql);
      expect(text).toContain("FOR UPDATE SKIP LOCKED");
      expect(text).toContain("t.organization_id = $");
      expect(text).toContain("t.conversation_id = $");
      expect(text).toContain("t.status = 'PENDING'");
    });
  it("wake only moves triggers that wait for a later time, to the database clock", () => {
    const text = norm(render(wakeConversationTriggersSql(c)).sql);
    expect(text).toContain("t.next_attempt_at > clock_timestamp()");
    expect(text).toContain("SET next_attempt_at = clock_timestamp()");
  });
  it("end finishes as IGNORED with a code and a cleared claim", () => {
    const q = render(endConversationTriggersSql({ ...c, outcomeCode: "session_ended" }));
    expect(norm(q.sql)).toContain("SET status = 'IGNORED', outcome_code = $");
    expect(norm(q.sql)).toContain("claim_token = NULL, claimed_at = NULL");
    expect(q.params).toContain("session_ended");
  });
  it("an excepted trigger is left alone", () => {
    expect(render(wakeConversationTriggersSql({ ...c, exceptId: I })).params).toContain(I);
    expect(render(endConversationTriggersSql({ ...c, exceptId: I })).params).toContain(I);
  });
});

describe("terminalization statements", () => {
  const p = { maxClaims: 6, leaseMs: 60_000 };
  const cand = { organizationId: O, id: I, conversationId: C };
  it("candidates: PENDING, exhausted, no live claim; the literal 6 is inlined so the partial index applies", () => {
    const text = norm(render(terminalizationCandidatesSql(p, 10)).sql);
    expect(text).toContain("t.status = 'PENDING' AND t.attempts = 6");
    expect(text).toMatch(
      /t\.claim_token IS NULL OR t\.claimed_at < clock_timestamp\(\) - \$\d+ \* interval '1 millisecond'/,
    );
    expect(text).not.toContain("FOR UPDATE"); // a plain read
  });
  it("the trigger row is taken FOR UPDATE SKIP LOCKED with the same predicate", () => {
    const text = norm(render(lockTerminalizationCandidateSql(cand, p)).sql);
    expect(text).toContain("FOR UPDATE SKIP LOCKED");
    expect(text).toMatch(
      /t\.status = 'PENDING' AND t\.attempts = \$\d+ AND \(t\.claim_token IS NULL OR t\.claimed_at < clock_timestamp\(\)/,
    );
  });
  it("DEAD is written only for a PENDING, exhausted trigger without a live claim", () => {
    const text = norm(render(markTriggerDeadSql(cand, p)).sql);
    expect(text).toContain("SET status = 'DEAD', outcome_code = 'attempts_exhausted'");
    expect(text).toMatch(
      /AND status = 'PENDING' AND attempts = \$\d+ AND \(claim_token IS NULL OR claimed_at < clock_timestamp\(\)/,
    );
  });
  it("refuses malformed identifiers and limits", () => {
    expect(() => markTriggerDeadSql({ ...cand, id: "x" }, p)).toThrow(TypeError);
    expect(() => terminalizationCandidatesSql({ ...p, maxClaims: 7 }, 10)).toThrow(RangeError);
    expect(() => terminalizationCandidatesSql(p, 0)).toThrow(RangeError);
  });
});

describe("every statement uses the database clock, never a transaction-start or application time", () => {
  it("no builder emits now(), current_timestamp or transaction_timestamp()", () => {
    const all = [
      claimTriggersSql({ limit: 1, leaseMs: 1, maxClaims: 6 }),
      recordTriggerFailureSql({ ...fence, errorCode: "a", backoffMs: 1 }),
      deferTriggerSql({ ...fence, ladderMs: [1], maxDeferrals: 1 }),
      finishTriggerSql({ ...fence, status: "IGNORED", outcomeCode: "a" }),
      wakeConversationTriggersSql({ organizationId: O, conversationId: C }),
      endConversationTriggersSql({ organizationId: O, conversationId: C }),
      terminalizationCandidatesSql({ maxClaims: 6, leaseMs: 1 }, 1),
      lockTerminalizationCandidateSql(
        { organizationId: O, id: I, conversationId: C },
        { maxClaims: 6, leaseMs: 1 },
      ),
      markTriggerDeadSql(
        { organizationId: O, id: I, conversationId: C },
        { maxClaims: 6, leaseMs: 1 },
      ),
    ];
    for (const s of all)
      expect(render(s).sql).not.toMatch(
        /\bnow\s*\(|current_timestamp|transaction_timestamp|statement_timestamp/i,
      );
  });
});

describe("timestamps from a raw result (Drizzle returns timestamptz as text)", () => {
  it("parses the server's text exactly, truncating microseconds to the millisecond", () => {
    expect(timestampToDate("2026-10-22 10:00:00.123456+00").toISOString()).toBe(
      "2026-10-22T10:00:00.123Z",
    );
    expect(timestampToDate("2026-10-22 10:00:00.999999+00").toISOString()).toBe(
      "2026-10-22T10:00:00.999Z",
    );
    expect(timestampToDate("2026-10-22 10:00:00+00").toISOString()).toBe(
      "2026-10-22T10:00:00.000Z",
    );
    expect(timestampToDate("2026-10-22 10:00:00.5+00").toISOString()).toBe(
      "2026-10-22T10:00:00.500Z",
    );
  });
  it("honours a non-UTC session offset", () => {
    expect(timestampToDate("2026-10-22 15:30:00.25+05:30").toISOString()).toBe(
      "2026-10-22T10:00:00.250Z",
    );
    expect(timestampToDate("2026-10-22 05:00:00-05").toISOString()).toBe(
      "2026-10-22T10:00:00.000Z",
    );
  });
  it("passes a valid Date through and refuses anything else instead of producing Invalid Date", () => {
    const d = new Date(5);
    expect(timestampToDate(d)).toBe(d);
    for (const bad of [
      "",
      "yesterday",
      "2026-10-22T10:00:00Z",
      "2026-13-40 99:00:00+00",
      null,
      undefined,
      5,
      new Date("x"),
    ])
      expect(() => timestampToDate(bad), String(bad)).toThrow(TypeError);
  });
});
