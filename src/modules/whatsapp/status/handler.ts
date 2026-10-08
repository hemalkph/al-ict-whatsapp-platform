import { and, eq, sql } from "drizzle-orm";
import { schema } from "@/db";
import { recordMessageStatus } from "@/db/ops/message-status";
import { emitWebhookLog } from "../logging";
import type { WebhookHandler, WebhookHandlerRegistry } from "../queue/process";
import { FUTURE_SKEW_MS } from "../time";
import { mapStatusEvent } from "./status-map";

// The STATUS handler. It runs INSIDE the queue worker's transaction (the same one that performs the fenced PROCESSED
// update), writes through `tx` only, and never decides the event's final state: it returns, or it throws. It reuses the
// Phase 02 operation `recordMessageStatus`, which keeps the append-only history in message_status_events and a priority-based
// cache on the message, so out-of-order and duplicate observations converge. It makes no HTTP request.
//
// What it deliberately does NOT do: create or touch a contact, a conversation, a lead, consent or an outbound message;
// match a status by recipient; change last_message_at / last_inbound_at (a delivery receipt is not customer activity and
// must never extend the customer-service window, which reads conversations.last_inbound_at); or fail a status because its
// message has not been stored yet (the event is kept with message_id NULL and reconciled when the message is created).
//
// Contract with the future outbound writer: it must take the same per-message advisory lock
// ("wa-message:{organization}:{account}:{wamid}") before inserting an outbound message, and then call
// resolveStatusEventsForMessage. The lock below is what makes "status arrives while the message is being created" safe.

const STALE_MS = 8 * 24 * 60 * 60 * 1000;

export const handleMessageStatus: WebhookHandler = async (tx, event) => {
  const status = mapStatusEvent(event.payload);
  const org = event.organizationId;
  const accountId = event.whatsappAccountId;

  // The queue rechecked the account just before calling us; this closes the small gap and proves org/account agree.
  const [account] = await tx
    .select({
      status: schema.whatsappAccounts.status,
      archivedAt: schema.whatsappAccounts.archivedAt,
    })
    .from(schema.whatsappAccounts)
    .where(
      and(
        eq(schema.whatsappAccounts.id, accountId),
        eq(schema.whatsappAccounts.organizationId, org),
      ),
    );
  if (!account || account.status !== "ACTIVE" || account.archivedAt !== null)
    throw new Error("account_not_active"); // transient: the next claim's account check holds or ignores the event

  const skew = status.occurredAt.getTime() - event.receivedAt.getTime();
  if (skew > FUTURE_SKEW_MS || -skew > STALE_MS) {
    emitWebhookLog({
      event: "webhook.timestamp_anomaly",
      outcome: "denied",
      webhookEventId: event.id,
      organizationId: org,
      whatsappAccountId: accountId,
      eventType: "STATUS",
      reason: skew > 0 ? "timestamp_future" : "timestamp_stale",
    });
  }

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`wa-message:${org}:${accountId}:${status.wamid}`}, 0))`,
  );
  const result = await recordMessageStatus(tx, {
    organizationId: org,
    whatsappAccountId: accountId,
    wamid: status.wamid,
    status: status.status,
    occurredAt: status.occurredAt,
    errorCode: status.errorCode,
    errorMessage: status.errorMessage,
    webhookEventId: event.id,
  });

  const note = (reason: string) =>
    emitWebhookLog({
      event: "webhook.status_observation",
      outcome: "success",
      webhookEventId: event.id,
      organizationId: org,
      whatsappAccountId: accountId,
      eventType: "STATUS",
      reason,
    });
  if (result.inboundMatch)
    note("inbound_message_wamid"); // kept in the history, never applied to the inbound message
  else if (result.duplicate) note("duplicate");
  else if (result.messageId === null) note("awaiting_message"); // stored; reconciled when the message row appears
};

/**
 * The handler registry for the STATUS event type. NOT wired into any production path: nothing starts a worker. Tests and
 * explicit non-production invocations combine it with the MESSAGE registry and pass it to processWebhookBatch({ handlers }).
 */
export const statusHandlers: WebhookHandlerRegistry = { STATUS: handleMessageStatus };
