import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { newPromptToken, productionStepDeps } from "./compose";

// Structural guards for the bot worker (Phase 08E-7; plan J.1, M; review condition "production never injects a test hook").

const root = new URL(".", import.meta.url).pathname;
const repo = join(root, "../../..");
const read = (p: string) => readFileSync(p, "utf8");
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
const sources = readdirSync(root)
  .filter((f) => f.endsWith(".ts") && !/\.(db\.)?test\.ts$/.test(f) && f !== "testing.ts")
  .map((f) => ({ file: f, text: code(read(join(root, f))) }));
const script = code(read(join(repo, "scripts/bots-worker.ts")));
const walk = (dir: string): string[] =>
  (
    readdirSync(join(repo, dir), {
      recursive: true,
      withFileTypes: true,
    }) as import("node:fs").Dirent[]
  )
    .filter((d) => d.isFile() && /\.(m?[tj]sx?)$/.test(d.name))
    .map((d) => join(d.parentPath, d.name));

/** Every runtime test capability: hooks and their barrier points, clock overrides, SQL seams, mutation switches. */
const TEST_CAPABILITIES =
  /\bhooks\b|readClock|afterTriggerLock|afterAdvisoryLocks|afterRowLocks|afterDecisionClock|afterStartDecision|afterEnqueue|beforeCommit|lockSessionSuppressionCandidates|lockSuppressionCandidates|\bmutate\b|\bvi\.|\/testing"/;

describe("bot worker boundaries (08E-7)", () => {
  it("has exactly the expected production files and no subdirectory", () => {
    expect(sources.map((s) => s.file).sort()).toEqual([
      "compose.ts",
      "config.ts",
      "errors.ts",
      "index.ts",
      "loops.ts",
      "policy.ts",
      "run.ts",
      "schema.ts",
    ]);
    const dirs = (readdirSync(root, { withFileTypes: true }) as import("node:fs").Dirent[]).filter(
      (d) => d.isDirectory(),
    );
    // the only subdirectory holds the test-only child process of process.test.ts (never imported by production code)
    expect(dirs.map((d) => d.name)).toEqual(["__fixtures__"]);
    expect(readdirSync(join(root, "__fixtures__"))).toEqual(["shutdown-child.ts"]);
  });

  it("production composition injects NO test capability: no hooks, clock override, barrier, SQL seam or mutation switch", () => {
    for (const { file, text } of [...sources, { file: "scripts/bots-worker.ts", text: script }])
      expect(text, file).not.toMatch(TEST_CAPABILITIES);
    // the runtime's dependencies are exactly these four, with real token and randomness sources
    const deps = productionStepDeps({
      BOTS_RUNTIME_ENABLED: "true",
      WHATSAPP_OUTBOUND_ENABLED: "true",
    });
    expect(Object.keys(deps).sort()).toEqual(["config", "flows", "newPromptToken", "random"]);
    expect(deps.random).toBe(Math.random);
    const tokens = new Set(Array.from({ length: 50 }, () => deps.newPromptToken()));
    expect(tokens.size).toBe(50);
    for (const tkn of tokens) expect(tkn).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(deps.newPromptToken).toBe(newPromptToken);
    // the run options a production start can pass are the environment and the stop signal only
    expect(script).toMatch(/runBotWorker\(\{ env: process\.env, signal: controller\.signal \}\)/);
    expect(script.match(/runBotWorker\(/g)).toHaveLength(1);
    // run.ts builds the runtime deps ONLY through productionStepDeps and offers no option to replace them
    const run = sources.find((s) => s.file === "run.ts")!.text;
    expect(run).toMatch(/const stepDeps = productionStepDeps\(options\.env\);/);
    // the real wiring: T0 claims at most the loop's limit (the lane count), T1 is processTrigger with the production deps
    // (its own fenced T2 inside), the sweep is sweepOnce; nothing else reaches the trigger queue or a session
    expect(run).toMatch(/claim: \(limit\) => claimTriggers\(db, limit\),/);
    expect(run).toMatch(/process: \(claim\) => processTrigger\(db, claim, stepDeps\),/);
    expect(run).toMatch(/concurrency: config\.concurrency,/);
    expect(run).toMatch(/sweep: \(\) => sweepOnce\(db, stepDeps\)/);
    expect(run.match(/claimTriggers\(|processTrigger\(|sweepOnce\(/g)).toHaveLength(3);
    expect(run).not.toMatch(/recordTriggerFailure|terminalizeTrigger|reconcileSession/);
    expect(run).not.toMatch(/stepDeps\?|options\.stepDeps|options\.deps/);
  });

  it("never sends: no transport, Meta, HTTP, dispatcher, enqueue or submission code; no request write or row lock", () => {
    for (const { file, text } of [...sources, { file: "scripts/bots-worker.ts", text: script }]) {
      expect(text, file).not.toMatch(
        /\bfetch\s*\(|undici|axios|graph\.facebook\.com|XMLHttpRequest|node:https?|node:net|meta-transport|OutboundTransport|FakeTransport/,
      );
      expect(text, file).not.toMatch(
        /@\/modules\/messaging\/(dispatch|transport|meta-transport|enqueue|submit|interactive)|claimNext|executeClaim|dispatchBatch|enqueueAutomatedMessage|submitOutboundMessage/,
      );
      expect(text, file).not.toMatch(
        /\b(INSERT INTO|UPDATE|DELETE FROM)\b|FOR (UPDATE|SHARE)|outboundRequests/,
      );
      // outbound_requests is named only by the preflight: run.ts's table list and schema.ts's catalog reads
      const outsidePreflight =
        file === "run.ts"
          ? text.replace(/const REQUIRED_TABLES = \[[\s\S]*?\];/, "")
          : file === "schema.ts"
            ? ""
            : text;
      expect(outsidePreflight, file).not.toMatch(/outbound_requests/);
    }
  });

  it("schema.ts only READS the catalog, in a READ ONLY rolled-back transaction, and never executes catalog-derived text", () => {
    const schema = sources.find((s) => s.file === "schema.ts")!.text;
    // its one raw statement is its own constant timeout; no catalog text is ever spliced into SQL (F-1)
    expect(schema.match(/sql\.raw\(/g)).toHaveLength(1);
    expect(schema).toMatch(
      /sql\.raw\(`SET LOCAL statement_timeout = '\$\{CATALOG_READ_TIMEOUT\}'`\)/,
    );
    expect(schema).toMatch(/\{ accessMode: "read only" \}/);
    expect(schema).toMatch(/tx\.rollback\(\);/);
    const sets = schema.match(/\bSET\s+\S+\s+\S+/g) ?? [];
    expect(sets).toEqual(["SET LOCAL statement_timeout", "SET LOCAL search_path"]);
    expect(schema).not.toMatch(/\b(CREATE|ALTER|DROP|INSERT|DELETE|TRUNCATE|GRANT)\s/);
  });

  it("imports only approved modules: the runtime's public API and its four worker entry points, the messaging gate parser, the database pool", () => {
    for (const { file, text } of sources)
      for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        expect(
          spec.startsWith("./") ||
            spec === "node:crypto" ||
            spec === "drizzle-orm" ||
            spec === "@/db" ||
            spec === "@/db/ops/executor" ||
            spec === "@/db/schema/enums" ||
            spec === "@/modules/bot-runtime" ||
            ["flow-cache", "outbound", "context", "reconcile", "step", "trigger-queue"].some(
              (x) => spec === `@/modules/bot-runtime/${x}`,
            ) ||
            spec === "@/modules/messaging/config",
          `${file}: ${spec}`,
        ).toBe(true);
      }
  });

  it("is started only by its opt-in script: nothing in the app, other scripts or modules imports it; importing starts nothing", () => {
    const importers = [...walk("src"), ...walk("scripts")].filter(
      (f) =>
        !f.includes("/src/modules/bot-worker/") &&
        !/\.test\.ts$/.test(f) &&
        /modules\/bot-worker/.test(read(f)),
    );
    expect(importers.map((f) => relative(repo, f))).toEqual(["scripts/bots-worker.ts"]);
    // the module index only re-exports; it has no statement that runs at import
    const index = sources.find((s) => s.file === "index.ts")!.text.trim();
    for (const line of index.split("\n").filter((l) => l.trim() !== ""))
      expect(line, line).toMatch(/^(export\b|\s|\}|[A-Za-z_]+,?$)/);
    for (const { file, text } of sources.filter((s) => s.file !== "index.ts"))
      expect(text, file).not.toMatch(/^(runBotWorker|run\w*Loop)\(/m); // no top-level call
  });

  it("process.env is read only by the script; the module takes an explicit environment object", () => {
    for (const { file, text } of sources) expect(text, file).not.toMatch(/process\.env/);
    expect(script).toMatch(/process\.env/);
    // the script wires SIGTERM and SIGINT to the stop signal and crashes without a stack (a fixed log line)
    expect(script).toMatch(
      /for \(const signal of \["SIGTERM", "SIGINT"\] as const\) process\.on\(signal, \(\) => controller\.abort\(\)\);/,
    );
    expect(script).not.toMatch(/console\.(log|error)\(\s*(error|e|err)\b/);
  });

  it("the pool is the worker's own, with the J.6 session settings; nothing else in the code base passes them", () => {
    const run = sources.find((s) => s.file === "run.ts")!.text;
    expect(run).toMatch(/sessionSettings: SESSION_SETTINGS/);
    expect(run).toMatch(/applicationName: "al-ict-bots-worker"/);
    expect(run).toMatch(/maxConnections: poolSize\(config\.concurrency\)/);
    const users = [...walk("src"), ...walk("scripts")].filter(
      (f) =>
        !/\.test\.ts$/.test(f) &&
        !f.endsWith("/src/db/client.ts") &&
        /sessionSettings/.test(read(f)),
    );
    // 08F-1: the retention script bounds its own one-connection pool (lock and statement timeouts), never the worker's settings
    expect(users.map((f) => relative(repo, f)).sort()).toEqual([
      "scripts/bots-retention.ts",
      "src/modules/bot-worker/run.ts",
    ]);
    const retention = read(join(repo, "scripts/bots-retention.ts"));
    expect(retention).not.toMatch(/SESSION_SETTINGS|bot-worker|transaction_timeout/);
    expect(retention).toMatch(
      /sessionSettings: \{ lock_timeout: "5s", statement_timeout: "60s" \}/,
    );
  });
});
