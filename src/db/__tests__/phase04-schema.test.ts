import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableName, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../schema";

// DB-free checks of the Phase 04 schema (migration 0002): the Drizzle definitions and the generated SQL text.
// The constraints themselves are exercised against real PostgreSQL by webhook-contact-schema.db.test.ts.
// This file must NOT live under src/db/schema/: drizzle-kit loads every file in that folder as a schema.

const tables = (Object.values(schema) as unknown[]).filter((x): x is PgTable => is(x, PgTable));
const config = (t: PgTable) => getTableConfig(t);
const named = (t: PgTable) => config(t);
const MIGRATION = readFileSync(
  fileURLToPath(
    new URL("../migrations/0002_whatsapp_webhook_ingest_and_bsuid_identity.sql", import.meta.url),
  ),
  "utf8",
);

describe("webhook_requests (exact raw body + ingest state)", () => {
  const c = named(schema.webhookRequests);
  const col = (name: string) => c.columns.find((x) => x.name === name);

  it("stores the exact bytes as bytea NOT NULL and no longer has a jsonb raw_payload", () => {
    expect(col("raw_body")?.getSQLType()).toBe("bytea");
    expect(col("raw_body")?.notNull).toBe(true);
    expect(col("raw_payload")).toBeUndefined();
  });

  it("keeps payload_sha256 NOT NULL (non-unique: Meta redelivers identical bytes)", () => {
    expect(col("payload_sha256")?.notNull).toBe(true);
    expect(c.uniqueConstraints).toEqual([]);
    expect(c.indexes.some((i) => i.config.unique)).toBe(false);
  });

  it("defaults ingest_status to ACCEPTED and allows a NULL error code", () => {
    expect(col("ingest_status")?.default).toBe("ACCEPTED");
    expect(col("ingest_status")?.notNull).toBe(true);
    expect(col("ingest_error_code")?.notNull).toBe(false);
  });

  it("declares the sha256-format, status and error-code CHECKs and the operational partial index", () => {
    expect(c.checks.map((x) => x.name).sort()).toEqual([
      "webhook_requests_ingest_error_check",
      "webhook_requests_ingest_error_len_check",
      "webhook_requests_ingest_status_check",
      "webhook_requests_sha256_check",
    ]);
    const idx = c.indexes.find((i) => i.config.name === "webhook_requests_not_accepted_idx");
    expect(idx?.config.where).toBeDefined();
  });

  it("allows exactly the planned ingest statuses", () => {
    expect([...schema.INGEST_STATUSES]).toEqual([
      "ACCEPTED",
      "UNPARSEABLE",
      "UNSUPPORTED_SHAPE",
      "EVENTS_REJECTED",
    ]);
    for (const status of schema.INGEST_STATUSES) expect(MIGRATION).toContain(`'${status}'`);
  });
});

describe("contacts (BSUID-only senders)", () => {
  const c = named(schema.contacts);
  const col = (name: string) => c.columns.find((x) => x.name === name);

  it("makes wa_id nullable, keeps its per-organization uniqueness and adds username", () => {
    expect(col("wa_id")?.notNull).toBe(false);
    expect(col("username")).toBeDefined();
    expect(c.uniqueConstraints.map((u) => u.name)).toContain("contacts_org_wa_id_unique");
  });

  it("does NOT carry a bsuid column: BSUIDs live only in contact_bsuids", () => {
    expect(c.columns.map((x) => x.name).filter((n) => n.includes("bsuid"))).toEqual([]);
  });
});

describe("contact_bsuids (BSUID ownership and history)", () => {
  const c = named(schema.contactBsuids);

  it("keeps a BSUID unique per organization (current or retired)", () => {
    expect(c.uniqueConstraints.map((u) => u.name)).toEqual(["contact_bsuids_org_bsuid_unique"]);
    expect(c.uniqueConstraints[0]?.columns.map((x) => x.name)).toEqual([
      "organization_id",
      "bsuid",
    ]);
  });

  it("references contacts through the composite organization-aware FK", () => {
    const fk = c.foreignKeys.find((f) => f.getName() === "contact_bsuids_org_contact_fk");
    const ref = fk!.reference();
    expect(ref.columns.map((x) => x.name)).toEqual(["organization_id", "contact_id"]);
    expect(ref.foreignColumns.map((x) => x.name)).toEqual(["organization_id", "id"]);
    expect(getTableName(ref.foreignTable)).toBe("contacts");
  });

  it("makes the webhook-event provenance FK a single-column ON DELETE SET NULL (never blocks pruning)", () => {
    const fk = c.foreignKeys.find((f) => f.getName() === "contact_bsuids_source_event_fk");
    const ref = fk!.reference();
    expect(ref.columns.map((x) => x.name)).toEqual(["source_webhook_event_id"]);
    expect(ref.foreignColumns.map((x) => x.name)).toEqual(["id"]);
    expect(getTableName(ref.foreignTable)).toBe("webhook_events");
    expect(fk!.onDelete).toBe("set null");
    expect(MIGRATION).toMatch(
      /"contact_bsuids_source_event_fk" FOREIGN KEY \("source_webhook_event_id"\) REFERENCES "public"\."webhook_events"\("id"\) ON DELETE set null/,
    );
  });

  it("has the CHECKs for bounded BSUIDs and ordered timestamps", () => {
    expect(c.checks.map((x) => x.name).sort()).toEqual([
      "contact_bsuids_bsuid_check",
      "contact_bsuids_retired_order_check",
      "contact_bsuids_seen_order_check",
    ]);
  });

  it("deliberately has NO 'one current alias per contact' unique index (H2 is not proven by Meta's docs)", () => {
    expect(c.indexes.filter((i) => i.config.unique)).toEqual([]);
    expect(MIGRATION).not.toMatch(/CREATE UNIQUE INDEX[^;]*contact_bsuids/);
    expect(MIGRATION).not.toMatch(/UNIQUE\s*\([^)]*contact_id[^)]*\)/);
  });
});

describe("Phase 04 constants", () => {
  it("adds IDENTITY events and REACTION messages without removing anything", () => {
    expect(schema.WEBHOOK_EVENT_TYPES).toEqual(["MESSAGE", "STATUS", "IDENTITY", "OTHER"]);
    expect(schema.MESSAGE_TYPES).toContain("REACTION");
    expect(schema.MESSAGE_TYPES).toContain("UNKNOWN");
  });
});

describe("generated migration 0002", () => {
  it("replaces raw_payload with a bytea raw_body and touches nothing unrelated", () => {
    expect(MIGRATION).toContain(
      'ALTER TABLE "webhook_requests" ADD COLUMN "raw_body" "bytea" NOT NULL',
    );
    expect(MIGRATION).toContain('ALTER TABLE "webhook_requests" DROP COLUMN "raw_payload"');
    expect(MIGRATION).toContain('ALTER TABLE "contacts" ALTER COLUMN "wa_id" DROP NOT NULL');
    const tablesTouched = new Set(
      [...MIGRATION.matchAll(/(?:CREATE TABLE|ALTER TABLE|ON) "([a-z_]+)"/g)].map((m) => m[1]),
    );
    expect([...tablesTouched].sort()).toEqual(["contact_bsuids", "contacts", "webhook_requests"]);
    expect(MIGRATION).not.toMatch(/DROP TABLE|DROP INDEX|DROP CONSTRAINT/);
  });
});

describe("identifier lengths (PostgreSQL truncates silently above 63 bytes)", () => {
  it("keeps every table, column, index, constraint and foreign-key name within 63 characters", () => {
    const tooLong: string[] = [];
    const check = (kind: string, name: string | undefined) => {
      if (name && name.length > 63) tooLong.push(`${kind}: ${name}`);
    };
    for (const t of tables) {
      const c = config(t);
      check("table", c.name);
      c.columns.forEach((x) => check("column", x.name));
      c.indexes.forEach((i) => check("index", i.config.name));
      c.uniqueConstraints.forEach((u) => check("unique", u.name));
      c.checks.forEach((x) => check("check", x.name));
      c.foreignKeys.forEach((f) => check("fk", f.getName()));
      c.primaryKeys.forEach((p) => check("pk", p.getName()));
    }
    expect(tooLong).toEqual([]);
  });
});
