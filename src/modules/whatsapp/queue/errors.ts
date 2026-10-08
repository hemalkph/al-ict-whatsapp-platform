import { sqlState } from "../ingest";

// Failure classification. last_error only ever receives a short code produced here: never an exception message, stack,
// payload text, phone number, BSUID or token.

const CODE = /^[a-z0-9_]{1,64}$/;
export const safeCode = (code: string, fallback = "unexpected_error"): string =>
  CODE.test(code) ? code : fallback;

/** A handler throws this when retrying can never help (invalid envelope, invariant violation). Goes straight to DEAD. */
export class PermanentWebhookError extends Error {
  readonly code: string;
  constructor(code: string) {
    const safe = safeCode(code, "permanent_error");
    super(safe);
    this.name = "PermanentWebhookError";
    this.code = safe;
  }
}

export class HandlerTimeoutError extends Error {
  constructor() {
    super("handler_timeout");
    this.name = "HandlerTimeoutError";
  }
}

export class LeaseLostError extends Error {
  constructor() {
    super("lease_lost");
    this.name = "LeaseLostError";
  }
}

export type Failure = { permanent: boolean; code: string };

/**
 * Only PermanentWebhookError is permanent. Everything else, including PostgreSQL constraint errors, is transient at this
 * generic level (a handler that knows a constraint violation is permanent says so by throwing PermanentWebhookError).
 */
export function classifyFailure(error: unknown): Failure {
  if (error instanceof PermanentWebhookError) return { permanent: true, code: error.code };
  if (error instanceof HandlerTimeoutError) return { permanent: false, code: "handler_timeout" };
  const state = sqlState(error);
  return { permanent: false, code: state ? `pg_${state.toLowerCase()}` : "unexpected_error" };
}
