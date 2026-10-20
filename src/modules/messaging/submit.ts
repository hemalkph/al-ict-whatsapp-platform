import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema, type Database } from "@/db";
import { assertCan, can, type AccessContext } from "@/modules/access";
import { sha256Hex } from "@/modules/whatsapp/idempotency";
import { emitWebhookLog } from "@/modules/whatsapp/logging";
import { canonicalJson } from "@/shared/canonical-json";
import { ForbiddenError, NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import { readOutboundConfig, type OutboundConfig } from "./config";
import { assess, loadAccount, loadConversationContext, loadTemplate } from "./eligibility";
import { IdempotencyConflictError, OutboundRefusedError } from "./errors";
import { DISPATCH_DEADLINE_MS } from "./policy";
import { submitSchema, type SubmitInput } from "./schemas";

// The ONLY way staff create an outbound message. It authenticates nothing itself (the route builds the AccessContext from the
// Better Auth session and the ACTIVE membership); it re-checks that actor inside the transaction, derives the account,
// contact and recipient from the database, applies the eligibility policy, and persists the intent. It performs NO network
// request: dispatching is the outbound worker's job.

export type SubmitDeps = {
  readonly db?: Database;
  readonly config?: OutboundConfig;
  readonly now?: () => Date;
};

export type SubmitResult = {
  readonly requestId: string;
  readonly messageId: string;
  readonly state: string;
  /** True when this was a replay of an earlier identical request (nothing new was created). */
  readonly replayed: boolean;
};

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const fieldsOf = (issues: ReadonlyArray<{ path: PropertyKey[] }>) => [
  ...new Set(issues.map((i) => String(i.path[0] ?? "body"))),
];

/** The actor may be stale (suspended or demoted after the context was built): re-check inside the transaction. */
async function revalidateActor(tx: Tx, ctx: AccessContext) {
  const [actor] = await tx
    .select({
      role: schema.organizationMemberships.role,
      status: schema.organizationMemberships.status,
    })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.id, ctx.membershipId),
        eq(schema.organizationMemberships.organizationId, ctx.organizationId),
        eq(schema.organizationMemberships.userId, ctx.userId),
      ),
    );
  if (!actor || actor.status !== "ACTIVE" || !can(actor.role, "conversation.reply"))
    throw new ForbiddenError("stale_actor");
}

/** What identifies "the same request": everything the sender chose. The resolved recipient is derived, so it is not part of it. */
export function fingerprintOf(input: SubmitInput): string {
  const m = input.message;
  return sha256Hex(
    canonicalJson({
      v: 1,
      conversationId: input.conversationId,
      message:
        m.type === "text"
          ? { type: "text", body: m.body, replyToMessageId: m.replyToMessageId ?? null }
          : { type: "template", templateId: m.templateId, parameters: m.parameters },
    }),
  );
}

export async function submitOutboundMessage(
  ctx: AccessContext,
  rawInput: unknown,
  deps: SubmitDeps = {},
): Promise<SubmitResult> {
  assertCan(ctx, "conversation.reply");
  const config = deps.config ?? readOutboundConfig(process.env);
  if (!config.outboundEnabled) throw new OutboundRefusedError("outbound_disabled");
  const parsed = submitSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(fieldsOf(parsed.error.issues));
  const input = parsed.data;
  const fingerprint = fingerprintOf(input);
  const db = deps.db ?? getDb();
  const now = (deps.now ?? (() => new Date()))();

  return db.transaction(async (tx) => {
    await revalidateActor(tx, ctx);
    // Another organization's (or a missing) conversation is the same 404: existence is never revealed.
    const context = await loadConversationContext(tx, ctx.organizationId, input.conversationId);
    if (!context) throw new NotFoundError();

    // Lock order (Phase 08D, V3.2 J.1 / L.2): the conversation row FIRST, before the idempotency lock and before any insert.
    // The request insert allocates the conversation's control_seq (a database trigger updates this row). Taking the row lock
    // here keeps the conversation-first order every other writer uses (Inbox workflow, Stop, bot step) and makes the allocation
    // update a row this transaction already holds, so no row lock is strengthened mid-transaction; staff submissions to one
    // conversation are serialized here, and control_seq follows their commit order. The replay path below takes the same
    // lock, so it is ordered identically.
    await tx
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.organizationId, ctx.organizationId),
          eq(schema.conversations.id, input.conversationId),
        ),
      )
      .for("update");

    // One logical operation per (organization, account, requester, key): concurrent submissions queue up here, and the
    // unique constraint behind it is the backstop.
    const scope = `${ctx.organizationId}:${context.accountId}:${ctx.membershipId}:${input.idempotencyKey}`;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`wa-outbound-idem:${scope}`}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(schema.outboundRequests)
      .where(
        and(
          eq(schema.outboundRequests.organizationId, ctx.organizationId),
          eq(schema.outboundRequests.whatsappAccountId, context.accountId),
          eq(schema.outboundRequests.requestedByMembershipId, ctx.membershipId),
          eq(schema.outboundRequests.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) throw new IdempotencyConflictError();
      return {
        requestId: existing.id,
        messageId: existing.messageId,
        state: existing.state,
        replayed: true,
      };
    }

    const account = await loadAccount(tx, ctx.organizationId, context.accountId, true);
    const m = input.message;
    const template =
      m.type === "template"
        ? await loadTemplate(tx, ctx.organizationId, context.accountId, m.templateId)
        : null;
    const assessment = assess({
      account,
      context,
      message:
        m.type === "text"
          ? { type: "text" }
          : { type: "template", template, parameterCount: m.parameters.length },
      bsuidRecipientEnabled: config.bsuidRecipientEnabled,
      now,
    });
    if (!assessment.ok) throw new OutboundRefusedError(assessment.code);

    let replyToWamid: string | null = null;
    if (m.type === "text" && m.replyToMessageId) {
      const [parent] = await tx
        .select({ wamid: schema.messages.wamid })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.organizationId, ctx.organizationId),
            eq(schema.messages.conversationId, input.conversationId),
            eq(schema.messages.id, m.replyToMessageId),
          ),
        );
      if (!parent?.wamid) throw new OutboundRefusedError("reply_target_unavailable");
      replyToWamid = parent.wamid;
    }

    const requestId = randomUUID();
    const [message] = await tx
      .insert(schema.messages)
      .values({
        organizationId: ctx.organizationId,
        conversationId: input.conversationId,
        whatsappAccountId: context.accountId,
        wamid: null, // Meta's id is recorded only when Meta accepts the send
        direction: "OUTBOUND",
        type: m.type === "text" ? "TEXT" : "TEMPLATE",
        body: m.type === "text" ? m.body : null,
        content:
          m.type === "text"
            ? null
            : {
                template: {
                  id: template!.id,
                  name: template!.name,
                  languageCode: template!.languageCode,
                  category: template!.category,
                },
                parameters: m.parameters,
              },
        replyToMessageId: m.type === "text" ? (m.replyToMessageId ?? null) : null,
        replyToWamid,
        occurredAt: now,
        clientRequestId: requestId,
      })
      .returning({ id: schema.messages.id });
    await tx.insert(schema.outboundRequests).values({
      id: requestId,
      organizationId: ctx.organizationId,
      whatsappAccountId: context.accountId,
      conversationId: input.conversationId,
      messageId: message!.id,
      requestedByMembershipId: ctx.membershipId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      messageType: m.type === "text" ? "TEXT" : "TEMPLATE",
      templateId: template?.id ?? null,
      recipientKind: assessment.recipient.kind,
      recipientId: assessment.recipient.id,
      payload: m.type === "text" ? { body: m.body, replyToWamid } : { parameters: m.parameters },
      state: "QUEUED",
      nextAttemptAt: now,
      dispatchDeadline: new Date(now.getTime() + DISPATCH_DEADLINE_MS),
    });
    emitWebhookLog({
      event: "outbound.created",
      outcome: "success",
      organizationId: ctx.organizationId,
      whatsappAccountId: context.accountId,
      outboundRequestId: requestId,
      eventType: m.type === "text" ? "TEXT" : "TEMPLATE",
    });
    return { requestId, messageId: message!.id, state: "QUEUED", replayed: false };
  });
}

export type OutboundRequestView = {
  readonly requestId: string;
  readonly messageId: string;
  readonly conversationId: string;
  readonly type: "TEXT" | "TEMPLATE" | "INTERACTIVE";
  readonly state: string;
  readonly holdReason: string | null;
  readonly failureCode: string | null;
  readonly attemptCount: number;
  readonly createdAt: Date;
  readonly acceptedAt: Date | null;
  readonly finishedAt: Date | null;
  /** Meta's message id once accepted (acceptance, not delivery). */
  readonly wamid: string | null;
  readonly deliveryStatus: string | null;
};

/** Status of one request, inside the caller's organization only. Never returns the recipient, the body or provider payloads. */
export async function getOutboundRequest(
  ctx: AccessContext,
  requestId: string,
  deps: Pick<SubmitDeps, "db"> = {},
): Promise<OutboundRequestView> {
  assertCan(ctx, "conversation.read");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))
    throw new NotFoundError();
  const db = deps.db ?? getDb();
  const [row] = await db
    .select({
      r: schema.outboundRequests,
      wamid: schema.messages.wamid,
      latest: schema.messages.latestStatus,
    })
    .from(schema.outboundRequests)
    .innerJoin(
      schema.messages,
      and(
        eq(schema.messages.organizationId, schema.outboundRequests.organizationId),
        eq(schema.messages.id, schema.outboundRequests.messageId),
      ),
    )
    .where(
      and(
        eq(schema.outboundRequests.organizationId, ctx.organizationId),
        eq(schema.outboundRequests.id, requestId),
      ),
    );
  if (!row) throw new NotFoundError();
  return {
    requestId: row.r.id,
    messageId: row.r.messageId,
    conversationId: row.r.conversationId,
    type: row.r.messageType,
    state: row.r.state,
    holdReason: row.r.holdReason,
    failureCode: row.r.failureCode,
    attemptCount: row.r.attemptCount,
    createdAt: row.r.createdAt,
    acceptedAt: row.r.acceptedAt,
    finishedAt: row.r.finishedAt,
    wamid: row.wamid,
    deliveryStatus: row.latest,
  };
}
