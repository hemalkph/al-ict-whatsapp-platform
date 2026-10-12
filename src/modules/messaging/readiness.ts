import { getDb, type Database } from "@/db";
import { assertCan, type AccessContext } from "@/modules/access";
import { NotFoundError } from "@/shared/errors/http-errors";
import { readOutboundConfig, type OutboundConfig } from "./config";
import { assess, loadAccount, loadConversationContext } from "./eligibility";
import { serviceWindow } from "./window";

// READ-ONLY and informational: it lets the inbox composer explain, before the user types, whether a free-form reply could
// be queued right now. It reuses the same policy functions the submission uses, writes nothing and queues nothing. It is
// NOT an authorization: POST /api/conversations/{id}/messages re-evaluates everything and stays the only authority.

export type ReplyReadiness = {
  /** Staff may queue outbound messages at all (WHATSAPP_OUTBOUND_ENABLED). False: nothing can be queued, nothing is sent. */
  readonly outboundEnabled: boolean;
  /** A free-form text reply would pass the eligibility policy at this moment. */
  readonly canQueueText: boolean;
  /** A fixed snake_case reason when it would not (outbound_disabled, window_closed, bsuid_send_unavailable, ...). */
  readonly reason: string | null;
  /** When the free-form window stops accepting replies (includes the safety margin); null if it is not open. */
  readonly windowClosesAt: Date | null;
};

export async function getReplyReadiness(
  ctx: AccessContext,
  conversationId: string,
  deps: { db?: Database; config?: OutboundConfig; now?: () => Date } = {},
): Promise<ReplyReadiness> {
  assertCan(ctx, "conversation.read");
  const config = deps.config ?? readOutboundConfig(process.env);
  const db = deps.db ?? getDb();
  const now = (deps.now ?? (() => new Date()))();
  const context = await loadConversationContext(db, ctx.organizationId, conversationId);
  if (!context) throw new NotFoundError();
  const window = serviceWindow(context.lastInboundAt, now);
  const windowClosesAt = window.open ? window.closesAt : null;
  if (!config.outboundEnabled)
    return {
      outboundEnabled: false,
      canQueueText: false,
      reason: "outbound_disabled",
      windowClosesAt,
    };
  const account = await loadAccount(db, ctx.organizationId, context.accountId, false);
  const decision = assess({
    account,
    context,
    message: { type: "text" },
    bsuidRecipientEnabled: config.bsuidRecipientEnabled,
    now,
  });
  return decision.ok
    ? { outboundEnabled: true, canQueueText: true, reason: null, windowClosesAt }
    : { outboundEnabled: true, canQueueText: false, reason: decision.code, windowClosesAt };
}
