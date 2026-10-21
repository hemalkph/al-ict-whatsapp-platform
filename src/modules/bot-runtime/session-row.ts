import type { Awaiting, BotSession } from "@/modules/bots";

// bot_sessions row <-> the engine's BotSession (Phase 08E-1; plan section F.2). PURE. The mapper NEVER repairs: a value that
// does not fit the engine's model is passed through unchanged, so the engine's own checkLiveSession reports SESSION_INVALID
// and ends the session at the error node with its variables discarded (ADR 0018 section 2). The database owns the columns
// this module never writes: revision (the caller adds 1), started_control_seq, handover_control_seq, started_at, ended_at.

/** The columns the engine's session model covers, as the database driver returns them. */
export type BotSessionRow = {
  readonly state: string;
  readonly currentNodeId: string;
  readonly variables: unknown;
  readonly awaiting: unknown;
  readonly awaitingToken: string | null;
  readonly lastConsumedToken: string | null;
  readonly stepSeq: number;
  readonly transitionCount: number;
  readonly sendCount: number;
  readonly invalidAttempts: number;
  /** timestamptz -> Date. */
  readonly expiresAt: Date | null;
  readonly endReason: string | null;
  readonly handoverReason: string | null;
  readonly terminalNoticeStepSeq: number | null;
};

/** The engine-owned columns written on an update (everything else on the row is the database's or the runtime's own). */
export type BotSessionColumns = {
  readonly state: string;
  readonly currentNodeId: string;
  readonly variables: Record<string, unknown>;
  /** SQL NULL (never JSON null) or a plain object; the database CHECK refuses JSON null. */
  readonly awaiting: Awaiting | null;
  readonly awaitingToken: string | null;
  readonly lastConsumedToken: string | null;
  readonly stepSeq: number;
  readonly transitionCount: number;
  readonly sendCount: number;
  readonly invalidAttempts: number;
  readonly expiresAt: Date | null;
  readonly endReason: string | null;
  readonly handoverReason: string | null;
  readonly terminalNoticeStepSeq: number | null;
};

export const ENGINE_SESSION_COLUMNS = [
  "state",
  "currentNodeId",
  "variables",
  "awaiting",
  "awaitingToken",
  "lastConsumedToken",
  "stepSeq",
  "transitionCount",
  "sendCount",
  "invalidAttempts",
  "expiresAt",
  "endReason",
  "handoverReason",
  "terminalNoticeStepSeq",
] as const;

/** A row as the engine's session. Unfitting values are passed through (cast), never normalized, so the engine rejects them. */
export function sessionFromRow(row: BotSessionRow): BotSession {
  return {
    state: row.state,
    currentNodeId: row.currentNodeId,
    variables: row.variables,
    awaiting: row.awaiting,
    awaitingToken: row.awaitingToken,
    lastConsumedToken: row.lastConsumedToken,
    stepSeq: row.stepSeq,
    transitionCount: row.transitionCount,
    sendCount: row.sendCount,
    invalidAttempts: row.invalidAttempts,
    // epoch milliseconds; an invalid Date becomes NaN, which the engine's model check refuses
    expiresAt: row.expiresAt === null ? null : row.expiresAt.getTime(),
    endReason: row.endReason,
    handoverReason: row.handoverReason,
    terminalNoticeStepSeq: row.terminalNoticeStepSeq,
  } as unknown as BotSession;
}

/** The engine's session as the columns to write. `awaiting` is SQL NULL or an object, never JSON null. */
export function sessionToColumns(session: BotSession): BotSessionColumns {
  return {
    state: session.state,
    currentNodeId: session.currentNodeId,
    variables: { ...session.variables },
    awaiting: session.awaiting === null ? null : session.awaiting,
    awaitingToken: session.awaitingToken,
    lastConsumedToken: session.lastConsumedToken,
    stepSeq: session.stepSeq,
    transitionCount: session.transitionCount,
    sendCount: session.sendCount,
    invalidAttempts: session.invalidAttempts,
    expiresAt: session.expiresAt === null ? null : new Date(session.expiresAt),
    endReason: session.endReason,
    handoverReason: session.handoverReason,
    terminalNoticeStepSeq: session.terminalNoticeStepSeq,
  };
}
