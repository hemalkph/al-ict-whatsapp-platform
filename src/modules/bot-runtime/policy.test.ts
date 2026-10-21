import { describe, expect, it } from "vitest";
import { TRIGGER_ELIGIBLE_TYPES } from "@/modules/bots";
import { BOT_DISPATCH_DEADLINE_MS, SENDING_RECOVERY_AFTER_MS } from "@/modules/messaging/policy";
import {
  ELIGIBLE_MESSAGE_TYPES,
  RUNTIME_POLICY,
  claimLeaseExpired,
  evaluateHourlyCap,
  hourlyWindowStartMs,
  isEligibleMessageType,
  isStaleInput,
  latestT1EndMs,
  queuedRequestOverdueFromMs,
  sendWaitExpiresAtMs,
  t1MayStart,
} from "./policy";

const S = 1_000;
const M = 60 * S;
const H = 60 * M;

describe("approved runtime policy", () => {
  it("the owner-approved product limits (O-3)", () => {
    expect(RUNTIME_POLICY.cooldownMs).toBe(30 * M);
    expect(RUNTIME_POLICY.contactSessionCap).toBe(3);
    expect(RUNTIME_POLICY.contactSessionWindowMs).toBe(24 * H);
    expect(RUNTIME_POLICY.maxInputAgeMs).toBe(10 * M);
    expect(RUNTIME_POLICY.hourlyBotRequestCap).toBe(30);
    expect(RUNTIME_POLICY.hourlyWindowMs).toBe(H);
  });

  it("the reviewed technical values are unchanged", () => {
    expect(RUNTIME_POLICY).toMatchObject({
      pendingTriggerCap: 20,
      triggerMaxClaims: 6,
      maxDeferrals: 1000,
      claimLeaseMs: 60 * S,
      t1StartGuardMs: 20 * S,
      transactionTimeoutMs: 25 * S,
      idleInTransactionTimeoutMs: 10 * S,
      statementTimeoutMs: 15 * S,
      lockTimeoutMs: 5 * S,
      postEnqueueSkewMs: 2 * S,
      botDispatchDeadlineMs: 120 * S,
      queuedDeadlineGraceMs: 30 * S,
      sendingRecoveryMs: 5 * M,
      sendWaitMarginMs: 30 * S,
      backoffJitter: 0.2,
    });
    expect([...RUNTIME_POLICY.claimBackoffMs]).toEqual([5 * S, 15 * S, 45 * S, 120 * S, 300 * S]);
    expect([...RUNTIME_POLICY.deferralLadderMs]).toEqual([2 * S, 4 * S, 8 * S, 15 * S]);
  });

  it("the values that duplicate a messaging constant equal it", () => {
    expect(RUNTIME_POLICY.botDispatchDeadlineMs).toBe(BOT_DISPATCH_DEADLINE_MS);
    expect(RUNTIME_POLICY.sendingRecoveryMs).toBe(SENDING_RECOVERY_AFTER_MS);
  });

  it("is frozen, arrays included", () => {
    expect(Object.isFrozen(RUNTIME_POLICY)).toBe(true);
    expect(Object.isFrozen(RUNTIME_POLICY.claimBackoffMs)).toBe(true);
    expect(Object.isFrozen(RUNTIME_POLICY.deferralLadderMs)).toBe(true);
  });

  it("eligible message types are the bots module's definition: TEXT, INTERACTIVE, BUTTON", () => {
    expect(ELIGIBLE_MESSAGE_TYPES).toBe(TRIGGER_ELIGIBLE_TYPES);
    expect(isEligibleMessageType("TEXT") && isEligibleMessageType("BUTTON")).toBe(true);
    expect(isEligibleMessageType("REACTION")).toBe(false);
  });
});

describe("stale input (strictly older than maxInputAge)", () => {
  const now = 10_000_000;
  it("exactly ten minutes is processed; one millisecond more is stale", () => {
    expect(isStaleInput(now, now - 10 * M)).toBe(false);
    expect(isStaleInput(now, now - 10 * M - 1)).toBe(true);
    expect(isStaleInput(now, now)).toBe(false);
    expect(isStaleInput(now, now + 5_000)).toBe(false); // a message dated slightly in the future is not stale
  });
});

describe("transaction bound, start guard and lease arithmetic (J.6)", () => {
  const claimed = 1_000_000;
  it("T1 may start while the claim is at most 20 s old, inclusive", () => {
    expect(t1MayStart(claimed, claimed)).toBe(true);
    expect(t1MayStart(claimed, claimed + 20 * S)).toBe(true);
    expect(t1MayStart(claimed, claimed + 20 * S + 1)).toBe(false);
  });

  it("the latest a started T1 can run is 45 s after the claim, 15 s inside the 60 s lease", () => {
    expect(latestT1EndMs(claimed) - claimed).toBe(45 * S);
    expect(latestT1EndMs(claimed)).toBeLessThan(claimed + RUNTIME_POLICY.claimLeaseMs);
    expect(claimed + RUNTIME_POLICY.claimLeaseMs - latestT1EndMs(claimed)).toBe(15 * S);
  });

  it("a claim excludes other workers until the lease is strictly over", () => {
    expect(claimLeaseExpired(claimed, claimed + 60 * S)).toBe(false);
    expect(claimLeaseExpired(claimed, claimed + 60 * S + 1)).toBe(true);
  });

  it("the transaction bound is the largest timeout and the client-stall timeout is smaller", () => {
    expect(RUNTIME_POLICY.transactionTimeoutMs).toBeGreaterThan(RUNTIME_POLICY.statementTimeoutMs);
    expect(RUNTIME_POLICY.idleInTransactionTimeoutMs).toBeLessThan(
      RUNTIME_POLICY.transactionTimeoutMs,
    );
  });
});

describe("send wait and the queued-request grace", () => {
  it("a session waits for its request 5 minutes plus 30 s, then is given up on", () => {
    expect(sendWaitExpiresAtMs(1_000)).toBe(1_000 + 5 * M + 30 * S);
  });
  it("a QUEUED request is overdue 30 s after its dispatch deadline", () => {
    expect(queuedRequestOverdueFromMs(500_000)).toBe(530_000);
  });
});

describe("the rolling-hour BOT request cap (C-4)", () => {
  it("29 recent requests allow the 30th; 30 refuse the 31st", () => {
    expect(evaluateHourlyCap({ recentCount: 0, stepAlreadyHasRequest: false })).toEqual({
      decision: "allow",
    });
    expect(evaluateHourlyCap({ recentCount: 29, stepAlreadyHasRequest: false })).toEqual({
      decision: "allow",
    });
    expect(evaluateHourlyCap({ recentCount: 30, stepAlreadyHasRequest: false })).toEqual({
      decision: "refuse",
      code: "bot_hourly_cap",
    });
    expect(evaluateHourlyCap({ recentCount: 500, stepAlreadyHasRequest: false }).decision).toBe(
      "refuse",
    );
  });

  it("an idempotent replay is neither counted again nor refused, even at or over the cap", () => {
    for (const recentCount of [0, 29, 30, 31, 500])
      expect(evaluateHourlyCap({ recentCount, stepAlreadyHasRequest: true })).toEqual({
        decision: "replay",
      });
  });

  it("the window is the 60 minutes before the decision clock", () => {
    expect(hourlyWindowStartMs(10 * H)).toBe(9 * H);
  });
});
