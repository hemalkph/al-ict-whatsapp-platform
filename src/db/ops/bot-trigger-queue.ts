import { sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "./executor";

// The bot trigger QUEUE primitives (Phase 08E-3; V3.2 H.3 and H.5, plan sections D.3, G.3, J.2, J.3, J.4a, K.1a, K.3):
// claim (T0), fenced failure record (T2), deferral with refund, fenced finish, non-waiting wake and end, and the terminalization
// of a trigger whose sixth claim has been used. Plain parameterized SQL on the caller's executor, in the pattern of
// bot-trigger.ts: no product policy lives here (every number is a parameter the runtime binds from its approved policy), and
// nothing here knows the engine, a transport or an outbound request.
//
// Time is the DATABASE clock (clock_timestamp()): never a transaction-start value, never the application clock. An optional
// `at` lets the step transaction pass the freshness clock it already read on the locked trigger (plan K.1a); without it the
// statement's own clock_timestamp() is used.
//
// FENCES. Every write to a claimed trigger is `WHERE organization_id = $org AND id = $id AND status = 'PENDING' AND
// claim_token = $token`: the organization, the exact claim, and the PENDING state. A stale worker (its claim expired and
// re-claimed), a worker of another organization, and a trigger that is already finished match zero rows and change nothing;
// the functions return false/null instead of throwing, and the caller decides (T1 treats zero rows as "lost the claim").
//
// LOCK DISCIPLINE (V3.2 L.2). Nothing that holds a conversation lock ever WAITS for a trigger row: wake and end select with
// FOR UPDATE SKIP LOCKED. The terminalizer takes the trigger row first (SKIP LOCKED), then, only when a live session exists,
// the conversation advisory try-lock, the deployment FOR SHARE, the conversation FOR UPDATE and the session FOR UPDATE: the
// order a step transaction uses, so the two meet at the trigger row and can never form a cycle. It never touches
// outbound_requests itself: holding a handed-over session's QUEUED request is the caller's injected session-scoped suppression
// (Phase 08E-5, the bot-control primitive), so this file can neither change a SENDING request nor create a transport attempt.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z0-9_]{1,64}$/;

function uuid(value: string, what: string): string {
  if (!UUID.test(value)) throw new TypeError(`${what} must be a UUID`);
  return value;
}
function code(value: string, what: string): string {
  if (!CODE.test(value)) throw new TypeError(`${what} must be a short snake_case code`);
  return value;
}
function int(value: number, min: number, max: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${what} must be an integer in ${min}..${max}`);
  return value;
}
/**
 * A timestamptz from a RAW `execute` result as a Date. Drizzle's node-postgres driver deliberately returns timestamp columns as
 * the server's TEXT ("2026-10-22 10:00:00.123456+00": microseconds, a numeric offset that may be just "+00") for its own column
 * mapping, so a raw statement must convert them itself. The conversion is strict: an unrecognized shape throws instead of
 * yielding Invalid Date, and the fraction is truncated (never rounded) to the millisecond a Date can hold.
 */
export function timestampToDate(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const m =
      /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::?(\d{2}))?$/.exec(
        value,
      );
    if (m) {
      const ms = (m[3] ?? "").padEnd(3, "0").slice(0, 3);
      const d = new Date(`${m[1]}T${m[2]}.${ms}${m[4]}${m[5]}:${m[6] ?? "00"}`);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  throw new TypeError("unrecognized timestamp from the database");
}

const atIso = (at: Date | undefined): string | null => {
  if (at === undefined) return null;
  if (Number.isNaN(at.getTime())) throw new RangeError("at must be a valid Date");
  return at.toISOString();
};

/** A claimed trigger, with the token that fences every later write. */
export type ClaimedTrigger = {
  readonly id: string;
  readonly organizationId: string;
  readonly whatsappAccountId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly claimToken: string;
  readonly claimedAt: Date;
  /** attempts AFTER this claim (1..maxClaims): the claim number. */
  readonly attempts: number;
  readonly deferrals: number;
  readonly inputOccurredAt: Date;
  readonly enqueuedAt: Date;
  readonly observedControlSeq: number;
};

type ClaimRow = {
  id: string;
  organization_id: string;
  whatsapp_account_id: string;
  conversation_id: string;
  message_id: string;
  claim_token: string;
  claimed_at: string | Date;
  attempts: number;
  deferrals: number;
  input_occurred_at: string | Date;
  enqueued_at: string | Date;
  observed_control_seq: string | number;
};

export type ClaimParams = {
  /** How many triggers one statement may claim (>= 1). */
  readonly limit: number;
  /** A claim excludes other workers until it is this old (milliseconds). */
  readonly leaseMs: number;
  /** A trigger is claimed while attempts < maxClaims (never a seventh claim when this is 6). */
  readonly maxClaims: number;
};

// ----------------------------------------------------------------------------------------------------- T0: claim

/**
 * T0. Claims up to `limit` due, claimable triggers in ONE statement (run it as its own short committed transaction).
 *
 * Eligible: status PENDING, attempts < maxClaims, next_attempt_at already due, no live claim (none, or older than the lease)
 * and no EARLIER PENDING trigger in the same conversation (head of line, by input_occurred_at then id). A claimed row stays
 * PENDING, so a claimed, deferred or exhausted trigger keeps every later trigger of its conversation waiting. Candidates are
 * locked FOR UPDATE SKIP LOCKED, so two workers never claim the same trigger and neither waits for the other; the winner's
 * `attempts + 1`, fresh `claim_token` and `claimed_at` are written atomically with the claim.
 */
export function claimTriggersSql(p: ClaimParams): SQL {
  const limit = int(p.limit, 1, 1_000, "limit");
  const leaseMs = int(p.leaseMs, 1, 3_600_000, "leaseMs");
  const maxClaims = int(p.maxClaims, 1, 6, "maxClaims");
  return sql`
    WITH c AS (
      SELECT t.id FROM bot_triggers t
       WHERE t.status = 'PENDING' AND t.attempts < ${maxClaims}
         AND t.next_attempt_at <= clock_timestamp()
         AND (t.claim_token IS NULL OR t.claimed_at < clock_timestamp() - ${leaseMs} * interval '1 millisecond')
         AND NOT EXISTS (
           SELECT 1 FROM bot_triggers e
            WHERE e.organization_id = t.organization_id AND e.conversation_id = t.conversation_id
              AND e.status = 'PENDING' AND (e.input_occurred_at, e.id) < (t.input_occurred_at, t.id))
       ORDER BY t.next_attempt_at, t.id
       LIMIT ${limit}
       FOR UPDATE OF t SKIP LOCKED)
    UPDATE bot_triggers t
       SET attempts = t.attempts + 1, claim_token = gen_random_uuid(), claimed_at = clock_timestamp()
      FROM c
     WHERE t.id = c.id AND t.status = 'PENDING' AND t.attempts < ${maxClaims}
    RETURNING t.id, t.organization_id, t.whatsapp_account_id, t.conversation_id, t.message_id, t.claim_token,
              t.claimed_at, t.attempts, t.deferrals, t.input_occurred_at, t.enqueued_at, t.observed_control_seq`;
}

export async function claimTriggers(
  db: DbExecutor,
  params: ClaimParams,
): Promise<ClaimedTrigger[]> {
  const result = await db.execute<ClaimRow>(claimTriggersSql(params));
  return result.rows.map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    whatsappAccountId: r.whatsapp_account_id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    claimToken: r.claim_token,
    claimedAt: timestampToDate(r.claimed_at),
    attempts: Number(r.attempts),
    deferrals: Number(r.deferrals),
    inputOccurredAt: timestampToDate(r.input_occurred_at),
    enqueuedAt: timestampToDate(r.enqueued_at),
    observedControlSeq: Number(r.observed_control_seq),
  }));
}

/** The claim a write is fenced by: organization, trigger id and the exact token. */
export type ClaimFence = {
  readonly organizationId: string;
  readonly id: string;
  readonly claimToken: string;
};

const fenceWhere = (f: ClaimFence): SQL =>
  sql`organization_id = ${uuid(f.organizationId, "organizationId")} AND id = ${uuid(f.id, "id")}
      AND status = 'PENDING' AND claim_token = ${uuid(f.claimToken, "claimToken")}`;

// -------------------------------------------------------------------------------------- T2: fenced failure record

export type FailureRecord = ClaimFence & {
  /** A short fixed code (never exception text); anything else is stored as `internal_error`. */
  readonly errorCode: string;
  /** Delay until the trigger may be claimed again; null = immediately (no claim is left after the sixth). */
  readonly backoffMs: number | null;
};

/**
 * T2, run AFTER T1 rolled back, on a fresh transaction: clears the current claim, schedules the retry and records the code.
 * Fenced on the exact claim token, so a worker whose claim expired cannot disturb the newer claim. Returns false (and changes
 * nothing) when the fence does not match. attempts is NOT touched: the claim-time attempt stays charged.
 */
export function recordTriggerFailureSql(r: FailureRecord): SQL {
  const backoff = r.backoffMs === null ? 0 : int(r.backoffMs, 0, 86_400_000, "backoffMs");
  const stored = CODE.test(r.errorCode) ? r.errorCode : "internal_error";
  return sql`
    UPDATE bot_triggers
       SET claim_token = NULL, claimed_at = NULL,
           next_attempt_at = clock_timestamp() + ${backoff} * interval '1 millisecond',
           last_error_code = ${stored}
     WHERE ${fenceWhere(r)}
    RETURNING id`;
}

export async function recordTriggerFailure(db: DbExecutor, r: FailureRecord): Promise<boolean> {
  return (await db.execute(recordTriggerFailureSql(r))).rows.length === 1;
}

// ------------------------------------------------------------------------------------- deferral with exact refund

export type DeferParams = ClaimFence & {
  /** The delay ladder selected by the deferrals already recorded: [2000, 4000, 8000, 15000] (the last rung repeats). */
  readonly ladderMs: readonly number[];
  /** The database ceiling of the deferrals column (CHECK 0..1000). */
  readonly maxDeferrals: number;
  /** The freshness clock the caller already read on the locked trigger (K.1a); the statement's own clock when omitted. */
  readonly at?: Date;
};

export type DeferResult = {
  readonly attempts: number;
  readonly deferrals: number;
  readonly nextAttemptAt: Date;
};

/**
 * Defers a FRESH trigger (a stale one is finished, never deferred: K.1a): clears the claim, refunds the claim-time attempt
 * exactly once (attempts - 1), counts the deferral and schedules next_attempt_at from the clock plus the ladder rung chosen by
 * the deferrals BEFORE this update. Fenced on the exact token, so a replay with the old token matches nothing and cannot
 * refund twice. Refuses (no change) when no attempt is charged or the deferral ceiling is reached.
 */
export function deferTriggerSql(p: DeferParams): SQL {
  const ladder = p.ladderMs.map((ms, i) => int(ms, 0, 3_600_000, `ladderMs[${i}]`));
  if (ladder.length === 0) throw new RangeError("ladderMs must not be empty");
  const maxDeferrals = int(p.maxDeferrals, 1, 1_000, "maxDeferrals");
  const at = atIso(p.at);
  return sql`
    UPDATE bot_triggers
       SET claim_token = NULL, claimed_at = NULL, attempts = attempts - 1, deferrals = deferrals + 1,
           next_attempt_at = COALESCE(${at}::timestamptz, clock_timestamp())
             + (${`{${ladder.join(",")}}`}::int[])[LEAST(deferrals, ${ladder.length - 1}) + 1] * interval '1 millisecond'
     WHERE ${fenceWhere(p)} AND attempts >= 1 AND deferrals < ${maxDeferrals}
    RETURNING attempts, deferrals, next_attempt_at`;
}

export async function deferTrigger(db: DbExecutor, p: DeferParams): Promise<DeferResult | null> {
  const rows = (
    await db.execute<{ attempts: number; deferrals: number; next_attempt_at: string | Date }>(
      deferTriggerSql(p),
    )
  ).rows;
  const r = rows[0];
  return r
    ? {
        attempts: Number(r.attempts),
        deferrals: Number(r.deferrals),
        nextAttemptAt: timestampToDate(r.next_attempt_at),
      }
    : null;
}

// -------------------------------------------------------------------------------------------------- fenced finish

export type FinishParams = ClaimFence & {
  /** PROCESSED or IGNORED. DEAD is written only by the terminalizer, and PENDING is not a finish. */
  readonly status: "PROCESSED" | "IGNORED";
  /** A short fixed code (stale_trigger, session_ended, processed, ...). */
  readonly outcomeCode: string;
  /** The session this trigger started or continued, when there is one. */
  readonly sessionId?: string;
  /** The freshness clock when the caller has one (the stale finish, K.1a); else the statement's clock. */
  readonly at?: Date;
};

/**
 * Finishes the CURRENT claim: status, outcome, processed_at, claim cleared, last_error_code cleared. Fenced like every write:
 * a stale or mismatched claim, a finished trigger and a DEAD trigger match zero rows (returns false), so an outcome can
 * never be overwritten, a terminal trigger can never be reopened, and a late worker changes nothing.
 */
export function finishTriggerSql(p: FinishParams): SQL {
  if (p.status !== "PROCESSED" && p.status !== "IGNORED")
    throw new TypeError("status must be PROCESSED or IGNORED");
  const outcome = code(p.outcomeCode, "outcomeCode");
  const session = p.sessionId === undefined ? null : uuid(p.sessionId, "sessionId");
  const at = atIso(p.at);
  return sql`
    UPDATE bot_triggers
       SET status = ${p.status}, outcome_code = ${outcome},
           processed_at = COALESCE(${at}::timestamptz, clock_timestamp()),
           claim_token = NULL, claimed_at = NULL, last_error_code = NULL,
           session_id = COALESCE(${session}::uuid, session_id)
     WHERE ${fenceWhere(p)}
    RETURNING id`;
}

export async function finishTrigger(db: DbExecutor, p: FinishParams): Promise<boolean> {
  return (await db.execute(finishTriggerSql(p))).rows.length === 1;
}

// ---------------------------------------------------------------------------- non-waiting wake and end (J.4a, G.3)

export type ConversationTriggers = {
  readonly organizationId: string;
  readonly conversationId: string;
  /** A trigger to leave alone (the caller's own). */
  readonly exceptId?: string;
};

/**
 * Makes the conversation's PENDING triggers that are waiting for a LATER time due now, so preserved inputs are applied
 * promptly. A row another transaction holds (a step transaction working that very trigger) is SKIPPED, never waited for:
 * the caller holds the conversation lock and that step transaction may be waiting for it. A skipped trigger is not lost: the
 * step reads the session state when it gets its locks, and its own backoff (at most 15 s on the ladder) makes it claimable.
 * Returns the number woken.
 */
export function wakeConversationTriggersSql(c: ConversationTriggers): SQL {
  const except = c.exceptId === undefined ? null : uuid(c.exceptId, "exceptId");
  return sql`
    WITH locked AS (
      SELECT t.id FROM bot_triggers t
       WHERE t.organization_id = ${uuid(c.organizationId, "organizationId")}
         AND t.conversation_id = ${uuid(c.conversationId, "conversationId")}
         AND t.status = 'PENDING' AND t.next_attempt_at > clock_timestamp()
         AND (${except}::uuid IS NULL OR t.id <> ${except}::uuid)
       ORDER BY t.input_occurred_at, t.id
       FOR UPDATE SKIP LOCKED)
    UPDATE bot_triggers t SET next_attempt_at = clock_timestamp()
      FROM locked WHERE t.id = locked.id
    RETURNING t.id`;
}

export async function wakeConversationTriggers(
  db: DbExecutor,
  c: ConversationTriggers,
): Promise<number> {
  return (await db.execute(wakeConversationTriggersSql(c))).rows.length;
}

/**
 * Ends the conversation's PENDING triggers as IGNORED with `outcomeCode` (default session_ended) once their session is over,
 * again without waiting on any locked row. This is an optimization, not the guarantee: a trigger it skips ends itself when its
 * own step transaction finds the session over (and a claimed trigger it ends makes that step stop with no effects, because the
 * step's first statement re-reads the trigger by claim token and finds it no longer PENDING). Returns the number ended.
 */
export function endConversationTriggersSql(
  c: ConversationTriggers & { readonly outcomeCode?: string },
): SQL {
  const except = c.exceptId === undefined ? null : uuid(c.exceptId, "exceptId");
  const outcome = code(c.outcomeCode ?? "session_ended", "outcomeCode");
  return sql`
    WITH locked AS (
      SELECT t.id FROM bot_triggers t
       WHERE t.organization_id = ${uuid(c.organizationId, "organizationId")}
         AND t.conversation_id = ${uuid(c.conversationId, "conversationId")}
         AND t.status = 'PENDING'
         AND (${except}::uuid IS NULL OR t.id <> ${except}::uuid)
       ORDER BY t.input_occurred_at, t.id
       FOR UPDATE SKIP LOCKED)
    UPDATE bot_triggers t
       SET status = 'IGNORED', outcome_code = ${outcome}, processed_at = clock_timestamp(),
           claim_token = NULL, claimed_at = NULL
      FROM locked WHERE t.id = locked.id
    RETURNING t.id`;
}

export async function endConversationTriggers(
  db: DbExecutor,
  c: ConversationTriggers & { readonly outcomeCode?: string },
): Promise<number> {
  return (await db.execute(endConversationTriggersSql(c))).rows.length;
}

// --------------------------------------------------------------------------------------- terminalization (R1, J.3)

export type TerminalizationParams = {
  /** The claim count at which a trigger is exhausted (6). */
  readonly maxClaims: number;
  /** A claim older than this no longer protects a running attempt (milliseconds). */
  readonly leaseMs: number;
};

export type TerminalizationCandidate = {
  readonly organizationId: string;
  readonly id: string;
  readonly conversationId: string;
};

/**
 * Exhausted triggers that no live claim protects: PENDING, attempts = maxClaims, and no claim or a claim past its lease.
 * A plain read (no locks). The partial index on (attempts, claimed_at) WHERE PENDING AND attempts = 6 serves it, which needs
 * the literal 6 in the text: the validated integer is inlined, not bound.
 */
export function terminalizationCandidatesSql(p: TerminalizationParams, limit: number): SQL {
  const maxClaims = int(p.maxClaims, 1, 6, "maxClaims");
  const leaseMs = int(p.leaseMs, 1, 3_600_000, "leaseMs");
  return sql`
    SELECT t.organization_id, t.id, t.conversation_id FROM bot_triggers t
     WHERE t.status = 'PENDING' AND t.attempts = ${sql.raw(String(maxClaims))}
       AND (t.claim_token IS NULL OR t.claimed_at < clock_timestamp() - ${leaseMs} * interval '1 millisecond')
     ORDER BY t.id
     LIMIT ${int(limit, 1, 1_000, "limit")}`;
}

export async function listTerminalizationCandidates(
  db: DbExecutor,
  p: TerminalizationParams,
  limit: number,
): Promise<TerminalizationCandidate[]> {
  const rows = (
    await db.execute<{ organization_id: string; id: string; conversation_id: string }>(
      terminalizationCandidatesSql(p, limit),
    )
  ).rows;
  return rows.map((r) => ({
    organizationId: r.organization_id,
    id: r.id,
    conversationId: r.conversation_id,
  }));
}

/** The DEAD write: only a PENDING, exhausted trigger with no live claim, and only the one this transaction holds. */
export function markTriggerDeadSql(t: TerminalizationCandidate, p: TerminalizationParams): SQL {
  return sql`
    UPDATE bot_triggers
       SET status = 'DEAD', outcome_code = 'attempts_exhausted', processed_at = clock_timestamp(),
           claim_token = NULL, claimed_at = NULL
     WHERE organization_id = ${uuid(t.organizationId, "organizationId")} AND id = ${uuid(t.id, "id")}
       AND status = 'PENDING' AND attempts = ${int(p.maxClaims, 1, 6, "maxClaims")}
       AND (claim_token IS NULL OR claimed_at < clock_timestamp() - ${int(p.leaseMs, 1, 3_600_000, "leaseMs")} * interval '1 millisecond')
    RETURNING id`;
}

/** The trigger row, taken first and never waited for: SKIP LOCKED passes over a running attempt. */
export function lockTerminalizationCandidateSql(
  t: TerminalizationCandidate,
  p: TerminalizationParams,
): SQL {
  return sql`
    SELECT t.id, t.whatsapp_account_id FROM bot_triggers t
     WHERE t.organization_id = ${uuid(t.organizationId, "organizationId")} AND t.id = ${uuid(t.id, "id")}
       AND t.status = 'PENDING' AND t.attempts = ${int(p.maxClaims, 1, 6, "maxClaims")}
       AND (t.claim_token IS NULL OR t.claimed_at < clock_timestamp() - ${int(p.leaseMs, 1, 3_600_000, "leaseMs")} * interval '1 millisecond')
     FOR UPDATE SKIP LOCKED`;
}

export type TerminalizeOptions = TerminalizationParams & {
  /** Bound for each lock wait inside the transaction (milliseconds). */
  readonly lockTimeoutMs: number;
  /**
   * The session-scoped suppression (08E-5), run on THIS transaction right after the hand-over: it holds the session's QUEUED
   * BOT requests and skips (never waits for) one a dispatcher holds. Required, so no caller can forget it.
   */
  readonly suppressSession: (
    tx: DbExecutor,
    organizationId: string,
    sessionId: string,
  ) => Promise<unknown>;
};

export type TerminalizationResult =
  /** Not a candidate any more (finished, claimed, held by a running attempt), or the conversation is busy: nothing changed. */
  | { readonly kind: "skipped"; readonly reason: "not_candidate" | "conversation_busy" }
  | {
      readonly kind: "dead";
      /** The live session handed over in the same transaction, when there was one. */
      readonly handedOverSessionId: string | null;
      /** Other PENDING triggers of the conversation ended with the session (only when a session was handed over). */
      readonly endedTriggers: number;
    };

/**
 * Terminalizes ONE exhausted trigger in ONE transaction. Order: the trigger row (FOR UPDATE SKIP LOCKED) -> when a live
 * session exists: the conversation advisory TRY-lock (busy: skip the round, nothing changed), deployment FOR SHARE,
 * conversation FOR UPDATE, session FOR UPDATE -> DEAD(attempts_exhausted) -> the session HANDED_OVER (system_handover /
 * bot_error, output suppressed, awaiting and tokens cleared; the database stamps ended_at and allocates handover_control_seq
 * on the conversation row already held) with its HANDED_OVER event -> the injected session-scoped suppression (QUEUED ->
 * HELD for rows it can lock; a row a dispatcher holds is skipped) -> the conversation's other PENDING triggers ended
 * (session_ended), without waiting.
 *
 * A skipped request stays safe because the session is suppressed in the same transaction: the dispatcher's claim and final
 * authorization hold it (bot_output_suppressed). A SENDING request is never changed by anyone but the dispatcher; one whose
 * final authorization already passed may still be sent (the accepted limit, V3.2 I.4).
 */
export async function terminalizeTrigger(
  db: DbExecutor,
  candidate: TerminalizationCandidate,
  options: TerminalizeOptions,
): Promise<TerminalizationResult> {
  const lockTimeout = int(options.lockTimeoutMs, 1, 60_000, "lockTimeoutMs");
  const org = uuid(candidate.organizationId, "organizationId");
  const conversationId = uuid(candidate.conversationId, "conversationId");
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${lockTimeout}ms'`));

    // 1. The trigger row, first and non-waiting. A running attempt holds it; a finished or re-claimed trigger fails the predicate.
    const locked = await tx.execute<{ id: string }>(
      lockTerminalizationCandidateSql(candidate, options),
    );
    if (locked.rows.length === 0) return { kind: "skipped", reason: "not_candidate" } as const;

    // 2. A live session of the conversation (plain read; at most one by the partial unique index).
    const live = await tx.execute<{ id: string; deployment_id: string }>(sql`
      SELECT s.id, s.deployment_id FROM bot_sessions s
       WHERE s.organization_id = ${org} AND s.conversation_id = ${conversationId}
         AND s.state IN ('ACTIVE', 'WAITING_FOR_SEND', 'WAITING_FOR_INPUT')`);
    const session = live.rows[0];

    let handedOverSessionId: string | null = null;
    if (session) {
      // 3. The conversation advisory try-lock: busy means a step transaction is working here; skip this round untouched.
      const key = `bot-conv:${org}:${conversationId}`;
      const gate = await tx.execute<{ ok: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS ok`,
      );
      if (gate.rows[0]?.ok !== true)
        return { kind: "skipped", reason: "conversation_busy" } as const;
      // 4. deployment FOR SHARE -> conversation FOR UPDATE -> session FOR UPDATE (the step transaction's order).
      await tx.execute(
        sql`SELECT id FROM bot_deployments WHERE organization_id = ${org} AND id = ${uuid(session.deployment_id, "deploymentId")} FOR SHARE`,
      );
      await tx.execute(
        sql`SELECT id FROM conversations WHERE organization_id = ${org} AND id = ${conversationId} FOR UPDATE`,
      );
      const stillLive = await tx.execute<{ id: string }>(sql`
        SELECT id FROM bot_sessions
         WHERE organization_id = ${org} AND id = ${uuid(session.id, "sessionId")}
           AND state IN ('ACTIVE', 'WAITING_FOR_SEND', 'WAITING_FOR_INPUT')
         FOR UPDATE`);
      if (stillLive.rows.length === 1) handedOverSessionId = session.id;
    }

    // 5. DEAD. Zero rows is impossible while this transaction holds the row, but the predicate is the safety net.
    const dead = await tx.execute(markTriggerDeadSql(candidate, options));
    if (dead.rows.length !== 1) return { kind: "skipped", reason: "not_candidate" } as const;

    let endedTriggers = 0;
    if (handedOverSessionId !== null) {
      // 6. The session is handed over and suppressed in this same transaction.
      await tx.execute(sql`
        UPDATE bot_sessions
           SET state = 'HANDED_OVER', end_reason = 'system_handover', handover_reason = 'bot_error',
               output_suppressed_at = COALESCE(output_suppressed_at, clock_timestamp()),
               awaiting = NULL, awaiting_token = NULL, expires_at = NULL, send_wait_expires_at = NULL,
               revision = revision + 1
         WHERE organization_id = ${org} AND id = ${handedOverSessionId}`);
      await tx.execute(sql`
        INSERT INTO bot_session_events (organization_id, session_id, conversation_id, kind, code)
        VALUES (${org}, ${handedOverSessionId}, ${conversationId}, 'HANDED_OVER', 'bot_error')`);
      // 7. The session's QUEUED request (if any) is held in the same transaction; never a wait on a request row.
      await options.suppressSession(tx as unknown as DbExecutor, org, handedOverSessionId);
      // 8. The other PENDING triggers of the conversation end with the session, never waiting on a held row.
      endedTriggers = (
        await tx.execute(endConversationTriggersSql({ organizationId: org, conversationId }))
      ).rows.length;
    }
    return { kind: "dead", handedOverSessionId, endedTriggers } as const;
  });
}

// ------------------------------------------------------------------------------------------- overdue audit (J.4a)

export type OverdueTriggers = {
  readonly organizationId: string;
  readonly conversationId: string;
  readonly count: number;
};

/**
 * J.4a audit, a PLAIN read: PENDING triggers enqueued longer ago than `ageMs` (maxInputAge + 2 x lease), counted per
 * conversation. Correctness never depends on the end/wake pass catching every row; a non-empty result is an operator alert.
 */
export function overdueTriggersSql(p: { ageMs: number; limit: number }): SQL {
  return sql`
    SELECT t.organization_id, t.conversation_id, count(*)::int AS n FROM bot_triggers t
     WHERE t.status = 'PENDING' AND t.enqueued_at < clock_timestamp() - ${int(p.ageMs, 1, 86_400_000, "ageMs")} * interval '1 millisecond'
     GROUP BY t.organization_id, t.conversation_id
     ORDER BY t.organization_id, t.conversation_id
     LIMIT ${int(p.limit, 1, 1_000, "limit")}`;
}

export async function listOverdueTriggers(
  db: DbExecutor,
  p: { ageMs: number; limit: number },
): Promise<OverdueTriggers[]> {
  const rows = (
    await db.execute<{ organization_id: string; conversation_id: string; n: number }>(
      overdueTriggersSql(p),
    )
  ).rows;
  return rows.map((r) => ({
    organizationId: r.organization_id,
    conversationId: r.conversation_id,
    count: Number(r.n),
  }));
}
