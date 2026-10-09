import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Structural guards for the inbound MESSAGE handler and its database operations. They pin the properties that make it safe
// (one transaction, check-before-write, scoping, no leads/consent, no Meta call, nothing wired to production) so a
// refactor cannot silently remove them.

const root = new URL(".", import.meta.url).pathname;
const repo = join(root, "../../../..");
const read = (path: string) => readFileSync(path, "utf8");
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sources = readdirSync(root)
  .filter((f) => f.endsWith(".ts") && !/\.(db\.)?test\.ts$/.test(f) && f !== "testing.ts")
  .map((f) => ({ file: f, text: code(read(join(root, f))) }));
const source = (file: string) => sources.find((s) => s.file === file)!.text;
const ops = code(read(join(repo, "src/db/ops/inbound-message.ts")));
const all = [...sources, { file: "db/ops/inbound-message.ts", text: ops }];
const before = (text: string, a: string, b: string) => {
  const ia = text.indexOf(a);
  const ib = text.indexOf(b);
  expect(ia, a).toBeGreaterThanOrEqual(0);
  expect(ib, b).toBeGreaterThanOrEqual(0);
  expect(ia, `${a} must come before ${b}`).toBeLessThan(ib);
};

describe("inbound message handler boundaries", () => {
  it("has exactly the expected production files", () => {
    expect(sources.map((s) => s.file).sort()).toEqual(["handler.ts", "index.ts", "message-map.ts"]);
  });

  it("makes no Meta/HTTP call, reads no environment or secret, runs no timers, imports no auth code", () => {
    for (const { file, text } of all) {
      expect(text, file).not.toMatch(/\bfetch\s*\(|node:https?|undici|axios|graph\.facebook/);
      expect(text, file).not.toMatch(/process\.env|META_APP_SECRET|credential/i);
      expect(text, file).not.toMatch(/\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/);
      expect(text, file).not.toMatch(/@\/modules\/(auth|access)|better-auth|next\/server/);
    }
  });

  it("sends nothing and runs no bot, downloader or outbound path", () => {
    for (const { file, text } of all) {
      expect(text, file).not.toMatch(
        /sendMessage|sendTemplate|chatbot|botEngine|bot-engine|downloadMedia|lookaside|graph\.facebook/i,
      );
      expect(text, file).not.toMatch(/direction:\s*"OUTBOUND"/);
    }
  });

  it("creates no lead, student, consent, tag or message status", () => {
    for (const { file, text } of all) {
      expect(text, file).not.toMatch(
        /schema\.(leads|contactConsents|contactTags|tags|messageStatusEvents)\b|\b(INSERT INTO|UPDATE)\s+(leads|contact_consents|contact_tags|tags|message_status_events|students)\b/i,
      );
      expect(text, file).not.toMatch(/marketingConsent|leadId:\s*[^n]/);
    }
    expect(ops).toMatch(/INSERT INTO lead_attributions[\s\S]*?\bNULL\b/); // lead_id is NULL
  });

  it("opens no transaction of its own and uses no connection but the one it is given (one savepoint, nothing else)", () => {
    for (const { file, text } of all) {
      expect(text, file).not.toMatch(/getDb|new Pool|\bconnect\s*\(|\bBEGIN\b|\bCOMMIT\b/);
      expect(text, file).not.toMatch(/from\s+"pg"|from\s+"@\/db\/client"/);
    }
    expect(source("handler.ts").match(/\.transaction\s*\(/g)).toHaveLength(1); // the savepoint inside the worker's transaction
    expect(ops).not.toMatch(/\.transaction\s*\(/);
    expect(source("handler.ts")).toContain("await tx.transaction(async (sp)");
  });

  it("never decides the event's final state: no completion, failure, hold, claim or PROCESSED anywhere", () => {
    for (const { file, text } of all) {
      expect(text, file).not.toMatch(
        /completeWebhookEvent|failWebhookEvent|deadWebhookEvent|holdWebhookEvent|claimWebhookEvent|webhookEvents\b|webhook_events\b/,
      );
      expect(text, file).not.toMatch(/PROCESSED|"IGNORED"|"UNROUTABLE"/);
    }
  });

  it("checks for the message BEFORE any write, under a per-message lock, and changes derived state only after the insert", () => {
    const handler = source("handler.ts");
    before(handler, "pg_advisory_xact_lock", "findMessageId(");
    before(handler, "findMessageId(", "resolveInboundContact(");
    before(handler, "resolveInboundContact(", "getOrCreateConversation(");
    before(handler, "getOrCreateConversation(", "insertInboundMessage(");
    before(handler, "insertInboundMessage(", "advanceInboundActivity(");
    before(handler, "advanceInboundActivity(", "reopenIfNewer(");
    before(handler, "insertInboundMessage(", "insertPendingAttachment(");
    before(handler, "insertInboundMessage(", "backResolveReplies(");
    before(handler, "insertInboundMessage(", "insertAttributionOnce(");
    expect(handler).toContain("if (!messageId) throw new DuplicateMessage()");
    expect(handler).toContain("wa-message:${org}:${accountId}:${message.wamid}");
  });

  it("uses the shared effective-time function for derived activity and never rewrites the provider time", () => {
    const handler = source("handler.ts");
    expect(handler).toContain("effectiveActivityTime(message.occurredAt, event.receivedAt)");
    expect(handler).toContain("occurredAt: message.occurredAt"); // stored as sent
    expect(handler).toContain("effectiveAt"); // used for conversation activity
    expect(source("message-map.ts")).not.toMatch(/Math\.(min|max)|clamp/);
  });

  it("takes the organization only from the trusted event and scopes every statement by it", () => {
    const handler = source("handler.ts");
    expect(handler).toContain("const org = event.organizationId");
    expect(handler).not.toMatch(/payload\.(organization|org)/i);
    // every exported primitive names organization_id/organizationId
    for (const part of ops.split("export async function").slice(1)) {
      const name = part.slice(0, part.indexOf("(")).trim();
      expect(part, name).toMatch(/organizationId|organization_id/);
    }
    expect(ops).not.toMatch(/\.delete\(/);
  });

  it("changes a conversation's status only by the single reopen statement (RESOLVED to OPEN, only status and resolved_at)", () => {
    expect(ops.match(/\bstatus:\s*"/g)).toEqual(['status: "']); // only the reopen sets a conversation status
    expect(ops).toContain('status: "OPEN", resolvedAt: null');
    expect(ops).toMatch(/eq\(conversations\.status,\s*"RESOLVED"\)/);
    expect(ops).toContain('storageStatus: "PENDING"');
    expect(ops).not.toMatch(/storageStatus:\s*"(FAILED|STORED|EXPIRED)"/);
  });

  it("is registered by name only: no default registry, not wired to any worker, route or other module", () => {
    expect(source("handler.ts")).toContain(
      "export const inboundMessageHandlers: WebhookHandlerRegistry = { MESSAGE: handleInboundMessage }",
    );
    const top = readdirSync(join(root, "..")).filter(
      (f) => f.endsWith(".ts") && !/test|testing/.test(f),
    );
    for (const f of top)
      expect(read(join(root, "..", f)), f).not.toMatch(/inbound\/|from\s+"\.\/inbound/);
    for (const dir of ["queue", "identity"]) {
      const files = readdirSync(join(root, "..", dir)).filter(
        (f) => f.endsWith(".ts") && !/test|testing/.test(f),
      );
      for (const f of files)
        expect(read(join(root, "..", dir, f)), `${dir}/${f}`).not.toMatch(
          /\.\.\/inbound|whatsapp\/inbound/,
        );
    }
    const app = (readdirSync(join(repo, "src/app"), { recursive: true }) as string[]).filter((f) =>
      /\.tsx?$/.test(f),
    );
    for (const f of app) expect(read(join(repo, "src/app", f)), f).not.toMatch(/whatsapp\/inbound/);
    const pkg = JSON.parse(read(join(repo, "package.json"))) as { scripts: Record<string, string> };
    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (name === "whatsapp:worker") continue; // the opt-in worker script (its own boundary test pins it)
      expect(name, name).not.toMatch(/worker/i);
      expect(command, name).not.toMatch(/worker|inbound/i);
    }
  });

  it("does not interpret identity-change or status data", () => {
    for (const { file, text } of all) {
      expect(text, file).not.toMatch(
        /previous_user_id|user_id_update|user_changed|recordMessageStatus|statuses\b/,
      );
    }
  });
});
