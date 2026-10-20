import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOT_FLOW_HANDOVER_REASONS,
  BOT_SESSION_END_REASONS,
  BOT_SESSION_STATES,
  BOT_TERMINAL_SESSION_STATES,
} from "@/db/schema/enums";
import {
  HANDOVER_REASON_CODES,
  SESSION_STATES,
  TERMINAL_SESSION_STATES,
  canonicalFlowJson,
  validateFlow,
  type FlowConfig,
} from "@/modules/bots";
import { enquiryFlow, flowOfNormalizedSize } from "@/modules/bots/testing";
import { canonicalJson } from "@/shared/canonical-json";
import { draftCanonical } from "./drafts";
import { BotControlError } from "./errors";
import { canonicalWithHash } from "./publish";
import { runBotsCli } from "./operator";

// Structural guards for the bot-control module (Phase 08C, ADR 0019) and unit checks that need no database.

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

describe("bot-control boundaries", () => {
  it("never sends: no network, Meta, messaging, webhook, Inbox or engine-runtime code", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /\bfetch\s*\(|undici|axios|graph\.facebook\.com|XMLHttpRequest/,
      );
      expect(text, file).not.toMatch(/@\/modules\/(messaging|whatsapp|inbox|leads)\b/);
      expect(text, file).not.toMatch(/\b(step|simulate|evaluateReply)\s*\(/);
      // Phase 08D: the suppression primitive is the ONLY file that touches outbound requests (QUEUED -> HELD, never anything else).
      if (file !== "suppression.ts")
        expect(text, file).not.toMatch(/outbound_?requests|outboundRequests/i);
    }
  });

  it("the suppression primitive never waits on a request row and only ever holds QUEUED BOT requests (08D)", () => {
    const s = sources.find((x) => x.file === "suppression.ts")!.text;
    // the candidate statement locks only the request rows, one at a time in id order, skipping any row another transaction holds
    expect(s.match(/FOR UPDATE OF r SKIP LOCKED/g)).toHaveLength(1);
    expect(s).toMatch(/ORDER BY r\.id FOR UPDATE OF r SKIP LOCKED`/);
    expect(s).not.toMatch(/FOR (UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)(?! OF r SKIP LOCKED)/);
    // the only write: QUEUED -> HELD on ids this transaction locked; it never sends, claims, re-queues or finishes a send
    expect(s.match(/UPDATE outbound_requests/g)).toHaveLength(1);
    expect(s).toMatch(/SET state = 'HELD'/);
    expect(s).toMatch(/AND o\.state = 'QUEUED'/);
    expect(s).not.toMatch(
      /'(SENDING|ACCEPTED|REJECTED|UNKNOWN_OUTCOME)'\s*,?\s*(hold|WHERE)|state = '(SENDING|ACCEPTED|REJECTED|UNKNOWN_OUTCOME)'/,
    );
    expect(s).toMatch(/r\.origin = 'BOT' AND r\.state = 'QUEUED'/);
    // every Stop path suppresses through it, and the test-only seam is never passed by production code
    const d = sources.find((x) => x.file === "deployments.ts")!.text;
    expect(d.match(/await suppress\(tx, deps, ctx\.organizationId/g)).toHaveLength(3);
    expect(d).toContain('export const STOP_HOLD_CODE = "bot_stopped";');
    const seamUsers = [...walk("src"), ...walk("scripts")].filter(
      (f) =>
        !/\.(db\.)?test\.ts$/.test(f) &&
        !/testing\.ts$/.test(f) &&
        /lockSuppressionCandidates\s*:/.test(read(f)),
    );
    expect(seamUsers).toEqual([]);
  });

  it("has no HTTP route or page: only the operator script uses it", () => {
    const users = [...walk("src"), ...walk("scripts")].filter(
      (f) =>
        !f.includes("/src/modules/bot-control/") &&
        /from\s+"@\/modules\/bot-control(\/[^"]*)?"/.test(read(f)),
    );
    expect(users.map((f) => f.slice(repo.length))).toEqual(["/scripts/bots-admin.ts"]);
  });

  it("nothing calls the redaction function yet (the 08F retention job will be its only caller)", () => {
    const callers = [...walk("src"), ...walk("scripts")].filter(
      (f) => !/\.(db\.)?test\.ts$/.test(f) && /redact_expired_bot_sessions/.test(read(f)),
    );
    expect(callers).toEqual([]);
  });

  it("every write goes through the approved authorization sequence", () => {
    for (const { file, text } of sources) {
      // A transaction is opened only by common.ts's write(), which locks and re-validates the actor first.
      if (file !== "common.ts") expect(text, file).not.toMatch(/\.transaction\s*\(/);
      if (file !== "common.ts") expect(text, file).not.toMatch(/revalidateActor/);
    }
    const common = sources.find((s) => s.file === "common.ts")!.text;
    expect(common.indexOf("assertCan(ctx, permission)")).toBeGreaterThan(-1);
    expect(common.indexOf("lockAndRevalidateActor(tx, ctx, permission)")).toBeLessThan(
      common.indexOf("await work(tx)"),
    );
  });

  it("adds no dependency", () => {
    const pkg = JSON.parse(read(join(repo, "package.json"))) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@base-ui/react",
      "@better-auth/drizzle-adapter",
      "better-auth",
      "class-variance-authority",
      "clsx",
      "drizzle-orm",
      "lucide-react",
      "next",
      "pg",
      "react",
      "react-dom",
      "tailwind-merge",
      "tw-animate-css",
      "zod",
    ]);
    expect(Object.keys(pkg.devDependencies)).toHaveLength(15);
  });
});

describe("database lists stay equal to the engine's", () => {
  it("the configurable HANDOVER reasons are the database's flow reasons", () => {
    expect([...BOT_FLOW_HANDOVER_REASONS]).toEqual([...HANDOVER_REASON_CODES]);
  });

  it("the engine's states and end reasons are database values", () => {
    expect(
      [...SESSION_STATES].every((s) => (BOT_SESSION_STATES as readonly string[]).includes(s)),
    ).toBe(true);
    expect([...TERMINAL_SESSION_STATES].sort()).toEqual([...BOT_TERMINAL_SESSION_STATES].sort());
    for (const reason of ["flow_end", "flow_handover", "idle_timeout", "system_handover", "error"])
      expect(BOT_SESSION_END_REASONS as readonly string[]).toContain(reason);
  });
});

describe("canonical storage (ADR 0019)", () => {
  const utf8 = (s: string) => new TextEncoder().encode(s).byteLength;

  it("a draft is stored as exactly the canonical JSON of what was saved", () => {
    const flow = enquiryFlow();
    expect(draftCanonical(flow)).toBe(canonicalJson(flow));
  });

  it("a draft at exactly 65,536 canonical bytes is accepted; one byte more is refused", () => {
    const at = validateFlow(flowOfNormalizedSize(65_536)).config!;
    expect(utf8(draftCanonical(at))).toBe(65_536);
    const over = { ...at, name: `${at.name}x` };
    expect(utf8(canonicalJson(over))).toBe(65_537);
    expect(() => draftCanonical(over)).toThrow(BotControlError);
    try {
      draftCanonical(over);
    } catch (e) {
      expect((e as BotControlError).reason).toBe("CONFIG_TOO_LARGE");
    }
  });

  it("a draft that is not JSON data is refused with its shape code", () => {
    for (const [value, reason] of [
      [{ a: Number.NaN }, "CONFIG_NOT_JSON"],
      [{ a: new Date(0) }, "CONFIG_NOT_JSON"],
    ] as const) {
      try {
        draftCanonical(value);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(BotControlError);
        expect((e as BotControlError).reason).toBe(reason);
      }
    }
  });

  it("a version hashes exactly the canonical UTF-8 bytes of the validated flow", () => {
    const config = validateFlow(enquiryFlow()).config as FlowConfig;
    const { canonical, sha256 } = canonicalWithHash(config);
    expect(canonical).toBe(canonicalFlowJson(config));
    expect(sha256).toBe(createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex"));
    expect(canonical).toMatch(/ආයුබෝවන්/); // multilingual text is stored as UTF-8, not escaped
  });

  it("extreme valid layout coordinates keep their canonical form (PostgreSQL rendering never decides acceptance)", () => {
    const flow = enquiryFlow();
    const xs = [5e-324, -1_000_000, 1_000_000, 0.1, 1e-7, 123456.789];
    const ids = Object.keys(flow.nodes as Record<string, unknown>);
    flow.layout = Object.fromEntries(xs.map((x, k) => [ids[k]!, { x, y: -x }]));
    const config = validateFlow(flow).config!;
    const { canonical } = canonicalWithHash(config);
    expect(canonical).toContain('"x":5e-324');
    expect(canonical).toContain('"x":1e-7');
    // Round trip through JSON (what a jsonb read returns to JavaScript) gives back the same canonical text.
    expect(canonicalJson(JSON.parse(canonical))).toBe(canonical);
  });
});

describe("operator CLI (no database needed for usage errors)", () => {
  const run = async (argv: string[]) => {
    const printed: unknown[] = [];
    const code = await runBotsCli(argv, undefined as never, (v) => printed.push(v));
    return { code, printed };
  };

  it("unknown commands and missing identity are usage errors, before any database access", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["frobnicate"])).code).toBe(2);
    expect((await run(["list"])).code).toBe(2);
    expect((await run(["list", "--organization", "o"])).code).toBe(2);
    expect((await run(["list", "--bogus"])).code).toBe(2);
  });
});
