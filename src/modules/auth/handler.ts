import { emitSecurityEvent, hashForLog } from "@/shared/security/events";
import { getAuth } from "./public-instance";
import { readAuthEnv } from "./env";

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

  const response = await auth.handler(request);

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
