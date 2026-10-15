import { z } from "zod";

// Opaque keyset cursors. The timestamp travels as the exact text PostgreSQL produced (microseconds), because a JavaScript Date
// would round it to milliseconds and could skip or repeat a row at a page boundary. A cursor is validated strictly on the way
// back in and is only ever used as a bound parameter, never interpolated.

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/;

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const daysInMonth = (year: number, month: number) =>
  month === 2 ? (isLeapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

/**
 * The text is a real instant, not just the right shape: a real month, a real day of that month (leap years included), hour
 * 0-23, minute and second 0-59 (a leap second is not a value PostgreSQL produces for this text). Checked on the components, so
 * the six-digit microseconds are kept exactly as PostgreSQL wrote them (a JavaScript Date would round them to milliseconds).
 */
export function isCalendarTimestamp(value: string): boolean {
  const m = TIMESTAMP.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

const payload = z.strictObject({
  t: z.string().refine(isCalendarTimestamp, "not a timestamp"),
  id: z.uuid(),
});
export type Cursor = z.infer<typeof payload>;

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

/** Returns null for anything that is not a cursor this module produced. */
export function decodeCursor(value: string): Cursor | null {
  if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = payload.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** SQL expression text that renders a timestamptz column as the cursor text (UTC, microseconds). */
export const CURSOR_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
