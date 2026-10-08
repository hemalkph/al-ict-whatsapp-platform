import { describe, expect, it } from "vitest";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  HANDLER_TIMEOUT_MS,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  REQUEUE_MAX_AGE_MS,
  STATEMENT_TIMEOUT_MS,
  retryDelayMs,
  retryDelaySeconds,
} from "./policy";

describe("queue policy constants", () => {
  it("are the approved values, and the handler budget fits inside the lease", () => {
    expect(MAX_ATTEMPTS).toBe(8);
    expect(LEASE_SECONDS).toBe(120);
    expect(HANDLER_TIMEOUT_MS).toBe(60_000);
    expect(STATEMENT_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_BATCH_SIZE).toBe(20);
    expect(DEFAULT_CONCURRENCY).toBe(2);
    expect(REQUEUE_MAX_AGE_MS).toBe(30 * 24 * 3600 * 1000);
    expect(HANDLER_TIMEOUT_MS).toBeLessThan(LEASE_SECONDS * 1000);
  });
});

describe("retry delay", () => {
  it("is exactly 30s, 1m, 2m, 4m, 8m, 16m, 32m after attempts 1-7, and there is no retry after attempt 8", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(retryDelaySeconds)).toEqual([
      30, 60, 120, 240, 480, 960, 1920,
    ]);
    expect(retryDelaySeconds(8)).toBeNull();
    expect(retryDelaySeconds(9)).toBeNull();
    expect([1, 2, 3, 4, 5, 6, 7].reduce((sum, n) => sum + retryDelaySeconds(n)!, 0)).toBe(3810);
  });

  it("rejects an attempt that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN])
      expect(() => retryDelaySeconds(bad)).toThrow(RangeError);
  });

  it("applies uniform jitter of at most +/-20% and nothing else", () => {
    for (let attempt = 1; attempt <= 7; attempt++) {
      const nominal = retryDelaySeconds(attempt)! * 1000;
      expect(retryDelayMs(attempt, () => 0)).toBe(Math.round(nominal * 0.8));
      expect(retryDelayMs(attempt, () => 0.5)).toBe(nominal);
      expect(retryDelayMs(attempt, () => 0.999999999)).toBeLessThanOrEqual(
        Math.round(nominal * 1.2),
      );
      for (let i = 0; i <= 1000; i++) {
        const v = retryDelayMs(attempt, () => i / 1001)!;
        expect(v).toBeGreaterThanOrEqual(nominal * 0.8 - 1);
        expect(v).toBeLessThanOrEqual(nominal * 1.2 + 1);
      }
    }
  });

  it("clamps a misbehaving random source into range and gives no delay when no retry remains", () => {
    expect(retryDelayMs(1, () => -5)).toBe(24_000);
    expect(retryDelayMs(1, () => 7)).toBe(36_000);
    expect(retryDelayMs(8, () => 0.5)).toBeNull();
  });
});
