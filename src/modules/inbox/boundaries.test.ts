import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Structural guards for the staff inbox: it can read and manage workflow, and it can NEVER send, reach Meta, skip
// authorization, or write outside its own tables. They pin properties a refactor could remove silently.

const root = new URL(".", import.meta.url).pathname;
const repo = join(root, "../../..");
const read = (p: string) => readFileSync(p, "utf8");
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sources = readdirSync(root)
  .filter((f) => f.endsWith(".ts") && !/\.(db\.)?test\.ts$/.test(f) && f !== "testing.ts")
  .map((f) => ({ file: f, text: code(read(join(root, f))) }));
const source = (f: string) => sources.find((s) => s.file === f)!.text;
const walk = (dir: string): string[] =>
  (
    readdirSync(join(repo, dir), {
      recursive: true,
      withFileTypes: true,
    }) as import("node:fs").Dirent[]
  )
    .filter((d) => d.isFile() && /\.(m?[tj]sx?)$/.test(d.name))
    .map((d) => relative(repo, join(d.parentPath, d.name)));
const routes = walk("src/app/api/inbox").filter((f) => f.endsWith("route.ts"));
const ui = walk("src/app/(app)/inbox").filter((f) => !/\.test\.ts$/.test(f));

/** The body of each exported async function in a module file. */
const exported = (text: string) =>
  text
    .split(/\nexport async function /)
    .slice(1)
    .map((chunk) => ({ name: /^(\w+)/.exec(chunk)![1]!, body: chunk }));

describe("inbox module boundaries", () => {
  it("has exactly the expected production files", () => {
    expect(sources.map((s) => s.file).sort()).toEqual([
      "bot-indicator.ts",
      "config.ts",
      "cursor.ts",
      "detail.ts",
      "display.ts",
      "errors.ts",
      "index.ts",
      "list.ts",
      "notes.ts",
      "quick-replies.ts",
      "read-state.ts",
      "schemas.ts",
      "tags.ts",
      "text.ts",
      "timeline.ts",
      "types.ts",
      "workflow.ts",
    ]);
  });

  it("cannot send: no network, no outbound service, no queue, no Meta, no environment, no logging", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /\bfetch\s*\(|node:https?|undici|axios|graph\.facebook\.com|XMLHttpRequest/,
      );
      expect(text, file).not.toMatch(
        /submitOutboundMessage|MetaTransport|OutboundTransport|dispatchBatch/,
      );
      expect(text, file).not.toMatch(/outboundRequests|outbound_requests\s*\(?\s*(INSERT|UPDATE)/i);
      expect(text, file).not.toMatch(/process\.env/);
      expect(text, file).not.toMatch(/console\.|logger\.|emitWebhookLog|emitSecurityEvent/);
    }
  });

  it("the only thing it takes from the messaging module is the read-only reply readiness", () => {
    for (const { file, text } of sources) {
      const imports = [...text.matchAll(/from "(@\/modules\/messaging[^"]*)"/g)].map((m) => m[1]);
      if (file === "detail.ts") expect(imports).toEqual(["@/modules/messaging"]);
      else expect(imports, file).toEqual([]);
    }
    expect(source("detail.ts")).toMatch(
      /import \{ getReplyReadiness \} from "@\/modules\/messaging";/,
    );
  });

  it("writes only its own tables and never a message, a timestamp of the messaging window, or consent", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /\.(insert|update|delete)\(schema\.(messages|messageAttachments|messageStatusEvents|webhookEvents|webhookRequests|contactConsents|contactBsuids|leads|leadAttributions|whatsappAccounts|whatsappTemplates)\)/,
      );
      expect(text, file).not.toMatch(/\.update\(schema\.contacts\)/);
      // the messaging-window timestamps are READ for display (detail.ts) but never SET, in a query builder or in raw SQL
      expect(text, file).not.toMatch(/\.set\(\{[^}]*(lastInboundAt|lastOutboundAt|lastMessageAt)/);
      expect(text, file).not.toMatch(
        /UPDATE\s+conversations|INSERT\s+INTO\s+(messages|outbound_requests)|DELETE\s+FROM\s+(messages|conversations)/i,
      );
    }
    // the only writes to the conversation row are status/assignment (workflow.ts), never a messaging timestamp
    const writes = sources
      .filter((s) => /\.update\(schema\.conversations\)/.test(s.text))
      .map((s) => s.file);
    expect(writes).toEqual(["workflow.ts"]);
  });

  it("every exported service authorizes FIRST, before it touches the database", () => {
    for (const file of [
      "list.ts",
      "detail.ts",
      "timeline.ts",
      "workflow.ts",
      "read-state.ts",
      "notes.ts",
      "tags.ts",
      "quick-replies.ts",
    ]) {
      const fns = exported(source(file));
      expect(fns.length, file).toBeGreaterThan(0);
      for (const fn of fns) {
        const auth = fn.body.indexOf("assertCan(");
        const touchesDb = fn.body.search(/getDb\(\)|deps\.db|db\./);
        expect(auth, `${file}:${fn.name} authorizes`).toBeGreaterThan(-1);
        expect(auth, `${file}:${fn.name} authorizes before the database`).toBeLessThan(
          touchesDb === -1 ? Infinity : touchesDb,
        );
      }
    }
  });

  it("every mutation revalidates the actor inside its transaction", () => {
    const mutations: Array<[string, string[]]> = [
      ["workflow.ts", ["changeConversationStatus", "assignConversation"]],
      ["read-state.ts", ["markMessagesSeen"]],
      ["notes.ts", ["createNote"]],
      ["tags.ts", ["createTag", "addContactTag", "removeContactTag"]],
      ["quick-replies.ts", ["createQuickReply", "updateQuickReply"]],
    ];
    for (const [file, names] of mutations)
      for (const name of names) {
        const fn = exported(source(file)).find((f) => f.name === name)!;
        expect(fn, `${file}:${name}`).toBeDefined();
        expect(fn.body.indexOf("db.transaction("), `${name} uses a transaction`).toBeGreaterThan(
          -1,
        );
        expect(
          fn.body.indexOf("revalidateActor(tx"),
          `${name} revalidates the actor`,
        ).toBeGreaterThan(fn.body.indexOf("db.transaction("));
      }
  });

  it("every query is scoped by the caller's organization, which only ever comes from the AccessContext", () => {
    for (const file of [
      "list.ts",
      "detail.ts",
      "timeline.ts",
      "notes.ts",
      "read-state.ts",
      "workflow.ts",
      "tags.ts",
      "quick-replies.ts",
    ])
      expect(source(file), file).toMatch(/ctx\.organizationId/);
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /input\.(organizationId|orgId)|body\.organizationId|query\.organizationId/,
      );
    }
    for (const file of ["schemas.ts"]) expect(source(file)).not.toMatch(/organizationId|orgId/);
    // raw SQL that reads tenant tables names the organization in its WHERE clause
    expect(source("list.ts")).toContain("c.organization_id = ${ctx.organizationId}::uuid"); // the list builds its WHERE from fragments
    for (const file of ["detail.ts", "timeline.ts", "notes.ts"]) {
      const sql = [...source(file).matchAll(/sql`([\s\S]*?)`/g)]
        .map((m) => m[1]!)
        .filter((q) =>
          /\bFROM\s+(conversations|messages|conversation_notes|conversation_events)\b/i.test(q),
        );
      expect(sql.length, file).toBeGreaterThan(0);
      for (const q of sql) expect(q, file).toMatch(/organization_id\s*=\s*\$\{/);
    }
  });

  it("untrusted text is always passed through the safe-text functions before it leaves the module", () => {
    for (const file of [
      "list.ts",
      "detail.ts",
      "timeline.ts",
      "notes.ts",
      "quick-replies.ts",
      "tags.ts",
    ])
      expect(source(file), file).toMatch(
        /safeLine|safeText|contactLabel|describeMessage|deliveryView/,
      );
    expect(source("display.ts")).toContain("toWellFormed()");
    // ZWJ / ZWNJ (U+200D / U+200C) are NOT stripped: Sinhala and Tamil need them
    expect(source("display.ts")).not.toMatch(/u200d|u200c|u200[a-f]\b.*u200f|200b-200f/i);
  });

  it("the other modules do not depend on the inbox", () => {
    for (const f of walk("src/modules").filter(
      (x) =>
        !x.startsWith("src/modules/inbox/") && !/\.test\.ts$/.test(x) && !/testing\.ts$/.test(x),
    ))
      expect(read(join(repo, f)), f).not.toMatch(/modules\/inbox|from "\.\.\/inbox/);
  });
});

describe("inbox routes", () => {
  it("are thin: one handleApi call per handler, no database, no environment, no business rules", () => {
    expect(routes.length).toBe(13);
    for (const f of routes) {
      const text = code(read(join(repo, f)));
      expect(text, f).toMatch(/handleApi\(/);
      expect(text, f).not.toMatch(/@\/db|process\.env|schema\.|assertCan|\bsql`|getDb/);
      expect(text, f).toMatch(/from "@\/modules\/inbox"/);
      expect(text.length, f).toBeLessThan(1700);
    }
  });

  it("state-changing methods are same-origin protected and reads are not marked as mutations", () => {
    for (const f of routes) {
      const text = code(read(join(repo, f)));
      for (const m of text.matchAll(
        /export async function (GET|POST|PATCH|PUT|DELETE)\b[\s\S]*?handleApi\(\s*request,\s*\{\s*mutation:\s*(true|false)/g,
      ))
        expect(m[2], `${f} ${m[1]}`).toBe(m[1] === "GET" ? "false" : "true");
    }
  });

  it("the inbox adds no send endpoint: the composer uses the Phase 05 endpoint", () => {
    expect(routes.filter((f) => /send|outbound/i.test(f))).toEqual([]);
    for (const f of routes)
      expect(code(read(join(repo, f))), f).not.toMatch(/submitOutboundMessage/);
  });
});

describe("inbox UI", () => {
  it("never talks to Meta and has exactly one send call: the pending-send module, to the Phase 05 endpoint", () => {
    const callers = ui.filter((f) => /\/api\/conversations\//.test(read(join(repo, f))));
    expect(callers).toEqual(["src/app/(app)/inbox/pending-send.ts"]);
    for (const f of ui) {
      const text = code(read(join(repo, f)));
      expect(text, f).not.toMatch(/graph\.facebook|api\.whatsapp|WHATSAPP_/);
      expect(text, f).not.toMatch(/localStorage|indexedDB/); // read state is on the server, per staff member
      // only the server page reads the environment (polling intervals); browser code never does
      if (/^"use client"/.test(read(join(repo, f)).trimStart()))
        expect(text, f).not.toMatch(/process\.env/);
    }
    const pending = code(read(join(repo, "src/app/(app)/inbox/pending-send.ts")));
    expect(pending.match(/\/api\/conversations\//g)).toHaveLength(1);
    expect(pending.match(/idempotencyKey/g)).toHaveLength(1); // one place builds the request, from the frozen operation
    expect(pending.match(/crypto\.randomUUID/g)).toHaveLength(1); // one place makes a key (a new logical send)
    expect(pending).not.toMatch(/console\./); // message text is never logged
    expect(pending).not.toMatch(/\b(body|text)\b[^\n;]*\.(slice|substring)\(/); // the stored text is exact, never trimmed or cut (key handling may slice prefixes)
    // the ONLY use of browser storage in the inbox is the pending-send journal (sessionStorage, tab-scoped)
    for (const f of ui)
      if (!f.endsWith("pending-send.ts"))
        expect(code(read(join(repo, f))), f).not.toMatch(/sessionStorage/);
    // the composer has no request code of its own, makes no key, and starts nothing by itself (no effect, no timer)
    const composer = code(read(join(repo, "src/app/(app)/inbox/composer.tsx")));
    expect(composer).not.toMatch(
      /\/api\/|fetch\(|idempotencyKey|randomUUID|useEffect|setTimeout|setInterval/,
    );
    expect(composer.match(/submitPending\(/g)).toHaveLength(1);
    expect(composer.match(/\brun\(/g)).toHaveLength(3); // the definition, Send, and the explicit "Check again"
    expect(composer).toMatch(/onClick=\{onCheck\}/);
    // every inbox request states the actor the page was opened for, and a send states the operation's own frozen actor, so the
    // server can refuse a replay from a tab whose session was replaced (X-Expected-Actor; modules/access/expected-actor.ts)
    expect(pending.match(/expectedActor:\s*\{/g)).toHaveLength(1);
    const apiClient = code(read(join(repo, "src/app/(app)/inbox/api.ts")));
    expect(apiClient).toContain('"x-expected-actor"');
    expect(apiClient.match(/\bfetch\(/g)).toHaveLength(1);
    for (const f of ui)
      if (!f.endsWith("/api.ts")) expect(code(read(join(repo, f))), f).not.toMatch(/\bfetch\(/);
    expect(code(read(join(repo, "src/app/(app)/inbox/inbox-app.tsx")))).toContain("setPageActor({");
    // forgetting a pending operation, or acknowledging an expired one, is only reachable through the confirmation dialog
    expect(composer.match(/dismissPending\(/g)).toHaveLength(1);
    expect(composer.match(/acknowledgeExpired\(/g)).toHaveLength(1);
    expect(composer).toContain("onDismiss={() => setConfirm(true)}");
    expect(composer).toContain("onAllow={() => setConfirm(true)}");
    expect(composer.match(/<ConfirmDialog/g)).toHaveLength(2);
    // an uncertain failure never clears the frozen operation: only a validated answer, a provable refusal or the person does
    expect(pending).toMatch(/provesNotQueued/);
    expect(pending).toMatch(/okStatuses: \[200, 201\]/);
  });

  it("quick replies only fill the composer: the picker has no send path at all", () => {
    const picker = code(read(join(repo, "src/app/(app)/inbox/quick-replies.tsx")));
    expect(picker).not.toMatch(/\/api\/conversations\/|messages|idempotency/i);
    expect(picker).toMatch(/onInsert/);
  });

  it("there is no resend control for an uncertain message", () => {
    for (const f of ui)
      expect(code(read(join(repo, f))), f).not.toMatch(
        />\s*(Resend|Retry send|Send again|Try sending)\b/i,
      );
  });

  it("renders provider text as text: no raw HTML injection and no HTML/URL building from message content", () => {
    for (const f of ui)
      expect(read(join(repo, f)), f).not.toMatch(
        /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write|eval\(/,
      );
  });

  it("polling is cleaned up and never overlaps", () => {
    const polling = code(read(join(repo, "src/app/(app)/inbox/use-polling.ts")));
    expect(polling).toMatch(/clearTimeout/);
    expect(polling).toMatch(/removeEventListener\("visibilitychange"/);
    expect(polling).toMatch(/controller\.abort\(\)/);
    expect(polling).not.toMatch(/setInterval/); // the next run is scheduled only after the previous one finished
    expect(polling).toMatch(/visibilityState/);
  });

  it("the page uses only public module APIs and no database", () => {
    for (const f of ui) {
      const text = code(read(join(repo, f)));
      expect(text, f).not.toMatch(/from "@\/db/);
      expect(text, f).not.toMatch(/from "@\/modules\/[a-z-]+\/[^"]+"/);
    }
  });
});
