import { AppError } from "@/shared/errors/app-error";

// Client-visible lead errors: fixed text and a fixed code, never a name, an id or content.

export type LeadConflictCode =
  "STALE_STATE" | "ALREADY_OPEN" | "CONTACT_ARCHIVED" | "RESERVED_STATUS";

/**
 * 409: what the caller saw is no longer the current state, or a lead rule refuses the change. Nothing was written. `reason` is
 * for server-side use only (it is not part of the response).
 */
export class LeadConflictError extends AppError {
  constructor(
    code: LeadConflictCode,
    message: string,
    readonly reason: string,
  ) {
    super(code, message, 409);
    this.name = "LeadConflictError";
  }
}

export const staleLead = () =>
  new LeadConflictError(
    "STALE_STATE",
    "This lead changed since you loaded it. Refresh and try again.",
    "revision",
  );

export const alreadyOpen = () =>
  new LeadConflictError(
    "ALREADY_OPEN",
    "This contact already has an open lead. Close it before reopening another one.",
    "open_lead_exists",
  );

export const contactArchived = () =>
  new LeadConflictError(
    "CONTACT_ARCHIVED",
    "This contact is archived. Leads cannot be created for it.",
    "contact_archived",
  );

export const reservedStatus = () =>
  new LeadConflictError(
    "RESERVED_STATUS",
    "This lead is in a status that is managed by the registration workflow and cannot be changed here.",
    "reserved_status",
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

export function pgConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === "string") return constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export const UNIQUE_VIOLATION = "23505";
export const OPEN_LEAD_INDEX = "leads_org_contact_open_uidx";

/** The database's own "one open lead per contact" backstop fired. */
export const isOpenLeadConflict = (error: unknown) =>
  pgCode(error) === UNIQUE_VIOLATION && pgConstraint(error) === OPEN_LEAD_INDEX;
