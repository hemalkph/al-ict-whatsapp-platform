import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Structural guards for the STATUS handler. They pin the properties that make it safe (one transaction, account check and
// per-message lock before any write, scoping by the trusted event, no conversation/contact/consent/lead/message writes,
// no Meta call, nothing wired to production) so a refactor cannot silently remove them.

const root = new URL(".", import.meta.url).pathname;
const repo = join(root, "../../../..");
const read = (path: string) => readFileSync(path, "utf8");
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sources = readdirSync(root)
  .filter((f) => f.endsWith(".ts") && !/\.(db\.)?test\.ts$/.test(f) && f !== "testing.ts")
  .map((f) => ({ file: f, text: code(read(join(root, f))) }));
const source = (file: string) => sources.find((s) => s.file === file)!.text;
const ops = code(read(join(repo, "src/db/ops/message-status.ts")));
const all = [...sources, { file: "db/ops/message-status.ts", text: ops }];
const before = (text: string, a: string, b: string) => {
  const ia = text.indexOf(a);
  const ib = text.indexOf(b);
  expect(ia, a).toBeGreaterThanOrEqual(0);
  expect(ib, b).toBeGreaterThanOrEqual(0);
  expect(ia, `${a} must come before ${b}`).toBeLessThan(ib);
};

describe("status handler boundaries", () => {
  it("has exactly the expected production files", () => {
    expect(sources.map((s) => s.file).sort()).toEqual(["handler.ts", "index.ts", "status-map.ts"]);
  });

  it("makes no Meta/HTTP call, reads no environment or secret, runs no timers, imports no auth code", () => {
    for (const { file, text } of all) {
      expect(text, file).not.toMatch(/\bfetch\s*\(|node:https?|undici|axios|graph\.facebook/);
      expect(text, file).not.toMatch(/process\.env|META_APP_SECRET|credential/i);
      expect(text, file).not.toMatch(/\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/);
      expect(text, file).not.toMatch(/@\/modules\/(auth|access)|better-auth|next\/server/);
    }
  });

  it("sends nothing, creates no message, and runs no bot, downloader or outbound path", () => {
    for (const { file, text } of all) {
      expect(text, file).not.toMatch(
        /sendMessage|sendTemplate|chatbot|botEngine|bot-engine|downloadMedia|lookaside|graph\.facebook/i,
      );
      expect(text, file).not.toMatch(
        /direction:\s*"OUTBOUND"|insertInboundMessage|\.insert\(\s*messages\s*\)/,
      );
    }
  });

  it("touches no contact, conversation, lead, consent, tag or attribution", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /schema\.(contacts|conversations|leads|contactConsents|contactTags|tags|leadAttributions|contactBsuids)\b|resolveInboundContact|getOrCreateConversation|advanceInboundActivity|reopenIfNewer|insertAttributionOnce/,
      );
      expect(text, file).not.toMatch(
        /\b(INSERT INTO|UPDATE|DELETE FROM)\s+(contacts|conversations|leads|contact_consents|contact_tags|tags|lead_attributions|students)\b/i,
      );
      expect(text, file).not.toMatch(
        /lastInboundAt|lastMessageAt|lastOutboundAt|marketingConsent|resolvedAt/,
      );
    }
    // the Phase 02 operation writes only messages (cache) and message_status_events (history)
    expect(ops).not.toMatch(/conversations|contacts|lastInboundAt|lastMessageAt|consent/i);
  });

  it("never matches a message by recipient, phone or BSUID", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/recipient|waId|phone_e164|phoneE164|from_user_id|bsuid/i);
    }
  });

  it("opens no transaction of its own and uses no connection but the one it is given", () => {
    for (const { file, text } of all) {
      expect(text, file).not.toMatch(/getDb|new Pool|\bconnect\s*\(|\bBEGIN\b|\bCOMMIT\b/);
      expect(text, file).not.toMatch(/from\s+"pg"|from\s+"@\/db\/client"|\.transaction\s*\(/);
    }
  });

  it("never decides the event's final state: no completion, failure, hold, claim or PROCESSED anywhere", () => {
    for (const { file, text } of all) {
      expect(text, file).not.toMatch(
        /completeWebhookEvent|failWebhookEvent|deadWebhookEvent|holdWebhookEvent|claimWebhookEvent|webhookEvents\b|webhook_events\b/,
      );
      expect(text, file).not.toMatch(/PROCESSED|"IGNORED"|"UNROUTABLE"/);
    }
  });

  it("checks the account, then takes the per-message lock, BEFORE the single status write", () => {
    const handler = source("handler.ts");
    before(handler, "mapStatusEvent(", "account_not_active");
    before(handler, "account_not_active", "pg_advisory_xact_lock");
    before(handler, "pg_advisory_xact_lock", "recordMessageStatus(");
    expect(handler).toContain("wa-message:${org}:${accountId}:${status.wamid}");
    expect(handler.match(/recordMessageStatus\(/g)).toHaveLength(1);
    expect(handler).toContain("webhookEventId: event.id");
  });

  it("takes the organization and account only from the trusted event, never from the payload", () => {
    const handler = source("handler.ts");
    expect(handler).toContain("const org = event.organizationId");
    expect(handler).toContain("const accountId = event.whatsappAccountId");
    expect(handler).not.toMatch(/payload\.(organization|org)|organization_id/i);
    expect(source("status-map.ts")).not.toMatch(/organization|account/i);
    expect(handler).toMatch(/eq\(schema\.whatsappAccounts\.organizationId, org\)/);
  });

  it("scopes every lookup and write of the Phase 02 operation by organization and account, and applies the cache only to outbound messages", () => {
    const record = ops.slice(ops.indexOf("export async function recordMessageStatus"));
    expect(record).toMatch(/eq\(messages\.organizationId, input\.organizationId\)/);
    expect(record).toMatch(/eq\(messages\.whatsappAccountId, input\.whatsappAccountId\)/);
    expect(record).toMatch(/eq\(messages\.wamid, input\.wamid\)/);
    expect(record).toContain('message.direction !== "OUTBOUND"');
    expect(record).toContain("messageId = message && !inboundMatch ? message.id : null");
    expect(record).toContain(".onConflictDoNothing()");
    expect(record).toContain("messageId ? await applyToMessage(tx, messageId, input) : false");
    // the cache moves only when the new priority is strictly higher
    expect(ops).toMatch(
      /priorityCase\(sql\.raw\("'" \+ e\.status \+ "'"\)\)\} > \$\{priorityCase\(messages\.latestStatus\)/,
    );
    const resolve = ops.slice(ops.indexOf("export async function resolveStatusEventsForMessage"));
    expect(resolve).toContain('owner?.direction !== "OUTBOUND"');
    expect(resolve).toMatch(/eq\(messageStatusEvents\.organizationId, message\.organizationId\)/);
    expect(resolve).toMatch(
      /eq\(messageStatusEvents\.whatsappAccountId, message\.whatsappAccountId\)/,
    );
  });

  it("keeps the provider timestamp as sent and logs only fixed fields", () => {
    const handler = source("handler.ts");
    expect(handler).toContain("occurredAt: status.occurredAt");
    expect(source("status-map.ts")).not.toMatch(/Math\.(min|max)|clamp|effectiveActivityTime/);
    expect(handler).not.toMatch(/console\./);
    expect(handler.match(/emitWebhookLog\(/g)).toHaveLength(2);
    // each log call carries only fixed fields: no wamid, error text or code
    for (const call of handler.split("emitWebhookLog(").slice(1))
      expect(call.slice(0, call.indexOf(");"))).not.toMatch(/wamid|error|payload|recipient/i);
  });

  it("is registered by name only: no default registry, not wired to any worker, route or other module", () => {
    expect(source("handler.ts")).toContain(
      "export const statusHandlers: WebhookHandlerRegistry = { STATUS: handleMessageStatus }",
    );
    const top = readdirSync(join(root, "..")).filter(
      (f) => f.endsWith(".ts") && !/test|testing/.test(f),
    );
    for (const f of top)
      expect(read(join(root, "..", f)), f).not.toMatch(/status\/|from\s+"\.\/status/);
    for (const dir of ["queue", "identity", "inbound"]) {
      const files = readdirSync(join(root, "..", dir)).filter(
        (f) => f.endsWith(".ts") && !/test|testing/.test(f),
      );
      for (const f of files)
        expect(read(join(root, "..", dir, f)), `${dir}/${f}`).not.toMatch(
          /\.\.\/status|whatsapp\/status/,
        );
    }
    const app = (readdirSync(join(repo, "src/app"), { recursive: true }) as string[]).filter((f) =>
      /\.tsx?$/.test(f),
    );
    for (const f of app) expect(read(join(repo, "src/app", f)), f).not.toMatch(/whatsapp\/status/);
    const pkg = JSON.parse(read(join(repo, "package.json"))) as { scripts: Record<string, string> };
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(name, name).not.toMatch(/worker/i);
      expect(command, name).not.toMatch(/worker|status\/handler/i);
    }
  });

  it("does not interpret identity-change data", () => {
    for (const { file, text } of all) {
      expect(text, file).not.toMatch(/previous_user_id|user_id_update|user_changed/);
    }
  });
});
