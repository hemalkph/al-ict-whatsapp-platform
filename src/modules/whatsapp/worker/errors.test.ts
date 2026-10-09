import { describe, expect, it } from "vitest";
import { SchemaNotReadyError, classifyLoopError } from "./errors";

const pg = (code: string, message = "boom") => Object.assign(new Error(message), { code });
const wrapped = (inner: unknown) =>
  Object.assign(new Error("Failed query: select ..."), { cause: inner });

describe("worker error classification", () => {
  it.each(["28P01", "28000", "3D000", "42P01", "42703", "42501"])(
    "SQLSTATE %s is a configuration error: waiting cannot fix it",
    (code) => {
      expect(classifyLoopError(pg(code)).kind).toBe("configuration");
      expect(classifyLoopError(wrapped(pg(code))).kind).toBe("configuration");
    },
  );

  it("an unapplied migration is a configuration error", () => {
    expect(classifyLoopError(new SchemaNotReadyError())).toEqual({
      kind: "configuration",
      code: "schema_not_ready",
    });
  });

  it.each(["08006", "08001", "57P01", "57P02", "57P03", "53300"])(
    "SQLSTATE %s is database unavailability",
    (code) => {
      expect(classifyLoopError(wrapped(pg(code))).kind).toBe("database_unavailable");
    },
  );

  it.each(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND"])(
    "Node error %s (even nested, even inside an AggregateError) is database unavailability",
    (code) => {
      expect(classifyLoopError(pg(code)).kind).toBe("database_unavailable");
      expect(classifyLoopError(wrapped(pg(code))).kind).toBe("database_unavailable");
      expect(classifyLoopError(new AggregateError([pg(code)])).kind).toBe("database_unavailable");
    },
  );

  it.each([
    "Connection terminated unexpectedly",
    "timeout exceeded when trying to connect",
    "Client has encountered a connection error and is not queryable",
  ])("the pool message %j is database unavailability", (message) => {
    expect(classifyLoopError(new Error(message)).kind).toBe("database_unavailable");
  });

  it("anything else is unexpected (still bounded by the outage limit) and its message is never carried in the code", () => {
    const f = classifyLoopError(new Error("password for user admin at 10.0.0.5 failed"));
    expect(f).toEqual({ kind: "unexpected", code: "unexpected_error" });
    expect(classifyLoopError(pg("23505", "duplicate key value (secret)"))).toEqual({
      kind: "unexpected",
      code: "pg_23505",
    });
    expect(classifyLoopError("a string")).toEqual({ kind: "unexpected", code: "unexpected_error" });
    expect(classifyLoopError(null).kind).toBe("unexpected");
  });
});
