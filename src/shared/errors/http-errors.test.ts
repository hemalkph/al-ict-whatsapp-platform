import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "./app-error";
import {
  ForbiddenError,
  NotFoundError,
  OrganizationSelectionRequiredError,
  PasswordChangeRequiredError,
  UnauthenticatedError,
  toErrorResponse,
} from "./http-errors";

afterEach(() => vi.restoreAllMocks());

describe("authorization errors", () => {
  it.each([
    [new UnauthenticatedError(), 401, "UNAUTHENTICATED"],
    [new ForbiddenError("anything internal"), 403, "FORBIDDEN"],
    [new PasswordChangeRequiredError(), 403, "PASSWORD_CHANGE_REQUIRED"],
    [new NotFoundError(), 404, "NOT_FOUND"],
    [new OrganizationSelectionRequiredError(), 409, "ORGANIZATION_SELECTION_REQUIRED"],
  ])("%s maps to %i %s", async (error, status, code) => {
    expect(error).toBeInstanceOf(AppError);
    const res = toErrorResponse(error);
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.error.code).toBe(code);
  });

  it("never leaks internal reasons or identifiers in the response body", async () => {
    const res = toErrorResponse(
      new ForbiddenError("membership 123 in organization abc is SUSPENDED"),
    );
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/membership|organization|abc|123|SUSPENDED/i);
  });

  it("answers NotFound identically regardless of which resource was requested", async () => {
    const a = await toErrorResponse(new NotFoundError()).text();
    const b = await toErrorResponse(new NotFoundError()).text();
    expect(a).toBe(b);
  });

  it("turns unknown errors and 5xx AppErrors into a generic 500 without leaking details", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const e of [
      new Error("password=hunter2 failed"),
      new AppError("DB", "db host secret", 503),
      "string",
    ]) {
      const res = toErrorResponse(e);
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).not.toMatch(/hunter2|secret/);
    }
    expect(spy.mock.calls.join(" ")).not.toMatch(/hunter2/);
  });
});
