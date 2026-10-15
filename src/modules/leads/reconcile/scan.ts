import { sql } from "drizzle-orm";
import type { Database } from "@/db";
import { CURSOR_FORMAT } from "../cursor";
import { bounded } from "./bounded";
import type { ReconcileOptions } from "./config";

// Candidate selection for the reconciler: a bounded, deterministic KEYSET scan over (received_at, id) of the touches that could
// still be acted on: confirmed Meta ad touches of INBOUND messages (the touch's own message decides, never the touch alone) on the
// partial index lead_attributions_unlinked_ad_idx. Candidates are read without locking any attribution, lead, decision, contact or
// message row, and every one is re-read under the proper locks before anything is done: a scanned row is only a pointer. The scan
// runs under PostgreSQL's own lock and statement timeouts.
//
// WHAT NEVER OCCUPIES A PAGE, because the query itself leaves it out:
//  - a touch with a TERMINAL decision (skipped or parked) and a RETRY that is not due yet;
//  - a touch whose contact is BUSY: its advisory lock (the one every lead writer takes first) is held by another session of THIS
//    database right now, read from pg_locks. The check is only a hint (the lock can be taken a moment later, and handling TRIES
//    the lock itself, which is the authority);
//  - a touch that a RETRY of an EARLIER touch still holds back from initiating a lead (the policy hold; never when the contact has
//    an open lead);
//  - a touch of an ORGANIZATION that is busy right now (ADR 0016, third review M3): the query asks PostgreSQL for the
//    organization row FOR KEY SHARE ... SKIP LOCKED. Staff management (suspension, demotion, reactivation) holds the row FOR UPDATE
//    for its whole transaction, which conflicts: the row is skipped, the candidate is not returned and it does NOT use up the LIMIT,
//    however many organizations are busy. No probe, no per-run list, no limit on the number of busy organizations.
// All four are decided in the SQL; handling re-reads and re-decides all of them under the locks.
//
// THE ORGANIZATION LOCK OF THE SCAN. It is taken inside the scan's own short transaction and released when that transaction ends,
// which is before any candidate is handled: nothing of it is held across the per-candidate transactions, which take the organization
// lock, the contact's advisory lock and the row locks again in the contract order. The scan holds NO other lock (no attribution,
// lead, decision or contact row lock, and no advisory lock), so it cannot invert the lock order; it never waits for a row lock
// (SKIP LOCKED); only a TABLE lock (a migration) can make it wait, and lock_timeout ends that. It is written as a correlated
// EXISTS over the organization row, not as a join: with `JOIN organizations ... FOR KEY SHARE OF o SKIP LOCKED` PostgreSQL puts
// the locking step above the whole join tree, so every candidate of a busy organization went through all the joins before being
// dropped (measured: about a hundred times the buffers of this form on a disposable data set); as a filter on the attribution row
// the lock is asked for before the joins and the LIMIT still stops the index scan early.
//
// ROWS EXAMINED, CANDIDATES RETURNED, TOUCHES PROCESSED are three different numbers. PostgreSQL examines index entries in
// (received_at, id) order and drops those that are not candidates (busy organization, busy contact, decided, held back): their
// number is NOT bounded by the scan limit (it is bounded by statement_timeout and by how many such rows lie ahead of the first
// eligible one) and is not reported. The query RETURNS at most the page size. The run PROCESSES (decides, links, creates) at most
// the batch size.

export type Candidate = {
  readonly organizationId: string;
  readonly attributionId: string;
  readonly contactId: string;
  /** The exact ordering key (microsecond UTC text) of received_at. */
  readonly receivedKey: string;
};

export type ScanPosition = { readonly t: string; readonly id: string };

/**
 * The key of the contact's advisory lock, computed IN SQL from a candidate row: the same text as `contactLockKey` in ../locks.ts,
 * hashed the same way. (The two must agree: a test holds a lock taken with the application's key and checks that the scan leaves
 * the contact out.) pg_advisory_xact_lock(bigint) keeps the high 32 bits of the key in classid and the low 32 bits in objid.
 */
const CONTACT_KEY_SQL = sql`hashtextextended('lead-contact:' || a.organization_id::text || ':' || a.contact_id::text, 0)`;

/**
 * The candidate query (exported so that a test can EXPLAIN exactly what the scan runs). `after` is the keyset position.
 */
export function candidateQuery(
  after: ScanPosition | null,
  limit: number,
  options: ReconcileOptions,
) {
  return sql`
      WITH held AS MATERIALIZED (
        SELECT ((l.classid::bigint << 32) | l.objid::bigint) AS k
        FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.database = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())
      )
      SELECT a.organization_id, a.id, a.contact_id,
             to_char(a.received_at AT TIME ZONE 'UTC', ${sql.raw(CURSOR_FORMAT)}) AS key_t
      FROM lead_attributions a
      JOIN LATERAL (SELECT 1 FROM messages m
                    JOIN conversations c ON c.organization_id = m.organization_id AND c.id = m.conversation_id
                    WHERE m.organization_id = a.organization_id AND m.id = a.message_id AND m.direction = 'INBOUND'
                      AND c.contact_id = a.contact_id
                    LIMIT 1) inbound ON true
      LEFT JOIN lead_reconcile_decisions d
             ON d.organization_id = a.organization_id AND d.attribution_id = a.id
      WHERE a.lead_id IS NULL AND a.source_type = 'META_AD' AND a.message_id IS NOT NULL
        AND (d.attribution_id IS NULL OR (d.decision = 'RETRY' AND d.next_attempt_at <= clock_timestamp()))
        ${after ? sql`AND (a.received_at, a.id) > (${after.t}::timestamptz, ${after.id}::uuid)` : sql``}
        AND NOT EXISTS (SELECT 1 FROM held WHERE held.k = ${CONTACT_KEY_SQL})
        AND (
          EXISTS (SELECT 1 FROM leads ol
                  WHERE ol.organization_id = a.organization_id AND ol.contact_id = a.contact_id AND ol.closed_at IS NULL)
          OR NOT EXISTS (
            SELECT 1 FROM lead_attributions e
            JOIN messages em ON em.organization_id = e.organization_id AND em.id = e.message_id AND em.direction = 'INBOUND'
            JOIN conversations ec ON ec.organization_id = em.organization_id AND ec.id = em.conversation_id
                                 AND ec.contact_id = e.contact_id
            JOIN lead_reconcile_decisions ed ON ed.organization_id = e.organization_id AND ed.attribution_id = e.id
            WHERE e.organization_id = a.organization_id AND e.contact_id = a.contact_id
              AND e.lead_id IS NULL AND e.source_type = 'META_AD'
              AND (e.received_at, e.id) < (a.received_at, a.id)
              AND ed.decision = 'RETRY'
              AND ed.created_at + (${options.holdMinutes}::int * interval '1 minute') > clock_timestamp())
        )
        AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = a.organization_id FOR KEY SHARE SKIP LOCKED)
      ORDER BY a.received_at, a.id
      LIMIT ${limit}`;
}

export async function scanCandidates(
  db: Database,
  after: ScanPosition | null,
  limit: number,
  options: ReconcileOptions,
): Promise<Candidate[]> {
  return bounded(db, options, async (tx) => {
    const result = await tx.execute<{
      organization_id: string;
      id: string;
      contact_id: string;
      key_t: string;
    }>(candidateQuery(after, limit, options));
    return result.rows.map((r) => ({
      organizationId: r.organization_id,
      attributionId: r.id,
      contactId: r.contact_id,
      receivedKey: r.key_t,
    }));
  });
}

/** Work that is left, bounded: counts only. */
export const REMAINING_CAP = 10_000;

export type Remaining = {
  /** False when the count could not be read (it failed or timed out): the numbers are then zero and mean nothing. */
  readonly known: boolean;
  /** Touches that can be acted on now (undecided, or a RETRY that is due), counted up to a cap. */
  readonly due: number;
  readonly dueCapped: boolean;
  /** Retries waiting for their time. */
  readonly retryWaiting: number;
  /** Touches that failed five times and are parked for good. */
  readonly parked: number;
};

export const UNKNOWN_REMAINING: Remaining = {
  known: false,
  due: 0,
  dueCapped: false,
  retryWaiting: 0,
  parked: 0,
};

export async function readRemaining(db: Database, options: ReconcileOptions): Promise<Remaining> {
  return bounded(db, options, async (tx) => {
    const result = await tx.execute<{ due: number; waiting: number; parked: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM (
           SELECT 1 FROM lead_attributions a
           JOIN messages m ON m.organization_id = a.organization_id AND m.id = a.message_id AND m.direction = 'INBOUND'
           JOIN conversations c ON c.organization_id = m.organization_id AND c.id = m.conversation_id
                               AND c.contact_id = a.contact_id
           LEFT JOIN lead_reconcile_decisions d
                  ON d.organization_id = a.organization_id AND d.attribution_id = a.id
           WHERE a.lead_id IS NULL AND a.source_type = 'META_AD' AND a.message_id IS NOT NULL
             AND (d.attribution_id IS NULL OR (d.decision = 'RETRY' AND d.next_attempt_at <= clock_timestamp()))
           LIMIT ${REMAINING_CAP + 1}) due) AS due,
        (SELECT count(*)::int FROM (
           SELECT 1 FROM lead_reconcile_decisions d
           JOIN lead_attributions a ON a.organization_id = d.organization_id AND a.id = d.attribution_id
           JOIN messages m ON m.organization_id = a.organization_id AND m.id = a.message_id AND m.direction = 'INBOUND'
           JOIN conversations c ON c.organization_id = m.organization_id AND c.id = m.conversation_id
                               AND c.contact_id = a.contact_id
           WHERE d.decision = 'RETRY' AND d.next_attempt_at > clock_timestamp()
             AND a.lead_id IS NULL AND a.source_type = 'META_AD' AND a.message_id IS NOT NULL
           LIMIT ${REMAINING_CAP + 1}) waiting) AS waiting,
        (SELECT count(*)::int FROM (
           SELECT 1 FROM lead_reconcile_decisions d
           JOIN lead_attributions a ON a.organization_id = d.organization_id AND a.id = d.attribution_id
           JOIN messages m ON m.organization_id = a.organization_id AND m.id = a.message_id AND m.direction = 'INBOUND'
           JOIN conversations c ON c.organization_id = m.organization_id AND c.id = m.conversation_id
                               AND c.contact_id = a.contact_id
           WHERE d.decision = 'PARKED'
             AND a.lead_id IS NULL AND a.source_type = 'META_AD' AND a.message_id IS NOT NULL
           LIMIT ${REMAINING_CAP + 1}) parked) AS parked`);
    const row = result.rows[0]!;
    return {
      known: true,
      due: Math.min(row.due, REMAINING_CAP),
      dueCapped: row.due > REMAINING_CAP,
      retryWaiting: Math.min(row.waiting, REMAINING_CAP),
      parked: Math.min(row.parked, REMAINING_CAP),
    };
  });
}
