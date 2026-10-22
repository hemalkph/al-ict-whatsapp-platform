import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateBotWorkerStart,
  gateBehaviour,
  readRuntimeGates,
  triggerCaptureEnabled,
} from "./config";

// Structural guards for the bot runtime core (Phase 08E-1, plan sections C, M and N.1). Decision helpers are pure;
// emitBotRuntimeLog intentionally writes logs and reads the clock through the shared logger. The source checks below do not
// prove transitive purity. The core reads no database, sends nothing, and models default-off gates.
// Later checkpoints (08E-2 and on) add files and change the file list below on purpose, as visible edits to this test.

const root = new URL(".", import.meta.url).pathname;
const repo = join(root, "../../..");
const read = (p: string) => readFileSync(p, "utf8");
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
// 08E-4: the files that reach the database, each ONLY through the SQL primitives of db/ops (no SQL text, driver or ORM here).
const OPS_IMPORTS: Record<string, readonly string[]> = {
  "trigger-queue.ts": ["@/db/ops/bot-trigger-queue", "@/db/ops/executor"],
  "apply.ts": ["@/db/ops/bot-session-store", "@/db/ops/bot-step"],
  "context.ts": ["@/db/ops/bot-step", "@/db/ops/executor"],
  "continue.ts": ["@/db/ops/bot-session-store", "@/db/ops/bot-step"],
  "flow-cache.ts": ["@/db/ops/bot-step", "@/db/ops/executor"],
  "outbound.ts": ["@/db/ops/bot-session-store", "@/db/ops/executor"],
  "start.ts": ["@/db/ops/bot-session-store", "@/db/ops/bot-step"],
  "step.ts": ["@/db/ops/bot-step", "@/db/ops/executor"],
};
const sources = readdirSync(root)
  .filter((f) => f.endsWith(".ts") && !/\.(db\.)?test\.ts$/.test(f) && f !== "testing.ts")
  .map((f) => ({ file: f, text: code(read(join(root, f))) }));
const walk = (dir: string): string[] =>
  (
    readdirSync(join(repo, dir), {
      recursive: true,
      withFileTypes: true,
    }) as import("node:fs").Dirent[]
  )
    .filter((d) => d.isFile() && /\.(m?[tj]sx?)$/.test(d.name))
    .map((d) => join(d.parentPath, d.name));

describe("bot runtime core boundaries (08E-1)", () => {
  it("has exactly the expected production files and no subdirectory", () => {
    expect(sources.map((s) => s.file).sort()).toEqual([
      "apply.ts",
      "backoff.ts",
      "config.ts",
      "context.ts",
      "continue.ts",
      "eligibility.ts",
      "flow-cache.ts",
      "index.ts",
      "input.ts",
      "log.ts",
      "outbound.ts",
      "policy.ts",
      "session-row.ts",
      "start.ts",
      "step.ts",
      "takeover.ts",
      "trigger-queue.ts",
    ]);
    const dirs = (readdirSync(root, { withFileTypes: true }) as import("node:fs").Dirent[]).filter(
      (d) => d.isDirectory(),
    );
    expect(dirs.map((d) => d.name)).toEqual([]);
  });

  it("reads no database and issues no SQL: no database, driver, ORM or query text (the files in OPS_IMPORTS excepted, see below)", () => {
    for (const { file, text } of sources.filter((s) => !(s.file in OPS_IMPORTS))) {
      expect(text, file).not.toMatch(
        /@\/db\b|drizzle|from "pg"|\bPool\b|\.execute\s*\(|\.transaction\s*\(/,
      );
      expect(text, file).not.toMatch(/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/);
    }
  });

  it("trigger-queue.ts (08E-3) is the one file that reaches the database, and only through the db/ops queue primitives", () => {
    const queue = sources.find((s) => s.file === "trigger-queue.ts")!.text;
    const specs = [...queue.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(specs.sort()).toEqual(
      ["./backoff", "./log", "./policy", "@/db/ops/bot-trigger-queue", "@/db/ops/executor"].sort(),
    );
    expect(queue).not.toMatch(/drizzle|from "pg"|\bPool\b|\.execute\s*\(|\.transaction\s*\(/);
    expect(queue).not.toMatch(/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/);
    // it is not part of the public index (the webhook worker imports the index), and nothing outside the module imports it
    expect(sources.find((s) => s.file === "index.ts")!.text).not.toMatch(/trigger-queue/);
    for (const f of [...walk("src"), ...walk("scripts")].filter(
      (p) =>
        !p.includes("/src/modules/bot-runtime/") &&
        !p.endsWith("/src/db/ops/bot-trigger-queue.ts") &&
        !p.endsWith("/src/db/ops/bot-step.ts") &&
        !p.endsWith("/src/db/ops/bot-session-store.ts") &&
        !/\.test\.ts$/.test(p),
    ))
      expect(read(f), f).not.toMatch(/bot-runtime\/trigger-queue|bot-trigger-queue/);
  });

  it("the 08E-4 step files reach the database only through db/ops primitives: no SQL text, driver, ORM or transaction call", () => {
    for (const [file, allowed] of Object.entries(OPS_IMPORTS)) {
      const text = sources.find((s) => s.file === file)!.text;
      expect(text, file).not.toMatch(
        /drizzle|from "pg"|\bPool\b|\.execute\s*\(|\.transaction\s*\(/,
      );
      expect(text, file).not.toMatch(/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/);
      for (const m of text.matchAll(/from\s+"(@\/db[^"]*)"/g))
        expect(allowed, `${file}: ${m[1]}`).toContain(m[1]);
    }
    // the step is not part of the public index and nothing outside the module imports it
    expect(sources.find((s) => s.file === "index.ts")!.text).not.toMatch(
      /step|apply|start|continue|outbound|flow-cache|context/,
    );
    for (const f of [...walk("src"), ...walk("scripts")].filter(
      (p) => !p.includes("/src/modules/bot-runtime/") && !/\.test\.ts$/.test(p),
    ))
      expect(read(f), f).not.toMatch(
        /bot-runtime\/(step|apply|start|continue|outbound|flow-cache|context)/,
      );
  });

  it("the step SQL never reads a transaction-start time, locks an outbound request, or waits for an advisory lock", () => {
    for (const f of ["src/db/ops/bot-step.ts", "src/db/ops/bot-session-store.ts"]) {
      const text = code(read(join(repo, f)));
      expect(text, f).not.toMatch(/\bnow\s*\(\s*\)|current_timestamp|transaction_timestamp/i);
      expect(text, f).not.toMatch(/pg_advisory_xact_lock\s*\(|pg_advisory_lock\s*\(/);
      expect(text, f).not.toMatch(/FROM outbound_requests[^;`]*FOR (UPDATE|SHARE)/i);
      expect(text, f).not.toMatch(/UPDATE outbound_requests|INSERT INTO outbound_requests/i);
      expect(text, f).not.toMatch(/bot-runtime|@\/modules\//);
    }
    const ops = code(read(join(repo, "src/db/ops/bot-step.ts")));
    expect(ops).toMatch(/pg_try_advisory_xact_lock/);
    // the lock order of K.1 is the order of these calls in the step
    const step = code(read(join(root, "step.ts")));
    const order = [
      "lockStepTrigger(",
      "tryAdvisoryLock(tx, conversationLockKey",
      "tryAdvisoryLock(tx, contactLockKey",
      "lockDeploymentsShare(",
      "lockConversation(",
      "lockLiveSession(",
      "lockAccountShare(",
      "await clockOf(deps)(tx);",
    ].map((n) => step.indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("enqueueAutomatedMessage has exactly one production importer in the runtime: outbound.ts, and it writes no request state", () => {
    const importers = sources
      .filter((s) => /enqueueAutomatedMessage/.test(s.text))
      .map((s) => s.file);
    expect(importers).toEqual(["outbound.ts"]);
    const out = sources.find((s) => s.file === "outbound.ts")!.text;
    const specs = [...out.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(specs.filter((x) => x.startsWith("@/modules/")).sort()).toEqual([
      "@/modules/bots",
      "@/modules/messaging/config",
      "@/modules/messaging/enqueue",
      "@/modules/messaging/errors",
    ]);
    for (const { file, text } of sources)
      expect(text, file).not.toMatch(
        /state\s*=\s*'(SENDING|ACCEPTED|REJECTED|UNKNOWN_OUTCOME|HELD|QUEUED)'/,
      );
  });

  it("the queue primitives never touch outbound requests, messages or any transport, and know no module", () => {
    const ops = code(read(join(repo, "src/db/ops/bot-trigger-queue.ts")));
    expect(ops).not.toMatch(
      /outbound_requests|\bmessages\b|@\/modules\/|fetch\s*\(|transport|Math\.random|process\./,
    );
    // the fence on every write to a claimed trigger names organization, id, PENDING and the exact claim token
    expect(ops).toMatch(/status = 'PENDING' AND claim_token = \$\{uuid\(f\.claimToken/);
    // nothing in the queue file holds a request or message row lock
    expect(ops).not.toMatch(/FROM bot_triggers[^;]*JOIN\s+outbound/);
  });

  it("sends nothing and reaches no one: no network, transport, outbound service, enqueue, inbox, inbound pipeline, admin services or UI", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /\bfetch\s*\(|undici|axios|graph\.facebook\.com|XMLHttpRequest|node:https?|node:net/,
      );
      expect(
        file === "outbound.ts"
          ? text.replace(/@\/modules\/messaging\/(config|enqueue|errors)"/g, '"')
          : text,
        file,
      ).not.toMatch(
        /@\/modules\/(messaging|bot-control|whatsapp|inbox|leads|access|auth)\b|@\/app\/|next\/|meta-transport|dispatchBatch|claimNext|executeClaim|authorizeSend|OutboundTransport/,
      );
      if (file !== "outbound.ts") expect(text, file).not.toMatch(/enqueueAutomatedMessage/);
    }
  });

  it("is pure: no clock read, randomness, timer, process access or environment (the gates take an explicit object)", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /Date\.now|new Date\s*\(\s*\)|performance\.now|Math\.random|crypto|randomUUID|getRandomValues/,
      );
      expect(text, file).not.toMatch(/setTimeout|setInterval|setImmediate|queueMicrotask/);
      expect(text, file).not.toMatch(/\bprocess\b|import\.meta\.env|\bconsole\./);
    }
  });

  it("imports only the bots module's approved pure surface, its own files and the shared logger", () => {
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        expect(
          spec.startsWith("./") ||
            spec === "@/modules/bots" ||
            (spec === "@/shared/logging/logger" && file === "log.ts") ||
            (spec.startsWith("@/db/ops/") && (OPS_IMPORTS[file] ?? []).includes(spec)) ||
            (file === "outbound.ts" &&
              ["config", "enqueue", "errors"].some((m) => spec === `@/modules/messaging/${m}`)),
          `${file}: ${spec}`,
        ).toBe(true);
      }
    }
  });

  it("only log.ts writes logs, and only through the fixed-field whitelist", () => {
    for (const { file, text } of sources)
      if (file !== "log.ts") expect(text, file).not.toMatch(/logger\b/);
    const log = sources.find((s) => s.file === "log.ts")!.text;
    expect(log).not.toMatch(/JSON\.stringify|\.\.\.\s*e\b|Object\.(assign|entries|keys)/); // no spreading of caller objects
  });

  it("has only the approved 08E-2 production callers for gates and capture logging", () => {
    const importers = [...walk("src"), ...walk("scripts")].filter(
      (f) =>
        !f.includes("/src/modules/bot-runtime/") &&
        /(from|import)\s*\(?\s*"[^"]*modules\/bot-runtime(\/[^"]*)?"/.test(read(f)),
    );
    expect(importers.map((f) => relative(repo, f)).sort()).toEqual([
      "src/modules/whatsapp/inbound/handler.ts",
      "src/modules/whatsapp/worker/registry.ts",
    ]);
    for (const f of importers) {
      const imports = [
        ...read(f).matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/modules\/bot-runtime"/g),
      ];
      expect(imports, f).toHaveLength(1);
      const names = imports[0]![1]!
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      expect(names, f).toEqual(
        f.endsWith("handler.ts")
          ? ["emitBotRuntimeLog"]
          : ["emitBotRuntimeLog", "triggerCaptureEnabled"],
      );
    }
  });

  it("no worker script, package script or environment example for the runtime exists yet (08E-7)", () => {
    const scripts = (
      JSON.parse(read(join(repo, "package.json"))) as { scripts: Record<string, string> }
    ).scripts;
    expect(Object.keys(scripts).filter((k) => /^bots:(worker|runtime)/.test(k))).toEqual([]);
    expect(readdirSync(join(repo, "scripts"))).not.toContain("bots-worker.ts");
  });

  it("the dispatcher and database ops do not know the runtime; inbound imports only at its approved capture boundaries", () => {
    for (const dir of ["src/modules/whatsapp", "src/modules/messaging", "src/db/ops"])
      for (const f of walk(dir).filter(
        (p) =>
          !/\.test\.ts$/.test(p) &&
          !p.endsWith("/inbound/handler.ts") &&
          !p.endsWith("/worker/registry.ts"),
      ))
        expect(read(f), f).not.toMatch(/bot-runtime/);
  });
});

describe("default-off is testable and holds", () => {
  it("an empty environment turns every modelled gate off, and nothing can reach Meta", () => {
    expect(readRuntimeGates({})).toEqual({
      botsRuntimeEnabled: false,
      outboundEnabled: false,
      liveSendEnabled: false,
    });
    expect(triggerCaptureEnabled({})).toBe(false);
    expect(evaluateBotWorkerStart({}).kind).toBe("refused");
    expect(gateBehaviour({ webhookWorker: {}, botWorker: {}, outboundWorker: {} })).toEqual({
      capturesTriggers: false,
      botWorkerStarts: false,
      outboundWorkerStarts: false,
      claimsBotRows: false,
      newBotMessagesCanReachMeta: false,
    });
  });

  it(".env.example documents the runtime gate as off", () => {
    const example = read(join(repo, ".env.example"));
    expect(example).toMatch(/^# BOTS_RUNTIME_ENABLED=false$/m);
    expect(example).not.toMatch(/^BOTS_RUNTIME_ENABLED=true/m);
  });
});
