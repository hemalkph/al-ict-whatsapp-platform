import { and, eq, sql } from "drizzle-orm";
import { schema } from "@/db";
import {
  advanceInboundActivity,
  backResolveReplies,
  findMessageId,
  findReplyParent,
  getOrCreateConversation,
  insertAttributionOnce,
  insertInboundMessage,
  insertPendingAttachment,
  reopenIfNewer,
} from "@/db/ops/inbound-message";
import { resolveInboundContact } from "../identity";
import { isRecord } from "../parse";
import { PermanentWebhookError } from "../queue/errors";
import { emitWebhookLog } from "../logging";
import type { WebhookHandler, WebhookHandlerRegistry } from "../queue/process";
import { FUTURE_SKEW_MS, effectiveActivityTime } from "../time";
import { mapInboundMessage } from "./message-map";

// The inbound MESSAGE handler. It runs INSIDE the queue worker's transaction (the same one that performs the fenced
// PROCESSED update), writes through `tx` only, and never decides the event's final status: it returns, or it throws.
// It makes no HTTP request, sends nothing, starts no bot and downloads no media.
//
//   map + validate  ->  account ready?  ->  lock this logical message  ->  already stored? (then it does NOTHING)
//   ->  [savepoint] resolve contact -> conversation -> message -> activity / reopen -> attachment -> reply links -> referral
//
// Duplicate safety. The advisory lock on (organization, account, wamid) serializes two workers handling the same
// message, and the existence check runs BEFORE any write, so a duplicate creates no contact, conversation, activity
// change, reopen, attachment, link or attribution. If the message insert nevertheless reports a conflict (a writer that
// does not take the lock), the savepoint rolls every provisional write back and the event completes as a duplicate.
//
// Not done here, on purpose: status handling, identity changes, outbound messages, Meta calls, media download, leads,
// students or marketing consent. A referral is attribution evidence, never an opt-in.

class DuplicateMessage extends Error {
  constructor() {
    super("duplicate_message");
  }
}

const STALE_MS = 8 * 24 * 60 * 60 * 1000;

export const handleInboundMessage: WebhookHandler = async (tx, event) => {
  // A sender / reply / media identifier that the ingest-time cleaning had to alter (a NUL or lone surrogate) is no longer
  // the identifier the provider sent, and might equal another contact's. Nothing is resolved or written from it.
  if (isRecord(event.payload) && event.payload.identifierIntegrity === "altered")
    throw new PermanentWebhookError("invalid_provider_identifier");
  const message = mapInboundMessage(event.payload);
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

  const effectiveAt = effectiveActivityTime(message.occurredAt, event.receivedAt);
  const providerSkew = message.occurredAt.getTime() - event.receivedAt.getTime();
  if (providerSkew > FUTURE_SKEW_MS || -providerSkew > STALE_MS) {
    emitWebhookLog({
      event: "webhook.timestamp_anomaly",
      outcome: "denied",
      webhookEventId: event.id,
      organizationId: org,
      whatsappAccountId: accountId,
      eventType: "MESSAGE",
      reason: providerSkew > 0 ? "timestamp_future" : "timestamp_stale",
    });
  }

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`wa-message:${org}:${accountId}:${message.wamid}`}, 0))`,
  );
  const duplicate = () =>
    emitWebhookLog({
      event: "webhook.message_duplicate",
      outcome: "success",
      webhookEventId: event.id,
      organizationId: org,
      whatsappAccountId: accountId,
      eventType: "MESSAGE",
    });
  if (
    await findMessageId(tx, {
      organizationId: org,
      whatsappAccountId: accountId,
      wamid: message.wamid,
    })
  ) {
    duplicate();
    return;
  }

  const isReaction = message.type === "REACTION";
  try {
    // A savepoint inside the worker's transaction (never a separate one): a late duplicate undoes the provisional writes.
    await tx.transaction(async (sp) => {
      const contact = await resolveInboundContact(sp, event, { observedAt: message.occurredAt });
      const conversation = await getOrCreateConversation(sp, {
        organizationId: org,
        whatsappAccountId: accountId,
        contactId: contact.contactId,
        initialLastMessageAt: effectiveAt,
        // a reaction is recorded but is not customer activity (whether it opens the service window is unresolved, G0)
        initialLastInboundAt: isReaction ? null : effectiveAt,
      });

      const parentId = message.replyToWamid
        ? await findReplyParent(sp, {
            organizationId: org,
            conversationId: conversation.id,
            wamid: message.replyToWamid,
          })
        : null;
      const messageId = await insertInboundMessage(sp, {
        organizationId: org,
        whatsappAccountId: accountId,
        conversationId: conversation.id,
        wamid: message.wamid,
        type: message.type,
        body: message.body,
        content: message.content,
        replyToWamid: message.replyToWamid,
        replyToMessageId: parentId,
        occurredAt: message.occurredAt,
        sourceWebhookEventId: event.id,
      });
      if (!messageId) throw new DuplicateMessage();

      // Only now, with a NEW message in hand, may derived conversation state change.
      if (!isReaction && !conversation.created) {
        await advanceInboundActivity(sp, {
          organizationId: org,
          conversationId: conversation.id,
          effectiveAt,
        });
        await reopenIfNewer(sp, {
          organizationId: org,
          conversationId: conversation.id,
          effectiveAt,
        });
      }
      if (message.media) {
        await insertPendingAttachment(sp, { organizationId: org, messageId, ...message.media });
      }
      await backResolveReplies(sp, {
        organizationId: org,
        conversationId: conversation.id,
        messageId,
        wamid: message.wamid,
      });
      if (message.referral) {
        await insertAttributionOnce(sp, {
          organizationId: org,
          contactId: contact.contactId,
          messageId,
          receivedAt: event.receivedAt,
          ...message.referral,
        });
      }
    });
  } catch (error) {
    if (error instanceof DuplicateMessage) {
      duplicate();
      return;
    }
    throw error;
  }
};

/**
 * The handler registry for the MESSAGE event type alone (tests compose it with others). Production uses the fixed MESSAGE +
 * STATUS registry of the worker module, run only by the opt-in `npm run whatsapp:worker` (disabled unless
 * WHATSAPP_WORKER_ENABLED=true; nothing in the web application starts it). IDENTITY and OTHER events have no handler and
 * stay unclaimed.
 */
export const inboundMessageHandlers: WebhookHandlerRegistry = { MESSAGE: handleInboundMessage };
