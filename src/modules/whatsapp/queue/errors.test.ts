import { describe, expect, it } from "vitest";
import { HandlerTimeoutError, PermanentWebhookError, classifyFailure, safeCode } from "./errors";
import { withDeadline } from "./timeout";

describe("failure classification", () => {
  it("a PermanentWebhookError is permanent and carries only its fixed code", () => {
    expect(classifyFailure(new PermanentWebhookError("invalid_envelope"))).toEqual({
      permanent: true,
      code: "invalid_envelope",
    });
  });

  it("replaces an unsafe permanent code instead of storing it", () => {
    for (const unsafe of ["has space", "UPPER", "15550100123 hello", "a".repeat(65), "", "x\ny"]) {
      const error = new PermanentWebhookError(unsafe);
      expect(error.code).toBe("permanent_error");
      expect(error.message).toBe("permanent_error");
      expect(classifyFailure(error)).toEqual({ permanent: true, code: "permanent_error" });
    }
  });

  it("everything else is transient, and the message never becomes the code", () => {
    for (const thrown of [
      new Error("secret 15550100123 LK.100000000000000001"),
      new TypeError("x"),
      "a string",
      null,
      undefined,
      { message: "token-abc", code: "not a sqlstate" },
    ]) {
      expect(classifyFailure(thrown)).toEqual({ permanent: false, code: "unexpected_error" });
    }
  });

  it("PostgreSQL errors (also wrapped, as Drizzle does) are transient with a sqlstate code, constraint errors included", () => {
    for (const state of ["23505", "23503", "23514", "22012", "40P01", "40001", "57014", "08006"]) {
      const wrapped = Object.assign(new Error("Failed query: insert ... params: secret"), {
        cause: Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: state,
        }),
      });
      expect(classifyFailure(wrapped)).toEqual({
        permanent: false,
        code: `pg_${state.toLowerCase()}`,
      });
    }
  });

  it("a timeout is transient", () => {
    expect(classifyFailure(new HandlerTimeoutError())).toEqual({
      permanent: false,
      code: "handler_timeout",
    });
  });

  it("safeCode accepts only short lowercase codes", () => {
    expect(safeCode("exhausted_pg_40p01")).toBe("exhausted_pg_40p01");
    expect(safeCode("Bad Code")).toBe("unexpected_error");
    expect(safeCode("x".repeat(65), "fallback_code")).toBe("fallback_code");
  });
});

describe("withDeadline", () => {
  it("passes the result through and cancels its timer", async () => {
    let timedOut = false;
    expect(await withDeadline(Promise.resolve(7), 50, () => (timedOut = true))).toBe(7);
    await new Promise((r) => setTimeout(r, 80));
    expect(timedOut).toBe(false);
  });

  it("passes the work's own error through", async () => {
    await expect(
      withDeadline(Promise.reject(new Error("own")), 50, () => undefined),
    ).rejects.toThrow("own");
  });

  it("calls onTimeout first, then rejects with HandlerTimeoutError, and swallows the late outcome", async () => {
    const order: string[] = [];
    const late = new Promise<void>((_, reject) => setTimeout(() => reject(new Error("late")), 80));
    await expect(
      withDeadline(late, 20, () => order.push("abort")).catch((e) => {
        order.push(e.constructor.name);
        throw e;
      }),
    ).rejects.toBeInstanceOf(HandlerTimeoutError);
    expect(order).toEqual(["abort", "HandlerTimeoutError"]);
    await new Promise((r) => setTimeout(r, 120)); // the late rejection must not surface as unhandled
  });
});
