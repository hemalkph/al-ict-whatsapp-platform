import { sql, type SQL } from "drizzle-orm";
import {
  HANDOVER_REASON_CODES,
  SYSTEM_HANDOVER_REASONS,
  type HandoverReasonCode,
} from "@/modules/bots";
import type { BotIndicator, BotNoticeOutcome, BotSessionStatus } from "./types";

// The read-only bot indicator (Phase 08F-2; V3.2 J.4, I.5, X6, X13; owner decisions D-2 and D-3). It reads the LATEST bot session
// of a conversation, by (started_at DESC, id DESC) on bot_sessions_conversation_idx, and its terminal notice's request state.
// Lifecycle columns only: the SELECT below names every column, so session variables, awaiting/consumed tokens, input ids and
// message text can never reach a response. Callers add it only for a caller holding bot.read; nothing here authorizes.

/** Unresolved is "not RESOLVED": the OPEN and PENDING views of the inbox. */
export const UNRESOLVED_SQL = sql`c.status <> 'RESOLVED'`;

/** The lateral join that yields `bs.*`: one row (or no row) per conversation. `conversation` is the alias of conversations. */
export function botJoinSql(organizationId: string, conversation = "c"): SQL {
  const c = sql.raw(conversation);
  return sql`LEFT JOIN LATERAL (
      SELECT s.state AS bs_state, s.handover_reason AS bs_handover_reason, s.started_at AS bs_started_at,
             s.ended_at AS bs_ended_at, s.redacted_at AS bs_redacted_at,
             (SELECT r.state FROM outbound_requests r
               WHERE r.organization_id = s.organization_id AND r.bot_session_id = s.id
                 AND s.terminal_notice_step_seq IS NOT NULL AND r.bot_step_seq = s.terminal_notice_step_seq) AS bs_notice_state,
             (s.terminal_notice_step_seq IS NOT NULL) AS bs_has_notice
      FROM bot_sessions s
      WHERE s.organization_id = ${organizationId}::uuid AND s.conversation_id = ${c}.id
      ORDER BY s.started_at DESC, s.id DESC LIMIT 1) bs ON true`;
}

export const BOT_COLUMNS_SQL = sql`bs.bs_state, bs.bs_handover_reason, bs.bs_started_at, bs.bs_ended_at, bs.bs_redacted_at,
           bs.bs_notice_state, bs.bs_has_notice`;

/** The owner-approved Bot Attention predicate (D-2); needs the join above. */
export const BOT_ATTENTION_SQL = sql`(${UNRESOLVED_SQL} AND bs.bs_state IN ('HANDED_OVER', 'FAILED'))`;

/** The columns of BOT_COLUMNS_SQL; absent (undefined) when the caller lacks bot.read and the join was not made. */
export type BotRow = {
  bs_state?: BotSessionStatus | null;
  bs_handover_reason?: string | null;
  bs_started_at?: string | Date | null;
  bs_ended_at?: string | Date | null;
  bs_redacted_at?: string | Date | null;
  bs_notice_state?: string | null;
  bs_has_notice?: boolean | null;
};

const FLOW_REASON: Record<HandoverReasonCode, string> = {
  student_requested: "The student asked for a person",
  needs_staff: "The flow said a staff member is needed",
  out_of_scope: "The question is outside what the bot handles",
  invalid_input: "The student's answers were not understood",
  error_fallback: "The flow fell back to a person after a problem",
  other: "The flow asked for a person",
};

const SYSTEM_REASON: Record<string, string> = {
  staff_assigned: "A staff member was assigned",
  staff_replied: "A staff member replied",
  staff_status_changed: "A staff member changed the conversation status",
  conversation_resolved: "The conversation was resolved",
  operator_stop: "An operator stopped the bot",
  deployment_stopped: "The bot deployment was stopped",
  bot_error: "The bot hit an internal error",
  engine_error: "The bot flow could not continue",
  delivery_failed: "A bot message could not be delivered",
  idle_timeout: "The student stopped replying",
  flow_handover: "The flow handed the chat over",
  send_held: "A bot message was held and not sent",
  send_refused: "A bot message was refused and not sent",
  send_outcome_unknown: "A bot message may not have been sent",
  send_outcome_unresolved: "A bot message could not be confirmed as sent",
};

/** Reasons meaning the student may not have received a bot message (V3.2 J.4): every send_* code and delivery_failed. */
const NOT_RECEIVED = (code: string) => code === "delivery_failed" || code.startsWith("send_");

/** Internal failures: warning severity (staff attention) WITHOUT claiming a message went missing (owner decision, 08F-2). */
const INTERNAL_ERROR = new Set(["bot_error", "engine_error"]);

const isFlowReason = (code: string): code is HandoverReasonCode =>
  (HANDOVER_REASON_CODES as readonly string[]).includes(code);
const isSystemReason = (code: string) =>
  (SYSTEM_HANDOVER_REASONS as readonly string[]).some((r) =>
    r.endsWith("_") ? code.startsWith(r) : code === r,
  );

const NOTICE_LABEL: Record<BotNoticeOutcome, string> = {
  NONE: "No final message was sent",
  PENDING: "The final message has not been confirmed yet",
  ACCEPTED: "The final message was accepted by WhatsApp",
  HELD: "The final message was held and not sent",
  REJECTED: "WhatsApp rejected the final message",
  UNKNOWN_OUTCOME: "The final message may or may not have been sent",
};

export function noticeOutcome(requestState: string | null | undefined): BotNoticeOutcome {
  switch (requestState) {
    case "QUEUED":
    case "SENDING":
      return "PENDING";
    case "ACCEPTED":
    case "HELD":
    case "REJECTED":
    case "UNKNOWN_OUTCOME":
      return requestState;
    default:
      return "NONE"; // no request found: a dangling step number authorizes and shows nothing
  }
}

const iso = (d: string | Date) => new Date(d).toISOString();

/** The indicator for one row, or undefined when the conversation has no bot session. */
export function toBotIndicator(r: BotRow): BotIndicator | undefined {
  if (r.bs_state == null || r.bs_started_at == null) return undefined;
  let handover: BotIndicator["handover"] = null;
  if (r.bs_state === "HANDED_OVER" && r.bs_handover_reason != null) {
    const code = r.bs_handover_reason;
    const flow = isFlowReason(code);
    const system = !flow && isSystemReason(code);
    const known = flow || system;
    const label = flow
      ? FLOW_REASON[code]
      : system
        ? (SYSTEM_REASON[code] ?? "The bot could not send a message")
        : "The reason is not recognised";
    handover = {
      origin: flow ? "flow" : system ? "system" : "unrecognized",
      reasonCode: known ? code : null,
      reason: label,
      studentMayNotHaveReceivedMessage: known && NOT_RECEIVED(code),
    };
  }
  const outcome = r.bs_has_notice ? noticeOutcome(r.bs_notice_state) : null;
  const noticeWarning =
    outcome === "HELD" || outcome === "REJECTED" || outcome === "UNKNOWN_OUTCOME";
  const label =
    r.bs_state === "HANDED_OVER"
      ? handover?.origin === "flow"
        ? "Bot asked for a human"
        : "Bot handed over to staff"
      : r.bs_state === "FAILED"
        ? "Bot stopped with an error"
        : r.bs_state === "COMPLETED"
          ? "Bot finished"
          : "Bot is handling this chat";
  const severity: BotIndicator["severity"] =
    r.bs_state === "FAILED" ||
    handover?.studentMayNotHaveReceivedMessage ||
    (handover?.reasonCode != null && INTERNAL_ERROR.has(handover.reasonCode)) ||
    noticeWarning
      ? "warning"
      : r.bs_state === "HANDED_OVER"
        ? "attention"
        : "neutral";
  return {
    state: r.bs_state,
    label,
    severity,
    handover,
    notice:
      outcome === null ? null : { outcome, label: NOTICE_LABEL[outcome], warning: noticeWarning },
    redacted: r.bs_redacted_at != null,
    startedAt: iso(r.bs_started_at),
    endedAt: r.bs_ended_at == null ? null : iso(r.bs_ended_at),
  };
}

/** `{ bot }` for a row of a query that joined botJoinSql, else `{}`: a caller without bot.read gets no bot key at all. */
export function botField(r: BotRow, allowed: boolean): { bot?: BotIndicator } {
  const bot = allowed ? toBotIndicator(r) : undefined;
  return bot ? { bot } : {};
}
