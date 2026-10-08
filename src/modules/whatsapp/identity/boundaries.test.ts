import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Structural guards for contact identity resolution. It resolves WHO sent a message and nothing else.

const root = new URL(".", import.meta.url).pathname;
const read = (path: string) => readFileSync(path, "utf8");
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sources = readdirSync(root)
  .filter((f) => f.endsWith(".ts") && !/\.(db\.)?test\.ts$/.test(f) && f !== "testing.ts")
  .map((f) => ({ file: f, text: code(read(join(root, f))) }));
const source = (file: string) => sources.find((s) => s.file === file)!.text;

describe("identity resolution boundaries", () => {
  it("has exactly the expected production files", () => {
    expect(sources.map((s) => s.file).sort()).toEqual(["index.ts", "profile.ts", "resolve.ts"]);
  });

  it("creates no lead, student, conversation, message, status, consent or tag, and uses no other identity table", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /schema\.(leads|leadAttributions|conversations|messages|messageStatusEvents|messageAttachments|contactConsents|contactTags|tags)\b/,
      );
      expect(text, file).not.toMatch(/marketingConsent|contact_consents/i);
    }
  });

  it("opens no transaction or savepoint of its own: every write uses the caller's transaction", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /\.transaction\s*\(|getDb|new Pool|connect\s*\(|BEGIN|SAVEPOINT/i,
      );
    }
  });

  it("makes no Meta/HTTP call, reads no environment or secret, runs no timers", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\bfetch\s*\(|node:https?|undici|axios|graph\.facebook/);
      expect(text, file).not.toMatch(/process\.env|META_APP_SECRET|credential/i);
      expect(text, file).not.toMatch(/\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/);
      expect(text, file).not.toMatch(/@\/modules\/(auth|access)|better-auth|next\/server/);
    }
  });

  it("does not depend on undocumented identity-change fields or on system messages", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /previous_user_id|user_id_update|user_changed|parent_user_id|from_parent_user_id|\bsystem\b\s*[.:=]|"system"/,
      );
    }
  });

  it("never re-points an alias: aliases are inserted or have their seen-window widened, and contact_id is never updated", () => {
    const resolve = source("resolve.ts");
    const updates = resolve.match(/\.update\(schema\.contactBsuids\)[\s\S]*?\.where\(/g) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toMatch(/contactId|contact_id|retiredAt|retired_at|bsuid:/);
    expect(resolve).not.toMatch(/onConflictDoUpdate/);
    expect(resolve).not.toMatch(/\.delete\(schema\.contactBsuids\)/);
  });

  it("has no legacy-link path: an alias is only ever inserted for a contact created in the same call", () => {
    const resolve = source("resolve.ts");
    expect(resolve.match(/insertAlias\(/g)).toHaveLength(2); // its definition and the one call inside createWithAlias
    expect(resolve.slice(resolve.indexOf("async function createWithAlias"))).toContain(
      "insertAlias(",
    );
    expect(resolve).not.toMatch(/linkedLegacy|contact_identity_linked/);
    // a phone-only message for a contact that has aliases is refused, never resolved
    expect(resolve).toContain('throw new PermanentWebhookError("phone_only_identity_ambiguous")');
  });

  it("scopes every contact and alias statement by organization, taken from the trusted event only", () => {
    const resolve = source("resolve.ts");
    // every Drizzle statement on the two identity tables names organizationId
    for (const table of ["contacts", "contactBsuids"]) {
      const statements =
        resolve.match(
          new RegExp(`(from|update|delete)\\((schema\\.)?${table}\\)[\\s\\S]*?;`, "g"),
        ) ?? [];
      expect(statements.length, table).toBeGreaterThan(0);
      for (const statement of statements) expect(statement, statement).toMatch(/organizationId/);
    }
    expect(resolve).not.toMatch(/payload\.(organization|org)/i);
    expect(resolve).toContain("const org = event.organizationId");
  });

  it("takes advisory transaction locks (never session locks) before reading, in sorted key order", () => {
    const resolve = source("resolve.ts");
    expect(resolve).toContain("pg_advisory_xact_lock");
    expect(resolve).not.toMatch(/pg_advisory_lock\b|pg_try_advisory/);
    expect(resolve).toMatch(/\.sort\(\)/);
    expect(resolve.indexOf("pg_advisory_xact_lock")).toBeLessThan(
      resolve.indexOf("resolveLocked(tx"),
    );
  });

  it("is not wired into the application or the queue", () => {
    const repo = join(root, "../../../..");
    const queue = readdirSync(join(root, "../queue")).filter(
      (f) => f.endsWith(".ts") && !/test|testing/.test(f),
    );
    for (const f of queue)
      expect(read(join(root, "../queue", f)), f).not.toMatch(/\.\.\/identity|whatsapp\/identity/);
    const top = readdirSync(join(root, "..")).filter(
      (f) => f.endsWith(".ts") && !/test|testing/.test(f),
    );
    for (const f of top) expect(read(join(root, "..", f)), f).not.toMatch(/from\s+"\.\/identity/);
    for (const dir of ["src/app"]) {
      const files = (readdirSync(join(repo, dir), { recursive: true }) as string[]).filter((f) =>
        /\.tsx?$/.test(f),
      );
      for (const f of files) expect(read(join(repo, dir, f)), f).not.toMatch(/whatsapp\/identity/);
    }
  });
});
