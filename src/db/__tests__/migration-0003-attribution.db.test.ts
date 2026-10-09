import { migrate } from "drizzle-orm/node-postgres/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FK_VIOLATION,
  UNIQUE_VIOLATION,
  createTestDatabase,
  expectPgError,
  pgError,
  seedContact,
  seedMessage,
  seedOrg,
  seedWorld,
  type TestDb,
} from "./helpers";

// Migration 0003: one attribution per referring inbound message, as a partial unique index
// (organization_id, message_id) WHERE message_id IS NOT NULL. Disposable databases only.

const FULL = fileURLToPath(new URL("../migrations", import.meta.url));
const TAG_0003 = "0003_lead_attribution_message_unique";
const INDEX = "lead_attributions_org_message_uidx";
const journal = JSON.parse(readFileSync(join(FULL, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ tag: string }>;
};

/** A copy of the migrations folder that stops before 0003 (what every database had until now). */
function folderBefore0003(): string {
  const dir = mkdtempSync(join(tmpdir(), "al-ict-migrations-pre0003-"));
  mkdirSync(join(dir, "meta"));
  const at = journal.entries.findIndex((e) => e.tag === TAG_0003);
  expect(at).toBeGreaterThan(0);
  const kept = journal.entries.slice(0, at);
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

const attribute = (
  t: TestDb,
  o: { org: string; contact: string; message: string | null; source?: string },
) =>
  t.pool.query(
    "insert into lead_attributions (organization_id, contact_id, message_id, source_type, received_at) values ($1, $2, $3, $4, now()) returning id",
    [o.org, o.contact, o.message, o.source ?? "META_AD"],
  );
const countRows = async (t: TestDb) =>
  (await t.pool.query("select count(*)::int n from lead_attributions")).rows[0].n as number;
const indexDef = async (t: TestDb) =>
  (
    await t.pool.query(
      "select indexdef from pg_indexes where schemaname = 'public' and indexname = $1",
      [INDEX],
    )
  ).rows[0]?.indexdef as string | undefined;
const recorded = async (t: TestDb) =>
  (await t.pool.query("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0]
    .n as number;

describe("migration 0003: the guarantee, on a fully migrated database", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());

  async function world() {
    const w = await seedWorld(t.db);
    const mk = (wamid: string) =>
      seedMessage(t.db, {
        organizationId: w.org.id,
        conversationId: w.conversation.id,
        whatsappAccountId: w.account.id,
        wamid,
        direction: "INBOUND",
      });
    return { ...w, mk };
  }

  it("the index is partial and unique over (organization_id, message_id)", async () => {
    const def = await indexDef(t);
    expect(def).toMatch(/CREATE UNIQUE INDEX lead_attributions_org_message_uidx/);
    expect(def).toMatch(/\(organization_id, message_id\)/);
    expect(def).toMatch(/WHERE \(message_id IS NOT NULL\)/);
  });

  it("A/B/C: the first attribution succeeds and a second for the same message is rejected by PostgreSQL itself (raw SQL, no application guard)", async () => {
    const w = await world();
    const m = await w.mk("wamid.A1");
    await attribute(t, { org: w.org.id, contact: w.contact.id, message: m.id });
    await expectPgError(
      attribute(t, { org: w.org.id, contact: w.contact.id, message: m.id, source: "REFERRAL" }),
      UNIQUE_VIOLATION,
      INDEX,
    );
    expect(
      (
        await t.pool.query("select count(*)::int n from lead_attributions where message_id = $1", [
          m.id,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it("D: different messages each get their own attribution", async () => {
    const w = await world();
    const [m1, m2] = [await w.mk("wamid.D1"), await w.mk("wamid.D2")];
    await attribute(t, { org: w.org.id, contact: w.contact.id, message: m1.id });
    await attribute(t, { org: w.org.id, contact: w.contact.id, message: m2.id });
    expect(
      (
        await t.pool.query(
          "select count(*)::int n from lead_attributions where message_id = any($1)",
          [[m1.id, m2.id]],
        )
      ).rows[0].n,
    ).toBe(2);
  });

  it("E: rows without a message are not constrained by the index", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++)
      await attribute(t, { org: w.org.id, contact: w.contact.id, message: null });
    expect(
      (
        await t.pool.query(
          "select count(*)::int n from lead_attributions where message_id is null and contact_id = $1",
          [w.contact.id],
        )
      ).rows[0].n,
    ).toBe(3);
  });

  it("F: the tenant and message foreign keys are intact", async () => {
    const a = await world();
    const b = await seedOrg(t.db);
    const bContact = await seedContact(t.db, b.id);
    const m = await a.mk("wamid.F1");
    // another organization cannot attribute this organization's message, nor name this organization's contact
    await expectPgError(
      attribute(t, { org: b.id, contact: bContact.id, message: m.id }),
      FK_VIOLATION,
      "lead_attributions_org_message_fk",
    );
    await expectPgError(
      attribute(t, { org: b.id, contact: a.contact.id, message: null }),
      FK_VIOLATION,
      "lead_attributions_org_contact_fk",
    );
    // a message that does not exist
    await expectPgError(
      attribute(t, {
        org: a.org.id,
        contact: a.contact.id,
        message: "00000000-0000-4000-8000-000000000001",
      }),
      FK_VIOLATION,
      "lead_attributions_org_message_fk",
    );
  });

  it("the same message id under two organizations is impossible, and two organizations may each attribute their own message", async () => {
    const a = await world();
    const b = await seedWorld(t.db);
    const bMessage = await seedMessage(t.db, {
      organizationId: b.org.id,
      conversationId: b.conversation.id,
      whatsappAccountId: b.account.id,
      wamid: "wamid.ISO",
      direction: "INBOUND",
    });
    const aMessage = await a.mk("wamid.ISO");
    await attribute(t, { org: a.org.id, contact: a.contact.id, message: aMessage.id });
    await attribute(t, { org: b.org.id, contact: b.contact.id, message: bMessage.id });
    expect(
      (
        await t.pool.query(
          "select count(*)::int n from lead_attributions where message_id = any($1)",
          [[aMessage.id, bMessage.id]],
        )
      ).rows[0].n,
    ).toBe(2);
  });
});

describe("migration 0003: applying it to a database that already has data", () => {
  let before: string;
  beforeAll(() => {
    before = folderBefore0003();
  });
  afterAll(() => rmSync(before, { recursive: true, force: true }));

  async function preDatabase() {
    const t = await createTestDatabase({ migrate: false });
    await migrate(t.db, { migrationsFolder: before });
    expect(await indexDef(t)).toBeUndefined(); // the pre-0003 schema has no such index
    return t;
  }
  async function seedPair(t: TestDb) {
    const w = await seedWorld(t.db);
    const mk = (wamid: string) =>
      seedMessage(t.db, {
        organizationId: w.org.id,
        conversationId: w.conversation.id,
        whatsappAccountId: w.account.id,
        wamid,
        direction: "INBOUND",
      });
    return { ...w, mk };
  }

  it("G: applies to a disposable migrated database that holds clean attribution data, and keeps that data", async () => {
    const t = await preDatabase();
    try {
      const w = await seedPair(t);
      const [m1, m2] = [await w.mk("wamid.G1"), await w.mk("wamid.G2")];
      await attribute(t, { org: w.org.id, contact: w.contact.id, message: m1.id });
      await attribute(t, { org: w.org.id, contact: w.contact.id, message: m2.id });
      await attribute(t, { org: w.org.id, contact: w.contact.id, message: null });
      await attribute(t, { org: w.org.id, contact: w.contact.id, message: null });
      expect(await recorded(t)).toBe(journal.entries.length - 1);
      await migrate(t.db, { migrationsFolder: FULL });
      expect(await recorded(t)).toBe(journal.entries.length);
      expect(await indexDef(t)).toMatch(/UNIQUE/);
      expect(await countRows(t)).toBe(4);
      await expectPgError(
        attribute(t, { org: w.org.id, contact: w.contact.id, message: m1.id }),
        UNIQUE_VIOLATION,
        INDEX,
      );
      // idempotent: running the migrator again changes nothing
      await migrate(t.db, { migrationsFolder: FULL });
      expect(await recorded(t)).toBe(journal.entries.length);
    } finally {
      await t.close();
    }
  });

  it("an empty table is fine", async () => {
    const t = await preDatabase();
    try {
      await migrate(t.db, { migrationsFolder: FULL });
      expect(await indexDef(t)).toMatch(/UNIQUE/);
    } finally {
      await t.close();
    }
  });

  it("I: pre-existing duplicates make the migration fail safely: nothing is deleted or merged, nothing is recorded, no index appears; after a manual fix it applies", async () => {
    const t = await preDatabase();
    try {
      const w = await seedPair(t);
      const [dup, ok] = [await w.mk("wamid.I1"), await w.mk("wamid.I2")];
      const ids: string[] = [];
      for (const message of [dup.id, dup.id, dup.id, ok.id])
        ids.push(
          (await attribute(t, { org: w.org.id, contact: w.contact.id, message })).rows[0].id,
        );
      await attribute(t, { org: w.org.id, contact: w.contact.id, message: null });
      const snapshot = async () =>
        (await t.pool.query("select * from lead_attributions order by id")).rows;
      const before = await snapshot();
      expect(before).toHaveLength(5);

      // the documented read-only preflight finds exactly the duplicate pair
      const preflight = await t.pool.query(
        "select organization_id, message_id, count(*)::int n from lead_attributions where message_id is not null group by organization_id, message_id having count(*) > 1",
      );
      expect(preflight.rows).toEqual([{ organization_id: w.org.id, message_id: dup.id, n: 3 }]);

      let caught: unknown;
      await migrate(t.db, { migrationsFolder: FULL }).catch((e) => (caught = e));
      expect(caught, "the migration must refuse").toBeDefined();
      expect(pgError(caught).code).toBe(UNIQUE_VIOLATION);
      expect(pgError(caught).message).toMatch(
        /migration 0003 refused: 1 \(organization_id, message_id\) pair/,
      );

      expect(await snapshot()).toEqual(before); // every historical row is still there, unchanged
      expect(await indexDef(t)).toBeUndefined();
      expect(await recorded(t)).toBe(journal.entries.length - 1); // 0003 is not recorded as applied

      // the operator resolves the duplicates BY HAND (here: keep the earliest touch), then retries
      await t.pool.query("delete from lead_attributions where id = any($1)", [[ids[1], ids[2]]]);
      await migrate(t.db, { migrationsFolder: FULL });
      expect(await indexDef(t)).toMatch(/UNIQUE/);
      expect(await countRows(t)).toBe(3);
    } finally {
      await t.close();
    }
  });
});
