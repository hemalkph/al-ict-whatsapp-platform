import { afterEach, describe, expect, it, vi } from "vitest";
import { logToStderr, logger } from "./logger";

afterEach(() => vi.restoreAllMocks());

describe("logger", () => {
  it("writes one JSON line with level, message, time and context", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("hello", { request_id: "r1" });
    const entry = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(entry).toMatchObject({ level: "info", message: "hello", request_id: "r1" });
    expect(typeof entry.time).toBe("string");
  });

  it("writes errors to stderr", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("boom");
    expect(spy).toHaveBeenCalledOnce();
  });

  // keep last: logToStderr() is process-wide by design (command-line tools call it once at start-up)
  it("logToStderr() moves every level to stderr and leaves stdout untouched", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logToStderr();
    logger.info("a");
    logger.warn("b");
    logger.error("c");
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(3);
  });
});
