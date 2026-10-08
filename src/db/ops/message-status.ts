import { and, eq, isNull, sql } from "drizzle-orm";
import { MESSAGE_STATUS_PRIORITY, type MESSAGE_STATUSES } from "../schema/enums";
import { messages, messageStatusEvents } from "../schema/messaging";
import type { DbExecutor } from "./executor";

type MessageStatus = (typeof MESSAGE_STATUSES)[number];

// Priority order: NULL(0) < SENT < FAILED < DELIVERED < READ. An event updates the cache only if
// its priority is strictly higher, so the cache equals the max-priority event regardless of arrival
// order, and re-applying an event is a no-op. message_status_events stays the authoritative history.
const priorityCase = (column: unknown) =>
  sql`(CASE ${column} ${sql.join(
    Object.entries(MESSAGE_STATUS_PRIORITY).map(
      ([status, p]) => sql`WHEN ${sql.raw(`'${status}'`)} THEN ${sql.raw(String(p))}`,
    ),
    sql` `,
  )} ELSE 0 END)`;

export type StatusEventInput = {
  organizationId: string;
  whatsappAccountId: string;
  wamid: string;
  status: MessageStatus;
  occurredAt: Date;
  errorCode?: string | null;
  errorMessage?: string | null;
  webhookEventId?: string | null;
};

async function applyToMessage(
  tx: DbExecutor,
  messageId: string,
  e: Pick<StatusEventInput, "status" | "occurredAt" | "errorCode" | "errorMessage">,
): Promise<boolean> {
  const failed = e.status === "FAILED";
  const updated = await tx
    .update(messages)
    .set({
      latestStatus: e.status,
      latestStatusAt: e.occurredAt,
      // error fields belong to the winning event; DELIVERED/READ superseding FAILED clears them
      errorCode: failed ? (e.errorCode ?? null) : null,
      errorMessage: failed ? (e.errorMessage ?? null) : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(messages.id, messageId),
        sql`${priorityCase(sql.raw("'" + e.status + "'"))} > ${priorityCase(messages.latestStatus)}`,
      ),
    )
    .returning({ id: messages.id });
  return updated.length > 0;
}

/**
 * Records a status event (idempotent) and updates messages.latest_status. Run inside a transaction.
 * If the message row does not exist yet the event is stored with message_id NULL and resolved later
 * by resolveStatusEventsForMessage().
 */
export async function recordMessageStatus(
  tx: DbExecutor,
  input: StatusEventInput,
): Promise<{
  duplicate: boolean;
  messageId: string | null;
  cacheUpdated: boolean;
  /** The wamid belongs to an INBOUND message: the event is kept (unlinked) but that message is never touched. */
  inboundMatch: boolean;
}> {
  const [message] = await tx
    .select({ id: messages.id, direction: messages.direction })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, input.organizationId),
        eq(messages.whatsappAccountId, input.whatsappAccountId),
        eq(messages.wamid, input.wamid),
      ),
    );
  // A status describes the delivery of a message WE sent. An inbound message with the same wamid is never linked to it
  // and its (absent) delivery status is never written.
  const inboundMatch = message !== undefined && message.direction !== "OUTBOUND";
  const messageId = message && !inboundMatch ? message.id : null;

  const inserted = await tx
    .insert(messageStatusEvents)
    .values({
      organizationId: input.organizationId,
      whatsappAccountId: input.whatsappAccountId,
      messageId,
      wamid: input.wamid,
      status: input.status,
      occurredAt: input.occurredAt,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      webhookEventId: input.webhookEventId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: messageStatusEvents.id });
  if (inserted.length === 0)
    return { duplicate: true, messageId, cacheUpdated: false, inboundMatch };

  const cacheUpdated = messageId ? await applyToMessage(tx, messageId, input) : false;
  return { duplicate: false, messageId, cacheUpdated, inboundMatch };
}

/**
 * Call after inserting an outbound message that has a wamid: attaches status events that arrived
 * first and applies the highest-priority one to the cache.
 */
export async function resolveStatusEventsForMessage(
  tx: DbExecutor,
  message: { id: string; organizationId: string; whatsappAccountId: string; wamid: string },
): Promise<void> {
  // Only a message we sent can carry delivery statuses.
  const [owner] = await tx
    .select({ direction: messages.direction })
    .from(messages)
    .where(and(eq(messages.organizationId, message.organizationId), eq(messages.id, message.id)));
  if (owner?.direction !== "OUTBOUND") return;
  await tx
    .update(messageStatusEvents)
    .set({ messageId: message.id })
    .where(
      and(
        eq(messageStatusEvents.organizationId, message.organizationId),
        eq(messageStatusEvents.whatsappAccountId, message.whatsappAccountId),
        eq(messageStatusEvents.wamid, message.wamid),
        isNull(messageStatusEvents.messageId),
      ),
    );
  const [best] = await tx
    .select()
    .from(messageStatusEvents)
    .where(eq(messageStatusEvents.messageId, message.id))
    .orderBy(
      sql`${priorityCase(messageStatusEvents.status)} DESC`,
      sql`${messageStatusEvents.occurredAt} DESC`,
    )
    .limit(1);
  if (best) await applyToMessage(tx, message.id, best);
}
