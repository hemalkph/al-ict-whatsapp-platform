// Worker-level error classification (Phase 08E-7; the WhatsApp worker's rules, copied): is a failure about the process's own
// database access, its configuration, or something unexpected? A trigger's own failure never reaches here (T1 rolls back and
// T2 records it on the trigger). Only a fixed code is ever logged, never an exception message (it can name a host or user).

/** The database cannot run the worker AS CONFIGURED (old server, missing tables, settings not applied): waiting cannot fix it. */
export class WorkerPreflightError extends Error {
  constructor(
    readonly code:
      "server_version_unsupported" | "schema_not_ready" | "session_settings_not_applied",
  ) {
    super(code);
    this.name = "WorkerPreflightError";
  }
}

/** An outcome that could not be recorded (T2 failed too): the database is struggling; the claim's lease recovers it. */
export class UnrecordedOutcomeError extends Error {
  constructor() {
    super("outcome_unrecorded");
    this.name = "UnrecordedOutcomeError";
  }
}

export type LoopFailure =
  | { readonly kind: "configuration"; readonly code: string }
  | { readonly kind: "database_unavailable"; readonly code: string }
  | { readonly kind: "unexpected"; readonly code: string };

const CONFIGURATION_STATES = new Set([
  "28000", // invalid authorization specification
  "28P01", // invalid password
  "3D000", // database does not exist
  "42P01", // undefined table: migrations not applied
  "42703", // undefined column: migrations out of date
  "42501", // insufficient privilege
  "42704", // undefined object: a startup setting this server does not know (transaction_timeout below PostgreSQL 17)
]);
const UNAVAILABLE_NODE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);
const UNAVAILABLE_MESSAGE =
  /connection terminated|timeout exceeded when trying to connect|client has encountered a connection error|cannot use a pool after calling end|connection ended unexpectedly|not queryable/i;

function chain(error: unknown): { code?: string; message?: string }[] {
  const out: { code?: string; message?: string }[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    out.push({
      code: typeof e.code === "string" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : undefined,
    });
    current = e.cause;
  }
  return out;
}

export function classifyLoopError(error: unknown): LoopFailure {
  if (error instanceof WorkerPreflightError) return { kind: "configuration", code: error.code };
  if (error instanceof UnrecordedOutcomeError)
    return { kind: "database_unavailable", code: "outcome_unrecorded" };
  for (const { code, message } of chain(error)) {
    if (code && CONFIGURATION_STATES.has(code))
      return { kind: "configuration", code: `db_${code.toLowerCase()}` };
    if (
      code &&
      (UNAVAILABLE_NODE_CODES.has(code) || code.startsWith("08") || code.startsWith("57P"))
    )
      return {
        kind: "database_unavailable",
        code: code.startsWith("E") ? code.toLowerCase() : `db_${code.toLowerCase()}`,
      };
    if (message && UNAVAILABLE_MESSAGE.test(message))
      return { kind: "database_unavailable", code: "connection_lost" };
  }
  return { kind: "unexpected", code: "unexpected_error" };
}
