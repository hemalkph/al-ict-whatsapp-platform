import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "../schema";

// Disposable-database harness. Each test file creates its own empty database on a LOCAL PostgreSQL
// server, migrates it from the committed migration files, and drops it afterwards.

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres";

function assertLocal(url: string) {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`Refusing to run DB tests against non-local host "${host}".`);
  }
}

export type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;

export async function createTestDatabase() {
  assertLocal(ADMIN_URL);
  const name = `al_ict_test_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 10 });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  return {
    db,
    pool,
    name,
    async close() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** Extracts the PostgreSQL error from a (possibly Drizzle-wrapped) failure. */
export function pgError(e: unknown): { code?: string; constraint?: string; message: string } {
  const err = e as { cause?: unknown; code?: string; constraint?: string; message: string };
  const inner = (err.cause ?? err) as { code?: string; constraint?: string; message: string };
  return { code: inner.code, constraint: inner.constraint, message: inner.message };
}

/** Asserts the promise rejects with the given SQLSTATE (and constraint name when given). */
export async function expectPgError(p: Promise<unknown>, code: string, constraint?: string) {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  if (!caught) throw new Error(`Expected PostgreSQL error ${code}, but the statement succeeded`);
  const got = pgError(caught);
  if (got.code !== code || (constraint && got.constraint !== constraint)) {
    throw new Error(
      `Expected ${code}${constraint ? ` (${constraint})` : ""}, got ${got.code} (${got.constraint}): ${got.message}`,
    );
  }
}

export const FK_VIOLATION = "23503";
export const UNIQUE_VIOLATION = "23505";
export const CHECK_VIOLATION = "23514";
export const NOT_NULL_VIOLATION = "23502";

// ---- seed helpers (each returns the inserted row) ----
type Db = TestDb["db"];
let counter = 0;
const uniq = () =>
  `${Date.now().toString(36)}${(counter++).toString(36)}${randomBytes(3).toString("hex")}`;
const at = (iso: string) => new Date(iso);

export async function seedOrg(db: Db) {
  const [row] = await db
    .insert(schema.organizations)
    .values({ name: "Org", slug: `org-${uniq()}` })
    .returning();
  return row!;
}

export async function seedAccount(db: Db, organizationId: string) {
  const [row] = await db
    .insert(schema.whatsappAccounts)
    .values({
      organizationId,
      wabaId: `waba-${uniq()}`,
      phoneNumberId: `pn-${uniq()}`,
      displayPhoneNumber: "+94 77 000 0000",
    })
    .returning();
  return row!;
}

export async function seedContact(db: Db, organizationId: string, waId = `wa-${uniq()}`) {
  const [row] = await db
    .insert(schema.contacts)
    .values({
      organizationId,
      waId,
      firstSeenAt: at("2026-01-01T00:00:00Z"),
      lastSeenAt: at("2026-01-01T00:00:00Z"),
    })
    .returning();
  return row!;
}

export async function seedConversation(
  db: Db,
  o: { organizationId: string; whatsappAccountId: string; contactId: string },
) {
  const [row] = await db
    .insert(schema.conversations)
    .values({ ...o, lastMessageAt: at("2026-01-01T00:00:00Z") })
    .returning();
  return row!;
}

export async function seedMessage(
  db: Db,
  o: {
    organizationId: string;
    conversationId: string;
    whatsappAccountId: string;
    wamid?: string | null;
    direction?: "INBOUND" | "OUTBOUND";
    replyToMessageId?: string | null;
    sourceWebhookEventId?: string | null;
    clientRequestId?: string | null;
  },
) {
  const [row] = await db
    .insert(schema.messages)
    .values({
      direction: "OUTBOUND",
      type: "TEXT",
      body: "hi",
      occurredAt: at("2026-01-01T00:00:01Z"),
      wamid: `wamid.${uniq()}`,
      ...o,
    })
    .returning();
  return row!;
}

export async function seedLead(db: Db, organizationId: string, contactId: string) {
  const [row] = await db.insert(schema.leads).values({ organizationId, contactId }).returning();
  return row!;
}

export async function seedWebhookEvent(
  db: Db,
  o: {
    organizationId?: string | null;
    whatsappAccountId?: string | null;
    key?: string;
    status?: string;
    receivedAt?: Date;
  } = {},
) {
  const [req] = await db
    .insert(schema.webhookRequests)
    .values({ rawPayload: { x: 1 }, payloadSha256: "00" })
    .returning();
  const [row] = await db
    .insert(schema.webhookEvents)
    .values({
      requestId: req!.id,
      organizationId: o.organizationId ?? null,
      whatsappAccountId: o.whatsappAccountId ?? null,
      eventType: "MESSAGE",
      idempotencyKey: o.key ?? `k-${uniq()}`,
      payload: { x: 1 },
      ...(o.status ? { status: o.status as never } : {}),
      ...(o.receivedAt ? { receivedAt: o.receivedAt } : {}),
    })
    .returning();
  return row!;
}

export async function seedTag(db: Db, organizationId: string, name = `tag-${uniq()}`) {
  const [row] = await db.insert(schema.tags).values({ organizationId, name }).returning();
  return row!;
}

/** Org with account, contact and conversation: the common starting point. */
export async function seedWorld(db: Db) {
  const org = await seedOrg(db);
  const account = await seedAccount(db, org.id);
  const contact = await seedContact(db, org.id);
  const conversation = await seedConversation(db, {
    organizationId: org.id,
    whatsappAccountId: account.id,
    contactId: contact.id,
  });
  return { org, account, contact, conversation };
}
