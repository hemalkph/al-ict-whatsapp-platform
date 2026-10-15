// Reconciler configuration, read from an explicit environment object (never from process.env directly) so it is testable.
// FAIL CLOSED: a run happens only when LEADS_RECONCILER_ENABLED is exactly "true". Problems name the KEY only, never a value (a
// database URL contains a password). No Meta credential is read: the reconciler never calls Meta.

export type ReconcileOptions = {
  /** Evidence older than this many days when it is first considered is skipped (ADR 0016: default 14, configurable 1-90). */
  readonly freshnessDays: number;
  /** The most touches PROCESSED (given a decision, linked or used to create a lead) in one run. */
  readonly batchSize: number;
  /** The run stops starting new touches after this many milliseconds. */
  readonly maxRunMs: number;
  /** The most candidate rows READ in one run, whatever happens to them (busy contacts and the like are scanned past). */
  readonly scanLimit: number;
  /** Candidate rows read per query. */
  readonly pageSize: number;
  /**
   * The longest any ONE statement may wait for a table-level lock (a migration, say) before it fails: PostgreSQL's own
   * `lock_timeout`, set transaction-locally on every transaction the reconciler opens (scan, count, readiness, handling, failure
   * recording). Row locks are never waited for at all (NOWAIT).
   */
  readonly lockTimeoutMs: number;
  /** The longest any ONE statement may run, lock waits included: PostgreSQL's own `statement_timeout`, transaction-local. */
  readonly statementTimeoutMs: number;
  /** The policy hold (minutes) of an earlier touch in its retry back-off over a later touch that would initiate a lead. */
  readonly holdMinutes: number;
};

export const DEFAULT_OPTIONS: ReconcileOptions = {
  freshnessDays: 14,
  batchSize: 100,
  maxRunMs: 30_000,
  scanLimit: 5_000,
  pageSize: 200,
  lockTimeoutMs: 3_000,
  statementTimeoutMs: 20_000,
  holdMinutes: 15,
};

export type ReconcileConfig = { databaseUrl: string; options: ReconcileOptions };
export type ReconcileConfigResult =
  | { kind: "disabled" }
  | { kind: "invalid"; problems: string[] }
  | { kind: "ready"; config: ReconcileConfig };

type Source = Record<string, string | undefined>;

function bounded(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

function isPostgresUrl(raw: string | undefined): raw is string {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname !== "" &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

export function readReconcileConfig(source: Source): ReconcileConfigResult {
  const flag = source.LEADS_RECONCILER_ENABLED;
  if (flag === undefined || flag === "" || flag === "false") return { kind: "disabled" };
  const problems: string[] = [];
  if (flag !== "true") problems.push("LEADS_RECONCILER_ENABLED (must be exactly true or false)");
  if (!isPostgresUrl(source.DATABASE_URL))
    problems.push("DATABASE_URL (missing or not a postgres connection URL)");

  const freshnessDays = bounded(
    source.LEADS_RECONCILE_FRESHNESS_DAYS,
    DEFAULT_OPTIONS.freshnessDays,
    1,
    90,
  );
  if (freshnessDays === null) problems.push("LEADS_RECONCILE_FRESHNESS_DAYS (integer 1 to 90)");
  const batchSize = bounded(source.LEADS_RECONCILE_BATCH_SIZE, DEFAULT_OPTIONS.batchSize, 1, 1_000);
  if (batchSize === null) problems.push("LEADS_RECONCILE_BATCH_SIZE (integer 1 to 1000)");
  const maxSeconds = bounded(
    source.LEADS_RECONCILE_MAX_SECONDS,
    DEFAULT_OPTIONS.maxRunMs / 1000,
    1,
    600,
  );
  if (maxSeconds === null) problems.push("LEADS_RECONCILE_MAX_SECONDS (integer 1 to 600)");
  const scanLimit = bounded(
    source.LEADS_RECONCILE_SCAN_LIMIT,
    DEFAULT_OPTIONS.scanLimit,
    1,
    100_000,
  );
  if (scanLimit === null) problems.push("LEADS_RECONCILE_SCAN_LIMIT (integer 1 to 100000)");
  const statementSeconds = bounded(
    source.LEADS_RECONCILE_STATEMENT_TIMEOUT_SECONDS,
    DEFAULT_OPTIONS.statementTimeoutMs / 1000,
    1,
    120,
  );
  if (statementSeconds === null)
    problems.push("LEADS_RECONCILE_STATEMENT_TIMEOUT_SECONDS (integer 1 to 120)");
  const lockSeconds = bounded(
    source.LEADS_RECONCILE_LOCK_TIMEOUT_SECONDS,
    DEFAULT_OPTIONS.lockTimeoutMs / 1000,
    1,
    60,
  );
  if (lockSeconds === null) problems.push("LEADS_RECONCILE_LOCK_TIMEOUT_SECONDS (integer 1 to 60)");

  if (
    problems.length > 0 ||
    freshnessDays === null ||
    batchSize === null ||
    maxSeconds === null ||
    scanLimit === null ||
    statementSeconds === null ||
    lockSeconds === null
  )
    return { kind: "invalid", problems };
  return {
    kind: "ready",
    config: {
      databaseUrl: source.DATABASE_URL as string,
      options: {
        ...DEFAULT_OPTIONS,
        freshnessDays,
        batchSize,
        maxRunMs: maxSeconds * 1000,
        scanLimit,
        statementTimeoutMs: statementSeconds * 1000,
        lockTimeoutMs: lockSeconds * 1000,
      },
    },
  };
}
