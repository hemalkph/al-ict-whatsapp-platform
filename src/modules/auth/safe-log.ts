import { logger } from "@/shared/logging/logger";

// Phase 08G-7B C1B-P1 closure: the ONLY output of Better Auth's logger. The library passes raw values to its logger: errors from
// the database adapter (a DrizzleQueryError message carries the SQL text and its parameters, such as session tokens), emails,
// origins and URLs. Nothing it passes is printed. Every field of a log line comes from a FIXED set below: the level, a code chosen
// by a known message PREFIX (never the message text), and from the first Error argument a recognized class and a recognized
// PostgreSQL SQLSTATE. Anything not in a set is "other" (or absent). No string taken from the library or an error is ever
// printed: not a message, name, constructor name, code, stack, cause, SQL text or parameter.

const KNOWN_MESSAGES: ReadonlyArray<readonly [prefix: string, code: string]> = [
  ["Failed to delete session from database", "session_delete_failed"],
  ["Failed to read session from database", "session_read_failed"],
  ["Failed to create session", "session_create_failed"],
  ["Error pruning rate limit rows", "rate_limit_prune_failed"],
  ["Failed to run background task", "background_task_failed"],
  ["INTERNAL_SERVER_ERROR", "internal_server_error"],
  ["Invalid origin", "invalid_origin"],
  ["Invalid callbackURL", "invalid_callback_url"],
  ["Invalid redirectURL", "invalid_redirect_url"],
  ["Invalid errorCallbackURL", "invalid_error_callback_url"],
  ["Invalid newUserCallbackURL", "invalid_new_user_callback_url"],
  ["Blocked cross-site navigation login attempt", "cross_site_navigation_login_blocked"],
  ["Rate limiting could not determine a client IP", "rate_limit_no_trusted_ip"],
  ["Invalid password", "invalid_password"],
  ["Password not found", "password_not_found"],
  ["User not found", "user_not_found"],
  ["Cookie cache payload failed schema validation", "cookie_cache_invalid"],
];

/** Error classes worth naming (database driver/ORM, Better Auth, runtime). Matched exactly; anything else is "other". */
const ERROR_CLASSES: ReadonlySet<string> = new Set([
  "DrizzleQueryError",
  "DrizzleError",
  "TransactionRollbackError",
  "DatabaseError",
  "APIError",
  "BetterAuthError",
  "BetterCallError",
  "AbortError",
  "TimeoutError",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
]);

/** PostgreSQL SQLSTATEs worth naming (raise, integrity, concurrency, availability, schema). Anything else is "other". */
const SQLSTATES: ReadonlySet<string> = new Set([
  "P0001", // raise_exception
  "23502", // not_null_violation
  "23503", // foreign_key_violation
  "23505", // unique_violation
  "23514", // check_violation
  "25P02", // in_failed_sql_transaction
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "57014", // query_canceled
  "57P01", // admin_shutdown
  "53300", // too_many_connections
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "42P01", // undefined_table
  "42703", // undefined_column
]);

const LEVELS: ReadonlySet<string> = new Set(["debug", "info", "success", "warn", "error"]);

export type AuthLogLevel = "debug" | "info" | "success" | "warn" | "error";

/** One string property read only to compare it against a fixed set (never returned unless it IS a member of that set). */
const own = (value: unknown, key: string): unknown =>
  (typeof value === "object" && value !== null) || typeof value === "function"
    ? (value as Record<string, unknown>)[key]
    : undefined;

function errorClass(error: Error | undefined, message: string): string | undefined {
  // A production build minifies class names (observed: a DrizzleQueryError's constructor name was mangled), so the two database
  // errors are recognized by SHAPE first; only the presence of fields is checked, their values are never read out.
  if (error && typeof own(error, "query") === "string" && Array.isArray(own(error, "params")))
    return "DrizzleQueryError";
  if (error && typeof own(error, "severity") === "string" && "routine" in error)
    return "DatabaseError";
  // The router and session routes log a non-API error with its `name` as the message.
  const candidates = error
    ? [own(own(error, "constructor"), "name"), own(error, "name")]
    : [message];
  for (const c of candidates) if (typeof c === "string" && ERROR_CLASSES.has(c)) return c;
  return error ? "other" : undefined;
}

function sqlState(error: Error | undefined): string | undefined {
  if (!error) return undefined;
  for (const code of [own(error, "code"), own(own(error, "cause"), "code")])
    if (typeof code === "string" && SQLSTATES.has(code)) return code;
  return own(error, "code") !== undefined || own(own(error, "cause"), "code") !== undefined
    ? "other"
    : undefined;
}

/** The allowlisted fields of one library log call: every value is a member of a fixed set. */
export function authLogFields(level: string, message: unknown, args: readonly unknown[]) {
  const text = typeof message === "string" ? message : "";
  const error = args.find((a): a is Error => a instanceof Error);
  return {
    auth_log_code:
      KNOWN_MESSAGES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? "unclassified",
    auth_log_level: LEVELS.has(level) ? level : "other",
    error_class: errorClass(error, text),
    sql_state: sqlState(error),
  };
}

/** Better Auth `logger` option: everything the library logs goes through authLogFields. */
export const safeAuthLogger = {
  log(level: AuthLogLevel, message: unknown, ...args: unknown[]) {
    const fields = authLogFields(level, message, args);
    if (level === "error") logger.error("auth library log", fields);
    else if (level === "warn") logger.warn("auth library log", fields);
    else logger.info("auth library log", fields);
  },
};

/** For an exception that escaped the Better Auth router (it would otherwise print it raw): the same allowlisted fields. */
export function logUnhandledAuthError(error: unknown): void {
  logger.error("unhandled auth error", authLogFields("error", "", [error]));
}

/** Better Auth paths open on the public instance that the 5xx diagnostic may name; any other path is "other". */
const AUTH_PATHS: ReadonlySet<string> = new Set([
  "/sign-in/email",
  "/sign-out",
  "/get-session",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
]);

/** A 5xx response from the public auth handler: its status and a fixed path name only (never headers or body). */
export function logAuthErrorResponse(status: number, pathname: string): void {
  const path = pathname.replace(/^.*\/api\/auth(?=\/)/, "");
  logger.error("auth error response", {
    status: status >= 500 && status <= 599 ? status : 500,
    auth_path: AUTH_PATHS.has(path) ? path : "other",
  });
}
