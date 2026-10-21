import { describe, expect, it } from "vitest";
import {
  claimFailureBackoffMs,
  deferralDelayMs,
  isClaimable,
  isTerminalizationCandidate,
  planDeferral,
} from "./backoff";

const S = 1_000;

describe("claim failure backoff: 5 s, 15 s, 45 s, 2 min, 5 min, +-20 %", () => {
  const bases = [5 * S, 15 * S, 45 * S, 120 * S, 300 * S];
  it.each(bases.map((b, i) => [i + 1, b] as const))(
    "claim %i: %i ms centre, 80 % to 120 %",
    (claim, base) => {
      expect(claimFailureBackoffMs(claim, () => 0.5)).toBe(base);
      expect(claimFailureBackoffMs(claim, () => 0)).toBe(Math.round(base * 0.8));
      expect(claimFailureBackoffMs(claim, () => 1)).toBe(Math.round(base * 1.2));
    },
  );

  it("every value in the jitter range stays within +-20 %", () => {
    for (const base of bases)
      for (let r = 0; r <= 1; r += 0.05) {
        const v = claimFailureBackoffMs(bases.indexOf(base) + 1, () => r)!;
        expect(v).toBeGreaterThanOrEqual(Math.round(base * 0.8));
        expect(v).toBeLessThanOrEqual(Math.round(base * 1.2));
      }
  });

  it("there is no backoff after the sixth claim or for a nonsense claim number: terminalization takes over", () => {
    for (const claim of [6, 7, 0, -1, 1.5, Number.NaN])
      expect(
        claimFailureBackoffMs(claim, () => 0.5),
        String(claim),
      ).toBeNull();
  });

  it("a misbehaving random source is clamped, never producing a wild delay", () => {
    expect(claimFailureBackoffMs(1, () => 99)).toBe(Math.round(5 * S * 1.2));
    expect(claimFailureBackoffMs(1, () => -5)).toBe(Math.round(5 * S * 0.8));
    expect(claimFailureBackoffMs(1, () => Number.NaN)).toBe(5 * S);
  });
});

describe("the deferral ladder: 2 s, 4 s, 8 s, then 15 s", () => {
  it("is selected by the deferrals already recorded", () => {
    expect([0, 1, 2, 3, 4, 10, 999].map(deferralDelayMs)).toEqual([
      2 * S,
      4 * S,
      8 * S,
      15 * S,
      15 * S,
      15 * S,
      15 * S,
    ]);
  });
  it("treats nonsense as the first rung or the last, never throws", () => {
    expect(deferralDelayMs(-3)).toBe(2 * S);
    expect(deferralDelayMs(2.9)).toBe(8 * S);
  });
});

describe("claims and terminalization", () => {
  it("a trigger is claimable for attempts 0 to 5 and never at 6", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(isClaimable)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });
  it("only attempts = 6 is a terminalization candidate", () => {
    expect([0, 5, 6, 7].map(isTerminalizationCandidate)).toEqual([false, false, true, false]);
  });
});

describe("deferral and refund arithmetic", () => {
  it("refunds the claim-time attempt exactly once and schedules from the freshness clock", () => {
    expect(planDeferral({ attempts: 1, deferrals: 0 }, 100_000)).toEqual({
      ok: true,
      attempts: 0,
      deferrals: 1,
      nextAttemptAtMs: 102_000,
    });
    expect(planDeferral({ attempts: 3, deferrals: 2 }, 100_000)).toEqual({
      ok: true,
      attempts: 2,
      deferrals: 3,
      nextAttemptAtMs: 108_000,
    });
    expect(planDeferral({ attempts: 2, deferrals: 7 }, 100_000)).toMatchObject({
      nextAttemptAtMs: 115_000,
    });
  });

  it("re-planning from the planned values refunds again only if a new claim charged again (no double refund)", () => {
    const first = planDeferral({ attempts: 1, deferrals: 0 }, 0);
    expect(first.ok && first.attempts).toBe(0);
    // a replay with the old values is the caller's fence's job; with the refunded values there is nothing left to refund
    expect(planDeferral({ attempts: 0, deferrals: 1 }, 0)).toEqual({
      ok: false,
      reason: "no_charged_attempt",
    });
  });

  it("a trigger at the database's deferral ceiling cannot be deferred again", () => {
    expect(planDeferral({ attempts: 1, deferrals: 999 }, 0).ok).toBe(true);
    expect(planDeferral({ attempts: 1, deferrals: 1000 }, 0)).toEqual({
      ok: false,
      reason: "deferral_limit",
    });
  });

  it("never produces attempts or deferrals outside the database CHECK ranges (0..6, 0..1000)", () => {
    for (let attempts = 1; attempts <= 6; attempts++)
      for (const deferrals of [0, 1, 500, 999]) {
        const p = planDeferral({ attempts, deferrals }, 0);
        expect(p.ok).toBe(true);
        if (p.ok) {
          expect(p.attempts).toBeGreaterThanOrEqual(0);
          expect(p.attempts).toBeLessThanOrEqual(5);
          expect(p.deferrals).toBeLessThanOrEqual(1000);
        }
      }
  });
});
