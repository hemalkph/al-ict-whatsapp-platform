import { describe, expect, it } from "vitest";
import { isSafeRedirectPath, safeRedirectPath } from "./redirect";

describe("redirect target validation", () => {
  it.each([
    "/",
    "/dashboard",
    "/inbox?status=open",
    "/contacts/123#notes",
    "/a/b/c?x=1&y=2",
    "/path%20with%20space",
  ])("accepts safe relative path %s", (p) => {
    expect(isSafeRedirectPath(p)).toBe(true);
    expect(safeRedirectPath(p, "/home")).toBe(p);
  });

  it.each([
    ["absolute https URL", "https://evil.example/phish"],
    ["absolute http URL", "http://evil.example"],
    ["protocol-relative", "//evil.example"],
    ["protocol-relative with path", "//evil.example/a"],
    ["backslash host bypass", "/\\evil.example"],
    ["double backslash", "\\\\evil.example"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,<script>alert(1)</script>"],
    ["vbscript scheme", "vbscript:msgbox(1)"],
    ["no leading slash", "dashboard"],
    ["scheme-looking relative", "evil.example/path"],
    ["leading space", " /dashboard"],
    ["leading space before //", " //evil.example"],
    ["tab inside", "/\t/evil.example"],
    ["newline", "/dashboard\nLocation: https://evil.example"],
    ["carriage return", "/a\r\nSet-Cookie: x=1"],
    ["null byte", "/a\u0000b"],
    ["encoded double slash", "/%2f%2fevil.example"],
    ["encoded backslash", "/%5cevil.example"],
    ["encoded control char", "/%0d%0aSet-Cookie:x"],
    ["dot-segment producing //", "/.//evil.example"],
    ["malformed percent encoding", "/%E0%A4%A"],
    ["empty string", ""],
    ["too long", "/" + "a".repeat(2100)],
  ])("rejects %s", (_name, p) => {
    expect(isSafeRedirectPath(p)).toBe(false);
    expect(safeRedirectPath(p, "/home")).toBe("/home");
  });

  it.each([null, undefined, 42, {}, ["/ok"], true])("rejects non-string %j", (v) => {
    expect(isSafeRedirectPath(v)).toBe(false);
    expect(safeRedirectPath(v)).toBe("/");
  });

  it("defaults the fallback to /", () => {
    expect(safeRedirectPath("https://evil.example")).toBe("/");
  });
});
