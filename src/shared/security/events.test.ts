import { afterEach, describe, expect, it, vi } from "vitest";
import { emitSecurityEvent, hashForLog } from "./events";

afterEach(() => vi.restoreAllMocks());

describe("emitSecurityEvent", () => {
  it("writes a structured warn line for denials with only whitelisted fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    emitSecurityEvent({
      event: "access.permission_denied",
      outcome: "denied",
      userId: "u1",
      organizationId: "o1",
      membershipId: "m1",
      permission: "staff.manage",
      reason: "role_lacks_permission",
    });
    const line = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      level: "warn",
      security_event: "access.permission_denied",
      outcome: "denied",
      user_id: "u1",
      organization_id: "o1",
      membership_id: "m1",
      permission: "staff.manage",
    });
  });

  it("cannot be used to log passwords, tokens, secrets or bodies (extra fields are dropped)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const hostile = {
      event: "auth.login_failed",
      outcome: "failure",
      password: "hunter2",
      token: "session-token-abc",
      secret: "auth-secret",
      body: '{"password":"hunter2"}',
      email: "person@example.com",
    } as unknown as Parameters<typeof emitSecurityEvent>[0];
    emitSecurityEvent(hostile);
    const raw = String(spy.mock.calls[0]?.[0]);
    expect(raw).not.toMatch(/hunter2|session-token-abc|auth-secret|person@example\.com/);
  });

  it("hashes emails stably, case/space-insensitively, without revealing them", () => {
    expect(hashForLog(" Person@Example.com ")).toBe(hashForLog("person@example.com"));
    expect(hashForLog("a@example.com")).not.toBe(hashForLog("b@example.com"));
    expect(hashForLog("person@example.com")).not.toContain("person");
    expect(hashForLog("x")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("logs success events at info level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    emitSecurityEvent({ event: "auth.session_denied", outcome: "success" });
    expect(JSON.parse(String(spy.mock.calls[0]?.[0])).level).toBe("info");
  });
});
