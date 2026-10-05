import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { config, isPublicPath, proxy } from "./proxy";

// Next.js ships this compiled copy without type declarations; it is the library Next uses for `config.matcher`.
const { pathToRegexp } = createRequire(import.meta.url)("next/dist/compiled/path-to-regexp") as {
  pathToRegexp: (path: string) => RegExp;
};

const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie } } : undefined);

describe("proxy.ts (optimistic cookie check only)", () => {
  it.each([
    "/login",
    "/api/health",
    "/api/auth/sign-in/email",
    "/api/auth/get-session",
    "/api/auth/",
  ])("lets public path %s through without a cookie", (path) => {
    expect(isPublicPath(path)).toBe(true);
    const res = proxy(req(path));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    "/",
    "/change-password",
    "/inbox",
    "/loginx",
    "/api/account/change-password",
    "/api/authx",
  ])("does not treat %s as public", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });

  it("redirects a page request without a session cookie to /login, remembering a safe destination", () => {
    const home = proxy(req("/"));
    expect(home.status).toBe(307);
    expect(new URL(home.headers.get("location")!).pathname).toBe("/login");
    expect(new URL(home.headers.get("location")!).search).toBe("");

    const deep = proxy(req("/inbox?status=open"));
    const location = new URL(deep.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/inbox?status=open");
  });

  it("answers API requests without a cookie with 401 JSON instead of a redirect", async () => {
    const res = proxy(req("/api/account/change-password"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("lets a request through when a Better Auth session cookie is present (optimistic)", () => {
    for (const cookie of [
      "better-auth.session_token=abc.def",
      "__Secure-better-auth.session_token=abc.def",
    ]) {
      const res = proxy(req("/", cookie));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("does NOT treat unrelated or empty cookies as a session", () => {
    for (const cookie of ["theme=dark", "better-auth.session_token=", "other.session_token=abc"]) {
      expect(proxy(req("/", cookie)).status).toBe(307);
    }
  });

  it("does not validate the cookie: a forged value passes (the real check happens in requireAccess)", () => {
    expect(proxy(req("/", "better-auth.session_token=forged")).status).toBe(200);
  });

  it("never redirects /login itself (no loop), with or without a cookie", () => {
    expect(proxy(req("/login")).status).toBe(200);
    expect(proxy(req("/login", "better-auth.session_token=x")).status).toBe(200);
  });
});

describe("the Meta webhook bypasses the proxy (its body must never be buffered or truncated)", () => {
  // The same path-to-regexp Next.js uses to turn `config.matcher` into the pattern it matches request paths against.
  const matcher = pathToRegexp(config.matcher[0]!);
  const handledByProxy = (path: string) => matcher.test(path);

  it("does not run the proxy on the webhook path at all (no buffering, no truncation, no cookie logic)", () => {
    expect(handledByProxy("/api/webhooks/whatsapp")).toBe(false);
    expect(handledByProxy("/api/webhooks/whatsapp/")).toBe(false);
    expect(handledByProxy("/api/webhooks/whatsapp/anything")).toBe(false);
  });

  it("still runs the proxy on every other API path and on look-alike paths", () => {
    for (const path of [
      "/api/staff",
      "/api/staff/00000000-0000-4000-8000-000000000001/role",
      "/api/account/change-password",
      "/api/auth/sign-in/email",
      "/api/webhooks",
      "/api/webhooks/whatsappx",
      "/api/webhooks/whatsapp-evil",
      "/api/webhooks/other",
      "/api/webhookz/whatsapp",
      "/",
      "/login",
    ]) {
      expect(handledByProxy(path), path).toBe(true);
    }
  });

  it("also treats the path as public, so even a direct call needs no session cookie", () => {
    expect(isPublicPath("/api/webhooks/whatsapp")).toBe(true);
    expect(proxy(req("/api/webhooks/whatsapp")).status).toBe(200);
    expect(isPublicPath("/api/webhooks/whatsappx")).toBe(false);
    expect(isPublicPath("/api/webhooks")).toBe(false);
  });

  it("keeps other protected API paths protected", async () => {
    for (const path of [
      "/api/staff",
      "/api/staff/x/suspend",
      "/api/account/change-password",
      "/api/webhooks/other",
    ]) {
      expect(proxy(req(path)).status, path).toBe(401);
    }
  });
});
