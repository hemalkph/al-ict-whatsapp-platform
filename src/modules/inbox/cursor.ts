import { z } from "zod";

// Opaque keyset cursors. The timestamp travels as the exact text PostgreSQL produced (microseconds), because a JavaScript Date
// would round it to milliseconds and could skip or repeat a row at a page boundary. A cursor is validated strictly on the way
// back in and is only ever used as a bound parameter, never interpolated.

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const payload = z.strictObject({ t: z.string().regex(TIMESTAMP), id: z.uuid() });
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

/** SQL expression that renders a timestamptz column as the cursor text. */
export const CURSOR_TIMESTAMP_SQL = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
