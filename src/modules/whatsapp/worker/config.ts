import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  MAX_BATCH_SIZE,
  MAX_CONCURRENCY,
} from "../queue/policy";

// Worker configuration, read from an explicit environment object (never from process.env directly) so it is testable.
// FAIL CLOSED: the worker runs only when WHATSAPP_WORKER_ENABLED is exactly "true". Problems name the KEY only, never a
// value (a database URL contains a password). No Meta credential is read: the worker never calls Meta.

export type WorkerConfig = { databaseUrl: string; batchSize: number; concurrency: number };

export type WorkerConfigResult =
  | { kind: "disabled" }
  | { kind: "invalid"; problems: string[] }
  | { kind: "ready"; config: WorkerConfig };

type Source = Record<string, string | undefined>;

function boundedInteger(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= max ? n : null;
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

export function readWorkerConfig(source: Source): WorkerConfigResult {
  const flag = source.WHATSAPP_WORKER_ENABLED;
  if (flag === undefined || flag === "" || flag === "false") return { kind: "disabled" };
  const problems: string[] = [];
  if (flag !== "true") problems.push("WHATSAPP_WORKER_ENABLED (must be exactly true or false)");

  if (!isPostgresUrl(source.DATABASE_URL))
    problems.push("DATABASE_URL (missing or not a postgres connection URL)");
  const batchSize = boundedInteger(
    source.WHATSAPP_WORKER_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    MAX_BATCH_SIZE,
  );
  if (batchSize === null)
    problems.push(`WHATSAPP_WORKER_BATCH_SIZE (integer 1 to ${MAX_BATCH_SIZE})`);
  const concurrency = boundedInteger(
    source.WHATSAPP_WORKER_CONCURRENCY,
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
  );
  if (concurrency === null)
    problems.push(`WHATSAPP_WORKER_CONCURRENCY (integer 1 to ${MAX_CONCURRENCY})`);

  if (problems.length > 0 || batchSize === null || concurrency === null)
    return { kind: "invalid", problems };
  return {
    kind: "ready",
    config: { databaseUrl: source.DATABASE_URL as string, batchSize, concurrency },
  };
}
