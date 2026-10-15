import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Structural guards for the leads module (Phase 07B): it reads and manages leads and NEVER sends, reaches Meta, skips
// authorization, links or decides attribution, or touches the inbound pipeline. They pin properties a refactor could remove silently.

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
const routes = walk("src/app/api/leads").filter((f) => f.endsWith("route.ts"));

/** The body of each exported async function in a module file. */
const exported = (text: string) =>
  text
    .split(/\nexport async function /)
    .slice(1)
    .map((chunk) => ({ name: /^(\w+)/.exec(chunk)![1]!, body: chunk }));

describe("leads module boundaries", () => {
  it("has exactly the expected production files", () => {
    expect(sources.map((s) => s.file).sort()).toEqual([
      "attribution.ts",
      "create.ts",
      "cursor.ts",
      "detail.ts",
      "display.ts",
      "errors.ts",
      "for-contact.ts",
      "history.ts",
      "index.ts",
      "items.ts",
      "list.ts",
      "locks.ts",
      "rules.ts",
      "schemas.ts",
      "types.ts",
      "workflow.ts",
    ]);
  });

  it("cannot send or fetch: no network, no Meta, no outbound service, no queue, no environment, no logging", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /\bfetch\s*\(|node:https?|undici|axios|graph\.facebook\.com|XMLHttpRequest|new URL\(\s*request/,
      );
      expect(text, file).not.toMatch(
        /submitOutboundMessage|MetaTransport|OutboundTransport|dispatchBatch/,
      );
      expect(text, file).not.toMatch(
        /outboundRequests|outbound_requests|webhookEvents|webhook_events/,
      );
      expect(text, file).not.toMatch(/process\.env/);
      expect(text, file).not.toMatch(/console\.|logger\.|emitWebhookLog|emitSecurityEvent/);
    }
  });

  it("depends on no other feature module except access, and on no WhatsApp, messaging or inbox code", () => {
    for (const { file, text } of sources) {
      const imports = [...text.matchAll(/from "(@\/[^"]+)"/g)].map((m) => m[1]!);
      for (const i of imports)
        expect(
          ["@/db", "@/modules/access", "@/shared/errors/http-errors", "@/shared/errors/app-error"],
          `${file} imports ${i}`,
        ).toContain(i);
    }
    for (const f of walk("src/modules").filter(
      (x) =>
        !x.startsWith("src/modules/leads/") && !/\.test\.ts$/.test(x) && !/testing\.ts$/.test(x),
    ))
      expect(read(join(repo, f)), f).not.toMatch(/modules\/leads|from "\.\.\/leads/);
  });

  it("writes only leads and lead history: never attribution, decisions, contacts, messages, consent or conversations", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /\.(insert|update|delete)\(\s*schema\.(?!leads\b|leadEvents\b)/,
      );
      expect(text, file).not.toMatch(
        /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(lead_attributions|lead_reconcile_decisions|contacts|contact_|messages|conversations|whatsapp_|tags|organization)/i,
      );
    }
    const writers = sources
      .filter((s) => /\.(insert|update)\(\s*schema\.leads\b/.test(s.text))
      .map((s) => s.file)
      .sort();
    expect(writers).toEqual(["create.ts", "workflow.ts"]);
    const historyWriters = sources
      .filter((s) => /\.insert\(\s*schema\.leadEvents\b/.test(s.text))
      .map((s) => s.file)
      .sort();
    expect(historyWriters).toEqual(["create.ts", "workflow.ts"]);
    // the only history rows the services write are CREATED (manual) and STATUS: never a link, never an automatic origin
    expect(source("create.ts")).toMatch(/kind: "CREATED"[\s\S]*origin: "MANUAL"/);
    expect(source("create.ts")).not.toMatch(
      /AD_REFERRAL|TOUCH_LINKED|attributionId|initiatingAttributionId/,
    );
    expect(source("workflow.ts")).toMatch(/kind: "STATUS"/);
    expect(source("workflow.ts")).not.toMatch(
      /AD_REFERRAL|TOUCH_LINKED|attributionId|initiatingAttributionId/,
    );
  });

  it("no service takes a client-supplied timestamp, revision or origin: lifecycle values come from the database clock after the locks", () => {
    for (const file of ["create.ts", "workflow.ts"]) {
      const text = source(file);
      expect(text, file).not.toMatch(/new Date\(|Date\.now\(|\bnow\(\)/);
      expect(text, file).toMatch(/afterLockTime\(tx\)/);
      expect(text, file).not.toMatch(/input\.|parsed\.data\.[a-z]*(At|Revision|Origin)/);
    }
    expect(source("locks.ts")).toMatch(/clock_timestamp\(\)/);
    expect(source("locks.ts")).not.toMatch(/now\(\)(?!\s*;)\s*::|\bnow\(\)\)/);
    // the stamp is taken AFTER the contact lock in both writers
    const create = source("create.ts");
    expect(create.indexOf("lockContact(")).toBeGreaterThan(-1);
    expect(create.indexOf("afterLockTime(")).toBeGreaterThan(create.indexOf("lockContact("));
    const workflow = source("workflow.ts");
    expect(workflow.indexOf("afterLockTime(")).toBeGreaterThan(workflow.indexOf('.for("update")'));
    expect(workflow.indexOf('.for("update")')).toBeGreaterThan(workflow.indexOf("lockContact("));
    // the schemas accept none of them
    const schemas = source("schemas.ts");
    expect(schemas).not.toMatch(
      /cycleStartedAt|closedAt|statusChangedAt|createdAt|origin|organizationId|orgId|actor/,
    );
    expect(schemas).toMatch(/z\.strictObject\(\{ contactId: uuid \}\)/);
    expect(schemas.match(/z\.strictObject\(/g)!.length).toBe(4);
    expect(schemas).not.toMatch(/z\.object\(|passthrough|catchall/);
  });

  it("every exported service authorizes FIRST, before it touches the database", () => {
    for (const file of [
      "create.ts",
      "workflow.ts",
      "list.ts",
      "detail.ts",
      "history.ts",
      "for-contact.ts",
    ]) {
      const fns = exported(source(file)).filter(
        (f) => !/^(selectEvents|selectLeadRows|getLeadItem)$/.test(f.name),
      );
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

  it("each service asks for the permissions the API contract names", () => {
    const perms = (file: string, name: string) =>
      [
        ...exported(source(file))
          .find((f) => f.name === name)!
          .body.matchAll(/assertCan\(ctx, "([a-z.]+)"\)/g),
      ].map((m) => m[1]);
    expect(perms("list.ts", "listLeads")).toEqual(["lead.read"]);
    expect(perms("detail.ts", "getLeadDetail")).toEqual([
      "lead.read",
      "contact.read",
      "conversation.read",
    ]);
    expect(perms("history.ts", "listLeadEvents")).toEqual([
      "lead.read",
      "contact.read",
      "conversation.read",
    ]);
    expect(perms("for-contact.ts", "getContactLeads")).toEqual(["lead.read", "contact.read"]);
    expect(perms("create.ts", "createManualLead")).toEqual(["lead.edit"]);
    expect(perms("workflow.ts", "changeLeadStatus")).toEqual(["lead.edit"]);
  });

  it("every mutation runs in one transaction, holds and revalidates the actor in it, and locks in the contract order", () => {
    for (const [file, name] of [
      ["create.ts", "createManualLead"],
      ["workflow.ts", "changeLeadStatus"],
    ] as const) {
      const fn = exported(source(file)).find((f) => f.name === name)!;
      expect(fn.body.indexOf("db.transaction("), `${name} uses a transaction`).toBeGreaterThan(-1);
    }
    for (const file of ["create.ts", "workflow.ts"]) {
      const text = source(file);
      const tx = text.indexOf("db.transaction(");
      const actor = text.indexOf("holdActor(tx");
      const lock = text.indexOf("lockContact(tx");
      expect(actor, file).toBeGreaterThan(tx);
      expect(lock, file).toBeGreaterThan(actor);
    }
    const locks = source("locks.ts");
    expect(locks).toMatch(/\.for\("share"\)[\s\S]*revalidateActor\(tx, ctx, permission\)/);
    expect(locks).toMatch(/pg_advisory_xact_lock\(hashtextextended\(/);
    // the actor locks follow the staff-management order: ORGANIZATION (from the authenticated context) first, then the MEMBERSHIP
    const organization = locks.indexOf('.for("key share")');
    const membership = locks.indexOf('.for("share")');
    expect(organization).toBeGreaterThan(-1);
    expect(membership).toBeGreaterThan(organization);
    expect(locks.indexOf("revalidateActor(tx, ctx, permission)")).toBeGreaterThan(membership);
    expect(locks.slice(0, membership)).toMatch(/schema\.organizations[\s\S]*ctx\.organizationId/);
    expect(locks).not.toMatch(/\.for\("update"\)|\.for\("no key update"\)/); // never stronger than staff management's own lock
    // manual creation and status changes take only the contact lock and the lead row: never an attribution or decision row
    for (const file of ["create.ts", "workflow.ts"])
      expect(source(file), file).not.toMatch(
        /leadAttributions|leadReconcileDecisions|lead_attributions|lead_reconcile_decisions/,
      );
    // the lead row is locked FOR UPDATE by the status change; the contact row FOR SHARE by creation
    expect(source("workflow.ts")).toMatch(/\.for\("update"\)/);
    expect(source("create.ts")).toMatch(/\.for\("share"\)/);
  });

  it("every query is scoped by the caller's organization, which only ever comes from the AccessContext", () => {
    for (const file of [
      "list.ts",
      "detail.ts",
      "history.ts",
      "for-contact.ts",
      "create.ts",
      "workflow.ts",
      "items.ts",
      "attribution.ts",
    ])
      expect(source(file), file).toMatch(/ctx\.organizationId|organizationId/);
    for (const { file, text } of sources)
      expect(text, file).not.toMatch(
        /input\.(organizationId|orgId)|body\.organizationId|query\.organizationId/,
      );
    // statements that name the organization in their own WHERE clause
    for (const file of ["attribution.ts", "detail.ts", "for-contact.ts"]) {
      const statements = [...source(file).matchAll(/sql`([\s\S]*?)`/g)]
        .map((m) => m[1]!)
        .filter((q) =>
          /\bFROM\s+(leads|lead_events|lead_attributions|contacts|conversations|lead_reconcile_decisions)\b/i.test(
            q,
          ),
        );
      expect(statements.length, file).toBeGreaterThan(0);
      for (const q of statements)
        expect(q, `${file}: ${q.slice(0, 60)}`).toMatch(/organization_id\s*=\s*\$\{/);
    }
    // the shared item query, the history page and the list build their WHERE from fragments that start from the organization
    expect(source("items.ts")).toContain("l.organization_id = ${organizationId}::uuid");
    expect(source("history.ts")).toContain("e.organization_id = ${organizationId}::uuid");
    expect(source("list.ts")).toContain("selectLeadRows(db, ctx.organizationId");
    expect(source("for-contact.ts")).toContain("ctx.organizationId");
  });

  it("untrusted text is always passed through the safe-text functions before it leaves the module", () => {
    for (const file of ["items.ts", "attribution.ts", "history.ts", "detail.ts", "for-contact.ts"])
      expect(source(file), file).toMatch(/safeLine|safeText|contactLabel|displayLink|clickIdTail/);
    const attribution = source("attribution.ts");
    for (const column of [
      "headline",
      "body",
      "source_id",
      "source_url",
      "media_type",
      "media_url",
      "ctwa_clid",
    ])
      expect(attribution, column).toMatch(new RegExp(`r\\.${column}`));
    // provider_data is never selected, and the click id is only ever reduced to its tail
    expect(attribution).not.toMatch(/provider_data|providerData/);
    expect(attribution).toMatch(/clickIdTail\(r\.ctwa_clid\)/);
    expect(source("display.ts")).toContain("toWellFormed()");
    expect(source("display.ts")).not.toMatch(/u200d|u200c/i);
    expect(source("types.ts")).not.toMatch(/ctwa|clickId\b|providerData|storageKey/i);
  });

  it("no raw SQL error text reaches a client: database errors are mapped or become a generic 500", () => {
    expect(source("errors.ts")).toMatch(/isOpenLeadConflict/);
    for (const file of ["create.ts", "workflow.ts"]) {
      const text = source(file);
      expect(text, file).toMatch(/isOpenLeadConflict\(error\)/);
      expect(text, file).not.toMatch(/error\.message|\.message\b|String\(error\)/);
    }
  });
});

describe("lead routes", () => {
  it("are thin: one handleApi call per handler, no database, no environment, no business rules", () => {
    expect(routes.sort()).toEqual([
      "src/app/api/leads/[id]/events/route.ts",
      "src/app/api/leads/[id]/route.ts",
      "src/app/api/leads/[id]/status/route.ts",
      "src/app/api/leads/for-contact/[contactId]/route.ts",
      "src/app/api/leads/route.ts",
    ]);
    for (const f of routes) {
      const text = code(read(join(repo, f)));
      expect(text, f).toMatch(/handleApi\(/);
      expect(text, f).not.toMatch(/@\/db|process\.env|schema\.|assertCan|\bsql`|getDb/);
      expect(text, f).toMatch(/from "@\/modules\/leads"/);
      expect(text.length, f).toBeLessThan(1500);
    }
  });

  it("offer exactly the documented methods: reads are GET, mutations are same-origin POSTs, nothing writes history or attribution", () => {
    const methods = (f: string) =>
      [
        ...code(read(join(repo, f))).matchAll(
          /export async function (GET|POST|PUT|PATCH|DELETE)\b/g,
        ),
      ].map((m) => m[1]);
    expect(methods("src/app/api/leads/route.ts")).toEqual(["GET", "POST"]);
    expect(methods("src/app/api/leads/[id]/route.ts")).toEqual(["GET"]);
    expect(methods("src/app/api/leads/[id]/events/route.ts")).toEqual(["GET"]);
    expect(methods("src/app/api/leads/[id]/status/route.ts")).toEqual(["POST"]);
    expect(methods("src/app/api/leads/for-contact/[contactId]/route.ts")).toEqual(["GET"]);
    for (const f of routes) {
      const text = code(read(join(repo, f)));
      for (const m of text.matchAll(
        /export async function (GET|POST|PATCH|PUT|DELETE)\b[\s\S]*?handleApi\(\s*request,\s*\{\s*mutation:\s*(true|false)/g,
      ))
        expect(m[2], `${f} ${m[1]}`).toBe(m[1] === "GET" ? "false" : "true");
      expect(text, f).not.toMatch(/attribution|reconcile|decision/i);
    }
  });

  it("the public index exports no way to write attribution, history or a reserved status", () => {
    const index = source("index.ts");
    for (const name of [
      "createManualLead",
      "changeLeadStatus",
      "listLeads",
      "getLeadDetail",
      "listLeadEvents",
      "getContactLeads",
    ])
      expect(index).toContain(name);
    expect(index).not.toMatch(/linkTouch|unlink|insertEvent|appendEvent|reconcile/);
  });
});
