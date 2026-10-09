import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { webhookWorkerHandlers } from "../worker/registry";
import { registerSchema } from "./accounts";
import { PII_REVEAL_VARIABLE, classifyDead, describeKind, piiRevealEnabled } from "./dead";
import { releasePath } from "./events";
import { CLAIMABLE_EVENT_TYPES } from "./health";

const root = new URL(".", import.meta.url).pathname;
const repo = join(root, "../../../..");
const read = (p: string) => readFileSync(p, "utf8");
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sources = readdirSync(root)
  .filter((f) => f.endsWith(".ts") && !/\.(db\.)?test\.ts$/.test(f))
  .map((f) => ({ file: f, text: code(read(join(root, f))) }));
const source = (f: string) => sources.find((s) => s.file === f)!.text;

const valid = {
  organization: "alpha",
  wabaId: "200000000000001",
  phoneNumberId: "100000000000001",
  displayPhoneNumber: "+94 77 000 0001",
  portfolioConfirmed: true,
};

describe("operator input validation", () => {
  it("accepts a complete registration", () => {
    expect(registerSchema.safeParse(valid).success).toBe(true);
    expect(
      registerSchema.safeParse({
        ...valid,
        credentialRef: "WHATSAPP_TOKEN_ALPHA",
        verifiedName: "A/L ICT",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["no confirmation", { portfolioConfirmed: undefined }],
    ["false confirmation", { portfolioConfirmed: false }],
    ["letters in an id", { wabaId: "20000x000001" }],
    ["a short id", { phoneNumberId: "12345" }],
    ["an overlong id", { phoneNumberId: "1".repeat(31) }],
    ["a token as credential", { credentialRef: "EAAGm0PX4ZCpsBAKd9ZB3" }],
    ["a mixed-case secret value", { credentialRef: "abcDEF123456" }],
    ["an overlong credential name", { credentialRef: "A".repeat(65) }],
    ["a control character", { verifiedName: "bad\u0007name" }],
    ["an unexpected key", { organizationId: "11111111-1111-4111-8111-111111111111" }],
  ])("rejects %s", (_n, over) => {
    expect(registerSchema.safeParse({ ...valid, ...over }).success).toBe(false);
  });
});

describe("DEAD classification", () => {
  it.each([
    ["invalid_timestamp", "invalid_provider_payload"],
    ["invalid_event_payload", "invalid_provider_payload"],
    ["max_attempts_exhausted", "retries_exhausted"],
    ["exhausted_pg_40p01", "retries_exhausted"],
    ["phone_only_identity_ambiguous", "ambiguous_identity"],
    ["missing_sender_identity", "ambiguous_identity"],
    ["account_missing", "routing_inconsistent"],
    ["missing_routing", "routing_inconsistent"],
    ["something_new", "permanent_failure"],
    [null, "permanent_failure"],
  ])("%s is %s", (reason, category) => {
    expect(classifyDead(reason).category).toBe(category);
    expect(classifyDead(reason).guidance.length).toBeGreaterThan(20);
  });

  it("describes an event without any of its content", () => {
    expect(
      describeKind({ field: "messages", message: { type: "image", image: { caption: "SECRET" } } }),
    ).toEqual({ field: "messages", messageType: "image", statusWord: null });
    expect(describeKind({ status: { status: "failed", errors: [{ message: "SECRET" }] } })).toEqual(
      { field: null, messageType: null, statusWord: "failed" },
    );
    // free text in a type position is dropped, never echoed
    expect(describeKind({ message: { type: "Hello Student 0771234567" } }).messageType).toBeNull();
    expect(describeKind("text")).toEqual({ field: null, messageType: null, statusWord: null });
  });
});

describe("release paths", () => {
  it.each([
    ["account_pending", true, "activation_or_requeue_routed"],
    ["account_disabled", true, "requeue_routed_explicit"],
    ["account_archived", true, "requeue_routed_explicit"],
    ["unknown_account", false, "requeue_unrouted_single_event_explicit"],
    ["waba_mismatch", false, "requeue_unrouted_single_event_explicit"],
    ["status_not_mirrored", true, "none"],
    ["unsupported_field", false, "none"],
    ["unknown_account", true, "none"], // a routed event can never be an "unknown account" event
    [null, false, "none"],
  ])("%s (routed %s) -> %s", (reason, routed, path) => {
    expect(releasePath(reason, routed)).toBe(path);
  });
});

describe("operator boundaries", () => {
  it("claimable types equal the worker's registry (the operator layer does not import the worker)", () => {
    expect([...CLAIMABLE_EVENT_TYPES].sort()).toEqual(Object.keys(webhookWorkerHandlers).sort());
    for (const { file, text } of sources)
      expect(text, file).not.toMatch(/\.\.\/worker|whatsapp\/worker/);
  });

  it("makes no network call, reads no environment or secret value, and runs no timers", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\bfetch\s*\(|node:https?|undici|axios|graph\.facebook/);
      expect(text, file).not.toMatch(/META_APP_SECRET|ACCESS_TOKEN/);
      expect(text, file).not.toMatch(/\bsetTimeout\b|\bsetInterval\b/);
      // the ONE environment read is the payload-reveal opt-in gate, in dead.ts
      if (file !== "dead.ts") expect(text, file).not.toMatch(/process\.env/);
    }
    expect(source("dead.ts").match(/process\.env/g)).toHaveLength(1);
    expect(source("dead.ts")).toContain('env[PII_REVEAL_VARIABLE] === "true"');
  });

  it("payload reveal is refused before the database is touched unless the opt-in is exactly 'true'", () => {
    const dead = source("dead.ts");
    const gate = dead.indexOf("!piiRevealEnabled(options.env)");
    expect(gate).toBeGreaterThan(0);
    expect(dead.slice(dead.indexOf("export async function inspectDead"), gate)).not.toMatch(
      /\bdb\b\s*\./,
    );
    expect(dead.indexOf("operator.payload_revealed")).toBeGreaterThan(gate);
    // the refusal never carries the variable's value or any payload
    const refusal = dead.slice(gate, dead.indexOf("const [row]"));
    expect(refusal).not.toMatch(/e\.payload|\.value|env\[|schema\.|options\.env\./);
  });

  it("changes account rows only in accounts.ts, event rows only through the approved requeue functions, and deletes nothing", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\.delete\(|DELETE\s+FROM|TRUNCATE|DROP\s/i);
      expect(text, file).not.toMatch(
        /\.update\(\s*(schema\.)?webhookEvents|UPDATE\s+webhook_events/i,
      );
      expect(text, file).not.toMatch(
        /\.insert\(\s*(schema\.)?(webhookEvents|webhookRequests|contacts|messages)/,
      );
      if (file !== "accounts.ts") expect(text, file).not.toMatch(/\.update\(|\.insert\(/);
    }
    expect(source("accounts.ts").match(/\.insert\(/g)).toHaveLength(1);
    expect(source("accounts.ts")).toContain(".insert(schema.whatsappAccounts)");
    expect(source("events.ts")).toContain("requeueRoutedHeldEvents(tx");
    expect(source("events.ts")).toContain("requeueUnroutedEvent(tx");
  });

  it("DEAD review is read-only: no write, no requeue, no replay", () => {
    const dead = source("dead.ts");
    expect(dead).not.toMatch(
      /\.(insert|update|delete)\(|queue\/requeue|requeueRouted|requeueUnrouted/,
    );
    expect(dead).not.toMatch(/transact|OperatorAbort/);
    for (const { file } of sources) expect(file).not.toMatch(/replay/i);
  });

  it("listings never select the payload; inspection reveals it only on request", () => {
    expect(source("events.ts")).not.toMatch(/payload:\s*schema\.webhookEvents\.payload/);
    expect(source("health.ts")).not.toMatch(/payload/);
    const dead = source("dead.ts");
    expect(dead).toMatch(/options\.revealPayload\s*\?/);
    expect(dead).toContain('event: "operator.payload_revealed"');
    expect(dead.match(/schema\.webhookEvents\.payload/g)?.length ?? 0).toBeLessThanOrEqual(1); // pg_column_size only
  });

  it("every state-changing operator function is a dry run unless applied, and the scripts are thin", () => {
    expect(source("dryrun.ts")).toContain("if (!apply) throw new DryRunRollback(v)");
    expect(source("accounts.ts").match(/transact\(db, options\.apply/g)).toHaveLength(2);
    expect(source("events.ts").match(/transact\(db, options\.apply/g)).toHaveLength(2);
    for (const name of ["accounts", "events", "status"]) {
      const script = code(read(join(repo, `scripts/whatsapp-${name}.ts`)));
      expect(script, name).toMatch(/getDb\(\)/);
      expect(script, name).toMatch(/logToStderr\(\);/); // stdout is reserved for the one JSON result
      expect(script, name).not.toMatch(/schema\.|\.select\(|\.update\(|\.insert\(|process\.env/);
    }
  });

  it("is not exported from the module's public API and is not reachable from the application", () => {
    expect(code(read(join(root, "../index.ts"))).trim()).toBe(
      'export { handleWebhookGet, handleWebhookPost } from "./handler";',
    );
    const app = (readdirSync(join(repo, "src/app"), { recursive: true }) as string[]).filter((f) =>
      /\.tsx?$/.test(f),
    );
    for (const f of app)
      expect(read(join(repo, "src/app", f)), f).not.toMatch(/whatsapp\/operator/);
    expect(read(join(repo, "src/proxy.ts"))).not.toMatch(/whatsapp\/operator/);
  });
});

describe("payload-reveal opt-in (WHATSAPP_ALLOW_PII_REVEAL)", () => {
  it("is disabled by default and only the exact string 'true' enables it", () => {
    expect(PII_REVEAL_VARIABLE).toBe("WHATSAPP_ALLOW_PII_REVEAL");
    expect(piiRevealEnabled({})).toBe(false); // unset
    expect(piiRevealEnabled({ WHATSAPP_ALLOW_PII_REVEAL: undefined })).toBe(false);
    for (const value of [
      "",
      "false",
      "FALSE",
      "TRUE",
      "True",
      "1",
      "0",
      "yes",
      "on",
      " true",
      "true ",
      "true\n",
      "enabled",
      "t",
    ])
      expect(piiRevealEnabled({ WHATSAPP_ALLOW_PII_REVEAL: value }), JSON.stringify(value)).toBe(
        false,
      );
    expect(piiRevealEnabled({ WHATSAPP_ALLOW_PII_REVEAL: "true" })).toBe(true);
  });

  it("reads the real environment when no environment is injected", () => {
    const saved = process.env.WHATSAPP_ALLOW_PII_REVEAL;
    try {
      delete process.env.WHATSAPP_ALLOW_PII_REVEAL;
      expect(piiRevealEnabled()).toBe(false);
      process.env.WHATSAPP_ALLOW_PII_REVEAL = "true";
      expect(piiRevealEnabled()).toBe(true);
      process.env.WHATSAPP_ALLOW_PII_REVEAL = "1";
      expect(piiRevealEnabled()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.WHATSAPP_ALLOW_PII_REVEAL;
      else process.env.WHATSAPP_ALLOW_PII_REVEAL = saved;
    }
  });

  it(".env.example documents it as disabled, with a warning that it is not authorization", () => {
    const example = read(join(repo, ".env.example"));
    expect(example).toMatch(/^# WHATSAPP_ALLOW_PII_REVEAL=false$/m);
    expect(example).not.toMatch(/^WHATSAPP_ALLOW_PII_REVEAL=true/m);
    expect(example).toMatch(/NOT authentication, NOT authorization and NOT an audit trail/);
    expect(example).toMatch(
      /UNAPPROVED\s+# FOR REAL CUSTOMER DATA|UNAPPROVED\n# FOR REAL CUSTOMER DATA/,
    );
  });
});
