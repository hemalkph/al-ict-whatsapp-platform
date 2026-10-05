import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { safeRedirectPath } from "@/shared/security/redirect";

// OPTIMISTIC UX protection only (Next.js 16 proxy). It looks at whether a Better Auth session cookie is PRESENT
// (cookie name handled by Better Auth's getSessionCookie, never hard-coded here). It never queries the database
// and never decides authorization: a forged, stale or revoked cookie passes this proxy and is rejected by the real
// checks (requireAccess/requirePermission and the service layer) on the server.

const PUBLIC_PATHS = ["/login", "/api/health", "/api/webhooks/whatsapp"];
const PUBLIC_PREFIXES = ["/api/auth/"];

export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) ||
    pathname === "/api/auth"
  );
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (getSessionCookie(request)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "Authentication required" } },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const next = safeRedirectPath(pathname + search, "");
  if (next && next !== "/") url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next.js internals, static files and the Meta webhook. When a proxy runs on a path, Next.js buffers
  // the request body and silently TRUNCATES it at proxyClientMaxBodySize; a webhook signature is computed over the exact
  // body bytes, so the webhook must never pass through the proxy at all (it authenticates itself: token + signature).
  matcher: [
    "/((?!api/webhooks/whatsapp(?:/|$)|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$).*)",
  ],
};
