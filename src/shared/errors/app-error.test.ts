import { describe, expect, it } from "vitest";
import { AppError } from "./app-error";

describe("AppError", () => {
  it("carries code, status and cause", () => {
    const cause = new Error("db down");
    const err = new AppError("DB_UNAVAILABLE", "Service unavailable", 503, { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ code: "DB_UNAVAILABLE", httpStatus: 503, cause });
  });

  it("defaults to 500", () => {
    expect(new AppError("X", "x").httpStatus).toBe(500);
  });
});
