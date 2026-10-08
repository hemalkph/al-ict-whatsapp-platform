// Provider timestamps are facts and are never rewritten, but derived state (activity, last-seen, profile freshness) must
// not be moved arbitrarily far into the future by a hostile or broken timestamp. The effective time is the provider
// time, capped at the moment WE received the event plus a small clock-skew allowance (ADR 0013, decision 6).

export const FUTURE_SKEW_MS = 5 * 60 * 1000;

export function effectiveActivityTime(providerTime: Date, receivedAt: Date): Date {
  const cap = receivedAt.getTime() + FUTURE_SKEW_MS;
  return providerTime.getTime() > cap ? new Date(cap) : providerTime;
}

/** Epoch seconds (string or number) -> Date, or null when it is not a positive integer inside the Date range. */
export function parseProviderTimestamp(value: unknown): Date | null {
  let seconds: number;
  if (typeof value === "number") seconds = value;
  else if (typeof value === "string" && /^\d{1,13}$/.test(value)) seconds = Number(value);
  else return null;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}
