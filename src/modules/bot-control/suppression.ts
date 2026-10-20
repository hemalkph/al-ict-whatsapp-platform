import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "./common";

// The ONE way to suppress queued BOT output (Phase 08D, ADR 0020; the correction of the acceptance-recording versus
// Stop-suppression concurrency finding). Stop, Emergency Stop and Retire use it now; the 08E sweeper and terminalization must
// reuse it (a static test pins that no other code writes BOT requests to HELD outside the dispatcher).
//
// The finding: a suppression statement that WAITS on a request row can close a cycle. Stop holds the conversation lock; its
// statement saw request R as QUEUED; meanwhile a dispatcher claimed R (SENDING) and, Meta having accepted it, the acceptance
// record holds R's newest version and waits for the conversation; a waiting UPDATE of R must wait for that record -> deadlock,
// and the victim is either the Stop or the acceptance record (which then marks an accepted message UNKNOWN_OUTCOME).
//
// The correction: candidates are locked with FOR UPDATE OF r SKIP LOCKED, so a request whose newest version is held by a
// dispatcher (claim or acceptance record) is skipped, never waited for; a request that is no longer QUEUED fails the re-check
// without a wait. The hold then touches only the rows THIS transaction locked. Both statements run on the caller's
// transaction (same connection), so the locks are held until it commits. Stop therefore has no wait edge to any request row.
//
// A skipped request is not lost: Stop commits its epoch bump in the same transaction, and the dispatcher's claim and final
// authorization hold any BOT request whose epoch no longer matches (bot_epoch_superseded). One whose final authorization had
// already passed may still be sent; that attempt cannot be recalled (V3.2 I.4, blocker 42).

/** PostgreSQL array literal of validated UUIDs, passed as ONE text parameter and cast to uuid[]. */
function uuidArray(ids: readonly string[]): string {
  for (const id of ids)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
      throw new Error("suppression: not a UUID");
  return `{${ids.join(",")}}`;
}

/**
 * The candidate statement: every QUEUED BOT request of the deployments' sessions (live or terminal, so a terminal notice is
 * included), locked one at a time in id order, skipping any row another transaction holds.
 */
export function suppressionCandidatesSql(
  organizationId: string,
  deploymentIds: readonly string[],
): SQL {
  return sql`SELECT r.id FROM outbound_requests r WHERE r.organization_id = ${organizationId} AND r.origin = 'BOT' AND r.state = 'QUEUED' AND r.bot_session_id IN (SELECT s.id FROM bot_sessions s WHERE s.organization_id = ${organizationId} AND s.deployment_id = ANY(${uuidArray(deploymentIds)}::uuid[])) ORDER BY r.id FOR UPDATE OF r SKIP LOCKED`;
}

/** Locks the candidates (the first statement of the primitive). Exported for the concurrency regression's barrier. */
export async function lockSuppressionCandidates(
  tx: Tx,
  organizationId: string,
  deploymentIds: readonly string[],
): Promise<string[]> {
  if (deploymentIds.length === 0) return [];
  const result = await tx.execute<{ id: string }>(
    suppressionCandidatesSql(organizationId, deploymentIds),
  );
  return result.rows.map((r) => r.id);
}

export type SuppressionCounts = {
  /** Per deployment: requests this call moved QUEUED -> HELD. */
  readonly suppressed: ReadonlyMap<string, number>;
  /** Per deployment: requests still QUEUED or SENDING in the snapshot of the count statement (after the hold). */
  readonly inFlight: ReadonlyMap<string, number>;
};

/** Holds the requests locked by lockSuppressionCandidates, then counts what remains in flight. */
export async function holdLockedAndCount(
  tx: Tx,
  organizationId: string,
  deploymentIds: readonly string[],
  lockedIds: readonly string[],
  holdCode: string,
): Promise<SuppressionCounts> {
  const suppressed = new Map<string, number>(deploymentIds.map((id) => [id, 0]));
  const inFlight = new Map<string, number>(deploymentIds.map((id) => [id, 0]));
  if (deploymentIds.length === 0) return { suppressed, inFlight };
  if (lockedIds.length > 0) {
    const held = await tx.execute<{ deployment_id: string }>(sql`
      UPDATE outbound_requests o
         SET state = 'HELD', hold_reason = ${holdCode}, finished_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE o.organization_id = ${organizationId} AND o.id = ANY(${uuidArray(lockedIds)}::uuid[]) AND o.state = 'QUEUED'
      RETURNING (SELECT s.deployment_id FROM bot_sessions s
                  WHERE s.organization_id = o.organization_id AND s.id = o.bot_session_id) AS deployment_id`);
    for (const r of held.rows)
      suppressed.set(r.deployment_id, (suppressed.get(r.deployment_id) ?? 0) + 1);
  }
  const counts = await tx.execute<{ deployment_id: string; n: number }>(sql`
    SELECT s.deployment_id, count(*)::int AS n
      FROM outbound_requests r
      JOIN bot_sessions s ON s.organization_id = r.organization_id AND s.id = r.bot_session_id
     WHERE r.organization_id = ${organizationId} AND r.origin = 'BOT' AND r.state IN ('QUEUED', 'SENDING')
       AND s.deployment_id = ANY(${uuidArray(deploymentIds)}::uuid[])
     GROUP BY s.deployment_id`);
  for (const r of counts.rows) inFlight.set(r.deployment_id, Number(r.n));
  return { suppressed, inFlight };
}

/** The primitive: lock the candidates (SKIP LOCKED), hold exactly those, count what remains in flight. One transaction. */
export async function suppressQueuedBotRequests(
  tx: Tx,
  organizationId: string,
  deploymentIds: readonly string[],
  holdCode: string,
): Promise<SuppressionCounts> {
  const locked = await lockSuppressionCandidates(tx, organizationId, deploymentIds);
  return holdLockedAndCount(tx, organizationId, deploymentIds, locked, holdCode);
}
