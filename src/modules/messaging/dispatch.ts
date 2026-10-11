import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@/db";
import { backResolveReplies } from "@/db/ops/inbound-message";
import { resolveStatusEventsForMessage } from "@/db/ops/message-status";
import { sqlState } from "@/modules/whatsapp/ingest";
import { emitWebhookLog } from "@/modules/whatsapp/logging";
import type { OutboundConfig } from "./config";
import {
  assess,
  loadAccount,
  loadConversationContext,
  loadTemplate,
  type HoldCode,
} from "./eligibility";
import {
  CLAIM_LOCK_TIMEOUT_MS,
  DEFAULT_ACCOUNT_MIN_INTERVAL_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  DEFAULT_CONVERSATION_MIN_INTERVAL_MS,
  HTTP_TIMEOUT_MS,
  MAX_CONCURRENCY,
  MAX_NOT_SENT_ATTEMPTS,
  SEND_START_BUDGET_MS,
  SENDING_RECOVERY_AFTER_MS,
  THROTTLE_RETRY_VERIFIED,
  retryDelayMs,
} from "./policy";
import type { OutboundTransport, SendMessage, SendRequest, SendResult } from "./transport";

// The outbound dispatcher. THE RULE THAT SHAPES IT: sending has an external side effect that cannot be rolled back, and Meta
// documents no idempotency for POST /messages. So a request is only ever re-sent when the code can PROVE it never left this
// process; anything that might have reached Meta ends as UNKNOWN_OUTCOME and stays there.
//
//   1. CLAIM (one short transaction, no network): lock a QUEUED row (SKIP LOCKED), re-validate account, recipient, window,
//      consent and deadline, and, if still allowed, mark it SENDING with send_started_at. Commit. If this transaction is lost,
//      nothing was sent and the row is still QUEUED.
//   2. SEND (no transaction open): first a PRE-TRANSMISSION AUTHORIZATION (a short read: the row is still SENDING and still
//      ours, the claim is young enough, the deadline and the account still allow it); only then one HTTP request through the
//      transport. A worker that resumes after its claim was recovered or finished by someone else therefore sends nothing.
//      What this cannot do: a database read cannot be atomic with an HTTP request. A process that is suspended for longer
//      than (SENDING_RECOVERY_AFTER_MS - SEND_START_BUDGET_MS) between the final check and the first byte can still send on a
//      claim that recovery has already marked UNKNOWN_OUTCOME. That row stays UNKNOWN_OUTCOME (which is true), is never
//      retried by this code, and the post-send fence refuses to overwrite it. It does NOT make a duplicate impossible: that
//      late request can reach the recipient, and if an operator has meanwhile sent a replacement, both messages can arrive.
//      Nothing here guarantees exactly-once delivery (see docs/PRE_PRODUCTION_BLOCKERS.md blocker 42).
//   3. RECORD (one fenced transaction): ACCEPTED (+ wamid, status reconciliation), REJECTED, back to QUEUED (only for a
//      refusal that came BEFORE any HTTP attempt began: gates, credentials, payload, abort, authorization), HELD, or UNKNOWN_OUTCOME. An answer that came back from Meta is
//      never queued again (a throttle is UNKNOWN_OUTCOME while THROTTLE_RETRY_VERIFIED is false). The fence is (id, state = SENDING, claimed_by).
// A process that dies between 1 and 3 leaves a SENDING row; recoverStuck() turns it into UNKNOWN_OUTCOME. It is never retried.

export type DispatchDeps = {
  readonly db: Database;
  readonly transport: OutboundTransport;
  readonly config: OutboundConfig;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly newOwner?: () => string;
  readonly accountMinIntervalMs?: number;
  readonly conversationMinIntervalMs?: number;
  /** TEST ONLY: exercises the preserved throttle-retry path. Production never sets it (policy.ts THROTTLE_RETRY_VERIFIED is false). */
  readonly throttleRetryVerified?: boolean;
  /** How long the claim transaction may wait for a database lock (default CLAIM_LOCK_TIMEOUT_MS). */
  readonly lockTimeoutMs?: number;
};

export type Claim = {
  readonly requestId: string;
  readonly organizationId: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly owner: string;
  readonly attempt: number;
  readonly request: SendRequest;
};

export type BatchSummary = {
  claimed: number;
  accepted: number;
  rejected: number;
  retryScheduled: number;
  unknown: number;
  held: number;
  recoveredUnknown: number;
  fenceLost: number;
};
const emptySummary = (): BatchSummary => ({
  claimed: 0,
  accepted: 0,
  rejected: 0,
  retryScheduled: 0,
  unknown: 0,
  held: 0,
  recoveredUnknown: 0,
  fenceLost: 0,
});

type Row = typeof schema.outboundRequests.$inferSelect;
const t = schema.outboundRequests;

function log(
  event: Parameters<typeof emitWebhookLog>[0]["event"],
  outcome: "success" | "denied" | "failure",
  row: Pick<Row, "id" | "organizationId" | "whatsappAccountId">,
  reason?: string,
  attempt?: number,
) {
  emitWebhookLog({
    event,
    outcome,
    organizationId: row.organizationId,
    whatsappAccountId: row.whatsappAccountId,
    outboundRequestId: row.id,
    reason,
    attempt,
  });
}

// ------------------------------------------------------------------------------------------------ recovery

/** SENDING rows older than the recovery age: the dispatching process is gone. They may have been sent: UNKNOWN_OUTCOME, final. */
export async function recoverStuck(deps: DispatchDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - SENDING_RECOVERY_AFTER_MS);
  const rows = await deps.db
    .update(t)
    .set({
      state: "UNKNOWN_OUTCOME",
      failureCode: "process_died_after_dispatch_start",
      finishedAt: now,
    })
    .where(
      and(eq(t.state, "SENDING"), sql`${t.sendStartedAt} < ${cutoff.toISOString()}::timestamptz`),
    )
    .returning({
      id: t.id,
      organizationId: t.organizationId,
      whatsappAccountId: t.whatsappAccountId,
    });
  for (const row of rows)
    log("outbound.recovered_unknown", "failure", row, "process_died_after_dispatch_start");
  return rows.length;
}

// ---------------------------------------------------------------------------------------------------- claim

async function hold(
  tx: Pick<Database, "update">,
  row: Row,
  code: HoldCode | string,
  now: Date,
): Promise<void> {
  await tx
    .update(t)
    .set({ state: "HELD", holdReason: code, finishedAt: now })
    .where(and(eq(t.id, row.id), eq(t.state, "QUEUED")));
  log("outbound.held", "denied", row, code);
}

function sendMessage(
  row: Row,
  template: { name: string; languageCode: string } | null,
): SendMessage {
  const payload = row.payload as {
    body?: string;
    replyToWamid?: string | null;
    parameters?: string[];
  };
  if (row.messageType === "TEXT")
    return { type: "text", body: payload.body ?? "", replyToWamid: payload.replyToWamid ?? null };
  return {
    type: "template",
    name: template!.name,
    languageCode: template!.languageCode,
    bodyParameters: payload.parameters ?? [],
  };
}

/**
 * Claims at most one request. Everything that can say "do not send" is decided here, in the same transaction that writes
 * SENDING, so the answer cannot go stale between the check and the claim. Returns held counts so the caller can report them.
 *
 * TIME: the clock is read AFTER every read that can block on a lock (the account row is taken FOR SHARE, so a concurrent
 * disable/archive makes this wait), and that fresh reading is what the deadline, the service window, the pacing check and
 * send_started_at all use. Nothing after it can block: the only remaining write is to the row this transaction already holds
 * FOR UPDATE. The wait itself is bounded (lock_timeout); a request that could not be examined in time stays QUEUED.
 */
export async function claimNext(
  deps: DispatchDeps,
): Promise<{ claim: Claim | null; held: number }> {
  const clock = deps.now ?? (() => new Date());
  const owner = (deps.newOwner ?? randomUUID)();
  const accountGap = deps.accountMinIntervalMs ?? DEFAULT_ACCOUNT_MIN_INTERVAL_MS;
  const conversationGap = deps.conversationMinIntervalMs ?? DEFAULT_CONVERSATION_MIN_INTERVAL_MS;
  const lockTimeout = deps.lockTimeoutMs ?? CLAIM_LOCK_TIMEOUT_MS;
  const iso = (d: Date) => d.toISOString();

  try {
    return await deps.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('lock_timeout', ${String(lockTimeout)}, true)`);
      // Candidates are READ without locks; each one is then locked individually (SKIP LOCKED) just before it is examined, so a
      // claimer only ever holds the row it is working on and other dispatchers can take the others at the same time.
      const candidates = await tx.execute<{ id: string }>(sql`
      SELECT id FROM outbound_requests
      WHERE state = 'QUEUED' AND next_attempt_at <= ${iso(clock())}::timestamptz
      ORDER BY next_attempt_at, id
      LIMIT 20`);
      let held = 0;
      for (const { id } of candidates.rows) {
        const locked = await tx.execute<{ id: string }>(
          sql`SELECT id FROM outbound_requests WHERE id = ${id} AND state = 'QUEUED' FOR UPDATE SKIP LOCKED`,
        );
        if (locked.rows.length === 0) continue; // taken by another dispatcher, or no longer queued
        const [row] = await tx.select().from(t).where(eq(t.id, id));
        if (!row) continue;

        // One claimer per account at a time, so the spacing check below cannot be raced; a busy account is skipped, not waited for.
        const lock = await tx.execute<{ ok: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`wa-outbound-account:${row.whatsappAccountId}`}, 0)) AS ok`,
        );
        if (!lock.rows[0]?.ok) continue;

        // Everything that can wait on a lock comes first...
        const account = await loadAccount(tx, row.organizationId, row.whatsappAccountId, true);
        const context = await loadConversationContext(tx, row.organizationId, row.conversationId);
        const template =
          row.templateId === null
            ? null
            : await loadTemplate(tx, row.organizationId, row.whatsappAccountId, row.templateId);
        // ...and only then is the time taken that the decision rests on.
        const now = clock();

        const recent = await tx.execute(sql`
        SELECT 1 FROM outbound_requests
        WHERE id <> ${row.id}
          AND ((whatsapp_account_id = ${row.whatsappAccountId}
                 AND send_started_at > ${iso(new Date(now.getTime() - accountGap))}::timestamptz)
            OR (conversation_id = ${row.conversationId}
                 AND send_started_at > ${iso(new Date(now.getTime() - conversationGap))}::timestamptz))
        LIMIT 1`);
        if (recent.rows.length > 0) continue; // spacing: leave it QUEUED for a later tick

        if (now.getTime() > row.dispatchDeadline.getTime()) {
          await hold(tx, row, "deadline_passed", now);
          held++;
          continue;
        }
        if (!context) {
          await hold(tx, row, "no_identity", now);
          held++;
          continue;
        }
        const payload = row.payload as { parameters?: string[] };
        const assessment = assess({
          account,
          context,
          message:
            row.messageType === "TEXT"
              ? { type: "text" }
              : { type: "template", template, parameterCount: payload.parameters?.length ?? 0 },
          bsuidRecipientEnabled: deps.config.bsuidRecipientEnabled,
          now,
        });
        if (!assessment.ok) {
          await hold(tx, row, assessment.code, now);
          held++;
          continue;
        }
        // The identity is re-resolved from the trusted records; if it is no longer what was queued, nothing is sent.
        if (
          assessment.recipient.kind !== row.recipientKind ||
          assessment.recipient.id !== row.recipientId
        ) {
          await hold(tx, row, "recipient_changed", now);
          held++;
          continue;
        }

        const attempt = row.attemptCount + 1;
        await tx
          .update(t)
          .set({
            state: "SENDING",
            claimedBy: owner,
            claimedAt: now,
            sendStartedAt: now,
            attemptCount: attempt,
          })
          .where(and(eq(t.id, row.id), eq(t.state, "QUEUED")));
        log("outbound.sending", "success", row, undefined, attempt);
        return {
          held,
          claim: {
            requestId: row.id,
            organizationId: row.organizationId,
            accountId: row.whatsappAccountId,
            conversationId: row.conversationId,
            messageId: row.messageId,
            owner,
            attempt,
            request: {
              phoneNumberId: account!.phoneNumberId,
              credentialRef: account!.credentialRef,
              recipient: assessment.recipient,
              message: sendMessage(row, template),
            },
          },
        };
      }
      return { claim: null, held };
    });
  } catch (error) {
    // lock_not_available (55P03): a lock was held too long. The transaction rolled back, so every row it looked at is still
    // QUEUED exactly as before (nothing was claimed, nothing was held); the next tick tries again.
    if (sqlState(error) === "55P03") return { claim: null, held: 0 };
    throw error;
  }
}

// ------------------------------------------------------------------------------------------------ record

type Outcome = "accepted" | "rejected" | "retry_scheduled" | "unknown" | "held" | "fence_lost";

/** The fence: only the claimer that moved the row to SENDING may finish it, and only while it is still SENDING. */
const fenced = (c: Claim) =>
  and(eq(t.id, c.requestId), eq(t.state, "SENDING"), eq(t.claimedBy, c.owner));

async function record(deps: DispatchDeps, claim: Claim, answer: SendResult): Promise<Outcome> {
  // Belt and braces for the policy in policy.ts: an answer that came back from Meta is never queued again unless throttle
  // retry has been verified, whatever transport produced it. (A not_sent result never reached Meta and is unaffected.)
  const result: SendResult =
    answer.kind === "throttled" && !(deps.throttleRetryVerified ?? THROTTLE_RETRY_VERIFIED)
      ? {
          kind: "unknown",
          reason: "rate_limited_semantics_unverified",
          httpStatus: answer.httpStatus,
          providerErrorCode: answer.providerErrorCode,
        }
      : answer;
  const now = (deps.now ?? (() => new Date()))();
  const row = {
    id: claim.requestId,
    organizationId: claim.organizationId,
    whatsappAccountId: claim.accountId,
  };
  const db = deps.db;

  if (result.kind === "accepted") {
    try {
      const done = await db.transaction(async (tx) => {
        // The SAME per-message lock the STATUS handler takes: a status for this wamid is either stored before this
        // transaction (and reconciled below) or waits until it commits, then links directly.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wa-message:${claim.organizationId}:${claim.accountId}:${result.wamid}`}, 0))`,
        );
        const updated = await tx
          .update(t)
          .set({
            state: "ACCEPTED",
            acceptedAt: now,
            finishedAt: now,
            providerHttpStatus: result.httpStatus,
            providerMessageStatus: result.providerStatus,
          })
          .where(fenced(claim))
          .returning({ id: t.id });
        if (updated.length === 0) return false;
        await tx
          .update(schema.messages)
          .set({ wamid: result.wamid })
          .where(
            and(
              eq(schema.messages.organizationId, claim.organizationId),
              eq(schema.messages.id, claim.messageId),
              eq(schema.messages.direction, "OUTBOUND"),
              sql`${schema.messages.wamid} IS NULL`,
            ),
          );
        await resolveStatusEventsForMessage(tx, {
          id: claim.messageId,
          organizationId: claim.organizationId,
          whatsappAccountId: claim.accountId,
          wamid: result.wamid,
        });
        // A customer may have replied to this message before its id was stored here: link those replies (the existing
        // inbound operation: same conversation and organization only, never to itself, never over an existing link).
        await backResolveReplies(tx, {
          organizationId: claim.organizationId,
          conversationId: claim.conversationId,
          messageId: claim.messageId,
          wamid: result.wamid,
        });
        // Sending moves the conversation's message / outbound timestamps forward and nothing else: not last_inbound_at
        // (so it never opens or extends the service window), not the status, not resolved_at (it does not reopen).
        await tx
          .update(schema.conversations)
          .set({
            lastOutboundAt: sql`GREATEST(${schema.conversations.lastOutboundAt}, ${now.toISOString()}::timestamptz)`,
            lastMessageAt: sql`GREATEST(${schema.conversations.lastMessageAt}, ${now.toISOString()}::timestamptz)`,
          })
          .where(
            and(
              eq(schema.conversations.organizationId, claim.organizationId),
              eq(schema.conversations.id, claim.conversationId),
            ),
          );
        return true;
      });
      if (!done) return "fence_lost";
      log("outbound.accepted", "success", row);
      return "accepted";
    } catch {
      // Meta DID accept it, but the id could not be recorded (for example the id already belongs to another message). We
      // do not invent a link: the request is UNKNOWN_OUTCOME and an operator reconciles it.
      const moved = await db
        .update(t)
        .set({
          state: "UNKNOWN_OUTCOME",
          failureCode: "accepted_but_not_recorded",
          finishedAt: now,
        })
        .where(fenced(claim))
        .returning({ id: t.id });
      log("outbound.unknown_outcome", "failure", row, "accepted_but_not_recorded");
      return moved.length === 0 ? "fence_lost" : "unknown";
    }
  }

  if (result.kind === "rejected") {
    const moved = await db.transaction(async (tx) => {
      const updated = await tx
        .update(t)
        .set({
          state: "REJECTED",
          failureCode: result.reason,
          providerHttpStatus: result.httpStatus,
          providerErrorCode: result.providerErrorCode,
          finishedAt: now,
        })
        .where(fenced(claim))
        .returning({ id: t.id });
      if (updated.length === 0) return false;
      await tx
        .update(schema.messages)
        .set({ errorCode: result.providerErrorCode ?? result.reason, errorMessage: result.reason })
        .where(
          and(
            eq(schema.messages.organizationId, claim.organizationId),
            eq(schema.messages.id, claim.messageId),
          ),
        );
      return true;
    });
    if (!moved) return "fence_lost";
    log("outbound.rejected", "failure", row, result.reason);
    return "rejected";
  }

  if (result.kind === "throttled" || result.kind === "not_sent") {
    const reason = result.kind === "throttled" ? "rate_limited" : result.reason;
    if (claim.attempt >= MAX_NOT_SENT_ATTEMPTS) {
      // Refused before any HTTP attempt began, but out of attempts: HELD (a new request is the next action), not an endless loop.
      const moved = await db
        .update(t)
        .set({
          state: "HELD",
          holdReason:
            result.kind === "throttled" ? "rate_limited_exhausted" : "send_failed_before_dispatch",
          finishedAt: now,
          providerErrorCode: result.kind === "throttled" ? result.providerErrorCode : null,
          providerHttpStatus: result.kind === "throttled" ? result.httpStatus : null,
        })
        .where(fenced(claim))
        .returning({ id: t.id });
      if (moved.length === 0) return "fence_lost";
      log("outbound.held", "denied", row, reason, claim.attempt);
      return "held";
    }
    const delay = retryDelayMs(
      claim.attempt,
      result.kind === "throttled" ? result.retryAfterMs : null,
      deps.random ?? Math.random,
    );
    const moved = await db
      .update(t)
      .set({
        state: "QUEUED",
        claimedBy: null,
        claimedAt: null,
        nextAttemptAt: new Date(now.getTime() + delay),
        providerErrorCode: result.kind === "throttled" ? result.providerErrorCode : null,
        providerHttpStatus: result.kind === "throttled" ? result.httpStatus : null,
        failureCode: null,
      })
      .where(fenced(claim))
      .returning({ id: t.id });
    if (moved.length === 0) return "fence_lost";
    log("outbound.retry_scheduled", "failure", row, reason, claim.attempt);
    return "retry_scheduled";
  }

  // unknown
  const moved = await db
    .update(t)
    .set({
      state: "UNKNOWN_OUTCOME",
      failureCode: result.reason.replace(/[^a-z0-9_]/g, "_").slice(0, 64),
      providerHttpStatus: result.httpStatus,
      providerErrorCode: result.providerErrorCode ?? null,
      finishedAt: now,
    })
    .where(fenced(claim))
    .returning({ id: t.id });
  if (moved.length === 0) return "fence_lost";
  log("outbound.unknown_outcome", "failure", row, result.reason);
  return "unknown";
}

// ------------------------------------------------------------------------------------------------ execute

/**
 * The pre-transmission authorization: a fresh read, immediately before the HTTP request, of whether this worker may still
 * send this claim. "stale" means the row is no longer the one this claim created (recovered, finished, re-claimed or gone):
 * the caller does nothing at all. "refused" means the claim is ours but must not be sent now; nothing was sent, so the
 * caller records that through the normal fenced not-sent path. The time used is read AFTER the query returns and the
 * decision is synchronous from there to the call of the transport.
 */
async function authorizeSend(
  deps: DispatchDeps,
  claim: Claim,
): Promise<{ kind: "ok" } | { kind: "stale" } | { kind: "refused"; reason: string }> {
  const [row] = await deps.db
    .select({
      state: t.state,
      claimedBy: t.claimedBy,
      sendStartedAt: t.sendStartedAt,
      dispatchDeadline: t.dispatchDeadline,
      accountStatus: schema.whatsappAccounts.status,
      accountArchivedAt: schema.whatsappAccounts.archivedAt,
    })
    .from(t)
    .innerJoin(
      schema.whatsappAccounts,
      and(
        eq(schema.whatsappAccounts.organizationId, t.organizationId),
        eq(schema.whatsappAccounts.id, t.whatsappAccountId),
      ),
    )
    .where(and(eq(t.organizationId, claim.organizationId), eq(t.id, claim.requestId)));
  const now = (deps.now ?? (() => new Date()))();
  if (!row || row.state !== "SENDING" || row.claimedBy !== claim.owner || !row.sendStartedAt)
    return { kind: "stale" };
  if (!deps.config.outboundEnabled) return { kind: "refused", reason: "outbound_disabled" };
  if (row.accountStatus !== "ACTIVE" || row.accountArchivedAt !== null)
    return { kind: "refused", reason: "account_inactive_before_dispatch" };
  if (now.getTime() - row.sendStartedAt.getTime() > SEND_START_BUDGET_MS)
    return { kind: "refused", reason: "claim_expired_before_dispatch" };
  if (now.getTime() > row.dispatchDeadline.getTime())
    return { kind: "refused", reason: "deadline_passed_before_dispatch" };
  return { kind: "ok" };
}

/**
 * One HTTP attempt for a claim, then the fenced record of its result. Never throws. The transport is only reached through
 * authorizeSend(); a result is only recorded through the fence, so a worker that lost its claim neither sends nor writes.
 */
export async function executeClaim(deps: DispatchDeps, claim: Claim): Promise<Outcome> {
  let authorization: Awaited<ReturnType<typeof authorizeSend>>;
  try {
    authorization = await authorizeSend(deps, claim);
  } catch {
    // The authorization could not be read (database trouble). Nothing was sent. The row stays SENDING and recovery
    // will turn it into UNKNOWN_OUTCOME: conservative, and never a retry.
    return "fence_lost";
  }
  if (authorization.kind === "stale") return "fence_lost";
  if (authorization.kind === "refused") {
    try {
      return await record(deps, claim, { kind: "not_sent", reason: authorization.reason });
    } catch {
      return "fence_lost";
    }
  }
  const controller = new AbortController();
  let guard: NodeJS.Timeout | undefined;
  let result: SendResult;
  // Set by the transport the instant it begins an HTTP attempt. From then on "not sent" can no longer be believed.
  let httpStarted = false;
  try {
    result = await Promise.race([
      deps.transport.send(claim.request, controller.signal, {
        httpStarted: () => {
          httpStarted = true;
        },
      }),
      new Promise<SendResult>((resolve) => {
        guard = setTimeout(() => {
          controller.abort();
          resolve({ kind: "unknown", reason: "send_deadline", httpStatus: null });
        }, HTTP_TIMEOUT_MS + 5_000);
      }),
    ]);
  } catch {
    // A transport that throws gives us no proof that nothing was sent.
    result = { kind: "unknown", reason: "transport_threw", httpStatus: null };
  } finally {
    clearTimeout(guard);
  }
  // A transport that began an HTTP attempt cannot also prove it sent nothing (a fake, a bug, a later transport): uncertain.
  if (httpStarted && (result.kind === "not_sent" || result.kind === "throttled"))
    result = { kind: "unknown", reason: "result_after_http_started", httpStatus: null };
  try {
    return await record(deps, claim, result);
  } catch {
    // The result could not be written (database trouble). The row stays SENDING; recoverStuck() will mark it
    // UNKNOWN_OUTCOME. We never turn this into a retry.
    return "unknown";
  }
}

/** Up to `batchSize` claim-and-send rounds with at most `concurrency` in flight. Stops claiming once `stopSignal` aborts. */
export async function dispatchBatch(
  deps: DispatchDeps,
  options: { batchSize?: number; concurrency?: number; stopSignal?: AbortSignal } = {},
): Promise<BatchSummary> {
  const summary = emptySummary();
  if (!deps.config.outboundEnabled) return summary; // belt and braces: the worker also refuses to start
  const batchSize = Math.min(Math.max(options.batchSize ?? DEFAULT_BATCH_SIZE, 1), 100);
  const concurrency = Math.min(
    Math.max(options.concurrency ?? DEFAULT_CONCURRENCY, 1),
    MAX_CONCURRENCY,
  );
  summary.recoveredUnknown += await recoverStuck(deps);
  let budget = batchSize;
  const lane = async () => {
    while (budget > 0 && !options.stopSignal?.aborted) {
      budget--;
      const { claim, held } = await claimNext(deps);
      summary.held += held;
      if (!claim) {
        if (held === 0) budget = 0; // nothing due: every lane stops
        continue;
      }
      summary.claimed++;
      const outcome = await executeClaim(deps, claim);
      if (outcome === "accepted") summary.accepted++;
      else if (outcome === "rejected") summary.rejected++;
      else if (outcome === "retry_scheduled") summary.retryScheduled++;
      else if (outcome === "unknown") summary.unknown++;
      else if (outcome === "held") summary.held++;
      else summary.fenceLost++;
    }
  };
  const lanes = await Promise.allSettled(Array.from({ length: concurrency }, lane));
  const failed = lanes.find((l): l is PromiseRejectedResult => l.status === "rejected");
  if (failed) throw failed.reason;
  return summary;
}
