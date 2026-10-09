import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import { claimWebhookEventRows } from "@/db/ops/webhook-queue";
import { ingestVerifiedDelivery } from "./ingest";
import { deliveryBytes } from "./inbound/testing";
import { inboundMessageHandlers } from "./inbound/handler";
import { processClaimedEvent } from "./queue/process";
import { deferred, until } from "./queue/testing";
import { lookupAccounts } from "./routing";
import { activateAccount } from "./operator/accounts";

// The account-activation race, reproduced with explicit barriers (no sleeps) on REAL PostgreSQL.
//
// Activation releases `account_pending` holds with a scan that sees only COMMITTED events. An ingest transaction that read
// the account while it was PENDING and inserts its event after that scan used to leave the event held for ever under an
// ACTIVE account. The contract now: the account state used to route an event is locked (FOR SHARE) until the transaction
// that inserts the event commits, so activation (FOR UPDATE) cannot complete in between.

describe("account activation versus event ingress", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
    await t.pool.query(
      "truncate webhook_events, webhook_requests, whatsapp_accounts, organizations cascade",
    );
  });
  // A failed assertion must never leave a transaction parked at a barrier: release everything first.
  const releases: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const release of releases.splice(0))
      await Promise.resolve(release()).catch(() => undefined);
    vi.restoreAllMocks();
  });

  const rows = async (q: string, p: unknown[] = []) => (await t.pool.query(q, p)).rows;
  const uid = () =>
    randomBytes(5)
      .toString("hex")
      .replace(/[a-f]/g, (c) => String(c.charCodeAt(0) % 10));
  const digits = () => `${Date.now() % 1_000_000}${uid()}`.padEnd(12, "7").slice(0, 14);

  async function account(status: "PENDING" | "ACTIVE" = "PENDING", orgId?: string) {
    const o = orgId ? { id: orgId } : await seedOrg(t.db);
    const pn = `1${digits()}`;
    const waba = orgId
      ? ((
          await rows("select waba_id from whatsapp_accounts where organization_id = $1 limit 1", [
            orgId,
          ])
        )[0]?.waba_id ?? `2${digits()}`)
      : `2${digits()}`;
    const [row] = (
      await t.pool.query(
        "insert into whatsapp_accounts (organization_id, waba_id, phone_number_id, display_phone_number, status) values ($1,$2,$3,'x',$4) returning *",
        [o.id, waba, pn, status],
      )
    ).rows;
    return { id: row.id as string, orgId: o.id as string, pn, waba: waba as string };
  }
  const bytes = (a: { pn: string; waba: string }, wamid: string) =>
    deliveryBytes({ id: wamid, bsuid: `LK.${wamid}`, pn: a.pn, waba: a.waba }).bytes;
  const ev = async (wamid: string) =>
    (await rows("select * from webhook_events where provider_object_id = $1", [wamid]))[0];

  /** True while some backend of this database is waiting for a lock. */
  const someoneWaitsForALock = async () =>
    (
      await rows(
        "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()",
      )
    )[0].n > 0;

  /** An ingest that reads the account state, then stops at a barrier BEFORE inserting its events. */
  function pausedIngest(body: Uint8Array) {
    const read = deferred();
    const resume = deferred();
    const done = ingestVerifiedDelivery(body, {
      db: t.db,
      lookupAccounts: async (tx, ids) => {
        const found = await lookupAccounts(tx, ids);
        read.resolve();
        await resume.promise;
        return found;
      },
    });
    releases.push(resume.resolve);
    return { read: read.promise, resume: resume.resolve, done };
  }

  // ------------------------------------------------------------------------------------------------ H1
  it("ingress read PENDING, activation requested before the insert: the event is never stranded under an ACTIVE account", async () => {
    const A = await account("PENDING");
    const ingest = pausedIngest(bytes(A, "wamid.RACE1"));
    await ingest.read; // the ingest transaction has read the account as PENDING and is paused before inserting

    let activationDone = false;
    const activation = activateAccount(t.db, A.id, { apply: true }).then(
      (r) => ((activationDone = true), r),
    );
    // activation either finished already (the bug) or is waiting on the account row that the ingest transaction holds
    await until(async () => activationDone || (await someoneWaitsForALock()));
    expect(
      activationDone,
      "activation must wait for the ingest transaction that observed PENDING",
    ).toBe(false);

    ingest.resume();
    const [, activated] = await Promise.all([ingest.done, activation]);
    expect(activated).toMatchObject({ ok: true, released: { requeued: 1 } });
    expect(
      (await rows("select status from whatsapp_accounts where id = $1", [A.id]))[0].status,
    ).toBe("ACTIVE");
    expect(await ev("wamid.RACE1")).toMatchObject({
      status: "PENDING",
      attempts: 0,
      last_error: null,
      organization_id: A.orgId,
      whatsapp_account_id: A.id,
    });
    expect(
      await rows(
        "select 1 from webhook_events where status = 'UNROUTABLE' and last_error = 'account_pending'",
      ),
    ).toHaveLength(0);
  });

  it("an activation that completed first is observed: the event is eligible for normal processing at once", async () => {
    const A = await account("PENDING");
    await activateAccount(t.db, A.id, { apply: true });
    await ingestVerifiedDelivery(bytes(A, "wamid.AFTER"), { db: t.db });
    expect(await ev("wamid.AFTER")).toMatchObject({
      status: "PENDING",
      last_error: null,
      organization_id: A.orgId,
      whatsapp_account_id: A.id,
    });
  });

  it("an activation still in flight when ingress starts: ingress waits and reads the NEW state", async () => {
    const A = await account("PENDING");
    // the operator transaction, stopped after changing the account and before committing (and before its release scan)
    const operator = await t.pool.connect();
    releases.push(async () => {
      await operator.query("rollback");
      operator.release();
    });
    await operator.query("begin");
    await operator.query("select 1 from whatsapp_accounts where id = $1 for update", [A.id]);
    await operator.query("update whatsapp_accounts set status = 'ACTIVE' where id = $1", [A.id]);

    let ingested = false;
    const ingest = ingestVerifiedDelivery(bytes(A, "wamid.INFLIGHT"), { db: t.db }).then(
      () => (ingested = true),
    );
    await until(() => someoneWaitsForALock());
    expect(
      ingested,
      "ingress must wait for the uncommitted state change, not route from the old row",
    ).toBe(false);
    await operator.query("commit");
    operator.release();
    releases.length = 0;
    await ingest;
    expect(await ev("wamid.INFLIGHT")).toMatchObject({ status: "PENDING", last_error: null });
  });

  it("DISABLE racing ingress: the event is classified from a state that held until it was inserted", async () => {
    const A = await account("PENDING");
    await t.pool.query("update whatsapp_accounts set status = 'ACTIVE' where id = $1", [A.id]);
    const ingest = pausedIngest(bytes(A, "wamid.DIS"));
    await ingest.read;
    const operator = t.pool.query(
      "update whatsapp_accounts set status = 'DISABLED' where id = $1",
      [A.id],
    );
    await until(() => someoneWaitsForALock());
    ingest.resume();
    await Promise.all([ingest.done, operator]);
    // classified ACTIVE (PENDING queue state) because that was true when it was routed; the worker's account gate decides later
    expect(await ev("wamid.DIS")).toMatchObject({ status: "PENDING" });
  });

  it("routing isolation: two organizations in one delivery are routed to their own accounts while an activation races", async () => {
    const A = await account("PENDING");
    const B = await account("PENDING");
    const both = Buffer.from(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [A, B].map((x, i) => ({
          id: x.waba,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "1", phone_number_id: x.pn },
                contacts: [{ wa_id: `1555010000${i}`, user_id: `LK.M${i}`, profile: {} }],
                messages: [
                  {
                    from: `1555010000${i}`,
                    from_user_id: `LK.M${i}`,
                    id: `wamid.MULTI${i}`,
                    timestamp: "1790000000",
                    type: "text",
                    text: { body: "x" },
                  },
                ],
              },
            },
          ],
        })),
      }),
    );
    const ingest = pausedIngest(both);
    await ingest.read;
    const acts = [
      activateAccount(t.db, B.id, { apply: true }),
      activateAccount(t.db, A.id, { apply: true }),
    ];
    await until(() => someoneWaitsForALock());
    ingest.resume();
    const results = await Promise.all([ingest.done, ...acts]);
    expect(results.slice(1)).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(await ev("wamid.MULTI0")).toMatchObject({
      status: "PENDING",
      organization_id: A.orgId,
      whatsapp_account_id: A.id,
    });
    expect(await ev("wamid.MULTI1")).toMatchObject({
      status: "PENDING",
      organization_id: B.orgId,
      whatsapp_account_id: B.id,
    });
    expect(A.orgId).not.toBe(B.orgId);
  });

  it("several accounts per delivery are locked in one deterministic order: concurrent deliveries and activations never deadlock and never strand an event", async () => {
    for (let round = 0; round < 8; round++) {
      const A = await account("PENDING");
      const B = await account("PENDING");
      const body = (first: typeof A, second: typeof A, tag: string) =>
        Buffer.from(
          JSON.stringify({
            object: "whatsapp_business_account",
            entry: [first, second].map((x, i) => ({
              id: x.waba,
              changes: [
                {
                  field: "messages",
                  value: {
                    messaging_product: "whatsapp",
                    metadata: { display_phone_number: "1", phone_number_id: x.pn },
                    contacts: [{ wa_id: "15550100001", user_id: `LK.${tag}${i}`, profile: {} }],
                    messages: [
                      {
                        from: "15550100001",
                        from_user_id: `LK.${tag}${i}`,
                        id: `wamid.${tag}${i}`,
                        timestamp: "1790000000",
                        type: "text",
                        text: { body: "x" },
                      },
                    ],
                  },
                },
              ],
            })),
          }),
        );
      const results = await Promise.allSettled([
        ingestVerifiedDelivery(body(A, B, `R${round}a`), { db: t.db }),
        ingestVerifiedDelivery(body(B, A, `R${round}b`), { db: t.db }), // opposite order in the body
        activateAccount(t.db, A.id, { apply: true }),
        activateAccount(t.db, B.id, { apply: true }),
        ingestVerifiedDelivery(body(B, A, `R${round}c`), { db: t.db }),
      ]);
      expect(
        results.map((r) => r.status),
        `round ${round}`,
      ).toEqual(Array(5).fill("fulfilled"));
      const stranded = await rows(
        "select 1 from webhook_events where status = 'UNROUTABLE' and last_error = 'account_pending' and whatsapp_account_id = any($1)",
        [[A.id, B.id]],
      );
      expect(stranded, `round ${round}`).toHaveLength(0);
      expect(
        (
          await rows(
            "select count(*)::int n from webhook_events where whatsapp_account_id = any($1)",
            [[A.id, B.id]],
          )
        )[0].n,
      ).toBe(6);
    }
  });

  it("idempotency is unchanged: redelivering the same body while the account is locked still yields one event", async () => {
    const A = await account("ACTIVE");
    const body = bytes(A, "wamid.IDEM");
    await Promise.all([
      ingestVerifiedDelivery(body, { db: t.db }),
      ingestVerifiedDelivery(body, { db: t.db }),
    ]);
    expect(
      await rows("select 1 from webhook_events where provider_object_id = 'wamid.IDEM'"),
    ).toHaveLength(1);
  });

  // --------------------------------------------------------------------------------- the worker's account gate
  describe("the worker's hold decision is made on a state that holds", () => {
    const deps = (afterAccountRead?: () => Promise<void>) => ({
      now: () => new Date(),
      random: Math.random,
      newLockOwner: () => "worker-test",
      leaseSeconds: 120,
      handlerTimeoutMs: 30_000,
      statementTimeoutMs: 15_000,
      afterAccountRead,
    });
    async function claimedEventFor(a: { id: string; pn: string; waba: string }, wamid: string) {
      await t.pool.query("update whatsapp_accounts set status = 'ACTIVE' where id = $1", [a.id]);
      await ingestVerifiedDelivery(bytes(a, wamid), { db: t.db });
      await t.pool.query("update whatsapp_accounts set status = 'PENDING' where id = $1", [a.id]);
      const [claimed] = await claimWebhookEventRows(t.db, {
        limit: 1,
        workerId: "worker-test",
        leaseSeconds: 120,
        eventTypes: ["MESSAGE"],
      });
      return claimed!;
    }

    it("worker read PENDING, activation completes before it holds: the event is processed, not held under an ACTIVE account", async () => {
      const A = await account("PENDING");
      const event = await claimedEventFor(A, "wamid.WGATE");
      const paused = deferred();
      const resume = deferred();
      const outcome = processClaimedEvent(
        t.db,
        event,
        inboundMessageHandlers,
        deps(async () => {
          paused.resolve();
          await resume.promise;
        }),
        "worker-test",
      );
      await paused.promise;
      const activated = await activateAccount(t.db, A.id, { apply: true }); // runs and commits while the worker is paused
      expect(activated).toMatchObject({ ok: true, released: { requeued: 0 } }); // the event is PROCESSING: nothing to release
      resume.resolve();
      expect(await outcome).toBe("processed");
      expect(await ev("wamid.WGATE")).toMatchObject({ status: "PROCESSED" });
    });

    it("worker holds from a PENDING reading while activation is requested: activation waits for the hold, then releases it", async () => {
      const A = await account("PENDING");
      const event = await claimedEventFor(A, "wamid.WHOLD");
      const paused = deferred();
      const resume = deferred();
      const outcome = processClaimedEvent(
        t.db,
        event,
        inboundMessageHandlers,
        deps(async () => {
          paused.resolve();
          await resume.promise;
        }),
        "worker-test",
      );
      await paused.promise;
      resume.resolve();
      expect(await outcome).toBe("held"); // PENDING is still true: the hold commits under the share lock
      expect(await ev("wamid.WHOLD")).toMatchObject({
        status: "UNROUTABLE",
        last_error: "account_pending",
        attempts: 0,
      });
      const activated = await activateAccount(t.db, A.id, { apply: true });
      expect(activated).toMatchObject({ ok: true, released: { requeued: 1 } }); // the hold was visible to activation's scan
      expect(await ev("wamid.WHOLD")).toMatchObject({ status: "PENDING" });
    });

    it("an activation in flight while the worker decides: the worker waits and reads the new state", async () => {
      const A = await account("PENDING");
      const event = await claimedEventFor(A, "wamid.WWAIT");
      const operator = await t.pool.connect();
      releases.push(async () => {
        await operator.query("rollback");
        operator.release();
      });
      await operator.query("begin");
      await operator.query("select 1 from whatsapp_accounts where id = $1 for update", [A.id]);
      await operator.query("update whatsapp_accounts set status = 'ACTIVE' where id = $1", [A.id]);
      const outcome = processClaimedEvent(
        t.db,
        event,
        inboundMessageHandlers,
        deps(),
        "worker-test",
      );
      await until(() => someoneWaitsForALock());
      await operator.query("commit");
      operator.release();
      releases.length = 0;
      expect(await outcome).toBe("processed");
    });
  });
});
