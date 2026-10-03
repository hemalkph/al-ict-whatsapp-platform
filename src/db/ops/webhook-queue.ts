import { sql } from "drizzle-orm";
import type { DbExecutor } from "./executor";

/**
 * Claims up to `limit` events: due PENDING/FAILED rows, plus PROCESSING rows whose lease expired.
 * FOR UPDATE SKIP LOCKED lets concurrent workers claim disjoint rows. attempts is incremented on
 * every claim. Returns the claimed row ids (RETURNING order is unspecified).
 */
export async function claimWebhookEvents(
  db: DbExecutor,
  opts: { limit: number; workerId: string; leaseSeconds: number },
): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`
    WITH candidates AS (
      SELECT id FROM webhook_events
      WHERE (status IN ('PENDING', 'FAILED') AND next_attempt_at <= now())
         OR (status = 'PROCESSING' AND locked_at < now() - make_interval(secs => ${opts.leaseSeconds}))
      ORDER BY received_at, id
      LIMIT ${opts.limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE webhook_events e
    SET status = 'PROCESSING', locked_at = now(), locked_by = ${opts.workerId}, attempts = e.attempts + 1
    FROM candidates c
    WHERE e.id = c.id
    RETURNING e.id
  `);
  return result.rows.map((r) => r.id);
}
