import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS, readReconcileConfig } from "./config";
import {
  BACKOFF_SECONDS,
  FIRST_TOUCH_HOLD_MINUTES,
  MAX_ATTEMPTS,
  decide,
  failureCode,
  stepAfterFailure,
  type Facts,
} from "./policy";

// Database-free tests of the reconciler's policy and configuration.

const base: Facts = {
  archived: false,
  stale: false,
  openLead: null,
  atOrBeforeLatestClosure: false,
  converted: false,
  earlierTouchHolding: false,
};

describe("reconciliation policy", () => {
  it("a fresh touch of a contact with no lead history creates a lead; every skip is terminal and named", () => {
    expect(decide(base)).toEqual({ action: "create" });
    expect(decide({ ...base, archived: true })).toEqual({
      action: "skip",
      decision: "SKIPPED_ARCHIVED",
    });
    expect(decide({ ...base, stale: true })).toEqual({ action: "skip", decision: "SKIPPED_STALE" });
    expect(decide({ ...base, atOrBeforeLatestClosure: true })).toEqual({
      action: "skip",
      decision: "SKIPPED_BEFORE_CYCLE",
    });
    expect(decide({ ...base, converted: true })).toEqual({
      action: "skip",
      decision: "SKIPPED_CONVERTED",
    });
  });

  it("with an open lead the touch is linked to it unless it predates the lead's cycle; creation is never an option", () => {
    const open = { id: "lead-1", touchPredatesCycle: false };
    expect(decide({ ...base, openLead: open })).toEqual({ action: "link", leadId: "lead-1" });
    expect(decide({ ...base, openLead: { ...open, touchPredatesCycle: true } })).toEqual({
      action: "skip",
      decision: "SKIPPED_BEFORE_CYCLE",
    });
    // an open lead makes the closure and conversion history irrelevant to THIS touch (staff created or reopened a lead on purpose)
    expect(
      decide({ ...base, openLead: open, converted: true, atOrBeforeLatestClosure: true }),
    ).toEqual({ action: "link", leadId: "lead-1" });
  });

  it("archived beats stale beats the cycle rules, and converted history only suppresses CREATION", () => {
    const open = { id: "l", touchPredatesCycle: true };
    expect(decide({ ...base, archived: true, stale: true, openLead: open })).toEqual({
      action: "skip",
      decision: "SKIPPED_ARCHIVED",
    });
    expect(decide({ ...base, stale: true, openLead: open })).toEqual({
      action: "skip",
      decision: "SKIPPED_STALE",
    });
    expect(decide({ ...base, converted: true, atOrBeforeLatestClosure: true })).toEqual({
      action: "skip",
      decision: "SKIPPED_BEFORE_CYCLE",
    });
  });

  it("an earlier touch in its retry back-off holds back CREATING a lead only: linking to an open lead never waits, and a skip never waits", () => {
    const open = { id: "l", touchPredatesCycle: false };
    expect(decide({ ...base, earlierTouchHolding: true })).toEqual({ action: "wait" });
    // an open lead: the touch is linked at once (an earlier touch does not hold it, even when the flag is set by mistake)
    expect(decide({ ...base, earlierTouchHolding: true, openLead: open })).toEqual({
      action: "link",
      leadId: "l",
    });
    expect(
      decide({
        ...base,
        earlierTouchHolding: true,
        openLead: { ...open, touchPredatesCycle: true },
      }),
    ).toEqual({ action: "skip", decision: "SKIPPED_BEFORE_CYCLE" });
    expect(decide({ ...base, earlierTouchHolding: true, stale: true })).toEqual({
      action: "skip",
      decision: "SKIPPED_STALE",
    });
    expect(decide({ ...base, earlierTouchHolding: true, archived: true })).toEqual({
      action: "skip",
      decision: "SKIPPED_ARCHIVED",
    });
    expect(decide({ ...base, earlierTouchHolding: true, converted: true })).toEqual({
      action: "skip",
      decision: "SKIPPED_CONVERTED",
    });
    expect(decide({ ...base, earlierTouchHolding: true, atOrBeforeLatestClosure: true })).toEqual({
      action: "skip",
      decision: "SKIPPED_BEFORE_CYCLE",
    });
    expect(FIRST_TOUCH_HOLD_MINUTES).toBe(15);
  });

  it("the retry policy: five failed attempts at most; back-off 1 minute, 5 minutes, 30 minutes, 2 hours; then PARKED", () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect([...BACKOFF_SECONDS]).toEqual([60, 300, 1_800, 7_200]);
    expect(stepAfterFailure(0)).toEqual({ decision: "RETRY", attempts: 1, delaySeconds: 60 });
    expect(stepAfterFailure(3)).toEqual({ decision: "RETRY", attempts: 4, delaySeconds: 7_200 });
    expect(stepAfterFailure(4)).toEqual({ decision: "PARKED", attempts: 5 });
    expect(stepAfterFailure(40)).toEqual({ decision: "PARKED", attempts: 5 });
    expect(stepAfterFailure(-3)).toEqual({ decision: "RETRY", attempts: 1, delaySeconds: 60 });
    expect(stepAfterFailure(1.9)).toEqual({ decision: "RETRY", attempts: 2, delaySeconds: 300 });
  });

  it("a failure is recorded by a fixed content-free code, and the code always fits the database's check", () => {
    expect(failureCode({ code: "23514" })).toBe("pg_23514");
    expect(failureCode({ cause: { cause: { code: "40P01" } } })).toBe("pg_40p01");
    expect(failureCode(new Error("connection to host db.internal failed for user admin"))).toBe(
      "internal_error",
    );
    expect(failureCode({ code: "ECONNREFUSED" })).toBe("internal_error");
    expect(failureCode(null)).toBe("internal_error");
    for (const e of [{ code: "23514" }, { code: "40P01" }, new Error("x")])
      expect(failureCode(e)).toMatch(/^[a-z0-9_.:-]{1,64}$/);
  });
});

describe("reconciler configuration", () => {
  const url = "postgres://user:secretpw@localhost:5432/al_ict_test_x";
  const on = { LEADS_RECONCILER_ENABLED: "true", DATABASE_URL: url };

  it("is disabled unless LEADS_RECONCILER_ENABLED is exactly true: nothing else matters", () => {
    for (const flag of [undefined, "", "false"])
      expect(readReconcileConfig({ LEADS_RECONCILER_ENABLED: flag, DATABASE_URL: url })).toEqual({
        kind: "disabled",
      });
    for (const flag of ["TRUE", "1", "yes", "True", " true"]) {
      const r = readReconcileConfig({ LEADS_RECONCILER_ENABLED: flag, DATABASE_URL: url });
      expect(r.kind).toBe("invalid");
    }
    expect(readReconcileConfig({ DATABASE_URL: url })).toEqual({ kind: "disabled" });
  });

  it("defaults: a 14-day freshness window, a bounded batch and run time", () => {
    const r = readReconcileConfig(on);
    expect(r).toEqual({ kind: "ready", config: { databaseUrl: url, options: DEFAULT_OPTIONS } });
    expect(DEFAULT_OPTIONS.freshnessDays).toBe(14);
    expect(DEFAULT_OPTIONS.batchSize).toBeLessThanOrEqual(1_000);
    expect(DEFAULT_OPTIONS.maxRunMs).toBeLessThanOrEqual(600_000);
  });

  it("every bound is enforced: freshness 1-90 days, batch 1-1000, run time 1-600 seconds, scan limit 1-100000", () => {
    const ok = (extra: Record<string, string>) => readReconcileConfig({ ...on, ...extra });
    expect(ok({ LEADS_RECONCILE_FRESHNESS_DAYS: "1" }).kind).toBe("ready");
    expect(ok({ LEADS_RECONCILE_FRESHNESS_DAYS: "90" }).kind).toBe("ready");
    for (const bad of ["0", "91", "-1", "1.5", "abc", "14d", "9999999"])
      expect(ok({ LEADS_RECONCILE_FRESHNESS_DAYS: bad }), bad).toMatchObject({ kind: "invalid" });
    for (const [key, good, bad] of [
      ["LEADS_RECONCILE_BATCH_SIZE", ["1", "1000"], ["0", "1001", "x"]],
      ["LEADS_RECONCILE_MAX_SECONDS", ["1", "600"], ["0", "601", "x"]],
      ["LEADS_RECONCILE_SCAN_LIMIT", ["1", "100000"], ["0", "100001", "x"]],
      ["LEADS_RECONCILE_STATEMENT_TIMEOUT_SECONDS", ["1", "120"], ["0", "121", "x"]],
      ["LEADS_RECONCILE_LOCK_TIMEOUT_SECONDS", ["1", "60"], ["0", "61", "x"]],
    ] as const) {
      for (const g of good) expect(ok({ [key]: g }).kind, `${key}=${g}`).toBe("ready");
      for (const b of bad) expect(ok({ [key]: b }).kind, `${key}=${b}`).toBe("invalid");
    }
    const r = ok({
      LEADS_RECONCILE_FRESHNESS_DAYS: "30",
      LEADS_RECONCILE_BATCH_SIZE: "7",
      LEADS_RECONCILE_MAX_SECONDS: "12",
      LEADS_RECONCILE_SCAN_LIMIT: "99",
    });
    expect(r).toMatchObject({
      kind: "ready",
      config: { options: { freshnessDays: 30, batchSize: 7, maxRunMs: 12_000, scanLimit: 99 } },
    });
  });

  it("problems name the KEY only: no value, in particular no database password, is ever echoed", () => {
    const r = readReconcileConfig({
      LEADS_RECONCILER_ENABLED: "true",
      DATABASE_URL: "postgres://user:secretpw@/",
      LEADS_RECONCILE_BATCH_SIZE: "SECRETVALUE",
    });
    expect(r.kind).toBe("invalid");
    const text = JSON.stringify(r);
    expect(text).toContain("DATABASE_URL");
    expect(text).toContain("LEADS_RECONCILE_BATCH_SIZE");
    expect(text).not.toContain("secretpw");
    expect(text).not.toContain("SECRETVALUE");
    expect(readReconcileConfig({ LEADS_RECONCILER_ENABLED: "true" })).toMatchObject({
      kind: "invalid",
    });
    expect(
      readReconcileConfig({ LEADS_RECONCILER_ENABLED: "true", DATABASE_URL: "mysql://u@h/db" }),
    ).toMatchObject({ kind: "invalid" });
  });
});
