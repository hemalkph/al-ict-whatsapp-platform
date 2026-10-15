import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerDatabase } from "@/db";
import { createTestDatabase } from "@/db/__tests__/helpers";
import { EXIT_FATAL, EXIT_OK, EXIT_REFUSED, runReconcileCli } from "./cli";
import { addContact, addTouch, fixture, minutesAgo, type Fixture } from "./testing";

// `npm run leads:reconcile`: opt-in, one bounded run, counts-only JSON, safe errors, and the exit codes. Disposable databases only;
// the script is run with an explicit environment that contains nothing but what the test passes (never .env.local).

describe("the leads:reconcile command", () => {
  let f: Fixture;
  const fetchSpy = vi.fn(() => {
    throw new Error("the reconciler must never make a network request");
  });
  beforeEach(async () => {
    f = await fixture();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await f.close();
  });

  const cli = async (
    env: Record<string, string | undefined>,
    createDatabase?: Parameters<typeof runReconcileCli>[0]["createDatabase"],
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runReconcileCli({
      env,
      output: (l) => out.push(l),
      print: (m) => err.push(m),
      createDatabase,
    });
    return { code, out, err };
  };
  const on = () => ({ LEADS_RECONCILER_ENABLED: "true", DATABASE_URL: f.t.url });
  const COMMAND = "al-ict-leads-reconciler";
  /**
   * Sessions of the command in THIS fixture's database (never another database's), polled for a bounded time because a backend
   * ends asynchronously after its client disconnects. A session that is still there after the wait is returned, not hidden.
   */
  const commandSessions = async (waitMs = 5_000) => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const { n } = await f.one<{ n: number }>(
        "select count(*)::int n from pg_stat_activity where datname = current_database() and application_name = $1",
        [COMMAND],
      );
      if (n === 0 || Date.now() >= deadline) return n;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it("does nothing, and does not even open the database, unless it is explicitly enabled or the configuration is valid", async () => {
    const touch = async () => addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(3) });
    await touch();
    let opened = 0;
    const spyDb = () => {
      opened++;
      throw new Error("must not be opened");
    };
    for (const env of [
      {},
      { DATABASE_URL: f.t.url },
      { LEADS_RECONCILER_ENABLED: "false", DATABASE_URL: f.t.url },
      { LEADS_RECONCILER_ENABLED: "TRUE", DATABASE_URL: f.t.url },
      { LEADS_RECONCILER_ENABLED: "true" },
      { ...on(), LEADS_RECONCILE_FRESHNESS_DAYS: "0" },
    ]) {
      const r = await cli(env, spyDb);
      expect(r.code).toBe(EXIT_REFUSED);
      expect(r.out).toEqual([]);
      expect(r.err.join(" ")).toMatch(/disabled|Invalid reconciler configuration/);
      expect(r.err.join(" ")).not.toContain(f.t.url);
    }
    expect(opened).toBe(0);
    expect((await f.q("select 1 from leads")).length).toBe(0);
  });

  it("runs ONE bounded pass and prints one JSON line of counts: no identifier, no text of a person, a contact, a touch or a message", async () => {
    const contact = await addContact(f.t.db, f.w.org.id, {
      profileName: "Kamal Perera",
      waId: "94771234567",
    });
    await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: minutesAgo(3),
      headline: "Secret Headline",
      ctwaClid: "SECRETCLICKID-0123456789",
    });
    await addTouch(f.t.db, f.w, (await addContact(f.t.db, f.w.org.id)).id, {
      receivedAt: minutesAgo(40 * 24 * 60),
    });
    const r = await cli({ ...on(), LEADS_RECONCILE_BATCH_SIZE: "50" });
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toHaveLength(1);
    const report = JSON.parse(r.out[0]!) as Record<string, unknown>;
    expect(report).toMatchObject({
      event: "leads.reconcile.run",
      outcome: "success",
      scanned: 2,
      processed: 2,
      created: 1,
      skipped: { stale: 1, beforeCycle: 0, converted: 0, archived: 0 },
      stopReason: "exhausted",
      remaining: { due: 0, dueCapped: false, retryWaiting: 0 },
    });
    // counts only
    const text = r.out[0]!;
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    for (const secret of [
      "Kamal",
      "94771234567",
      "Secret Headline",
      "SECRETCLICKID",
      f.t.url,
      "postgres",
    ])
      expect(text).not.toContain(secret);
    expect(r.err).toEqual([]);
    // the pool was closed: a second run on the same URL works, and the database is not left with a session of the command
    expect(await commandSessions()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the cleanup check counts only THIS database: a same-named session in another database does not fail it, a real leak here is still caught", async () => {
    await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(3) });
    // another disposable database with an open session under the command's own application name
    const other = await createTestDatabase();
    const elsewhere = createWorkerDatabase(other.url, {
      maxConnections: 1,
      applicationName: COMMAND,
      onPoolError: () => undefined,
    });
    try {
      await elsewhere.db.execute(sql`select 1`);
      expect(
        (
          await other.pool.query(
            "select count(*)::int n from pg_stat_activity where datname = current_database() and application_name = $1",
            [COMMAND],
          )
        ).rows[0].n,
      ).toBe(1);
      expect((await cli(on())).code).toBe(EXIT_OK);
      expect(await commandSessions()).toBe(0); // the other database's session is not counted here
      // a genuine leak in THIS database is still detected (after the bounded wait, not hidden)
      const leak = createWorkerDatabase(f.t.url, {
        maxConnections: 1,
        applicationName: COMMAND,
        onPoolError: () => undefined,
      });
      try {
        await leak.db.execute(sql`select 1`);
        expect(await commandSessions(300)).toBe(1);
      } finally {
        await leak.close();
      }
      expect(await commandSessions()).toBe(0);
    } finally {
      await elsewhere.close();
      await other.close();
    }
  });

  it("refuses a database that is not migrated to the lead schema, changing and creating nothing, with a fixed reason", async () => {
    const empty = await createTestDatabase({ migrate: false });
    try {
      const r = await cli({ LEADS_RECONCILER_ENABLED: "true", DATABASE_URL: empty.url });
      expect(r.code).toBe(EXIT_FATAL);
      expect(JSON.parse(r.out[0]!)).toEqual({
        event: "leads.reconcile.run",
        outcome: "failure",
        reason: "schema_not_ready",
      });
      expect(
        (
          await empty.pool.query(
            "select count(*)::int n from information_schema.tables where table_schema = 'public'",
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await empty.close();
    }
  });

  it("an unreachable database is a fixed 'database_unreachable' failure that names nothing about it", async () => {
    const r = await cli({
      LEADS_RECONCILER_ENABLED: "true",
      DATABASE_URL: "postgres://nobody:hunter2@127.0.0.1:1/al_ict_nowhere",
    });
    expect(r.code).toBe(EXIT_FATAL);
    expect(r.out).toHaveLength(1);
    expect(JSON.parse(r.out[0]!)).toEqual({
      event: "leads.reconcile.run",
      outcome: "failure",
      reason: "database_unreachable",
    });
    expect(r.out.join(" ") + r.err.join(" ")).not.toMatch(
      /hunter2|nobody|127\.0\.0\.1|al_ict_nowhere/,
    );
  });

  it("an unexpected database error during the run is a failed run with fixed codes only: never a message, a host or a value", async () => {
    const r = await cli(on(), (config) => {
      const real = createDatabaseFor(config.databaseUrl);
      const transaction = real.db.transaction.bind(real.db);
      let calls = 0;
      real.db.transaction = ((fn: Parameters<typeof transaction>[0]) => {
        calls++;
        // the readiness check passes; everything after it fails with an error that carries sensitive text
        if (calls > 1)
          return Promise.reject(new Error("internal detail: password=hunter2 host=db.internal"));
        return transaction(fn);
      }) as typeof real.db.transaction;
      return real;
    });
    expect(r.code).toBe(EXIT_FATAL);
    const report = JSON.parse(r.out[0]!) as Record<string, unknown>;
    expect(report).toMatchObject({
      event: "leads.reconcile.run",
      outcome: "failure",
      stopReason: "query_failed",
      scanned: 0,
      processed: 0,
      errors: { internal_error: 2 }, // the scan and the count
      remaining: { known: false },
    });
    expect(r.out.join(" ") + r.err.join(" ")).not.toMatch(/hunter2|db\.internal|password/);
  });

  it("a candidate scan that hits a database limit makes the command exit 1 with a failure report that says only what happened", async () => {
    // the readiness check passes (it touches nothing that is locked), then the scan meets a migration's lock on its table
    await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(3) });
    const hold = await f.t.pool.connect();
    try {
      const r = await cli({ ...on(), LEADS_RECONCILE_LOCK_TIMEOUT_SECONDS: "1" }, (config) => {
        const real = createDatabaseFor(config.databaseUrl);
        const transaction = real.db.transaction.bind(real.db);
        let calls = 0;
        real.db.transaction = ((fn: Parameters<typeof transaction>[0]) => {
          calls++;
          if (calls === 2) {
            // lock the table just before the first scan, as a migration starting at that moment would
            return hold
              .query("begin")
              .then(() => hold.query("lock table lead_attributions in access exclusive mode"))
              .then(() => transaction(fn));
          }
          return transaction(fn);
        }) as typeof real.db.transaction;
        return real;
      });
      expect(r.code).toBe(EXIT_FATAL);
      expect(JSON.parse(r.out[0]!)).toMatchObject({
        outcome: "failure",
        stopReason: "query_failed",
        errors: { pg_55p03: 2 },
      });
      expect(r.out.join(" ")).not.toMatch(/select |lead_attributions|access exclusive/i);
    } finally {
      await hold.query("rollback").catch(() => undefined);
      hold.release();
    }
  });

  it("the real script, as a separate process: refused with exit code 2 unless enabled; with an explicit enabled flag it runs once and EXITS", async () => {
    const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    expect(existsSync(tsx)).toBe(true);
    await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(2) });
    const spawn = (env: Record<string, string>) =>
      spawnSync(process.execPath, [tsx, "scripts/leads-reconcile.ts"], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 60_000,
      });
    const refused = spawn({ DATABASE_URL: f.t.url });
    expect(refused.status).toBe(EXIT_REFUSED);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toMatch(/disabled/);
    expect((await f.q("select 1 from leads")).length).toBe(0);

    const ran = spawn({ LEADS_RECONCILER_ENABLED: "true", DATABASE_URL: f.t.url });
    expect(ran.error).toBeUndefined();
    expect(ran.status).toBe(EXIT_OK);
    const lines = ran.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      outcome: "success",
      created: 1,
      stopReason: "exhausted",
    });
    expect((await f.q("select 1 from leads")).length).toBe(1);
  }, 120_000);

  it("is wired to nothing: the command is a package script only, nothing in the application imports it, and no schedule exists", () => {
    // (structural checks are in boundaries.test.ts; this one pins the script name and the gate)
    expect(existsSync(join(process.cwd(), "scripts/leads-reconcile.ts"))).toBe(true);
  });
});

function createDatabaseFor(url: string) {
  return createWorkerDatabase(url, {
    maxConnections: 2,
    applicationName: "al-ict-leads-reconciler-test",
    onPoolError: () => undefined,
  });
}
