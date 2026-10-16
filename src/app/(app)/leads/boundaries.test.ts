import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Security boundaries of the browser-side lead code (Phases 07D-1 and 07D-2), in the style of src/modules/inbox/boundaries.test.ts.
// Static: these lines prove what the source CAN do (no server code in the browser, one request path, no raw HTML, no sending),
// not runtime behaviour (the unit and browser tests do that).

const repo = process.cwd();
const dir = "src/app/(app)/leads";
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const files = readdirSync(join(repo, dir))
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.ts$/.test(f))
  .map((f) => ({ file: f, text: code(readFileSync(join(repo, dir, f), "utf8")) }));
const text = (f: string) => files.find((x) => x.file === f)!.text;
const imports = (t: string) =>
  [...t.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+"([^"]+)"/gm)].map((m) => ({
    typeOnly: Boolean(m[2]),
    from: m[3]!,
  }));

/** The one server file: it checks access and renders the first page on the server. Everything else runs in the browser. */
const SERVER = new Set(["page.tsx"]);
const browser = files.filter((f) => !SERVER.has(f.file));

describe("browser lead code boundaries", () => {
  it("has exactly the reviewed files (a new file must be added here deliberately)", () => {
    expect(files.map((f) => f.file).sort()).toEqual([
      "lead-api.ts",
      "lead-errors.ts",
      "lead-filter-toolbar.tsx",
      "lead-filters.ts",
      "lead-labels.ts",
      "lead-list.ts",
      "lead-page-controller.ts",
      "lead-table.tsx",
      "leads-app.tsx",
      "loading.tsx",
      "page.tsx",
    ]);
  });

  it("browser files take only TYPES from modules (their runtime exports carry server code), and nothing from the database", () => {
    for (const { file, text: t } of browser)
      for (const i of imports(t)) {
        if (i.from.startsWith("@/modules/"))
          expect(i.typeOnly, `${file}: runtime import of ${i.from}`).toBe(true);
        expect(i.from, file).not.toMatch(
          /^@\/db|^@\/modules\/[^/]+\/|^pg$|^drizzle-orm|server-only|node:|^@\/lib\/request-headers/,
        );
      }
  });

  it("browser files import only their own files, the shared inbox client and formatting, the UI kit, React and Next navigation", () => {
    const allowed = (from: string, typeOnly: boolean) =>
      from.startsWith("./") ||
      from === "../inbox/api" ||
      from === "../inbox/format" ||
      from.startsWith("@/components/ui/") ||
      ["react", "next/navigation", "next/link", "lucide-react"].includes(from) ||
      (typeOnly && from.startsWith("@/modules/"));
    for (const { file, text: t } of browser)
      for (const i of imports(t))
        expect(allowed(i.from, i.typeOnly), `${file} imports ${i.from}`).toBe(true);
  });

  it("interactive files are client components; the page is a server component that authorizes before loading", () => {
    for (const f of ["leads-app.tsx", "lead-filter-toolbar.tsx", "lead-table.tsx"])
      expect(readFileSync(join(repo, dir, f), "utf8").startsWith('"use client";'), f).toBe(true);
    const page = text("page.tsx");
    expect(page).not.toMatch(/"use client"/);
    expect(page.indexOf("getPageAccess(")).toBeLessThan(page.indexOf("listLeads("));
    expect(page.indexOf('ctx.can("lead.read")')).toBeLessThan(page.indexOf("listLeads("));
    for (const i of imports(page))
      expect(
        [
          "next",
          "next/navigation",
          "@/lib/request-headers",
          "@/modules/access",
          "@/modules/leads",
          "./lead-filters",
          "./leads-app",
        ],
        `page.tsx imports ${i.from}`,
      ).toContain(i.from);
  });

  it("the page declares its actor before any request, and an actor change blocks it", () => {
    const app = text("leads-app.tsx");
    expect(app.indexOf("useLayoutEffect(")).toBeLessThan(app.indexOf("createLeadsController("));
    expect(app).toMatch(/useLayoutEffect\(\(\) => \{\s*setPageActor\(/);
    expect(app).toMatch(/subscribeActorChanged/);
    expect(app).toMatch(/if \(actorChanged\) controller\.block\(\)/);
    expect(app).toMatch(/isActorChanged: getActorChanged/);
  });

  it("makes no request of its own: no fetch, XMLHttpRequest or beacon; only lead-api.ts calls the shared client", () => {
    for (const { file, text: t } of files) {
      expect(t, file).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource/);
      if (file !== "lead-api.ts") expect(t, file).not.toMatch(/\bapi(<[^>]*>)?\(/);
    }
  });

  it("lead-api.ts reaches only /api/leads endpoints and nothing reaches a sending path", () => {
    const api = text("lead-api.ts");
    const paths = [...api.matchAll(/`(\/api\/[^`$?]*)|"(\/api\/[^"]*)"/g)].map((m) => m[1] ?? m[2]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p).toMatch(/^\/api\/leads(\/|$)/);
    for (const { file, text: t } of files)
      expect(t, file).not.toMatch(
        /\/api\/conversations|\/messages\b|outbound|graph\.facebook|idempotency|submitPending/i,
      );
  });

  it("no environment, storage, raw HTML or dynamic code in the browser files", () => {
    for (const { file, text: t } of browser) {
      expect(t, file).not.toMatch(
        /process\.env|localStorage|sessionStorage|indexedDB|document\.cookie/,
      );
      expect(t, file).not.toMatch(
        /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function\(/,
      );
    }
  });

  it("does not decide authorization or tenancy: an organization id appears only in the page's actor declaration", () => {
    for (const { file, text: t } of files)
      if (file !== "page.tsx" && file !== "leads-app.tsx")
        expect(t, file).not.toMatch(/organizationId|organization_id|membershipId/);
    // leads-app.tsx: only the actor it was rendered for (its prop type and `me.organizationId`), handed to the shared client and
    // sent as an ASSERTION, never as a filter or a request field
    const rest = text("leads-app.tsx")
      .replace(/organizationId: string/g, "")
      .replace(/organizationId: me\.organizationId/g, "")
      .replace(/me\.organizationId/g, "");
    expect(rest).not.toMatch(/organizationId/);
  });

  it("only the two documented mutations exist, nothing retries, and timers exist only for the search debounce", () => {
    const api = text("lead-api.ts");
    expect(api.match(/method: "POST"/g)).toHaveLength(2);
    expect(api).not.toMatch(/method: "(PUT|PATCH|DELETE)"/);
    for (const { file, text: t } of files) {
      expect(t, file).not.toMatch(
        /\bretry\s*\(\s*\)\s*;?\s*\}\s*,\s*\d|for\s*\(\s*let\s+attempt|setInterval/,
      );
      if (file !== "leads-app.tsx") expect(t, file).not.toMatch(/setTimeout/);
    }
    expect(text("leads-app.tsx").match(/setTimeout\(/g)).toHaveLength(1);
    // the page makes no mutation at all in 07D-2: no create or status call is imported by the page's UI
    for (const f of ["leads-app.tsx", "lead-filter-toolbar.tsx", "lead-table.tsx"])
      expect(text(f), f).not.toMatch(/\bcreateLead\(|\bchangeLeadStatus\(/);
  });
});
