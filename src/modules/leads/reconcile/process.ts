import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@/db";
import { isOpenLeadConflict } from "../errors";
import { afterLockTime, contactLockKey, type Tx } from "../locks";
import { bounded, isLockTimeout } from "./bounded";
import type { ReconcileOptions } from "./config";
import { observeState, recordFailureIn, type FailureOutcome, type Observed } from "./failure";
import { decide, failureCode, type Facts, type SkipDecision } from "./policy";
import type { Candidate } from "./scan";

// Handling ONE candidate touch in ONE transaction. The lock order is the contract of ADR 0016 (the reconciler has no staff actor,
// so there is no membership lock):
//   1. the organization row FOR KEY SHARE (what a lead INSERT takes through its foreign key anyway; it keeps this writer on the
//      same side as staff management, which locks the organization FOR UPDATE first),
//   2. the contact's advisory lock, TRIED without waiting,
//   3. the contact row FOR SHARE, then the contact's open lead FOR UPDATE,
//   4. the touch row FOR UPDATE (never before the contact lock), then its decision row FOR UPDATE,
//   5. history insertion.
// NOTHING IS WAITED FOR: every row lock above is taken NOWAIT and the advisory lock is only tried, so a contact or row that is in
// use is passed over at once (SQLSTATE 55P03, reported as "busy", never as a failure) and the scan moves on. Only a table-level
// lock (a migration) can make a statement wait, and PostgreSQL's lock_timeout then ends the wait (bounded.ts).
// Everything about eligibility is READ AGAIN under those locks; the candidate row that was scanned is only a pointer.
//
// Everything the touch causes (the decision, the lead, its CREATED and TOUCH_LINKED history, the link, the removal of a RETRY row)
// commits together or not at all, and the database's own rules (migration 0006) are the final check on every part of it.

export type Outcome =
  | { readonly kind: "linked" }
  | { readonly kind: "created" }
  | { readonly kind: "skipped"; readonly decision: SkipDecision }
  /** The contact (or a row of it) is in use: nothing was done and no attempt was spent. */
  | { readonly kind: "busy" }
  /** An earlier touch of the contact is in its retry back-off and still holds this one back from initiating a lead. */
  | { readonly kind: "waiting" }
  /** Staff management (or another exclusive writer) took the organization row after the scan: this touch is passed over, nothing was done. */
  | { readonly kind: "organization_busy" }
  /** The attempt failed and was rolled back; the failure was recorded in the SAME transaction while the contact was still held. */
  | { readonly kind: "failed"; readonly code: string; readonly recorded: FailureOutcome }
  /** The database's one-open-lead rule fired for a writer that does not follow the lock order: try again later. */
  | { readonly kind: "conflict" }
  /** Nothing to do any more: already linked, already decided, no longer a candidate. */
  | { readonly kind: "gone" };

/**
 * What the caller keeps of an attempt even when it fails and rolls back: the database-clock instant at which the attempt began.
 * It is the trusted FIRST-CONSIDERATION time of a touch that has no RETRY row yet, and recordFailure stores it as the anchor of the
 * new RETRY row, so that recording the failure later cannot move the freshness anchor forward.
 */
export type AttemptTrace = {
  firstConsideredAt: string | null;
  /**
   * The state of the touch the attempt observed under the contact lock, before its fallible work (null or absent: none was).
   * The fallback after an ambiguous COMMIT records a failure only if the committed state is still this one (failure.ts).
   */
  prior?: Observed | null;
};

type TouchRow = {
  lead_id: string | null;
  source_type: string;
  inbound: boolean;
  received_at: string;
  evidence_at: string | null;
};

type FactRow = {
  stale: boolean;
  predates: boolean;
  at_or_before_closure: boolean;
  converted: boolean;
  holding: boolean;
};

/** The organization row is locked against a writer that needs it exclusively (staff management): not the touch's, nor the contact's, fault. */
export class OrganizationBusyError extends Error {
  constructor() {
    super("organization_busy");
    this.name = "OrganizationBusyError";
  }
}

/**
 * Takes the organization lock and TRIES the contact's advisory lock. Both without waiting. False: the contact is busy. Throws
 * OrganizationBusyError when staff management (or another exclusive writer) holds the organization row.
 */
export async function enterContact(tx: Tx, c: Candidate): Promise<boolean> {
  try {
    await tx
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, c.organizationId))
      .for("key share", { noWait: true });
  } catch (error) {
    if (isLockTimeout(error)) throw new OrganizationBusyError();
    throw error;
  }
  const result = await tx.execute<{ ok: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${contactLockKey(c.organizationId, c.contactId)}, 0)) AS ok`,
  );
  return result.rows[0]!.ok === true;
}

// THE SHAPE OF AN ATTEMPT (review C-M2). One transaction, one savepoint:
//   BEGIN  (lock_timeout and statement_timeout set, transaction-local)
//     organization FOR KEY SHARE NOWAIT, contact advisory lock TRIED          <- held until COMMIT, whatever happens below
//     the first-consideration instant, read from the database clock           <- while the contact is held
//     SAVEPOINT
//       handle(): the contact, the open lead, the touch and its decision revalidated and locked NOWAIT, the facts, the decision
//       or the lead with its history and link; then SET CONSTRAINTS ALL IMMEDIATE so that the deferred history triggers (which
//       would otherwise fire at COMMIT, outside any savepoint) run INSIDE the savepoint
//     on a recoverable failure: ROLLBACK TO SAVEPOINT, then, STILL HOLDING the contact, record the RETRY (or PARKED) row with the
//     original anchor (failure.ts)
//   COMMIT
// The advisory lock and the organization lock are taken BEFORE the savepoint, so rolling back to it cannot release them; the row
// locks taken after it are released by the rollback and are taken again, in the approved order, by the recording. A concurrent
// reconciler therefore finds the contact busy for the whole attempt, and afterwards finds the recorded RETRY (not due): it can
// never judge the touch stale in the gap between the rollback and the recording.
//
// What is NOT covered (documented in ADR 0016 and the runbook): a lost connection or a server crash loses the transaction, the
// anchor with it; the touch is then judged afresh by a later run. A failure to record (a lock timeout on the touch or decision
// row, held by a writer outside the contract) is reported as unrecorded for the same reason.
export async function processCandidate(
  db: Database,
  c: Candidate,
  options: ReconcileOptions,
  trace: AttemptTrace = { firstConsideredAt: null },
): Promise<Outcome> {
  try {
    return await bounded(db, options, async (tx) => {
      if (!(await enterContact(tx, c))) return { kind: "busy" } as Outcome;
      // the trusted first-consideration time: the database clock, read while this transaction holds the contact
      const anchor = (await tx.execute<{ t: string }>(sql`SELECT clock_timestamp()::text AS t`))
        .rows[0]!.t;
      trace.firstConsideredAt = anchor;
      // the state of the touch BEFORE anything can fail, read with the contact held (not the scan's stale row)
      const prior = await observeState(tx, c);
      if (!prior || prior.kind === "linked" || prior.kind === "terminal")
        return { kind: "gone" } as Outcome;
      trace.prior = prior;
      try {
        return await tx.transaction(async (savepoint) => {
          const outcome = await handle(savepoint, c, options, anchor);
          await savepoint.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
          return outcome;
        });
      } catch (error) {
        if (isLockTimeout(error)) return { kind: "busy" } as Outcome;
        if (isOpenLeadConflict(error)) return { kind: "conflict" } as Outcome;
        const code = failureCode(error);
        let recorded: FailureOutcome;
        try {
          recorded = await tx.transaction((savepoint) =>
            recordFailureIn(savepoint, c, code, anchor, prior),
          );
        } catch (recordError) {
          // a row held by a writer outside the contract: the failure is not recorded this time
          if (!isLockTimeout(recordError)) throw recordError;
          recorded = { kind: "busy" };
        }
        return { kind: "failed", code, recorded } as Outcome;
      }
    });
  } catch (error) {
    if (error instanceof OrganizationBusyError) return { kind: "organization_busy" };
    if (isLockTimeout(error)) return { kind: "busy" };
    if (isOpenLeadConflict(error)) return { kind: "conflict" };
    throw error;
  }
}

async function handle(
  tx: Tx,
  c: Candidate,
  options: ReconcileOptions,
  startedAt: string,
): Promise<Outcome> {
  const [contact] = await tx
    .select({ archivedAt: schema.contacts.archivedAt })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.organizationId, c.organizationId),
        eq(schema.contacts.id, c.contactId),
      ),
    )
    .for("share", { noWait: true });
  if (!contact) return { kind: "gone" };

  // the contact's open lead, locked BEFORE the touch row
  const [open] = await tx
    .select({
      id: schema.leads.id,
      cycleStartedAt: sql<string>`${schema.leads.cycleStartedAt}::text`,
    })
    .from(schema.leads)
    .where(
      and(
        eq(schema.leads.organizationId, c.organizationId),
        eq(schema.leads.contactId, c.contactId),
        inArray(schema.leads.status, schema.OPEN_LEAD_STATUSES),
      ),
    )
    .for("update", { noWait: true });

  // the touch, locked AFTER the contact lock and the lead, and re-read: it must still be a candidate, and the message that carried
  // it must be an INBOUND one (an outbound message is never a customer inquiry)
  const touchResult = await tx.execute<TouchRow>(sql`
    SELECT a.lead_id, a.source_type,
           COALESCE(m.direction = 'INBOUND' AND c.contact_id = a.contact_id, false) AS inbound,
           a.received_at::text AS received_at, LEAST(a.received_at, m.occurred_at)::text AS evidence_at
    FROM lead_attributions a
    LEFT JOIN messages m ON m.organization_id = a.organization_id AND m.id = a.message_id
    LEFT JOIN conversations c ON c.organization_id = m.organization_id AND c.id = m.conversation_id
    WHERE a.organization_id = ${c.organizationId}::uuid AND a.id = ${c.attributionId}::uuid
      AND a.contact_id = ${c.contactId}::uuid
    FOR UPDATE OF a NOWAIT`);
  const touch = touchResult.rows[0];
  if (
    !touch ||
    touch.lead_id !== null ||
    touch.source_type !== "META_AD" ||
    !touch.inbound ||
    touch.evidence_at === null
  )
    return { kind: "gone" };

  // its decision row, if any: a terminal decision is final; a RETRY must still be due
  const decisionResult = await tx.execute<{
    decision: string;
    attempts: number;
    created_at: string;
    due: boolean;
  }>(sql`
    SELECT decision, attempts, created_at::text AS created_at,
           (decision = 'RETRY' AND next_attempt_at <= clock_timestamp()) AS due
    FROM lead_reconcile_decisions
    WHERE organization_id = ${c.organizationId}::uuid AND attribution_id = ${c.attributionId}::uuid
    FOR UPDATE NOWAIT`);
  const existing = decisionResult.rows[0];
  if (existing && !existing.due) return { kind: "gone" };

  // the facts, from the database's own clock and exact timestamps. FRESHNESS is judged against the touch's FIRST consideration:
  // the created_at of its RETRY row when it has one (it is never moved by a later attempt), otherwise the instant this very
  // attempt began (startedAt, read from the database clock before anything else; recordFailure stores it if the attempt fails).
  const ev = touch.evidence_at;
  const factResult = await tx.execute<FactRow>(sql`
    SELECT
      ${ev}::timestamptz
        < COALESCE(${existing?.created_at ?? null}::timestamptz, ${startedAt}::timestamptz)
          - (${options.freshnessDays}::int * interval '1 day') AS stale,
      ${open ? sql`${ev}::timestamptz < ${open.cycleStartedAt}::timestamptz` : sql`false`} AS predates,
      COALESCE((SELECT bool_or(l.closed_at >= ${ev}::timestamptz) FROM leads l
                WHERE l.organization_id = ${c.organizationId}::uuid AND l.contact_id = ${c.contactId}::uuid
                  AND l.closed_at IS NOT NULL), false) AS at_or_before_closure,
      COALESCE((SELECT bool_or(l.status = 'CONVERTED') FROM leads l
                WHERE l.organization_id = ${c.organizationId}::uuid AND l.contact_id = ${c.contactId}::uuid), false)
        AS converted,
      EXISTS (SELECT 1 FROM lead_attributions e
              JOIN messages em ON em.organization_id = e.organization_id AND em.id = e.message_id AND em.direction = 'INBOUND'
            JOIN conversations ec ON ec.organization_id = em.organization_id AND ec.id = em.conversation_id
                                 AND ec.contact_id = e.contact_id
              JOIN lead_reconcile_decisions ed ON ed.organization_id = e.organization_id AND ed.attribution_id = e.id
              WHERE e.organization_id = ${c.organizationId}::uuid AND e.contact_id = ${c.contactId}::uuid
                AND e.lead_id IS NULL AND e.source_type = 'META_AD'
                AND (e.received_at, e.id) < (${touch.received_at}::timestamptz, ${c.attributionId}::uuid)
                AND ed.decision = 'RETRY'
                AND ed.created_at + (${options.holdMinutes}::int * interval '1 minute') > clock_timestamp()) AS holding`);
  const f = factResult.rows[0]!;
  const facts: Facts = {
    archived: contact.archivedAt !== null,
    stale: f.stale,
    openLead: open ? { id: open.id, touchPredatesCycle: f.predates } : null,
    atOrBeforeLatestClosure: f.at_or_before_closure,
    converted: f.converted,
    earlierTouchHolding: f.holding,
  };
  const verdict = decide(facts);
  if (verdict.action === "wait") return { kind: "waiting" };

  const at = await afterLockTime(tx);
  const stamp = sql`${at}::timestamptz`;

  if (verdict.action === "skip") {
    if (existing)
      await tx
        .update(schema.leadReconcileDecisions)
        .set({ decision: verdict.decision, nextAttemptAt: null, updatedAt: stamp })
        .where(
          and(
            eq(schema.leadReconcileDecisions.organizationId, c.organizationId),
            eq(schema.leadReconcileDecisions.attributionId, c.attributionId),
          ),
        );
    else
      await tx.insert(schema.leadReconcileDecisions).values({
        organizationId: c.organizationId,
        attributionId: c.attributionId,
        contactId: c.contactId,
        decision: verdict.decision,
        attempts: 0,
        createdAt: sql`${startedAt}::timestamptz`,
        updatedAt: stamp,
      });
    return { kind: "skipped", decision: verdict.decision };
  }

  let leadId: string;
  if (verdict.action === "create") {
    // The lead names its initiating touch in its own INSERT; the database sets its cycle start from that touch's receipt time.
    const [lead] = await tx
      .insert(schema.leads)
      .values({
        organizationId: c.organizationId,
        contactId: c.contactId,
        status: "NEW",
        revision: 0,
        initiatingAttributionId: c.attributionId,
        statusChangedAt: stamp,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning({ id: schema.leads.id });
    leadId = lead!.id;
    await tx.insert(schema.leadEvents).values({
      organizationId: c.organizationId,
      leadId,
      contactId: c.contactId,
      kind: "CREATED",
      origin: "AD_REFERRAL",
      attributionId: c.attributionId,
      revision: 0,
      createdAt: stamp,
    });
  } else leadId = verdict.leadId;

  // link, then remove a waiting RETRY row, then write the history (the order the database's triggers require)
  await tx
    .update(schema.leadAttributions)
    .set({ leadId })
    .where(
      and(
        eq(schema.leadAttributions.organizationId, c.organizationId),
        eq(schema.leadAttributions.id, c.attributionId),
      ),
    );
  if (existing)
    await tx
      .delete(schema.leadReconcileDecisions)
      .where(
        and(
          eq(schema.leadReconcileDecisions.organizationId, c.organizationId),
          eq(schema.leadReconcileDecisions.attributionId, c.attributionId),
        ),
      );
  await tx.insert(schema.leadEvents).values({
    organizationId: c.organizationId,
    leadId,
    contactId: c.contactId,
    kind: "TOUCH_LINKED",
    attributionId: c.attributionId,
    // a moment of its own, later than the CREATED row of the same transaction, so the history reads in the order things happened
    createdAt: sql`clock_timestamp()`,
  });
  return { kind: verdict.action === "create" ? "created" : "linked" };
}
