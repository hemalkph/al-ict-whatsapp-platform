import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { FIXTURE_DEFERRED_DDL, getEvent } from "../queue/testing";
import { processWebhookBatch } from "../queue/process";
import { identityLockKeys, resolveInboundContact, type ContactResolution } from "./resolve";
import {
  PN2,
  WABA2,
  DOMAIN_TABLES,
  minutesAgo,
  send,
  tenant,
  type SendOptions,
  type StoredEvent,
} from "./testing";

// Identity resolution under concurrent transactions and inside the worker's transaction, on REAL PostgreSQL.
// The advisory locks serialize competing messages; the unique constraints are the second, independent line of defense.

describe("identity resolution: concurrency, locking and the worker transaction", () => {
  let t: TestDb;
  const logs: string[] = [];
  beforeAll(async () => {
    t = await createTestDatabase();
    for (const ddl of FIXTURE_DEFERRED_DDL) await t.pool.query(ddl);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    logs.length = 0;
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((line: unknown) => void logs.push(String(line)));
    }
    await t.pool.query(
      "truncate webhook_events, webhook_requests, whatsapp_accounts, organizations, queue_fixture_parents cascade",
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const table of DOMAIN_TABLES) {
      const r = await t.pool.query(`select count(*)::int n from ${table}`);
      expect(r.rows[0].n, table).toBe(0);
    }
  });

  const resolve = (e: StoredEvent, observedAt = minutesAgo(1)) =>
    t.db.transaction((tx) => resolveInboundContact(tx, e, { observedAt }));
  const sendTo = (o: SendOptions) => send(t.db, o);
  const count = async (table: string) =>
    (await t.pool.query(`select count(*)::int n from ${table}`)).rows[0].n as number;
  const ids = (results: ContactResolution[]) => new Set(results.map((r) => r.contactId));

  // ---------------------------------------------------------------------------------------------------- creation
  it("many simultaneous first messages for one new BSUID create exactly one contact and one alias (repeated rounds)", async () => {
    await tenant(t.db);
    for (let round = 0; round < 6; round++) {
      const bsuid = `LK.CC${round}`;
      const from = `1555020${round}000`;
      const events = await Promise.all(
        Array.from({ length: 8 }, () => sendTo({ bsuid, from, name: `N${round}` })),
      );
      const results = await Promise.all(events.map((e) => resolve(e)));
      expect(ids(results).size, `round ${round}`).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      const aliasRows = await t.pool.query(
        "select contact_id from contact_bsuids where bsuid = $1",
        [bsuid],
      );
      expect(aliasRows.rows).toEqual([{ contact_id: results[0]!.contactId }]);
      const contactRows = await t.pool.query("select wa_id from contacts where wa_id = $1", [from]);
      expect(contactRows.rowCount).toBe(1);
    }
  });

  it("a BSUID-only message racing a BSUID + phone message for the same new BSUID ends as one contact that owns the phone", async () => {
    await tenant(t.db);
    for (let round = 0; round < 6; round++) {
      const bsuid = `LK.MX${round}`;
      const from = `1555030${round}000`;
      const events = await Promise.all(
        Array.from({ length: 6 }, (_, i) => sendTo(i % 2 === 0 ? { bsuid } : { bsuid, from })),
      );
      const results = await Promise.all(events.map((e) => resolve(e)));
      expect(ids(results).size, `round ${round}`).toBe(1);
      const row = (
        await t.pool.query("select wa_id from contacts where id = $1", [results[0]!.contactId])
      ).rows[0];
      expect(row.wa_id, `round ${round}`).toBe(from);
      expect(
        (await t.pool.query("select count(*)::int n from contact_bsuids where bsuid = $1", [bsuid]))
          .rows[0].n,
      ).toBe(1);
    }
  });

  it("different BSUIDs racing for one phone: exactly one contact gets the phone, the others are kept separate, none is merged", async () => {
    await tenant(t.db);
    for (let round = 0; round < 5; round++) {
      const from = `1555040${round}000`;
      const bsuids = [`LK.PH${round}A`, `LK.PH${round}B`, `LK.PH${round}C`];
      const events = await Promise.all(
        bsuids.flatMap((bsuid) => [sendTo({ bsuid, from }), sendTo({ bsuid, from })]),
      );
      const results = await Promise.all(events.map((e) => resolve(e)));
      expect(ids(results).size, `round ${round}`).toBe(3);
      const owners = await t.pool.query(
        "select b.bsuid, b.contact_id, c.wa_id from contact_bsuids b join contacts c on c.id = b.contact_id where b.bsuid = any($1) order by b.bsuid",
        [bsuids],
      );
      expect(new Set(owners.rows.map((r) => r.contact_id)).size).toBe(3);
      expect(owners.rows.filter((r) => r.wa_id === from)).toHaveLength(1);
      expect(owners.rows.filter((r) => r.wa_id === null)).toHaveLength(2);
    }
  });

  it("two unknown BSUIDs arriving with the same legacy phone each get their own contact; the legacy contact is never linked (repeated rounds)", async () => {
    await tenant(t.db);
    for (let round = 0; round < 6; round++) {
      const from = `1555050${round}000`;
      const legacy = await resolve(await sendTo({ from }));
      const legacyBefore = (
        await t.pool.query("select * from contacts where id = $1", [legacy.contactId])
      ).rows[0];
      const events = await Promise.all([
        sendTo({ bsuid: `LK.LG${round}A`, from }),
        sendTo({ bsuid: `LK.LG${round}B`, from }),
        sendTo({ bsuid: `LK.LG${round}A`, from }),
        sendTo({ bsuid: `LK.LG${round}B`, from }),
      ]);
      const results = await Promise.all(events.map((e) => resolve(e)));
      expect(ids(results).size, `round ${round}`).toBe(2);
      expect(results.some((r) => r.contactId === legacy.contactId)).toBe(false);
      expect(results.filter((r) => r.created)).toHaveLength(2);
      const owners = await t.pool.query(
        "select b.bsuid, b.contact_id, c.wa_id from contact_bsuids b join contacts c on c.id = b.contact_id where b.bsuid like $1",
        [`LK.LG${round}%`],
      );
      expect(owners.rows).toHaveLength(2);
      expect(new Set(owners.rows.map((r) => r.contact_id)).size).toBe(2);
      expect(owners.rows.every((r) => r.wa_id === null)).toBe(true);
      expect(
        (await t.pool.query("select * from contacts where id = $1", [legacy.contactId])).rows[0]
          .last_seen_at,
      ).toEqual(legacyBefore.last_seen_at);
      expect(
        (
          await t.pool.query("select count(*)::int n from contact_bsuids where contact_id = $1", [
            legacy.contactId,
          ])
        ).rows[0].n,
      ).toBe(0);
    }
  });

  it("a new BSUID racing older phone-only messages for the same legacy phone: the phone-only messages keep the legacy contact, the BSUID gets its own", async () => {
    await tenant(t.db);
    for (let round = 0; round < 6; round++) {
      const from = `1555051${round}000`;
      const legacy = await resolve(await sendTo({ from }));
      const events = await Promise.all([
        sendTo({ from }),
        sendTo({ bsuid: `LK.OP${round}`, from }),
        sendTo({ from }),
        sendTo({ bsuid: `LK.OP${round}`, from }),
        sendTo({ from }),
      ]);
      const results = await Promise.all(events.map((e) => resolve(e)));
      const phoneOnly = results.filter((_, i) => i % 2 === 0);
      const withBsuid = results.filter((_, i) => i % 2 === 1);
      expect(
        phoneOnly.every((r) => r.contactId === legacy.contactId),
        `round ${round}`,
      ).toBe(true);
      expect(ids(withBsuid).size).toBe(1);
      expect(withBsuid[0]!.contactId).not.toBe(legacy.contactId);
      const alias = await t.pool.query("select contact_id from contact_bsuids where bsuid = $1", [
        `LK.OP${round}`,
      ]);
      expect(alias.rows).toEqual([{ contact_id: withBsuid[0]!.contactId }]);
      expect(
        (await t.pool.query("select wa_id from contacts where id = $1", [withBsuid[0]!.contactId]))
          .rows[0].wa_id,
      ).toBeNull();
    }
  });

  it("a new BSUID and a phone-only message racing for a phone nobody owns yet always end in one of the two safe states", async () => {
    await tenant(t.db);
    const states = new Set<string>();
    for (let round = 0; round < 10; round++) {
      const from = `1555052${round}000`;
      const bsuid = `LK.UN${round}`;
      const [bsuidEvent, phoneEvent] = await Promise.all([
        sendTo({ bsuid, from }),
        sendTo({ from }),
      ]);
      const [bsuidResult, phoneResult] = await Promise.allSettled([
        resolve(bsuidEvent),
        resolve(phoneEvent),
      ]);
      expect(bsuidResult.status).toBe("fulfilled");
      const rows = (
        await t.pool.query(
          "select c.id, c.wa_id, (select count(*)::int from contact_bsuids b where b.contact_id = c.id) as aliases from contacts c where c.wa_id = $1 or c.id in (select contact_id from contact_bsuids where bsuid = $2)",
          [from, bsuid],
        )
      ).rows;
      if (phoneResult.status === "rejected") {
        // the BSUID won the race and owns the phone; the phone-only message was refused as ambiguous
        expect((phoneResult.reason as { code?: string }).code).toBe(
          "phone_only_identity_ambiguous",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ wa_id: from, aliases: 1 });
        states.add("bsuid-first");
      } else {
        // the phone-only contact came first; the BSUID got its own contact without the phone
        expect(rows).toHaveLength(2);
        expect(rows.filter((r) => r.wa_id === from && r.aliases === 0)).toHaveLength(1);
        expect(rows.filter((r) => r.wa_id === null && r.aliases === 1)).toHaveLength(1);
        states.add("phone-first");
      }
    }
    expect(states.size).toBeGreaterThan(0);
  });

  it("a new BSUID arriving while another transaction is updating the legacy contact waits for it, then gets its own contact", async () => {
    await tenant(t.db);
    const from = "15550530000";
    const legacy = await resolve(await sendTo({ from, name: "Old" }), minutesAgo(120));
    const phoneOnly = await sendTo({ from, name: "Updated By Holder" });
    const bsuidEvent = await sendTo({ bsuid: "LK.WAIT2", from, name: "Newcomer" });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const holder = t.db.transaction(async (tx) => {
      const r = await resolveInboundContact(tx, phoneOnly, { observedAt: minutesAgo(5) });
      started();
      await gate;
      return r;
    });
    await startedP;
    let settled = false;
    const waiter = resolve(bsuidEvent, minutesAgo(1)).then((r) => ((settled = true), r));
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false); // blocked on the phone's advisory lock
    release();
    const [held, waited] = await Promise.all([holder, waiter]);
    expect(held.contactId).toBe(legacy.contactId);
    expect(waited.contactId).not.toBe(legacy.contactId);
    expect(waited.conflicts).toEqual(["legacy_phone_ownership_unverified"]);
    const row = (
      await t.pool.query("select wa_id, profile_name from contacts where id = $1", [
        legacy.contactId,
      ])
    ).rows[0];
    expect(row).toEqual({ wa_id: from, profile_name: "Updated By Holder" });
    expect(
      (await t.pool.query("select wa_id from contacts where id = $1", [waited.contactId])).rows[0]
        .wa_id,
    ).toBeNull();
  });

  it("an existing retired alias observed while a different new BSUID arrives for the same contact's phone: independent, no merge, no promotion", async () => {
    const { org } = await tenant(t.db);
    const from = "15550600000";
    const x = await resolve(await sendTo({ bsuid: "LK.RT.CUR", from }));
    await t.pool.query(
      `insert into contact_bsuids (organization_id, contact_id, bsuid, first_seen_at, last_seen_at, retired_at)
       values ($1, $2, 'LK.RT.OLD', now() - interval '9 days', now() - interval '8 days', now() - interval '8 days')`,
      [org.id, x.contactId],
    );
    const before = (await t.pool.query("select * from contact_bsuids where bsuid = 'LK.RT.OLD'"))
      .rows[0];
    const events = await Promise.all([
      sendTo({ bsuid: "LK.RT.OLD", from }),
      sendTo({ bsuid: "LK.RT.NEW", from }),
      sendTo({ bsuid: "LK.RT.OLD" }),
      sendTo({ bsuid: "LK.RT.NEW", from }),
    ]);
    const results = await Promise.all(events.map((e) => resolve(e)));
    expect(results[0]!.contactId).toBe(x.contactId);
    expect(results[2]!.contactId).toBe(x.contactId);
    expect(results[1]!.contactId).not.toBe(x.contactId);
    expect(results[3]!.contactId).toBe(results[1]!.contactId);
    expect(
      (await t.pool.query("select * from contact_bsuids where bsuid = 'LK.RT.OLD'")).rows[0],
    ).toEqual(before);
    expect(await count("contacts")).toBe(2);
  });

  it("the same BSUID arriving simultaneously in two organizations creates one contact in each", async () => {
    const a = await tenant(t.db);
    const b = await tenant(t.db, { pn: PN2, waba: WABA2 });
    const events = await Promise.all([
      ...Array.from({ length: 4 }, () => sendTo({ bsuid: "LK.ORG", from: "15550700000" })),
      ...Array.from({ length: 4 }, () =>
        sendTo({ pn: PN2, waba: WABA2, bsuid: "LK.ORG", from: "15550700000" }),
      ),
    ]);
    const results = await Promise.all(events.map((e) => resolve(e)));
    expect(ids(results).size).toBe(2);
    const rows = await t.pool.query(
      "select organization_id, count(*)::int n from contacts group by organization_id",
    );
    expect(Object.fromEntries(rows.rows.map((r) => [r.organization_id, r.n]))).toEqual({
      [a.org.id]: 1,
      [b.org.id]: 1,
    });
  });

  // ----------------------------------------------------------------------------------------------------- locking
  describe("transaction-scoped advisory locks", () => {
    it("takes deterministic, organization-scoped, de-duplicated lock keys in sorted order", () => {
      const keys = identityLockKeys("org-1", {
        bsuid: "LK.B",
        waId: "999",
        profileName: null,
        username: null,
      });
      expect(keys).toEqual([...keys].sort());
      expect(keys).toEqual(["wa-identity:org-1:bsuid:LK.B", "wa-identity:org-1:wa:999"]);
      expect(
        identityLockKeys("org-2", {
          bsuid: "LK.B",
          waId: "999",
          profileName: null,
          username: null,
        }),
      ).not.toEqual(keys);
      expect(
        identityLockKeys("org-1", { bsuid: "LK.B", waId: null, profileName: null, username: null }),
      ).toHaveLength(1);
      expect(
        identityLockKeys("org-1", { bsuid: null, waId: "999", profileName: null, username: null }),
      ).toHaveLength(1);
    });

    it("holds one advisory lock per identifier until the surrounding transaction ends, and none afterwards", async () => {
      await tenant(t.db);
      const held = async (e: StoredEvent) => {
        let inside = -1;
        await t.db.transaction(async (tx) => {
          await resolveInboundContact(tx, e, { observedAt: minutesAgo(1) });
          const r = await tx.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`,
          );
          inside = r.rows[0]!.n;
        });
        return inside;
      };
      expect(await held(await sendTo({ bsuid: "LK.LOCK1", from: "15550800001" }))).toBe(2);
      expect(await held(await sendTo({ bsuid: "LK.LOCK2" }))).toBe(1);
      expect(await held(await sendTo({ from: "15550800003" }))).toBe(1);
      const after = await t.pool.query(
        "select count(*)::int n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())",
      );
      expect(after.rows[0].n).toBe(0);
    });

    it("a second transaction for the same identity waits for the first to finish (it does not read stale 'unseen' state)", async () => {
      await tenant(t.db);
      const first = await sendTo({ bsuid: "LK.WAIT", from: "15550800010", name: "First" });
      const second = await sendTo({ bsuid: "LK.WAIT", from: "15550800010", name: "Second" });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let started!: () => void;
      const startedP = new Promise<void>((r) => (started = r));
      const holder = t.db.transaction(async (tx) => {
        const r = await resolveInboundContact(tx, first, { observedAt: minutesAgo(5) });
        started();
        await gate;
        return r;
      });
      await startedP;
      let settled = false;
      const waiter = resolve(second, minutesAgo(1)).then((r) => ((settled = true), r));
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // blocked on the advisory lock, not racing ahead
      release();
      const [a, b] = await Promise.all([holder, waiter]);
      expect(b.contactId).toBe(a.contactId);
      expect(b.created).toBe(false);
      expect(await count("contacts")).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------------ worker transaction
  describe("inside the worker's transaction", () => {
    const run = (
      handler: (tx: Parameters<typeof resolveInboundContact>[0], e: StoredEvent) => Promise<void>,
    ) =>
      processWebhookBatch(t.db, {
        handlers: {
          MESSAGE: async (tx, event) => {
            await handler(tx, event as unknown as StoredEvent);
          },
        },
      });

    it("contact and alias commit together with the PROCESSED mark", async () => {
      await tenant(t.db);
      const event = await sendTo({ bsuid: "LK.WK1", from: "15550900001", name: "Worker" });
      const summary = await run(
        async (tx, e) => void (await resolveInboundContact(tx, e, { observedAt: minutesAgo(1) })),
      );
      expect(summary).toMatchObject({ claimed: 1, processed: 1 });
      expect(await count("contacts")).toBe(1);
      expect(await count("contact_bsuids")).toBe(1);
      expect((await getEvent(t.pool, event.id)).status).toBe("PROCESSED");
      expect(
        (await t.pool.query("select source_webhook_event_id from contact_bsuids")).rows[0]
          .source_webhook_event_id,
      ).toBe(event.id);
    });

    it("a failure after the resolver rolls the contact and alias back with the event", async () => {
      await tenant(t.db);
      const event = await sendTo({ bsuid: "LK.WK2", from: "15550900002" });
      const summary = await run(async (tx, e) => {
        await resolveInboundContact(tx, e, { observedAt: minutesAgo(1) });
        throw new Error("later step failed");
      });
      expect(summary).toMatchObject({ claimed: 1, failed: 1, processed: 0 });
      expect(await count("contacts")).toBe(0);
      expect(await count("contact_bsuids")).toBe(0);
      expect((await getEvent(t.pool, event.id)).status).toBe("FAILED");
    });

    it("a failure at COMMIT (a deferred constraint) also discards the contact", async () => {
      await tenant(t.db);
      const event = await sendTo({ bsuid: "LK.WK3", from: "15550900003" });
      const summary = await run(async (tx, e) => {
        await resolveInboundContact(tx, e, { observedAt: minutesAgo(1) });
        await tx.execute(sql`insert into queue_fixture_children (parent_id) values (999)`);
      });
      expect(summary).toMatchObject({ failed: 1, processed: 0 });
      expect(await count("contacts")).toBe(0);
      expect((await getEvent(t.pool, event.id)).status).toBe("FAILED");
    });

    it("a PermanentWebhookError from the resolver (no sender identity) makes the event DEAD with its fixed code and writes nothing", async () => {
      await tenant(t.db);
      const event = await sendTo({ bsuid: "LK.WK4", from: "15550900004" });
      await t.pool.query(
        "update webhook_events set payload = jsonb_set(payload, '{message}', '{\"id\":\"wamid.X\"}') where id = $1",
        [event.id],
      );
      const summary = await run(
        async (tx, e) => void (await resolveInboundContact(tx, e, { observedAt: minutesAgo(1) })),
      );
      expect(summary).toMatchObject({ claimed: 1, dead: 1 });
      expect(await getEvent(t.pool, event.id)).toMatchObject({
        status: "DEAD",
        last_error: "missing_sender_identity",
      });
      expect(await count("contacts")).toBe(0);
    });

    it("two workers resolving the same new BSUID at once end with one contact", async () => {
      await tenant(t.db);
      for (let i = 0; i < 4; i++) await sendTo({ bsuid: "LK.WK5", from: "15550900005" });
      const handler = async (tx: Parameters<typeof resolveInboundContact>[0], e: StoredEvent) => {
        await resolveInboundContact(tx, e, { observedAt: minutesAgo(1) });
      };
      const summaries = await Promise.all([run(handler), run(handler), run(handler)]);
      expect(summaries.reduce((n, s) => n + s.processed, 0)).toBe(4);
      expect(await count("contacts")).toBe(1);
      expect(await count("contact_bsuids")).toBe(1);
    });
  });
});
