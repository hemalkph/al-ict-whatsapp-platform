import { sql } from "drizzle-orm";
import type { DbExecutor } from "./executor";
import { timestampToDate } from "./bot-trigger-queue";
import { LIVE_STATES_SQL, uuid } from "./bot-step";

// The bot SESSION STORE (Phase 08E-4; plan sections E.2, F.2, F.3, H.5, J.5): the writes of a session, its events and the
// reads of the BOT requests the step depends on. Plain parameterized SQL on the caller's executor. The step transaction holds
// the conversation and session locks before any of these runs.
//
// What the database owns and this file never writes: started_control_seq and handover_control_seq (allocation triggers, under
// the conversation row lock the step already holds), started_at and ended_at (the guard), redacted_at. A live update must raise
// `revision` by exactly 1 (the guard), so every update is fenced on the revision the step read under the session lock: a zero
// row result is a defect the caller turns into a rollback, never a silent skip. Nothing here repairs a session: it writes the
// engine's result, or a fixed runtime hand-over, and the table's CHECKs and guard accept or refuse it.
//
// No statement here locks or writes an outbound request: request state is READ (plain, non-locking), and the only writer of a
// request is the enqueue function and the suppression primitive.

export type NewSession = {
  readonly organizationId: string;
  readonly botId: string;
  readonly botVersionId: string;
  readonly deploymentId: string;
  readonly whatsappAccountId: string;
  readonly contactId: string;
  readonly conversationId: string;
  /** The message that started the session; also its first (and so last consumed) input. */
  readonly startedByMessageId: string;
  readonly startNodeId: string;
  readonly inputOccurredAt: Date;
};

/**
 * E.2 step 2: inserts the session LIVE (state ACTIVE), so the request of its first send can reference it inside the same
 * transaction. The database stamps started_at and allocates started_control_seq (greater than every staff event examined).
 */
export async function insertLiveSession(
  tx: DbExecutor,
  s: NewSession,
): Promise<{ id: string; revision: number; startedControlSeq: number }> {
  const r = await tx.execute<{
    id: string;
    revision: number;
    started_control_seq: string | number;
  }>(sql`
    INSERT INTO bot_sessions (organization_id, bot_id, bot_version_id, deployment_id, whatsapp_account_id, contact_id,
                              conversation_id, started_by_message_id, state, current_node_id,
                              last_input_message_id, last_input_occurred_at)
    VALUES (${uuid(s.organizationId, "organizationId")}, ${uuid(s.botId, "botId")}, ${uuid(s.botVersionId, "botVersionId")},
            ${uuid(s.deploymentId, "deploymentId")}, ${uuid(s.whatsappAccountId, "accountId")}, ${uuid(s.contactId, "contactId")},
            ${uuid(s.conversationId, "conversationId")}, ${uuid(s.startedByMessageId, "messageId")}, 'ACTIVE', ${s.startNodeId},
            ${s.startedByMessageId}, ${s.inputOccurredAt.toISOString()}::timestamptz)
    RETURNING id, revision, started_control_seq`);
  const x = r.rows[0]!;
  return { id: x.id, revision: x.revision, startedControlSeq: Number(x.started_control_seq) };
}

/** The engine-owned columns plus the runtime's own (F.2). `expiresAt` and `sendWaitExpiresAt` are absolute instants. */
export type SessionWrite = {
  readonly organizationId: string;
  readonly id: string;
  /** The revision read under the session lock; the update raises it by exactly 1. */
  readonly expectedRevision: number;
  readonly state: string;
  readonly currentNodeId: string;
  readonly variables: Record<string, unknown>;
  /** SQL NULL when none; the database CHECK refuses JSON null. */
  readonly awaiting: Record<string, unknown> | null;
  readonly awaitingToken: string | null;
  readonly lastConsumedToken: string | null;
  readonly stepSeq: number;
  readonly transitionCount: number;
  readonly sendCount: number;
  readonly invalidAttempts: number;
  readonly expiresAt: Date | null;
  readonly sendWaitExpiresAt: Date | null;
  readonly endReason: string | null;
  readonly handoverReason: string | null;
  readonly terminalNoticeStepSeq: number | null;
  /** Set when an input was consumed by this step; otherwise the columns are left as they are. */
  readonly lastInput: { readonly messageId: string; readonly occurredAt: Date } | null;
  /** A runtime hand-over: output_suppressed_at is set once (never changed afterwards). */
  readonly suppressOutput: boolean;
};

const iso = (d: Date | null): string | null => {
  if (d === null) return null;
  if (Number.isNaN(d.getTime())) throw new RangeError("invalid Date");
  return d.toISOString();
};

/** Writes the result of a step. Exactly one live row must match (organization, id, revision); anything else throws. */
export async function writeSession(tx: DbExecutor, w: SessionWrite): Promise<number> {
  const r = await tx.execute<{ revision: number }>(sql`
    UPDATE bot_sessions
       SET state = ${w.state}, current_node_id = ${w.currentNodeId},
           variables = ${JSON.stringify(w.variables)}::jsonb,
           awaiting = ${w.awaiting === null ? null : JSON.stringify(w.awaiting)}::jsonb,
           awaiting_token = ${w.awaitingToken}, last_consumed_token = ${w.lastConsumedToken},
           step_seq = ${w.stepSeq}, transition_count = ${w.transitionCount}, send_count = ${w.sendCount},
           invalid_attempts = ${w.invalidAttempts},
           expires_at = ${iso(w.expiresAt)}::timestamptz, send_wait_expires_at = ${iso(w.sendWaitExpiresAt)}::timestamptz,
           end_reason = ${w.endReason}, handover_reason = ${w.handoverReason},
           terminal_notice_step_seq = ${w.terminalNoticeStepSeq},
           last_input_message_id = COALESCE(${w.lastInput?.messageId ?? null}::uuid, last_input_message_id),
           last_input_occurred_at = COALESCE(${iso(w.lastInput?.occurredAt ?? null)}::timestamptz, last_input_occurred_at),
           output_suppressed_at = CASE WHEN ${w.suppressOutput} THEN COALESCE(output_suppressed_at, clock_timestamp())
                                       ELSE output_suppressed_at END,
           revision = revision + 1
     WHERE organization_id = ${uuid(w.organizationId, "organizationId")} AND id = ${uuid(w.id, "sessionId")}
       AND revision = ${w.expectedRevision} AND state IN (${LIVE_STATES_SQL})
    RETURNING revision`);
  if (r.rows.length !== 1) throw new Error("session_write_conflict");
  return r.rows[0]!.revision;
}

export type SessionEnd = {
  readonly organizationId: string;
  readonly id: string;
  readonly expectedRevision: number;
  readonly state: "COMPLETED" | "HANDED_OVER" | "FAILED";
  readonly endReason: string;
  readonly handoverReason: string | null;
};

/**
 * A runtime-decided end (staff takeover, flow_invalid, send_refused, ...): the terminal state, reason, output suppressed once,
 * awaiting and tokens cleared, no terminal notice. Everything else on the row is left exactly as it is. The database stamps
 * ended_at and, for HANDED_OVER, allocates handover_control_seq on the conversation row the step holds.
 */
export async function endSession(tx: DbExecutor, e: SessionEnd): Promise<number> {
  const r = await tx.execute<{ revision: number }>(sql`
    UPDATE bot_sessions
       SET state = ${e.state}, end_reason = ${e.endReason}, handover_reason = ${e.handoverReason},
           output_suppressed_at = COALESCE(output_suppressed_at, clock_timestamp()),
           awaiting = NULL, awaiting_token = NULL, expires_at = NULL, send_wait_expires_at = NULL,
           revision = revision + 1
     WHERE organization_id = ${uuid(e.organizationId, "organizationId")} AND id = ${uuid(e.id, "sessionId")}
       AND revision = ${e.expectedRevision} AND state IN (${LIVE_STATES_SQL})
    RETURNING revision`);
  if (r.rows.length !== 1) throw new Error("session_write_conflict");
  return r.rows[0]!.revision;
}

export type SessionEventKind =
  | "INPUT_ACCEPTED"
  | "INPUT_REJECTED"
  | "PROMPT_INTERACTION"
  | "HANDED_OVER"
  | "TERMINAL_NOTICE_NOT_QUEUED"
  | "ERROR";

export type SessionEventWrite = {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly kind: SessionEventKind;
  readonly messageId?: string;
  readonly stepSeq?: number;
  /** A fixed snake_case code (never text, a value or a token); the table's CHECK enforces the shape. */
  readonly code?: string;
};

/**
 * Appends one fact, idempotently: the input and interaction kinds by their unique (session, message) indexes, and every kind
 * by an identical-tuple guard, so a replayed step adds nothing. Returns whether a row was written.
 */
export async function insertSessionEvent(tx: DbExecutor, e: SessionEventWrite): Promise<boolean> {
  const org = uuid(e.organizationId, "organizationId");
  const session = uuid(e.sessionId, "sessionId");
  const message = e.messageId === undefined ? null : uuid(e.messageId, "messageId");
  const r = await tx.execute<{ id: string }>(sql`
    INSERT INTO bot_session_events (organization_id, session_id, conversation_id, kind, message_id, step_seq, code)
    SELECT ${org}::uuid, ${session}::uuid, ${uuid(e.conversationId, "conversationId")}::uuid, ${e.kind}::text,
           ${message}::uuid, ${e.stepSeq ?? null}::integer, ${e.code ?? null}::text
     WHERE NOT EXISTS (
       SELECT 1 FROM bot_session_events x
        WHERE x.organization_id = ${org}::uuid AND x.session_id = ${session}::uuid AND x.kind = ${e.kind}::text
          AND x.message_id IS NOT DISTINCT FROM ${message}::uuid
          AND x.step_seq IS NOT DISTINCT FROM ${e.stepSeq ?? null}::integer
          AND x.code IS NOT DISTINCT FROM ${e.code ?? null}::text)
    ON CONFLICT DO NOTHING
    RETURNING id`);
  return r.rows.length === 1;
}

// ------------------------------------------------------------------------------------- plain reads of the BOT requests

export type StepRequest = {
  readonly state: "QUEUED" | "SENDING" | "ACCEPTED" | "HELD" | "REJECTED" | "UNKNOWN_OUTCOME";
  /** The hold code of a HELD request. */
  readonly holdReason: string | null;
  /** The provider message id of the request's message, once Meta accepted it (the prompt a reply may answer). */
  readonly wamid: string | null;
};

/** The session's request for a step, if any (unique per (organization, session, step)). A plain, non-locking read. */
export async function readStepRequest(
  tx: DbExecutor,
  org: string,
  sessionId: string,
  stepSeq: number,
): Promise<StepRequest | null> {
  const r = await tx.execute<{
    state: StepRequest["state"];
    hold_reason: string | null;
    wamid: string | null;
  }>(sql`
    SELECT r.state, r.hold_reason, m.wamid
      FROM outbound_requests r
      LEFT JOIN messages m ON m.organization_id = r.organization_id AND m.id = r.message_id
     WHERE r.organization_id = ${uuid(org, "organizationId")} AND r.origin = 'BOT'
       AND r.bot_session_id = ${uuid(sessionId, "sessionId")} AND r.bot_step_seq = ${stepSeq}`);
  const x = r.rows[0];
  return x ? { state: x.state, holdReason: x.hold_reason, wamid: x.wamid } : null;
}

/**
 * H.5 / C-4: BOT requests created for the conversation in the rolling hour ending at the decision clock, in ANY state (a
 * rolled-back creation leaves no row). The window is (clock - window, clock]: exactly `window` old is excluded. created_at is
 * the database default (transaction start), documented in the plan as the cap's clock; the decision clock is a millisecond
 * value, so "at or before the clock" is written `< clock + 1 ms` (a row created in the clock's own millisecond counts).
 */
export async function countRecentBotRequests(
  tx: DbExecutor,
  org: string,
  conversationId: string,
  decisionClock: Date,
  windowMs: number,
): Promise<number> {
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new RangeError("windowMs");
  const at = iso(decisionClock)!;
  const r = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM outbound_requests
     WHERE organization_id = ${uuid(org, "organizationId")} AND conversation_id = ${uuid(conversationId, "conversationId")}
       AND origin = 'BOT'
       AND created_at > ${at}::timestamptz - ${windowMs} * interval '1 millisecond'
       AND created_at < ${at}::timestamptz + interval '1 millisecond'`);
  return Number(r.rows[0]!.n);
}

/** The instant a timestamp read from the database denotes (re-exported so the runtime needs no second converter). */
export const toDate = timestampToDate;
