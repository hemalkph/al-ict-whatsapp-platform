import { describe, expect, it } from "vitest";
import * as publicApi from "./index";
import { WebhookConfigError, readAppSecret, readVerifyToken } from "./config";

describe("webhook configuration is read lazily and never echoes values", () => {
  it("importing the module needs no environment (nothing is read at import time)", () => {
    expect(Object.keys(publicApi).sort()).toEqual(["handleWebhookGet", "handleWebhookPost"]);
  });

  it("accepts a valid app secret and verification token", () => {
    expect(readAppSecret({ META_APP_SECRET: "a".repeat(32) })).toBe("a".repeat(32));
    expect(readVerifyToken({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: "t".repeat(40) })).toBe("t".repeat(40));
  });

  it.each([
    ["missing", {}],
    ["empty", { META_APP_SECRET: "" }],
    ["too short", { META_APP_SECRET: "short" }],
    ["too long", { META_APP_SECRET: "x".repeat(257) }],
  ])("rejects a %s app secret, naming only the key", (_name, source) => {
    expect(() => readAppSecret(source)).toThrow(WebhookConfigError);
    try {
      readAppSecret(source);
    } catch (error) {
      expect((error as WebhookConfigError).key).toBe("META_APP_SECRET");
      expect((error as Error).message).not.toContain("short");
      expect((error as Error).message).not.toContain("xxxxxxxx");
    }
  });

  it("requires a verification token of at least 32 characters and never puts it in the error", () => {
    const secretish = "a-token-that-is-31-characters-x"; // 31
    expect(secretish).toHaveLength(31);
    try {
      readVerifyToken({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: secretish });
      expect.unreachable();
    } catch (error) {
      expect((error as WebhookConfigError).key).toBe("WHATSAPP_WEBHOOK_VERIFY_TOKEN");
      expect((error as Error).message).not.toContain(secretish);
    }
  });

  it("the two settings are independent: GET needs only the token, POST only the secret", () => {
    expect(readVerifyToken({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: "t".repeat(32) })).toBeTruthy();
    expect(() => readAppSecret({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: "t".repeat(32) })).toThrow(
      WebhookConfigError,
    );
  });
});
