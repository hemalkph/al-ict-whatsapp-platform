import { ApiError, isAbort } from "../inbox/api";

// What a failed lead request means for the person using the screen. The server is the authority: this only turns its fixed error
// codes (never its messages) into a kind, a sentence and what may safely happen next. Codes and statuses are the ones the lead
// routes really produce (handleApi, the leads module, the proxy):
//   401 UNAUTHENTICATED · 403 FORBIDDEN (also a cross-origin mutation) · 403 PASSWORD_CHANGE_REQUIRED · 404 NOT_FOUND
//   400 VALIDATION_ERROR (field names only) · 409 ACTOR_CHANGED · 409 ORGANIZATION_SELECTION_REQUIRED
//   409 STALE_STATE · 409 ALREADY_OPEN · 409 RESERVED_STATUS · 409 CONTACT_ARCHIVED · 500 INTERNAL_ERROR
//   status 0 NETWORK (a dropped connection or the client's 20 s timeout: the shared client does not tell them apart)
//   BAD_RESPONSE (a 2xx that was not the documented status or could not be read)
//
// NOTHING IS RETRIED HERE. `next` tells the UI what is safe:
//   "reload-page"  the signed-in account changed (or must change its password / pick an organization): this page's data belongs
//                  to someone else's session. Never retried; the shared client has already stopped the page (ACTOR_CHANGED).
//   "sign-in"      the session ended.
//   "refetch"      the lead changed or a rule refused the change: show the CURRENT state before offering the action again.
//                  A status change is never re-sent with the revision the user saw.
//   "check-first"  the outcome of a MUTATION is unknown (the request may have been applied): refetch, then let the user decide.
//   "retry"        a READ that failed can simply be tried again.
//   "none"         nothing to do (not permitted, invalid input, gone).
//   "ignore"       the request was cancelled by the page itself (navigation, a newer request).

export type LeadOperation = "read" | "create" | "status";

export type LeadErrorKind =
  | "aborted"
  | "actor_changed"
  | "unauthenticated"
  | "password_change_required"
  | "organization_selection_required"
  | "forbidden"
  | "not_found"
  | "validation"
  | "stale"
  | "already_open"
  | "reserved_status"
  | "contact_archived"
  | "outcome_unknown"
  | "unavailable"
  | "unexpected";

export type LeadErrorNext =
  "ignore" | "reload-page" | "sign-in" | "refetch" | "check-first" | "retry" | "none";

export type LeadErrorInfo = {
  readonly kind: LeadErrorKind;
  readonly next: LeadErrorNext;
  /** Plain language for staff. Never the server's message, never a value that came from the request. */
  readonly message: string;
};

const info = (kind: LeadErrorKind, next: LeadErrorNext, message: string): LeadErrorInfo => ({
  kind,
  next,
  message,
});

export function describeLeadError(error: unknown, operation: LeadOperation): LeadErrorInfo {
  if (isAbort(error)) return info("aborted", "ignore", "");
  if (!(error instanceof ApiError))
    return info(
      "unexpected",
      operation === "read" ? "retry" : "check-first",
      "Something went wrong. Please try again.",
    );

  const mutation = operation !== "read";
  if (error.code === "ACTOR_CHANGED")
    return info(
      "actor_changed",
      "reload-page",
      "Your signed-in account has changed in another tab. Reload this page to continue as the account that is signed in now.",
    );
  if (error.status === 401 || error.code === "UNAUTHENTICATED")
    return info("unauthenticated", "sign-in", "Your session has ended. Please sign in again.");
  if (error.code === "PASSWORD_CHANGE_REQUIRED")
    return info(
      "password_change_required",
      "reload-page",
      "You need to change your password before continuing.",
    );
  if (error.code === "ORGANIZATION_SELECTION_REQUIRED")
    return info(
      "organization_selection_required",
      "reload-page",
      "Choose an organization to continue. Reload this page.",
    );
  if (error.status === 403)
    return info("forbidden", "none", "You do not have permission to do that.");
  // Deliberately the same sentence for "does not exist" and "not yours": a 404 says nothing about another organization.
  if (error.status === 404)
    return info("not_found", "none", "This lead or contact is not available.");

  switch (error.code) {
    case "STALE_STATE":
      return info(
        "stale",
        "refetch",
        "Someone else changed this lead after you opened it. The current state has been loaded; check it before changing it again.",
      );
    case "ALREADY_OPEN":
      return info(
        "already_open",
        "refetch",
        operation === "create"
          ? "This contact already has an open lead."
          : "This lead cannot be reopened because the contact already has another open lead.",
      );
    case "RESERVED_STATUS":
      return info(
        "reserved_status",
        "refetch",
        "This lead is in a status that belongs to the registration workflow, so it cannot be changed here.",
      );
    case "CONTACT_ARCHIVED":
      return info(
        "contact_archived",
        "none",
        "This contact is archived, so a lead cannot be created for it.",
      );
    case "VALIDATION_ERROR":
      // The server names the refused fields, but the shared client keeps only the code: the UI cannot say which field.
      return info(
        "validation",
        "none",
        "That request was not accepted. Reload the page and try again.",
      );
  }

  if (error.uncertain)
    return mutation
      ? info(
          "outcome_unknown",
          "check-first",
          "We could not confirm whether that change was saved. The current state will be loaded before you try again.",
        )
      : info("unavailable", "retry", "The leads could not be loaded. Please try again.");
  return info(
    "unexpected",
    mutation ? "check-first" : "retry",
    "Something went wrong. Please try again.",
  );
}
