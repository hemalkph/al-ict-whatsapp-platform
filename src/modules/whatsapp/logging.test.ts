import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shortHash } from "./idempotency";
import { emitWebhookLog, type WebhookLog } from "./logging";

const ALLOWED = new Set([
  "level",
  "message",
  "time",
  "webhook_event",
  "outcome",
  "request_id",
  "organization_id",
  "whatsapp_account_id",
  "event_type",
  "reason",
  "ingest_status",
  "body_bytes",
  "duration_ms",
  "count_events",
  "count_inserted",
  "count_duplicates",
  "count_pending",
  "count_held",
  "count_ignored",
  "count_dead",
]);

describe("webhook logging writes only a fixed set of fields", () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation(
        (line: unknown) => void lines.push(String(line)),
      );
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it("drops any extra property, even one smuggled past the types", () => {
    const hostile = {
      event: "webhook.request_accepted",
      outcome: "success",
      requestId: "r1",
      rawBody: "SECRET-BODY",
      body: "message text",
      name: "Test Student",
      phone: "15550100123",
      waId: "15550100123",
      bsuid: "LK.100000000000000001",
      signature: "sha256=abc",
      token: "verify-token",
      appSecret: "app-secret",
      headers: { "x-hub-signature-256": "sha256=abc" },
      payload: { text: "hello" },
    } as unknown as WebhookLog;
    emitWebhookLog(hostile);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) expect(ALLOWED.has(key), key).toBe(true);
    for (const forbidden of [
      "SECRET-BODY",
      "message text",
      "Test Student",
      "15550100123",
      "LK.1000",
      "sha256=abc",
      "verify-token",
      "app-secret",
      "hello",
    ]) {
      expect(lines[0], forbidden).not.toContain(forbidden);
    }
    expect(parsed.request_id).toBe("r1");
  });

  it("flattens counts and rounds the duration", () => {
    emitWebhookLog({
      event: "webhook.request_accepted",
      outcome: "success",
      durationMs: 12.6,
      counts: { events: 3, inserted: 2, duplicates: 1, pending: 1, held: 1, ignored: 0, dead: 0 },
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      duration_ms: 13,
      count_events: 3,
      count_inserted: 2,
      count_duplicates: 1,
      count_pending: 1,
      count_held: 1,
      count_ignored: 0,
      count_dead: 0,
    });
  });

  it("accepts only short fixed reason codes: free text cannot be injected into the log", () => {
    emitWebhookLog({
      event: "webhook.signature_invalid",
      outcome: "denied",
      reason: 'bad"}\n{"level":"error',
    });
    expect(lines).toHaveLength(1); // no second, forged log line
    expect(JSON.parse(lines[0]!).reason).toBe("invalid_reason");
    emitWebhookLog({
      event: "webhook.signature_invalid",
      outcome: "denied",
      reason: "malformed_header",
    });
    expect(JSON.parse(lines[1]!).reason).toBe("malformed_header");
  });

  it("uses info for success, warn for denials and failures, and error only for a failed ingest", () => {
    emitWebhookLog({ event: "webhook.request_accepted", outcome: "success" });
    emitWebhookLog({ event: "webhook.signature_invalid", outcome: "denied" });
    emitWebhookLog({ event: "webhook.events_rejected", outcome: "failure" });
    emitWebhookLog({ event: "webhook.ingest_failed", outcome: "failure" });
    expect(lines.map((line) => JSON.parse(line).level)).toEqual(["info", "warn", "warn", "error"]);
  });
});

describe("shortHash", () => {
  it("is a short, stable, non-reversible tag", () => {
    expect(shortHash("wamid.FAKE1")).toMatch(/^[0-9a-f]{12}$/);
    expect(shortHash("wamid.FAKE1")).toBe(shortHash("wamid.FAKE1"));
    expect(shortHash("wamid.FAKE1")).not.toBe(shortHash("wamid.FAKE2"));
    expect(shortHash("wamid.FAKE1")).not.toContain("FAKE");
  });
});
