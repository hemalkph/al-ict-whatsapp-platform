import { AppError } from "@/shared/errors/app-error";

// Client-visible inbox errors: fixed text and a fixed code, never a name, an id or content.

/**
 * What the caller saw is no longer the current state (someone else changed the conversation, or an inbound message reopened
 * it), or a uniqueness rule refused the change. 409: the client reloads and decides again; nothing was overwritten.
 */
export class InboxConflictError extends AppError {
  constructor(
    code: "STALE_STATE" | "DUPLICATE" | "ARCHIVED",
    message: string,
    readonly reason: string,
  ) {
    super(code, message, 409);
    this.name = "InboxConflictError";
  }
}

export const staleState = (what: string) =>
  new InboxConflictError(
    "STALE_STATE",
    "This conversation changed since you loaded it. Refresh and try again.",
    what,
  );

/** The SQLSTATE of a database error (drizzle wraps the driver error as `cause`), or null. */
export function pgCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
export const UNIQUE_VIOLATION = "23505";
