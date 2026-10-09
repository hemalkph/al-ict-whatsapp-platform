import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { handleInboundMessage } from "../inbound/handler";
import { addAccount, deliveryBytes, tenant } from "../inbound/testing";
import { PermanentWebhookError } from "../queue/errors";
import type { WebhookHandlerRegistry } from "../queue/process";
import { deferred, expireLeases, insertEvent, makeFailedDue, until } from "../queue/testing";
import { handleMessageStatus } from "../status/handler";
import { seedMessage, statusBytes } from "../status/testing";
import { EXIT_FATAL, EXIT_REFUSED, EXIT_STOPPED, runWorker, type RunOptions } from "./run";
import { disableAccount } from "../operator/accounts";
import { TEST_APP_SECRET, postSigned } from "./testing";

// The worker loop on REAL PostgreSQL, run in-process with the real handlers (and, for fault injection, wrapped ones).
// Every delivery enters through the real signed webhook handler.

const PN2 = "100000000000002";
const WABA2 = "200000000000002";
const BASE = 1_790_000_000;

describe("whatsapp worker on PostgreSQL", () => {
  let t: TestDb;
  const running: Array<{ controller: AbortController; done: Promise<number> }> = [];
  const logs: Record<string, unknown>[] = [];
  const printed: string[] = [];
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    logs.length = 0;
    printed.length = 0;
    vi.stubEnv("META_APP_SECRET", TEST_APP_SECRET);
    for (const method of ["log", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation((line: unknown) => {
        try {
          logs.push(JSON.parse(String(line)) as Record<string, unknown>);
        } catch {
          // not a log record
        }
      });
    await t.pool.query(
      "truncate webhook_events, webhook_requests, whatsapp_accounts, organizations cascade",
    );
  });
  afterEach(async () => {
    for (const w of running.splice(0)) {
      w.controller.abort();
      await w.done;
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const rows = async (query: string, params: unknown[] = []) =>
    (await t.pool.query(query, params)).rows;
  const count = async (table: string) =>
    (await rows(`select count(*)::int n from ${table}`))[0].n as number;
  const domain = async () => ({
    contacts: await count("contacts"),
    conversations: await count("conversations"),
    messages: await count("messages"),
    history: await count("message_status_events"),
  });
  const byWamid = async (wamid: string) =>
    (
      await rows(
        "select * from webhook_events where provider_object_id = $1 order by received_at",
        [wamid],
      )
    )[0];
  const eventsOf = (type: string) =>
    rows("select * from webhook_events where event_type = $1", [type]);
  const allProcessed = async () =>
    (await rows("select count(*)::int n from webhook_events where status <> 'PROCESSED'"))[0].n ===
    0;

  /** A worker sharing the test pool (its close is a no-op); idle waits are short so tests are quick. */
  function start(
    options: Omit<Partial<RunOptions>, "env"> & { env?: Record<string, string | undefined> } = {},
  ) {
    const { env, ...rest } = options;
    const controller = new AbortController();
    const done = runWorker({
      env: { WHATSAPP_WORKER_ENABLED: "true", DATABASE_URL: t.url, ...env },
      signal: controller.signal,
      print: (m) => void printed.push(m),
      createDatabase: () => ({ db: t.db, close: async () => undefined }),
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(ms, 25));
          signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        }),
      ...rest,
    });
    const w = { controller, done, stop: () => (controller.abort(), done) };
    running.push(w);
    return w;
  }
  const post = async (bytes: Uint8Array) =>
    expect((await postSigned(t.db, bytes)).status).toBe(200);
  const statusDelivery = (
    id: string,
    status: string,
    offset: number,
    o: { pn?: string; waba?: string } = {},
  ) => statusBytes({ id, status, timestamp: BASE + offset, ...o });

  // ----------------------------------------------------------------------------------- A. MESSAGE events
  it("A. a signed message delivery becomes a contact, conversation and inbound message, and the event is PROCESSED", async () => {
    const { org, account } = await tenant(t.db);
    const { bytes } = deliveryBytes({
      id: "wamid.A1",
      bsuid: "LK.A1",
      from: "15550100123",
      name: "Student",
    });
    await post(bytes);
    expect(await byWamid("wamid.A1")).toMatchObject({
      status: "PENDING",
      attempts: 0,
      event_type: "MESSAGE",
    });
    const w = start();
    await until(async () => (await byWamid("wamid.A1")).status === "PROCESSED");
    expect(await w.stop()).toBe(EXIT_STOPPED);
    expect(await domain()).toEqual({ contacts: 1, conversations: 1, messages: 1, history: 0 });
    expect((await rows("select * from messages"))[0]).toMatchObject({
      direction: "INBOUND",
      wamid: "wamid.A1",
      organization_id: org.id,
      whatsapp_account_id: account.id,
    });
    expect(await byWamid("wamid.A1")).toMatchObject({
      status: "PROCESSED",
      attempts: 1,
      last_error: null,
      locked_by: null,
    });
    expect((await rows("select count(*)::int n from contact_bsuids"))[0].n).toBe(1);
  });

  // ------------------------------------------------------------------------------------ B. STATUS events
  it("B. a signed status delivery records the history, updates the outbound message and the event is PROCESSED", async () => {
    const { org, account } = await tenant(t.db);
    const { message } = await seedMessage(t.db, {
      organizationId: org.id,
      whatsappAccountId: account.id,
      wamid: "wamid.B1",
    });
    for (const [s, o] of [
      ["sent", 0],
      ["read", 20],
      ["delivered", 10],
    ] as const)
      await post(statusDelivery("wamid.B1", s, o));
    start();
    await until(allProcessed);
    expect(
      (await rows("select status from message_status_events order by occurred_at")).map(
        (r) => r.status,
      ),
    ).toEqual(["SENT", "DELIVERED", "READ"]);
    expect(
      (await rows("select latest_status from messages where id = $1", [message.id]))[0]
        .latest_status,
    ).toBe("READ");
    expect((await domain()).messages).toBe(1); // no message was created by a status
  });

  it("B2. a status that arrives before its message is kept unlinked and creates nothing", async () => {
    await tenant(t.db);
    await post(statusDelivery("wamid.B2", "delivered", 0));
    start();
    await until(allProcessed);
    expect(await domain()).toEqual({ contacts: 0, conversations: 0, messages: 0, history: 1 });
    expect((await rows("select message_id from message_status_events"))[0].message_id).toBeNull();
  });

  // -------------------------------------------------------------------------------------- C. duplicates
  it("C. a duplicate delivery produces one event; extra events for the same message or status add nothing", async () => {
    const { org, account } = await tenant(t.db);
    await seedMessage(t.db, {
      organizationId: org.id,
      whatsappAccountId: account.id,
      wamid: "wamid.C0",
    });
    const { bytes } = deliveryBytes({ id: "wamid.C1", bsuid: "LK.C1" });
    await post(bytes);
    await post(bytes); // Meta redelivers the identical body
    const status = statusDelivery("wamid.C0", "delivered", 0);
    await post(status);
    await post(status);
    expect(await count("webhook_events")).toBe(2);
    // two workers, plus copies of both events that bypass the ingest idempotency key
    const copy = async (wamid: string, type: "MESSAGE" | "STATUS") => {
      const e = await byWamid(wamid);
      await insertEvent(t.db, {
        organizationId: e.organization_id,
        whatsappAccountId: e.whatsapp_account_id,
        payload: e.payload,
        eventType: type,
      });
    };
    await copy("wamid.C1", "MESSAGE");
    await copy("wamid.C0", "STATUS");
    start();
    start();
    await until(allProcessed);
    expect(await count("messages")).toBe(2); // the seeded outbound one and ONE inbound
    expect(await count("message_status_events")).toBe(1);
    expect(await count("contacts")).toBe(2);
  });

  // ------------------------------------------------------------------------------- D. unsupported types
  it("D. OTHER and IDENTITY events are never claimed, even beside events that are processed", async () => {
    const { org, account } = await tenant(t.db);
    for (const eventType of ["OTHER", "IDENTITY"] as const)
      await insertEvent(t.db, { organizationId: org.id, whatsappAccountId: account.id, eventType });
    const { bytes } = deliveryBytes({ id: "wamid.D1", bsuid: "LK.D1" });
    await post(bytes);
    const w = start();
    await until(async () => (await byWamid("wamid.D1")).status === "PROCESSED");
    await new Promise((r) => setTimeout(r, 300)); // several more polls
    await w.stop();
    for (const type of ["OTHER", "IDENTITY"])
      expect((await eventsOf(type))[0], type).toMatchObject({
        status: "PENDING",
        attempts: 0,
        locked_by: null,
        locked_at: null,
        last_error: null,
      });
    expect(await count("messages")).toBe(1);
  });

  it("D2. real ingested system / identity-change / unsupported deliveries are left exactly as ingest stored them", async () => {
    await tenant(t.db);
    const { ingestFixture } = await import("../identity/testing");
    for (const f of [
      "system-user-changed-user-id.json",
      "system-user-changed-number-legacy.json",
      "user-id-update.json",
      "unsupported-field-change.json",
    ])
      await ingestFixture(t.db, f);
    const before = await rows("select * from webhook_events order by id");
    const w = start();
    await new Promise((r) => setTimeout(r, 300));
    await w.stop();
    const after = await rows("select * from webhook_events order by id");
    for (const [i, row] of after.entries())
      for (const key of Object.keys(row))
        expect(row[key], `${row.event_type}/${key}`).toEqual(before[i][key]);
    expect(await domain()).toEqual({ contacts: 0, conversations: 0, messages: 0, history: 0 });
  });

  it("D3. a worker whose only handlers do not match claims nothing at all", async () => {
    const { org, account } = await tenant(t.db);
    await insertEvent(t.db, {
      organizationId: org.id,
      whatsappAccountId: account.id,
      eventType: "OTHER",
    });
    const w = start({ handlers: {} });
    await new Promise((r) => setTimeout(r, 200));
    await w.stop();
    expect((await eventsOf("OTHER"))[0]).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  // ------------------------------------------------------------------------------------ E. account state
  describe("E. inactive accounts", () => {
    const send = async (wamid: string) => {
      const { bytes } = deliveryBytes({ id: wamid, bsuid: `LK.${wamid}` });
      await post(bytes);
      await post(statusDelivery(`${wamid}.s`, "read", 0));
    };

    it.each([
      [
        "DISABLED",
        "update whatsapp_accounts set status = 'DISABLED'",
        "IGNORED",
        "account_disabled",
      ],
      [
        "archived",
        "update whatsapp_accounts set archived_at = now()",
        "IGNORED",
        "account_archived",
      ],
      [
        "PENDING",
        "update whatsapp_accounts set status = 'PENDING'",
        "UNROUTABLE",
        "account_pending",
      ],
    ])(
      "an account that is %s when the worker reaches the events: nothing is processed, routing is kept",
      async (_name, change, status, reason) => {
        const { org, account } = await tenant(t.db);
        await send("wamid.E1");
        await t.pool.query(change);
        const w = start();
        await until(
          async () =>
            (
              await rows("select count(*)::int n from webhook_events where status = $1", [status])
            )[0].n === 2,
        );
        await w.stop();
        const events = await rows("select * from webhook_events");
        for (const e of events)
          expect(e).toMatchObject({
            status,
            last_error: reason,
            attempts: 0,
            organization_id: org.id,
            whatsapp_account_id: account.id,
            locked_by: null,
          });
        expect(await domain()).toEqual({ contacts: 0, conversations: 0, messages: 0, history: 0 });
      },
    );

    it("re-activating the account does not requeue anything: that is an operator decision, not the worker's", async () => {
      await tenant(t.db);
      await send("wamid.E2");
      await t.pool.query("update whatsapp_accounts set status = 'DISABLED'");
      const first = start();
      await until(
        async () =>
          (await rows("select count(*)::int n from webhook_events where status = 'IGNORED'"))[0]
            .n === 2,
      );
      await first.stop();
      await t.pool.query("update whatsapp_accounts set status = 'ACTIVE'");
      const second = start();
      await new Promise((r) => setTimeout(r, 300));
      await second.stop();
      expect((await rows("select status from webhook_events")).map((r) => r.status)).toEqual([
        "IGNORED",
        "IGNORED",
      ]);
      expect(await domain()).toEqual({ contacts: 0, conversations: 0, messages: 0, history: 0 });
    });

    it("an account disabled BEFORE the handler's own account check: that event is refused (rolled back) and the rest are ignored; nothing is processed", async () => {
      const { account } = await tenant(t.db);
      for (let i = 0; i < 6; i++)
        await post(deliveryBytes({ id: `wamid.E3${i}`, bsuid: `LK.E3${i}` }).bytes);
      const gate = deferred();
      const entered = deferred();
      const handlers: WebhookHandlerRegistry = {
        MESSAGE: async (tx, e, c) => {
          entered.resolve();
          await gate.promise;
          await handleInboundMessage(tx, e, c); // rechecks the account inside its own transaction
        },
      };
      const w = start({ handlers, env: { WHATSAPP_WORKER_CONCURRENCY: "1" } });
      await entered.promise; // the first event is mid-handler
      await t.pool.query("update whatsapp_accounts set status = 'DISABLED' where id = $1", [
        account.id,
      ]);
      gate.resolve();
      await until(
        async () =>
          (await rows("select count(*)::int n from webhook_events where status = 'IGNORED'"))[0]
            .n === 5,
      );
      const first = (await rows("select * from webhook_events order by received_at, id"))[0];
      expect(first).toMatchObject({
        status: "FAILED",
        attempts: 1,
        last_error: "unexpected_error",
      });
      await makeFailedDue(t.pool); // its retry meets the account gate and is ignored too
      await until(
        async () =>
          (await rows("select count(*)::int n from webhook_events where status = 'IGNORED'"))[0]
            .n === 6,
      );
      await w.stop();
      expect(await domain()).toEqual({ contacts: 0, conversations: 0, messages: 0, history: 0 });
      expect((await rows("select distinct last_error from webhook_events"))[0].last_error).toBe(
        "account_disabled",
      );
    });

    it("the operator's disable WAITS for a handler transaction that already wrote rows for the account and never cancels it", async () => {
      const { account } = await tenant(t.db);
      await post(deliveryBytes({ id: "wamid.E40", bsuid: "LK.E40" }).bytes);
      const passedCheck = deferred();
      const hold = deferred();
      const handlers: WebhookHandlerRegistry = {
        MESSAGE: async (tx, e, c) => {
          await handleInboundMessage(tx, e, c); // the account check and every domain write are done...
          passedCheck.resolve();
          await hold.promise; // ...and the transaction is still open
        },
      };
      const w = start({ handlers, env: { WHATSAPP_WORKER_CONCURRENCY: "1" } });
      await passedCheck.promise;
      // The command locks the account row FOR UPDATE; the open handler transaction holds a FOR KEY SHARE lock on it through
      // the foreign keys of the rows it inserted, so the command waits. It does not cancel the transaction.
      let disabled = false;
      const disabling = disableAccount(t.db, account.id, { apply: true }).then((r) => {
        disabled = true;
        return r;
      });
      await until(
        async () =>
          (
            await rows(
              "select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
            )
          ).length > 0,
      );
      expect(disabled).toBe(false);
      expect((await byWamid("wamid.E40")).status).toBe("PROCESSING");
      hold.resolve(); // the in-flight handler commits
      expect(await disabling).toMatchObject({ ok: true, account: { status: "DISABLED" } });
      await until(async () => (await byWamid("wamid.E40")).status === "PROCESSED");
      await w.stop();
      // the in-flight event was written although the account was disabled meanwhile; the disable did not cancel it
      expect(await count("messages")).toBe(1);
      expect((await rows("select status from whatsapp_accounts"))[0].status).toBe("DISABLED");
    });
  });

  // ------------------------------------------------------------------------------------ F. tenant isolation
  describe("F. tenant isolation", () => {
    it("the same wamid delivered to two organizations creates two independent messages, each in its own organization", async () => {
      const a = await tenant(t.db);
      const b = await tenant(t.db, { pn: PN2, waba: WABA2 });
      await post(deliveryBytes({ id: "wamid.F1", bsuid: "LK.F1" }).bytes);
      await post(deliveryBytes({ id: "wamid.F1", bsuid: "LK.F1", pn: PN2, waba: WABA2 }).bytes);
      const before = await rows(
        "select id, organization_id, whatsapp_account_id from webhook_events order by id",
      );
      // sequential on purpose: two events processed at the same instant could mask a missing organization filter
      start({ env: { WHATSAPP_WORKER_CONCURRENCY: "1" } });
      await until(allProcessed);
      expect(
        await rows(
          "select id, organization_id, whatsapp_account_id from webhook_events order by id",
        ),
      ).toEqual(before);
      const messages = await rows("select organization_id from messages order by organization_id");
      expect(messages.map((m) => m.organization_id).sort()).toEqual([a.org.id, b.org.id].sort());
      expect((await rows("select count(distinct contact_id)::int n from conversations"))[0].n).toBe(
        2,
      );
    });

    it("a status for one organization's wamid, delivered to another organization's number, never touches the first", async () => {
      const a = await tenant(t.db);
      const b = await tenant(t.db, { pn: PN2, waba: WABA2 });
      const { message } = await seedMessage(t.db, {
        organizationId: a.org.id,
        whatsappAccountId: a.account.id,
        wamid: "wamid.F2",
      });
      await post(statusDelivery("wamid.F2", "read", 0, { pn: PN2, waba: WABA2 }));
      start();
      await until(allProcessed);
      expect(
        (await rows("select latest_status from messages where id = $1", [message.id]))[0]
          .latest_status,
      ).toBeNull();
      expect(
        (await rows("select organization_id, message_id from message_status_events"))[0],
      ).toMatchObject({ organization_id: b.org.id, message_id: null });
    });

    it("an event routed to one account is never processed under another, even for the same organization", async () => {
      const { org, account } = await tenant(t.db);
      const second = await addAccount(t.db, org.id, PN2, WABA2);
      await post(deliveryBytes({ id: "wamid.F3", bsuid: "LK.F3", pn: PN2, waba: WABA2 }).bytes);
      start();
      await until(allProcessed);
      expect((await rows("select whatsapp_account_id from messages"))[0].whatsapp_account_id).toBe(
        second.id,
      );
      expect(account.id).not.toBe(second.id);
    });
  });

  // ------------------------------------------------------------------------------------- G. restart recovery
  it("G. an event claimed by a worker that then vanished is reclaimed after lease expiry and written exactly once", async () => {
    const { org, account } = await tenant(t.db);
    await post(deliveryBytes({ id: "wamid.G1", bsuid: "LK.G1" }).bytes);
    // the vanished worker: claimed, never finished
    await t.pool.query(
      "update webhook_events set status = 'PROCESSING', locked_at = now(), locked_by = 'dead-worker', attempts = 1",
    );
    const w = start();
    await new Promise((r) => setTimeout(r, 300));
    expect((await byWamid("wamid.G1")).status).toBe("PROCESSING"); // lease still valid: untouched
    expect(await count("messages")).toBe(0);
    await expireLeases(t.pool);
    await until(async () => (await byWamid("wamid.G1")).status === "PROCESSED");
    await w.stop();
    expect(await byWamid("wamid.G1")).toMatchObject({ attempts: 2 });
    expect(await domain()).toEqual({ contacts: 1, conversations: 1, messages: 1, history: 0 });
    // a later redelivery of the same message (a second event) is a duplicate: still one message
    const e = await byWamid("wamid.G1");
    await insertEvent(t.db, {
      organizationId: org.id,
      whatsappAccountId: account.id,
      payload: e.payload,
    });
    const again = start();
    await until(allProcessed);
    await again.stop();
    expect(await count("messages")).toBe(1);
  });

  it("G2. a worker that lost its lease mid-event cannot complete it or add anything; the reclaiming worker's result stands", async () => {
    await tenant(t.db);
    await post(deliveryBytes({ id: "wamid.G2", bsuid: "LK.G2" }).bytes);
    const entered = deferred();
    const hold = deferred();
    const first = start({
      handlers: {
        MESSAGE: async (tx, e, c) => {
          entered.resolve();
          await hold.promise; // stuck past its lease
          await handleInboundMessage(tx, e, c);
        },
      },
    });
    await entered.promise;
    await expireLeases(t.pool);
    const second = start();
    await until(async () => (await byWamid("wamid.G2")).status === "PROCESSED");
    const afterReclaim = await domain();
    hold.resolve();
    await until(() => logs.some((l) => l.webhook_event === "webhook.event_lease_lost"));
    await Promise.all([first.stop(), second.stop()]);
    expect(await domain()).toEqual(afterReclaim);
    expect(afterReclaim).toEqual({ contacts: 1, conversations: 1, messages: 1, history: 0 });
    expect(await byWamid("wamid.G2")).toMatchObject({ status: "PROCESSED", attempts: 2 });
  });

  it("G3. a worker that lost its lease cannot complete an event that another worker now owns", async () => {
    await tenant(t.db);
    await post(deliveryBytes({ id: "wamid.G3", bsuid: "LK.G3" }).bytes);
    const holds = [deferred(), deferred()];
    const entered = [deferred(), deferred()];
    let call = 0;
    const handlers: WebhookHandlerRegistry = {
      MESSAGE: async (tx, e, c) => {
        const me = call++;
        entered[me]!.resolve();
        await holds[me]!.promise;
        await handleInboundMessage(tx, e, c);
      },
    };
    const first = start({ handlers });
    await entered[0]!.promise;
    await expireLeases(t.pool); // the first worker's lease runs out while it is stuck
    const second = start({ handlers });
    await entered[1]!.promise; // the second worker now owns the event and is mid-handler
    const owner = (await byWamid("wamid.G3")).locked_by;
    holds[0]!.resolve(); // the first worker wakes up and tries to finish
    await until(() => logs.some((l) => l.webhook_event === "webhook.event_lease_lost"));
    expect(await byWamid("wamid.G3")).toMatchObject({ status: "PROCESSING", locked_by: owner });
    expect(await domain()).toEqual({ contacts: 0, conversations: 0, messages: 0, history: 0 });
    holds[1]!.resolve();
    await until(async () => (await byWamid("wamid.G3")).status === "PROCESSED");
    await Promise.all([first.stop(), second.stop()]);
    expect(await domain()).toEqual({ contacts: 1, conversations: 1, messages: 1, history: 0 });
    expect(await byWamid("wamid.G3")).toMatchObject({ attempts: 2 });
  });

  // --------------------------------------------------------------------------------------- H. error handling
  describe("H. error handling", () => {
    it("a transient error retries later with backoff and then succeeds; nothing is PROCESSED in between", async () => {
      await tenant(t.db);
      await post(deliveryBytes({ id: "wamid.H1", bsuid: "LK.H1" }).bytes);
      let fail = true;
      const handlers: WebhookHandlerRegistry = {
        MESSAGE: async (tx, e, c) => {
          await handleInboundMessage(tx, e, c); // writes happen, then the failure rolls them back
          if (fail) throw new Error("transient");
        },
      };
      const w = start({ handlers });
      await until(async () => (await byWamid("wamid.H1")).status === "FAILED");
      const failed = await byWamid("wamid.H1");
      expect(failed).toMatchObject({ attempts: 1, last_error: "unexpected_error" });
      expect(new Date(failed.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 20_000); // ~30 s +/- jitter
      expect(await domain()).toEqual({ contacts: 0, conversations: 0, messages: 0, history: 0 });
      await new Promise((r) => setTimeout(r, 200));
      expect((await byWamid("wamid.H1")).attempts).toBe(1); // not retried before it is due
      fail = false;
      await makeFailedDue(t.pool);
      await until(async () => (await byWamid("wamid.H1")).status === "PROCESSED");
      await w.stop();
      expect(await byWamid("wamid.H1")).toMatchObject({ attempts: 2, last_error: null });
      expect(await count("messages")).toBe(1);
    });

    it("a permanent error becomes DEAD after one run and is never retried or PROCESSED", async () => {
      await tenant(t.db);
      await post(deliveryBytes({ id: "wamid.H2", bsuid: "LK.H2" }).bytes);
      let runs = 0;
      const handlers: WebhookHandlerRegistry = {
        MESSAGE: async () => {
          runs++;
          throw new PermanentWebhookError("test_permanent");
        },
      };
      const w = start({ handlers });
      await until(async () => (await byWamid("wamid.H2")).status === "DEAD");
      await new Promise((r) => setTimeout(r, 200));
      await w.stop();
      expect(runs).toBe(1);
      expect(await byWamid("wamid.H2")).toMatchObject({
        status: "DEAD",
        attempts: 1,
        last_error: "test_permanent",
      });
    });

    it("an event that keeps failing stops after the 8th run as DEAD, never PROCESSED", async () => {
      await tenant(t.db);
      await post(deliveryBytes({ id: "wamid.H3", bsuid: "LK.H3" }).bytes);
      let runs = 0;
      const handlers: WebhookHandlerRegistry = {
        MESSAGE: async () => {
          runs++;
          throw new Error("always");
        },
      };
      const w = start({ handlers });
      for (let i = 0; i < 8; i++) {
        // ONE read per check: the status and attempt count must come from the same row version
        await until(async () => {
          const e = await byWamid("wamid.H3");
          return e.status !== "PROCESSING" && e.attempts === i + 1;
        });
        await makeFailedDue(t.pool);
      }
      await until(async () => (await byWamid("wamid.H3")).status === "DEAD");
      await w.stop();
      expect(runs).toBe(8);
      expect(await byWamid("wamid.H3")).toMatchObject({ status: "DEAD", attempts: 8 });
    });

    it("real handler failures: an invalid timestamp is DEAD at once, and its sibling events are unaffected", async () => {
      await tenant(t.db);
      await post(deliveryBytes({ id: "wamid.H4", bsuid: "LK.H4", timestamp: "not-a-time" }).bytes);
      await post(deliveryBytes({ id: "wamid.H5", bsuid: "LK.H5" }).bytes);
      start();
      await until(
        async () =>
          (await byWamid("wamid.H5")).status === "PROCESSED" &&
          (await byWamid("wamid.H4")).status === "DEAD",
      );
      expect(await byWamid("wamid.H4")).toMatchObject({
        last_error: "invalid_timestamp",
        attempts: 1,
      });
      expect(await count("messages")).toBe(1);
    });

    it("a failing STATUS handler rolls back the history row and the cached status, and the event is not PROCESSED", async () => {
      const { org, account } = await tenant(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.H7",
      });
      await post(statusDelivery("wamid.H7", "read", 0));
      const handlers: WebhookHandlerRegistry = {
        STATUS: async (tx, e, c) => {
          await handleMessageStatus(tx, e, c);
          throw new Error("later step failed");
        },
      };
      const w = start({ handlers });
      await until(async () => (await byWamid("wamid.H7")).status === "FAILED");
      await w.stop();
      expect(await count("message_status_events")).toBe(0);
      expect(
        (await rows("select latest_status from messages where id = $1", [message.id]))[0]
          .latest_status,
      ).toBeNull();
      expect(await byWamid("wamid.H7")).toMatchObject({ status: "FAILED", attempts: 1 });
    });

    it("a COMMIT-time database failure marks nothing PROCESSED and writes nothing", async () => {
      await tenant(t.db);
      await t.pool.query(`create table if not exists worker_deferred_parent (id int primary key);
        create table if not exists worker_deferred_child (parent_id int references worker_deferred_parent(id) deferrable initially deferred)`);
      await post(deliveryBytes({ id: "wamid.H6", bsuid: "LK.H6" }).bytes);
      const handlers: WebhookHandlerRegistry = {
        MESSAGE: async (tx, e, c) => {
          await handleInboundMessage(tx, e, c);
          await tx.execute(
            (await import("drizzle-orm"))
              .sql`insert into worker_deferred_child (parent_id) values (999)`,
          );
        },
      };
      const w = start({ handlers });
      await until(async () => (await byWamid("wamid.H6")).status === "FAILED");
      await w.stop();
      expect(await byWamid("wamid.H6")).toMatchObject({ status: "FAILED", last_error: "pg_23503" });
      expect(await domain()).toEqual({ contacts: 0, conversations: 0, messages: 0, history: 0 });
      await t.pool.query("drop table worker_deferred_child; drop table worker_deferred_parent");
    });
  });

  // ------------------------------------------------------------------------------------ concurrency bounds
  it("never runs more handlers at once than the configured concurrency (default 2, and 1 when set)", async () => {
    await tenant(t.db);
    for (let i = 0; i < 10; i++)
      await post(deliveryBytes({ id: `wamid.K${i}`, bsuid: `LK.K${i}` }).bytes);
    for (const [limit, env] of [
      [2, {}],
      [1, { WHATSAPP_WORKER_CONCURRENCY: "1" }],
    ] as const) {
      await t.pool.query(
        "update webhook_events set status = 'PENDING', attempts = 0, locked_by = null, locked_at = null, processed_at = null",
      );
      await t.pool.query("truncate messages, conversations, contact_bsuids, contacts cascade");
      let live = 0;
      let peak = 0;
      const handlers: WebhookHandlerRegistry = {
        MESSAGE: async (tx, e, c) => {
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 30));
          try {
            await handleInboundMessage(tx, e, c);
          } finally {
            live--;
          }
        },
      };
      const w = start({ handlers, env });
      await until(allProcessed);
      await w.stop();
      expect(peak, `concurrency ${limit}`).toBe(limit);
    }
  });

  // --------------------------------------------------------------------------------------------- I. shutdown
  describe("I. shutdown", () => {
    it("after the stop signal no further event is claimed; the in-flight one finishes and the exit is clean", async () => {
      await tenant(t.db);
      for (let i = 0; i < 5; i++)
        await post(deliveryBytes({ id: `wamid.I${i}`, bsuid: `LK.I${i}` }).bytes);
      const gate = deferred();
      const entered = deferred();
      const handlers: WebhookHandlerRegistry = {
        MESSAGE: async (tx, e, c) => {
          entered.resolve();
          await gate.promise;
          await handleInboundMessage(tx, e, c);
        },
      };
      const w = start({ handlers, env: { WHATSAPP_WORKER_CONCURRENCY: "1" } });
      await entered.promise;
      w.controller.abort();
      await new Promise((r) => setTimeout(r, 200));
      gate.resolve();
      expect(await w.done).toBe(EXIT_STOPPED);
      const statuses = await rows(
        "select status, attempts from webhook_events order by received_at, id",
      );
      expect(statuses[0]).toMatchObject({ status: "PROCESSED", attempts: 1 });
      expect(statuses.slice(1)).toEqual(Array(4).fill({ status: "PENDING", attempts: 0 }));
      expect(logs.map((l) => l.webhook_event)).toEqual(
        expect.arrayContaining(["worker.stopping", "worker.stopped"]),
      );
    });

    it("past the shutdown grace period the worker gives up (non-zero); the event stays leased for another worker", async () => {
      await tenant(t.db);
      await post(deliveryBytes({ id: "wamid.I9", bsuid: "LK.I9" }).bytes);
      const entered = deferred();
      const gate = deferred();
      const handlers: WebhookHandlerRegistry = {
        MESSAGE: async () => {
          entered.resolve();
          await gate.promise;
          throw new Error("released after the deadline");
        },
      };
      const w = start({ handlers, shutdownGraceMs: 150 });
      await entered.promise;
      w.controller.abort();
      expect(await w.done).toBe(EXIT_FATAL);
      expect((await byWamid("wamid.I9")).status).toBe("PROCESSING");
      expect(
        logs.some((l) => l.webhook_event === "worker.fatal" && l.reason === "shutdown_deadline"),
      ).toBe(true);
      gate.resolve();
    });
  });

  // --------------------------------------------------------------------------------------- J. disabled startup
  describe("J. disabled startup", () => {
    it.each([
      {},
      { WHATSAPP_WORKER_ENABLED: "false" },
      { WHATSAPP_WORKER_ENABLED: "TRUE" },
      { WHATSAPP_WORKER_ENABLED: "1" },
    ])("env %j: no database is opened, no event is claimed, nothing is modified", async (env) => {
      const { org, account } = await tenant(t.db);
      await post(deliveryBytes({ id: "wamid.J1", bsuid: "LK.J1" }).bytes);
      await insertEvent(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        eventType: "STATUS",
        status: "FAILED",
      });
      const before = await rows("select * from webhook_events order by id");
      const createDatabase = vi.fn(() => ({ db: t.db, close: async () => undefined }));
      const code = await runWorker({
        env: { DATABASE_URL: t.url, ...env },
        signal: new AbortController().signal,
        print: (m) => void printed.push(m),
        createDatabase,
      });
      expect(code).toBe(EXIT_REFUSED);
      expect(createDatabase).not.toHaveBeenCalled();
      expect(await rows("select * from webhook_events order by id")).toEqual(before);
      expect(await domain()).toEqual({ contacts: 0, conversations: 0, messages: 0, history: 0 });
      expect(printed.join(" ")).toContain("WHATSAPP_WORKER_ENABLED");
      expect(logs.filter((l) => l.webhook_event === "worker.started")).toEqual([]);
    });

    it("no import of the worker starts anything: importing the module claims nothing", async () => {
      await tenant(t.db);
      await post(deliveryBytes({ id: "wamid.J2", bsuid: "LK.J2" }).bytes);
      const before = await rows("select * from webhook_events order by id");
      await import("./index");
      await import("./registry");
      await new Promise((r) => setTimeout(r, 100));
      expect(await rows("select * from webhook_events order by id")).toEqual(before);
    });
  });

  // ------------------------------------------------------------------------------ database outage recovery
  describe("database outage", () => {
    const killWorkerSessions = () =>
      t.pool.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and application_name = 'al-ict-whatsapp-worker' and pid <> pg_backend_pid()",
      );
    const real = (): Partial<RunOptions> => ({ createDatabase: undefined });

    it("the worker survives its connections being killed, recovers, and processes later events", async () => {
      await tenant(t.db);
      const w = start(real());
      await until(
        async () =>
          (
            await rows(
              "select count(*)::int n from pg_stat_activity where datname = current_database() and application_name = 'al-ict-whatsapp-worker'",
            )
          )[0].n > 0,
      );
      await post(deliveryBytes({ id: "wamid.L1", bsuid: "LK.L1" }).bytes);
      await until(async () => (await byWamid("wamid.L1")).status === "PROCESSED");
      await killWorkerSessions();
      await post(deliveryBytes({ id: "wamid.L2", bsuid: "LK.L2" }).bytes);
      await until(async () => (await byWamid("wamid.L2")).status === "PROCESSED", 20_000);
      expect(await w.stop()).toBe(EXIT_STOPPED);
      expect(await count("messages")).toBe(2);
    });

    it("repeatedly killing the worker's connections mid-processing loses nothing, duplicates nothing and falsely processes nothing", async () => {
      await tenant(t.db);
      const N = 40;
      for (let i = 0; i < N; i++)
        await post(deliveryBytes({ id: `wamid.M${i}`, bsuid: `LK.M${i % 7}` }).bytes);
      // each handler lingers inside its transaction, so a kill lands in the middle of a transaction
      const slow: WebhookHandlerRegistry = {
        MESSAGE: async (tx, e, c) => {
          await new Promise((r) => setTimeout(r, 25));
          await handleInboundMessage(tx, e, c);
        },
      };
      const w = start({ ...real(), handlers: slow });
      // Six kills, 60 ms apart: no event can be killed often enough to exhaust its 8 attempts (that would be a legitimate
      // DEAD, visible to operators, and is covered by the queue tests); everything must then converge.
      let stop = false;
      const chaos = (async () => {
        for (let kills = 0; kills < 6 && !stop; kills++) {
          await new Promise((r) => setTimeout(r, 60));
          if (!stop) await killWorkerSessions();
        }
      })();
      try {
        // a killed handler leaves its event leased; expiring leases stands in for the passage of the lease time
        await until(async () => {
          // Only ORPHANED leases are expired (a killed handler never finishes). Expiring every lease blindly would also
          // reclaim events that live handlers are still working on, and enough of that exhausts their 8 attempts.
          await t.pool.query(
            "update webhook_events set locked_at = now() - interval '1 day' where status = 'PROCESSING' and locked_at < now() - interval '5 seconds'",
          );
          await t.pool.query(
            "update webhook_events set next_attempt_at = now() where status = 'FAILED'",
          );
          return (
            (await rows("select count(*)::int n from webhook_events where status = 'PROCESSED'"))[0]
              .n === N
          );
        }, 60_000);
      } catch (error) {
        // a non-converging run must say WHY (event states, sessions, the worker's own last log lines)
        const states = await rows(
          "select status, attempts, last_error, (locked_by is not null) leased, count(*)::int n from webhook_events where status <> 'PROCESSED' group by 1,2,3,4 order by 1,2",
        );
        const sessions = await rows(
          "select application_name app, state, wait_event_type wt, wait_event we from pg_stat_activity where datname = current_database()",
        );
        process.stderr.write(
          `NONCONVERGENCE ${JSON.stringify({ states, sessions, tail: logs.slice(-12).map((l) => [l.webhook_event, l.reason, l.count_processed, l.count_claimed]) })}\n`,
        );
        throw error;
      } finally {
        stop = true;
        await chaos;
      }
      expect(await w.stop()).toBe(EXIT_STOPPED);
      // the kills really interrupted work: some event needed a second run
      expect(
        (await rows("select max(attempts)::int m from webhook_events"))[0].m,
      ).toBeGreaterThanOrEqual(2);
      expect(await count("messages")).toBe(N); // one message per event: nothing lost, nothing duplicated
      expect(
        (
          await rows(
            "select count(*)::int n from webhook_events e where status = 'PROCESSED' and not exists (select 1 from messages m where m.wamid = e.provider_object_id)",
          )
        )[0].n,
      ).toBe(0);
      expect(
        (await rows("select max(attempts)::int m from webhook_events"))[0].m,
      ).toBeLessThanOrEqual(8);
      expect(
        (await rows("select count(*)::int n from webhook_events where status = 'DEAD'"))[0].n,
      ).toBe(0);
    }, 90_000);
  });
});
