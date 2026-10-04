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

/** Input failed strict schema validation. Carries field NAMES only, never values. */
export class ValidationError extends AppError {
  constructor(readonly fields: readonly string[]) {
    super("VALIDATION_ERROR", "Invalid input", 400);
    this.name = "ValidationError";
  }
}

/**
 * One deliberately generic refusal for operations that must not reveal why (e.g. the identity already exists,
 * belongs to another organization, or is shared). Reasons go to security events only.
 */
export class OperationRefusedError extends AppError {
  constructor(readonly reason?: string) {
    super("OPERATION_REFUSED", "This operation cannot be completed", 409);
    this.name = "OperationRefusedError";
  }
}

/** An organization must always keep at least one ACTIVE administrator. */
export class LastAdminRequiredError extends AppError {
  constructor() {
    super(
      "LAST_ADMIN_REQUIRED",
      "An organization must keep at least one active administrator",
      409,
    );
    this.name = "LastAdminRequiredError";
  }
}

/** Provisioning stopped part-way; the intent is kept so a retry can safely resume. Fail-closed meanwhile. */
export class ProvisioningIncompleteError extends AppError {
  constructor() {
    super(
      "STAFF_PROVISIONING_INCOMPLETE",
      "Staff account setup could not be completed. Please retry.",
      409,
    );
    this.name = "ProvisioningIncompleteError";
  }
}

/** A password reset stopped part-way; the account is already locked into a forced password change. */
export class PasswordResetIncompleteError extends AppError {
  constructor() {
    super(
      "PASSWORD_RESET_INCOMPLETE",
      "The password reset could not be completed. Please retry.",
      409,
    );
    this.name = "PasswordResetIncompleteError";
  }
}

/** Maps any error to a safe JSON response. Unknown errors become a generic 500 and are logged by name only. */
export function toErrorResponse(error: unknown): Response {
  const headers = { "Cache-Control": "no-store" };
  if (error instanceof AppError && error.httpStatus >= 400 && error.httpStatus < 500) {
    const fields = error instanceof ValidationError ? { fields: error.fields } : {};
    return Response.json(
      { error: { code: error.code, message: error.message, ...fields } },
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
