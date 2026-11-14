import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema, type DbExecutor } from "@/db";
import { sha256Hex } from "@/modules/whatsapp/idempotency";
import { emitWebhookLog } from "@/modules/whatsapp/logging";
import { canonicalJson } from "@/shared/canonical-json";
import type { OutboundConfig } from "./config";
import { assess, loadAccount, loadConversationContext } from "./eligibility";
import { IdempotencyConflictError, OutboundRefusedError } from "./errors";
import { botSendContent, type BotOutboundMessage } from "./interactive";
import { BOT_DISPATCH_DEADLINE_MS } from "./policy";

// The ONLY way an origin-BOT outbound request is created (Phase 08D, ADR 0020; V3.2 I.2, I.3). It is called by the bot
// runtime's step transaction (Phase 08E) and by tests. Phase 08D ships NO production caller (a static test pins that only test
// files import it), and it refuses while BOTS_RUNTIME_ENABLED is off.
//
// The caller passes ITS transaction and must already hold the step locks of V3.2 L.2, in order: deployment FOR SHARE,
// conversation FOR UPDATE, session FOR UPDATE, account FOR SHARE (this function takes the account again FOR SHARE, which is
// harmless when already held). Under those locks it re-derives and re-verifies everything from the database (never from the
// authority's word alone): the session is live, unsuppressed and bound to this conversation, account, deployment and version;
// the deployment is ACTIVE or PAUSED with the authority's send epoch; the bot is not archived; no staff control event is
// sequenced after the session start; and the ordinary outbound policy (account, contact, window, recipient). It performs no
// network I/O. The insert allocates the request's control_seq (database trigger) and the in-flight indexes are the backstop for
// "one BOT request in flight per session and per conversation".

export type AutomationAuthority = {
  readonly kind: "BOT";
  readonly organizationId: string;
  readonly botSessionId: string;
  readonly deploymentId: string;
  readonly botVersionId: string;
  readonly whatsappAccountId: string;
  readonly conversationId: string;
  readonly contactId: string;
  /** The deployment's send_epoch read by the runtime under the deployment FOR SHARE lock. */
  readonly sendEpoch: number;
};

export type AutomatedMessageInput = {
  /** The step that produced the message: the request's bot_step_seq (>= 1). */
  readonly stepSeq: number;
  readonly message: BotOutboundMessage;
};

export type EnqueueDeps = {
  readonly config: OutboundConfig;
  readonly now?: () => Date;
};

export type EnqueueResult = {
  readonly requestId: string;
  readonly messageId: string;
  /** True when this step's request already existed with the same content (nothing new was created). */
  readonly replayed: boolean;
};

const LIVE = new Set(["ACTIVE", "WAITING_FOR_SEND", "WAITING_FOR_INPUT"]);

export async function enqueueAutomatedMessage(
  tx: DbExecutor,
  authority: AutomationAuthority,
  input: AutomatedMessageInput,
  deps: EnqueueDeps,
): Promise<EnqueueResult> {
  if (authority.kind !== "BOT") throw new OutboundRefusedError("bot_state_unreadable");
  if (!deps.config.outboundEnabled) throw new OutboundRefusedError("outbound_disabled");
  if (!deps.config.botsRuntimeEnabled) throw new OutboundRefusedError("bots_runtime_disabled");
  if (!Number.isSafeInteger(input.stepSeq) || input.stepSeq < 1)
    throw new OutboundRefusedError("bot_step_superseded");
  const content = botSendContent(input.message);
  if (content === null) throw new OutboundRefusedError("payload_invalid");
  const org = authority.organizationId;

  // The session, its deployment and bot, re-read under the caller's locks.
  const state = await tx.execute<{
    session_state: string;
    output_suppressed_at: Date | null;
    started_control_seq: string;
    deployment_status: string;
    send_epoch: string;
    bot_archived_at: Date | null;
    staff_after_start: boolean;
    resolved_after_start: boolean;
  }>(sql`
    SELECT s.state AS session_state, s.output_suppressed_at, s.started_control_seq,
           d.status AS deployment_status, d.send_epoch, b.archived_at AS bot_archived_at,
           (EXISTS (SELECT 1 FROM conversation_events e
                     WHERE e.organization_id = s.organization_id AND e.conversation_id = s.conversation_id
                       AND e.control_seq > s.started_control_seq)
            OR EXISTS (SELECT 1 FROM outbound_requests x
                        WHERE x.organization_id = s.organization_id AND x.conversation_id = s.conversation_id
                          AND x.origin = 'STAFF' AND x.control_seq > s.started_control_seq)) AS staff_after_start,
           EXISTS (SELECT 1 FROM conversation_events e
                    WHERE e.organization_id = s.organization_id AND e.conversation_id = s.conversation_id
                      AND e.kind = 'STATUS' AND e.to_status = 'RESOLVED'
                      AND e.control_seq > s.started_control_seq) AS resolved_after_start
      FROM bot_sessions s
      JOIN bot_deployments d ON d.organization_id = s.organization_id AND d.id = s.deployment_id
      JOIN bots b ON b.organization_id = s.organization_id AND b.id = s.bot_id
     WHERE s.organization_id = ${org} AND s.id = ${authority.botSessionId}
       AND s.conversation_id = ${authority.conversationId}
       AND s.whatsapp_account_id = ${authority.whatsappAccountId}
       AND s.contact_id = ${authority.contactId}
       AND s.deployment_id = ${authority.deploymentId}
       AND s.bot_version_id = ${authority.botVersionId}`);
  const s = state.rows[0];
  if (!s) throw new OutboundRefusedError("bot_state_unreadable");
  if (s.deployment_status === "RETIRED") throw new OutboundRefusedError("bot_deployment_inactive");
  if (s.deployment_status === "STOPPED") throw new OutboundRefusedError("bot_stopped");
  if (Number(s.send_epoch) !== authority.sendEpoch)
    throw new OutboundRefusedError("bot_epoch_superseded");
  if (s.bot_archived_at !== null) throw new OutboundRefusedError("bot_archived");
  if (s.output_suppressed_at !== null) throw new OutboundRefusedError("bot_output_suppressed");
  if (!LIVE.has(s.session_state)) throw new OutboundRefusedError("bot_session_ended");
  if (s.resolved_after_start) throw new OutboundRefusedError("conversation_resolved");
  if (s.staff_after_start) throw new OutboundRefusedError("staff_took_over");

  // Idempotency: one request per (session, step). Concurrent callers for the same step queue on this lock (a namespace of its
  // own, distinct from staff keys); the unique step index is the backstop.
  const idempotencyKey = `bot-${authority.botSessionId}-${input.stepSeq}`;
  const fingerprint = sha256Hex(
    canonicalJson({
      v: 1,
      botSessionId: authority.botSessionId,
      stepSeq: input.stepSeq,
      content,
    }),
  );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`wa-outbound-bot:${org}:${idempotencyKey}`}, 0))`,
  );
  const [existing] = await tx
    .select({
      id: schema.outboundRequests.id,
      messageId: schema.outboundRequests.messageId,
      fingerprint: schema.outboundRequests.requestFingerprint,
    })
    .from(schema.outboundRequests)
    .where(
      and(
        eq(schema.outboundRequests.organizationId, org),
        eq(schema.outboundRequests.origin, "BOT"),
        eq(schema.outboundRequests.botSessionId, authority.botSessionId),
        eq(schema.outboundRequests.botStepSeq, input.stepSeq),
      ),
    );
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new IdempotencyConflictError();
    return { requestId: existing.id, messageId: existing.messageId, replayed: true };
  }

  // The ordinary outbound policy, with the identity re-derived from the trusted records.
  const now = (deps.now ?? (() => new Date()))();
  const context = await loadConversationContext(tx, org, authority.conversationId);
  if (
    !context ||
    context.accountId !== authority.whatsappAccountId ||
    context.contactId !== authority.contactId
  )
    throw new OutboundRefusedError("bot_state_unreadable");
  const account = await loadAccount(tx, org, authority.whatsappAccountId, true);
  const assessment = assess({
    account,
    context,
    message: content.type === "text" ? { type: "text" } : { type: "interactive" },
    bsuidRecipientEnabled: deps.config.bsuidRecipientEnabled,
    now,
  });
  if (!assessment.ok) throw new OutboundRefusedError(assessment.code);

  const requestId = randomUUID();
  const [message] = await tx
    .insert(schema.messages)
    .values({
      organizationId: org,
      conversationId: authority.conversationId,
      whatsappAccountId: authority.whatsappAccountId,
      wamid: null, // Meta's id is recorded only when Meta accepts the send
      direction: "OUTBOUND",
      type: content.type === "text" ? "TEXT" : "INTERACTIVE",
      body: content.type === "text" ? content.body : content.payload.body,
      content: content.type === "text" ? null : { interactive: content.payload },
      occurredAt: now,
      clientRequestId: requestId,
    })
    .returning({ id: schema.messages.id });
  await tx.insert(schema.outboundRequests).values({
    id: requestId,
    organizationId: org,
    whatsappAccountId: authority.whatsappAccountId,
    conversationId: authority.conversationId,
    messageId: message!.id,
    origin: "BOT",
    requestedByMembershipId: null,
    botSessionId: authority.botSessionId,
    botStepSeq: input.stepSeq,
    botSendEpoch: authority.sendEpoch,
    idempotencyKey,
    requestFingerprint: fingerprint,
    messageType: content.type === "text" ? "TEXT" : "INTERACTIVE",
    templateId: null,
    recipientKind: assessment.recipient.kind,
    recipientId: assessment.recipient.id,
    payload: content.type === "text" ? { body: content.body, replyToWamid: null } : content.payload,
    state: "QUEUED",
    nextAttemptAt: now,
    dispatchDeadline: new Date(now.getTime() + BOT_DISPATCH_DEADLINE_MS),
  });
  emitWebhookLog({
    event: "outbound.created",
    outcome: "success",
    organizationId: org,
    whatsappAccountId: authority.whatsappAccountId,
    outboundRequestId: requestId,
    eventType: content.type === "text" ? "TEXT" : "INTERACTIVE",
  });
  return { requestId, messageId: message!.id, replayed: false };
}
