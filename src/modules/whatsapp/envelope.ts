import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { isRecord } from "./parse";

// The ONE place that knows where the stored event envelope keeps the routing identifiers (the envelope is written by
// normalize.ts: `{ v, wabaId, field, metadata: { phone_number_id, ... }, ... }`). Queue code that has to find an
// event's intended phone_number_id (UNROUTABLE events have NULL routing columns) goes through these helpers, never
// through its own JSON paths.

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export function phoneNumberIdOf(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.metadata)) return null;
  return nonEmpty(payload.metadata.phone_number_id);
}

export function wabaIdOf(payload: unknown): string | null {
  return isRecord(payload) ? nonEmpty(payload.wabaId) : null;
}

/** SQL equivalents of the two readers above, for filtering a `payload` column. */
export const payloadPhoneNumberId = (payload: AnyColumn): SQL<string | null> =>
  sql`${payload} #>> '{metadata,phone_number_id}'`;
export const payloadWabaId = (payload: AnyColumn): SQL<string | null> =>
  sql`${payload} ->> 'wabaId'`;
