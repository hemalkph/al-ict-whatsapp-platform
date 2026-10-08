import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@/db";
import type { TestDb } from "@/db/__tests__/helpers";
import { inboundMessageHandlers } from "../inbound/handler";
import { processWebhookBatch, type WebhookEventKind } from "../queue/process";
import { PN, WABA, ingestBytes, type StoredEvent } from "../identity/testing";
import { handlerContext } from "../inbound/testing";
import { handleMessageStatus, statusHandlers } from "./handler";

export { PN, WABA, ingestBytes, ingestFixture, minutesAgo, tenant } from "../identity/testing";
export { addAccount, epoch, eventStatus } from "../inbound/testing";
export type { StoredEvent } from "../identity/testing";

// TEST-ONLY helpers (excluded from the boundary scans). Statuses are produced by the REAL ingest path and run by the REAL
// queue worker. Outbound/inbound message rows are inserted directly because the outbound writer does not exist yet.

type Db = TestDb["db"];
let n = 0;
const uniq = () => `${(n++).toString(36)}${randomBytes(2).toString("hex")}`;

export type StatusDelivery = {
  pn?: string;
  waba?: string;
  id: string;
  status: string;
  /** Epoch seconds as Meta sends them (any raw value, to test invalid input). */
  timestamp: string | number;
  recipient?: string;
  /** Extra properties of the status object (errors, pricing, ...). */
  extra?: Record<string, unknown>;
};

export function statusBytes(o: StatusDelivery): Buffer {
  const status: Record<string, unknown> = { id: o.id, status: o.status, timestamp: o.timestamp };
  if (o.recipient !== undefined) status.recipient_id = o.recipient;
  Object.assign(status, o.extra ?? {});
  return Buffer.from(
    JSON.stringify({
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
                statuses: [status],
              },
            },
          ],
        },
      ],
    }),
  );
}

/** One status notification through the real ingest path; returns the stored (routed, PENDING) STATUS event. */
export async function deliverStatus(db: Db, o: StatusDelivery): Promise<StoredEvent> {
  const events = await ingestBytes(db, statusBytes(o));
  const event = events.find((e) => e.eventType === "STATUS");
  if (!event) throw new Error("the delivery produced no STATUS event");
  return event;
}

/** A message row (with its own contact and conversation) so statuses have something to attach to. */
export async function seedMessage(
  db: Db,
  o: {
    organizationId: string;
    whatsappAccountId: string;
    wamid: string;
    direction?: "OUTBOUND" | "INBOUND";
    occurredAt?: Date;
  },
) {
  const at = o.occurredAt ?? new Date(Date.now() - 3_600_000);
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: o.organizationId,
      waId: `wa-${uniq()}`,
      firstSeenAt: at,
      lastSeenAt: at,
    })
    .returning();
  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      organizationId: o.organizationId,
      whatsappAccountId: o.whatsappAccountId,
      contactId: contact!.id,
      lastMessageAt: at,
      lastInboundAt: o.direction === "INBOUND" ? at : null,
      lastOutboundAt: o.direction === "INBOUND" ? null : at,
    })
    .returning();
  const [message] = await db
    .insert(schema.messages)
    .values({
      organizationId: o.organizationId,
      conversationId: conversation!.id,
      whatsappAccountId: o.whatsappAccountId,
      wamid: o.wamid,
      direction: o.direction ?? "OUTBOUND",
      type: "TEXT",
      body: "hello",
      occurredAt: at,
    })
    .returning();
  return { contact: contact!, conversation: conversation!, message: message! };
}

/** The real queue worker with the real MESSAGE and STATUS handlers (tests only; no production worker exists). */
export const processBoth = (
  db: Db,
  extra: Partial<Parameters<typeof processWebhookBatch>[1]> = {},
) =>
  processWebhookBatch(db, { handlers: { ...inboundMessageHandlers, ...statusHandlers }, ...extra });
export const processStatuses = (
  db: Db,
  extra: Partial<Parameters<typeof processWebhookBatch>[1]> = {},
) => processWebhookBatch(db, { handlers: statusHandlers, ...extra });

/** The status handler called directly inside a transaction (no queue state involved). */
export const handleStatusDirect = (db: Db, event: StoredEvent) =>
  db.transaction((tx) =>
    handleMessageStatus(
      tx,
      { ...event, eventType: event.eventType as WebhookEventKind },
      handlerContext(),
    ),
  );

export async function historyOf(db: Db, wamid: string) {
  return db
    .select()
    .from(schema.messageStatusEvents)
    .where(eq(schema.messageStatusEvents.wamid, wamid))
    .orderBy(schema.messageStatusEvents.occurredAt, schema.messageStatusEvents.status);
}
