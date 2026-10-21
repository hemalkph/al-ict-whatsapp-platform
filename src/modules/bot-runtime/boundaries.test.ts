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
// prove transitive purity. The core reads no database, sends nothing, has no production caller, and models default-off gates.
// Later checkpoints (08E-2 and on) add files and change the file list below on purpose, as visible edits to this test.

const root = new URL(".", import.meta.url).pathname;
const repo = join(root, "../../..");
const read = (p: string) => readFileSync(p, "utf8");
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
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
      "backoff.ts",
      "config.ts",
      "eligibility.ts",
      "index.ts",
      "input.ts",
      "log.ts",
      "policy.ts",
      "session-row.ts",
      "takeover.ts",
    ]);
    const dirs = (readdirSync(root, { withFileTypes: true }) as import("node:fs").Dirent[]).filter(
      (d) => d.isDirectory(),
    );
    expect(dirs.map((d) => d.name)).toEqual([]);
  });

  it("reads no database and issues no SQL: no database, driver, ORM or query text", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /@\/db\b|drizzle|from "pg"|\bPool\b|\.execute\s*\(|\.transaction\s*\(/,
      );
      expect(text, file).not.toMatch(/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/);
    }
  });

  it("sends nothing and reaches no one: no network, transport, outbound service, enqueue, inbox, inbound pipeline, admin services or UI", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /\bfetch\s*\(|undici|axios|graph\.facebook\.com|XMLHttpRequest|node:https?|node:net/,
      );
      expect(text, file).not.toMatch(
        /@\/modules\/(messaging|bot-control|whatsapp|inbox|leads|access|auth)\b|@\/app\/|next\/|enqueueAutomatedMessage|meta-transport|dispatchBatch|claimNext|executeClaim|authorizeSend|OutboundTransport/,
      );
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
            (spec === "@/shared/logging/logger" && file === "log.ts"),
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

  it("has NO production caller: nothing outside the module imports it yet (tests excepted)", () => {
    const importers = [...walk("src"), ...walk("scripts")].filter(
      (f) =>
        !f.includes("/src/modules/bot-runtime/") &&
        /(from|import)\s*\(?\s*"[^"]*modules\/bot-runtime(\/[^"]*)?"/.test(read(f)),
    );
    expect(importers.map((f) => relative(repo, f))).toEqual([]);
  });

  it("no worker script, package script or environment example for the runtime exists yet (08E-7)", () => {
    const scripts = (
      JSON.parse(read(join(repo, "package.json"))) as { scripts: Record<string, string> }
    ).scripts;
    expect(Object.keys(scripts).filter((k) => /^bots:(worker|runtime)/.test(k))).toEqual([]);
    expect(readdirSync(join(repo, "scripts"))).not.toContain("bots-worker.ts");
  });

  it("the inbound pipeline and the dispatcher do not know the runtime", () => {
    for (const dir of ["src/modules/whatsapp", "src/modules/messaging", "src/db/ops"])
      for (const f of walk(dir).filter((p) => !/\.test\.ts$/.test(p)))
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
