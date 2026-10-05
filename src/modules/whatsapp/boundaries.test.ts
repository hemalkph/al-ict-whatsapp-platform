import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Structural fast-acknowledgement and module-boundary guards. The ingest path must stay: read bytes, verify, store,
// acknowledge. No HTTP/Graph client, no media, no domain handlers, no worker, no background work.

const root = new URL(".", import.meta.url).pathname;
const read = (path: string) => readFileSync(path, "utf8");
const sources = readdirSync(root)
  .filter(
    (f) =>
      f.endsWith(".ts") &&
      !f.endsWith(".test.ts") &&
      !f.endsWith(".db.test.ts") &&
      f !== "testing.ts",
  )
  .map((f) => ({ file: f, text: read(join(root, f)) }));
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"); // strip comments

describe("whatsapp module boundaries", () => {
  it("finds the module's production files", () => {
    expect(sources.map((s) => s.file).sort()).toEqual([
      "body.ts",
      "config.ts",
      "handler.ts",
      "idempotency.ts",
      "index.ts",
      "ingest.ts",
      "logging.ts",
      "normalize.ts",
      "parse.ts",
      "routing.ts",
      "sanitize.ts",
      "signature.ts",
      "verification.ts",
    ]);
  });

  it("exposes a narrow public API and the route imports nothing else", () => {
    expect(code(read(join(root, "index.ts"))).trim()).toBe(
      'export { handleWebhookGet, handleWebhookPost } from "./handler";',
    );
    const route = read(join(root, "../../app/api/webhooks/whatsapp/route.ts"));
    const imports = [...route.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports).toEqual(["@/modules/whatsapp"]);
    expect(code(route)).not.toMatch(/@\/db|process\.env|META_APP_SECRET|crypto|schema\./);
  });

  it("contains no HTTP or Graph client, no Meta call, no media code", () => {
    for (const { file, text } of sources) {
      const c = code(text);
      expect(c, file).not.toMatch(/\bfetch\s*\(/);
      expect(c, file).not.toMatch(
        /node:https?|undici|axios|node-fetch|XMLHttpRequest|node:net\b|node:tls/,
      );
      expect(c, file).not.toMatch(
        /graph\.facebook|developers\.facebook|lookaside|media[_-]?(id|url)|downloadMedia|storageKey/i,
      );
    }
  });

  it("does no background or deferred work (no timers, no after(), no worker, no queue claim)", () => {
    for (const { file, text } of sources) {
      const c = code(text);
      expect(c, file).not.toMatch(
        /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b|\bafter\s*\(/,
      );
      expect(c, file).not.toMatch(/next\/server|claimWebhookEvents|worker|processWebhook/i);
    }
  });

  it("creates no domain rows: it never touches contacts, conversations, messages, statuses, leads or aliases", () => {
    for (const { file, text } of sources) {
      expect(code(text), file).not.toMatch(
        /schema\.(contacts|contactConsents|contactBsuids|conversations|messages|messageStatusEvents|messageAttachments|leads|leadAttributions|tags|contactTags)\b/,
      );
    }
  });

  it("imports no authentication, authorization or session code (the webhook is not staff-authenticated)", () => {
    for (const { file, text } of sources) {
      expect(code(text), file).not.toMatch(
        /@\/modules\/(auth|access)|better-auth|requireAccess|getSession/,
      );
    }
  });

  it("verifies signatures over bytes only: no JSON, normalization, escaping or canonical form in the verifier", () => {
    const signature = code(sources.find((s) => s.file === "signature.ts")!.text);
    expect(signature).not.toMatch(/JSON\./);
    expect(signature).not.toMatch(
      /\.normalize\s*\(|escape|canonical|toWellFormed|TextDecoder|TextEncoder|toString\s*\(/i,
    );
    expect(signature).not.toMatch(/canonical-json/);
    expect(signature.match(/createHmac\s*\(/g)).toHaveLength(1); // exactly one computation, no second candidate
  });

  it("uses canonical JSON only to derive idempotency keys", () => {
    const users = sources
      .filter((s) => /canonical-json|canonicalJson/.test(code(s.text)))
      .map((s) => s.file);
    expect(users).toEqual(["idempotency.ts"]);
  });

  it("reads the request body only as raw bytes, never request.json() or request.text()", () => {
    for (const { file, text } of sources) {
      expect(code(text), file).not.toMatch(/\brequest\.(json|text|formData|blob|arrayBuffer)\s*\(/);
    }
    expect(code(sources.find((s) => s.file === "handler.ts")!.text)).toContain(
      "readBoundedBody(request.body)",
    );
  });

  it("never reads secrets outside config.ts", () => {
    for (const { file, text } of sources.filter((s) => s.file !== "config.ts")) {
      expect(code(text), file).not.toMatch(
        /process\.env|META_APP_SECRET|WHATSAPP_WEBHOOK_VERIFY_TOKEN/,
      );
    }
  });
});
