import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Security boundaries of the lead page (Phase 07D-3), in the style of ../boundaries.test.ts. Static: these lines prove what the
// source CAN do (no server code in the browser, one request path, no raw HTML, no link built from provider text, no mutation),
// not runtime behaviour (the unit and browser tests do that).

const repo = process.cwd();
const dir = "src/app/(app)/leads/[id]";
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

/** The server files: the page checks access and loads the lead, the two others are static. Everything else runs in the browser. */
const SERVER = new Set(["page.tsx", "not-found.tsx", "loading.tsx"]);
const browser = files.filter((f) => !SERVER.has(f.file));

describe("lead page code boundaries", () => {
  it("has exactly the reviewed files (a new file must be added here deliberately)", () => {
    expect(files.map((f) => f.file).sort()).toEqual([
      "lead-detail-app.tsx",
      "lead-detail-controller.ts",
      "lead-detail-sections.tsx",
      "lead-detail.ts",
      "lead-response.ts",
      "lead-status-control.tsx",
      "lead-status.ts",
      "loading.tsx",
      "not-found.tsx",
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

  it("browser files import only the leads page's own files, the inbox formatting, the UI kit, React and Next navigation", () => {
    const allowed = (from: string, typeOnly: boolean) =>
      from.startsWith("./") ||
      [
        "../lead-api",
        "../lead-errors",
        "../lead-filters",
        "../lead-labels",
        "../lead-list",
      ].includes(from) ||
      from === "../../inbox/format" ||
      from.startsWith("@/components/ui/") ||
      ["react", "next/link", "lucide-react"].includes(from) ||
      (typeOnly && from.startsWith("@/modules/"));
    for (const { file, text: t } of browser)
      for (const i of imports(t))
        expect(allowed(i.from, i.typeOnly), `${file} imports ${i.from}`).toBe(true);
  });

  it("the interactive files are client components; the page is a server component that authorizes before loading", () => {
    for (const f of ["lead-detail-app.tsx", "lead-detail-sections.tsx", "lead-status-control.tsx"])
      expect(readFileSync(join(repo, dir, f), "utf8").startsWith('"use client";'), f).toBe(true);
    const page = text("page.tsx");
    expect(page).not.toMatch(/"use client"/);
    expect(page.indexOf("getPageAccess(")).toBeLessThan(page.indexOf("getLeadDetail("));
    expect(page.indexOf('ctx.can("lead.read")')).toBeLessThan(page.indexOf("getLeadDetail("));
    expect(page).toMatch(/instanceof NotFoundError\)\s*notFound\(\)/);
    // the organization is the session's: nothing from the URL or the browser decides it
    expect(page).not.toMatch(/organizationId:\s*(id|params|searchParams)/);
    for (const i of imports(page))
      expect(
        [
          "next",
          "next/navigation",
          "@/lib/request-headers",
          "@/modules/access",
          "@/modules/leads",
          "@/shared/errors/http-errors",
          "../lead-filters",
          "./lead-detail-app",
          "./lead-detail",
        ],
        `page.tsx imports ${i.from}`,
      ).toContain(i.from);
  });

  it("the page declares its actor before any request, and an actor change blocks it", () => {
    const app = text("lead-detail-app.tsx");
    expect(app.indexOf("useLayoutEffect(")).toBeLessThan(app.indexOf("createDetailController("));
    expect(app).toMatch(/useLayoutEffect\(\(\) => \{\s*setPageActor\(/);
    expect(app).toMatch(/subscribeActorChanged/);
    expect(app).toMatch(/if \(actorChanged\) controller\.block\(\)/);
    expect(app).toMatch(/isActorChanged: getActorChanged/);
    expect(app).toMatch(/useEffect\(\(\) => \(\) => controller\.cancel\(\)/);
  });

  it("every response is checked against the current request, and against the lead", () => {
    const ctl = text("lead-detail-controller.ts");
    expect(ctl).toMatch(
      /const isCurrent = \(mine: number\) => mine === sequence && !state\.blocked/,
    );
    expect((ctl.match(/if \(!isCurrent\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(ctl).toMatch(/detail\.lead\.id !== leadId/);
  });

  it("makes no request of its own: no fetch, XMLHttpRequest or beacon, and no direct use of the shared client", () => {
    for (const { file, text: t } of files) {
      expect(t, file).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource/);
      expect(t, file).not.toMatch(/\bapi(<[^>]*>)?\(/);
    }
    // the only calls the page's UI makes are the two reads of the lead API wrappers
    const app = text("lead-detail-app.tsx");
    expect(app).toMatch(/fetchLeadDetail\(/);
    expect(app).toMatch(/fetchLeadEvents\(/);
    // creating a lead and the list read are not part of this page; the status change and the open-lead lookup are, and only here
    expect(app).not.toMatch(/\bcreateLead\(|\bfetchLeadPage\(/);
    expect(app.match(/\bchangeLeadStatus\(/g)).toHaveLength(1);
    expect(app.match(/\bfetchContactLeads\(/g)).toHaveLength(1);
    for (const { file, text: t } of files)
      if (file !== "lead-detail-app.tsx")
        expect(t, file).not.toMatch(/\bchangeLeadStatus\(|\bcreateLead\(/);
  });

  it("no mutation, sending, environment, storage, raw HTML or dynamic code anywhere on the page", () => {
    for (const { file, text: t } of files) {
      expect(t, file).not.toMatch(
        /process\.env|localStorage|sessionStorage|indexedDB|document\.cookie/,
      );
      expect(t, file).not.toMatch(
        /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function\(/,
      );
      expect(t, file).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"|<form\b|onSubmit/);
      expect(t, file).not.toMatch(
        /\/api\/conversations|\/messages\b|outbound|graph\.facebook|idempotency|submitPending/i,
      );
      expect(t, file).not.toMatch(/setTimeout|setInterval/);
    }
  });

  it("builds a link only from ids and validated filters: provider text never reaches an href, src, window.open or a redirect", () => {
    for (const { file, text: t } of files) {
      expect(t, file).not.toMatch(/window\.open|<a\b|<img\b|<iframe\b|<object\b|<embed\b|target=/);
      // every href is one of the page's own constants or builders
      for (const m of t.matchAll(/href=\{([^}]*)\}/g))
        expect(m[1], `${file}: href`).toMatch(
          /^(backHref|inboxConversationPath\(c\.id\)|signInHref|openLeadHref\(notice\.openLeadId\)|"\/leads")$/,
        );
    }
    const sections = text("lead-detail-sections.tsx");
    expect(sections).not.toMatch(/touch\.(sourceLink|mediaLink)[^;]*href/);
  });

  it("does not decide authorization or tenancy in the browser: an organization id appears only in the actor declaration", () => {
    for (const { file, text: t } of files)
      if (file !== "page.tsx" && file !== "lead-detail-app.tsx")
        expect(t, file).not.toMatch(/organizationId|organization_id|membershipId/);
    const rest = text("lead-detail-app.tsx")
      .replace(/organizationId: string/g, "")
      .replace(/organizationId: me\.organizationId/g, "")
      .replace(/me\.organizationId/g, "");
    expect(rest).not.toMatch(/organizationId/);
  });

  it("status management: the revision sent is the decision's own (never read again, never incremented), nothing retries, the dialog is controlled", () => {
    const ctl = text("lead-detail-controller.ts");
    expect(ctl).toMatch(/expectedRevision:\s*decision\.revision/);
    expect(ctl).not.toMatch(/revision\s*\+\s*1|revision\+\+|\+\+\s*\w*revision/i);
    expect(ctl).not.toMatch(/setTimeout|setInterval|for\s*\(\s*let\s+attempt/);
    // a decision whose revision is not the one shown is never sent
    expect(ctl).toMatch(/decision\.revision !== state\.detail\.lead\.revision/);
    // a change in flight is never superseded by a read, and a read is the only follow-up
    expect(ctl).toMatch(/if \(state\.phase === "changing"\) return/);
    expect(ctl.match(/init\s*\.changeStatus\(/g)).toHaveLength(1);
    const control = text("lead-status-control.tsx");
    expect(control).toMatch(/<AlertDialog\s+open=\{confirmOpen\}/);
    expect(control).not.toMatch(/AlertDialogTrigger/);
    // the confirm button does not close the dialog by itself: only the controller's state does
    expect(control).toMatch(/onClick=\{\(\) => controller\.confirm\(\)\}/);
    // busy controls keep focus: aria-disabled, not disabled, on the buttons the person just used
    expect(control).toMatch(/aria-disabled=\{!canSubmit\}/);
    expect(control).toMatch(/aria-disabled=\{changing\}/);
  });
});
