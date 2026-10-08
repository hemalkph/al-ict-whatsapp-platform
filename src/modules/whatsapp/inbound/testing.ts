import { eq } from "drizzle-orm";
import { schema } from "@/db";
import type { TestDb } from "@/db/__tests__/helpers";
import {
  processWebhookBatch,
  type WebhookEventKind,
  type WebhookHandlerContext,
} from "../queue/process";
import { handleInboundMessage, inboundMessageHandlers } from "./handler";
import { PN, WABA, ingestBytes, type StoredEvent } from "../identity/testing";

export { PN, WABA, ingestBytes, ingestFixture, minutesAgo, tenant } from "../identity/testing";
export type { StoredEvent } from "../identity/testing";

// TEST-ONLY helpers (excluded from the boundary scans). Everything is produced by the REAL ingest path, so the handler
// is always exercised against genuine stored envelopes, and run by the REAL queue worker with the real registry.

type Db = TestDb["db"];
let n = 0;
const uniq = () => `${(n++).toString(36)}${Math.random().toString(16).slice(2, 6)}`;

/** Epoch seconds as Meta sends them (a string). */
export const epoch = (date: Date) => String(Math.floor(date.getTime() / 1000));

export type DeliverOptions = {
  pn?: string;
  waba?: string;
  from?: string | null;
  bsuid?: string | null;
  name?: string | null;
  /** The wamid; generated when omitted. */
  id?: string;
  /** Provider timestamp (epoch seconds as a string, a Date, or any raw value to test invalid input). */
  timestamp?: Date | string | number;
  /** Replaces the whole default text message body: { type: 'image', image: {...} } etc. */
  message?: Record<string, unknown>;
  contacts?: unknown[];
};

export function deliveryBytes(o: DeliverOptions = {}): { bytes: Buffer; wamid: string } {
  const wamid = o.id ?? `wamid.TEST${uniq()}`;
  const timestamp =
    o.timestamp instanceof Date
      ? epoch(o.timestamp)
      : (o.timestamp ?? epoch(new Date(Date.now() - 60_000)));
  const profile: Record<string, unknown> = {};
  if (o.name) profile.name = o.name;
  const contact: Record<string, unknown> = { profile };
  const message: Record<string, unknown> = { id: wamid, timestamp };
  const from = o.from === undefined ? "15550100123" : o.from;
  if (from) {
    message.from = from;
    contact.wa_id = from;
  }
  if (o.bsuid) {
    message.from_user_id = o.bsuid;
    contact.user_id = o.bsuid;
  }
  Object.assign(message, o.message ?? { type: "text", text: { body: `hello ${wamid}` } });
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
  return { bytes: Buffer.from(JSON.stringify(body)), wamid };
}

/** One message through the real ingest path; returns the stored (routed, PENDING) event. */
export async function deliver(db: Db, o: DeliverOptions = {}): Promise<StoredEvent> {
  const { bytes, wamid } = deliveryBytes(o);
  const events = await ingestBytes(db, bytes);
  const event = events.find((e) => e.providerObjectId === wamid);
  if (!event) throw new Error("the delivery produced no event for the message");
  return event;
}

/** A second WhatsApp business number for an EXISTING organization. */
export async function addAccount(db: Db, organizationId: string, pn: string, waba: string) {
  const [account] = await db
    .insert(schema.whatsappAccounts)
    .values({
      organizationId,
      wabaId: waba,
      phoneNumberId: pn,
      displayPhoneNumber: "15550100002",
      status: "ACTIVE",
    })
    .returning();
  return account!;
}

/** The real queue worker with the real MESSAGE handler (tests only; no production worker exists). */
export const process = (db: Db, extra: Partial<Parameters<typeof processWebhookBatch>[1]> = {}) =>
  processWebhookBatch(db, { handlers: inboundMessageHandlers, ...extra });

export const handlerContext = (): WebhookHandlerContext => ({
  attempt: 1,
  maxAttempts: 8,
  signal: new AbortController().signal,
  now: () => new Date(),
});

/** The handler called directly inside a transaction (no queue state involved). */
export const handleDirect = (db: Db, event: StoredEvent) =>
  db.transaction((tx) =>
    handleInboundMessage(
      tx,
      { ...event, eventType: event.eventType as WebhookEventKind },
      handlerContext(),
    ),
  );

export async function eventStatus(db: Db, id: string) {
  const [row] = await db
    .select({
      status: schema.webhookEvents.status,
      attempts: schema.webhookEvents.attempts,
      lastError: schema.webhookEvents.lastError,
    })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.id, id));
  return row!;
}
