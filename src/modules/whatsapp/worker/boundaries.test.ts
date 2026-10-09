import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Structural guards for the standalone worker: it is opt-in, makes no Meta call, writes no domain data itself, runs only
// the two real handlers, and is started by exactly one script that nothing else invokes.

const root = new URL(".", import.meta.url).pathname;
const repo = join(root, "../../../..");
const read = (path: string) => readFileSync(path, "utf8");
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sources = readdirSync(root)
  .filter((f) => f.endsWith(".ts") && !/\.(db\.)?test\.ts$/.test(f) && f !== "testing.ts")
  .map((f) => ({ file: f, text: code(read(join(root, f))) }));
const source = (file: string) => sources.find((s) => s.file === file)!.text;
const script = code(read(join(repo, "scripts/whatsapp-worker.ts")));

const walk = (dir: string): string[] =>
  (
    readdirSync(join(repo, dir), {
      recursive: true,
      withFileTypes: true,
    }) as import("node:fs").Dirent[]
  )
    .filter((d) => d.isFile() && /\.(m?[tj]sx?|json|ya?ml)$/.test(d.name))
    .map((d) => relative(repo, join(d.parentPath, d.name)))
    .filter((f) => !/node_modules|\.next\//.test(f));

describe("worker boundaries", () => {
  it("has exactly the expected production files", () => {
    expect(sources.map((s) => s.file).sort()).toEqual([
      "config.ts",
      "errors.ts",
      "index.ts",
      "loop.ts",
      "policy.ts",
      "registry.ts",
      "run.ts",
    ]);
  });

  it("makes no Meta/HTTP call, reads no Meta credential, and does not read process.env itself", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\bfetch\s*\(|node:https?|undici|axios|graph\.facebook/);
      expect(text, file).not.toMatch(/META_APP_SECRET|VERIFY_TOKEN|ACCESS_TOKEN|credential_ref/i);
      expect(text, file).not.toMatch(/process\.env/); // the environment arrives as an argument
      expect(text, file).not.toMatch(/@\/modules\/(auth|access)|better-auth|next\/server/);
    }
    expect(script).not.toMatch(/META_APP_SECRET|ACCESS_TOKEN|fetch\s*\(/);
  });

  it("writes nothing itself: no INSERT/UPDATE/DELETE/DDL, no migration, no domain table, no account change", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b\s/);
      expect(text, file).not.toMatch(/\.(insert|update|delete)\s*\(/);
      expect(text, file).not.toMatch(/migrat/i);
      expect(text, file).not.toMatch(/schema\.(?!WEBHOOK_EVENT)/); // no table access at all
    }
    expect(source("run.ts")).toContain("SELECT 1");
  });

  it("never completes, fails, holds, requeues or activates anything: that is the queue's and the operator's business", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /completeWebhookEvent|failWebhookEvent|deadWebhookEvent|holdWebhookEvent|claimWebhookEvent|requeue|activate|replay/i,
      );
    }
    // the only queue entry points it uses
    expect(source("run.ts")).toContain("processWebhookBatch(db");
    expect(source("run.ts")).toContain("readQueueStats(");
  });

  it("registers exactly MESSAGE and STATUS, by name: no default, no no-op, no IDENTITY or OTHER", () => {
    const registry = source("registry.ts");
    expect(registry).toMatch(
      /Object\.freeze\(\{\s*MESSAGE:\s*handleInboundMessage,\s*STATUS:\s*handleMessageStatus,?\s*\}\)/,
    );
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /IDENTITY|\bOTHER\b|noop|no-op|NOOP|async\s*\(\)\s*=>\s*(undefined|\{\s*\})/,
      );
    }
    // the registry is the only source of handlers for the real run
    expect(source("run.ts")).toContain("options.handlers ?? webhookWorkerHandlers");
    expect(source("run.ts")).not.toMatch(/handleInboundMessage|handleMessageStatus/);
    expect(script).not.toMatch(/handlers|createDatabase|sleep/); // the script cannot override anything
  });

  it("is opt-in: nothing is opened or claimed before the enablement check, and the flag is exactly 'true'", () => {
    const run = source("run.ts");
    const check = run.indexOf("readWorkerConfig(options.env)");
    expect(check).toBeGreaterThan(0);
    expect(run.indexOf('read.kind === "disabled"')).toBeGreaterThan(check);
    for (const later of [
      "createDatabase",
      "processWebhookBatch(",
      'emitWebhookLog({ event: "worker.started"',
    ])
      expect(run.indexOf(later, run.indexOf('read.kind === "invalid"')), later).toBeGreaterThan(
        check,
      );
    // the disabled and invalid branches return before any of them
    const disabled = run.slice(
      run.indexOf('read.kind === "disabled"'),
      run.indexOf("const { config } = read"),
    );
    expect(disabled).toContain("return EXIT_REFUSED");
    expect(disabled).not.toMatch(/createDatabase|database|processWebhookBatch/);
    expect(source("config.ts")).toContain('flag === undefined || flag === "" || flag === "false"');
    expect(source("config.ts")).toContain('flag !== "true"');
  });

  it("uses a bounded, owned pool and never loops without a wait or a stop check", () => {
    const client = code(read(join(repo, "src/db/client.ts")));
    const worker = client.slice(client.indexOf("export function createWorkerDatabase"));
    expect(worker).toContain("connectionTimeoutMillis");
    expect(worker).toContain("max: options.maxConnections");
    expect(worker).toContain('pool.on("error"');
    expect(worker).toContain('pool.on("connect"');
    expect(worker).toContain("new WorkerPool(");
    expect(client).toContain("super.connect().then(releaseWhenConnectionEnds)"); // drizzle begin-outside-try leak guard
    expect(source("run.ts")).toContain("maxConnections: config.concurrency + 2");
    for (const { file, text } of sources)
      expect(text, file).not.toMatch(/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)|setInterval/);
    const loop = source("loop.ts");
    expect(loop).toContain("while (!signal.aborted)");
    expect(loop).toContain("deps.sleep(idleDelayMs(");
    expect(loop).toContain("deps.sleep(outageDelayMs(");
    // every batch is told when to stop claiming
    expect(source("run.ts")).toContain("stopSignal: signal");
    expect(code(read(join(root, "../queue/process.ts")))).toContain(
      "while (budget > 0 && !options.stopSignal?.aborted)",
    );
  });

  it("logs only through the fixed-field logger and never the database URL", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/logger\.|console\.(log|info|warn|debug)/);
      if (file !== "run.ts") expect(text, file).not.toMatch(/databaseUrl(?!\s*:)/);
    }
    // the only direct output is the explanatory refusal message, which is built from fixed text and configuration KEY names
    expect(source("run.ts").match(/console\./g)).toEqual(["console."]);
    expect(source("run.ts")).toContain("console.error(message)");
    expect(source("run.ts").match(/databaseUrl/g)).toHaveLength(1); // handed to the pool factory, nowhere else
    expect(script).not.toMatch(/DATABASE_URL|console\.log/);
  });

  it("is started only by scripts/whatsapp-worker.ts, which only wires signals", () => {
    const importers = [...walk("src"), ...walk("scripts"), ...walk("e2e")]
      .filter((f) => !/\.test\.ts$/.test(f) && !/(^|\/)testing\.ts$/.test(f))
      .filter((f) => !f.startsWith("src/modules/whatsapp/worker/"))
      .filter((f) => /whatsapp\/worker|\.\/worker/.test(read(join(repo, f))));
    expect(importers).toEqual(["scripts/whatsapp-worker.ts"]);
    expect(script).toContain("process.on(signal, () => controller.abort())");
    expect(script).toMatch(/\["SIGTERM", "SIGINT"\]/);
    expect(script.match(/runWorker\(/g)).toHaveLength(1);
    expect(code(read(join(root, "../index.ts"))).trim()).toBe(
      'export { handleWebhookGet, handleWebhookPost } from "./handler";',
    );
  });

  it("is not run automatically: one explicit command, no lifecycle hook, no cron, no instrumentation, no route", () => {
    const pkg = JSON.parse(read(join(repo, "package.json"))) as { scripts: Record<string, string> };
    expect(
      Object.entries(pkg.scripts).filter(([n, c]) => /worker/i.test(n) || /worker/i.test(c)),
    ).toEqual([
      ["whatsapp:worker", "tsx --env-file-if-exists=.env.local scripts/whatsapp-worker.ts"],
    ]);
    for (const hook of [
      "preinstall",
      "install",
      "postinstall",
      "prepare",
      "prebuild",
      "postbuild",
      "predev",
      "prestart",
      "pretest",
      "posttest",
      "predb:migrate",
      "postdb:migrate",
    ])
      expect(pkg.scripts[hook], hook).toBeUndefined();
    for (const f of [
      "vercel.json",
      "src/instrumentation.ts",
      "instrumentation.ts",
      "src/instrumentation-client.ts",
    ])
      expect(existsSync(join(repo, f)), f).toBe(false);
    const appFiles = walk("src/app");
    expect(appFiles.filter((f) => /cron/i.test(f))).toEqual([]);
    for (const f of [...appFiles, "src/proxy.ts"])
      expect(read(join(repo, f)), f).not.toMatch(/whatsapp\/worker|runWorker|processWebhookBatch/);
    for (const f of readdirSync(join(repo, "scripts")).filter((f) => /^e2e.*\.ts$/.test(f)))
      expect(read(join(repo, "scripts", f)), f).not.toMatch(/whatsapp-worker|runWorker/);
    for (const f of readdirSync(join(repo, ".github/workflows")))
      expect(read(join(repo, ".github/workflows", f)), f).not.toMatch(
        /whatsapp:worker|WHATSAPP_WORKER_ENABLED/,
      );
  });
});
