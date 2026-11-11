import { emitSecurityEvent, hashForLog } from "@/shared/security/events";
import { getAuth } from "./public-instance";
import { readAuthEnv } from "./env";
import { logAuthErrorResponse, logUnhandledAuthError } from "./safe-log";

/** Origins that may perform state-changing requests against our own handlers (derived lazily from env). */
export function getAllowedOrigins(): string[] {
  return [readAuthEnv().origin];
}

type AuthHandler = { handler(request: Request): Promise<Response> };

/**
 * The single entry point mounted at /api/auth/*: delegates to the PUBLIC Better Auth instance and emits safe
 * security events for sign-in and sign-out. Better Auth itself keeps its origin/CSRF checks and rate limiting.
 * Nothing about the body is logged: only the HTTP outcome, the user id on success, and a hash of the email on failure.
 */
export async function handleAuthRequest(
  request: Request,
  auth: AuthHandler = getAuth(),
): Promise<Response> {
  const path = request.method === "POST" ? new URL(request.url).pathname : "";
  const isSignIn = path.endsWith("/sign-in/email");
  // The request body can be read once: clone BEFORE Better Auth consumes it.
  const bodyForHash = isSignIn ? request.clone() : null;

  let response: Response;
  try {
    response = await auth.handler(request);
  } catch (error) {
    // Only non-APIError exceptions reach here (onAPIError.throw): the same bare 500 the router returned, without printing the
    // raw error (a database error carries its SQL parameters).
    logUnhandledAuthError(error);
    return new Response(null, { status: 500, statusText: "Internal Server Error" });
  }
  // With onAPIError.throw the library no longer logs its internal APIErrors (they become responses unlogged): one fixed line,
  // the response itself untouched.
  if (response.status >= 500) logAuthErrorResponse(response.status, new URL(request.url).pathname);

  try {
    if (isSignIn && bodyForHash) {
      if (response.ok) {
        const body = (await response.clone().json()) as { user?: { id?: string } };
        emitSecurityEvent({
          event: "auth.login_succeeded",
          outcome: "success",
          userId: body.user?.id,
        });
      } else {
        let emailHash: string | undefined;
        try {
          const sent = (await bodyForHash.json()) as { email?: unknown };
          if (typeof sent.email === "string") emailHash = hashForLog(sent.email);
        } catch {
          // unreadable body: no hash
        }
        emitSecurityEvent({
          event: "auth.login_failed",
          outcome: "failure",
          reason: `http_${response.status}`,
          emailHash,
        });
      }
    } else if (path.endsWith("/sign-out") && response.ok) {
      emitSecurityEvent({ event: "auth.logout", outcome: "success" });
    }
  } catch {
    // observability must never break authentication
  }
  return response;
}
