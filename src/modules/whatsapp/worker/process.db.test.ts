import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { deliveryBytes, eventStatus, tenant } from "../inbound/testing";
import { expireLeases, until } from "../queue/testing";
import { TEST_APP_SECRET, postSigned, spawnWorker, type WorkerProcess } from "./testing";

// The REAL script (scripts/whatsapp-worker.ts) in a child process against a disposable PostgreSQL database: opt-in,
// refusal to start, SIGTERM, SIGKILL and recovery. The environment of the child is explicit.

describe("whatsapp-worker process", () => {
  let t: TestDb;
  const children: WorkerProcess[] = [];
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    vi.stubEnv("META_APP_SECRET", TEST_APP_SECRET);
    for (const method of ["log", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation(() => undefined);
    await t.pool.query(
      "truncate webhook_events, webhook_requests, whatsapp_accounts, organizations cascade",
    );
    await t.pool.query("select pg_advisory_unlock_all()");
  });
  afterEach(async () => {
    for (const c of children.splice(0)) {
      c.kill("SIGKILL");
      await c.exited;
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const enabled = (extra: Record<string, string> = {}) => ({
    DATABASE_URL: t.url,
    WHATSAPP_WORKER_ENABLED: "true",
    ...extra,
  });
  const start = (env: Record<string, string>) => {
    const w = spawnWorker(env);
    children.push(w);
    return w;
  };
  const rows = async (query: string, params: unknown[] = []) =>
    (await t.pool.query(query, params)).rows;
  const count = async (table: string) =>
    (await rows(`select count(*)::int n from ${table}`))[0].n as number;
  const snapshot = () => rows("select * from webhook_events order by id");
  const workerSessions = async () =>
    (
      await rows(
        "select count(*)::int n from pg_stat_activity where datname = current_database() and application_name = 'al-ict-whatsapp-worker'",
      )
    )[0].n as number;
  const post = async (id: string, bsuid: string) => {
    const { bytes } = deliveryBytes({ id, bsuid });
    expect((await postSigned(t.db, bytes)).status).toBe(200);
  };
  const waitStatus = async (wamid: string, status: string, ms = 20_000) =>
    until(
      async () =>
        (await rows("select status from webhook_events where provider_object_id = $1", [wamid]))[0]
          ?.status === status,
      ms,
    );
  /** Holds the per-message advisory lock the MESSAGE handler takes, so its handler blocks inside its transaction. */
  async function holdMessageLock(wamid: string) {
    const [{ org, acct }] = await rows(
      "select organization_id org, id acct from whatsapp_accounts limit 1",
    );
    const client = await t.pool.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `wa-message:${org}:${acct}:${wamid}`,
    ]);
    return {
      release: async () => {
        await client.query("rollback");
        client.release();
      },
    };
  }

  // ----------------------------------------------------------------------------------------- opt-in / refusal
  describe("refuses to start", () => {
    it("without WHATSAPP_WORKER_ENABLED: exits 2 with an explanation, opens no connection, changes nothing", async () => {
      await tenant(t.db);
      await post("wamid.OFF1", "LK.OFF1");
      const before = await snapshot();
      const w = start({ DATABASE_URL: t.url });
      expect(await w.exited).toMatchObject({ code: 2 });
      expect(w.output()).toContain("WHATSAPP_WORKER_ENABLED=true");
      expect(w.output()).toMatch(/disabled/i);
      expect(await workerSessions()).toBe(0);
      expect(await snapshot()).toEqual(before);
      expect(before[0]).toMatchObject({ status: "PENDING", attempts: 0, locked_by: null });
      expect(w.lines.filter((l) => l.webhook_event === "worker.started")).toEqual([]);
    });

    it.each(["TRUE", "1", "yes", "false", ""])(
      "WHATSAPP_WORKER_ENABLED=%j is not an opt-in",
      async (flag) => {
        await tenant(t.db);
        await post("wamid.OFF2", "LK.OFF2");
        const before = await snapshot();
        const w = start({ DATABASE_URL: t.url, WHATSAPP_WORKER_ENABLED: flag });
        expect((await w.exited).code).toBe(2);
        expect(await snapshot()).toEqual(before);
        expect(await workerSessions()).toBe(0);
      },
    );

    it("an invalid configuration exits 2 naming the key, never the value", async () => {
      const w = start({
        DATABASE_URL: "postgresql://admin:Sup3rSecretPw@localhost:5432/x",
        WHATSAPP_WORKER_ENABLED: "true",
        WHATSAPP_WORKER_CONCURRENCY: "500",
      });
      expect((await w.exited).code).toBe(2);
      expect(w.output()).toContain("WHATSAPP_WORKER_CONCURRENCY");
      expect(w.output()).not.toContain("Sup3rSecretPw");
      expect(await workerSessions()).toBe(0);
    });

    it("a database that was never migrated: exits 2, creates nothing, claims nothing", async () => {
      const bare = await createTestDatabase({ migrate: false });
      try {
        const w = start({ DATABASE_URL: bare.url, WHATSAPP_WORKER_ENABLED: "true" });
        expect((await w.exited).code).toBe(2);
        expect(w.lines.find((l) => l.webhook_event === "worker.fatal")).toMatchObject({
          reason: "schema_not_ready",
        });
        const tables = await bare.pool.query(
          "select count(*)::int n from information_schema.tables where table_schema in ('public', 'drizzle')",
        );
        expect(tables.rows[0].n).toBe(0);
        expect(w.output()).not.toContain(bare.url);
      } finally {
        await bare.close();
      }
    });

    it("a database that does not exist: exits 2 at once (a configuration error is not retried)", async () => {
      const url = new URL(t.url);
      url.pathname = "/al_ict_no_such_database_xyz";
      const w = start({ DATABASE_URL: url.toString(), WHATSAPP_WORKER_ENABLED: "true" });
      expect((await w.exited).code).toBe(2);
      expect(w.lines.find((l) => l.webhook_event === "worker.fatal")).toMatchObject({
        reason: "pg_3d000",
      });
    });
  });

  // --------------------------------------------------------------------------------------------- running
  describe("running", () => {
    it("processes a signed delivery, then stops cleanly on SIGTERM (exit 0) with its own bounded sessions closed", async () => {
      await tenant(t.db);
      await post("wamid.RUN1", "LK.RUN1");
      const w = start(enabled());
      await w.ready();
      await waitStatus("wamid.RUN1", "PROCESSED");
      expect(await count("messages")).toBe(1);
      expect(await workerSessions()).toBeGreaterThan(0);
      w.kill("SIGTERM");
      expect(await w.exited).toEqual({ code: 0, signal: null });
      expect(w.lines.map((l) => l.webhook_event)).toEqual(
        expect.arrayContaining(["worker.started", "worker.stopping", "worker.stopped"]),
      );
      await until(async () => (await workerSessions()) === 0, 10_000);
    });

    it("SIGINT stops it the same way", async () => {
      await tenant(t.db);
      const w = start(enabled());
      await w.ready();
      w.kill("SIGINT");
      expect(await w.exited).toEqual({ code: 0, signal: null });
    });

    it("logs only fixed fields: no message text, phone, BSUID, wamid, secret or database password", async () => {
      await tenant(t.db);
      const { bytes } = deliveryBytes({
        id: "wamid.SECRETWAMID",
        bsuid: "LK.SECRETBSUID",
        from: "15550177123",
        name: "Sensitive Name",
      });
      await postSigned(t.db, bytes);
      const w = start(enabled());
      await w.ready();
      await waitStatus("wamid.SECRETWAMID", "PROCESSED");
      w.kill("SIGTERM");
      await w.exited;
      const out = w.output();
      for (const leak of [
        "SECRETWAMID",
        "SECRETBSUID",
        "15550177123",
        "Sensitive Name",
        "hello wamid",
        "postgres:postgres",
        TEST_APP_SECRET,
      ])
        expect(out, leak).not.toContain(leak);
      expect(out).toContain("worker.stopped");
    });
  });

  // -------------------------------------------------------------------------------------------- shutdown
  describe("graceful shutdown", () => {
    it("SIGTERM during an in-flight event lets it finish (PROCESSED), claims nothing further, then exits 0", async () => {
      await tenant(t.db);
      for (const n of [1, 2, 3]) await post(`wamid.SD${n}`, `LK.SD${n}`);
      const lock = await holdMessageLock("wamid.SD1"); // SD1 is claimed first (received_at order) and blocks inside its transaction
      const w = start(enabled({ WHATSAPP_WORKER_CONCURRENCY: "1" }));
      await w.ready();
      await waitStatus("wamid.SD1", "PROCESSING");
      w.kill("SIGTERM");
      await until(() => w.lines.some((l) => l.webhook_event === "worker.stopping"));
      // still running: the in-flight transaction is not cut short
      await new Promise((r) => setTimeout(r, 400));
      expect(w.child.exitCode).toBeNull();
      expect(
        (await rows("select status from webhook_events where provider_object_id = 'wamid.SD1'"))[0]
          .status,
      ).toBe("PROCESSING");
      await lock.release();
      expect(await w.exited).toEqual({ code: 0, signal: null });
      expect(
        (await rows("select status from webhook_events where provider_object_id = 'wamid.SD1'"))[0]
          .status,
      ).toBe("PROCESSED");
      for (const n of [2, 3]) {
        const [e] = await rows(
          "select status, attempts, locked_by from webhook_events where provider_object_id = $1",
          [`wamid.SD${n}`],
        );
        expect(e, `SD${n}`).toMatchObject({ status: "PENDING", attempts: 0, locked_by: null });
      }
      expect(await count("messages")).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------------- crash recovery
  describe("crash and restart", () => {
    it("SIGKILL mid-event leaves the event PROCESSING with nothing written; after the lease expires another worker reclaims it exactly once", async () => {
      await tenant(t.db);
      await post("wamid.CR1", "LK.CR1");
      const lock = await holdMessageLock("wamid.CR1");
      const first = start(enabled());
      await first.ready();
      await waitStatus("wamid.CR1", "PROCESSING");
      first.kill("SIGKILL");
      expect((await first.exited).signal).toBe("SIGKILL");
      await lock.release();
      // the orphaned transaction cannot commit: nothing was written and the event is still leased
      await new Promise((r) => setTimeout(r, 300));
      expect(await count("messages")).toBe(0);
      expect(await count("contacts")).toBe(0);
      expect(
        (
          await rows(
            "select status, attempts from webhook_events where provider_object_id = 'wamid.CR1'",
          )
        )[0],
      ).toMatchObject({ status: "PROCESSING", attempts: 1 });
      // a second worker does not take it while the lease is valid
      const second = start(enabled());
      await second.ready();
      await new Promise((r) => setTimeout(r, 500));
      expect(
        (await rows("select status from webhook_events where provider_object_id = 'wamid.CR1'"))[0]
          .status,
      ).toBe("PROCESSING");
      await expireLeases(t.pool);
      await waitStatus("wamid.CR1", "PROCESSED");
      const [e] = await rows(
        "select attempts from webhook_events where provider_object_id = 'wamid.CR1'",
      );
      expect(e.attempts).toBe(2);
      expect(await count("messages")).toBe(1);
      expect(await count("contacts")).toBe(1);
      expect(await count("conversations")).toBe(1);
      second.kill("SIGTERM");
      expect((await second.exited).code).toBe(0);
    });

    it("two workers draining one queue process each event exactly once", async () => {
      await tenant(t.db);
      for (let i = 0; i < 30; i++) await post(`wamid.TW${i}`, `LK.TW${i % 5}`);
      const a = start(enabled());
      const b = start(enabled());
      await Promise.all([a.ready(), b.ready()]);
      await until(
        async () =>
          (await rows("select count(*)::int n from webhook_events where status = 'PROCESSED'"))[0]
            .n === 30,
        30_000,
      );
      expect(await count("messages")).toBe(30);
      expect(await count("contacts")).toBe(5);
      expect((await rows("select max(attempts)::int m from webhook_events"))[0].m).toBe(1);
      for (const w of [a, b]) w.kill("SIGTERM");
      expect((await a.exited).code).toBe(0);
      expect((await b.exited).code).toBe(0);
      const e = await eventStatus(
        t.db,
        (await rows("select id from webhook_events limit 1"))[0].id,
      );
      expect(e.status).toBe("PROCESSED");
    });
  });
});
