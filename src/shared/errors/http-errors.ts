import { AppError } from "./app-error";
import { logger } from "@/shared/logging/logger";

// Authorization-related errors with FIXED, generic client messages: they never contain organization ids,
// resource ids or internal reasons. `reason` (when present) is for server-side logging only.

export class UnauthenticatedError extends AppError {
  constructor(readonly reason?: string) {
    super("UNAUTHENTICATED", "Authentication required", 401);
    this.name = "UnauthenticatedError";
  }
}

/** Authenticated but not permitted (also used for "no ACTIVE membership"). */
export class ForbiddenError extends AppError {
  constructor(readonly reason?: string) {
    super("FORBIDDEN", "You do not have permission to perform this action", 403);
    this.name = "ForbiddenError";
  }
}

/** The caller must change their password before normal application access (global security state). */
export class PasswordChangeRequiredError extends AppError {
  constructor() {
    super("PASSWORD_CHANGE_REQUIRED", "A password change is required before continuing", 403);
    this.name = "PasswordChangeRequiredError";
  }
}

/**
 * The resource does not exist WITHIN THE CALLER'S ORGANIZATION. Also the answer for another
 * organization's ids, so existence elsewhere is never revealed.
 */
export class NotFoundError extends AppError {
  constructor() {
    super("NOT_FOUND", "Resource not found", 404);
    this.name = "NotFoundError";
  }
}

/** More than one ACTIVE membership and no organization selector exists yet: fail closed. */
export class OrganizationSelectionRequiredError extends AppError {
  constructor() {
    super("ORGANIZATION_SELECTION_REQUIRED", "An organization must be selected to continue", 409);
    this.name = "OrganizationSelectionRequiredError";
  }
}

/** Maps any error to a safe JSON response. Unknown errors become a generic 500 and are logged by name only. */
export function toErrorResponse(error: unknown): Response {
  const headers = { "Cache-Control": "no-store" };
  if (error instanceof AppError && error.httpStatus >= 400 && error.httpStatus < 500) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.httpStatus, headers },
    );
  }
  logger.error("unhandled error", {
    error_name: error instanceof Error ? error.name : typeof error,
  });
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
    { status: 500, headers },
  );
}
