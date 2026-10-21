import { logger, type LogContext } from "@/shared/logging/logger";

// Fixed-field structured logging for the bot runtime (Phase 08E-1; plan sections C.1 and M, V3.2 M "Logging"). ONLY the fields
// below are included. Identifiers are UUID-validated; reasons are format-checked, not checked against a trusted-code registry.
// Callers must supply approved fixed reason codes, never message text, tokens, reply ids, option keys, names, phone numbers or
// payloads. Invalid identifiers are dropped; malformed reasons become invalid_reason.

export type BotRuntimeLogEvent =
  | "bots.trigger_capped"
  | "bots.trigger_capture_failed"
  | "bots.trigger_dead"
  | "bots.trigger_overdue"
  | "bots.send_state_missing";

export type BotRuntimeLog = {
  readonly event: BotRuntimeLogEvent;
  readonly outcome: "success" | "denied" | "failure";
  readonly organizationId?: string;
  readonly whatsappAccountId?: string;
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly triggerId?: string;
  readonly sessionId?: string;
  readonly outboundRequestId?: string;
  /** Caller-supplied approved fixed code; validation checks format only, not registry membership. */
  readonly reason?: string;
  /** A count (for example pending triggers). */
  readonly count?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REASON = /^[a-z0-9_]{1,64}$/;

const id = (value: string | undefined): string | undefined =>
  value !== undefined && UUID.test(value) ? value : undefined;

/** The exact context of a log line: nothing outside this whitelist is ever included. */
export function botRuntimeLogContext(e: BotRuntimeLog): LogContext {
  return {
    bots_event: e.event,
    outcome: e.outcome,
    organization_id: id(e.organizationId),
    whatsapp_account_id: id(e.whatsappAccountId),
    conversation_id: id(e.conversationId),
    message_id: id(e.messageId),
    trigger_id: id(e.triggerId),
    session_id: id(e.sessionId),
    outbound_request_id: id(e.outboundRequestId),
    reason:
      e.reason === undefined ? undefined : REASON.test(e.reason) ? e.reason : "invalid_reason",
    count:
      e.count !== undefined && Number.isSafeInteger(e.count) && e.count >= 0 ? e.count : undefined,
  };
}

export function emitBotRuntimeLog(e: BotRuntimeLog): void {
  const context = botRuntimeLogContext(e);
  if (e.event === "bots.trigger_dead" || e.event === "bots.send_state_missing")
    logger.error(e.event, context);
  else if (e.outcome === "success") logger.info(e.event, context);
  else logger.warn(e.event, context);
}
