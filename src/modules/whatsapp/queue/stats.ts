import { sql } from "drizzle-orm";
import { schema, type DbExecutor } from "@/db";
import { LEASE_SECONDS } from "./policy";

// Queue health numbers. Counts and ages only: no payload, phone number, BSUID or message text is selected.

export type QueueStats = {
  byStatus: Record<(typeof schema.WEBHOOK_EVENT_STATUSES)[number], number>;
  /** Seconds the oldest due PENDING/FAILED event has been waiting past its due time (null when none is due). */
  oldestDueAgeSeconds: number | null;
  /** PROCESSING rows whose lease expired: nobody is working on them; the next claim reclaims them. */
  expiredLeases: number;
};

/**
 * `eventTypes` (when given) limits `oldestDueAgeSeconds` to the types a worker can claim, so events nobody will ever claim
 * (no handler installed) do not look like a stuck queue.
 */
export async function readQueueStats(
  db: DbExecutor,
  leaseSeconds: number = LEASE_SECONDS,
  eventTypes?: readonly string[],
): Promise<QueueStats> {
  const typeFilter = eventTypes
    ? eventTypes.length === 0
      ? sql`AND false`
      : sql`AND event_type IN (${sql.join(
          eventTypes.map((t) => sql`${t}`),
          sql`, `,
        )})`
    : sql``;
  const [counts, health] = await Promise.all([
    db.execute<{ status: string; n: number }>(
      sql`SELECT status, count(*)::int AS n FROM webhook_events GROUP BY status`,
    ),
    db.execute<{ oldest: number | null; expired: number }>(sql`
      SELECT
        (SELECT floor(extract(epoch FROM now() - min(next_attempt_at)))::int FROM webhook_events
          WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= now() ${typeFilter}) AS oldest,
        (SELECT count(*)::int FROM webhook_events
          WHERE status = 'PROCESSING'
            AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => ${leaseSeconds}))) AS expired
    `),
  ]);
  const byStatus = Object.fromEntries(
    schema.WEBHOOK_EVENT_STATUSES.map((s) => [s, 0]),
  ) as QueueStats["byStatus"];
  for (const row of counts.rows)
    if (row.status in byStatus) byStatus[row.status as keyof typeof byStatus] = row.n;
  const h = health.rows[0];
  return { byStatus, oldestDueAgeSeconds: h?.oldest ?? null, expiredLeases: h?.expired ?? 0 };
}
