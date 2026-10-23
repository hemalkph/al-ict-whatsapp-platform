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

// ------------------------------------------------------------------------------- Phase 08E-5: one session (plan I.5)
//
// The SAME two-statement protocol as above, for ONE bot session: the candidate statement is textually identical except for its
// session predicate (a static test pins that), and the hold touches only the rows this transaction locked. It never waits on a
// request row: a request a dispatcher claim or acceptance record holds is skipped, and the caller relies on the session change
// it commits in the same transaction (state + output_suppressed_at), which the dispatcher's claim and final authorization read.
// SENDING, ACCEPTED, REJECTED, HELD and UNKNOWN_OUTCOME requests are never candidates.

/** The hold code of a session-scoped suppression: the code the dispatcher itself uses for a suppressed session. */
export const OUTPUT_SUPPRESSED_HOLD_CODE = "bot_output_suppressed";

/** Only the executor is needed, so a Drizzle transaction or the runtime's DbExecutor both fit. */
export type SuppressionExecutor = Pick<Tx, "execute">;

/** The candidate statement for one session: its QUEUED BOT requests, locked in id order, skipping any row another holds. */
export function sessionSuppressionCandidatesSql(organizationId: string, sessionId: string): SQL {
  uuidArray([organizationId, sessionId]); // validates both
  return sql`SELECT r.id FROM outbound_requests r WHERE r.organization_id = ${organizationId} AND r.origin = 'BOT' AND r.state = 'QUEUED' AND r.bot_session_id = ${sessionId} ORDER BY r.id FOR UPDATE OF r SKIP LOCKED`;
}

/** The first statement of the session primitive. Exported for the concurrency regression's barrier. */
export async function lockSessionSuppressionCandidates(
  tx: SuppressionExecutor,
  organizationId: string,
  sessionId: string,
): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(
    sessionSuppressionCandidatesSql(organizationId, sessionId),
  );
  return result.rows.map((r) => r.id);
}

export type SessionSuppressionDeps = {
  /** TEST ONLY: replaces the candidate statement with an equivalent the regression can pause. Production passes none. */
  readonly lockSessionSuppressionCandidates?: typeof lockSessionSuppressionCandidates;
};

/**
 * Holds the QUEUED BOT requests of ONE session on the caller's transaction. Returns the ids moved QUEUED -> HELD; an empty
 * result can mean nothing was queued OR a dispatcher held the row (skipped, never waited for).
 */
export async function suppressSessionQueuedRequests(
  tx: SuppressionExecutor,
  organizationId: string,
  sessionId: string,
  holdCode: string,
  deps: SessionSuppressionDeps = {},
): Promise<{ readonly heldIds: readonly string[] }> {
  if (!/^[a-z0-9_]{1,64}$/.test(holdCode)) throw new Error("suppression: invalid hold code");
  uuidArray([organizationId, sessionId]);
  const lock = deps.lockSessionSuppressionCandidates ?? lockSessionSuppressionCandidates;
  const locked = await lock(tx, organizationId, sessionId);
  if (locked.length === 0) return { heldIds: [] };
  const held = await tx.execute<{ id: string }>(sql`
      UPDATE outbound_requests o
         SET state = 'HELD', hold_reason = ${holdCode}, finished_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE o.organization_id = ${organizationId} AND o.id = ANY(${uuidArray(locked)}::uuid[]) AND o.state = 'QUEUED'
         AND o.origin = 'BOT' AND o.bot_session_id = ${sessionId}
      RETURNING o.id`);
  return { heldIds: held.rows.map((r) => r.id) };
}
