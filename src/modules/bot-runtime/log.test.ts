import { afterEach, describe, expect, it, vi } from "vitest";
import { botRuntimeLogContext, emitBotRuntimeLog, type BotRuntimeLog } from "./log";

const U = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";

afterEach(() => vi.restoreAllMocks());

describe("fixed-field bot runtime logging", () => {
  it("writes only the whitelisted fields", () => {
    const context = botRuntimeLogContext({
      event: "bots.trigger_dead",
      outcome: "failure",
      organizationId: U,
      whatsappAccountId: V,
      conversationId: U,
      messageId: V,
      triggerId: U,
      sessionId: V,
      outboundRequestId: U,
      reason: "attempts_exhausted",
      count: 6,
    });
    expect(Object.keys(context).sort()).toEqual(
      [
        "bots_event",
        "outcome",
        "organization_id",
        "whatsapp_account_id",
        "conversation_id",
        "message_id",
        "trigger_id",
        "session_id",
        "outbound_request_id",
        "reason",
        "count",
      ].sort(),
    );
  });

  it("an extra property can never reach the output, whatever a caller passes (text, tokens, variables, payloads)", () => {
    const hostile = {
      event: "bots.trigger_capture_failed",
      outcome: "failure",
      organizationId: U,
      body: "student wrote a secret",
      text: "hello",
      promptToken: "AbCdEfGhIjKlMnOpQrStUv",
      replyId: "b1.AbCdEfGhIjKlMnOpQrStUv.fees",
      variables: { name: "Nimal" },
      payload: { a: 1 },
      phone: "94771234567",
    } as unknown as BotRuntimeLog;
    const text = JSON.stringify(botRuntimeLogContext(hostile));
    for (const leak of [
      "secret",
      "hello",
      "AbCdEf",
      "b1.",
      "Nimal",
      "94771234567",
      "payload",
      "variables",
    ])
      expect(text, leak).not.toContain(leak);
  });

  it("an identifier that is not a UUID is dropped, a reason that is not a short code is replaced, a bad count is dropped", () => {
    const c = botRuntimeLogContext({
      event: "bots.trigger_overdue",
      outcome: "failure",
      organizationId: "not-a-uuid",
      conversationId: "94771234567",
      reason: "Has Spaces And Text",
      count: -1,
    });
    expect(c.organization_id).toBeUndefined();
    expect(c.conversation_id).toBeUndefined();
    expect(c.reason).toBe("invalid_reason");
    expect(c.count).toBeUndefined();
    expect(
      botRuntimeLogContext({ event: "bots.trigger_overdue", outcome: "failure", count: 1.5 }).count,
    ).toBeUndefined();
    expect(
      botRuntimeLogContext({ event: "bots.trigger_overdue", outcome: "failure", count: 0 }).count,
    ).toBe(0);
  });

  it("the severity follows the event and outcome, and the line is one JSON object", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    emitBotRuntimeLog({
      event: "bots.trigger_dead",
      outcome: "failure",
      triggerId: U,
      reason: "attempts_exhausted",
    });
    emitBotRuntimeLog({ event: "bots.send_state_missing", outcome: "failure", sessionId: U });
    emitBotRuntimeLog({
      event: "bots.trigger_capped",
      outcome: "denied",
      conversationId: U,
      count: 20,
    });
    expect(error).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1); // a warning is written with the ordinary stream
    const line = JSON.parse(String(error.mock.calls[0]![0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "error",
      message: "bots.trigger_dead",
      bots_event: "bots.trigger_dead",
      trigger_id: U,
    });
  });
});
