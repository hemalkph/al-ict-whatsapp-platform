import { describe, expect, it } from "vitest";
import type { AccessContext } from "@/modules/access";
import type { Database } from "@/db/client";
import { ValidationError } from "@/shared/errors/http-errors";
import { listBotSessions, listDeadTriggers } from "./listings";

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
