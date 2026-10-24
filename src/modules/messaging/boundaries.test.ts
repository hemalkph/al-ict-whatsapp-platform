import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Structural guards for outbound messaging: where network I/O can happen, where secrets and the environment may be read,
// what may change a request's state, and what can reach what. They pin the properties that keep a send from being duplicated,
// leaked or started by accident, so a refactor cannot remove them silently.

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
    .map((d) => relative(repo, join(d.parentPath, d.name)))
    .filter((f) => !/node_modules|\.next\//.test(f));
const appSources = () =>
  [...walk("src"), ...walk("scripts")].filter(
    (f) =>
      !/\.test\.ts$/.test(f) &&
      !/(^|\/)testing\.ts$/.test(f) &&
      !/__tests__/.test(f) &&
      f !== "scripts/repro-next-body-clone-abort.mjs", // a standalone Next.js bug reproduction, never run by the app
  );

describe("outbound boundaries", () => {
  it("has exactly the expected production files", () => {
    expect(sources.map((s) => s.file).sort()).toEqual([
      "bot-authorization.ts",
      "classify.ts",
      "config.ts",
      "dispatch.ts",
      "eligibility.ts",
      "enqueue.ts",
      "errors.ts",
      "index.ts",
      "interactive.ts",
      "meta-transport.ts",
      "operator.ts",
      "policy.ts",
      "readiness.ts",
      "schemas.ts",
      "submit.ts",
      "transport.ts",
      "window.ts",
      "worker.ts",
    ]);
  });

  describe("network and secrets", () => {
    it("the only outbound HTTP request in server code is in meta-transport.ts, to one fixed host over HTTPS", () => {
      // browser code in the app UI calls its own origin; server code, scripts and the data layer must not call out at all
      const server = appSources().filter((f) => !/^src\/app\/(?!api\/)/.test(f));
      for (const f of server) {
        if (f === "src/modules/messaging/meta-transport.ts") continue;
        expect(code(read(join(repo, f))), f).not.toMatch(
          /\bfetch\s*\(|node:https?|\bhttp\.request|undici|axios|XMLHttpRequest|graph\.facebook\.com/,
        );
      }
      // production code makes NO use of fetch (undici may replay a POST internally); the worker script passes no HTTP seam at all
      for (const f of server)
        expect(code(read(join(repo, f))), f).not.toMatch(
          /\bfetch\s*\(|globalThis\.fetch|\bfetch:|undici/,
        );
      const script = code(read(join(repo, "scripts/whatsapp-outbound-worker.ts")));
      expect(script).toContain("new MetaTransport({ env: () => process.env })");
      expect(script).not.toMatch(/\bpost\b\s*:|singleAttemptPost|postToMeta|node:https?/);
      const t = source("meta-transport.ts");
      // exactly one request implementation is bound to the network: node:https, to the fixed host; node:http is imported as TYPES only
      expect(t.match(/\bhttps\.request\b/g)).toHaveLength(1);
      expect(t).toMatch(/import https from "node:https";/);
      expect(t).toMatch(/import type \{[^}]*\} from "node:http";/);
      expect(t).not.toMatch(/\bhttp\.request\b|from "node:http"[^;]*;\s*\n.*\bimport http\b/);
      expect(t.match(/https:\/\//g)).toHaveLength(1);
      expect(t).toContain('const HOST = "https://graph.facebook.com";');
      expect(t).not.toMatch(/http:\/\//);
      // single attempt: a fresh connection per call, and no redirect / retry / keep-alive / TLS-weakening vocabulary at all
      expect(t).toContain("agent: false");
      expect(t).not.toMatch(
        /maxRedirects|followRedirect|\bredirect\b|keepAlive|rejectUnauthorized|NODE_TLS|checkServerIdentity|\bagent: true|setTimeout\([^)]*\b(?:request|req)\b[^)]*retry/i,
      );
      expect(t.match(/requestImpl\(/g)).toHaveLength(1); // one call site per attempt
      // the destination of the production implementation is the constant host, never a parameter of a send
      expect(t).toMatch(
        /singleAttemptPost\(https\.request, \{\s*protocol: "https:",\s*hostname: META_HOSTNAME\s*\}\)/,
      );
    });

    it("the access token is read in exactly one place and never logged, stored, or put in a URL", () => {
      for (const { file, text } of sources) {
        if (file !== "meta-transport.ts")
          expect(text, file).not.toMatch(
            /Authorization|Bearer|env\[credential\]|accessToken|access_token/,
          );
        expect(text, file).not.toMatch(/logger\./);
        // the only console use is the worker's injectable print (operator-facing refusal text, never request data)
        if (file !== "worker.ts") expect(text, file).not.toMatch(/console\./);
      }
      const t = source("meta-transport.ts");
      expect(t.match(/env\[credential\]/g)).toHaveLength(1);
      expect(t.match(/Authorization/g)).toHaveLength(1);
      expect(t).not.toMatch(/searchParams|access_token|\?token|emitWebhookLog|console\./);
      // the schema has no column that could hold a token: credential_ref is a NAME
      expect(code(read(join(repo, "src/db/schema/outbound.ts")))).not.toMatch(
        /token|secret|password/i,
      );
    });

    it("the environment is read only for the gates: submit.ts (default config) and the transport/worker receive it as an argument", () => {
      expect(source("submit.ts").match(/process\.env/g)).toHaveLength(1);
      for (const f of [
        "config.ts",
        "dispatch.ts",
        "eligibility.ts",
        "operator.ts",
        "meta-transport.ts",
        "worker.ts",
        "classify.ts",
      ])
        expect(source(f), f).not.toMatch(/process\.env/);
      expect(source("config.ts")).toContain('env[name] === "true"');
    });

    it("the final HTTP boundary re-checks both live-send gates on every call, before any request", () => {
      const t = source("meta-transport.ts");
      const gate = t.indexOf("config.outboundEnabled");
      expect(gate).toBeGreaterThan(0);
      expect(t.indexOf("config.liveSendEnabled")).toBeGreaterThan(gate);
      expect(t.indexOf("(this.options.post ?? postToMeta)(")).toBeGreaterThan(
        t.indexOf("config.liveSendEnabled"),
      );
      expect(t).toContain("this.options.env()");
      expect(t).not.toMatch(/private config|this\.config/); // never cached
    });
  });

  describe("duplicate-send safety", () => {
    it("claiming and recording are transactions; the network call is in neither", () => {
      const d = source("dispatch.ts");
      const claim = d.slice(
        d.indexOf("export async function claimNext"),
        d.indexOf("const fenced"),
      );
      expect(claim).not.toMatch(/transport|\.send\(|fetch/);
      const execute = d.slice(
        d.indexOf("export async function executeClaim"),
        d.indexOf("export async function dispatchBatch"),
      );
      const beforeRecord = execute.slice(0, execute.indexOf("record(deps, claim, result)"));
      expect(beforeRecord).toContain("deps.transport.send(");
      expect(beforeRecord).not.toMatch(/transaction\(/);
      expect(d.match(/transport\.send\(/g)).toHaveLength(1);
    });

    it("SENDING is written, with send_started_at, inside the claim transaction BEFORE any send", () => {
      const d = source("dispatch.ts");
      expect(d).toMatch(
        /state: "SENDING",\s*claimedBy: owner,\s*claimedAt: now,\s*sendStartedAt: now/,
      );
      expect(d.indexOf('state: "SENDING"')).toBeLessThan(d.indexOf("deps.transport.send("));
    });

    it("QUEUED is written back in exactly one place: the branch for results that PROVE nothing was sent (rate limit / not sent)", () => {
      const d = source("dispatch.ts");
      expect(d.match(/state: "QUEUED"/g)).toHaveLength(1);
      const at = d.indexOf('state: "QUEUED"');
      expect(
        d.lastIndexOf('result.kind === "throttled" || result.kind === "not_sent"', at),
      ).toBeGreaterThan(0);
      // no other module writes request state; submit.ts (staff) and enqueue.ts (bot, Phase 08D) only INSERT the first QUEUED
      // row and never update the table
      for (const { file, text } of sources) {
        if (file === "dispatch.ts") continue;
        if (file === "submit.ts" || file === "enqueue.ts")
          expect(text, file).not.toMatch(
            /\.update\(schema\.outboundRequests|\.update\(t\)|UPDATE outbound_requests/i,
          );
        else
          expect(text, file).not.toMatch(
            /state: "(QUEUED|SENDING|ACCEPTED|REJECTED|UNKNOWN_OUTCOME)"/,
          );
      }
    });

    it("every transition after the claim is fenced by (id, state = SENDING, claimed_by)", () => {
      const d = source("dispatch.ts");
      expect(d).toMatch(
        /const fenced = \(c: Claim\) =>\s*and\(eq\(t\.id, c\.requestId\), eq\(t\.state, "SENDING"\), eq\(t\.claimedBy, c\.owner\)\);/,
      );
      const record = d.slice(
        d.indexOf("async function record("),
        d.indexOf("/** One HTTP attempt"),
      );
      expect(record.match(/\.where\(fenced\(claim\)\)/g)?.length).toBeGreaterThanOrEqual(6);
      expect(record).not.toMatch(/\.where\(eq\(t\.id/);
    });

    it("the accepted path takes the same per-message advisory lock as the STATUS handler and reconciles through the existing operation", () => {
      const d = source("dispatch.ts");
      expect(d).toContain(
        "`wa-message:${claim.organizationId}:${claim.accountId}:${result.wamid}`",
      );
      expect(d).toContain("resolveStatusEventsForMessage(tx,");
      expect(d.indexOf("pg_advisory_xact_lock")).toBeLessThan(
        d.indexOf("resolveStatusEventsForMessage(tx,"),
      );
      expect(d).toMatch(/lastOutboundAt: sql`GREATEST/);
      expect(d).not.toMatch(/lastInboundAt|status: "OPEN"|resolvedAt|messageStatusEvents/);
    });

    it("no code path turns an UNKNOWN_OUTCOME, HELD, REJECTED or ACCEPTED request back into a sendable one, and the operator tools cannot", () => {
      const o = source("operator.ts");
      expect(o.match(/\.update\(/g)).toHaveLength(1); // the template status update, nothing else
      expect(o).toContain(".update(schema.whatsappTemplates)");
      expect(o).not.toMatch(/outboundRequests\)\s*\.set|UPDATE outbound_requests|retry\(/i);
    });

    it("the transport is reached only after the pre-transmission authorization, with nothing awaited in between", () => {
      const d = source("dispatch.ts");
      const execute = d.slice(
        d.indexOf("export async function executeClaim"),
        d.indexOf("export async function dispatchBatch"),
      );
      const authorized = execute.indexOf("authorizeSend(deps, claim)");
      const sent = execute.indexOf("deps.transport.send(");
      expect(authorized).toBeGreaterThan(0);
      expect(sent).toBeGreaterThan(authorized);
      expect(execute.slice(0, sent)).toContain('authorization.kind === "stale"');
      // the stale / refused branches return before the line that calls the transport
      expect(execute.slice(authorized, sent)).not.toMatch(/deps\.transport/);
      // the authorization reads the row it will later fence on, and the clock only after that read returns
      const auth = d.slice(
        d.indexOf("async function authorizeSend"),
        d.indexOf("export async function executeClaim"),
      );
      expect(auth).toContain("SEND_START_BUDGET_MS");
      expect(auth.indexOf(".where(and(eq(t.organizationId")).toBeLessThan(
        auth.indexOf("const now = (deps.now"),
      );
    });

    it("the claim reads the clock AFTER the reads that can wait on a lock, and bounds the wait", () => {
      const d = source("dispatch.ts");
      const claim = d.slice(
        d.indexOf("export async function claimNext"),
        d.indexOf("const fenced"),
      );
      expect(claim).toContain("lock_timeout");
      expect(claim.indexOf("loadTemplate(")).toBeLessThan(claim.indexOf("const now = clock();"));
      expect(claim.indexOf("loadAccount(")).toBeLessThan(claim.indexOf("const now = clock();"));
      expect(claim).not.toMatch(/const now = \(deps\.now/); // no clock read before the transaction is used for decisions
      expect(claim).toContain("sendStartedAt: now");
    });

    it("a stored phone is never a fallback for a contact that has an alias", () => {
      const e = source("eligibility.ts");
      const choose = e.slice(
        e.indexOf("export function chooseRecipient"),
        e.indexOf("export type Assessment"),
      );
      expect(choose.match(/kind: "PHONE"/g)).toHaveLength(1);
      expect(choose.indexOf('kind: "PHONE"')).toBeGreaterThan(
        choose.indexOf("context.aliases.length > 0"),
      );
      expect(choose.indexOf("bsuid_send_unavailable")).toBeLessThan(
        choose.indexOf('kind: "PHONE"'),
      );
    });

    it("a transport that began an HTTP attempt can never make a result count as 'not sent' (dispatcher defense in depth)", () => {
      const d = source("dispatch.ts");
      const execute = d.slice(
        d.indexOf("export async function executeClaim"),
        d.indexOf("export async function dispatchBatch"),
      );
      expect(execute).toContain("httpStarted: () => {");
      expect(execute).toMatch(
        /httpStarted && \(result\.kind === "not_sent" \|\| result\.kind === "throttled"\)/,
      );
      expect(execute.indexOf("result_after_http_started")).toBeLessThan(
        execute.indexOf("await record(deps, claim, result)"),
      );
      // the only place the transport reports the start is immediately before the HTTP call, after every pre-flight refusal
      const t = source("meta-transport.ts");
      expect(t.match(/hooks\?\.httpStarted\(\)/g)).toHaveLength(1);
      expect(t.indexOf("hooks?.httpStarted()")).toBeGreaterThan(
        t.indexOf("bsuid_recipient_not_enabled"),
      );
      expect(t.indexOf("hooks?.httpStarted()")).toBeLessThan(
        t.indexOf("(this.options.post ?? postToMeta)("),
      );
      // after the attempt starts the transport has no `not_sent` return of its own
      expect(t.slice(t.indexOf("hooks?.httpStarted()"))).not.toContain("not_sent");
      // and the error classifier never produces one
      expect(source("classify.ts")).not.toMatch(/kind: "not_sent"/);
    });

    it("throttle retry is switched off by a code constant that no environment variable or transport can turn on", () => {
      expect(read(join(root, "policy.ts"))).toContain(
        "export const THROTTLE_RETRY_VERIFIED = false;",
      );
      // the transport classifies with the defaults (no options), so it cannot enable the throttled result
      expect(source("meta-transport.ts")).toMatch(
        /classifyResponse\(\s*response\.status,\s*parseBody\(response\.body\),\s*response\.headers\.get\("retry-after"\),?\s*\)/,
      );
      // the dispatcher turns any throttled answer into UNKNOWN_OUTCOME unless the (test-only) dependency says otherwise
      expect(source("dispatch.ts")).toMatch(
        /answer\.kind === "throttled" &&\s*!\(deps\.throttleRetryVerified \?\? THROTTLE_RETRY_VERIFIED\)/,
      );
      for (const f of ["config.ts", "worker.ts", "operator.ts", "submit.ts"])
        expect(source(f), f).not.toMatch(/throttleRetryVerified|THROTTLE_RETRY_VERIFIED/);
      for (const f of appSources().filter((x) => /^(src\/app|scripts)\//.test(x)))
        expect(read(join(repo, f)), f).not.toMatch(/throttleRetryVerified|THROTTLE_RETRY_VERIFIED/);
    });

    it("the dispatcher never claims anything while outbound is disabled", () => {
      expect(source("dispatch.ts")).toMatch(/if \(!deps\.config\.outboundEnabled\) return summary/);
    });
  });

  describe("BOT requests (Phase 08D, ADR 0020)", () => {
    it("BOT rows are not even candidates while the runtime gate is off, so they can neither be sent nor starve staff rows", () => {
      const claim = source("dispatch.ts").slice(
        source("dispatch.ts").indexOf("export async function claimNext"),
        source("dispatch.ts").indexOf("const fenced"),
      );
      expect(claim).toContain("const botsEnabled = deps.config.botsRuntimeEnabled === true;");
      expect(claim).toMatch(
        /AND \(origin = 'STAFF' OR \$\{botsEnabled\}\)\s*ORDER BY next_attempt_at, id/,
      );
      expect(claim).toContain("bot_request_hold_code(");
      expect(source("config.ts")).toContain(
        'botsRuntimeEnabled: flag(env, "BOTS_RUNTIME_ENABLED")',
      );
    });

    it("the BOT final authorization is one statement, then a fresh clock, then the bot rule, window and recipient", () => {
      const b = source("bot-authorization.ts");
      expect(b.match(/db\.execute</g)).toHaveLength(1);
      for (const field of [
        "c.last_inbound_at",
        "k.archived_at",
        "k.wa_id",
        "k.marketing_consent_status",
        "contact_bsuids",
        "a.status",
        "bot_request_hold_code(r.organization_id, r.id)",
      ])
        expect(b, field).toContain(field);
      const auth = b.slice(b.indexOf("export async function authorizeBotSend"));
      expect(auth.indexOf("readFinalState(")).toBeLessThan(auth.indexOf("const now = (deps.now"));
      const verdict = b.slice(b.indexOf("export function botFinalVerdict"));
      const order = [
        'row.state !== "SENDING"',
        "config.botsRuntimeEnabled",
        "account_inactive_before_dispatch",
        "claim_expired_before_dispatch",
        "deadline_passed_before_dispatch",
        "row.bot_hold_code !== null",
        "assess({",
        '"recipient_changed"',
      ].map((x) => verdict.indexOf(x));
      expect(order.every((i) => i > 0)).toBe(true);
      expect([...order].sort((x, y) => x - y)).toEqual(order);
      // staff requests never take this path; theirs is the unchanged read in dispatch.ts
      expect(source("dispatch.ts")).toMatch(
        /if \(claim\.origin === "BOT"\)\s*return authorizeBotSend\(/,
      );
    });

    it("a BOT request is HELD (never re-queued) on every refusal, and the acceptance retry is bounded and database-only", () => {
      const d = source("dispatch.ts");
      const notSent = d.slice(
        d.indexOf('result.kind === "throttled" || result.kind === "not_sent"'),
      );
      expect(notSent.indexOf('claim.origin === "BOT"')).toBeLessThan(
        notSent.indexOf('state: "QUEUED"'),
      );
      expect(d).toContain('const RETRYABLE_RECORD_STATES = new Set(["40P01", "40001"]);');
      expect(d).toContain("export const RECORD_RETRY_LIMIT = 2;");
      const accepted = d.slice(
        d.indexOf('if (result.kind === "accepted") {'),
        d.indexOf('if (result.kind === "rejected") {'),
      );
      // reset on every attempt, inside the loop; set on both normal return paths; checked before retrying
      expect(accepted).toMatch(
        /for \(let attempt = 1; ; attempt\+\+\) \{[\s\S]{0,400}let bodyCompleted = false;/,
      );
      expect(accepted.match(/bodyCompleted = true;/g)).toHaveLength(2);
      expect(accepted).toMatch(
        /retryableRecordFailure\(error, bodyCompleted\) && attempt <= retries/,
      );
      expect(d).toMatch(/!bodyCompleted &&\s*states\.length > 0 &&\s*states\.every/);
      expect(accepted).not.toMatch(/transport|\.send\(/);
    });

    it("enqueueAutomatedMessage has exactly one production importer (bot-runtime/outbound.ts, 08E-4), and messaging never imports the bot modules", () => {
      const callers = appSources().filter(
        (f) =>
          !f.startsWith("src/modules/messaging/") &&
          /enqueueAutomatedMessage|messaging\/enqueue/.test(read(join(repo, f))),
      );
      expect(callers).toEqual(["src/modules/bot-runtime/outbound.ts"]);
      for (const { file, text } of sources)
        expect(text, file).not.toMatch(/@\/modules\/(bots|bot-control|bot-runtime)\b/);
      expect(source("enqueue.ts")).not.toMatch(/process\.env/);
    });
  });

  describe("tenant and identity safety", () => {
    it("the organization and actor come from the AccessContext and the database, never from the request", () => {
      const s = source("submit.ts");
      expect(s).toContain("ctx.organizationId");
      expect(s).not.toMatch(/input\.(organizationId|whatsappAccountId|accountId|to|recipient)/);
      expect(source("schemas.ts")).not.toMatch(/organizationId|whatsappAccountId|recipient|phone/);
      expect(s).toContain('assertCan(ctx, "conversation.reply")');
      expect(s).toContain("revalidateActor(tx, ctx)");
      expect(s.indexOf("assertCan(ctx")).toBeLessThan(s.indexOf("db.transaction"));
    });

    it("every query on tenant tables in submit/eligibility/dispatch is organization-scoped", () => {
      for (const f of ["submit.ts", "eligibility.ts"]) {
        const text = source(f);
        for (const m of text.matchAll(
          /\.from\(schema\.(conversations|contacts|messages|whatsappAccounts|whatsappTemplates|outboundRequests|contactBsuids)\)/g,
        )) {
          const rest = text.slice(m.index!, m.index! + 900);
          expect(rest, `${f}: ${m[1]}`).toMatch(/organizationId/);
        }
      }
    });

    it("recipient identifiers are never cleaned, trimmed or truncated on the way to the transport", () => {
      for (const f of ["eligibility.ts", "meta-transport.ts", "submit.ts"])
        expect(source(f), f).not.toMatch(
          /\.trim\(\)|\.slice\(|\.substring|sanitizeString|toWellFormed|replaceAll\(|\.normalize\(/,
        );
      expect(source("eligibility.ts")).toContain("isIntactIdentifier(");
    });

    it("no consent is ever written, and the inbound conversation timestamps are never touched", () => {
      for (const { file, text } of sources) {
        expect(text, file).not.toMatch(
          /contactConsents|recordMarketingConsent|\.update\(schema\.contacts\)|insert\(schema\.contacts\)/,
        );
        // conversations are updated in exactly one place (the accepted path) and only lastOutboundAt is set there
        if (file !== "dispatch.ts")
          expect(text, file).not.toMatch(/\.update\(schema\.conversations\)/);
      }
      const d = source("dispatch.ts");
      expect(d.match(/\.update\(schema\.conversations\)/g)).toHaveLength(1);
    });

    it("the window decision reads only the inbound timestamp", () => {
      const w = source("window.ts");
      expect(w).not.toMatch(
        /lastOutboundAt|lastMessageAt|latestStatus|occurredAt|referral|attribution|statusAt/,
      );
      expect(source("eligibility.ts")).toContain("lastInboundAt: row.conversation.lastInboundAt");
    });
  });

  describe("wiring", () => {
    it("the whatsapp module (ingest, queue, handlers, inbound worker, operator layer) does not import messaging", () => {
      for (const f of walk("src/modules/whatsapp").filter(
        (x) => !/\.test\.ts$/.test(x) && !/testing\.ts$/.test(x),
      ))
        expect(read(join(repo, f)), f).not.toMatch(/modules\/messaging|\.\.\/messaging/);
    });

    it("messaging reaches into the whatsapp module only for shared, side-effect-free helpers", () => {
      const allowed = new Set([
        "@/modules/whatsapp/logging",
        "@/modules/whatsapp/idempotency",
        "@/modules/whatsapp/identifiers",
        "@/modules/whatsapp/ingest",
        "@/modules/whatsapp/operator/dryrun",
      ]);
      for (const { file, text } of sources)
        for (const m of text.matchAll(/from "(@\/modules\/whatsapp[^"]*)"/g))
          expect(allowed.has(m[1]!), `${file}: ${m[1]}`).toBe(true);
    });

    it("only the two staff routes import it, and only its public API; no route can dispatch or reach the transport", () => {
      const importers = appSources().filter(
        (f) =>
          /modules\/messaging/.test(read(join(repo, f))) && !f.startsWith("src/modules/messaging/"),
      );
      // Besides the two staff routes and the two operator scripts: the inbox reads the read-only reply readiness (detail.ts,
      // pinned by src/modules/inbox/boundaries.test.ts) and the disposable-database E2E seed uses the real submission path.
      expect(importers.sort()).toEqual([
        "scripts/e2e-seed.ts",
        "scripts/whatsapp-outbound-worker.ts",
        "scripts/whatsapp-outbound.ts",
        "src/app/api/conversations/[conversationId]/messages/route.ts",
        "src/app/api/outbound-requests/[requestId]/route.ts",
        "src/modules/bot-runtime/outbound.ts",
        // Phase 08E-7: the bot worker reads the gates with the dispatcher's own parser (config only; pinned below)
        "src/modules/bot-worker/compose.ts",
        "src/modules/inbox/detail.ts",
      ]);
      expect(
        [
          ...read(join(repo, "src/modules/bot-worker/compose.ts")).matchAll(
            /from "(@\/modules\/messaging[^"]*)"/g,
          ),
        ].map((m) => m[1]),
      ).toEqual(["@/modules/messaging/config"]);
      for (const f of importers.filter((x) => x.startsWith("src/app/")))
        expect(read(join(repo, f))).toMatch(/from "@\/modules\/messaging";/);
      expect(code(read(join(root, "index.ts"))).trim()).toBe(
        `export {
  getOutboundRequest,
  submitOutboundMessage,
  type OutboundRequestView,
  type SubmitDeps,
  type SubmitResult,
} from "./submit";
export { getReplyReadiness, type ReplyReadiness } from "./readiness";
export { IdempotencyConflictError, OutboundRefusedError } from "./errors";`,
      );
    });

    it("the proxy and the public API list contain no outbound entry; there is no unauthenticated send path", () => {
      expect(read(join(repo, "src/proxy.ts"))).not.toMatch(/outbound|conversations/);
      const routes = walk("src/app").filter(
        (f) =>
          f.endsWith("route.ts") && /outbound|messages|send/i.test(f) && !f.includes("/api/inbox/"),
      );
      expect(routes.sort()).toEqual([
        "src/app/api/conversations/[conversationId]/messages/route.ts",
        "src/app/api/outbound-requests/[requestId]/route.ts",
      ]);
      for (const f of routes) expect(read(join(repo, f))).toContain("handleApi(");
    });

    it("the outbound worker is started by exactly one script, never by the app, the build, a hook, CI, a route or a test", () => {
      const pkg = JSON.parse(read(join(repo, "package.json"))) as {
        scripts: Record<string, string>;
      };
      expect(
        Object.entries(pkg.scripts).filter(([n, c]) => /outbound/i.test(n) || /outbound/i.test(c)),
      ).toEqual([
        ["whatsapp:outbound", "tsx --env-file-if-exists=.env.local scripts/whatsapp-outbound.ts"],
        [
          "whatsapp:outbound-worker",
          "tsx --env-file-if-exists=.env.local scripts/whatsapp-outbound-worker.ts",
        ],
      ]);
      for (const hook of [
        "preinstall",
        "postinstall",
        "prepare",
        "prebuild",
        "postbuild",
        "predev",
        "prestart",
        "pretest",
        "posttest",
      ])
        expect(pkg.scripts[hook], hook).toBeUndefined();
      const startsIt = appSources().filter(
        (f) =>
          /runOutboundWorker|new MetaTransport/.test(read(join(repo, f))) &&
          !f.startsWith("src/modules/messaging/"),
      );
      expect(startsIt).toEqual(["scripts/whatsapp-outbound-worker.ts"]);
      for (const f of readdirSync(join(repo, ".github/workflows")))
        expect(read(join(repo, ".github/workflows", f)), f).not.toMatch(
          /WHATSAPP_OUTBOUND_ENABLED|WHATSAPP_LIVE_SEND_ENABLED|outbound-worker|META_ACCESS/,
        );
      for (const f of ["scripts/e2e.ts", "playwright.config.ts", "e2e/server.mjs"])
        expect(code(read(join(repo, f))), f).not.toMatch(/WHATSAPP_LIVE_SEND_ENABLED/);
      // The E2E app may QUEUE (outbound enabled, no worker, no credential) so the inbox composer can be tested. The environment of
      // BOTH servers is built in one place that sets every gate explicitly: live sending and BSUID sending are always "false",
      // and the harness scripts never set a gate themselves. A second server with outbound OFF covers the disabled state.
      for (const f of ["scripts/e2e.ts", "e2e/server.mjs"])
        expect(read(join(repo, f)), f).not.toMatch(/WHATSAPP_OUTBOUND_ENABLED/);
      const serverEnvSource = code(read(join(repo, "e2e/support/server-env.ts")));
      expect(serverEnvSource).toContain('WHATSAPP_LIVE_SEND_ENABLED: "false"');
      expect(serverEnvSource).toContain('WHATSAPP_BSUID_RECIPIENT_ENABLED: "false"');
      expect(serverEnvSource).not.toMatch(/(LIVE_SEND|BSUID_RECIPIENT)_ENABLED: "true"/);
      expect(serverEnvSource).toContain(
        'WHATSAPP_OUTBOUND_ENABLED: options.outboundEnabled ? "true" : "false"',
      );
      const playwrightConfig = code(read(join(repo, "playwright.config.ts")));
      expect(playwrightConfig.match(/outboundEnabled: (true|false)/g)).toEqual([
        "outboundEnabled: true",
        "outboundEnabled: false",
      ]);
      expect(playwrightConfig.match(/env: serverEnv\(/g)).toHaveLength(2); // no server has an ad-hoc env of its own
      const script = code(read(join(repo, "scripts/whatsapp-outbound-worker.ts")));
      expect(script).toMatch(/\["SIGTERM", "SIGINT"\]/);
      expect(script).not.toMatch(/WHATSAPP_OUTBOUND_ENABLED|WHATSAPP_LIVE_SEND_ENABLED/); // the gates live in the worker and the transport
    });

    it("the example environment documents every gate as off and holds no token", () => {
      const example = read(join(repo, ".env.example"));
      for (const name of [
        "WHATSAPP_OUTBOUND_ENABLED",
        "WHATSAPP_LIVE_SEND_ENABLED",
        "WHATSAPP_BSUID_RECIPIENT_ENABLED",
        "BOTS_RUNTIME_ENABLED",
      ])
        expect(example).toMatch(new RegExp(`^# ${name}=false$`, "m"));
      expect(example).not.toMatch(/^WHATSAPP_(OUTBOUND|LIVE_SEND|BSUID_RECIPIENT)_ENABLED=true/m);
      expect(example).not.toMatch(/^BOTS_RUNTIME_ENABLED=true/m);
      expect(example).not.toMatch(/EAA[A-Za-z0-9]{10,}/);
    });
  });
});
