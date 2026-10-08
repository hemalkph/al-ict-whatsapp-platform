import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Structural guards for the queue/worker core. It is infrastructure only: no domain handlers, no Meta client, no
// executable worker, no default handlers.

const root = new URL(".", import.meta.url).pathname;
const repo = join(root, "../../../..");
const read = (path: string) => readFileSync(path, "utf8");
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sources = readdirSync(root)
  .filter((f) => f.endsWith(".ts") && !/\.(db\.)?test\.ts$/.test(f) && f !== "testing.ts")
  .map((f) => ({ file: f, text: code(read(join(root, f))) }));
const source = (file: string) => sources.find((s) => s.file === file)!.text;

describe("queue core boundaries", () => {
  it("has exactly the expected production files", () => {
    expect(sources.map((s) => s.file).sort()).toEqual([
      "errors.ts",
      "index.ts",
      "policy.ts",
      "process.ts",
      "requeue.ts",
      "stats.ts",
      "timeout.ts",
    ]);
  });

  it("implements no domain logic: no contacts, conversations, messages, statuses, leads or aliases", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /schema\.(contacts|contactConsents|contactBsuids|conversations|messages|messageStatusEvents|messageAttachments|leads|leadAttributions|tags|contactTags)\b/,
      );
    }
  });

  it("makes no Meta/HTTP call and reads no environment, secret or credential", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\bfetch\s*\(|node:https?|undici|axios|graph\.facebook/);
      expect(text, file).not.toMatch(/process\.env|META_APP_SECRET|credential/i);
      expect(text, file).not.toMatch(/@\/modules\/(auth|access)|better-auth|next\/server/);
    }
  });

  it("runs no daemon: no polling loop, no signal handling, no process exit, timers only in the deadline helper", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /\bsetInterval\b|\bsetImmediate\b|process\.(on|once|exit|kill)\b/,
      );
      expect(text, file).not.toMatch(/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/);
      if (file !== "timeout.ts") expect(text, file).not.toMatch(/\bsetTimeout\b/);
    }
  });

  it("has no default handler registry and no no-op handler: the registry is a required argument", () => {
    const process = source("process.ts");
    expect(process).toMatch(/\n\s*handlers: WebhookHandlerRegistry;/);
    expect(process).not.toMatch(/handlers\??:\s*WebhookHandlerRegistry\s*=|handlers\s*=\s*\{/);
    for (const { file, text } of sources)
      expect(text, file).not.toMatch(/noop|no-op|NOOP|defaultHandlers|DEFAULT_HANDLERS/);
  });

  it("completes the event inside the SAME transaction the handler writes through, never on the outer connection", () => {
    const process = source("process.ts");
    expect(process).toContain("completeWebhookEvent(tx, fence)");
    expect(process).not.toMatch(/completeWebhookEvent\(db\b/);
    expect(process).toContain("handler(tx, handlerEvent, context)");
  });

  it("finds a held event's phone number only through the envelope helper", () => {
    const requeue = source("requeue.ts");
    expect(requeue).toContain("payloadPhoneNumberId(");
    expect(requeue).not.toMatch(/'\{metadata|->>?\s*'|payload\s*->|\.metadata/);
  });

  it("never takes an organization from the caller, and a routed requeue never writes routing columns", () => {
    const requeue = source("requeue.ts");
    expect(requeue).not.toMatch(/organizationId\s*[:?]\s*string/);
    // routed events: the update sets queue state only (the shared `released` object), never organization/account
    expect(requeue.match(/\.set\(released\)/g)).toHaveLength(1);
    // routed events must already carry exactly the account's organization (compared, never assigned)
    expect(requeue).toContain("eq(schema.webhookEvents.organizationId, account.organizationId)");
    // unrouted events: routing comes from the verified target account row, in exactly one place
    expect(requeue.match(/organizationId:\s*account\.organizationId/g)).toHaveLength(1);
    expect(requeue).toMatch(
      /\.set\(\{\s*\.\.\.released,\s*organizationId:\s*account\.organizationId,\s*whatsappAccountId:\s*account\.id/,
    );
  });

  it("treats account ownership as immutable: no production code updates whatsapp_accounts", () => {
    const srcRoot = join(repo, "src");
    const files = (readdirSync(srcRoot, { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => !/(\.test\.tsx?$|(^|\/)testing\.ts$|__tests__|(^|\/)migrations\/)/.test(f))
      .map((f) => ({ file: f, text: code(read(join(srcRoot, f))) }));
    const scripts = readdirSync(join(repo, "scripts"))
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => ({ file: `scripts/${f}`, text: code(read(join(repo, "scripts", f))) }));
    expect(files.length).toBeGreaterThan(20); // the scan really covers the application
    for (const { file, text } of [...files, ...scripts]) {
      expect(text, file).not.toMatch(/update\(\s*(schema\.)?whatsappAccounts\s*\)/);
      expect(text, file).not.toMatch(/UPDATE\s+("?public"?\.)?"?whatsapp_accounts"?/i);
    }
  });

  it("is not wired into the application: no worker command, no route, not re-exported by the public API", () => {
    const pkg = JSON.parse(read(join(repo, "package.json"))) as { scripts: Record<string, string> };
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(name, name).not.toMatch(/worker|queue/i);
      expect(command, name).not.toMatch(/worker|queue/i);
    }
    expect(readdirSync(join(repo, "scripts")).filter((f) => /worker|queue/i.test(f))).toEqual([]);
    for (const dir of ["src/app", "src/proxy.ts"]) {
      const target = join(repo, dir);
      if (!existsSync(target)) continue;
      const files = dir.endsWith(".ts")
        ? [target]
        : (readdirSync(target, { recursive: true }) as string[])
            .filter((f) => /\.tsx?$/.test(f))
            .map((f) => join(target, f));
      for (const file of files)
        expect(read(file), file).not.toMatch(/whatsapp\/queue|webhook-queue/);
    }
    expect(code(read(join(root, "../index.ts"))).trim()).toBe(
      'export { handleWebhookGet, handleWebhookPost } from "./handler";',
    );
  });
});
