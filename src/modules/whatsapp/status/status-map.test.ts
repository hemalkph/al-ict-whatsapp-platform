import { describe, expect, it } from "vitest";
import { normalizeEnvelope } from "../normalize";
import { parseDelivery } from "../parse";
import { fixture } from "../testing";
import { STATUS_LIMITS, mapStatusEvent } from "./status-map";

// Pure mapping/validation of the stored STATUS envelope, driven by the sanitized G0 fixtures.

const statusEvents = (name: string) => {
  const parsed = parseDelivery(fixture(name));
  if (!parsed.ok) throw new Error("fixture does not parse");
  return normalizeEnvelope(parsed.envelope).filter((e) => e.eventType === "STATUS");
};
const map = (name: string) => mapStatusEvent(statusEvents(name)[0]!.payload);
const withStatus = (status: Record<string, unknown>) => ({
  v: 1,
  status: { id: "wamid.X", status: "delivered", timestamp: "1790000000", ...status },
});
const codeOf = (payload: unknown) => {
  try {
    mapStatusEvent(payload);
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

describe("status values (sanitized G0 fixtures)", () => {
  it("sent, delivered (phone + BSUID, BSUID only), read", () => {
    expect(map("status-sent.json")).toMatchObject({
      wamid: "wamid.FAKE00000000000000000200",
      status: "SENT",
    });
    expect(map("status-delivered-phone-bsuid.json").status).toBe("DELIVERED");
    expect(map("status-delivered-bsuid-only.json").status).toBe("DELIVERED");
    expect(map("status-read.json").status).toBe("READ");
    expect(map("status-sent.json").occurredAt.toISOString()).toBe("2026-09-21T14:13:20.000Z");
  });

  it("failed keeps the first error's code and a short description, nothing else", () => {
    expect(map("status-failed.json")).toMatchObject({
      status: "FAILED",
      errorCode: "131049",
      errorMessage: "This message was not delivered to maintain healthy ecosystem engagement.",
    });
  });

  it("played (documented only by a changelog sentence) is refused, as is any unknown value", () => {
    expect(statusEvents("status-played.json")[0]!.intrinsic).toEqual({
      kind: "ignored",
      reason: "status_not_mirrored",
    });
    expect(codeOf(statusEvents("status-played.json")[0]!.payload)).toBe("unsupported_status");
    for (const status of ["PLAYED", "deleted", "", "Sent", " sent", 7, null])
      expect(codeOf(withStatus({ status })), String(status)).toBe("unsupported_status");
  });
});

describe("recipients are never read", () => {
  it("the observation carries only the wamid, status, time and error fields", () => {
    const m = map("status-delivered-phone-bsuid.json");
    expect(Object.keys(m).sort()).toEqual([
      "errorCode",
      "errorMessage",
      "occurredAt",
      "status",
      "wamid",
    ]);
    expect(JSON.stringify(m)).not.toMatch(/15550100123|LK\./);
  });
});

describe("validation", () => {
  it("fails permanently with fixed codes", () => {
    expect(codeOf(null)).toBe("invalid_event_payload");
    expect(codeOf({ v: 1 })).toBe("invalid_event_payload");
    expect(codeOf({ v: 1, status: "x" })).toBe("invalid_event_payload");
    expect(codeOf(withStatus({ id: undefined }))).toBe("invalid_status");
    expect(codeOf(withStatus({ id: "" }))).toBe("invalid_status");
    expect(codeOf(withStatus({ id: 7 }))).toBe("invalid_status");
    expect(codeOf(withStatus({ id: "w".repeat(STATUS_LIMITS.wamid + 1) }))).toBe("invalid_status");
    for (const timestamp of [undefined, "abc", "0", "-1", "12.5", "99999999999999", {}, ""])
      expect(codeOf(withStatus({ timestamp })), String(timestamp)).toBe("invalid_timestamp");
  });
  it("accepts a wamid at the limit and keeps it opaque (no parsing, no case change)", () => {
    const wamid = "wamid." + "Ab-_=".repeat(100).slice(0, STATUS_LIMITS.wamid - 6);
    expect(mapStatusEvent(withStatus({ id: wamid })).wamid).toBe(wamid);
  });
  it("keeps the provider timestamp exactly, including one far in the future", () => {
    expect(mapStatusEvent(withStatus({ timestamp: "4102444800" })).occurredAt.toISOString()).toBe(
      "2100-01-01T00:00:00.000Z",
    );
    expect(mapStatusEvent(withStatus({ timestamp: 1790000000 })).occurredAt.getTime()).toBe(
      1790000000000,
    );
  });
});

describe("failed-status error details", () => {
  const failed = (errors: unknown) => mapStatusEvent(withStatus({ status: "failed", errors }));
  it("missing, empty or malformed errors give nulls and never fail the status", () => {
    for (const errors of [undefined, null, [], "x", 5, {}, [null], [5], ["s"]])
      expect(failed(errors), JSON.stringify(errors)).toMatchObject({
        status: "FAILED",
        errorCode: null,
        errorMessage: null,
      });
  });
  it("code may be a number or a string; a description comes from message, then title, then error_data.details", () => {
    expect(failed([{ code: 131026 }]).errorCode).toBe("131026");
    expect(failed([{ code: "131026" }]).errorCode).toBe("131026");
    expect(failed([{ code: 1.9 }]).errorCode).toBe("1");
    expect(failed([{ code: Number.NaN }]).errorCode).toBeNull();
    expect(failed([{ message: "m", title: "t", error_data: { details: "d" } }]).errorMessage).toBe(
      "m",
    );
    expect(failed([{ title: "t", error_data: { details: "d" } }]).errorMessage).toBe("t");
    expect(failed([{ error_data: { details: "d" } }]).errorMessage).toBe("d");
  });
  it("only the first error is used; nested or unknown fields are never stored", () => {
    const m = failed([
      { code: 1, message: "first", href: "/x", error_data: { secret: "s" } },
      { code: 2, message: "second" },
    ]);
    expect(m).toMatchObject({ errorCode: "1", errorMessage: "first" });
    expect(JSON.stringify(m)).not.toMatch(/second|href|secret/);
  });
  it("error text is sanitized and cut to the limit instead of failing the status", () => {
    expect(failed([{ message: "a\u0000b\ud800" }]).errorMessage).toBe("ab\u{FFFD}");
    const long = failed([{ message: "x".repeat(50_000), code: "9".repeat(500) }]);
    expect(Array.from(long.errorMessage!)).toHaveLength(STATUS_LIMITS.errorMessage);
    expect(long.errorCode).toHaveLength(STATUS_LIMITS.errorCode);
    expect(failed([{ message: "\u{1F600}".repeat(600) }]).errorMessage!.endsWith("\u{1F600}")).toBe(
      true,
    );
  });
  it("errors on a non-failed status are ignored", () => {
    expect(
      mapStatusEvent(withStatus({ status: "delivered", errors: [{ code: 5, message: "m" }] })),
    ).toMatchObject({
      status: "DELIVERED",
      errorCode: null,
      errorMessage: null,
    });
  });
});
