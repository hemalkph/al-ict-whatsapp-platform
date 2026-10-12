// Polling intervals for the inbox UI (ADR 0015: bounded polling, no realtime infrastructure). Read on the server and passed to
// the page, so the browser never reads the environment. Anything missing or out of range falls back to the default, and every
// value is clamped: a mistyped setting cannot turn the inbox into a request storm.

export type InboxConfig = {
  /** How often the conversation list refreshes while the tab is visible. */
  readonly listPollMs: number;
  /** How often the open conversation (messages, delivery states, reply readiness) refreshes while visible. */
  readonly chatPollMs: number;
};

export const INBOX_DEFAULTS = { listPollMs: 15_000, chatPollMs: 5_000 } as const;
const BOUNDS = { listPollMs: [3_000, 300_000], chatPollMs: [2_000, 120_000] } as const;

function bounded(raw: string | undefined, key: keyof InboxConfig): number {
  if (raw === undefined || !/^[0-9]{1,7}$/.test(raw)) return INBOX_DEFAULTS[key];
  const [min, max] = BOUNDS[key];
  const value = Number(raw);
  return value >= min && value <= max ? value : INBOX_DEFAULTS[key];
}

export function readInboxConfig(env: Record<string, string | undefined>): InboxConfig {
  return {
    listPollMs: bounded(env.INBOX_POLL_LIST_MS, "listPollMs"),
    chatPollMs: bounded(env.INBOX_POLL_CHAT_MS, "chatPollMs"),
  };
}
