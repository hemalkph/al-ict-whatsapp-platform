// Provider timestamps are facts and are never rewritten, but derived state (activity, last-seen, profile freshness) must
// not be moved arbitrarily far into the future by a hostile or broken timestamp. The effective time is the provider
// time, capped at the moment WE received the event plus a small clock-skew allowance (ADR 0013, decision 6).

export const FUTURE_SKEW_MS = 5 * 60 * 1000;

export function effectiveActivityTime(providerTime: Date, receivedAt: Date): Date {
  const cap = receivedAt.getTime() + FUTURE_SKEW_MS;
  return providerTime.getTime() > cap ? new Date(cap) : providerTime;
}
