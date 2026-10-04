import { afterEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/shared/errors/http-errors";
import { assertSameOrigin, isSameOriginRequest } from "./same-origin";

const ALLOWED = ["https://app.example.com"];
const req = (method: string, headers: Record<string, string> = {}) => ({
  method,
  headers: new Headers(headers),
});

afterEach(() => vi.restoreAllMocks());

describe("isSameOriginRequest", () => {
  it("lets safe methods through regardless of origin", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isSameOriginRequest(req(m, { origin: "https://evil.example" }), ALLOWED)).toBe(true);
    }
  });

  it("accepts mutating requests whose Origin exactly matches an allowed origin", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isSameOriginRequest(req(m, { origin: "https://app.example.com" }), ALLOWED)).toBe(
        true,
      );
    }
  });

  it("rejects foreign, null, malformed, scheme-mismatched and port-mismatched origins", () => {
    for (const origin of [
      "https://evil.example",
      "null",
      "not a url",
      "http://app.example.com",
      "https://app.example.com:8443",
      "https://app.example.com.evil.example",
      "https://sub.app.example.com",
      "javascript:alert(1)",
    ]) {
      expect(isSameOriginRequest(req("POST", { origin }), ALLOWED), origin).toBe(false);
    }
  });

  it("falls back to Sec-Fetch-Site only when Origin is absent", () => {
    expect(isSameOriginRequest(req("POST", { "sec-fetch-site": "same-origin" }), ALLOWED)).toBe(
      true,
    );
    for (const v of ["cross-site", "same-site", "none"]) {
      expect(isSameOriginRequest(req("POST", { "sec-fetch-site": v }), ALLOWED), v).toBe(false);
    }
    // a foreign Origin wins over a (spoofable by non-browsers) same-origin hint
    expect(
      isSameOriginRequest(
        req("POST", { origin: "https://evil.example", "sec-fetch-site": "same-origin" }),
        ALLOWED,
      ),
    ).toBe(false);
  });

  it("rejects mutating requests that carry neither header", () => {
    expect(isSameOriginRequest(req("POST"), ALLOWED)).toBe(false);
  });

  it("rejects everything when no origin is allowed", () => {
    expect(isSameOriginRequest(req("POST", { origin: "https://app.example.com" }), [])).toBe(false);
  });
});

describe("assertSameOrigin", () => {
  it("throws ForbiddenError for cross-origin mutations and emits a security event", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() =>
      assertSameOrigin(req("POST", { origin: "https://evil.example" }), ALLOWED),
    ).toThrow(ForbiddenError);
    expect(JSON.parse(String(spy.mock.calls[0]?.[0])).security_event).toBe(
      "access.cross_origin_rejected",
    );
  });
  it("does nothing for allowed requests", () => {
    expect(() =>
      assertSameOrigin(req("POST", { origin: "https://app.example.com" }), ALLOWED),
    ).not.toThrow();
  });
});
