import { describe, expect, it } from "vitest";
import type { AccessContext } from "@/modules/access";
import type { Database } from "@/db/client";
import { ValidationError } from "@/shared/errors/http-errors";
import { listBotSessions, listBotsPage, listDeadTriggers } from "./listings";

// Cursor validation needs no database: a bad cursor must be refused BEFORE any SQL is built or executed (Phase 08F-3).

const ctx = {
  userId: "u",
  membershipId: "m",
  organizationId: "00000000-0000-4000-8000-000000000001",
  role: "ADMIN",
  can: () => true,
} as unknown as AccessContext;

function stub() {
  const calls: unknown[] = [];
  const db = {
    execute: async (q: unknown) => {
      calls.push(q);
      return { rows: [] };
    },
  } as unknown as Database;
  return { db, calls };
}

const ID = "11111111-1111-4111-8111-111111111111";
const cursorOf = (t: string) => Buffer.from(JSON.stringify([t, ID])).toString("base64url");

describe("operator-listing cursor timestamps", () => {
  it.each([
    "2026-02-28T23:59:59.123456Z",
    "2024-02-29T00:00:00.000000Z", // leap day in a leap year
    "2000-02-29T12:00:00.999999Z", // divisible by 400
    "2026-12-31T23:59:59.000001Z", // microsecond precision is kept
  ])("accepts %s and reaches the executor", async (t) => {
    const { db, calls } = stub();
    await listBotSessions(ctx, { cursor: cursorOf(t) }, { db });
    await listDeadTriggers(ctx, { cursor: cursorOf(t) }, { db });
    expect(calls).toHaveLength(2);
  });

  it.each([
    "2026-13-01T00:00:00.000000Z", // month 13
    "2026-00-10T00:00:00.000000Z", // month 0
    "2026-02-30T00:00:00.000000Z", // Feb 30
    "2026-02-29T00:00:00.000000Z", // Feb 29, common year
    "1900-02-29T00:00:00.000000Z", // divisible by 100, not 400
    "2026-04-31T00:00:00.000000Z", // 30-day month
    "2026-01-00T00:00:00.000000Z", // day 0
    "2026-01-01T24:00:00.000000Z", // hour 24
    "2026-01-01T00:60:00.000000Z", // minute 60
    "2026-01-01T00:00:60.000000Z", // second 60
  ])("rejects %s before any SQL", async (t) => {
    const { db, calls } = stub();
    await expect(listBotSessions(ctx, { cursor: cursorOf(t) }, { db })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(listDeadTriggers(ctx, { cursor: cursorOf(t) }, { db })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("bot-list cursor (DEV-1)", () => {
  const keyCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  it.each([
    ["enquiry"],
    ["a"],
    ["a_1"],
    [`a${"z".repeat(63)}`], // the longest key
    ["a_key_this_organization_never_had"], // well-formed but never issued: only a starting point in the caller's own bots
  ])("accepts the key %s and reaches the executor", async (key) => {
    const { db, calls } = stub();
    await expect(listBotsPage(ctx, { cursor: keyCursor([key]) }, { db })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["not base64url", "!!!"],
    ["padding characters", `${keyCursor(["enquiry"])}==`],
    ["not JSON", Buffer.from("enquiry").toString("base64url")],
    ["a bare string", keyCursor("enquiry")],
    ["an empty tuple", keyCursor([])],
    ["two elements", keyCursor(["enquiry", "other"])],
    ["an object", keyCursor({ key: "enquiry" })],
    ["a number", keyCursor([5])],
    ["an upper-case key", keyCursor(["Enquiry"])],
    ["a key starting with a digit", keyCursor(["1bot"])],
    ["a key with a quote", keyCursor(["a' OR '1'='1"])],
    ["a key of 65 characters", keyCursor([`a${"z".repeat(64)}`])],
    ["an empty key", keyCursor([""])],
    ["a sessions cursor", cursorOf("2026-02-28T23:59:59.123456Z")],
    ["an empty cursor", ""],
    ["a cursor over 300 characters", keyCursor(["a"]).padEnd(301, "A")],
  ])("rejects %s before any SQL", async (_name, cursor) => {
    const { db, calls } = stub();
    await expect(listBotsPage(ctx, { cursor }, { db })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it("keeps the numeric limit contract of the other listings: a string limit is refused here (HTTP converts it first)", async () => {
    const { db, calls } = stub();
    for (const limit of ["50", 0, 101, 1.5, Number.NaN])
      await expect(listBotsPage(ctx, { limit }, { db })).rejects.toBeInstanceOf(ValidationError);
    await expect(listBotsPage(ctx, { organizationId: "x" }, { db })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(calls).toHaveLength(0);
    await listBotsPage(ctx, { limit: 100 }, { db });
    expect(calls).toHaveLength(1);
  });
});
