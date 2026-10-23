import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import * as schema from "../schema";

// Disposable-database harness. Each test file creates its own empty database on a LOCAL PostgreSQL
// server, migrates it from the committed migration files, and drops it afterwards.

// Safety preflight (Phase 08C, ADR 0019). The persistent development database (al_ict_whatsapp) must never be touched by
// tests. The administrative connection comes ONLY from TEST_DATABASE_ADMIN_URL (never defaulted, never DATABASE_URL or
// .env.local) and may only reach the maintenance database "postgres" on a local server over TCP. The only database the
// harness ever creates or drops is the one it generated, named al_ict_test_<12 hex> (al_ict_e2e_<12 hex> for the browser
// suite); the name is re-checked before DROP DATABASE.
//
// The check is made on what the installed driver would actually do, not on how a generic URL parser reads the string:
// pg-connection-string lets query parameters (host, port, dbname via db=, options, ...) override the URL's host and path,
// accepts a socket: protocol and bare /socket paths, and pg's ConnectionParameters fills any missing field from PG* env
// variables. So the string must be a plain postgres(ql)://user[:password]@local-host[:port]/postgres with no query, fragment
// or whitespace; pg's own ConnectionParameters must then resolve both the string and the explicit config built from it to
// that same host, port, database and user; and the pool is created from that explicit config (no connection string), so
// what was validated is exactly what connects. These URL/driver checks run before any client or pool exists. The validated
// maintenance connection must then report PostgreSQL 17 before CREATE DATABASE. Refusal closes its pool. Error messages
// never include the connection string or credentials.
export const PERSISTENT_DATABASE = "al_ict_whatsapp";
export const DISPOSABLE_DATABASE_NAME = /^al_ict_(test|e2e)_[0-9a-f]{12}$/;
export const MAINTENANCE_DATABASE = "postgres";
const LOCAL_HOSTS = new Map([
  ["localhost", "localhost"],
  ["127.0.0.1", "127.0.0.1"],
  ["[::1]", "::1"],
]);

/** An explicit, validated connection target: every field the driver routes on is set, so nothing falls back to PG* env. */
export type PgTarget = {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
};

type EffectiveParameters = {
  host: string;
  port: number;
  database: string;
  user: string;
  isDomainSocket: boolean;
};
// pg's own resolver (the code path Pool/Client use to turn options into a connection target). Constructing it opens nothing.
const ConnectionParameters = createRequire(import.meta.url)("pg/lib/connection-parameters") as new (
  config: string | object,
) => EffectiveParameters;

const refuse = (reason: string) => new Error(`Refusing to run DB tests: ${reason}.`);

function resolveTarget(raw: string | undefined, label: string, database: string): PgTarget {
  if (raw === undefined || raw === "")
    throw refuse(`${label} is not set (it has no default, and DATABASE_URL is never used)`);
  if (/\s/.test(raw) || raw.includes("?") || raw.includes("#"))
    throw refuse(`${label} must not contain whitespace, connection options (?...) or a fragment`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refuse(`${label} is not a valid connection URL`); // the parser's error would carry the input
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw refuse(`${label} must use postgres: or postgresql:, not "${url.protocol}"`);
  const host = LOCAL_HOSTS.get(url.hostname);
  if (host === undefined) throw refuse(`${label} must name a local server, not "${url.hostname}"`);
  if (url.username === "") throw refuse(`${label} must name its user explicitly`);
  const path = url.pathname.slice(1);
  if (
    path.toLowerCase().includes(PERSISTENT_DATABASE) ||
    safeDecode(path).toLowerCase().includes(PERSISTENT_DATABASE)
  )
    throw refuse(`${label} names ${PERSISTENT_DATABASE}`);
  if (path !== database) throw refuse(`${label} must use the database "${database}"`);
  const target: PgTarget = {
    host,
    port: url.port === "" ? 5432 : Number(url.port),
    database,
    user: safeDecode(url.username),
    password: safeDecode(url.password),
  };
  // What the driver itself resolves, from the string and from the explicit config the pool will receive, must be the target.
  for (const [source, config] of [
    ["string", raw],
    ["config", target],
  ] as const) {
    const p = new ConnectionParameters(config);
    if (
      p.isDomainSocket ||
      p.host !== target.host ||
      p.port !== target.port ||
      p.database !== target.database ||
      p.user !== target.user
    )
      throw refuse(
        `the PostgreSQL driver resolves ${label} (${source}) to a different target than validated (check PGHOST/PGPORT/PGDATABASE/PGUSER)`,
      );
  }
  return target;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw refuse("the connection URL contains invalid percent-encoding");
  }
}

/** The validated administrative target: local server, maintenance database, from TEST_DATABASE_ADMIN_URL only. */
export function resolveAdminTarget(
  raw: string | undefined = process.env.TEST_DATABASE_ADMIN_URL,
): PgTarget {
  return resolveTarget(raw, "TEST_DATABASE_ADMIN_URL", MAINTENANCE_DATABASE);
}

/** Back-compat name for the admin preflight. */
export const assertSafeAdminUrl = (url: string): PgTarget => resolveAdminTarget(url);

export function assertDisposableName(name: string): void {
  if (name === PERSISTENT_DATABASE || !DISPOSABLE_DATABASE_NAME.test(name))
    throw new Error(`Refusing to create or drop "${name}": not a disposable test database name.`);
}

/**
 * A generated disposable database on the validated admin server: its explicit target (for the harness pool) and its URL (for
 * code under test that takes a URL). The URL goes through the same driver check, so both can only reach that database.
 */
export function disposableTarget(admin: PgTarget, name: string): { target: PgTarget; url: string } {
  assertDisposableName(name);
  const host = admin.host === "::1" ? "[::1]" : admin.host;
  const credentials = `${encodeURIComponent(admin.user)}${admin.password === "" ? "" : `:${encodeURIComponent(admin.password)}`}`;
  const url = `postgresql://${credentials}@${host}:${admin.port}/${name}`;
  return { target: resolveTarget(url, "the disposable database URL", name), url };
}

export type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;

/**
 * Server-side limits for every session of a test pool, sent by the driver at connection start (milliseconds). The server
 * enforces them even if the test process stops awaiting: a lock wait, a statement or an abandoned transaction ends on its own.
 */
export type SessionTimeouts = {
  readonly lock_timeout?: number;
  readonly statement_timeout?: number;
  readonly idle_in_transaction_session_timeout?: number;
};

/**
 * A pg Pool with explicit ownership. `pool.end()` alone is not enough: pg-pool drops its clients from
 * its own bookkeeping immediately and closes the sockets asynchronously, so `await pool.end()` can
 * resolve while backend connections are still closing. end() therefore also waits for every client
 * the pool ever created to emit "end". Pool-level errors are recorded and re-thrown from end()
 * rather than ignored.
 */
function ownedPool(target: PgTarget, max: number, timeouts: SessionTimeouts = {}) {
  const pool = new Pool({ ...target, ...timeouts, max });
  const clientsClosed: Promise<void>[] = [];
  const errors: Error[] = [];
  pool.on("connect", (client) => {
    clientsClosed.push(new Promise<void>((resolve) => client.once("end", () => resolve())));
  });
  pool.on("error", (e) => errors.push(e)); // idle-client errors; surfaced by end(), never swallowed
  let ended: Promise<void> | undefined;
  return {
    pool,
    end() {
      ended ??= (async () => {
        await pool.end();
        await withTimeout(Promise.all(clientsClosed), 10_000, "pool connections did not close");
        if (errors.length > 0) throw new AggregateError(errors, "pg pool reported errors");
      })();
      return ended;
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Waits until the scratch database has no remaining sessions. Backends exit asynchronously after
 * their client disconnects, so brief polling is expected. Sessions that never go away are leaks
 * (e.g. a pool created by a test and never ended): they are reported, never force-terminated.
 */
async function waitForNoSessions(admin: Pool, name: string, waitMs: number) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = await admin.query(
      "select pid, application_name, state from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [name],
    );
    if (r.rowCount === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Test database ${name} still connected after teardown (leaked connections: ${JSON.stringify(r.rows)}). ` +
          "A test created a pool/client that it never closed.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function createTestDatabase(
  options: {
    sessionWaitMs?: number;
    prefix?: "al_ict_test" | "al_ict_e2e";
    /** false = return an EMPTY database with no migrations applied (migration-precondition tests only). */
    migrate?: boolean;
    /** PostgreSQL session timeouts for the test pool (not the admin connection). Default: none. */
    sessionTimeouts?: SessionTimeouts;
  } = {},
) {
  const adminTarget = resolveAdminTarget();
  const name = `${options.prefix ?? "al_ict_test"}_${randomBytes(6).toString("hex")}`;
  assertDisposableName(name);
  const disposable = disposableTarget(adminTarget, name);
  const url = disposable.url;
  const admin = ownedPool(adminTarget, 1);
  try {
    const result = await admin.pool.query<{ server_version_num: string }>(
      "SHOW server_version_num",
    );
    const version = Number(result.rows[0]?.server_version_num);
    if (!Number.isInteger(version) || version < 170000 || version >= 180000)
      throw refuse("PostgreSQL 17 is required for the isolated test server");
    await admin.pool.query(`CREATE DATABASE ${name}`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const owned = ownedPool(disposable.target, 10, options.sessionTimeouts);
  const pool = owned.pool;
  const db = drizzle(pool, { schema });
  let closed: Promise<void> | undefined;
  try {
    if (options.migrate !== false) {
      await migrate(db, {
        migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
      });
    }
  } catch (e) {
    await owned.end();
    assertDisposableName(name);
    await admin.pool.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
    throw e;
  }
  return {
    db,
    pool,
    name,
    url,
    /** The validated explicit target of this disposable database (for an extra connection outside the pool). */
    target: disposable.target,
    /**
     * Lifecycle: finish all work -> end the harness pool and wait for its sockets to close -> wait
     * for the server to report no sessions -> DROP DATABASE (no FORCE) -> close the admin pool.
     * Throws if a test leaked a connection; the database is then left in place (retry after the
     * leak is closed succeeds).
     */
    close() {
      if (closed) return closed;
      closed = (async () => {
        await owned.end();
        await waitForNoSessions(admin.pool, name, options.sessionWaitMs ?? 10_000);
        assertDisposableName(name);
        await admin.pool.query(`DROP DATABASE IF EXISTS ${name}`);
        await admin.end();
      })();
      // A failed close (leak) may be retried once the leak is fixed; a successful one is final.
      closed.catch(() => (closed = undefined));
      return closed;
    },
  };
}

/**
 * A SECOND owned pool on the same disposable database with its own session timeouts (for example a short lock_timeout in a
 * mutation check). Test-only; close it with end() before the test database is closed (its sessions would otherwise be reported
 * as a leak by close()).
 */
export function extraTestDb(t: TestDb, timeouts: SessionTimeouts, max = 2) {
  const owned = ownedPool(t.target, max, timeouts);
  return { db: drizzle(owned.pool, { schema }), end: () => owned.end() };
}

/**
 * Cancels (or, as a last resort, terminates) every non-idle session of a disposable test database except its own, over a
 * dedicated connection outside the test pool (which may be exhausted by the very statements being stopped). This stops the
 * SQL on the server; abandoning a JavaScript promise would not. Returns how many backends were signalled.
 */
export async function signalTestBackends(
  target: PgTarget,
  signal: "cancel" | "terminate",
): Promise<number> {
  assertDisposableName(target.database);
  const client = new Client({
    ...target,
    statement_timeout: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    // Cancelling reaches running statements (including lock waits); terminating also ends idle-in-transaction sessions.
    const [fn, which] =
      signal === "cancel"
        ? ["pg_cancel_backend", "state = 'active'"]
        : ["pg_terminate_backend", "state is distinct from 'idle'"];
    const r = await client.query<{ n: number }>(
      `select count(*) filter (where ${fn}(pid))::int n from pg_stat_activity
       where datname = $1 and pid <> pg_backend_pid() and ${which}`,
      [target.database],
    );
    return r.rows[0]!.n;
  } finally {
    await client.end();
  }
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

/** A stored, signature-verified delivery: exact bytes plus the lowercase-hex SHA-256 of those bytes. */
export async function seedWebhookRequest(
  db: Db,
  o: {
    rawBody?: Buffer;
    ingestStatus?: (typeof schema.INGEST_STATUSES)[number];
    ingestErrorCode?: string | null;
  } = {},
) {
  const rawBody = o.rawBody ?? Buffer.from('{"x":1}');
  const [row] = await db
    .insert(schema.webhookRequests)
    .values({
      rawBody,
      payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
      ...(o.ingestStatus ? { ingestStatus: o.ingestStatus } : {}),
      ...(o.ingestErrorCode !== undefined ? { ingestErrorCode: o.ingestErrorCode } : {}),
    })
    .returning();
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
  const req = await seedWebhookRequest(db);
  const [row] = await db
    .insert(schema.webhookEvents)
    .values({
      requestId: req.id,
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
