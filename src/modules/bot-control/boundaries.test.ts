import { createHash } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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
import { sessionSuppressionCandidatesSql, suppressionCandidatesSql } from "./suppression";

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
    // the candidate statements (deployment-scoped 08D, session-scoped 08E-5) lock only request rows, in id order, skipping any
    // row another transaction holds
    expect(s.match(/FOR UPDATE OF r SKIP LOCKED/g)).toHaveLength(2);
    expect(s.match(/ORDER BY r\.id FOR UPDATE OF r SKIP LOCKED`/g)).toHaveLength(2);
    expect(s).not.toMatch(/FOR (UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)(?! OF r SKIP LOCKED)/);
    // the only writes: QUEUED -> HELD on ids this transaction locked; they never send, claim, re-queue or finish a send
    expect(s.match(/UPDATE outbound_requests/g)).toHaveLength(2);
    expect(s.match(/SET state = 'HELD'/g)).toHaveLength(2);
    expect(
      s.match(/= ANY\(\$\{uuidArray\(locked(Ids)?\)\}::uuid\[\]\) AND o\.state = 'QUEUED'/g),
    ).toHaveLength(2);
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
        /lock(Session)?SuppressionCandidates\s*:/.test(read(f)),
    );
    expect(seamUsers).toEqual([]);
  });

  it("the session-scoped candidate statement is the deployment-scoped one with only the session predicate changed (08E-5, plan I.5)", () => {
    const render = (q: SQL) => new PgDialect().sqlToQuery(q).sql;
    const org = "00000000-0000-4000-8000-000000000001";
    const id = "00000000-0000-4000-8000-000000000002";
    const deployment = render(suppressionCandidatesSql(org, [id]));
    const session = render(sessionSuppressionCandidatesSql(org, id));
    const predicate =
      /AND r\.bot_session_id (IN \(SELECT s\.id FROM bot_sessions s WHERE .*\)|= \$\d+) ORDER BY/;
    expect(deployment).toMatch(predicate);
    expect(session).toMatch(
      /AND r\.bot_session_id = \$2 ORDER BY r\.id FOR UPDATE OF r SKIP LOCKED$/,
    );
    const cut = (text: string) => text.replace(predicate, "AND r.bot_session_id <P> ORDER BY");
    expect(cut(session)).toBe(cut(deployment));
    // the hold of the session primitive is restricted to the locked ids that are still QUEUED BOT rows of that session
    const s = sources.find((x) => x.file === "suppression.ts")!.text;
    expect(s).toMatch(
      /AND o\.state = 'QUEUED'\s+AND o\.origin = 'BOT' AND o\.bot_session_id = \$\{sessionId\}/,
    );
    expect(s).toContain('export const OUTPUT_SUPPRESSED_HOLD_CODE = "bot_output_suppressed";');
    expect(s).toContain('export const SEND_DEADLINE_HOLD_CODE = "bot_send_deadline";');
  });

  it("has no HTTP route or page: only the operator script and (08E-5) the runtime's session-scoped hold use it", () => {
    const users = [...walk("src"), ...walk("scripts")].filter(
      (f) =>
        !f.includes("/src/modules/bot-control/") &&
        /from\s+"@\/modules\/bot-control(\/[^"]*)?"/.test(read(f)),
    );
    expect(users.map((f) => f.slice(repo.length)).sort()).toEqual([
      "/scripts/bots-admin.ts",
      "/src/modules/bot-runtime/continue.ts",
      "/src/modules/bot-runtime/reconcile.ts",
      "/src/modules/bot-runtime/trigger-queue.ts",
    ]);
    // the runtime imports exactly the session primitive and its hold code, through the module index, nothing else
    for (const f of users.filter((x) => x.includes("/bot-runtime/"))) {
      const imports = [
        ...read(f).matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/modules\/bot-control(\/[^"]*)?"/g),
      ];
      expect(imports, f).toHaveLength(1);
      expect(imports[0]![2], f).toBeUndefined();
      expect(
        imports[0]![1]!
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)
          .sort(),
        f,
      ).toEqual(
        f.endsWith("reconcile.ts")
          ? [
              "OUTPUT_SUPPRESSED_HOLD_CODE",
              "SEND_DEADLINE_HOLD_CODE",
              "suppressSessionQueuedRequests",
            ]
          : ["OUTPUT_SUPPRESSED_HOLD_CODE", "suppressSessionQueuedRequests"],
      );
    }
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
