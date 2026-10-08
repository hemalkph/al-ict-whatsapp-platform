import { describe, expect, it } from "vitest";
import { FUTURE_SKEW_MS, effectiveActivityTime } from "./time";

describe("effectiveActivityTime", () => {
  const received = new Date("2026-06-01T12:00:00Z");
  it("keeps a provider time at or before receipt + 5 minutes", () => {
    for (const offset of [-86_400_000, 0, 60_000, FUTURE_SKEW_MS]) {
      const provider = new Date(received.getTime() + offset);
      expect(effectiveActivityTime(provider, received)).toBe(provider);
    }
  });
  it("caps a later provider time at receipt + 5 minutes", () => {
    const capped = effectiveActivityTime(new Date("2099-01-01T00:00:00Z"), received);
    expect(capped.getTime()).toBe(received.getTime() + 5 * 60_000);
    expect(
      effectiveActivityTime(new Date(received.getTime() + FUTURE_SKEW_MS + 1), received).getTime(),
    ).toBe(received.getTime() + FUTURE_SKEW_MS);
  });
});
