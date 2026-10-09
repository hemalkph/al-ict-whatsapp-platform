import { describe, expect, it } from "vitest";
import { handleInboundMessage } from "../inbound/handler";
import { handleMessageStatus } from "../status/handler";
import { webhookWorkerHandlers } from "./registry";

describe("production handler registry", () => {
  it("contains exactly MESSAGE and STATUS, mapped to the real handlers", () => {
    expect(Object.keys(webhookWorkerHandlers).sort()).toEqual(["MESSAGE", "STATUS"]);
    expect(webhookWorkerHandlers.MESSAGE).toBe(handleInboundMessage);
    expect(webhookWorkerHandlers.STATUS).toBe(handleMessageStatus);
  });

  it("has no IDENTITY, OTHER or any other entry: those event types stay unclaimed", () => {
    for (const type of ["IDENTITY", "OTHER", "SYSTEM", "UNKNOWN"])
      expect(webhookWorkerHandlers).not.toHaveProperty(type);
  });

  it("is frozen: nothing can register a handler (a no-op included) at runtime", () => {
    expect(Object.isFrozen(webhookWorkerHandlers)).toBe(true);
    expect(() => {
      "use strict";
      (webhookWorkerHandlers as Record<string, unknown>).IDENTITY = async () => undefined;
    }).toThrow();
    expect(webhookWorkerHandlers).not.toHaveProperty("IDENTITY");
  });

  it("holds only real, named handlers", () => {
    for (const handler of Object.values(webhookWorkerHandlers)) {
      expect(typeof handler).toBe("function");
      expect(handler!.name).toMatch(/^handle[A-Z]/);
      expect(handler!.toString()).not.toMatch(/^\s*(async\s*)?\(\)\s*=>\s*(undefined|\{\s*\})/);
    }
  });
});
