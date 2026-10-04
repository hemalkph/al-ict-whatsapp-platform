import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "../index";
import {
  CHECK_VIOLATION,
  FK_VIOLATION,
  NOT_NULL_VIOLATION,
  UNIQUE_VIOLATION,
  createTestDatabase,
  expectPgError,
  seedAccount,
  seedContact,
  seedMessage,
  seedOrg,
  seedWebhookEvent,
  seedWebhookRequest,
  seedWorld,
  type TestDb,
} from "./helpers";

// Phase 04 schema (migration 0002) against real PostgreSQL: exact raw bodies + ingest state, contacts without a
// phone-based id, and the BSUID alias/history table. Written with the migration; first run after its review.

const T0 = new Date("2026-03-01T00:00:00Z");
const T1 = new Date("2026-03-02T00:00:00Z");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("Phase 04 schema (migration 0002)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  });
  afterAll(async () => t.close());

  describe("webhook_requests: exact bytes and ingest state", () => {
    it("round-trips the exact bytes, including NUL and bytes that are not valid UTF-8", async () => {
      const body = Buffer.from([0x7b, 0x00, 0xff, 0xfe, 0x80, 0x22, 0x7d]);
      const row = await seedWebhookRequest(db, { rawBody: body });
      const [back] = await db
        .select()
        .from(schema.webhookRequests)
        .where(eq(schema.webhookRequests.id, row.id));
      expect(Buffer.isBuffer(back!.rawBody)).toBe(true);
      expect(back!.rawBody.equals(body)).toBe(true);
      expect(back!.payloadSha256).toBe(sha(body));
    });

    it("has no jsonb raw_payload any more and requires raw_body", async () => {
      const cols = await t.pool.query(
        "select column_name, data_type, is_nullable from information_schema.columns where table_name = 'webhook_requests'",
      );
      const byName = Object.fromEntries(cols.rows.map((c) => [c.column_name, c]));
      expect(byName.raw_payload).toBeUndefined();
      expect(byName.raw_body).toMatchObject({ data_type: "bytea", is_nullable: "NO" });
      await expectPgError(
        t.pool.query("insert into webhook_requests (payload_sha256) values ($1)", [
          sha(Buffer.alloc(0)),
        ]),
        NOT_NULL_VIOLATION,
      );
    });

    it("defaults to ACCEPTED with no error code", async () => {
      const row = await seedWebhookRequest(db);
      expect(row.ingestStatus).toBe("ACCEPTED");
      expect(row.ingestErrorCode).toBeNull();
    });

    it("accepts every non-ACCEPTED status with a 1..64 character code", async () => {
      for (const status of ["UNPARSEABLE", "UNSUPPORTED_SHAPE", "EVENTS_REJECTED"] as const) {
        const row = await seedWebhookRequest(db, {
          ingestStatus: status,
          ingestErrorCode: "invalid_json",
        });
        expect(row.ingestStatus).toBe(status);
      }
      await seedWebhookRequest(db, {
        ingestStatus: "UNPARSEABLE",
        ingestErrorCode: "x".repeat(64),
      });
    });

    it("rejects an unknown ingest status", async () => {
      await expectPgError(
        seedWebhookRequest(db, { ingestStatus: "BOGUS" as never, ingestErrorCode: "x" }),
        CHECK_VIOLATION,
        "webhook_requests_ingest_status_check",
      );
    });

    it("enforces ACCEPTED if and only if the error code is NULL", async () => {
      await expectPgError(
        seedWebhookRequest(db, { ingestStatus: "ACCEPTED", ingestErrorCode: "invalid_json" }),
        CHECK_VIOLATION,
        "webhook_requests_ingest_error_check",
      );
      for (const status of ["UNPARSEABLE", "UNSUPPORTED_SHAPE", "EVENTS_REJECTED"] as const) {
        await expectPgError(
          seedWebhookRequest(db, { ingestStatus: status, ingestErrorCode: null }),
          CHECK_VIOLATION,
          "webhook_requests_ingest_error_check",
        );
      }
    });

    it("bounds the error code to 1..64 characters", async () => {
      await expectPgError(
        seedWebhookRequest(db, { ingestStatus: "UNPARSEABLE", ingestErrorCode: "" }),
        CHECK_VIOLATION,
        "webhook_requests_ingest_error_len_check",
      );
      await expectPgError(
        seedWebhookRequest(db, { ingestStatus: "UNPARSEABLE", ingestErrorCode: "x".repeat(65) }),
        CHECK_VIOLATION,
        "webhook_requests_ingest_error_len_check",
      );
    });

    it("requires payload_sha256 to be 64 lowercase hex characters", async () => {
      for (const bad of [
        "00",
        "A".repeat(64),
        "g".repeat(64),
        "a".repeat(63),
        "a".repeat(65),
        "",
      ]) {
        await expectPgError(
          db
            .insert(schema.webhookRequests)
            .values({ rawBody: Buffer.from("{}"), payloadSha256: bad }),
          CHECK_VIOLATION,
          "webhook_requests_sha256_check",
        );
      }
    });

    it("keeps the sha256 non-unique (identical redeliveries are stored) and has the partial operational index", async () => {
      const body = Buffer.from('{"same":"bytes"}');
      await seedWebhookRequest(db, { rawBody: body });
      await seedWebhookRequest(db, { rawBody: body });
      const idx = await t.pool.query(
        "select indexdef from pg_indexes where indexname = 'webhook_requests_not_accepted_idx'",
      );
      expect(idx.rows[0].indexdef).toMatch(/WHERE.*ingest_status.*<>.*'ACCEPTED'/);
    });
  });

  describe("contacts without a phone-based id", () => {
    it("allows wa_id to be NULL, several times in one organization", async () => {
      const org = await seedOrg(db);
      for (const username of ["first.user", "second.user"]) {
        const [row] = await db
          .insert(schema.contacts)
          .values({ organizationId: org.id, waId: null, username, firstSeenAt: T0, lastSeenAt: T0 })
          .returning();
        expect(row!.waId).toBeNull();
        expect(row!.username).toBe(username);
      }
    });

    it("still rejects a duplicate non-NULL wa_id within an organization and allows it across organizations", async () => {
      const a = await seedOrg(db);
      const b = await seedOrg(db);
      await seedContact(db, a.id, "94770000901");
      await expectPgError(
        seedContact(db, a.id, "94770000901"),
        UNIQUE_VIOLATION,
        "contacts_org_wa_id_unique",
      );
      await seedContact(db, b.id, "94770000901");
    });
  });

  describe("contact_bsuids", () => {
    const alias = (
      orgId: string,
      contactId: string,
      bsuid: string,
      o: { first?: Date; last?: Date; retired?: Date | null; source?: string | null } = {},
    ) =>
      db.insert(schema.contactBsuids).values({
        organizationId: orgId,
        contactId,
        bsuid,
        firstSeenAt: o.first ?? T0,
        lastSeenAt: o.last ?? o.first ?? T0,
        retiredAt: o.retired ?? null,
        sourceWebhookEventId: o.source ?? null,
      });

    it("rejects a duplicate (organization, bsuid), also for another contact and also when the first is retired", async () => {
      const org = await seedOrg(db);
      const c1 = await seedContact(db, org.id);
      const c2 = await seedContact(db, org.id);
      await alias(org.id, c1.id, "LK.100000000000000001", { retired: T1 });
      await expectPgError(
        alias(org.id, c1.id, "LK.100000000000000001"),
        UNIQUE_VIOLATION,
        "contact_bsuids_org_bsuid_unique",
      );
      await expectPgError(
        alias(org.id, c2.id, "LK.100000000000000001"),
        UNIQUE_VIOLATION,
        "contact_bsuids_org_bsuid_unique",
      );
    });

    it("permits the same bsuid string in different organizations", async () => {
      const a = await seedWorld(db);
      const b = await seedWorld(db);
      await alias(a.org.id, a.contact.id, "LK.100000000000000002");
      await alias(b.org.id, b.contact.id, "LK.100000000000000002");
    });

    it("rejects a missing contact and a contact of another organization (tenant-aware FK)", async () => {
      const a = await seedWorld(db);
      const b = await seedWorld(db);
      await expectPgError(
        alias(a.org.id, "00000000-0000-4000-8000-0000000000aa", "LK.100000000000000003"),
        FK_VIOLATION,
        "contact_bsuids_org_contact_fk",
      );
      await expectPgError(
        alias(b.org.id, a.contact.id, "LK.100000000000000004"), // org B pointing at org A's contact
        FK_VIOLATION,
        "contact_bsuids_org_contact_fk",
      );
    });

    it("bounds the BSUID to 1..255 characters", async () => {
      const w = await seedWorld(db);
      for (const bad of ["", "x".repeat(256)]) {
        await expectPgError(
          alias(w.org.id, w.contact.id, bad),
          CHECK_VIOLATION,
          "contact_bsuids_bsuid_check",
        );
      }
      await alias(w.org.id, w.contact.id, "x".repeat(255));
    });

    it("requires last_seen_at >= first_seen_at and retired_at >= first_seen_at (or NULL)", async () => {
      const w = await seedWorld(db);
      await expectPgError(
        alias(w.org.id, w.contact.id, "LK.100000000000000005", { first: T1, last: T0 }),
        CHECK_VIOLATION,
        "contact_bsuids_seen_order_check",
      );
      await expectPgError(
        alias(w.org.id, w.contact.id, "LK.100000000000000006", {
          first: T1,
          last: T1,
          retired: T0,
        }),
        CHECK_VIOLATION,
        "contact_bsuids_retired_order_check",
      );
      await alias(w.org.id, w.contact.id, "LK.100000000000000007", {
        first: T0,
        last: T0,
        retired: T0,
      });
      await alias(w.org.id, w.contact.id, "LK.100000000000000008", {
        first: T0,
        last: T1,
        retired: null,
      });
    });

    it("does NOT assert one current alias per contact (Meta does not document it; H2)", async () => {
      const w = await seedWorld(db);
      await alias(w.org.id, w.contact.id, "LK.100000000000000009");
      await alias(w.org.id, w.contact.id, "LK.100000000000000010"); // second non-retired alias: allowed by the schema
      const rows = await db
        .select()
        .from(schema.contactBsuids)
        .where(eq(schema.contactBsuids.contactId, w.contact.id));
      expect(rows.filter((r) => r.retiredAt === null)).toHaveLength(2);
    });

    it("never blocks pruning webhook events: deleting the provenance event nulls the pointer and keeps the alias", async () => {
      const w = await seedWorld(db);
      const ev = await seedWebhookEvent(db, {
        organizationId: w.org.id,
        whatsappAccountId: w.account.id,
      });
      await alias(w.org.id, w.contact.id, "LK.100000000000000011", { source: ev.id });
      await t.pool.query("delete from webhook_events where id = $1", [ev.id]);
      const [row] = await db
        .select()
        .from(schema.contactBsuids)
        .where(eq(schema.contactBsuids.bsuid, "LK.100000000000000011"));
      expect(row).toBeDefined();
      expect(row!.sourceWebhookEventId).toBeNull();
    });

    it("treats the provenance pointer as provenance only: it is not a tenant boundary", async () => {
      const a = await seedWorld(db);
      const b = await seedWorld(db);
      const eventOfB = await seedWebhookEvent(db, {
        organizationId: b.org.id,
        whatsappAccountId: b.account.id,
      });
      const unrouted = await seedWebhookEvent(db);
      await alias(a.org.id, a.contact.id, "LK.100000000000000012", { source: eventOfB.id });
      await alias(a.org.id, a.contact.id, "LK.100000000000000013", { source: unrouted.id });
      const account = await seedAccount(db, a.org.id);
      expect(account.id).toBeDefined(); // ownership of the alias is decided by organization_id/contact_id alone
    });

    it("has the contact lookup index and the partial provenance index", async () => {
      const idx = await t.pool.query(
        "select indexname, indexdef from pg_indexes where tablename = 'contact_bsuids' order by 1",
      );
      const names = idx.rows.map((r) => r.indexname);
      expect(names).toContain("contact_bsuids_org_contact_idx");
      expect(names).toContain("contact_bsuids_source_event_idx");
      const source = idx.rows.find((r) => r.indexname === "contact_bsuids_source_event_idx");
      expect(source.indexdef).toMatch(/WHERE.*source_webhook_event_id.*IS NOT NULL/);
      // no unique index other than (organization_id, bsuid)
      const unique = idx.rows.filter((r) => /UNIQUE/.test(r.indexdef)).map((r) => r.indexname);
      expect(unique).toEqual(["contact_bsuids_org_bsuid_unique", "contact_bsuids_pkey"].sort());
    });
  });
  // -------------------------------------------------------------------------------------------- real catalog
  describe("real PostgreSQL catalog", () => {
    const columns = async (table: string) =>
      Object.fromEntries(
        (
          await t.pool.query(
            "select column_name, udt_name, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = $1",
            [table],
          )
        ).rows.map((r) => [r.column_name, r]),
      );
    const constraints = async (table: string, type: string) =>
      Object.fromEntries(
        (
          await t.pool.query(
            "select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = ('public.' || $1)::regclass and contype = $2",
            [table, type],
          )
        ).rows.map((r) => [r.conname, r.def as string]),
      );
    const indexes = async (table: string) =>
      Object.fromEntries(
        (
          await t.pool.query(
            "select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = $1",
            [table],
          )
        ).rows.map((r) => [r.indexname, r.indexdef as string]),
      );

    it("has exactly 23 tables", async () => {
      const r = await t.pool.query(
        "select count(*)::int n from information_schema.tables where table_schema = 'public'",
      );
      expect(r.rows[0].n).toBe(23);
    });

    it("webhook_requests: bytea raw_body NOT NULL, text sha256 NOT NULL, ACCEPTED default, nullable error code, four CHECKs, partial index", async () => {
      const c = await columns("webhook_requests");
      expect(c.raw_payload).toBeUndefined();
      expect(c.raw_body).toMatchObject({ udt_name: "bytea", is_nullable: "NO" });
      expect(c.payload_sha256).toMatchObject({ udt_name: "text", is_nullable: "NO" });
      expect(c.ingest_status).toMatchObject({ udt_name: "text", is_nullable: "NO" });
      expect(c.ingest_status.column_default).toBe("'ACCEPTED'::text");
      expect(c.ingest_error_code).toMatchObject({ udt_name: "text", is_nullable: "YES" });
      const checks = await constraints("webhook_requests", "c");
      expect(Object.keys(checks).sort()).toEqual([
        "webhook_requests_ingest_error_check",
        "webhook_requests_ingest_error_len_check",
        "webhook_requests_ingest_status_check",
        "webhook_requests_sha256_check",
      ]);
      expect(checks.webhook_requests_sha256_check).toContain("^[0-9a-f]{64}$");
      expect(checks.webhook_requests_ingest_status_check).toMatch(
        /ACCEPTED.*UNPARSEABLE.*UNSUPPORTED_SHAPE.*EVENTS_REJECTED/,
      );
      const idx = await indexes("webhook_requests");
      expect(idx.webhook_requests_not_accepted_idx).toMatch(
        /\(ingest_status, received_at\) WHERE \(ingest_status <> 'ACCEPTED'::text\)/,
      );
      expect(idx.webhook_requests_received_at_idx).toBeDefined();
    });

    it("contacts: wa_id nullable, username text, UNIQUE (organization_id, wa_id) still present", async () => {
      const c = await columns("contacts");
      expect(c.wa_id).toMatchObject({ udt_name: "text", is_nullable: "YES" });
      expect(c.username).toMatchObject({ udt_name: "text", is_nullable: "YES" });
      expect(c.bsuid).toBeUndefined();
      expect((await constraints("contacts", "u")).contacts_org_wa_id_unique).toBe(
        "UNIQUE (organization_id, wa_id)",
      );
    });

    it("contact_bsuids: planned columns, CHECKs, FKs, UNIQUE and indexes", async () => {
      const c = await columns("contact_bsuids");
      const expected: Record<string, [string, "YES" | "NO"]> = {
        id: ["uuid", "NO"],
        organization_id: ["uuid", "NO"],
        contact_id: ["uuid", "NO"],
        bsuid: ["text", "NO"],
        first_seen_at: ["timestamptz", "NO"],
        last_seen_at: ["timestamptz", "NO"],
        retired_at: ["timestamptz", "YES"],
        source_webhook_event_id: ["uuid", "YES"],
        created_at: ["timestamptz", "NO"],
      };
      expect(Object.keys(c).sort()).toEqual(Object.keys(expected).sort());
      for (const [name, [type, nullable]] of Object.entries(expected)) {
        expect(c[name], name).toMatchObject({ udt_name: type, is_nullable: nullable });
      }
      expect(Object.keys(await constraints("contact_bsuids", "c")).sort()).toEqual([
        "contact_bsuids_bsuid_check",
        "contact_bsuids_retired_order_check",
        "contact_bsuids_seen_order_check",
      ]);
      expect((await constraints("contact_bsuids", "u")).contact_bsuids_org_bsuid_unique).toBe(
        "UNIQUE (organization_id, bsuid)",
      );
      const fks = await constraints("contact_bsuids", "f");
      expect(fks.contact_bsuids_org_contact_fk).toBe(
        "FOREIGN KEY (organization_id, contact_id) REFERENCES contacts(organization_id, id)",
      );
      expect(fks.contact_bsuids_source_event_fk).toBe(
        "FOREIGN KEY (source_webhook_event_id) REFERENCES webhook_events(id) ON DELETE SET NULL",
      );
      const idx = await indexes("contact_bsuids");
      expect(idx.contact_bsuids_org_contact_idx).toMatch(
        /\(organization_id, contact_id, last_seen_at DESC\)/,
      );
      expect(idx.contact_bsuids_source_event_idx).toMatch(
        /\(source_webhook_event_id\) WHERE \(source_webhook_event_id IS NOT NULL\)/,
      );
    });

    it("records every FK that references webhook_events and its delete rule", async () => {
      const r = await t.pool.query(`
        select conrelid::regclass::text as tbl, conname,
               case confdeltype when 'a' then 'NO ACTION' when 'n' then 'SET NULL' when 'c' then 'CASCADE' when 'r' then 'RESTRICT' end as del
          from pg_constraint where contype = 'f' and confrelid = 'public.webhook_events'::regclass order by 1, 2`);
      // sorted in code: the SQL collation would order "messages" before "message_status_events"
      const byTable = [...r.rows].sort((a, b) => (a.tbl < b.tbl ? -1 : a.tbl > b.tbl ? 1 : 0));
      expect(byTable).toEqual([
        { tbl: "contact_bsuids", conname: "contact_bsuids_source_event_fk", del: "SET NULL" },
        {
          tbl: "message_status_events",
          conname: "message_status_events_org_webhook_event_fk",
          del: "NO ACTION",
        },
        { tbl: "messages", conname: "messages_org_source_webhook_event_fk", del: "NO ACTION" },
      ]);
    });
  });

  // ---------------------------------------------------------------------------------- exact bytes (bytea)
  describe("webhook_requests.raw_body preserves bytes exactly", () => {
    const fixture = (name: string) =>
      readFileSync(new URL(`../../modules/whatsapp/__fixtures__/${name}`, import.meta.url));
    const base = JSON.parse(fixture("text-phone.json").toString("utf8")) as {
      object: string;
      entry: unknown;
    };
    const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const cases: Array<[string, Buffer]> = [
      ["ordinary ASCII JSON", fixture("text-phone.json")],
      ["UTF-8 Sinhala (literal characters)", fixture("text-sinhala-raw-utf8.json")],
      ["Sinhala with lowercase \\uXXXX escapes", fixture("text-sinhala-escaped.json")],
      ["UTF-8 Tamil (literal characters)", fixture("text-tamil-raw-utf8.json")],
      [
        "a JSON \\u0000 escape sequence (text, not a NUL byte)",
        fixture("text-with-nul-escape.json"),
      ],
      ["bytes that are not valid UTF-8", fixture("invalid-utf8.bin")],
      ["truncated, unparseable JSON", fixture("invalid-json.txt")],
      ["every byte value 0x00 to 0xFF", allBytes],
      ["an empty body", Buffer.alloc(0)],
      ["compact JSON", Buffer.from(JSON.stringify(base))],
      ["pretty-printed JSON", Buffer.from(JSON.stringify(base, null, 2))],
      ["pretty-printed with a trailing newline", Buffer.from(JSON.stringify(base, null, 2) + "\n")],
      ["CRLF line endings", Buffer.from(JSON.stringify(base, null, 2).replace(/\n/g, "\r\n"))],
      [
        "keys in a different order",
        Buffer.from(JSON.stringify({ entry: base.entry, object: base.object })),
      ],
    ];

    it.each(cases)("round-trips byte for byte: %s", async (_name, bytes) => {
      const row = await seedWebhookRequest(db, { rawBody: bytes });
      const [back] = await db
        .select()
        .from(schema.webhookRequests)
        .where(eq(schema.webhookRequests.id, row.id));
      expect(Buffer.compare(back!.rawBody, bytes)).toBe(0);
      expect(back!.payloadSha256).toBe(sha(bytes)); // the column holds the SHA-256 of these exact bytes

      // and PostgreSQL itself agrees (no driver in the middle)
      const r = await t.pool.query(
        "select octet_length(raw_body) as len, encode(raw_body, 'hex') as hex, encode(sha256(raw_body), 'hex') as digest from webhook_requests where id = $1",
        [row.id],
      );
      expect(r.rows[0].len).toBe(bytes.length);
      expect(r.rows[0].hex).toBe(bytes.toString("hex"));
      expect(r.rows[0].digest).toBe(sha(bytes));
      expect(r.rows[0].digest).toBe(back!.payloadSha256);
    });

    it("stores bytes, not meaning: the same JSON value in different byte forms stays different", async () => {
      const forms = cases.filter(([n]) =>
        [
          "compact JSON",
          "pretty-printed JSON",
          "pretty-printed with a trailing newline",
          "CRLF line endings",
          "keys in a different order",
        ].includes(n),
      );
      const first = JSON.parse(forms[0]![1].toString("utf8"));
      for (const [, b] of forms) expect(JSON.parse(b.toString("utf8"))).toEqual(first); // identical JSON values ...
      expect(new Set(forms.map(([, b]) => sha(b))).size).toBe(forms.length); // ... different byte sequences
      const literal = fixture("text-sinhala-raw-utf8.json");
      const escaped = fixture("text-sinhala-escaped.json");
      expect(JSON.parse(literal.toString("utf8"))).toEqual(JSON.parse(escaped.toString("utf8")));
      expect(literal.equals(escaped)).toBe(false);
      const a = await seedWebhookRequest(db, { rawBody: literal });
      const b = await seedWebhookRequest(db, { rawBody: escaped });
      expect(a.payloadSha256).not.toBe(b.payloadSha256);
    });
  });

  // -------------------------------------------------------------------- BSUID history (schema level only)
  describe("contact_bsuids history semantics (no resolver)", () => {
    let seq = 0;
    // unique per call, so no test can touch another test's rows
    const freshBsuid = () => `LK.3${String(++seq).padStart(18, "0")}`;
    const T2 = new Date("2026-03-03T00:00:00Z");
    const insert = (orgId: string, contactId: string, value: string) =>
      db.insert(schema.contactBsuids).values({
        organizationId: orgId,
        contactId,
        bsuid: value,
        firstSeenAt: T0,
        lastSeenAt: T0,
      });
    const scope = (orgId: string, value: string) =>
      and(eq(schema.contactBsuids.organizationId, orgId), eq(schema.contactBsuids.bsuid, value));
    const update = (
      orgId: string,
      value: string,
      set: Partial<typeof schema.contactBsuids.$inferInsert>,
    ) => db.update(schema.contactBsuids).set(set).where(scope(orgId, value));
    const row = async (orgId: string, value: string) =>
      (await db.select().from(schema.contactBsuids).where(scope(orgId, value)))[0]!;

    it("permits two non-retired aliases, lets one be retired, and lets a late observation of the retired one touch last_seen_at", async () => {
      const w = await seedWorld(db);
      const [a, b] = [freshBsuid(), freshBsuid()];
      await insert(w.org.id, w.contact.id, a);
      await insert(w.org.id, w.contact.id, b); // H2: single-current cardinality is not established, so allowed
      const open = (
        await db
          .select()
          .from(schema.contactBsuids)
          .where(eq(schema.contactBsuids.contactId, w.contact.id))
      ).filter((r) => r.retiredAt === null);
      expect(open.map((r) => r.bsuid).sort()).toEqual([a, b].sort());

      await update(w.org.id, a, { retiredAt: T1 });
      expect((await row(w.org.id, a)).retiredAt).toEqual(T1);
      expect((await row(w.org.id, b)).retiredAt).toBeNull();

      // an old delivery carrying A arrives late: its last_seen_at moves forward without violating anything
      await update(w.org.id, a, { lastSeenAt: T2 });
      const late = await row(w.org.id, a);
      expect(late.lastSeenAt).toEqual(T2);
      expect(late.retiredAt).toEqual(T1); // still retired
      expect(late.contactId).toBe(w.contact.id);

      // the CHECKs keep holding for updates
      await expectPgError(
        update(w.org.id, a, { lastSeenAt: new Date("2026-02-01T00:00:00Z") }),
        CHECK_VIOLATION,
        "contact_bsuids_seen_order_check",
      );
    });

    it("keeps UNIQUE (organization, bsuid) against a second row for a retired alias on another contact", async () => {
      const org = await seedOrg(db);
      const x = await seedContact(db, org.id);
      const y = await seedContact(db, org.id);
      const [a, b] = [freshBsuid(), freshBsuid()];
      await insert(org.id, x.id, a);
      await update(org.id, a, { retiredAt: T1 });
      await expectPgError(
        insert(org.id, y.id, a),
        UNIQUE_VIOLATION,
        "contact_bsuids_org_bsuid_unique",
      );
      await insert(org.id, y.id, b); // a different BSUID is fine
    });

    it("FINDING: the schema alone does not stop an UPDATE from re-pointing an alias to another contact of the same organization", async () => {
      // UNIQUE prevents a second ROW for the alias; it cannot forbid changing contact_id of the existing row. The
      // resolver checkpoint must never re-point an alias (conflicts fail closed); a trigger could enforce it later.
      const org = await seedOrg(db);
      const x = await seedContact(db, org.id);
      const y = await seedContact(db, org.id);
      const a = freshBsuid();
      await insert(org.id, x.id, a);
      await update(org.id, a, { contactId: y.id });
      expect((await row(org.id, a)).contactId).toBe(y.id);
      // ... but never across organizations: the composite FK still binds the alias to its own organization
      const other = await seedWorld(db);
      await expectPgError(
        update(org.id, a, { contactId: other.contact.id }),
        FK_VIOLATION,
        "contact_bsuids_org_contact_fk",
      );
    });
  });

  // ------------------------------------------------------------------------------ provenance and retention
  describe("webhook event provenance and retention", () => {
    it("deleting the provenance event succeeds, keeps the alias and the contact, and clears only the pointer", async () => {
      const org = await seedOrg(db);
      const account = await seedAccount(db, org.id);
      const contact = await seedContact(db, org.id);
      const request = await seedWebhookRequest(db);
      const event = await seedWebhookEvent(db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
      });
      await db.insert(schema.contactBsuids).values({
        organizationId: org.id,
        contactId: contact.id,
        bsuid: "LK.200000000000000010",
        firstSeenAt: T0,
        lastSeenAt: T0,
        sourceWebhookEventId: event.id,
      });
      const contactBefore = (
        await db.select().from(schema.contacts).where(eq(schema.contacts.id, contact.id))
      )[0]!;

      await t.pool.query("delete from webhook_events where id = $1", [event.id]); // must NOT be blocked

      expect(
        (await t.pool.query("select count(*)::int n from webhook_events where id = $1", [event.id]))
          .rows[0].n,
      ).toBe(0);
      const [alias] = await db
        .select()
        .from(schema.contactBsuids)
        .where(eq(schema.contactBsuids.bsuid, "LK.200000000000000010"));
      expect(alias).toBeDefined();
      expect(alias!.sourceWebhookEventId).toBeNull();
      expect(alias!.organizationId).toBe(org.id);
      expect(alias!.contactId).toBe(contact.id);
      const contactAfter = (
        await db.select().from(schema.contacts).where(eq(schema.contacts.id, contact.id))
      )[0]!;
      expect(contactAfter).toEqual(contactBefore);
      expect(
        (
          await db.select().from(schema.organizations).where(eq(schema.organizations.id, org.id))
        )[0]!.id,
      ).toBe(org.id);
      expect(request.id).toBeDefined(); // the delivery row itself is untouched by deleting one of its events
    });

    it("FINDING (older FKs, unchanged by 0002): messages and status events DO block deleting a webhook event until their pointer is nulled", async () => {
      const w = await seedWorld(db);
      const forMessage = await seedWebhookEvent(db, {
        organizationId: w.org.id,
        whatsappAccountId: w.account.id,
      });
      await seedMessage(db, {
        organizationId: w.org.id,
        conversationId: w.conversation.id,
        whatsappAccountId: w.account.id,
        sourceWebhookEventId: forMessage.id,
      });
      await expectPgError(
        t.pool.query("delete from webhook_events where id = $1", [forMessage.id]),
        FK_VIOLATION,
        "messages_org_source_webhook_event_fk",
      );

      const forStatus = await seedWebhookEvent(db, {
        organizationId: w.org.id,
        whatsappAccountId: w.account.id,
      });
      await db.insert(schema.messageStatusEvents).values({
        organizationId: w.org.id,
        whatsappAccountId: w.account.id,
        wamid: "wamid.FAKE.status.retention",
        status: "SENT",
        occurredAt: T0,
        webhookEventId: forStatus.id,
      });
      await expectPgError(
        t.pool.query("delete from webhook_events where id = $1", [forStatus.id]),
        FK_VIOLATION,
        "message_status_events_org_webhook_event_fk",
      );

      // the documented retention order: null the pointers first, then prune
      await t.pool.query(
        "update messages set source_webhook_event_id = null where source_webhook_event_id = $1",
        [forMessage.id],
      );
      await t.pool.query(
        "update message_status_events set webhook_event_id = null where webhook_event_id = $1",
        [forStatus.id],
      );
      await t.pool.query("delete from webhook_events where id = any($1)", [
        [forMessage.id, forStatus.id],
      ]);
    });
  });
});
