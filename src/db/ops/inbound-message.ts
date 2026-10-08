import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { conversations, messageAttachments, messages } from "../schema";
import type { DbExecutor } from "./executor";

// Primitives for persisting ONE inbound message. Every statement is scoped by organization_id and runs in the caller's
// transaction. They are deliberately small and ordered so the caller can find out that a message is a duplicate BEFORE
// any activity timestamp, status or derived row is touched:
//   findMessageId -> getOrCreateConversation -> insertInboundMessage -> (only if inserted) advance / reopen /
//   attachments / reply links / attribution.

/** The id of an existing message with this provider id on this WhatsApp account, if any. */
export async function findMessageId(
  tx: DbExecutor,
  where: { organizationId: string; whatsappAccountId: string; wamid: string },
): Promise<string | null> {
  const [row] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, where.organizationId),
        eq(messages.whatsappAccountId, where.whatsappAccountId),
        eq(messages.wamid, where.wamid),
      ),
    );
  return row?.id ?? null;
}

/**
 * The conversation for (organization, account, contact), created when missing. Race-safe: the insert is
 * ON CONFLICT DO NOTHING and a lost race re-reads the winner's row. An EXISTING conversation is returned untouched (no
 * timestamp or status change): activity is advanced later, once the message is known to be new.
 */
export async function getOrCreateConversation(
  tx: DbExecutor,
  input: {
    organizationId: string;
    whatsappAccountId: string;
    contactId: string;
    /** Used only if the conversation is created now. */
    initialLastMessageAt: Date;
    initialLastInboundAt: Date | null;
  },
): Promise<{ id: string; created: boolean }> {
  const [inserted] = await tx
    .insert(conversations)
    .values({
      organizationId: input.organizationId,
      whatsappAccountId: input.whatsappAccountId,
      contactId: input.contactId,
      lastMessageAt: input.initialLastMessageAt,
      lastInboundAt: input.initialLastInboundAt,
    })
    .onConflictDoNothing({
      target: [
        conversations.organizationId,
        conversations.whatsappAccountId,
        conversations.contactId,
      ],
    })
    .returning({ id: conversations.id });
  if (inserted) return { id: inserted.id, created: true };
  const [existing] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, input.organizationId),
        eq(conversations.whatsappAccountId, input.whatsappAccountId),
        eq(conversations.contactId, input.contactId),
      ),
    );
  if (!existing) throw new Error("conversation_vanished"); // a conflict with no visible row: retried as transient
  return { id: existing.id, created: false };
}

export type InboundMessageInput = {
  organizationId: string;
  whatsappAccountId: string;
  conversationId: string;
  wamid: string;
  type: string;
  body: string | null;
  content: unknown;
  replyToWamid: string | null;
  replyToMessageId: string | null;
  occurredAt: Date;
  sourceWebhookEventId: string;
};

/** Inserts the message; null means a message with this wamid already exists (nothing was written). */
export async function insertInboundMessage(
  tx: DbExecutor,
  input: InboundMessageInput,
): Promise<string | null> {
  const [row] = await tx
    .insert(messages)
    .values({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      whatsappAccountId: input.whatsappAccountId,
      wamid: input.wamid,
      direction: "INBOUND",
      type: input.type,
      body: input.body,
      content: input.content,
      replyToWamid: input.replyToWamid,
      replyToMessageId: input.replyToMessageId,
      occurredAt: input.occurredAt,
      sourceWebhookEventId: input.sourceWebhookEventId,
    })
    .onConflictDoNothing({
      target: [messages.organizationId, messages.whatsappAccountId, messages.wamid],
      where: sql`${messages.wamid} IS NOT NULL`,
    })
    .returning({ id: messages.id });
  return row?.id ?? null;
}

/** Moves the conversation's activity forward only (GREATEST); an older message can never move it backwards. */
export async function advanceInboundActivity(
  tx: DbExecutor,
  where: { organizationId: string; conversationId: string; effectiveAt: Date },
): Promise<void> {
  const at = sql`${where.effectiveAt.toISOString()}::timestamptz`;
  await tx
    .update(conversations)
    .set({
      lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, ${at})`,
      lastInboundAt: sql`GREATEST(${conversations.lastInboundAt}, ${at})`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(conversations.organizationId, where.organizationId),
        eq(conversations.id, where.conversationId),
      ),
    );
}

/**
 * RESOLVED -> OPEN, only when the message is newer than resolved_at (so a delayed older message never reopens it). One
 * conditional statement, so concurrent messages cannot interleave a read and a write. Only status and resolved_at change.
 * Returns whether the conversation was reopened. A RESOLVED conversation without resolved_at is not reopened.
 */
export async function reopenIfNewer(
  tx: DbExecutor,
  where: { organizationId: string; conversationId: string; effectiveAt: Date },
): Promise<boolean> {
  const rows = await tx
    .update(conversations)
    .set({ status: "OPEN", resolvedAt: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(conversations.organizationId, where.organizationId),
        eq(conversations.id, where.conversationId),
        eq(conversations.status, "RESOLVED"),
        sql`${conversations.resolvedAt} < ${where.effectiveAt.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: conversations.id });
  return rows.length === 1;
}

/** Attachment metadata for provider media that has NOT been downloaded yet (storage_status PENDING by default). */
export async function insertPendingAttachment(
  tx: DbExecutor,
  input: {
    organizationId: string;
    messageId: string;
    metaMediaId: string;
    mimeType: string | null;
    filename: string | null;
    sha256: string | null;
  },
): Promise<void> {
  await tx
    .insert(messageAttachments)
    .values({ ...input, storageStatus: "PENDING" })
    .onConflictDoNothing({
      target: [messageAttachments.messageId, messageAttachments.metaMediaId],
    });
}

/** The message with this wamid in THIS conversation (the composite FK allows nothing else), or null. */
export async function findReplyParent(
  tx: DbExecutor,
  where: { organizationId: string; conversationId: string; wamid: string },
): Promise<string | null> {
  const [row] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, where.organizationId),
        eq(messages.conversationId, where.conversationId),
        eq(messages.wamid, where.wamid),
      ),
    );
  return row?.id ?? null;
}

/**
 * A message that just arrived may be the parent some earlier reply was waiting for. Links those replies, but only inside
 * this conversation and organization, never to itself, and never over an existing link.
 */
export async function backResolveReplies(
  tx: DbExecutor,
  where: { organizationId: string; conversationId: string; messageId: string; wamid: string },
): Promise<number> {
  const rows = await tx
    .update(messages)
    .set({ replyToMessageId: where.messageId })
    .where(
      and(
        eq(messages.organizationId, where.organizationId),
        eq(messages.conversationId, where.conversationId),
        eq(messages.replyToWamid, where.wamid),
        isNull(messages.replyToMessageId),
        ne(messages.id, where.messageId),
      ),
    )
    .returning({ id: messages.id });
  return rows.length;
}

export type AttributionInput = {
  organizationId: string;
  contactId: string;
  messageId: string;
  sourceType: "META_AD" | "REFERRAL";
  sourceId: string | null;
  sourceUrl: string | null;
  headline: string | null;
  body: string | null;
  mediaType: string | null;
  mediaUrl: string | null;
  ctwaClid: string | null;
  providerData: unknown;
  receivedAt: Date;
};

/**
 * One attribution touch for an inbound message. The table has no uniqueness on message_id, so the guarantee is made
 * here: it is written only by the call that inserted the message, and the insert itself refuses to repeat for a message
 * that already has one. It never creates a lead (lead_id stays NULL).
 */
export async function insertAttributionOnce(
  tx: DbExecutor,
  input: AttributionInput,
): Promise<boolean> {
  const providerData = input.providerData === null ? null : JSON.stringify(input.providerData);
  const result = await tx.execute<{ id: string }>(sql`
    INSERT INTO lead_attributions (
      organization_id, contact_id, lead_id, message_id, source_type, source_id, source_url, headline, body,
      media_type, media_url, ctwa_clid, provider_data, received_at
    )
    SELECT ${input.organizationId}::uuid, ${input.contactId}::uuid, NULL, ${input.messageId}::uuid,
           ${input.sourceType}::text, ${input.sourceId}::text, ${input.sourceUrl}::text, ${input.headline}::text,
           ${input.body}::text, ${input.mediaType}::text, ${input.mediaUrl}::text, ${input.ctwaClid}::text,
           ${providerData}::jsonb, ${input.receivedAt.toISOString()}::timestamptz
    WHERE NOT EXISTS (
      SELECT 1 FROM lead_attributions la
      WHERE la.organization_id = ${input.organizationId}::uuid AND la.message_id = ${input.messageId}::uuid
    )
    RETURNING id
  `);
  return result.rows.length === 1;
}
