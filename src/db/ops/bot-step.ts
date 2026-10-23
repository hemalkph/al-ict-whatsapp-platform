import { sql } from "drizzle-orm";
import type { DbExecutor } from "./executor";
import { timestampToDate } from "./bot-trigger-queue";

// The SQL of the bot STEP transaction (T1; Phase 08E-4, plan sections E.2, E.3, D.4a, K.1, K.1a): the lock helpers in the
// approved order and every read the step makes under them. Plain parameterized SQL on the caller's executor, in the pattern of
// bot-trigger-queue.ts: no product policy lives here (every number is a parameter), and nothing here knows the engine, a
// transport or an outbound request's content.
//
// LOCK ORDER (K.1). trigger row (FOR UPDATE, first) -> conversation advisory TRY-lock -> contact advisory TRY-lock (start path
// only) -> deployment(s) FOR SHARE in id order -> conversation FOR UPDATE -> session FOR UPDATE -> account FOR SHARE -> the
// decision clock. NO function here ever waits for an advisory lock, a trigger row held by someone else or a request row, and
// none reads now(), current_timestamp or transaction_timestamp(): the decision clock is clock_timestamp(), read by `dbClock`
// after the last blocking lock; a static test pins both.
//
// Every statement is scoped by organization_id. Reads of rows another transaction may change (staff control, request state)
// are plain, non-locking reads taken while this transaction holds the conversation lock, which every staff writer needs first.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function uuid(value: string, what: string): string {
  if (!UUID.test(value)) throw new TypeError(`${what} must be a UUID`);
  return value;
}

const uuidArray = (ids: readonly string[]): string =>
  `{${ids.map((i) => uuid(i, "id")).join(",")}}`;

/** The live session states (ACTIVE, WAITING_FOR_SEND, WAITING_FOR_INPUT); one per conversation by a partial unique index. */
export const LIVE_STATES_SQL = sql.raw("'ACTIVE', 'WAITING_FOR_SEND', 'WAITING_FOR_INPUT'");

/** Runs `fn` in ONE transaction with a lock_timeout for every row-lock wait inside it (the bound of J.6 comes from the pool). */
export function withStepTransaction<T>(
  db: DbExecutor,
  lockTimeoutMs: number,
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 60_000)
    throw new RangeError("lockTimeoutMs must be an integer in 1..60000");
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`));
    return fn(tx as unknown as DbExecutor);
  });
}

/** The DATABASE decision clock. Never a transaction-start value. */
export async function dbClock(tx: DbExecutor): Promise<Date> {
  const r = await tx.execute<{ now: string | Date }>(sql`SELECT clock_timestamp() AS now`);
  return timestampToDate(r.rows[0]!.now);
}

/** A transaction-scoped advisory TRY-lock: true when acquired, false when someone else holds it. Never waits. */
export async function tryAdvisoryLock(tx: DbExecutor, key: string): Promise<boolean> {
  const r = await tx.execute<{ ok: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS ok`,
  );
  return r.rows[0]?.ok === true;
}

export const conversationLockKey = (org: string, conversationId: string): string =>
  `bot-conv:${uuid(org, "organizationId")}:${uuid(conversationId, "conversationId")}`;
export const contactLockKey = (org: string, contactId: string): string =>
  `bot-contact:${uuid(org, "organizationId")}:${uuid(contactId, "contactId")}`;

// ------------------------------------------------------------------------------------------------ step 0: the trigger

export type StepTrigger = {
  readonly id: string;
  readonly organizationId: string;
  readonly whatsappAccountId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly inputOccurredAt: Date;
  readonly enqueuedAt: Date;
  readonly observedControlSeq: number;
  readonly attempts: number;
  readonly deferrals: number;
};

/**
 * K.1 step 0. Locks the trigger row by its EXACT claim (organization, id, PENDING, token) and only while the claim is at most
 * `startGuardMs` old (J.6). No row (finished, re-claimed, another organization, claim too old) means: stop, no effects. Waits
 * only if another transaction holds this very row, which only a wake/end pass or the terminalizer can, both of which use
 * SKIP LOCKED and hold it for one statement.
 */
export async function lockStepTrigger(
  tx: DbExecutor,
  fence: { organizationId: string; id: string; claimToken: string },
  startGuardMs: number,
): Promise<StepTrigger | null> {
  const r = await tx.execute<{
    id: string;
    organization_id: string;
    whatsapp_account_id: string;
    conversation_id: string;
    message_id: string;
    input_occurred_at: string | Date;
    enqueued_at: string | Date;
    observed_control_seq: string | number;
    attempts: number;
    deferrals: number;
  }>(sql`
    SELECT t.id, t.organization_id, t.whatsapp_account_id, t.conversation_id, t.message_id, t.input_occurred_at,
           t.enqueued_at, t.observed_control_seq, t.attempts, t.deferrals
      FROM bot_triggers t
     WHERE t.organization_id = ${uuid(fence.organizationId, "organizationId")} AND t.id = ${uuid(fence.id, "id")}
       AND t.status = 'PENDING' AND t.claim_token = ${uuid(fence.claimToken, "claimToken")}
       AND t.claimed_at >= clock_timestamp() - ${startGuardMs} * interval '1 millisecond'
     FOR UPDATE`);
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    whatsappAccountId: row.whatsapp_account_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    inputOccurredAt: timestampToDate(row.input_occurred_at),
    enqueuedAt: timestampToDate(row.enqueued_at),
    observedControlSeq: Number(row.observed_control_seq),
    attempts: Number(row.attempts),
    deferrals: Number(row.deferrals),
  };
}

// --------------------------------------------------------------------------- plain reads that decide which locks to take

export type ConversationRef = { readonly contactId: string; readonly whatsappAccountId: string };

export async function readConversationRef(
  tx: DbExecutor,
  org: string,
  conversationId: string,
): Promise<ConversationRef | null> {
  const r = await tx.execute<{ contact_id: string; whatsapp_account_id: string }>(sql`
    SELECT contact_id, whatsapp_account_id FROM conversations
     WHERE organization_id = ${uuid(org, "organizationId")} AND id = ${uuid(conversationId, "conversationId")}`);
  const row = r.rows[0];
  return row ? { contactId: row.contact_id, whatsappAccountId: row.whatsapp_account_id } : null;
}

export type LiveSessionRef = { readonly id: string; readonly deploymentId: string };

/** The conversation's live session, if any (plain read; at most one by the partial unique index). */
export async function readLiveSessionRef(
  tx: DbExecutor,
  org: string,
  conversationId: string,
): Promise<LiveSessionRef | null> {
  const r = await tx.execute<{ id: string; deployment_id: string }>(sql`
    SELECT id, deployment_id FROM bot_sessions
     WHERE organization_id = ${uuid(org, "organizationId")} AND conversation_id = ${uuid(conversationId, "conversationId")}
       AND state IN (${LIVE_STATES_SQL})`);
  const row = r.rows[0];
  return row ? { id: row.id, deploymentId: row.deployment_id } : null;
}

/** The ids of the account's ACTIVE deployments (plain read; re-read under the locks). */
export async function activeDeploymentIds(
  tx: DbExecutor,
  org: string,
  accountId: string,
): Promise<string[]> {
  const r = await tx.execute<{ id: string }>(sql`
    SELECT id FROM bot_deployments
     WHERE organization_id = ${uuid(org, "organizationId")} AND whatsapp_account_id = ${uuid(accountId, "accountId")}
       AND status = 'ACTIVE' ORDER BY id`);
  return r.rows.map((x) => x.id);
}

// ---------------------------------------------------------------------------------------- steps 4 to 7: the row locks

/** Step 4. The deployments FOR SHARE in id order (Stop takes them FOR UPDATE in the same order, so the two meet here). */
export async function lockDeploymentsShare(
  tx: DbExecutor,
  org: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`
    SELECT id FROM bot_deployments
     WHERE organization_id = ${uuid(org, "organizationId")} AND id = ANY(${uuidArray(ids)}::uuid[])
     ORDER BY id FOR SHARE`);
}

export type DeploymentRow = {
  readonly id: string;
  readonly botId: string;
  readonly versionId: string;
  readonly status: "ACTIVE" | "PAUSED" | "STOPPED" | "RETIRED";
  readonly priority: number;
  readonly sendEpoch: number;
  readonly startEligibleFrom: Date;
};

/** The deployments' state, read AFTER their locks (a Stop that committed first is visible here). */
export async function readDeployments(
  tx: DbExecutor,
  org: string,
  ids: readonly string[],
): Promise<DeploymentRow[]> {
  if (ids.length === 0) return [];
  const r = await tx.execute<{
    id: string;
    bot_id: string;
    version_id: string;
    status: DeploymentRow["status"];
    priority: number;
    send_epoch: string | number;
    start_eligible_from: string | Date;
  }>(sql`
    SELECT id, bot_id, version_id, status, priority, send_epoch, start_eligible_from FROM bot_deployments
     WHERE organization_id = ${uuid(org, "organizationId")} AND id = ANY(${uuidArray(ids)}::uuid[]) ORDER BY id`);
  return r.rows.map((x) => ({
    id: x.id,
    botId: x.bot_id,
    versionId: x.version_id,
    status: x.status,
    priority: Number(x.priority),
    sendEpoch: Number(x.send_epoch),
    startEligibleFrom: timestampToDate(x.start_eligible_from),
  }));
}

export type LockedConversation = {
  readonly id: string;
  readonly contactId: string;
  readonly whatsappAccountId: string;
  readonly status: "OPEN" | "PENDING" | "RESOLVED";
  readonly assignedMembershipId: string | null;
  readonly controlSeq: number;
};

/** Step 5. */
export async function lockConversation(
  tx: DbExecutor,
  org: string,
  conversationId: string,
): Promise<LockedConversation | null> {
  const r = await tx.execute<{
    id: string;
    contact_id: string;
    whatsapp_account_id: string;
    status: LockedConversation["status"];
    assigned_membership_id: string | null;
    control_seq: string | number;
  }>(sql`
    SELECT id, contact_id, whatsapp_account_id, status, assigned_membership_id, control_seq FROM conversations
     WHERE organization_id = ${uuid(org, "organizationId")} AND id = ${uuid(conversationId, "conversationId")}
     FOR UPDATE`);
  const x = r.rows[0];
  return x
    ? {
        id: x.id,
        contactId: x.contact_id,
        whatsappAccountId: x.whatsapp_account_id,
        status: x.status,
        assignedMembershipId: x.assigned_membership_id,
        controlSeq: Number(x.control_seq),
      }
    : null;
}

/** The columns of a live session the step reads (the engine's model, the guards' and the fences' inputs). */
export type LiveSessionRow = {
  readonly id: string;
  readonly organizationId: string;
  readonly botId: string;
  readonly botVersionId: string;
  readonly deploymentId: string;
  readonly whatsappAccountId: string;
  readonly contactId: string;
  readonly conversationId: string;
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
  readonly revision: number;
  readonly startedControlSeq: number;
  readonly expiresAt: Date | null;
  readonly sendWaitExpiresAt: Date | null;
  readonly endReason: string | null;
  readonly handoverReason: string | null;
  readonly terminalNoticeStepSeq: number | null;
  readonly outputSuppressedAt: Date | null;
};

type SessionSqlRow = {
  id: string;
  organization_id: string;
  bot_id: string;
  bot_version_id: string;
  deployment_id: string;
  whatsapp_account_id: string;
  contact_id: string;
  conversation_id: string;
  state: string;
  current_node_id: string;
  variables: unknown;
  awaiting: unknown;
  awaiting_token: string | null;
  last_consumed_token: string | null;
  step_seq: number;
  transition_count: number;
  send_count: number;
  invalid_attempts: number;
  revision: number;
  started_control_seq: string | number;
  expires_at: string | Date | null;
  send_wait_expires_at: string | Date | null;
  end_reason: string | null;
  handover_reason: string | null;
  terminal_notice_step_seq: number | null;
  output_suppressed_at: string | Date | null;
};

const opt = (v: string | Date | null): Date | null => (v === null ? null : timestampToDate(v));

/** Step 6. The conversation's live session FOR UPDATE, re-read after the conversation lock (never the earlier plain read). */
export async function lockLiveSession(
  tx: DbExecutor,
  org: string,
  conversationId: string,
): Promise<LiveSessionRow | null> {
  const r = await tx.execute<SessionSqlRow>(sql`
    SELECT id, organization_id, bot_id, bot_version_id, deployment_id, whatsapp_account_id, contact_id, conversation_id,
           state, current_node_id, variables, awaiting, awaiting_token, last_consumed_token, step_seq, transition_count,
           send_count, invalid_attempts, revision, started_control_seq, expires_at, send_wait_expires_at, end_reason,
           handover_reason,
           terminal_notice_step_seq, output_suppressed_at
      FROM bot_sessions
     WHERE organization_id = ${uuid(org, "organizationId")} AND conversation_id = ${uuid(conversationId, "conversationId")}
       AND state IN (${LIVE_STATES_SQL})
     FOR UPDATE`);
  const x = r.rows[0];
  if (!x) return null;
  return {
    id: x.id,
    organizationId: x.organization_id,
    botId: x.bot_id,
    botVersionId: x.bot_version_id,
    deploymentId: x.deployment_id,
    whatsappAccountId: x.whatsapp_account_id,
    contactId: x.contact_id,
    conversationId: x.conversation_id,
    state: x.state,
    currentNodeId: x.current_node_id,
    variables: x.variables,
    awaiting: x.awaiting,
    awaitingToken: x.awaiting_token,
    lastConsumedToken: x.last_consumed_token,
    stepSeq: x.step_seq,
    transitionCount: x.transition_count,
    sendCount: x.send_count,
    invalidAttempts: x.invalid_attempts,
    revision: x.revision,
    startedControlSeq: Number(x.started_control_seq),
    expiresAt: opt(x.expires_at),
    sendWaitExpiresAt: opt(x.send_wait_expires_at),
    endReason: x.end_reason,
    handoverReason: x.handover_reason,
    terminalNoticeStepSeq: x.terminal_notice_step_seq,
    outputSuppressedAt: opt(x.output_suppressed_at),
  };
}

export type LockedAccount = { readonly active: boolean };

/** Step 7. */
export async function lockAccountShare(
  tx: DbExecutor,
  org: string,
  accountId: string,
): Promise<LockedAccount | null> {
  const r = await tx.execute<{ status: string; archived_at: string | Date | null }>(sql`
    SELECT status, archived_at FROM whatsapp_accounts
     WHERE organization_id = ${uuid(org, "organizationId")} AND id = ${uuid(accountId, "accountId")} FOR SHARE`);
  const x = r.rows[0];
  return x ? { active: x.status === "ACTIVE" && x.archived_at === null } : null;
}

// --------------------------------------------------------------------------------------------- step 9: plain reads

export type TriggerMessageRow = {
  readonly id: string;
  readonly direction: string;
  readonly type: string;
  readonly body: string | null;
  readonly content: unknown;
  readonly replyToWamid: string | null;
};

/** The trigger's persisted message, re-read by organization, conversation, account and id (never the webhook payload). */
export async function readTriggerMessage(
  tx: DbExecutor,
  t: {
    organizationId: string;
    conversationId: string;
    whatsappAccountId: string;
    messageId: string;
  },
): Promise<TriggerMessageRow | null> {
  const r = await tx.execute<{
    id: string;
    direction: string;
    type: string;
    body: string | null;
    content: unknown;
    reply_to_wamid: string | null;
  }>(sql`
    SELECT id, direction, type, body, content, reply_to_wamid FROM messages
     WHERE organization_id = ${uuid(t.organizationId, "organizationId")} AND conversation_id = ${uuid(t.conversationId, "conversationId")}
       AND whatsapp_account_id = ${uuid(t.whatsappAccountId, "accountId")} AND id = ${uuid(t.messageId, "messageId")}`);
  const x = r.rows[0];
  return x
    ? {
        id: x.id,
        direction: x.direction,
        type: x.type,
        body: x.body,
        content: x.content,
        replyToWamid: x.reply_to_wamid,
      }
    : null;
}

export type VersionRow = { readonly config: unknown; readonly sha256: string };

/** The pinned, immutable version of a bot (scoped by organization AND bot). */
export async function readVersion(
  tx: DbExecutor,
  org: string,
  botId: string,
  versionId: string,
): Promise<VersionRow | null> {
  const r = await tx.execute<{ config: unknown; config_sha256: string }>(sql`
    SELECT config, config_sha256 FROM bot_versions
     WHERE organization_id = ${uuid(org, "organizationId")} AND bot_id = ${uuid(botId, "botId")} AND id = ${uuid(versionId, "versionId")}`);
  const x = r.rows[0];
  return x ? { config: x.config, sha256: x.config_sha256 } : null;
}

export type StaffControlEventRow =
  | { readonly kind: "assignment" }
  | { readonly kind: "reply" }
  | { readonly kind: "status"; readonly to: "OPEN" | "PENDING" | "RESOLVED" };

/**
 * The staff control events sequenced AFTER `afterSeq` (the same predicate bot_request_hold_code and the BOT enqueue
 * use: control_seq > started_control_seq; STAFF-origin only for requests). Plain read under the conversation lock.
 */
export async function readStaffControlAfter(
  tx: DbExecutor,
  org: string,
  conversationId: string,
  afterSeq: number,
): Promise<StaffControlEventRow[]> {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new RangeError("afterSeq");
  const r = await tx.execute<{ kind: string; to_status: string | null }>(sql`
    SELECT e.kind, e.to_status FROM conversation_events e
     WHERE e.organization_id = ${uuid(org, "organizationId")} AND e.conversation_id = ${uuid(conversationId, "conversationId")}
       AND e.control_seq > ${afterSeq}
    UNION ALL
    SELECT 'REPLY', NULL FROM outbound_requests x
     WHERE x.organization_id = ${org} AND x.conversation_id = ${conversationId}
       AND x.origin = 'STAFF' AND x.control_seq > ${afterSeq}`);
  return r.rows.map((x) =>
    x.kind === "ASSIGNMENT"
      ? { kind: "assignment" as const }
      : x.kind === "REPLY"
        ? { kind: "reply" as const }
        : { kind: "status" as const, to: x.to_status as "OPEN" | "PENDING" | "RESOLVED" },
  );
}

export type StartFactsRows = {
  readonly maxStaffControlSeq: number | null;
  readonly latestHandoverSeq: number | null;
  readonly latestNonResolutionStaffSeq: number | null;
  readonly hasLegacyNonResolutionStaffRow: boolean;
  readonly latestResolution: { readonly seq: number; readonly createdAt: Date } | null;
  readonly botRequestInFlight: boolean;
  readonly lastSessionEndedAt: Date | null;
  readonly contactSessionStarts: readonly Date[];
  readonly lastConsumedInputAt: Date | null;
  readonly contactArchived: boolean;
};

const num = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * The start-eligibility facts of E.3, as plain reads under the conversation lock, with the contact's session window counted
 * from the DECISION clock passed in (and only after the contact try-lock is held, so a winner's committed start is visible).
 */
export async function readStartFacts(
  tx: DbExecutor,
  p: {
    organizationId: string;
    conversationId: string;
    contactId: string;
    decisionClock: Date;
    contactWindowMs: number;
  },
): Promise<StartFactsRows> {
  const org = uuid(p.organizationId, "organizationId");
  const conv = uuid(p.conversationId, "conversationId");
  const contact = uuid(p.contactId, "contactId");
  const seqs = await tx.execute<{
    max_staff: string | null;
    latest_non_resolution: string | null;
    legacy_non_resolution: boolean;
    latest_handover: string | null;
  }>(sql`
    WITH staff AS (
      SELECT e.control_seq AS seq, COALESCE(e.kind = 'STATUS' AND e.to_status = 'RESOLVED', false) AS resolution
        FROM conversation_events e WHERE e.organization_id = ${org} AND e.conversation_id = ${conv}
      UNION ALL
      SELECT x.control_seq, false
        FROM outbound_requests x WHERE x.organization_id = ${org} AND x.conversation_id = ${conv} AND x.origin = 'STAFF')
    SELECT (SELECT max(seq) FROM staff) AS max_staff,
           (SELECT max(seq) FROM staff WHERE NOT resolution) AS latest_non_resolution,
           EXISTS (SELECT 1 FROM staff WHERE NOT resolution AND seq IS NULL) AS legacy_non_resolution,
           (SELECT max(handover_control_seq) FROM bot_sessions
             WHERE organization_id = ${org} AND conversation_id = ${conv} AND state = 'HANDED_OVER') AS latest_handover`);
  const s = seqs.rows[0]!;
  const resolution = await tx.execute<{
    control_seq: string | number;
    created_at: string | Date;
  }>(sql`
    SELECT control_seq, created_at FROM conversation_events
     WHERE organization_id = ${org} AND conversation_id = ${conv} AND kind = 'STATUS' AND to_status = 'RESOLVED'
       AND control_seq IS NOT NULL
     ORDER BY control_seq DESC LIMIT 1`);
  const history = await tx.execute<{
    in_flight: boolean;
    last_ended: string | Date | null;
    last_input: string | Date | null;
    contact_archived: boolean;
  }>(sql`
    SELECT EXISTS (SELECT 1 FROM outbound_requests r
                    WHERE r.organization_id = ${org} AND r.conversation_id = ${conv} AND r.origin = 'BOT'
                      AND r.state IN ('QUEUED', 'SENDING')) AS in_flight,
           (SELECT max(ended_at) FROM bot_sessions WHERE organization_id = ${org} AND conversation_id = ${conv}) AS last_ended,
           (SELECT max(last_input_occurred_at) FROM bot_sessions
             WHERE organization_id = ${org} AND conversation_id = ${conv}) AS last_input,
           (SELECT archived_at IS NOT NULL FROM contacts WHERE organization_id = ${org} AND id = ${contact}) AS contact_archived`);
  const h = history.rows[0]!;
  const window = Math.trunc(p.contactWindowMs);
  if (!Number.isSafeInteger(window) || window < 1) throw new RangeError("contactWindowMs");
  const starts = await tx.execute<{ started_at: string | Date }>(sql`
    SELECT started_at FROM bot_sessions
     WHERE organization_id = ${org} AND contact_id = ${contact}
       AND started_at > ${p.decisionClock.toISOString()}::timestamptz - ${window} * interval '1 millisecond'`);
  const res = resolution.rows[0];
  return {
    maxStaffControlSeq: num(s.max_staff),
    latestHandoverSeq: num(s.latest_handover),
    latestNonResolutionStaffSeq: num(s.latest_non_resolution),
    hasLegacyNonResolutionStaffRow: s.legacy_non_resolution === true,
    latestResolution: res
      ? { seq: Number(res.control_seq), createdAt: timestampToDate(res.created_at) }
      : null,
    botRequestInFlight: h.in_flight === true,
    lastSessionEndedAt: opt(h.last_ended),
    contactSessionStarts: starts.rows.map((x) => timestampToDate(x.started_at)),
    lastConsumedInputAt: opt(h.last_input),
    contactArchived: h.contact_archived === true,
  };
}

export type FirstEligibleRows = {
  readonly firstInRecordHistory: boolean;
  readonly noPreviousSessionStart: boolean;
  readonly evidenceDefect: boolean;
};

/**
 * D.4a: the two independent history checks, in ONE fresh READ COMMITTED statement taken while the conversation is locked.
 * Record order is (messages.created_at, id) compared inside the database at full precision, never the provider timestamp; the
 * session check looks at sessions of every state (a historical or redacted one is still evidence). A previous session whose
 * start message is missing or not an eligible inbound message is a defect, reported separately (fail closed).
 */
export async function readFirstEligibleRows(
  tx: DbExecutor,
  p: { organizationId: string; conversationId: string; messageId: string },
): Promise<FirstEligibleRows> {
  const org = uuid(p.organizationId, "organizationId");
  const conv = uuid(p.conversationId, "conversationId");
  const msg = uuid(p.messageId, "messageId");
  const r = await tx.execute<{
    first_in_record: boolean;
    no_previous: boolean;
    defect: boolean;
  }>(sql`
    SELECT NOT EXISTS (
             SELECT 1 FROM messages m
              WHERE m.organization_id = ${org} AND m.conversation_id = ${conv}
                AND m.direction = 'INBOUND' AND m.type IN ('TEXT', 'INTERACTIVE', 'BUTTON')
                AND (m.created_at, m.id) < (SELECT c.created_at, c.id FROM messages c
                                             WHERE c.organization_id = ${org} AND c.conversation_id = ${conv} AND c.id = ${msg})
           ) AS first_in_record,
           NOT EXISTS (SELECT 1 FROM bot_sessions s WHERE s.organization_id = ${org} AND s.conversation_id = ${conv}) AS no_previous,
           EXISTS (
             SELECT 1 FROM bot_sessions s
               LEFT JOIN messages sm ON sm.organization_id = s.organization_id AND sm.conversation_id = s.conversation_id
                                     AND sm.id = s.started_by_message_id
              WHERE s.organization_id = ${org} AND s.conversation_id = ${conv}
                AND (sm.id IS NULL OR NOT (sm.direction = 'INBOUND' AND sm.type IN ('TEXT', 'INTERACTIVE', 'BUTTON')))
           ) AS defect`);
  const x = r.rows[0]!;
  return {
    firstInRecordHistory: x.first_in_record === true,
    noPreviousSessionStart: x.no_previous === true,
    evidenceDefect: x.defect === true,
  };
}

/** C-3 evidence: every attribution row of this exact message in this organization (the caller checks the contact). */
export async function readAttributions(
  tx: DbExecutor,
  org: string,
  messageId: string,
): Promise<{ organizationId: string; messageId: string; contactId: string }[]> {
  const r = await tx.execute<{
    organization_id: string;
    message_id: string;
    contact_id: string;
  }>(sql`
    SELECT organization_id, message_id, contact_id FROM lead_attributions
     WHERE organization_id = ${uuid(org, "organizationId")} AND message_id = ${uuid(messageId, "messageId")}`);
  return r.rows.map((x) => ({
    organizationId: x.organization_id,
    messageId: x.message_id,
    contactId: x.contact_id,
  }));
}
