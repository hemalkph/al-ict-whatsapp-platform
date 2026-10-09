import { describe, expect, it } from "vitest";
import { HANDLER_TIMEOUT_MS } from "../queue/policy";
import {
  IDLE_MAX_MS,
  OUTAGE_MAX_MS,
  SHUTDOWN_GRACE_MS,
  idleDelayMs,
  outageDelayMs,
} from "./policy";

const mid = () => 0.5; // jitter factor 1.0

describe("worker timing", () => {
  it("idle polling starts short, doubles, and is capped at 5 s", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => idleDelayMs(n, mid))).toEqual([
      500, 1000, 2000, 4000, 5000, 5000, 5000,
    ]);
  });

  it("database-trouble backoff doubles from 1 s and is capped at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 40].map((n) => outageDelayMs(n, mid))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });

  it("jitter is +/-20% and never exceeds the ceiling or goes below 80% of nominal", () => {
    expect(idleDelayMs(1, () => 0)).toBe(400);
    expect(idleDelayMs(1, () => 1)).toBe(600);
    for (let n = 1; n < 12; n++) {
      for (const r of [0, 0.25, 0.999, 1, -5, 7]) {
        expect(idleDelayMs(n, () => r)).toBeLessThanOrEqual(IDLE_MAX_MS);
        expect(outageDelayMs(n, () => r)).toBeLessThanOrEqual(OUTAGE_MAX_MS);
        expect(idleDelayMs(n, () => r)).toBeGreaterThanOrEqual(400);
      }
    }
  });

  it("the shutdown grace covers a full handler budget", () => {
    expect(SHUTDOWN_GRACE_MS).toBeGreaterThan(HANDLER_TIMEOUT_MS);
  });
});
