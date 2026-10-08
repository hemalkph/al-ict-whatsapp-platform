import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@/db";
import { seedAccount, seedOrg, seedWebhookRequest, type TestDb } from "@/db/__tests__/helpers";
import { ingestVerifiedDelivery } from "../ingest";

// TEST-ONLY helpers for the queue tests (excluded from the boundary scans). Events are either inserted directly (to put
// the queue in an exact state) or produced by the REAL ingest path so held events carry genuine normalized envelopes.

type Db = TestDb["db"];
type Pool = TestDb["pool"];
type EventStatus = (typeof schema.WEBHOOK_EVENT_STATUSES)[number];
let counter = 0;
const uniq = () => `${(counter++).toString(36)}${randomBytes(3).toString("hex")}`;

// Far in the future of any real clock, so a scheduled retry is never due again inside the same test.
export const FIXED_NOW = new Date("2099-01-01T00:00:00.000Z");

export async function world(db: Db, o: { status?: "PENDING" | "ACTIVE" | "DISABLED" } = {}) {
  const org = await seedOrg(db);
  const base = await seedAccount(db, org.id);
  const [account] = await db
    .update(schema.whatsappAccounts)
    .set({ status: o.status ?? "ACTIVE" })
    .where(eqId(base.id))
    .returning();
  return { org, account: account! };
}
const eqId = (id: string) => eq(schema.whatsappAccounts.id, id);

/** Inserts one event directly, in an exact queue state. */
export async function insertEvent(
  db: Db,
  o: {
    organizationId?: string | null;
    whatsappAccountId?: string | null;
    phoneNumberId?: string;
    wabaId?: string;
    eventType?: (typeof schema.WEBHOOK_EVENT_TYPES)[number];
    status?: EventStatus;
    attempts?: number;
    receivedAt?: Date;
    lastError?: string | null;
    payload?: unknown;
  } = {},
) {
  const req = await seedWebhookRequest(db);
  const [row] = await db
    .insert(schema.webhookEvents)
    .values({
      requestId: req.id,
      organizationId: o.organizationId ?? null,
      whatsappAccountId: o.whatsappAccountId ?? null,
      eventType: o.eventType ?? "MESSAGE",
      idempotencyKey: `k-${uniq()}`,
      payload: o.payload ?? {
        v: 1,
        wabaId: o.wabaId ?? null,
        field: "messages",
        metadata: { phone_number_id: o.phoneNumberId ?? null },
        message: { id: `wamid.${uniq()}` },
      },
      status: o.status ?? "PENDING",
      attempts: o.attempts ?? 0,
      lastError: o.lastError ?? null,
      ...(o.receivedAt ? { receivedAt: o.receivedAt } : {}),
    })
    .returning();
  return row!;
}

/** A routed PENDING MESSAGE event for the account. */
export const pending = (
  db: Db,
  w: { org: { id: string }; account: { id: string; phoneNumberId: string; wabaId: string } },
  o: Parameters<typeof insertEvent>[1] = {},
) =>
  insertEvent(db, {
    organizationId: w.org.id,
    whatsappAccountId: w.account.id,
    phoneNumberId: w.account.phoneNumberId,
    wabaId: w.account.wabaId,
    ...o,
  });

export type EventRow = {
  id: string;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
  processed_at: Date | null;
  organization_id: string | null;
  whatsapp_account_id: string | null;
};
export async function getEvent(pool: Pool, id: string): Promise<EventRow> {
  const r = await pool.query<EventRow>("select * from webhook_events where id = $1", [id]);
  return r.rows[0]!;
}

/** Simulates 121 s passing for a claim: the lease is expired and the next claim may reclaim it. */
export const expireLeases = (pool: Pool) =>
  pool.query(
    "update webhook_events set locked_at = now() - interval '121 seconds' where status = 'PROCESSING'",
  );
/** Simulates the retry delay having passed. */
export const makeFailedDue = (pool: Pool) =>
  pool.query("update webhook_events set next_attempt_at = now() where status = 'FAILED'");

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function until(check: () => Promise<boolean> | boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Deterministic PRNG (mulberry32) so randomized tests are reproducible from their seed. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const lockOwners = (prefix = "owner") => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

/** A fake domain table: stands in for future contact/message writes without implementing any of them. */
export const FIXTURE_DDL =
  "create table if not exists queue_fixture_notes (id serial primary key, event_id uuid not null, note text not null)";

/** A constraint that is only checked at COMMIT: lets a test make the handler's transaction fail after its last statement. */
export const FIXTURE_DEFERRED_DDL = [
  "create table if not exists queue_fixture_parents (id int primary key)",
  "create table if not exists queue_fixture_children (id serial primary key, parent_id int not null references queue_fixture_parents(id) deferrable initially deferred)",
];

export const message = (id: string, extra: Record<string, unknown> = {}) => ({
  from: "15550100123",
  id,
  timestamp: "1790000000",
  type: "text",
  text: { body: `hello ${id}` },
  ...extra,
});

export const delivery = (o: { waba: string; pn: string; messages?: unknown[] }) =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: o.waba,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550100001", phone_number_id: o.pn },
              contacts: [{ profile: { name: "Test Student" }, wa_id: "15550100123" }],
              messages: o.messages ?? [],
            },
          },
        ],
      },
    ],
  });

/** Runs a delivery through the REAL ingest path. */
export const ingest = (db: Db, body: string) =>
  ingestVerifiedDelivery(Buffer.from(body), { db: db as never });
