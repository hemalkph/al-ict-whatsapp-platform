import {
  ForbiddenError,
  OrganizationSelectionRequiredError,
  PasswordChangeRequiredError,
  UnauthenticatedError,
} from "@/shared/errors/http-errors";
import { safeRedirectPath } from "@/shared/security/redirect";
import { requireAccess, type AccessContext, type AccessOptions } from "./access";

// Page-level (UX) decisions built ON TOP of requireAccess(); they decide where to send the browser, they do not
// replace authorization inside data/service functions (layouts do not re-run on every navigation).

export type DeniedStatus =
  "unauthenticated" | "password_change_required" | "forbidden" | "organization_selection_required";
export type PageAccess = { status: "ok"; ctx: AccessContext } | { status: DeniedStatus };

export async function getPageAccess(
  headers: Headers,
  options: AccessOptions = {},
): Promise<PageAccess> {
  try {
    return { status: "ok", ctx: await requireAccess(headers, options) };
  } catch (error) {
    if (error instanceof UnauthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PasswordChangeRequiredError) return { status: "password_change_required" };
    if (error instanceof OrganizationSelectionRequiredError)
      return { status: "organization_selection_required" };
    if (error instanceof ForbiddenError) return { status: "forbidden" };
    throw error;
  }
}

/** Where a protected page sends a request that is not allowed in. `from` is validated before it is echoed. */
export function pageRedirectFor(status: DeniedStatus, from?: string): string {
  switch (status) {
    case "unauthenticated": {
      const next = from === undefined ? undefined : safeRedirectPath(from, "");
      return next ? `/login?next=${encodeURIComponent(next)}` : "/login";
    }
    case "password_change_required":
      return "/change-password";
    case "forbidden":
      return "/login?reason=access";
    case "organization_selection_required":
      return "/login?reason=organization";
  }
}

/**
 * What /login does for a visitor. Only a visitor who ALREADY has working access is sent onward; everyone else
 * (including a stale/forged cookie, a suspended user, no access) sees the form. This is what prevents redirect loops:
 * protected pages send "not allowed" visitors to /login, and /login never sends them back.
 */
export function loginDestination(access: PageAccess, next: unknown): string | null {
  if (access.status === "ok") return safeRedirectPath(next, "/");
  if (access.status === "password_change_required") return "/change-password";
  return null;
}
