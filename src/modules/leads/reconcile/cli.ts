import { sql } from "drizzle-orm";
import { createWorkerDatabase, type WorkerDatabase } from "@/db";
import { bounded, isLimitError } from "./bounded";
import { readReconcileConfig, type ReconcileConfig, type ReconcileOptions } from "./config";
import { runReconciliation, type ReconcileReport } from "./run";

// Process-level orchestration of `npm run leads:reconcile`: validate configuration, open ITS OWN small pool, check that the
// database is migrated (it never migrates), run ONE bounded reconciliation, print counts as one JSON line, close the pool. It
// never calls Meta, sends nothing, starts nothing in the background and runs only when LEADS_RECONCILER_ENABLED is exactly
// "true". No cron, no scheduler: whoever wants repeated runs starts it repeatedly (blocker register).
//
// Every statement it issues, the readiness check included, runs under PostgreSQL's own lock and statement timeouts (bounded.ts):
// a migration holding a table lock makes the command end with `database_timeout` after the configured lock timeout instead of
// waiting for the migration to finish.

export const EXIT_OK = 0;
export const EXIT_FATAL = 1;
export const EXIT_REFUSED = 2;

/** The tables and the column that migration 0006 adds; existence only. */
const REQUIRED = [
  "leads",
  "lead_events",
  "lead_attributions",
  "lead_reconcile_decisions",
  "contacts",
  "messages",
  "organizations",
];

/**
 * Is the database migrated to the lead schema? Besides the catalog checks it TOUCHES the three tables the reconciler reads and
 * writes (`WHERE false`: no row is read, but the table lock and the privilege check are real), so that a table that is locked by
 * a migration, or not accessible, is noticed here, under the timeouts, rather than on the first scan.
 */
async function schemaReady(db: WorkerDatabase["db"], options: ReconcileOptions): Promise<boolean> {
  return bounded(db, options, async (tx) => {
    const tables = await tx.execute<{ missing: number }>(sql`
      SELECT count(*)::int AS missing
      FROM unnest(${sql.raw(`ARRAY[${REQUIRED.map((t) => `'${t}'`).join(",")}]::text[]`)}) AS t(name)
      WHERE to_regclass(format('public.%I', t.name)) IS NULL`);
    if ((tables.rows[0]?.missing ?? 1) > 0) return false;
    const column = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'initiating_attribution_id'`);
    if ((column.rows[0]?.n ?? 0) !== 1) return false;
    await tx.execute(sql`SELECT 1 FROM leads WHERE false`);
    await tx.execute(sql`SELECT 1 FROM lead_attributions WHERE false`);
    await tx.execute(sql`SELECT 1 FROM lead_reconcile_decisions WHERE false`);
    return true;
  });
}

export type CliOptions = {
  env: Record<string, string | undefined>;
  /** Where the one-line JSON report goes (stdout). */
  output?: (line: string) => void;
  /** Where explanatory messages go (stderr). Never receives a value from the environment. */
  print?: (message: string) => void;
  /** Tests only. */
  createDatabase?: (config: ReconcileConfig) => WorkerDatabase;
};

function defaultDatabase(config: ReconcileConfig): WorkerDatabase {
  return createWorkerDatabase(config.databaseUrl, {
    maxConnections: 2,
    applicationName: "al-ict-leads-reconciler",
    onPoolError: () => undefined, // a dead idle connection surfaces as a failed query below, with a fixed message
  });
}

const failureLine = (reason: string) =>
  JSON.stringify({ event: "leads.reconcile.run", outcome: "failure", reason });
/** A run whose candidate scan failed or hit a database limit did not do its work: it is reported (with its counts) as a failure. */
const reportLine = (report: ReconcileReport) =>
  JSON.stringify({
    event: "leads.reconcile.run",
    outcome: report.stopReason === "query_failed" ? "failure" : "success",
    ...report,
  });

export async function runReconcileCli(options: CliOptions): Promise<number> {
  const print = options.print ?? ((message: string) => console.error(message));
  const output = options.output ?? ((line: string) => console.log(line));
  const read = readReconcileConfig(options.env);
  if (read.kind === "disabled") {
    print(
      "The lead reconciler is disabled. It runs only when LEADS_RECONCILER_ENABLED=true is set explicitly. Nothing was read or changed.",
    );
    return EXIT_REFUSED;
  }
  if (read.kind === "invalid") {
    print(
      `Invalid reconciler configuration: ${read.problems.join("; ")}. Nothing was read or changed.`,
    );
    return EXIT_REFUSED;
  }
  const database = (options.createDatabase ?? defaultDatabase)(read.config);
  try {
    let ready: boolean;
    try {
      ready = await schemaReady(database.db, read.config.options);
    } catch (error) {
      // a limit PostgreSQL itself enforced (a locked table, a slow statement) is a timeout; anything else is "unreachable"
      output(failureLine(isLimitError(error) ? "database_timeout" : "database_unreachable"));
      return EXIT_FATAL;
    }
    if (!ready) {
      output(failureLine("schema_not_ready"));
      print(
        "The database is not migrated to the lead schema (migration 0006). Nothing was read or changed.",
      );
      return EXIT_FATAL;
    }
    const report = await runReconciliation(database.db, read.config.options);
    output(reportLine(report));
    return report.stopReason === "query_failed" ? EXIT_FATAL : EXIT_OK;
  } catch {
    // a fixed line: an error object can name a host, a user or a value
    output(failureLine("run_failed"));
    return EXIT_FATAL;
  } finally {
    await database.close().catch(() => undefined);
  }
}
