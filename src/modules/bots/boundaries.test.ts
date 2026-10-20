import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_CODES,
  ENGINE_BUDGETS,
  HANDOVER_REASON_CODES,
  SYSTEM_HANDOVER_REASONS,
  TRIGGER_KINDS,
  NODE_TYPES,
  validateFlow,
} from "./index";
import { minimalFlow } from "./testing";

// Structural guards for the bots module (ADR 0017, ADR 0018): a PURE flow contract, validator, engine and simulator. It never
// reaches a database, sends, reads the clock, generates randomness or reads the environment, and it contains no
// student-facing wording. They pin properties a refactor could remove silently.

const root = new URL(".", import.meta.url).pathname;
const read = (p: string) => readFileSync(p, "utf8");
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
const sources = readdirSync(root)
  .filter((f) => f.endsWith(".ts") && !/\.(db\.)?test\.ts$/.test(f) && f !== "testing.ts")
  .map((f) => ({ file: f, text: code(read(join(root, f))) }));

describe("bots module boundaries (08A, 08B)", () => {
  it("has no subdirectory, so nothing (a database helper, say) can hide below the scanned files", () => {
    const directories = (
      readdirSync(root, { withFileTypes: true }) as import("node:fs").Dirent[]
    ).filter((d) => d.isDirectory());
    expect(directories.map((d) => d.name)).toEqual([]);
  });

  it("has exactly the expected production files", () => {
    expect(sources.map((s) => s.file).sort()).toEqual([
      "canonical.ts",
      "diagnostics.ts",
      "engine.ts",
      "graph.ts",
      "index.ts",
      "limits.ts",
      "lookup.ts",
      "render.ts",
      "reply-id.ts",
      "schemas.ts",
      "session.ts",
      "simulate.ts",
      "text.ts",
      "types.ts",
      "urls.ts",
      "validate.ts",
      "zod-diagnostics.ts",
    ]);
  });

  it("is pure: no database, network, filesystem, process, clock, randomness, timer or environment", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /\bfetch\s*\(|["']node:|undici|axios|graph\.facebook\.com|XMLHttpRequest|WebSocket|\bprocess\b|\bBuffer\b|require\s*\(/,
      );
      expect(text, file).not.toMatch(
        /Date\.now|new Date\b|\bDate\(|performance\.now|Math\.random|crypto|randomUUID|getRandomValues/,
      );
      expect(text, file).not.toMatch(/setTimeout|setInterval|setImmediate|queueMicrotask/);
      expect(text, file).not.toMatch(/\bconsole\./);
      expect(text, file).not.toMatch(/import\.meta\.env|\benv\b\./);
    }
  });

  it("imports only zod, the shared canonicalizer and its own files", () => {
    for (const { file, text } of sources) {
      const specifiers = [...text.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const spec of specifiers) {
        expect(
          spec === "zod" || spec === "@/shared/canonical-json" || spec.startsWith("./"),
          `${file}: ${spec}`,
        ).toBe(true);
      }
    }
  });

  it("does not import any other module, the database, the dispatcher, the inbound pipeline or the UI", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/@\/modules\/|@\/db|drizzle|from "pg"|\.\.\/|@\/app\/|next\//);
    }
  });

  it("evaluates no code: no eval, Function constructor, dynamic import or RegExp built from configuration", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /\beval\s*\(|new Function\b|\bFunction\s*\(|\bimport\s*\(|vm\./,
      );
    }
    // Regular expressions are fixed patterns written in the source, never built from configuration or input.
    for (const { file, text } of sources) {
      const constructed = [...text.matchAll(/new RegExp\(\s*([^,)]*)/g)].map((m) => m[1]!.trim());
      for (const arg of constructed) expect(arg, file).toMatch(/^String\.raw`/);
    }
  });

  it("contains no student-facing wording: no Sinhala or Tamil text in production code", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/[஀-௿඀-෿]/);
    }
  });

  it("production source is pure ASCII: no hidden, invisible or bidirectional characters", () => {
    for (const f of readdirSync(root).filter(
      (n) => n.endsWith(".ts") && !/\.test\.ts$/.test(n) && n !== "testing.ts",
    )) {
      expect(read(join(root, f)), f).not.toMatch(/[^\x00-\x7f]/);
    }
  });

  it("is imported only by bot-control, and only for its pure validation and canonicalization (no runtime before 08E)", () => {
    const repo = join(root, "../../..");
    const walk = (dir: string): string[] =>
      (
        readdirSync(join(repo, dir), {
          recursive: true,
          withFileTypes: true,
        }) as import("node:fs").Dirent[]
      )
        .filter((d) => d.isFile() && /\.(m?[tj]sx?)$/.test(d.name))
        .map((d) => join(d.parentPath, d.name));
    const importers = [...walk("src"), ...walk("scripts")].filter(
      (f) =>
        !f.includes("/src/modules/bots/") &&
        /(from|import)\s*\(?\s*"[^"]*modules\/bots(\/[^"]*)?"/.test(read(f)),
    );
    const production = importers.filter((f) => !/\.(db\.)?test\.ts$|\/testing\.ts$/.test(f));
    expect(production.length).toBeGreaterThan(0); // the scan really finds the bot-control importers
    for (const f of production) expect(f, f).toContain("/src/modules/bot-control/");
    // The approved pure surface: validation, canonicalization, limits and types. Never the engine or the simulator.
    const allowed = new Set([
      "validateFlow",
      "canonicalFlowJson",
      "checkJsonShape",
      "FLOW_LIMITS",
      "Diagnostic",
      "FlowConfig",
      "type Diagnostic",
      "type FlowConfig",
    ]);
    for (const f of production) {
      for (const m of read(f).matchAll(
        /import\s*(type\s*)?\{([^}]*)\}\s*from\s*"@\/modules\/bots"/g,
      )) {
        for (const name of m[2]!
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean))
          expect(allowed.has(name), `${f}: ${name}`).toBe(true);
      }
      expect(read(f), f).not.toMatch(/@\/modules\/bots\//); // no deep imports
    }
  });

  it("leaves migrations 0000-0007 byte-for-byte unchanged; 0008 (bot outbound dispatch) is the latest", () => {
    const repo = join(root, "../../..");
    const dir = join(repo, "src/db/migrations");
    const migrations = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const sha = (f: string) =>
      createHash("sha256")
        .update(readFileSync(join(dir, f)))
        .digest("hex");
    expect(Object.fromEntries(migrations.slice(0, 8).map((f) => [f, sha(f)]))).toEqual({
      "0000_init_foundation_schema.sql":
        "f32afe09d834c149dd7d1405ae1d5d4b4392b73b2025d5fc0d3b19e6030ccb8b",
      "0001_auth_and_access_foundation.sql":
        "884f5297d34e213b78fcc0514868fc87e34bb03b4b6edb005833cb234202e98c",
      "0002_whatsapp_webhook_ingest_and_bsuid_identity.sql":
        "9b152887fa4ebdbf49743c761a1494b3274550ce2bcf14da81f0770f373f2ab0",
      "0003_lead_attribution_message_unique.sql":
        "c6dba16be8f5a08806a61ec568e3b63c82bbcf2d8c1b5aace76c9e32e550e17d",
      "0004_outbound_requests_and_templates.sql":
        "fcb82c48950859ede62d5fbdcc10ed7559608291af41109aab50ea32e4e542c4",
      "0005_staff_inbox_workflow.sql":
        "d875b3221911fc9222f5a582b9cda117bd67eafec683efb6206da83cf204fab3",
      "0006_leads_lifecycle_and_attribution_integrity.sql":
        "27dd6768054d0386418281f8c094ed21259610370343d868104229d4ae4f9bd4",
      "0007_bot_foundation.sql": "98232660a569710ca1dcfe89ce4c59d6d112a9cdf5cb0da25d365e2376dcf6b2",
    });
    expect(migrations.at(-1)).toBe("0008_bot_outbound_dispatch.sql");
    expect(migrations).toHaveLength(9);
  });
});

describe("contract tables", () => {
  it("supports exactly the eight node types and three trigger kinds of the approved architecture", () => {
    expect([...NODE_TYPES]).toEqual([
      "MESSAGE",
      "BUTTONS",
      "LIST",
      "QUESTION",
      "CONDITION",
      "SET_VARIABLE",
      "HANDOVER",
      "END",
    ]);
    expect([...TRIGGER_KINDS]).toEqual(["keyword", "first_message", "referral_source"]);
  });

  it("HANDOVER reason codes never collide with the system's own handover reasons", () => {
    const flowReasons: readonly string[] = HANDOVER_REASON_CODES;
    const systemReasons: readonly string[] = SYSTEM_HANDOVER_REASONS;
    for (const reason of flowReasons) {
      for (const system of systemReasons) {
        expect(
          system.endsWith("_") ? reason.startsWith(system) : reason === system,
          `${reason} vs ${system}`,
        ).toBe(false);
      }
    }
  });

  it("every handover reason the engine writes itself is a system reason, never a configurable flow reason", () => {
    const systemReasons: readonly string[] = SYSTEM_HANDOVER_REASONS;
    const flowReasons: readonly string[] = HANDOVER_REASON_CODES;
    const isSystem = (reason: string) =>
      systemReasons.some((s) => (s.endsWith("_") ? reason.startsWith(s) : reason === s));
    const engineSource = read(join(root, "engine.ts"));
    for (const reason of [
      "engine_error",
      "delivery_failed",
      "send_held",
      "send_rejected",
      "send_outcome_unknown",
    ]) {
      expect(engineSource, reason).toContain(`"${reason}"`);
      expect(isSystem(reason), reason).toBe(true);
      expect(flowReasons, reason).not.toContain(reason);
    }
  });

  it("every diagnostic code is unique, upper snake case, and has a fixed severity", () => {
    expect(new Set(DIAGNOSTIC_CODES).size).toBe(DIAGNOSTIC_CODES.length);
    for (const c of DIAGNOSTIC_CODES) expect(c).toMatch(/^[A-Z][A-Z_]+$/);
  });

  it("the validator never throws, whatever it is given", () => {
    const hostile: unknown[] = [
      undefined,
      null,
      0,
      "",
      [],
      {},
      [[]],
      { nodes: null },
      { nodes: { a: null } },
      { triggers: [null] },
      { variables: [] },
      minimalFlow(),
    ];
    for (const input of hostile) expect(() => validateFlow(input)).not.toThrow();
  });
});

describe("ADR 0017 stays in step with the code", () => {
  const adr = read(join(root, "../../../docs/adr/0017-bot-flow-contract.md"));

  it("lists every diagnostic code, node type and trigger kind", () => {
    for (const c of DIAGNOSTIC_CODES) expect(adr, c).toContain(`\`${c}\``);
    for (const t of NODE_TYPES) expect(adr, t).toContain(t);
    for (const k of TRIGGER_KINDS) expect(adr, k).toContain(k);
    for (const r of HANDOVER_REASON_CODES) expect(adr, r).toContain(r);
  });

  it("records the owner decisions and keeps the P2 acceptance-recording finding OPEN", () => {
    expect(adr).toMatch(/Owner decisions confirmed for 08A/);
    expect(adr).toMatch(/P2 concurrency finding/);
    expect(adr).toMatch(/\*\*OPEN\*\*|It is \*\*OPEN\*\*/);
    expect(adr).toMatch(/MUST be resolved before production sign-off/);
    expect(adr).not.toMatch(/P2[^.]*\b(is|was|has been) (resolved|closed|fixed)\b/i);
  });
});

describe("ADR 0018 stays in step with the engine", () => {
  const adr = read(join(root, "../../../docs/adr/0018-bot-execution-engine.md"));

  it("states the budgets the engine enforces", () => {
    expect(ENGINE_BUDGETS).toMatchObject({
      transitionsPerStep: 20,
      transitionsPerSession: 200,
      sendsPerSession: 60,
      sendsPerStep: 1,
      variablesTotalMax: 4096,
    });
    expect(adr).toMatch(/at most 20 nodes entered per step, 200 per session, 60 sends per session/);
    expect(adr).toMatch(/4,096 UTF-16 code units/);
  });

  it("records the owner decisions and keeps the acceptance-recording versus Stop blocker OPEN", () => {
    expect(adr).toMatch(/routes to `errorNodeId` \(owner decision\)/);
    expect(adr).toMatch(/Missing variables are strict \(owner decision\)/);
    expect(adr).toMatch(/is \*\*OPEN\*\*/);
    expect(adr).toMatch(
      /MUST be resolved, and proven with disposable PostgreSQL concurrency tests/,
    );
    expect(adr).not.toMatch(/blocker[^.]*\b(is|was|has been) (resolved|closed|fixed)\b/i);
  });
});
