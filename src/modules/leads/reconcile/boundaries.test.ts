import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Structural guards for the lead reconciler (Phase 07C): it reads confirmed Meta ad evidence that Phase 04 already stored, links or
// creates leads, and NEVER sends, calls Meta, schedules itself, starts on import, changes evidence or touches another module.

const root = new URL(".", import.meta.url).pathname;
const repo = join(root, "../../../..");
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

describe("reconciler boundaries", () => {
  it("has exactly the expected production files", () => {
    expect(sources.map((s) => s.file).sort()).toEqual([
      "bounded.ts",
      "cli.ts",
      "config.ts",
      "failure.ts",
      "index.ts",
      "policy.ts",
      "process.ts",
      "run.ts",
      "scan.ts",
    ]);
  });

  it("cannot send, fetch or reach Meta: no network, outbound, queue, environment or logging code", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /\bfetch\s*\(|node:https?|undici|axios|graph\.facebook\.com|XMLHttpRequest/,
      );
      expect(text, file).not.toMatch(
        /submitOutboundMessage|MetaTransport|OutboundTransport|dispatchBatch/,
      );
      expect(text, file).not.toMatch(
        /outboundRequests|outbound_requests|webhookEvents|webhook_events|webhookRequests/,
      );
      expect(text, file).not.toMatch(/process\.env/); // configuration arrives as an object
      expect(text, file).not.toMatch(
        /console\.(?!log|error)|logger\.|emitWebhookLog|emitSecurityEvent/,
      );
    }
    // the only printing is the CLI's report line and its fixed explanations
    for (const { file, text } of sources)
      if (file !== "cli.ts") expect(text, file).not.toMatch(/console\./);
  });

  it("depends on no other module and no staff concept: only the database, the leads internals it shares, and drizzle", () => {
    for (const { file, text } of sources) {
      const imports = [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
      for (const i of imports)
        expect(
          i === "@/db" ||
            i === "drizzle-orm" ||
            i.startsWith("./") ||
            ["../errors", "../locks", "../cursor"].includes(i),
          `${file} imports ${i}`,
        ).toBe(true);
      expect(text, file).not.toMatch(
        /@\/modules\/|membership|AccessContext|assertCan|revalidateActor|actor/i,
      );
    }
  });

  it("writes only leads, lead history, the link of a touch and decisions: never contacts, messages, conversations, consent or evidence", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /\.(insert|update|delete)\(\s*schema\.(?!leads\b|leadEvents\b|leadAttributions\b|leadReconcileDecisions\b)/,
      );
      expect(text, file).not.toMatch(
        /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(contacts|contact_|messages|conversations|whatsapp_|tags|organization|lead_attributions)/i,
      );
    }
    const process = source("process.ts");
    // the only change to a touch is its link, nothing else of the evidence
    const updates = [
      ...process.matchAll(/\.update\(\s*schema\.leadAttributions\s*\)\s*\.set\(\s*(\{[^}]*\})/g),
    ].map((m) => m[1]);
    expect(updates).toEqual(["{ leadId }"]);
    expect(process).not.toMatch(/\.delete\(\s*schema\.(?!leadReconcileDecisions)/);
    expect(process).not.toMatch(/\.delete\(\s*schema\.leadEvents|\.update\(\s*schema\.leadEvents/);
    // history written: CREATED (AD_REFERRAL) and TOUCH_LINKED only, never a STATUS row
    expect(process).toMatch(/kind: "CREATED"[\s\S]*origin: "AD_REFERRAL"/);
    expect(process).toMatch(/kind: "TOUCH_LINKED"/);
    expect(process).not.toMatch(/kind: "STATUS"|MANUAL/);
    // a created lead is NEW at revision 0, names its touch, and takes no cycle start from the writer
    expect(process).toMatch(
      /status: "NEW"[\s\S]*revision: 0[\s\S]*initiatingAttributionId: c\.attributionId/,
    );
    const leadInsert = process.slice(
      process.indexOf(".insert(schema.leads)"),
      process.indexOf(".returning({ id: schema.leads.id })"),
    );
    expect(leadInsert).toContain("initiatingAttributionId");
    expect(leadInsert).not.toMatch(/cycleStartedAt|closedAt/); // the database derives the cycle start from the touch
    expect(process).not.toMatch(/closedAt/);
    expect(process).not.toMatch(/\.update\(\s*schema\.leads\s*\)/); // an existing lead is never changed by the reconciler
    // decisions are only the six the schema defines, and never written for a linked touch (the database also refuses it)
    expect(source("failure.ts")).not.toMatch(/PARKED[\s\S]*SKIPPED/);
  });

  it("locks in the contract order and WAITS FOR NOTHING: organization, TRIED contact lock, contact, lead, touch, decision, history, all NOWAIT", () => {
    const text = source("process.ts");
    const at = (needle: string) => {
      const i = text.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      "enterContact(tx",
      ".from(schema.contacts)",
      '.for("share", { noWait: true })',
      ".from(schema.leads)",
      '.for("update", { noWait: true })',
      "FOR UPDATE OF a NOWAIT",
      "FROM lead_reconcile_decisions",
      "FOR UPDATE NOWAIT",
      "afterLockTime(tx)",
      "tx.insert(schema.leadEvents)",
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // the organization is locked FOR KEY SHARE without waiting, and the contact lock is only TRIED
    expect(text).toMatch(
      /\.from\(schema\.organizations\)[\s\S]*\.for\("key share", \{ noWait: true \}\)[\s\S]*pg_try_advisory_xact_lock/,
    );
    // no row lock of the handling transaction can wait: every FOR UPDATE / FOR SHARE in it is NOWAIT
    for (const m of text.matchAll(/FOR (UPDATE|SHARE|KEY SHARE|NO KEY UPDATE)\b[^`]*/g))
      expect(m[0], m[0]).toMatch(/NOWAIT/);
    for (const m of text.matchAll(/\.for\("[a-z ]+"(, \{[^}]*\})?\)/g))
      expect(m[0], m[0]).toContain("noWait: true");
    // the ONLY blocking lock in the module is the failure recorder's, and it is bounded by lock_timeout
    for (const { file, text: t } of sources) {
      if (file === "failure.ts") expect(t).toMatch(/pg_advisory_xact_lock\(/);
      else expect(t, file).not.toMatch(/pg_advisory_xact_lock\(/);
      expect(t, file).not.toMatch(/\.for\("update"\)[\s\S]*pg_try_advisory/);
    }
    // the touch row is never locked before the contact lock: the scan locks no attribution, lead, decision, contact or message row
    // and no advisory lock. The ONE lock it takes is the organization row, FOR KEY SHARE ... SKIP LOCKED (never waited for), inside
    // its own short transaction (it ends before any candidate is handled)
    const scanSource = source("scan.ts");
    expect(scanSource).not.toMatch(/\.for\(/); // no query-builder lock: only the statement below
    const query = scanSource.slice(
      scanSource.indexOf("export function candidateQuery"),
      scanSource.indexOf("export async function scanCandidates"),
    );
    // exactly ONE locking clause in the whole candidate statement, and it is the organization row, never waited for
    expect(query.match(/\bFOR\s+(UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b/gi)).toHaveLength(1);
    expect(query).toMatch(
      /EXISTS \(SELECT 1 FROM organizations o WHERE o\.id = a\.organization_id FOR KEY SHARE SKIP LOCKED\)/,
    );
    expect(query).not.toMatch(/NOWAIT|pg_try_advisory|pg_advisory/i);
    // it sits BEFORE the ORDER BY / LIMIT in the statement: a filter, so a skipped organization never uses the limit
    expect(query.indexOf("FOR KEY SHARE SKIP LOCKED")).toBeLessThan(query.indexOf("ORDER BY"));
    expect(query.indexOf("ORDER BY")).toBeLessThan(query.lastIndexOf("LIMIT"));
    // and nothing of the retired probe is left
    for (const { file, text } of sources)
      expect(text, file).not.toMatch(
        /organizationAvailable|organizationProbeLimit|organizationsUnavailable|deferredByOrganization/,
      );
    // a failure is recorded under the same order, touch before decision, contact lock before both
    const whole = source("failure.ts");
    const failure = whole.slice(whole.indexOf("export async function recordFailureIn"));
    expect(failure.indexOf("pg_advisory_xact_lock(")).toBeLessThan(
      failure.indexOf("FROM lead_attributions"),
    );
    expect(failure.indexOf("FROM lead_attributions")).toBeLessThan(
      failure.indexOf("FROM lead_reconcile_decisions"),
    );
  });

  it("EVERY database interaction is bounded by PostgreSQL's own timeouts: nothing talks to the database except through bounded()", () => {
    for (const { file, text } of sources) {
      if (file === "bounded.ts") continue;
      expect(text, file).not.toMatch(/\bdb\.(execute|transaction|select|insert|update|delete)\(/);
      expect(text, file).not.toMatch(/\bdatabase\.db\.(execute|transaction)\(/);
    }
    const bounded = source("bounded.ts");
    expect(bounded).toContain("set_config('lock_timeout'");
    expect(bounded).toContain("set_config('statement_timeout'");
    expect(bounded).toMatch(/, true\)/); // is_local: they end with the transaction and never stay on a pooled connection
    expect(bounded).not.toMatch(/set_config\([^)]*, false\)|SET SESSION|\bSET\s+(?!LOCAL)/i);
    for (const file of ["scan.ts", "process.ts", "failure.ts", "cli.ts"])
      expect(source(file), file).toContain("bounded(");
    expect(source("scan.ts").match(/bounded\(/g)!.length).toBe(2); // the scan and the count
    // no JavaScript timer stands in for them
    for (const { file, text } of sources)
      expect(text, file).not.toMatch(/Promise\.race|AbortSignal\.timeout/);
  });

  it("only INBOUND messages qualify, in every place a touch is read: the scan, the count, handling, failure recording and the hold", () => {
    // the scan, the due count, and the waiting and parked counts (a decision of an outbound-tied touch is never work)
    expect(source("scan.ts").match(/\bm\.direction = 'INBOUND'/g)!.length).toBe(4);
    expect(source("scan.ts")).toContain("em.direction = 'INBOUND'"); // the hold's earlier touches
    expect(source("process.ts")).toMatch(/m\.direction = 'INBOUND'/);
    expect(source("process.ts")).toMatch(/em\.direction = 'INBOUND'/); // the policy hold
    expect(source("process.ts")).toMatch(/!touch\.inbound/);
    expect(source("failure.ts")).toMatch(/m\.direction = 'INBOUND'/);
    expect(source("failure.ts")).toMatch(/!touch\.rows\[0\]\.inbound/);
  });

  it("the message must belong to the touch's OWN contact, through its conversation, in the same places", () => {
    // scan probe + the three counts use alias c; the hold's earlier touches use ec
    expect(source("scan.ts").match(/AND c\.contact_id = a\.contact_id/g)!.length).toBe(4);
    expect(source("scan.ts")).toContain("AND ec.contact_id = e.contact_id");
    expect(
      source("scan.ts").match(
        /JOIN conversations c ON c\.organization_id = m\.organization_id AND c\.id = m\.conversation_id/g,
      )!.length,
    ).toBe(4);
    expect(source("process.ts")).toContain(
      "m.direction = 'INBOUND' AND c.contact_id = a.contact_id",
    );
    expect(source("process.ts")).toContain("AND ec.contact_id = e.contact_id");
    expect(source("failure.ts")).toContain(
      "m.direction = 'INBOUND' AND c.contact_id = a.contact_id",
    );
    for (const file of ["process.ts", "failure.ts"])
      expect(source(file), file).toContain(
        "LEFT JOIN conversations c ON c.organization_id = m.organization_id AND c.id = m.conversation_id",
      );
  });

  it("the first-consideration time comes only from the database clock inside the attempt and goes only to failure recording: no input, no JavaScript clock", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/Date\.now\(|new Date\(/);
      expect(text, file).not.toMatch(/process\.argv|env\.[A-Z_]*(FIRST|ANCHOR|CONSIDER)/i);
    }
    expect(source("bounded.ts")).toContain("clock_timestamp()::text AS t");
    expect(source("process.ts")).toMatch(/trace\.firstConsideredAt = anchor/);
    expect(source("process.ts")).toMatch(/SELECT clock_timestamp\(\)::text AS t/);
    expect(source("process.ts")).toMatch(/recordFailureIn\(savepoint, c, code, anchor, prior\)/);
    expect(source("run.ts")).toMatch(/recordFailure\(db, candidate, code, options, trace\)/);
    expect(source("failure.ts")).toMatch(/firstConsideredAt \?\? startedAt/);
    // configuration cannot carry it
    expect(source("config.ts")).not.toMatch(/consider|anchor/i);
    expect(read(join(repo, "scripts/leads-reconcile.ts"))).not.toMatch(/consider|anchor/i);
  });

  it("a failure is recorded INSIDE the attempt's transaction: locks before the savepoint, rollback to it, the recording, one COMMIT", () => {
    const text = source("process.ts");
    const at = (needle: string) => {
      const i = text.indexOf(needle, text.indexOf("export async function processCandidate"));
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      "await enterContact(tx, c)", // organization lock and the contact's advisory lock: before the savepoint
      "SELECT clock_timestamp()::text AS t", // the first-consideration instant, with the contact held
      "tx.transaction(async (savepoint)", // the savepoint around the fallible work
      "await handle(savepoint",
      "SET CONSTRAINTS ALL IMMEDIATE", // deferred history triggers fire INSIDE the savepoint
      "recordFailureIn(savepoint, c, code, anchor, prior)", // after the rollback to the savepoint, in the same outer transaction
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // there is exactly one transaction around the attempt: the recording is not a second bounded() call
    const body = text.slice(text.indexOf("export async function processCandidate"));
    expect(body.match(/bounded\(/g)!.length).toBe(1);
    // the fallible work never takes the contact lock itself (it could not be kept across the rollback)
    expect(
      source("process.ts").slice(source("process.ts").indexOf("async function handle(")),
    ).not.toMatch(/pg_try_advisory_xact_lock|pg_advisory_xact_lock|enterContact\(/);
  });

  it("scans by keyset on (received_at, id), takes confirmed Meta ads with a message only, and excludes decided touches in the query itself", () => {
    const scan = source("scan.ts");
    expect(scan).toContain(
      "a.lead_id IS NULL AND a.source_type = 'META_AD' AND a.message_id IS NOT NULL",
    );
    expect(scan).toContain("ORDER BY a.received_at, a.id");
    expect(scan).toMatch(/\(a\.received_at, a\.id\) > \(/);
    expect(scan).toMatch(
      /d\.attribution_id IS NULL OR \(d\.decision = 'RETRY' AND d\.next_attempt_at <= clock_timestamp\(\)\)/,
    );
    expect(scan).toMatch(/LIMIT \$\{limit\}/);
    // handling re-reads eligibility: the touch must still be unlinked, a Meta ad with a message, and not decided
    const process = source("process.ts");
    expect(process).toMatch(/touch\.lead_id !== null \|\|\s*touch\.source_type !== "META_AD"/);
    expect(process).toContain("existing && !existing.due");
  });

  it("is never started by anything but the command: not exported from the leads module, not imported by the application, not scheduled", () => {
    const leadsIndex = code(read(join(repo, "src/modules/leads/index.ts")));
    expect(leadsIndex).not.toMatch(/reconcile/i);
    for (const f of walk("src").filter((x) => !x.startsWith("src/modules/leads/reconcile/")))
      expect(read(join(repo, f)), f).not.toMatch(/leads\/reconcile/);
    // only the script imports it, and it is a package script, never a hook of install, build, start, dev or test
    const importers = walk("scripts").filter((f) => /leads\/reconcile/.test(read(join(repo, f))));
    expect(importers).toEqual(["scripts/leads-reconcile.ts"]);
    const pkg = JSON.parse(read(join(repo, "package.json"))) as { scripts: Record<string, string> };
    expect(pkg.scripts["leads:reconcile"]).toBe(
      "tsx --env-file-if-exists=.env.local scripts/leads-reconcile.ts",
    );
    for (const hook of [
      "preinstall",
      "install",
      "postinstall",
      "prebuild",
      "postbuild",
      "prestart",
      "poststart",
      "predev",
      "pretest",
      "posttest",
      "prepare",
    ])
      expect(JSON.stringify(pkg.scripts[hook] ?? ""), hook).not.toMatch(/reconcile/);
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /setInterval|setTimeout|node-cron|\bcron\b|\bschedule\(|scheduler/i,
      );
      // nothing runs when the module is imported: no top-level call
      expect(
        text.split("\n").filter((l) => /^(void |await )?run[A-Z]\w*\(/.test(l)),
        file,
      ).toEqual([]);
    }
    const script = code(read(join(repo, "scripts/leads-reconcile.ts")));
    expect(script).toMatch(/runReconcileCli\(\{ env: process\.env \}\)/);
    expect(script).not.toMatch(/setInterval|setTimeout|\bcron\b|\bschedule|while \(|for \(;;\)/);
    // the gate is in the configuration, not in the script, and is checked before the database is opened
    const cli = source("cli.ts");
    expect(cli.indexOf("readReconcileConfig(")).toBeLessThan(
      cli.indexOf("(options.createDatabase ?? defaultDatabase)"),
    );
    expect(source("config.ts")).toContain("LEADS_RECONCILER_ENABLED");
    // it never runs inside the Next.js request process: no Next import anywhere in the module
    for (const { file, text } of sources)
      expect(text, file).not.toMatch(/from "next|next\/server|NextRequest/);
  });

  it("shows no value in a log or a report: the report type carries counts, fixed words and fixed codes only", () => {
    const run = source("run.ts");
    expect(run).not.toMatch(
      /contactId|attributionId|organizationId|leadId/i.source
        ? /report\s*=\s*\{[^}]*(contactId|attributionId|organizationId|leadId)/
        : /x/,
    );
    const report = run.slice(
      run.indexOf("export type ReconcileReport"),
      run.indexOf("export type RunHooks"),
    );
    for (const word of [
      "contact",
      "attribution",
      "organization",
      "lead",
      "wamid",
      "profile",
      "headline",
      "phone",
    ])
      expect(report.replace(/leads\.reconcile|remaining|linked|created/gi, ""), word).not.toMatch(
        new RegExp(`\\b${word}(Id|Name|Url)\\b`, "i"),
      );
    expect(report).toContain("readonly errors: Readonly<Record<string, number>>");
  });

  it("the documents state the APPROVED first-touch policy and the real timeout behaviour, and no longer call the policy proposed", () => {
    const docs = [
      "docs/adr/0016-leads-and-ad-attribution.md",
      "docs/PRE_PRODUCTION_BLOCKERS.md",
      "docs/RUNBOOK_WHATSAPP.md",
      "docs/ARCHITECTURE.md",
      "docs/SECURITY.md",
      "docs/TESTING_STRATEGY.md",
    ].map((d) => ({ d, text: read(join(repo, d)) }));
    for (const { d, text } of docs) {
      // every line that speaks of the first-touch hold: never "proposed", "pending", "not yet approved" or "to be confirmed"
      for (const line of text.split("\n").filter((l) => /first-touch|15 minutes/i.test(l)))
        expect(line, d).not.toMatch(
          /\bproposed\b|pending approval|not yet approved|unapproved|to be confirmed|confirm or change/i,
        );
    }
    const adr = docs[0]!.text;
    expect(adr).toMatch(/First-touch policy \(APPROVED/);
    const blockers = docs[1]!.text;
    expect(blockers).toMatch(/First-touch hold: approved/);
    expect(blockers).not.toMatch(/PROPOSED, not yet approved/);
    // timeouts: processing waits for nothing, failure recording may wait (bounded), the count is bounded, the budget stops new work
    for (const { d, text } of [docs[0]!, docs[2]!]) {
      expect(text, d).toMatch(/lock_timeout|lock timeout/);
      expect(text, d).toMatch(/NOWAIT|waits for no lock/);
      expect(text, d).toMatch(
        /no guaranteed (processing latency|maximum elapsed retry delay)|not a guaranteed/i,
      );
    }
    expect(adr).toMatch(/Recording a failure is the one place that may WAIT/);
    expect(adr).toMatch(/final remaining-work count also runs/);
    // no scheduler, not production-ready, residual fairness limits
    for (const { d, text } of [docs[0]!, docs[1]!, docs[2]!]) {
      expect(text, d).toMatch(/no scheduler|No schedule|no schedule/i);
      expect(text, d).toMatch(/not production-ready|NOT production-ready/i);
    }
    expect(adr).toMatch(/Universal fairness is NOT claimed/);
  });

  it("third review: the documents state the ambiguous-COMMIT rule, the budget as admission control and the scan-level organization lock with its honest limits", () => {
    const adr = read(join(repo, "docs/adr/0016-leads-and-ad-attribution.md"));
    const runbook = read(join(repo, "docs/RUNBOOK_WHATSAPP.md"));
    const blockers = read(join(repo, "docs/PRE_PRODUCTION_BLOCKERS.md"));
    expect(adr).toMatch(/ambiguous COMMIT is unknown, never assumed rolled back/i);
    expect(adr).toMatch(/at most one attempt/);
    expect(adr).toMatch(/admit work; they are not a deadline/);
    // M3: the scan-level lock, what it holds, the removed fields, the conditional guarantee
    expect(adr).toMatch(/FOR KEY SHARE \.\.\. SKIP LOCKED/);
    expect(adr).toMatch(/a number that cannot be measured is not reported/);
    expect(adr).toMatch(/Rows examined, candidates returned, touches processed/);
    expect(adr).toMatch(/conditional fairness guarantee/i);
    expect(adr).toMatch(/Not claimed:\*\* universal starvation freedom/);
    expect(runbook).toMatch(/admission control, not a deadline/);
    expect(runbook).toMatch(/failuresUncertain/);
    expect(runbook).toMatch(/the report has no count of unavailable organizations/);
    expect(blockers).toMatch(/\| 74 .*CLOSED LOCALLY, pending independent review/);
    expect(blockers).toMatch(/\| 71 .*Not claimed:\*\* universal starvation freedom/);
    // the retired probe is not described as a current mechanism anywhere
    for (const [d, text] of [
      ["adr", adr],
      ["runbook", runbook],
    ] as const)
      expect(text, d).not.toMatch(
        /organizationProbeLimit|probes each organization|is probed without waiting/,
      );
  });

  it("the attempt observes the touch's state under the contact lock BEFORE the savepoint, and the fallback records only against that state", () => {
    const process = source("process.ts");
    expect(process.indexOf("observeState(tx, c)")).toBeGreaterThan(
      process.indexOf("await enterContact(tx, c)"),
    );
    expect(process.indexOf("observeState(tx, c)")).toBeLessThan(
      process.indexOf("tx.transaction(async (savepoint)"),
    );
    expect(source("run.ts")).toMatch(/recordFailure\(db, candidate, code, options, trace\)/);
    const failure = source("failure.ts");
    expect(failure).toMatch(/kind: "changed"/);
    expect(failure).toMatch(/kind: "unknown"/);
    // admission: asked before every page, probe and candidate
    expect((source("run.ts").match(/stopBefore\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
