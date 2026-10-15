import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@/db";
import { contactLockKey, type Tx } from "../locks";
import { bounded, isLockTimeout } from "./bounded";
import type { ReconcileOptions } from "./config";
import { stepAfterFailure } from "./policy";
import type { Candidate } from "./scan";

// Recording that an attempt FAILED. A failure moves the touch one step along the retry policy: RETRY with attempts 1-4 and a due
// time 1 minute, 5 minutes, 30 minutes and 2 hours ahead, then PARKED at the fifth failed attempt. The code is a fixed
// content-free code (a SQLSTATE or "internal_error"), never a message.
//
// WHERE IT RUNS. Normally INSIDE the attempt's own transaction (recordFailureIn, called by process.ts after the failed work was
// rolled back to its savepoint): the organization lock and the contact's advisory lock were taken before the savepoint and are
// still held, so no other reconciler can judge the touch between the failure and its recording. recordFailure (a transaction of its
// own) is the FALLBACK for when the attempt's transaction itself was lost (a killed connection, a crash of the backend): the
// contact was released with it, and this transaction takes everything again.
//
// AMBIGUOUS COMMIT (third review, M1). When the attempt's transaction fails at COMMIT the caller cannot know whether it committed:
// the acknowledgement can be lost AFTER the server committed (a RETRY row, a decision, a lead with its link). The fallback therefore
// never records "one more failure" on faith. Before the risky work the attempt OBSERVED the state of the touch (observeState, under
// the contact lock): no decision, a RETRY with N attempts, a terminal decision, or linked. The fallback takes the locks again,
// reads the committed state and records ONLY when it is still exactly the observed one (nothing committed, so the failure is
// really new); a different state means the attempt's own COMMIT landed, or another worker moved the touch on, and either way this
// failure must not consume a second attempt. A linked touch and a terminal decision are never touched; a failure before any state
// was observed is not recorded at all (the outcome is unknown, never guessed).
//
// THE FRESHNESS ANCHOR. A touch that was fresh when its first attempt began must not become stale because the attempt FAILED and
// the failure was written later. The first attempt's own start (read from the database clock, never from JavaScript or from
// any input) is stored as the `created_at` of the new RETRY row, which is the anchor every later attempt judges freshness by
// (process.ts). An existing RETRY row keeps its original anchor: it is only ever updated, never recreated.
//
// LOCKS. Same order as handling the touch (organization, contact, touch, decision). Taking the first two again inside the attempt's
// transaction is a no-op; in the fallback this transaction WAITS for them and for row locks, but only as long as PostgreSQL's
// lock_timeout allows (bounded.ts): a failure is rare, and an unrecorded failure loses the anchor (the touch is judged afresh next
// run), so a short bounded wait is the better trade here than skipping. If the wait times out the failure is not recorded this
// time (reported as unrecorded, not hidden).

export type FailureOutcome =
  | { readonly kind: "retry"; readonly attempts: number }
  | { readonly kind: "parked" }
  | { readonly kind: "busy" }
  | { readonly kind: "gone" }
  /** The committed state is no longer the one the attempt observed (its own COMMIT landed, or another worker moved the touch on): nothing is written. */
  | { readonly kind: "changed" }
  /** No state was observed before the failure, so it cannot be told whether recording would double-count: nothing is written. */
  | { readonly kind: "unknown" };

/** The reconciliation state of a touch as an attempt saw it, under the contact's lock, before its fallible work. */
export type Observed =
  | { readonly kind: "absent" }
  | { readonly kind: "retry"; readonly attempts: number }
  | { readonly kind: "terminal" }
  | { readonly kind: "linked" };

/**
 * Reads the current state of the touch (no row lock: every writer of a decision or a link holds the contact's lock, which the
 * caller holds). Null: no such touch of this contact.
 */
export async function observeState(tx: Tx, c: Candidate): Promise<Observed | null> {
  const result = await tx.execute<{
    linked: boolean;
    decision: string | null;
    attempts: number | null;
  }>(sql`
    SELECT a.lead_id IS NOT NULL AS linked, d.decision, d.attempts
    FROM lead_attributions a
    LEFT JOIN lead_reconcile_decisions d ON d.organization_id = a.organization_id AND d.attribution_id = a.id
    WHERE a.organization_id = ${c.organizationId}::uuid AND a.id = ${c.attributionId}::uuid
      AND a.contact_id = ${c.contactId}::uuid`);
  const row = result.rows[0];
  if (!row) return null;
  if (row.linked) return { kind: "linked" };
  if (row.decision === null) return { kind: "absent" };
  if (row.decision === "RETRY") return { kind: "retry", attempts: row.attempts! };
  return { kind: "terminal" };
}

/**
 * The recording itself, in a transaction that already exists. Two callers:
 *  - the attempt's OWN transaction (process.ts), after the failed work was rolled back to its savepoint. The organization lock and
 *    the contact's advisory lock taken before the savepoint are still held, so no other reconciler could have judged the touch in
 *    between; taking them again here is a no-op, and the touch and decision rows (locked after the savepoint, hence released by the
 *    rollback) are locked again in the approved order;
 *  - recordFailure below, in a transaction of its own (the fallback when the attempt's transaction could not record: a lost
 *    connection, a failed commit), where the same statements acquire everything, waiting only as long as lock_timeout allows.
 * `anchor` is the database-clock instant of the attempt's first consideration.
 */
export async function recordFailureIn(
  tx: Tx,
  c: Candidate,
  code: string,
  anchor: string,
  /** The state the attempt observed before its work; null when none was (nothing is then recorded). */
  expected: Observed | null,
): Promise<FailureOutcome> {
  await tx
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, c.organizationId))
    .for("key share");
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${contactLockKey(c.organizationId, c.contactId)}, 0))`,
  );
  // the touch row (never before the contact lock), then its decision row; an outbound message's touch is never a candidate
  const touch = await tx.execute<{ lead_id: string | null; inbound: boolean }>(sql`
    SELECT a.lead_id, COALESCE(m.direction = 'INBOUND' AND c.contact_id = a.contact_id, false) AS inbound
    FROM lead_attributions a
    LEFT JOIN messages m ON m.organization_id = a.organization_id AND m.id = a.message_id
    LEFT JOIN conversations c ON c.organization_id = m.organization_id AND c.id = m.conversation_id
    WHERE a.organization_id = ${c.organizationId}::uuid AND a.id = ${c.attributionId}::uuid
      AND a.contact_id = ${c.contactId}::uuid
    FOR UPDATE OF a`);
  if (!touch.rows[0] || touch.rows[0].lead_id !== null || !touch.rows[0].inbound)
    return { kind: "gone" as const };
  const decision = await tx.execute<{ decision: string; attempts: number }>(sql`
    SELECT decision, attempts FROM lead_reconcile_decisions
    WHERE organization_id = ${c.organizationId}::uuid AND attribution_id = ${c.attributionId}::uuid
    FOR UPDATE`);
  const existing = decision.rows[0];
  if (existing && existing.decision !== "RETRY") return { kind: "gone" as const };
  // only a state that is exactly the observed one proves that the attempted transition has not happened
  if (!expected || expected.kind === "linked" || expected.kind === "terminal")
    return { kind: "unknown" as const };
  const unchanged =
    expected.kind === "absent" ? !existing : existing?.attempts === expected.attempts;
  if (!unchanged) return { kind: "changed" as const };

  const step = stepAfterFailure(existing?.attempts ?? 0);
  const where = and(
    eq(schema.leadReconcileDecisions.organizationId, c.organizationId),
    eq(schema.leadReconcileDecisions.attributionId, c.attributionId),
  );
  // the due time is taken from the database clock at the moment of the write
  const next =
    step.decision === "RETRY"
      ? sql`clock_timestamp() + ${step.delaySeconds}::int * interval '1 second'`
      : null;
  const values = {
    decision: step.decision,
    attempts: step.attempts,
    nextAttemptAt: next,
    lastErrorCode: code,
    updatedAt: sql`clock_timestamp()`,
  };
  if (existing) await tx.update(schema.leadReconcileDecisions).set(values).where(where);
  else
    await tx.insert(schema.leadReconcileDecisions).values({
      organizationId: c.organizationId,
      attributionId: c.attributionId,
      contactId: c.contactId,
      ...values,
      // the anchor: the first attempt's own start. An existing RETRY row is only updated above, so its anchor is never moved.
      createdAt: sql`${anchor}::timestamptz`,
    });
  return step.decision === "RETRY"
    ? { kind: "retry" as const, attempts: step.attempts }
    : { kind: "parked" as const };
}

export async function recordFailure(
  db: Database,
  c: Candidate,
  code: string,
  options: ReconcileOptions,
  trace: { firstConsideredAt?: string | null; prior?: Observed | null } = {},
): Promise<FailureOutcome> {
  try {
    return await bounded(db, options, (tx, startedAt) =>
      recordFailureIn(tx, c, code, trace.firstConsideredAt ?? startedAt, trace.prior ?? null),
    );
  } catch (error) {
    if (isLockTimeout(error)) return { kind: "busy" };
    throw error;
  }
}
