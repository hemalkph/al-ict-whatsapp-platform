import { describe, expect, it } from "vitest";
import { isDeterministicDataError, sqlState } from "./ingest";

const pg = (code: string) => Object.assign(new Error("pg"), { code });
const wrapped = (code: string) => Object.assign(new Error("Failed query"), { cause: pg(code) });

describe("which failures are deterministic (answer 200, keep the request) versus infrastructure (answer 500)", () => {
  it("finds the SQLSTATE through a wrapped cause", () => {
    expect(sqlState(pg("23503"))).toBe("23503");
    expect(sqlState(wrapped("22P02"))).toBe("22P02");
    expect(sqlState(new Error("plain"))).toBeNull();
    expect(sqlState(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBeNull();
    expect(sqlState(null)).toBeNull();
    expect(sqlState("23503")).toBeNull();
  });

  it.each([
    "22001",
    "22021",
    "22P02",
    "22P05",
    "23502",
    "23503",
    "23505",
    "23514",
    "54000",
    "54001",
  ])("treats SQLSTATE %s as deterministic (retrying the same bytes cannot succeed)", (code) => {
    expect(isDeterministicDataError(pg(code))).toBe(true);
    expect(isDeterministicDataError(wrapped(code))).toBe(true);
  });

  it.each([
    "08000",
    "08006",
    "40001",
    "40P01",
    "53100",
    "53300",
    "55P03",
    "57014",
    "57P01",
    "58000",
    "XX000",
    "42P01",
  ])(
    "treats SQLSTATE %s as infrastructure (a retry may succeed, so the caller answers 500)",
    (code) => {
      expect(isDeterministicDataError(pg(code))).toBe(false);
      expect(isDeterministicDataError(wrapped(code))).toBe(false);
    },
  );

  it("treats a RangeError (absurdly nested JSON) as deterministic and any other error as infrastructure", () => {
    expect(isDeterministicDataError(new RangeError("Maximum call stack size exceeded"))).toBe(true);
    expect(isDeterministicDataError(new Error("connection terminated unexpectedly"))).toBe(false);
    expect(isDeterministicDataError(new TypeError("x"))).toBe(false);
    expect(isDeterministicDataError("oops")).toBe(false);
  });
});
