import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { HANDOVER_REASON_CODES, SYSTEM_HANDOVER_REASONS } from "@/modules/bots";
import {
  BOT_ATTENTION_SQL,
  BOT_COLUMNS_SQL,
  botField,
  botJoinSql,
  noticeOutcome,
  toBotIndicator,
  type BotRow,
} from "./bot-indicator";

// Pure mapping of the bot indicator (08F-2): every published reason code has plain wording, the origin follows the published
// lists, and the SQL names lifecycle columns only.

const row = (over: Partial<BotRow>): BotRow => ({
  bs_state: "HANDED_OVER",
  bs_handover_reason: "needs_staff",
  bs_started_at: "2026-10-26T10:00:00.000Z",
  bs_ended_at: "2026-10-26T10:05:00.000Z",
  bs_redacted_at: null,
  bs_notice_state: null,
  bs_has_notice: false,
  ...over,
});
const render = (q: Parameters<PgDialect["sqlToQuery"]>[0]) => new PgDialect().sqlToQuery(q).sql;

describe("bot indicator mapping", () => {
  it("every flow reason is flow-requested and carries its own wording", () => {
    const reasons = new Set<string>();
    for (const code of HANDOVER_REASON_CODES) {
      const h = toBotIndicator(row({ bs_handover_reason: code }))!;
      expect(h.label).toBe("Bot asked for a human");
      expect(h.handover).toMatchObject({
        origin: "flow",
        reasonCode: code,
        studentMayNotHaveReceivedMessage: false,
      });
      reasons.add(h.handover!.reason);
    }
    expect(reasons.size).toBe(HANDOVER_REASON_CODES.length);
  });

  it("every exact system reason is system-initiated with wording; send_* and delivery_failed warn", () => {
    for (const code of SYSTEM_HANDOVER_REASONS.filter((r) => !r.endsWith("_"))) {
      const h = toBotIndicator(row({ bs_handover_reason: code }))!;
      expect(h.handover, code).toMatchObject({ origin: "system", reasonCode: code });
      expect(h.handover!.reason, code).not.toBe("The bot could not send a message");
      expect(h.handover!.studentMayNotHaveReceivedMessage, code).toBe(
        code === "delivery_failed" || code.startsWith("send_"),
      );
      expect(h.label).toBe("Bot handed over to staff");
    }
  });

  it("bot_error and engine_error are warning severity but NOT delivery uncertainty; staff reasons stay attention", () => {
    for (const code of ["bot_error", "engine_error"]) {
      const i = toBotIndicator(row({ bs_handover_reason: code }))!;
      expect(i.severity, code).toBe("warning");
      expect(i.handover, code).toMatchObject({
        origin: "system",
        reasonCode: code,
        studentMayNotHaveReceivedMessage: false,
      });
      expect(i.notice).toBeNull();
    }
    for (const code of ["staff_assigned", "operator_stop", "idle_timeout"])
      expect(toBotIndicator(row({ bs_handover_reason: code }))!.severity, code).toBe("attention");
    expect(toBotIndicator(row({ bs_handover_reason: "send_held" }))!.handover).toMatchObject({
      studentMayNotHaveReceivedMessage: true,
    });
  });

  it("a send_ prefix reason this build has no wording for still warns, and an unknown code is neither flow nor system", () => {
    expect(toBotIndicator(row({ bs_handover_reason: "send_future_code" }))!).toMatchObject({
      severity: "warning",
      handover: { origin: "system", reason: "The bot could not send a message" },
    });
    const unknown = toBotIndicator(row({ bs_handover_reason: "totally_new" }))!;
    expect(unknown.handover).toEqual({
      origin: "unrecognized",
      reasonCode: null,
      reason: "The reason is not recognised",
      studentMayNotHaveReceivedMessage: false,
    });
    expect(JSON.stringify(unknown)).not.toContain("totally_new");
  });

  it("notice outcomes: HELD, REJECTED and UNKNOWN_OUTCOME warn; accepted, pending and none do not", () => {
    for (const [state, outcome, warning] of [
      ["ACCEPTED", "ACCEPTED", false],
      ["QUEUED", "PENDING", false],
      ["SENDING", "PENDING", false],
      ["HELD", "HELD", true],
      ["REJECTED", "REJECTED", true],
      ["UNKNOWN_OUTCOME", "UNKNOWN_OUTCOME", true],
      [null, "NONE", false],
    ] as const) {
      expect(noticeOutcome(state)).toBe(outcome);
      const i = toBotIndicator(row({ bs_has_notice: true, bs_notice_state: state }))!;
      expect(i.notice).toMatchObject({ outcome, warning });
      expect(i.severity).toBe(warning ? "warning" : "attention");
    }
    expect(toBotIndicator(row({ bs_has_notice: false }))!.notice).toBeNull();
  });

  it("a COMPLETED session can still warn about its notice; redaction only sets a flag", () => {
    const i = toBotIndicator(
      row({
        bs_state: "COMPLETED",
        bs_handover_reason: null,
        bs_has_notice: true,
        bs_notice_state: "HELD",
        bs_redacted_at: "2026-11-30T00:00:00.000Z",
      }),
    )!;
    expect(i).toMatchObject({ state: "COMPLETED", severity: "warning", redacted: true });
    expect(i.handover).toBeNull();
  });

  it("no session, or no permission, yields no bot key", () => {
    expect(toBotIndicator({})).toBeUndefined();
    expect(toBotIndicator(row({ bs_state: null }))).toBeUndefined();
    expect(botField(row({}), false)).toEqual({});
    expect(Object.keys(botField(row({}), true))).toEqual(["bot"]);
  });
});

describe("bot indicator SQL", () => {
  const org = "00000000-0000-4000-8000-000000000001";
  it("names lifecycle columns only: no variables, awaiting, tokens, input ids or message text", () => {
    const text = `${render(botJoinSql(org))} ${render(BOT_COLUMNS_SQL)}`;
    expect(text).not.toMatch(
      /variables|awaiting|token(?!_notice)|last_input|body|content|started_by/i,
    );
    expect(text).toMatch(/s\.organization_id = \$1::uuid/);
    expect(text).toMatch(/r\.organization_id = s\.organization_id/);
    expect(text).toMatch(/ORDER BY s\.started_at DESC, s\.id DESC LIMIT 1/);
    expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
  it("the filter is unresolved AND latest state HANDED_OVER/FAILED", () => {
    expect(render(BOT_ATTENTION_SQL)).toBe(
      "(c.status <> 'RESOLVED' AND bs.bs_state IN ('HANDED_OVER', 'FAILED'))",
    );
  });
});
