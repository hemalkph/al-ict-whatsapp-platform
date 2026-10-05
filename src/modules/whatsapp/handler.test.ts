import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { MAX_WEBHOOK_BODY_BYTES } from "./body";
import { handleWebhookGet, handleWebhookPost } from "./handler";
import {
  TEST_APP_SECRET,
  TEST_VERIFY_TOKEN,
  WEBHOOK_URL,
  fixture,
  sign,
  webhookGet,
  webhookPost,
} from "./testing";

// Everything that happens BEFORE the database. The `db` handed to the handler throws on any use, so a passing 403/413
// proves that a refused delivery stores nothing and never even reaches storage.
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error("the database must not be touched for this request");
    },
  },
) as unknown as Database;
const deps = { db: untouchable };

describe("webhook handlers before storage", () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    vi.stubEnv("META_APP_SECRET", TEST_APP_SECRET);
    vi.stubEnv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", TEST_VERIFY_TOKEN);
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation(
        (line: unknown) => void lines.push(String(line)),
      );
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("GET verification", () => {
    const ok = {
      "hub.mode": "subscribe",
      "hub.verify_token": TEST_VERIFY_TOKEN,
      "hub.challenge": "1158201444",
    };

    it("answers 200 with the exact challenge as text/plain, uncached and with nosniff", async () => {
      const res = handleWebhookGet(webhookGet(ok));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("1158201444");
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it.each([
      ["a wrong token", { ...ok, "hub.verify_token": "x".repeat(40) }],
      ["a wrong mode", { ...ok, "hub.mode": "unsubscribe" }],
      ["a missing challenge", { "hub.mode": "subscribe", "hub.verify_token": TEST_VERIFY_TOKEN }],
      ["no parameters at all", {}],
    ])("refuses %s with 403 and an empty body", async (_name, query) => {
      const res = handleWebhookGet(webhookGet(query));
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    });

    it("never logs the supplied or the expected token", () => {
      handleWebhookGet(
        webhookGet({ ...ok, "hub.verify_token": "SUPPLIED-WRONG-TOKEN-0123456789012345" }),
      );
      handleWebhookGet(webhookGet(ok));
      const output = lines.join("\n");
      expect(output).not.toContain(TEST_VERIFY_TOKEN);
      expect(output).not.toContain("SUPPLIED-WRONG-TOKEN");
      expect(output).toContain("webhook.verification_failed");
      expect(output).toContain("webhook.verification_succeeded");
    });

    it("fails closed with a generic 500 and a log naming only the missing key", async () => {
      vi.stubEnv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", "");
      const res = handleWebhookGet(webhookGet(ok));
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("");
      const logged = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
      expect(logged.reason).toBe("whatsapp_webhook_verify_token");
      expect(JSON.stringify(logged)).not.toContain(TEST_VERIFY_TOKEN);
    });
  });

  describe("POST refusals store nothing", () => {
    const body = fixture("text-phone.json");

    it("fails closed with a generic 500 when the app secret is not configured", async () => {
      vi.stubEnv("META_APP_SECRET", "");
      const res = await handleWebhookPost(webhookPost(body), deps);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("");
      expect(JSON.parse(lines.at(-1)!).reason).toBe("meta_app_secret");
    });

    it("answers 413 from a declared Content-Length over the limit without reading the body", async () => {
      const request = webhookPost(body, {
        headers: { "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1) },
      });
      const res = await handleWebhookPost(request, deps);
      expect(res.status).toBe(413);
      expect(await res.text()).toBe("");
      expect(request.bodyUsed).toBe(false);
      expect(res.headers.get("connection")).toBe("close"); // never keep a connection open for a refused upload
    });

    it("also stops a body that exceeds the limit while streaming, whatever it declares (or hides)", async () => {
      const chunk = new Uint8Array(64 * 1024).fill(0x61);
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent > MAX_WEBHOOK_BODY_BYTES) return controller.close();
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      const request = new Request(WEBHOOK_URL, {
        method: "POST",
        body: stream,
        duplex: "half",
        headers: { "x-hub-signature-256": sign(chunk) },
      } as RequestInit);
      const res = await handleWebhookPost(request, deps);
      expect(res.status).toBe(413);
      expect(res.headers.get("connection")).toBe("close");
      expect(sent).toBeLessThanOrEqual(MAX_WEBHOOK_BODY_BYTES + chunk.byteLength * 2); // it stopped reading
    });

    it.each([
      ["a missing signature", null],
      ["an empty signature", ""],
      ["a malformed signature", "sha256=not-hex"],
      [
        "an uppercase-hex signature",
        sign(fixture("text-phone.json"))
          .replace(/[a-f]/g, (c) => c.toUpperCase())
          .replace("SHA256", "sha256"),
      ],
      [
        "a signature from another secret",
        sign(fixture("text-phone.json"), "some-other-secret-0123456789"),
      ],
    ])("returns 403 for %s and touches no storage", async (_name, signature) => {
      const res = await handleWebhookPost(webhookPost(body, { signature }), deps);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    });

    it("returns 403 when the signature covers different bytes than were sent (raw-byte rule, end to end)", async () => {
      const pretty = Buffer.from(JSON.stringify(JSON.parse(body.toString("utf8")), null, 2));
      const compact = Buffer.from(JSON.stringify(JSON.parse(body.toString("utf8"))));
      expect(pretty.equals(compact)).toBe(false);
      expect(
        (await handleWebhookPost(webhookPost(compact, { signature: sign(pretty) }), deps)).status,
      ).toBe(403);
      const literal = fixture("text-sinhala-raw-utf8.json");
      const escaped = fixture("text-sinhala-escaped.json");
      expect(
        (await handleWebhookPost(webhookPost(escaped, { signature: sign(literal) }), deps)).status,
      ).toBe(403);
      expect(
        (await handleWebhookPost(webhookPost(literal, { signature: sign(escaped) }), deps)).status,
      ).toBe(403);
    });

    it("refuses a body whose signature covers its compact RE-SERIALIZATION (the received bytes are what count)", async () => {
      const pretty = Buffer.from(JSON.stringify(JSON.parse(body.toString("utf8")), null, 2));
      const reserialized = Buffer.from(JSON.stringify(JSON.parse(pretty.toString("utf8"))));
      expect(pretty.equals(reserialized)).toBe(false);
      const res = await handleWebhookPost(
        webhookPost(pretty, { signature: sign(reserialized) }),
        deps,
      );
      expect(res.status).toBe(403);
      // the same holds for the Unicode spellings: a signature over the escaped form never validates the literal bytes
      const literal = fixture("text-sinhala-raw-utf8.json");
      const escaped = Buffer.from(
        literal
          .toString("utf8")
          .replace(
            /[\u0080-\uffff]/g,
            (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
          ),
      );
      expect(
        (await handleWebhookPost(webhookPost(literal, { signature: sign(escaped) }), deps)).status,
      ).toBe(403);
    });

    it("logs a refusal by reason code only: no body, signature, secret or header value", async () => {
      const signature = sign(body, "another-secret-0123456789");
      await handleWebhookPost(webhookPost(body, { signature }), deps);
      await handleWebhookPost(webhookPost(body, { signature: null }), deps);
      const output = lines.join("\n");
      expect(output).toContain("webhook.signature_invalid");
      expect(output).toContain("signature_mismatch");
      expect(output).toContain("missing_header");
      for (const forbidden of [
        signature,
        signature.slice(7),
        TEST_APP_SECRET,
        "Does the ICT class",
        "15550100123",
        "wamid.FAKE",
      ]) {
        expect(output, forbidden).not.toContain(forbidden);
      }
    });
  });
});
