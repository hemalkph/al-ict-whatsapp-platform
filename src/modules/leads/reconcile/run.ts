import type { Database } from "@/db";
import type { ReconcileOptions } from "./config";
import { recordFailure } from "./failure";
import { failureCode } from "./policy";
import { processCandidate, type AttemptTrace } from "./process";
import {
  UNKNOWN_REMAINING,
  readRemaining,
  scanCandidates,
  type Candidate,
  type Remaining,
  type ScanPosition,
} from "./scan";

// One bounded reconciliation run. It scans candidates oldest first (received_at, id) page by page, handles each in its own
// transaction, and stops at the first of: the batch of processed touches, the run's time, the scan limit, a failed or timed-out
// scan, or the end of the candidates. It never promises that everything is finished: the report says what was done and what
// remains, as counts only (no identifier of a person, a contact, a touch or a message appears in it).
//
// BUDGETS (all documented in the runbook):
//  - batchSize: touches PROCESSED (given a decision, linked, or used to create a lead, or that failed);
//  - scanLimit: candidates EXAMINED (returned by the scan and then attempted or passed over), whatever happens to them. It is NOT
//    a limit on the rows PostgreSQL looks at to find them: the scan drops busy organizations and contacts, decided and held-back
//    touches inside the query (scan.ts), and those never reach this count;
//  - maxRunMs: ADMISSION CONTROL, not a deadline. After this the run admits NO new work: no candidate scan, no further page, no
//    candidate. batchSize is checked at the same places. Both are checked BEFORE each of those (stopBefore
//    below) and report `time_limit` / `batch_limit`. A statement that was already admitted is not interrupted by the budget: it is
//    bounded by PostgreSQL's own lock_timeout and statement_timeout (bounded.ts), and either finishes or fails, so one run can last
//    longer than its budget: by the bounded statements already in flight, and by the bounded count query at the end (which is
//    always attempted so that the report says what remains).
//
// PROGRESS (what each run does about work it cannot do now), every reason counted on its own and no touch counted twice:
//  - decided touches (skipped, parked) and retries that are not due are never candidates (the scan query leaves them out);
//  - a contact whose lock is held by someone else is left out by the scan query too, and one that turns busy between the scan and
//    the attempt is `busy`; its later touches in this run are passed over for the same reason (`busy`), so a later inquiry never
//    overtakes an earlier one of the same contact;
//  - a touch that an earlier touch's RETRY still holds back from initiating a lead is `waiting`, and so are the later touches of
//    that contact in this run;
//  - an ORGANIZATION whose row staff management holds (suspension, demotion) is skipped by the scan query itself (FOR KEY SHARE
//    ... SKIP LOCKED), however many there are, and costs no scan budget; one that turns busy between the scan and the attempt is
//    `busy` for that touch (the attempt's own NOWAIT lock revalidates it), and the contact's later touches are passed over;
//  - a failure is recorded as the next step of the retry policy IN THE ATTEMPT'S OWN TRANSACTION (process.ts) and the scan
//    continues with the next candidate.
// Because busy organizations and contacts and held-back touches never occupy the scan, repeated runs (separate processes) reach
// the eligible work behind them, as long as the organizations and contacts in front are held by compliant writers at scan time
// (ADR 0016: a conditional guarantee, not universal fairness).

export type ReconcileReport = {
  /** Candidates returned by the scan queries (some may be left unexamined when the run stops mid-page). */
  readonly fetched: number;
  /** Candidates examined: attempted or passed over for a reason of their own. Bounded by the scan limit. */
  readonly scanned: number;
  readonly processed: number;
  readonly linked: number;
  readonly created: number;
  readonly skipped: {
    readonly stale: number;
    readonly beforeCycle: number;
    readonly converted: number;
    readonly archived: number;
  };
  readonly retryScheduled: number;
  /** Touches that failed their fifth attempt in THIS run and are now parked for good. */
  readonly parked: number;
  /** Passed over because the contact, or a row of it, was in use (lock contention). Nothing was done and no attempt was spent. */
  readonly busy: number;
  /** Passed over by the first-touch policy: an earlier touch of the contact is in its retry back-off. Not lock contention. */
  readonly waiting: number;
  readonly conflicts: number;
  readonly gone: number;
  /** Failures that could not be recorded this time (the wait for a lock timed out): the touch is tried again. */
  readonly failuresUnrecorded: number;
  /**
   * Failures whose recording was NOT repeated because it cannot be told whether it already happened: the attempt's COMMIT may
   * have landed with its acknowledgement lost, another worker may have moved the touch on, or the state was never observed.
   * Nothing was written by the fallback, so no attempt was consumed twice.
   */
  readonly failuresUncertain: number;
  /** Failures by fixed code (a SQLSTATE such as pg_23514, pg_55p03 or pg_57014, or internal_error). */
  readonly errors: Readonly<Record<string, number>>;
  readonly stopReason:
    | "exhausted"
    | "batch_limit"
    | "time_limit"
    | "scan_limit"
    /** The candidate scan itself failed or hit PostgreSQL's lock or statement timeout; see `errors`. */
    | "query_failed";
  readonly remaining: Remaining;
  readonly durationMs: number;
};

export type RunHooks = {
  /** Tests only: the clock used for the run's time limit. */
  readonly now?: () => number;
  /** Tests only: called after each candidate has been handled, with the kind of outcome (a fixed word). */
  readonly afterCandidate?: (outcome: string) => Promise<void> | void;
};

const contactKey = (c: Candidate) => `${c.organizationId}:${c.contactId}`;
type PassedOver = "busy" | "waiting" | "conflict";

export async function runReconciliation(
  db: Database,
  options: ReconcileOptions,
  hooks: RunHooks = {},
): Promise<ReconcileReport> {
  const now = hooks.now ?? (() => performance.now());
  const started = now();
  const counts = {
    fetched: 0,
    scanned: 0,
    processed: 0,
    linked: 0,
    created: 0,
    stale: 0,
    beforeCycle: 0,
    converted: 0,
    archived: 0,
    retryScheduled: 0,
    parked: 0,
    busy: 0,
    waiting: 0,
    conflicts: 0,
    gone: 0,
    failuresUnrecorded: 0,
    failuresUncertain: 0,
  };
  const errors: Record<string, number> = {};
  const noteError = (error: unknown) => {
    const code = failureCode(error);
    errors[code] = (errors[code] ?? 0) + 1;
    return code;
  };
  const passedOver = new Map<string, PassedOver>();
  const passOver = (candidate: Candidate, reason: PassedOver) => {
    if (!passedOver.has(contactKey(candidate))) passedOver.set(contactKey(candidate), reason);
  };
  const tally = (reason: PassedOver) => {
    if (reason === "busy") counts.busy++;
    else if (reason === "waiting") counts.waiting++;
    else counts.conflicts++;
  };
  let stopReason: ReconcileReport["stopReason"] = "exhausted";
  let position: ScanPosition | null = null;
  // ADMISSION: asked before every page and every candidate. The batch is exhausted, or the budget spent.
  const stopBefore = (): "batch_limit" | "time_limit" | null =>
    counts.processed >= options.batchSize
      ? "batch_limit"
      : now() - started >= options.maxRunMs
        ? "time_limit"
        : null;

  scan: for (;;) {
    const room = Math.min(options.pageSize, options.scanLimit - counts.scanned);
    if (room <= 0) {
      stopReason = "scan_limit";
      break;
    }
    const stopPage = stopBefore();
    if (stopPage) {
      stopReason = stopPage;
      break;
    }
    let page: Candidate[];
    try {
      page = await scanCandidates(db, position, room, options);
      counts.fetched += page.length;
    } catch (error) {
      noteError(error);
      stopReason = "query_failed";
      break;
    }
    if (page.length === 0) break;
    for (const candidate of page) {
      const stopCandidate = stopBefore();
      if (stopCandidate) {
        stopReason = stopCandidate;
        break scan;
      }
      position = { t: candidate.receivedKey, id: candidate.attributionId };
      counts.scanned++;
      const earlier = passedOver.get(contactKey(candidate));
      if (earlier) {
        tally(earlier);
        continue;
      }
      const trace: AttemptTrace = { firstConsideredAt: null };
      try {
        const outcome = await processCandidate(db, candidate, options, trace);
        await hooks.afterCandidate?.(outcome.kind);
        switch (outcome.kind) {
          case "linked":
            counts.processed++;
            counts.linked++;
            break;
          case "created":
            counts.processed++;
            counts.created++;
            break;
          case "skipped":
            counts.processed++;
            if (outcome.decision === "SKIPPED_STALE") counts.stale++;
            else if (outcome.decision === "SKIPPED_BEFORE_CYCLE") counts.beforeCycle++;
            else if (outcome.decision === "SKIPPED_CONVERTED") counts.converted++;
            else counts.archived++;
            break;
          case "busy":
            counts.busy++;
            passOver(candidate, "busy");
            break;
          case "waiting":
            counts.waiting++;
            passOver(candidate, "waiting");
            break;
          case "organization_busy":
            counts.busy++;
            passOver(candidate, "busy");
            break;
          case "conflict":
            counts.conflicts++;
            passOver(candidate, "conflict");
            break;
          case "failed": {
            // the attempt failed and the failure was recorded in its own transaction, the contact held throughout
            counts.processed++;
            errors[outcome.code] = (errors[outcome.code] ?? 0) + 1;
            if (outcome.recorded.kind === "retry") counts.retryScheduled++;
            else if (outcome.recorded.kind === "parked") counts.parked++;
            else if (outcome.recorded.kind === "busy") {
              counts.failuresUnrecorded++;
              passOver(candidate, "busy");
            } else if (outcome.recorded.kind === "changed" || outcome.recorded.kind === "unknown")
              counts.failuresUncertain++;
            break;
          }
          case "gone":
            counts.gone++;
            break;
        }
      } catch (error) {
        // the attempt's transaction itself failed (connection, commit): the failure could not be recorded inside it, and WHETHER IT
        // COMMITTED IS UNKNOWN (the acknowledgement of a COMMIT can be lost after the server committed). The fallback therefore
        // takes the locks again and records only if the committed state is still the one the attempt observed; otherwise it
        // writes nothing (failure.ts). The contact was released in between.
        const code = noteError(error);
        counts.processed++;
        try {
          // the first-consideration instant and the observed state of the FAILED attempt go with the failure
          const recorded = await recordFailure(db, candidate, code, options, trace);
          if (recorded.kind === "retry") counts.retryScheduled++;
          else if (recorded.kind === "parked") counts.parked++;
          else if (recorded.kind === "busy") {
            counts.failuresUnrecorded++;
            passOver(candidate, "busy");
          } else if (recorded.kind === "changed" || recorded.kind === "unknown")
            counts.failuresUncertain++;
        } catch (recordError) {
          noteError(recordError);
          counts.failuresUnrecorded++;
          passOver(candidate, "busy");
        }
        await hooks.afterCandidate?.("failed");
      }
    }
    if (page.length < room) break; // the end of the candidates
  }

  let remaining: Remaining = UNKNOWN_REMAINING;
  try {
    remaining = await readRemaining(db, options);
  } catch (error) {
    // the count is bounded like every query; a failure of it is reported as unknown, never hidden and never fatal
    noteError(error);
  }
  return {
    fetched: counts.fetched,
    scanned: counts.scanned,
    processed: counts.processed,
    linked: counts.linked,
    created: counts.created,
    skipped: {
      stale: counts.stale,
      beforeCycle: counts.beforeCycle,
      converted: counts.converted,
      archived: counts.archived,
    },
    retryScheduled: counts.retryScheduled,
    parked: counts.parked,
    busy: counts.busy,
    waiting: counts.waiting,
    conflicts: counts.conflicts,
    gone: counts.gone,
    failuresUnrecorded: counts.failuresUnrecorded,
    failuresUncertain: counts.failuresUncertain,
    errors,
    stopReason,
    remaining,
    durationMs: Math.round(now() - started),
  };
}
