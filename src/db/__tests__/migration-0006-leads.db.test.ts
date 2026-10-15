import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_VIOLATION,
  UNIQUE_VIOLATION,
  createTestDatabase,
  pgError,
  type TestDb,
} from "./helpers";

// Migration 0006 (leads lifecycle, history, reconcile decisions, attribution evidence) applied as an UPGRADE to a database
// that already holds leads and attribution touches, on disposable databases only. The fresh-database path is covered by every
// other database test (they all migrate from empty), and the guarantees themselves by leads-schema.db.test.ts.

const FULL = fileURLToPath(new URL("../migrations", import.meta.url));
const TAG = "0006_leads_lifecycle_and_attribution_integrity";
const journal = JSON.parse(readFileSync(join(FULL, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ tag: string }>;
};
const BEFORE = journal.entries.findIndex((e) => e.tag === TAG);
const OPEN = ["NEW", "QUALIFIED", "INTERESTED", "REGISTRATION_STARTED", "REGISTERED", "PAID"];
const CLOSED = ["CONVERTED", "NOT_INTERESTED", "NO_RESPONSE", "INVALID"];

/** A copy of the migrations folder that stops before 0006 (what a database has today). */
function folderBefore0006(): string {
  const dir = mkdtempSync(join(tmpdir(), "al-ict-migrations-pre0006-"));
  mkdirSync(join(dir, "meta"));
  const kept = journal.entries.slice(0, BEFORE);
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify(
      { ...JSON.parse(readFileSync(join(FULL, "meta/_journal.json"), "utf8")), entries: kept },
      null,
      2,
    ),
  );
  for (const e of kept) copyFileSync(join(FULL, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

describe("migration 0006: applying it to a database that already has leads and attribution touches", () => {
  let before: string;
  beforeAll(() => {
    expect(BEFORE).toBe(6);
    before = folderBefore0006();
  });
  afterAll(() => rmSync(before, { recursive: true, force: true }));

  async function preDatabase() {
    const t = await createTestDatabase({ migrate: false });
    await migrate(t.db, { migrationsFolder: before });
    expect(await column(t, "leads", "revision")).toBe(false); // really the schema of today
    return t;
  }
  const q = (t: TestDb, sql: string, params: unknown[] = []) => t.pool.query(sql, params);
  const column = async (t: TestDb, table: string, name: string) =>
    (
      await q(
        t,
        "select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2",
        [table, name],
      )
    ).rowCount === 1;
  const table = async (t: TestDb, name: string) =>
    (await q(t, "select to_regclass($1) as r", [`public.${name}`])).rows[0].r !== null;
  const recorded = async (t: TestDb) =>
    (await q(t, "select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n as number;
  const days = (n: number) => new Date(Date.now() - n * 24 * 3600_000);

  // Raw SQL on purpose: this database has the schema of its time (before 0006); the Drizzle helpers name the current columns.
  async function seed(t: TestDb) {
    const org = (
      await q(t, "insert into organizations (name, slug) values ('Org', 'org-0006') returning id")
    ).rows[0].id as string;
    const account = (
      await q(
        t,
        "insert into whatsapp_accounts (organization_id, waba_id, phone_number_id, display_phone_number, status) values ($1,'200000000000601','100000000000601','+94 77 000 0601','ACTIVE') returning id",
        [org],
      )
    ).rows[0].id as string;
    let n = 0;
    const contact = async () => {
      const id = (
        await q(
          t,
          "insert into contacts (organization_id, wa_id, first_seen_at, last_seen_at) values ($1, $2, now(), now()) returning id",
          [org, `9477060${n++}`],
        )
      ).rows[0].id as string;
      const conversation = (
        await q(
          t,
          "insert into conversations (organization_id, whatsapp_account_id, contact_id, last_message_at) values ($1,$2,$3, now()) returning id",
          [org, account, id],
        )
      ).rows[0].id as string;
      return { id, conversation };
    };
    const message = async (c: { conversation: string }, occurredAt: Date) =>
      (
        await q(
          t,
          "insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at, wamid) values ($1,$2,$3,'INBOUND','TEXT','m', $4, $5) returning id",
          [org, c.conversation, account, occurredAt, `wamid.U6${n++}`],
        )
      ).rows[0].id as string;
    const lead = async (
      c: { id: string },
      status: string,
      createdAt: Date,
      statusChangedAt: Date = createdAt,
    ) =>
      (
        await q(
          t,
          "insert into leads (organization_id, contact_id, status, status_changed_at, created_at, updated_at) values ($1,$2,$3,$4,$5,$4) returning id",
          [org, c.id, status, statusChangedAt, createdAt],
        )
      ).rows[0].id as string;
    // before 0006 a touch could be inserted already linked: these are the "existing linked touches"
    const touch = async (
      c: { id: string },
      o: { lead?: string; message?: string; source?: string; receivedAt?: Date },
    ) =>
      (
        await q(
          t,
          `insert into lead_attributions (organization_id, contact_id, lead_id, message_id, source_type, source_id, source_url, headline, body, ctwa_clid, provider_data, received_at)
           values ($1,$2,$3,$4,$5,'ad-9','https://example.test/ad','Headline','Body','clid-9','{"k":"v"}', $6) returning id`,
          [
            org,
            c.id,
            o.lead ?? null,
            o.message ?? null,
            o.source ?? "META_AD",
            o.receivedAt ?? days(2),
          ],
        )
      ).rows[0].id as string;
    return { org, account, contact, message, lead, touch };
  }

  it("keeps every existing lead and touch unchanged, backfills only the new columns, invents no history, and is idempotent", async () => {
    const t = await preDatabase();
    try {
      const s = await seed(t);
      // one contact per status (so no contact has two open leads), each with distinct timestamps
      const leads: Record<string, string> = {};
      for (const [i, status] of [...OPEN, ...CLOSED].entries())
        leads[status] = await s.lead(await s.contact(), status, days(20 + i), days(10 + i));
      // a contact with history: two closed leads and one open lead
      const veteran = await s.contact();
      const oldClosed = await s.lead(veteran, "NOT_INTERESTED", days(90), days(80));
      await s.lead(veteran, "NO_RESPONSE", days(70), days(60));
      const veteranOpen = await s.lead(veteran, "QUALIFIED", days(30), days(25));
      // unusual timestamps: the status "changed" before the row was created
      const odd = await s.lead(await s.contact(), "INVALID", days(5), days(6));
      const oddOpen = await s.lead(await s.contact(), "NEW", days(5), days(6));

      // touches: unlinked (with and without a message), and linked ones of several kinds
      const unlinked = await s.touch(veteran, { message: await s.message(veteran, days(1)) });
      await s.touch(veteran, {}); // no message, no lead
      const linkedOpen = await s.touch(veteran, {
        lead: veteranOpen,
        message: await s.message(veteran, days(26)),
        receivedAt: days(26),
      });
      const linkedClosed = await s.touch(veteran, {
        lead: oldClosed,
        message: await s.message(veteran, days(85)),
        receivedAt: days(85),
      });
      const linkedReferral = await s.touch(veteran, { lead: veteranOpen, source: "REFERRAL" }); // not an ad, no message
      // an old unlinked ad touch from before the open lead existed
      const ancient = await s.touch(veteran, {
        message: await s.message(veteran, days(40)),
        receivedAt: days(40),
      });
      const snapshot = async () => ({
        leads: (
          await q(
            t,
            "select id, organization_id, contact_id, status, status_changed_at, created_at, updated_at from leads order by id",
          )
        ).rows,
        touches: (await q(t, "select * from lead_attributions order by id")).rows,
        contacts: (await q(t, "select * from contacts order by id")).rows,
        messages: (await q(t, "select * from messages order by id")).rows,
      });
      const old = await snapshot();
      expect(old.leads).toHaveLength(15);
      expect(old.touches).toHaveLength(6);
      expect(await recorded(t)).toBe(BEFORE);

      await migrate(t.db, { migrationsFolder: FULL });

      expect(await snapshot()).toEqual(old); // not one existing value changed; nothing was deleted, linked or unlinked
      expect(await recorded(t)).toBe(journal.entries.length);

      // the three new columns, for every existing lead
      const rows = (
        await q(
          t,
          "select id, status, revision, closed_at, cycle_started_at, created_at, status_changed_at, initiating_attribution_id from leads",
        )
      ).rows as Array<{
        initiating_attribution_id: string | null;
        id: string;
        status: string;
        revision: number;
        closed_at: Date | null;
        cycle_started_at: Date;
        created_at: Date;
        status_changed_at: Date;
      }>;
      for (const r of rows) {
        expect(r.revision, r.status).toBe(0);
        expect(r.initiating_attribution_id, r.status).toBeNull(); // no origin is invented, not even for a lead with touches
        if (OPEN.includes(r.status)) expect(r.closed_at, r.status).toBeNull();
        else expect(r.closed_at, r.status).toEqual(r.status_changed_at);
        expect(r.cycle_started_at.getTime(), r.status).toBe(
          Math.min(r.created_at.getTime(), r.status_changed_at.getTime()),
        );
      }
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(leads.NEW!)!.cycle_started_at).toEqual(byId.get(leads.NEW!)!.created_at);
      // the rows with unusual timestamps still satisfy closed_at >= cycle_started_at
      expect(byId.get(odd)!.closed_at).toEqual(byId.get(odd)!.cycle_started_at);
      expect(byId.get(oddOpen)!.cycle_started_at).toEqual(byId.get(oddOpen)!.status_changed_at);

      // no history and no decision was invented for anything that already existed
      for (const name of ["lead_events", "lead_reconcile_decisions"])
        expect((await q(t, `select count(*)::int n from ${name}`)).rows[0].n, name).toBe(0);
      expect(
        (
          await q(
            t,
            "select count(*)::int n from information_schema.tables where table_schema = 'public'",
          )
        ).rows[0].n,
      ).toBe(31);

      // existing linked touches stay linked exactly as they were, and are now protected like every other touch
      const leadOf = async (id: string) =>
        (await q(t, "select lead_id from lead_attributions where id = $1", [id])).rows[0].lead_id;
      expect(await leadOf(linkedOpen)).toBe(veteranOpen);
      expect(await leadOf(linkedClosed)).toBe(oldClosed);
      expect(await leadOf(linkedReferral)).toBe(veteranOpen);
      for (const id of [linkedOpen, linkedClosed, linkedReferral]) {
        for (const statement of [
          "update lead_attributions set lead_id = null where id = $1",
          "update lead_attributions set headline = 'x' where id = $1",
          "delete from lead_attributions where id = $1",
        ]) {
          let code: string | undefined;
          await q(t, statement, [id]).catch((e: unknown) => (code = pgError(e).code));
          expect(code, statement).toBe(CHECK_VIOLATION);
        }
        // a statement that changes nothing is not a new link: it needs no history and does not fail at commit
        await q(t, "update lead_attributions set lead_id = lead_id where id = $1", [id]);
      }

      // the upgraded database works: the unlinked touch can be linked to the existing open lead, with its history
      const c = await t.pool.connect();
      try {
        await c.query("begin");
        await c.query("update lead_attributions set lead_id = $1 where id = $2", [
          veteranOpen,
          unlinked,
        ]);
        await c.query(
          "insert into lead_events (organization_id, lead_id, contact_id, kind, attribution_id) values ($1, $2, $3, 'TOUCH_LINKED', $4)",
          [s.org, veteranOpen, veteran.id, unlinked],
        );
        await c.query("commit");
      } finally {
        c.release();
      }
      expect(await leadOf(unlinked)).toBe(veteranOpen);
      // a lead from before the migration has no CREATED event, and cannot be given one that claims an old touch as its
      // origin: neither the fabricated event nor the link of the touch it predates is accepted (review H1)
      const attempts: Array<[string, unknown[]]> = [
        [
          "insert into lead_events (organization_id, lead_id, contact_id, kind, origin, attribution_id, revision) values ($1, $2, $3, 'CREATED', 'AD_REFERRAL', $4, 0)",
          [s.org, veteranOpen, veteran.id, ancient],
        ],
        ["update lead_attributions set lead_id = $1 where id = $2", [veteranOpen, ancient]],
        ["update leads set initiating_attribution_id = $2 where id = $1", [veteranOpen, ancient]],
      ];
      for (const [statement, params] of attempts) {
        let code: string | undefined;
        await q(t, statement, params).catch((e: unknown) => (code = pgError(e).code));
        expect(code, statement).toBe(CHECK_VIOLATION);
      }
      expect(await leadOf(ancient)).toBeNull();
      expect(
        (await q(t, "select count(*)::int n from lead_events where kind = 'CREATED'")).rows[0].n,
      ).toBe(0);
      // and the one-open-lead rule holds for a contact that already had an open lead
      let violation: ReturnType<typeof pgError> | undefined;
      await q(t, "insert into leads (organization_id, contact_id) values ($1, $2)", [
        s.org,
        veteran.id,
      ]).catch((e: unknown) => (violation = pgError(e)));
      expect(violation).toMatchObject({
        code: UNIQUE_VIOLATION,
        constraint: "leads_org_contact_open_uidx",
      });

      await migrate(t.db, { migrationsFolder: FULL }); // idempotent
      expect(await recorded(t)).toBe(journal.entries.length);
    } finally {
      await t.close();
    }
  });

  it("an empty database of today upgrades cleanly", async () => {
    const t = await preDatabase();
    try {
      await migrate(t.db, { migrationsFolder: FULL });
      expect(await column(t, "leads", "cycle_started_at")).toBe(true);
      expect(await table(t, "lead_events")).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("a contact with two open leads makes the migration refuse atomically: nothing is changed, closed or recorded; after a manual fix it applies", async () => {
    const t = await preDatabase();
    try {
      const s = await seed(t);
      const fine = await s.contact();
      await s.lead(fine, "INTERESTED", days(9));
      await s.lead(fine, "NOT_INTERESTED", days(30), days(20));
      const doubled = await s.contact();
      const first = await s.lead(doubled, "NEW", days(8));
      const second = await s.lead(doubled, "REGISTERED", days(4));
      await s.touch(doubled, { lead: first, message: await s.message(doubled, days(8)) });
      const snapshot = async () => ({
        leads: (await q(t, "select * from leads order by id")).rows,
        touches: (await q(t, "select * from lead_attributions order by id")).rows,
      });
      const old = await snapshot();

      // the documented read-only preflight finds exactly that contact
      const preflight = await q(
        t,
        `select organization_id, contact_id, count(*)::int as open_leads from leads
          where status in ('NEW','QUALIFIED','INTERESTED','REGISTRATION_STARTED','REGISTERED','PAID')
          group by organization_id, contact_id having count(*) > 1`,
      );
      expect(preflight.rows).toEqual([
        { organization_id: s.org, contact_id: doubled.id, open_leads: 2 },
      ]);

      let caught: unknown;
      await migrate(t.db, { migrationsFolder: FULL }).catch((e) => (caught = e));
      expect(caught, "the migration must refuse").toBeDefined();
      expect(pgError(caught).code).toBe(UNIQUE_VIOLATION);
      expect(pgError(caught).message).toMatch(
        /migration 0006 refused: 1 contact\(s\) have more than one open lead; no rows were changed/,
      );

      // atomic: no column, table, index, constraint or trigger of 0006 exists, and no row changed
      expect(await snapshot()).toEqual(old);
      for (const name of ["revision", "closed_at", "cycle_started_at"])
        expect(await column(t, "leads", name), name).toBe(false);
      for (const name of ["lead_events", "lead_reconcile_decisions"])
        expect(await table(t, name), name).toBe(false);
      expect(
        (
          await q(
            t,
            "select count(*)::int n from pg_indexes where schemaname = 'public' and indexname in ('leads_org_contact_open_uidx','lead_attributions_unlinked_ad_idx','lead_attributions_org_id_contact_unique')",
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await q(
            t,
            "select count(*)::int n from pg_trigger where not tgisinternal and tgname like 'lead%'",
          )
        ).rows[0].n,
      ).toBe(0);
      expect(await recorded(t)).toBe(BEFORE); // 0006 is not recorded as applied

      // the operator decides BY HAND which lead stays open (here: the newer one) and closes the other, then retries
      await q(t, "update leads set status = 'INVALID', status_changed_at = now() where id = $1", [
        first,
      ]);
      await migrate(t.db, { migrationsFolder: FULL });
      expect(await recorded(t)).toBe(journal.entries.length);
      const after = (
        await q(
          t,
          "select id, status, closed_at, revision from leads where id = any($1) order by created_at",
          [[first, second]],
        )
      ).rows;
      expect(after[0]).toMatchObject({ id: first, status: "INVALID", revision: 0 });
      expect(after[0].closed_at).not.toBeNull();
      expect(after[1]).toMatchObject({
        id: second,
        status: "REGISTERED",
        closed_at: null,
        revision: 0,
      });
    } finally {
      await t.close();
    }
  });
});

describe("the migrations that are already applied elsewhere are not rewritten", () => {
  // SHA-256 of each committed migration file as it was when 0006 was written. A migration that has run on any database must
  // never change; a new one is always a new file.
  const PINNED: Record<string, string> = {
    "0000_init_foundation_schema":
      "f32afe09d834c149dd7d1405ae1d5d4b4392b73b2025d5fc0d3b19e6030ccb8b",
    "0001_auth_and_access_foundation":
      "884f5297d34e213b78fcc0514868fc87e34bb03b4b6edb005833cb234202e98c",
    "0002_whatsapp_webhook_ingest_and_bsuid_identity":
      "9b152887fa4ebdbf49743c761a1494b3274550ce2bcf14da81f0770f373f2ab0",
    "0003_lead_attribution_message_unique":
      "c6dba16be8f5a08806a61ec568e3b63c82bbcf2d8c1b5aace76c9e32e550e17d",
    "0004_outbound_requests_and_templates":
      "fcb82c48950859ede62d5fbdcc10ed7559608291af41109aab50ea32e4e542c4",
    "0005_staff_inbox_workflow": "d875b3221911fc9222f5a582b9cda117bd67eafec683efb6206da83cf204fab3",
  };

  it("migrations 0000 to 0005 are byte-for-byte what was committed, and 0006 follows them", () => {
    expect(journal.entries.slice(0, 7).map((e) => e.tag)).toEqual([...Object.keys(PINNED), TAG]);
    for (const [tag, sha] of Object.entries(PINNED))
      expect(
        createHash("sha256")
          .update(readFileSync(join(FULL, `${tag}.sql`)))
          .digest("hex"),
        tag,
      ).toBe(sha);
  });
});
