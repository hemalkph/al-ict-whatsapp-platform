import { getAuth, type PublicAuth } from "./public-instance";

/** The slice of the public instance needed to resolve a session (injectable for tests). */
export type SessionProvider = { readonly api: Pick<PublicAuth["api"], "getSession"> };

/**
 * Resolves the Better Auth session from request headers (cookie). Database sessions with the cookie cache
 * disabled: deleted, revoked or expired sessions resolve to null on the very next call. Returns null when absent.
 */
export async function getSession(headers: Headers, auth: SessionProvider = getAuth()) {
  return auth.api.getSession({ headers });
}
