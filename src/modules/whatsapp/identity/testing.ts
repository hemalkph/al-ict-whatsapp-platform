import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@/db";
import { seedOrg, type TestDb } from "@/db/__tests__/helpers";
import { ingestVerifiedDelivery } from "../ingest";
import type { TrustedWebhookEvent } from "./resolve";

// TEST-ONLY helpers (excluded from the boundary scans). Events are produced by the REAL ingest path (real normalizer,
// real routing), so the resolver is always exercised against genuine stored envelopes.

type Db = TestDb["db"];
let n = 0;
const uniq = () => `${(n++).toString(36)}${randomBytes(2).toString("hex")}`;

export const PN = "100000000000001"; // the phone_number_id / WABA used inside the sanitized G0 fixtures
export const WABA = "200000000000001";
export const PN2 = "100000000000002";
export const WABA2 = "200000000000002";

export async function tenant(db: Db, o: { pn?: string; waba?: string } = {}) {
  const org = await seedOrg(db);
  const [account] = await db
    .insert(schema.whatsappAccounts)
    .values({
      organizationId: org.id,
      wabaId: o.waba ?? WABA,
      phoneNumberId: o.pn ?? PN,
      displayPhoneNumber: "15550100001",
      status: "ACTIVE",
    })
    .returning();
  return { org, account: account! };
}

export type StoredEvent = TrustedWebhookEvent & { providerObjectId: string };

const toEvent = (r: typeof schema.webhookEvents.$inferSelect): StoredEvent => ({
  id: r.id,
  eventType: r.eventType,
  organizationId: r.organizationId!,
  whatsappAccountId: r.whatsappAccountId!,
  receivedAt: r.receivedAt,
  payload: r.payload,
  providerObjectId: r.providerObjectId!,
});

/** Runs raw delivery bytes through the real ingest path and returns the stored events (by wamid). */
export async function ingestBytes(db: Db, bytes: Uint8Array): Promise<StoredEvent[]> {
  const outcome = await ingestVerifiedDelivery(bytes, { db: db as never });
  const rows = await db
    .select()
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.requestId, outcome.requestId));
  return rows.map(toEvent);
}

export const ingestFixture = (db: Db, name: string) =>
  ingestBytes(db, readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url)));

export type SendOptions = {
  pn?: string;
  waba?: string;
  bsuid?: string | null;
  from?: string | null;
  name?: string | null;
  username?: string | null;
  /** Put this contacts[] element in the delivery instead of the generated, correctly paired one. */
  contacts?: unknown[];
};

/** One text message from the given sender, delivered through the real ingest path. */
export async function send(db: Db, o: SendOptions): Promise<StoredEvent> {
  const id = `wamid.TEST${uniq()}`;
  const profile: Record<string, unknown> = {};
  if (o.name !== undefined && o.name !== null) profile.name = o.name;
  if (o.username) profile.username = o.username;
  const contact: Record<string, unknown> = { profile };
  if (o.from) contact.wa_id = o.from;
  if (o.bsuid) contact.user_id = o.bsuid;
  const message: Record<string, unknown> = {
    id,
    timestamp: "1790000000",
    type: "text",
    text: { body: `hello ${id}` },
  };
  if (o.from) message.from = o.from;
  if (o.bsuid) message.from_user_id = o.bsuid;
  const body = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: o.waba ?? WABA,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550100001", phone_number_id: o.pn ?? PN },
              contacts: o.contacts ?? [contact],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
  const events = await ingestBytes(db, Buffer.from(JSON.stringify(body)));
  return events.find((e) => e.providerObjectId === id)!;
}

export const DOMAIN_TABLES = [
  "leads",
  "lead_attributions",
  "conversations",
  "messages",
  "message_status_events",
  "message_attachments",
  "contact_consents",
  "contact_tags",
  "tags",
];

export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
