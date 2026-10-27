import { readFileSync } from "node:fs";
import { BOT_ORG_A, BOT_ORG_B, BOT_USERS } from "../e2e/support/identities";
import { describe, expect, it } from "vitest";
import {
  BOT_CONVERSATIONS,
  BULK_ATTENTION,
  FLOW_HANDOVER_CODES,
  attentionKeys,
  PASSWORD_SOURCE,
  parseTarget,
  sendProblems,
  sessionToken,
  writeBotWorld,
  type Queryable,
  type ConversationPlan,
  type SendSnapshot,
} from "../e2e/support/bot-fixtures";

// Database-free checks of the bot browser fixtures: nothing here connects to anything. The fixture is written as a plan
// (data) and a writer (SQL); the plan is validated against the database rules it will meet, so a mistake shows here and not
// halfway through an authorized browser run.

const GOOD = "postgres://user:pw@127.0.0.1:55432/al_ict_e2e_0123456789ab";

describe("E2E_DATABASE_URL guard", () => {
  it("accepts exactly the generated database on the isolated test server", () => {
    expect(parseTarget(GOOD)).toEqual({
      host: "127.0.0.1",
      port: 55432,
      database: "al_ict_e2e_0123456789ab",
      user: "user",
      password: "pw",
    });
  });

  it.each([
    ["unset", undefined],
    ["not a URL", "not a url"],
    ["the permanent database", "postgres://u:p@127.0.0.1:55432/al_ict_whatsapp"],
    ["the maintenance database", "postgres://u:p@127.0.0.1:55432/postgres"],
    ["a unit-test database", "postgres://u:p@127.0.0.1:55432/al_ict_test_0123456789ab"],
    ["too few hex digits", "postgres://u:p@127.0.0.1:55432/al_ict_e2e_0123456789a"],
    ["too many hex digits", "postgres://u:p@127.0.0.1:55432/al_ict_e2e_0123456789abc"],
    ["upper-case hex", "postgres://u:p@127.0.0.1:55432/al_ict_e2e_0123456789AB"],
    ["a suffix after the name", "postgres://u:p@127.0.0.1:55432/al_ict_e2e_0123456789ab_x"],
    ["localhost", "postgres://u:p@localhost:55432/al_ict_e2e_0123456789ab"],
    ["another host", "postgres://u:p@db.example.com:55432/al_ict_e2e_0123456789ab"],
    ["another port", "postgres://u:p@127.0.0.1:5432/al_ict_e2e_0123456789ab"],
    ["no port", "postgres://u:p@127.0.0.1/al_ict_e2e_0123456789ab"],
    ["a query string that could redirect the driver", `${GOOD}?host=db.example.com`],
    ["a fragment", `${GOOD}#x`],
    ["no user", "postgres://127.0.0.1:55432/al_ict_e2e_0123456789ab"],
    ["another protocol", "mysql://u:p@127.0.0.1:55432/al_ict_e2e_0123456789ab"],
  ])("refuses %s", (_name, url) => {
    expect(() => parseTarget(url)).toThrow(/E2E_DATABASE_URL/);
  });

  it("never puts the connection string or password in an error", () => {
    try {
      parseTarget("postgres://user:secret-pw@db.example.com:1/al_ict_whatsapp");
    } catch (error) {
      expect(String(error)).not.toMatch(/secret-pw|db\.example\.com|user:/);
    }
  });
});

describe("fixture plan against the database rules", () => {
  const lastSession = (c: ConversationPlan) => c.sessions[c.sessions.length - 1]!;
  const requests = (c: ConversationPlan) => (c.messages ?? []).filter((m) => m.request);
  const flow = (reason?: string) =>
    (FLOW_HANDOVER_CODES as readonly string[]).includes(reason ?? "");

  it("has unique keys and unique, underscore-free contact names", () => {
    expect(new Set(BOT_CONVERSATIONS.map((c) => c.key)).size).toBe(BOT_CONVERSATIONS.length);
    expect(new Set(BOT_CONVERSATIONS.map((c) => c.name)).size).toBe(BOT_CONVERSATIONS.length);
    for (const c of BOT_CONVERSATIONS) expect(c.name, c.key).not.toContain("_");
    expect(new Set(BOT_CONVERSATIONS.map((c) => `${c.org}${c.minutesAgo}`)).size).toBe(
      BOT_CONVERSATIONS.length,
    ); // a stable list order
  });

  it("uses message keys once, replies only to earlier messages, requests only on OUTBOUND messages", () => {
    for (const c of BOT_CONVERSATIONS) {
      const seen = new Set(["start"]);
      for (const m of c.messages ?? []) {
        expect(seen.has(m.key), `${c.key}.${m.key} duplicate`).toBe(false);
        if (m.replyTo)
          expect(seen.has(m.replyTo), `${c.key}.${m.key} replies to a later message`).toBe(true);
        if (m.request) expect(m.direction, `${c.key}.${m.key}`).toBe("OUTBOUND");
        if (m.request)
          expect(m.type, `${c.key}.${m.key} bots send text or interactive`).not.toBe("BUTTON");
        if (m.direction === "OUTBOUND") expect(m.replyTo, `${c.key}.${m.key}`).toBeUndefined();
        seen.add(m.key);
      }
    }
  });

  it("keeps the in-flight rule (one QUEUED or SENDING bot request per conversation, and only as the last one)", () => {
    for (const c of BOT_CONVERSATIONS) {
      const rs = requests(c);
      const inFlight = rs.filter(
        (m) => m.request!.state === "QUEUED" || m.request!.state === "SENDING",
      );
      expect(inFlight.length, c.key).toBeLessThanOrEqual(1);
      if (inFlight.length === 1) expect(rs[rs.length - 1], c.key).toBe(inFlight[0]);
    }
  });

  it("gives every session a legal shape (live only last; reasons, notices and redaction only where the CHECKs allow)", () => {
    for (const c of BOT_CONVERSATIONS) {
      c.sessions
        .slice(0, -1)
        .forEach((s) =>
          expect(s.end, `${c.key}: an earlier session must have ended`).not.toBe("LIVE"),
        );
      for (const [i, s] of c.sessions.entries()) {
        const where = `${c.key}#${i}`;
        expect(s.end === "HANDED_OVER", where).toBe(s.handoverReason !== undefined);
        if (s.handoverReason) expect(s.handoverReason, where).toMatch(/^[a-z0-9_]{1,64}$/);
        if (s.redacted) expect(s.end, where).not.toBe("LIVE");
        if (i < c.sessions.length - 1) {
          expect(s.noticeOf, where).toBeUndefined();
          expect(s.redacted, where).toBeUndefined();
        }
        if (s.noticeOf) {
          // terminal_notice check: COMPLETED (flow_end) or HANDED_OVER by the flow (flow_handover); the last request of the session
          expect(
            s.end === "COMPLETED" || (s.end === "HANDED_OVER" && flow(s.handoverReason)),
            where,
          ).toBe(true);
          const rs = requests(c);
          expect(rs[rs.length - 1]!.key, where).toBe(s.noticeOf);
        }
      }
      if (c.messages?.some((m) => m.request)) expect(lastSession(c)).toBeDefined();
    }
  });

  it("states expectations that agree with the plan itself (independent of the production display code)", () => {
    for (const c of BOT_CONVERSATIONS) {
      const s = lastSession(c);
      const attention = c.status !== "RESOLVED" && (s.end === "HANDED_OVER" || s.end === "FAILED");
      expect(c.expect.attention, c.key).toBe(attention);
      const quietFinish = s.end === "COMPLETED" && !c.expect.warning;
      expect(c.expect.inList, c.key).toBe(!quietFinish);
      const label =
        s.end === "LIVE"
          ? "Bot is handling this chat"
          : s.end === "COMPLETED"
            ? "Bot finished"
            : s.end === "FAILED"
              ? "Bot stopped with an error"
              : flow(s.handoverReason)
                ? "Bot asked for a human"
                : "Bot handed over to staff";
      expect(c.expect.label, c.key).toBe(label);
      if (s.end === "FAILED") expect(c.expect.warning, c.key).toBe(true);
    }
  });

  it("makes the Bot attention view longer than one page of 30, with newer conversations that are not in it", () => {
    const org = attentionKeys("A");
    expect(org.length).toBe(BULK_ATTENTION + 15);
    expect(org.length).toBeGreaterThan(30);
    const newest = BOT_CONVERSATIONS.filter((c) => c.org === "A").sort(
      (a, b) => a.minutesAgo - b.minutesAgo,
    )[0]!;
    expect(newest.expect.attention).toBe(false);
    expect(attentionKeys("B")).toEqual(["orgB"]);
    // every named conversation fits on the first page of 30 of the unfiltered list, so the row checks need no paging
    expect(
      BOT_CONVERSATIONS.filter((c) => c.org === "A" && !c.key.startsWith("bulk")).length,
    ).toBeLessThanOrEqual(30);
  });

  it("covers every notice outcome, a warning COMPLETED session, redaction, hold reasons and the hostile interactive rows", () => {
    const states = BOT_CONVERSATIONS.flatMap((c) => requests(c).map((m) => m.request!.state));
    for (const s of ["QUEUED", "SENDING", "ACCEPTED", "HELD", "REJECTED", "UNKNOWN_OUTCOME"])
      expect(states).toContain(s);
    expect(BOT_CONVERSATIONS.some((c) => lastSession(c).redacted)).toBe(true);
    expect(
      BOT_CONVERSATIONS.some((c) => lastSession(c).end === "COMPLETED" && c.expect.warning),
    ).toBe(true);
    const interactive = BOT_CONVERSATIONS.find((c) => c.key === "interactive")!.messages!;
    expect(
      interactive.some(
        (m) => m.type === "INTERACTIVE" && m.direction === "OUTBOUND" && m.body === null,
      ),
    ).toBe(true); // bodyless
    expect(
      interactive.some(
        (m) => m.type === "INTERACTIVE" && m.direction === "INBOUND" && m.body === null,
      ),
    ).toBe(true);
    expect(
      interactive.some((m) => m.content && JSON.stringify(m.content).includes("not-a-list")),
    ).toBe(true); // malformed
    expect(interactive.some((m) => m.type === "BUTTON")).toBe(true);
    const holds = BOT_CONVERSATIONS.find((c) => c.key === "holds")!.messages!.map(
      (m) => m.request!.holdReason,
    );
    expect(holds).toEqual(["staff_took_over", "bot_step_superseded", "bot_stopped"]);
  });

  it("contains no real-looking personal data, credential or underscore in any message text", () => {
    for (const c of BOT_CONVERSATIONS)
      for (const m of c.messages ?? []) {
        expect(m.body ?? "", `${c.key}.${m.key}`).not.toMatch(/_|\+?\d{9,}|EAA|token|secret/i);
      }
  });
});

describe("the writer's SQL cannot weaken a guard or leave the disposable database", () => {
  const source = readFileSync(new URL("../e2e/support/bot-fixtures.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("never disables a trigger, changes the replication role, alters or drops anything", () => {
    expect(code).not.toMatch(
      /disable\s+trigger|enable\s+replica|set\s+(local\s+)?session_replication_role|alter\s+(table|system)|drop\s+|truncate|\bcopy\b/i,
    );
    // the only DDL is the retention interval, executed from the captured ORIGINAL definition (no hardcoded replacement)
    expect(code).not.toMatch(/create or replace function/i);
    expect(code).toContain("pg_get_functiondef");
    expect(code).toContain("session_replication_role"); // read-only: the identity check proves it is 'origin'
  });

  it("imports no production module and reads no other environment variable", () => {
    expect([...code.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort()).toEqual([
      "./identities",
      "pg",
    ]);
    expect([...code.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1])).toEqual([
      "E2E_DATABASE_URL",
    ]);
    expect(code).not.toMatch(/al_ict_whatsapp|DATABASE_ADMIN|connectionString/);
  });

  it("writes one transaction, sets no allocator-owned column and no credential", () => {
    expect(code).toContain('c.query("begin")');
    expect(code).toContain('c.query("commit")');
    expect(code).toContain('"rollback"');
    expect(code).not.toMatch(
      /started_control_seq|handover_control_seq|\bcontrol_seq\s*=|\bstarted_at\s*=|\bended_at\s*=/,
    );
    expect(code).not.toMatch(/credential_ref/);
    expect(code).not.toMatch(/WA_TOKEN|EAA[A-Za-z0-9]{6,}/);
  });
});

describe("the no-send comparison", () => {
  const snapshot = (overrides: Partial<SendSnapshot> = {}): SendSnapshot => ({
    requests: {
      a: { state: "SENDING", digest: "d1" },
      b: { state: "QUEUED", digest: "d2" },
      c: { state: "ACCEPTED", digest: "d3" },
    },
    outboundMessages: 7,
    statusEvents: 0,
    sessionsDigest: "s",
    ...overrides,
  });

  it("accepts an unchanged world, existing SENDING rows included", () => {
    expect(sendProblems(snapshot(), snapshot())).toEqual([]);
  });

  it.each([
    [
      "a new request",
      { requests: { ...snapshot().requests, z: { state: "QUEUED", digest: "n" } } },
      /new outbound request z/,
    ],
    [
      "a request whose state changed",
      { requests: { ...snapshot().requests, b: { state: "SENDING", digest: "x" } } },
      /request b changed/,
    ],
    [
      "a request changed without a state change",
      { requests: { ...snapshot().requests, c: { state: "ACCEPTED", digest: "x" } } },
      /request c changed/,
    ],
    [
      "a new SENDING request",
      { requests: { ...snapshot().requests, z: { state: "SENDING", digest: "n" } } },
      /newly SENDING/,
    ],
    [
      "a vanished request",
      { requests: { a: snapshot().requests.a!, b: snapshot().requests.b! } },
      /disappeared/,
    ],
    ["a new outbound message", { outboundMessages: 8 }, /outbound message count/],
    ["a delivery status event", { statusEvents: 1 }, /status event/],
    ["a changed bot session", { sessionsDigest: "t" }, /bot session changed/],
  ] as const)("reports %s", (_name, change, pattern) => {
    expect(sendProblems(snapshot(), snapshot(change as Partial<SendSnapshot>)).join("\n")).toMatch(
      pattern,
    );
  });
});

// ----------------------------------------------------------------------------------------- the writer, with a recording client
// The REAL writer (writeBotWorld) is driven by a client that records every statement and its bindings and answers like a database
// would (generated ids, the original retention definition). No connection exists; this inspects what the SQL path actually binds.
const ORIGINAL_DEF =
  "CREATE OR REPLACE FUNCTION public.bot_session_redaction_after()\n RETURNS interval\n LANGUAGE sql\n STABLE\nAS $function$ SELECT interval '30 days' $function$\n";

type Recorded = { text: string; params: unknown[] };
function recordingClient(options: { restoreBroken?: boolean } = {}) {
  const log: Recorded[] = [];
  const owner = new Map<string, { table: string; org: string; params: unknown[] }>(); // id -> row
  let def = ORIGINAL_DEF;
  let n = 0;
  const client = {
    async query(text: string, params: unknown[] = []) {
      log.push({ text, params });
      const sql = text.trim();
      if (/^select pg_get_functiondef/i.test(sql)) return { rows: [{ def }] };
      if (/^create or replace function/i.test(sql)) {
        def =
          options.restoreBroken && text === ORIGINAL_DEF
            ? text.replace("30 days", "31 days")
            : text;
        return { rows: [] };
      }
      if (/^select send_epoch/i.test(sql)) return { rows: [{ send_epoch: "1" }] };
      if (/^select m\.type from messages/i.test(sql))
        return { rows: [{ type: owner.get(String(params[0]))!.params[4] }] };
      const insert = /^insert into (\w+)/i.exec(sql);
      if (insert && /returning id/i.test(sql)) {
        const table = insert[1]!;
        const id = `${table}-${++n}`;
        // the organization column is the first binding of every tenant-owned table; organizations are their own owner
        const org =
          table === "organizations"
            ? id
            : table === "users" || table === "accounts"
              ? ""
              : String(params[0]);
        owner.set(id, { table, org, params });
        return { rows: [{ id }] };
      }
      return { rows: [] };
    },
  } as unknown as Queryable;
  const inserts = (table: string) =>
    log.filter((r) => new RegExp(`^insert into ${table}\\b`, "i").test(r.text.trim()));
  return { client, log, owner, inserts };
}

describe("the writer's bindings (driven with a recording client)", () => {
  it("binds a distinct, valid 22-character token to every session, unique within each organization", async () => {
    const rec = recordingClient();
    await writeBotWorld(rec.client);
    const sessions = rec.inserts("bot_sessions");
    expect(sessions).toHaveLength(
      BOT_CONVERSATIONS.reduce((total, c) => total + c.sessions.length, 0),
    );
    const byOrg = new Map<string, string[]>();
    for (const { params } of sessions) {
      const token = String(params[10]);
      expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(token.startsWith("CANARYTOKEN")).toBe(true); // still a sensitive-data canary
      byOrg.set(String(params[0]), [...(byOrg.get(String(params[0])) ?? []), token]);
    }
    expect(byOrg.size).toBe(2);
    for (const tokens of byOrg.values()) expect(new Set(tokens).size).toBe(tokens.length);
    expect(new Set([...byOrg.values()].flat()).size).toBe(sessions.length);
    expect(sessionToken(1)).not.toBe(sessionToken(2));
  });

  it("gives each organization its own bot, version and deployment, and every session references only its own organization's rows", async () => {
    const rec = recordingClient();
    const world = await writeBotWorld(rec.client);
    for (const table of ["bots", "bot_versions", "bot_deployments"]) {
      const orgs = rec.inserts(table).map((r) => r.params[0]);
      expect(orgs.sort(), table).toEqual([world.orgIds.A, world.orgIds.B].sort());
    }
    const rows = (id: unknown) => rec.owner.get(String(id))!;
    // a version belongs to its bot, a deployment to its own bot, version and account, all of one organization
    for (const { params } of rec.inserts("bot_versions"))
      expect(rows(params[1]).org).toBe(params[0]);
    for (const { params } of rec.inserts("bot_deployments")) {
      for (const ref of [params[1], params[2], params[3]])
        expect(rows(ref).org, String(ref)).toBe(params[0]);
      expect(rows(params[3]).params[1]).toBe(params[2]); // the version is a version of that bot
    }
    for (const { params } of rec.inserts("bot_sessions")) {
      // (org, account, bot, version, deployment, contact, conversation, started-by message)
      const [org, bot, version, deployment, account, contact, conversation, message] = params;
      for (const ref of [bot, version, deployment, account, contact, conversation, message])
        expect(rows(ref).org, `${rows(ref).table} of a session of ${String(org)}`).toBe(org);
      expect(rows(deployment).params[2]).toBe(bot); // the deployment is of this bot, the version of this bot
      expect(rows(version).params[1]).toBe(bot);
      expect(rows(conversation).params[1]).toBe(account);
    }
    // each plan lands in its own organization, and the bot requests reference their own session, conversation and message
    for (const [key, conversationId] of Object.entries(world.conversations)) {
      const plan = BOT_CONVERSATIONS.find((c) => c.key === key)!;
      expect(rows(conversationId).org, key).toBe(world.orgIds[plan.org]);
    }
    for (const { params } of rec.inserts("outbound_requests")) {
      const [org, account, conversation, message, , , , session] = params;
      for (const ref of [account, conversation, message, session]) expect(rows(ref).org).toBe(org);
      expect(rows(session).params[6]).toBe(conversation);
    }
    // the memberships that created a bot / published a version belong to the same organization
    for (const { params } of rec.inserts("bots")) expect(rows(params[1]).org).toBe(params[0]);
    for (const { params } of rec.inserts("bot_versions"))
      expect(rows(params[3]).org).toBe(params[0]);
    const memberships = rec.inserts("organization_memberships").length;
    expect(memberships).toBe(4);
  });

  it("captures the original retention definition, restores that exact text, and verifies it", async () => {
    const rec = recordingClient();
    await writeBotWorld(rec.client);
    const statements = rec.log.map((r) => r.text.trim());
    const defs = statements.filter((t) => /^create or replace function/i.test(t));
    expect(defs).toHaveLength(2);
    expect(defs[0]).toBe(ORIGINAL_DEF.replace("30 days", "0 seconds").trim());
    expect(defs[1]).toBe(ORIGINAL_DEF.trim()); // the captured original, byte for byte
    const at = (text: string) => statements.findIndex((t) => t === text);
    const reads = statements.flatMap((t, i) => (/^select pg_get_functiondef/i.test(t) ? [i] : []));
    expect(reads).toHaveLength(2); // before the change and after the restore
    expect(reads[0]).toBeLessThan(at(defs[0]!));
    expect(reads[1]).toBeGreaterThan(at(defs[1]!));
    const redactions = statements.filter((t) => /redacted_at = now\(\)/.test(t));
    expect(redactions.length).toBeGreaterThan(0);
    for (const t of redactions) expect(at(t)).toBeGreaterThan(at(defs[0]!));
    for (const t of redactions) expect(at(t)).toBeLessThan(at(defs[1]!));
  });

  it("fails the whole fixture when the restored definition differs", async () => {
    await expect(writeBotWorld(recordingClient({ restoreBroken: true }).client)).rejects.toThrow(
      /not restored exactly/,
    );
  });
});

describe("the bot users' login credentials (driven with a recording client)", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const specs = [
    "auth",
    "staff-api",
    "inbox",
    "inbox-bot",
    "inbox-review",
    "inbox-leads",
    "leads",
    "lead-detail",
    "lead-status",
    "leads-integration",
    "inbox-outbound-off",
    "outbound",
    "proxy",
    "redirect",
    "shell-a11y",
    "webhook",
  ];

  it("gives all four bot users (both organizations) a hash copied from the intended stable source", async () => {
    const rec = recordingClient();
    await writeBotWorld(rec.client);
    const users = rec.inserts("users");
    const accounts = rec.inserts("accounts");
    expect(users.map((r) => r.params[1])).toEqual(Object.values(BOT_USERS).map((u) => u.email));
    expect(accounts).toHaveLength(users.length);
    for (const r of [...users, ...accounts])
      expect(r.params[2], r.text.slice(0, 30)).toBe(PASSWORD_SOURCE);
    // each credential account is bound to its own user's new id (the user inserted with that email), both columns alike
    const emails = Object.values(BOT_USERS).map((u) => u.email);
    accounts.forEach((r, i) => {
      expect(r.params[0]).toBe(r.params[1]);
      expect(rec.owner.get(String(r.params[0]))!.params[1]).toBe(emails[i]);
    });
    const orgs = new Set(rec.inserts("organization_memberships").map((r) => r.params[0]));
    expect(orgs.size).toBe(2);
  });

  it("the source is a seeded account with the shared password that no spec changes (the first admin is not it)", () => {
    expect(PASSWORD_SOURCE).not.toBe("first.admin@e2e.test");
    const seed = read("scripts/e2e-seed.ts");
    expect(seed).toContain("...Object.values(INBOX_USERS),");
    expect(seed).toMatch(
      /signUpEmail\(\{\s*body: \{ name: u\.name, email: u\.email, password: E2E_PASSWORD \}/,
    );
    // only auth.spec.ts changes a password, and only the first admin's; nothing resets one through the staff API
    const changers = specs.filter((f) =>
      /change-password|E2E_NEW_PASSWORD|reset-password/.test(read(`e2e/${f}.spec.ts`)),
    );
    expect(changers).toEqual(["auth"]);
    const auth = read("e2e/auth.spec.ts");
    expect(auth).not.toMatch(/INBOX_USERS/);
    expect(auth.match(/E2E_NEW_PASSWORD/g)!.length).toBeGreaterThan(0);
    expect(auth).toContain("FIRST_ADMIN");
    for (const f of specs)
      expect(read(`e2e/${f}.spec.ts`), f).not.toMatch(
        /accounts set password|signUpEmail|setPassword/,
      );
  });

  it("the bot spec signs in with the shared password (never an explicit one)", () => {
    const spec = read("e2e/inbox-bot.spec.ts");
    const calls = [...spec.matchAll(/loginViaUi\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args).toMatch(/^page, email, undefined,/);
    expect(read("e2e/support/ui.ts")).toContain("password: string = E2E_PASSWORD");
  });

  it("leaves the tenant layout alone: users, memberships and roles as before", async () => {
    const rec = recordingClient();
    await writeBotWorld(rec.client);
    const memberships = rec.inserts("organization_memberships");
    expect(memberships.map((r) => r.params[2])).toEqual(
      Object.values(BOT_USERS).map((u) => u.role),
    );
    // every user belongs to the organization named in the identity (A for three of them, B for the fourth)
    memberships.forEach((r, i) => {
      const u = Object.values(BOT_USERS)[i]!;
      expect(rec.owner.get(String(r.params[0]))!.params[1]).toBe(
        u.org === "A" ? BOT_ORG_A.slug : BOT_ORG_B.slug,
      );
      expect(rec.owner.get(String(r.params[1]))!.params[1]).toBe(u.email);
    });
  });
});
