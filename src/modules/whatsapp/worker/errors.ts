import { sqlState } from "../ingest";

// Worker-level error classification: is the failure about the process's own database access? Individual events are
// never classified here (the queue does that). Only a short fixed code is ever logged, never an exception message
// (a connection error can contain a host name or user).

/** The connected database lacks the tables the worker needs (migrations were never applied). Never fixed automatically. */
export class SchemaNotReadyError extends Error {
  constructor() {
    super("schema_not_ready");
    this.name = "SchemaNotReadyError";
  }
}

export type LoopFailure =
  | { kind: "configuration"; code: string }
  | { kind: "database_unavailable"; code: string }
  | { kind: "unexpected"; code: string };

/** The database cannot work AS CONFIGURED: waiting will not help. */
const CONFIGURATION_STATES = new Set([
  "28000", // invalid authorization specification
  "28P01", // invalid password
  "3D000", // database does not exist
  "42P01", // undefined table: migrations not applied
  "42703", // undefined column: migrations out of date
  "42501", // insufficient privilege
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
  /connection terminated|timeout exceeded when trying to connect|client has encountered a connection error|cannot use a pool after calling end|connection ended unexpectedly/i;

function chain(error: unknown): { code?: string; message?: string }[] {
  const out: { code?: string; message?: string }[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const e = current as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    out.push({
      code: typeof e.code === "string" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : undefined,
    });
    if (Array.isArray(e.errors))
      for (const inner of e.errors.slice(0, 3)) out.push(...chain(inner));
    current = e.cause;
  }
  return out;
}

export function classifyLoopError(error: unknown): LoopFailure {
  if (error instanceof SchemaNotReadyError)
    return { kind: "configuration", code: "schema_not_ready" };
  const state = sqlState(error);
  if (state && CONFIGURATION_STATES.has(state))
    return { kind: "configuration", code: `pg_${state.toLowerCase()}` };
  if (state && (state.startsWith("08") || state.startsWith("53") || /^57P0[123]$/.test(state)))
    return { kind: "database_unavailable", code: `pg_${state.toLowerCase()}` };
  for (const link of chain(error)) {
    if (link.code && UNAVAILABLE_NODE_CODES.has(link.code))
      return { kind: "database_unavailable", code: link.code.toLowerCase() };
    if (link.message && UNAVAILABLE_MESSAGE.test(link.message))
      return { kind: "database_unavailable", code: "connection_lost" };
  }
  return { kind: "unexpected", code: state ? `pg_${state.toLowerCase()}` : "unexpected_error" };
}
