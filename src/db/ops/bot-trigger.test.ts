import { describe, expect, it, vi } from "vitest";
import type { DbExecutor } from "./executor";
import { insertBotTriggerIfAdmitted } from "./bot-trigger";

describe("trigger admission type boundary", () => {
  it.each([
    "IMAGE",
    "VIDEO",
    "AUDIO",
    "DOCUMENT",
    "STICKER",
    "LOCATION",
    "CONTACT",
    "REACTION",
    "FLOW",
    "TEMPLATE",
    "SYSTEM",
    "UNKNOWN",
    "text",
    "",
  ])("%s issues no SQL", async (messageType) => {
    const execute = vi.fn();
    expect(
      await insertBotTriggerIfAdmitted({ execute } as unknown as DbExecutor, {
        organizationId: "unused",
        whatsappAccountId: "unused",
        conversationId: "unused",
        messageId: "unused",
        messageType,
        inputOccurredAt: new Date(0),
      }),
    ).toEqual({ inserted: false, reason: "type" });
    expect(execute).not.toHaveBeenCalled();
  });
});
