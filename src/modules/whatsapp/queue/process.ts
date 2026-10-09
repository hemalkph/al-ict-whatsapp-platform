import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { schema, type DbExecutor } from "@/db";
import {
  claimWebhookEventRows,
  completeWebhookEvent,
  deadWebhookEvent,
  failWebhookEvent,
  holdWebhookEvent,
  type ClaimedWebhookEvent,
  type Fence,
} from "@/db/ops/webhook-queue";
import { emitWebhookLog, type WebhookLog } from "../logging";
import { HandlerTimeoutError, LeaseLostError, classifyFailure, safeCode } from "./errors";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  HANDLER_TIMEOUT_MS,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  MAX_BATCH_SIZE,
  MAX_CONCURRENCY,
  STATEMENT_TIMEOUT_MS,
  retryDelayMs,
} from "./policy";
import { withDeadline } from "./timeout";

// Worker core. It claims events, runs the handler registered for the event's type and records the outcome. It knows
// nothing about contacts, conversations, messages or statuses: those arrive later as handlers in a registry that the
// CALLER passes in. There is deliberately no default registry and no no-op handler: an event type without a handler
// is never claimed, so it simply stays PENDING instead of being marked PROCESSED without domain logic.

export type WebhookEventKind = (typeof schema.WEBHOOK_EVENT_TYPES)[number];

export type WebhookHandlerEvent = {
  id: string;
  eventType: WebhookEventKind;
  organizationId: string;
  whatsappAccountId: string;
  payload: unknown;
  receivedAt: Date;
};

export type WebhookHandlerContext = {
  /** 1-based claim number of this run (at most MAX_ATTEMPTS). */
  attempt: number;
  maxAttempts: number;
  /** Aborted when the per-event time budget is exhausted; the transaction is then rolled back regardless. */
  signal: AbortSignal;
  now: () => Date;
};

/**
 * `tx` is the SAME transaction that records the event as PROCESSED (fenced). A handler writes its domain rows through
 * `tx` only; if the lease was lost, or the handler throws, everything it wrote rolls back together. A handler must not
 * open a separate transaction or connection for domain writes. Throw PermanentWebhookError when retrying cannot help;
 * any other throw is a transient failure.
 */
export type WebhookHandler = (
  tx: DbExecutor,
  event: WebhookHandlerEvent,
  context: WebhookHandlerContext,
) => Promise<void>;

export type WebhookHandlerRegistry = Partial<Record<WebhookEventKind, WebhookHandler>>;

export type ProcessDeps = {
  now: () => Date;
  random: () => number;
  /** A fresh value per claim: the lease owner stamped into locked_by. */
  newLockOwner: () => string;
  leaseSeconds: number;
  handlerTimeoutMs: number;
  statementTimeoutMs: number;
};

export type EventOutcome =
  "processed" | "failed" | "dead" | "held" | "ignored" | "lease_lost" | "unrecorded";

export type BatchSummary = {
  claimed: number;
  processed: number;
  failed: number;
  dead: number;
  held: number;
  ignored: number;
  leaseLost: number;
  /** The outcome could not be written (database trouble); the lease expiry will recover the event. */
  unrecorded: number;
};

const emptySummary = (): BatchSummary => ({
  claimed: 0,
  processed: 0,
  failed: 0,
  dead: 0,
  held: 0,
  ignored: 0,
  leaseLost: 0,
  unrecorded: 0,
});

const SUMMARY_KEY: Record<EventOutcome, keyof BatchSummary> = {
  processed: "processed",
  failed: "failed",
  dead: "dead",
  held: "held",
  ignored: "ignored",
  lease_lost: "leaseLost",
  unrecorded: "unrecorded",
};

const LOG_EVENT: Record<EventOutcome, WebhookLog["event"]> = {
  processed: "webhook.event_processed",
  failed: "webhook.event_failed",
  dead: "webhook.event_dead",
  held: "webhook.event_held",
  ignored: "webhook.event_ignored",
  lease_lost: "webhook.event_lease_lost",
  unrecorded: "webhook.event_unrecorded",
};

type Resolution = { outcome: EventOutcome; reason?: string };

/** The account state at processing time decides whether the event may run at all (same table as ingest routing). */
function accountGate(account: {
  status: "PENDING" | "ACTIVE" | "DISABLED";
  archivedAt: Date | null;
}): { status: "UNROUTABLE" | "IGNORED"; reason: string } | null {
  if (account.archivedAt !== null) return { status: "IGNORED", reason: "account_archived" };
  if (account.status === "DISABLED") return { status: "IGNORED", reason: "account_disabled" };
  if (account.status === "PENDING") return { status: "UNROUTABLE", reason: "account_pending" };
  return null;
}

const isKind = (type: string): type is WebhookEventKind =>
  (schema.WEBHOOK_EVENT_TYPES as readonly string[]).includes(type);

async function resolve(
  db: DbExecutor,
  event: ClaimedWebhookEvent,
  handlers: WebhookHandlerRegistry,
  deps: ProcessDeps,
  fence: Fence,
): Promise<Resolution> {
  const lost: Resolution = { outcome: "lease_lost" };
  const dead = async (reason: string): Promise<Resolution> =>
    (await deadWebhookEvent(db, { ...fence, reason })) ? { outcome: "dead", reason } : lost;

  // Exhaustion is recognized WITHOUT running the handler: a crashed final run is only noticed by the next reclaim,
  // which increments attempts to MAX_ATTEMPTS + 1.
  if (event.attempts > MAX_ATTEMPTS) return dead("max_attempts_exhausted");

  if (event.organizationId === null || event.whatsappAccountId === null)
    return dead("missing_routing");
  const [account] = await db
    .select({
      status: schema.whatsappAccounts.status,
      archivedAt: schema.whatsappAccounts.archivedAt,
    })
    .from(schema.whatsappAccounts)
    .where(eq(schema.whatsappAccounts.id, event.whatsappAccountId));
  if (!account) return dead("account_missing");

  // A hold is not a handler attempt: holdWebhookEvent gives the claim's attempt back.
  const gate = accountGate(account);
  if (gate) {
    const held = await holdWebhookEvent(db, { ...fence, ...gate });
    if (!held) return lost;
    return { outcome: gate.status === "UNROUTABLE" ? "held" : "ignored", reason: gate.reason };
  }

  const handler = isKind(event.eventType) ? handlers[event.eventType] : undefined;
  let failure: { permanent: boolean; code: string };
  if (!handler || !isKind(event.eventType)) {
    failure = { permanent: false, code: "handler_not_installed" };
  } else {
    const controller = new AbortController();
    const handlerEvent: WebhookHandlerEvent = {
      id: event.id,
      eventType: event.eventType,
      organizationId: event.organizationId,
      whatsappAccountId: event.whatsappAccountId,
      payload: event.payload,
      receivedAt: event.receivedAt,
    };
    const context: WebhookHandlerContext = {
      attempt: event.attempts,
      maxAttempts: MAX_ATTEMPTS,
      signal: controller.signal,
      now: deps.now,
    };
    try {
      await withDeadline(
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('statement_timeout', ${String(deps.statementTimeoutMs)}, true)`,
          );
          await handler(tx, handlerEvent, context);
          if (controller.signal.aborted) throw new HandlerTimeoutError();
          // Same transaction as the handler's writes: losing the fence rolls all of them back.
          if (!(await completeWebhookEvent(tx, fence))) throw new LeaseLostError();
        }),
        deps.handlerTimeoutMs,
        () => controller.abort(),
      );
      return { outcome: "processed" };
    } catch (error) {
      if (error instanceof LeaseLostError) return lost;
      failure = classifyFailure(error);
    }
  }

  if (failure.permanent) return dead(failure.code);
  const delay = retryDelayMs(event.attempts, deps.random);
  if (delay === null) return dead(safeCode(`exhausted_${failure.code}`, "max_attempts_exhausted"));
  const failed = await failWebhookEvent(db, {
    ...fence,
    reason: failure.code,
    nextAttemptAt: new Date(deps.now().getTime() + delay),
  });
  return failed ? { outcome: "failed", reason: failure.code } : lost;
}

/** Runs one already-claimed event to an outcome. Never throws: a failure to record the outcome is `unrecorded`. */
export async function processClaimedEvent(
  db: DbExecutor,
  event: ClaimedWebhookEvent,
  handlers: WebhookHandlerRegistry,
  deps: ProcessDeps,
  lockOwner: string,
): Promise<EventOutcome> {
  const started = performance.now();
  let result: Resolution;
  try {
    result = await resolve(db, event, handlers, deps, { id: event.id, workerId: lockOwner });
  } catch {
    result = { outcome: "unrecorded", reason: "record_failed" };
  }
  emitWebhookLog({
    event: LOG_EVENT[result.outcome],
    outcome:
      result.outcome === "processed"
        ? "success"
        : result.outcome === "held" || result.outcome === "ignored"
          ? "denied"
          : "failure",
    webhookEventId: event.id,
    organizationId: event.organizationId ?? undefined,
    whatsappAccountId: event.whatsappAccountId ?? undefined,
    eventType: event.eventType,
    attempt: event.attempts,
    durationMs: performance.now() - started,
    reason: result.reason,
  });
  return result.outcome;
}

export type ProcessBatchOptions = Partial<ProcessDeps> & {
  /** Required and explicit: there is no default registry. An event type without a handler is not claimed. */
  handlers: WebhookHandlerRegistry;
  /** Maximum events claimed by this call (default 20). */
  batchSize?: number;
  /** Maximum handlers running at once (default 2). */
  concurrency?: number;
  /** Once aborted no further event is claimed; events already claimed run to their outcome. */
  stopSignal?: AbortSignal;
};

function bounded(name: string, value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new RangeError(`${name} must be an integer between 1 and ${max}`);
  return value;
}

/**
 * Processes up to `batchSize` events with at most `concurrency` handlers in flight. Each lane claims ONE event
 * immediately before running it, so an event's lease never ticks while it waits for a free lane (a claimed batch of 20
 * behind 2 slow handlers would outlive the 120 s lease). Every event is independent: its own transaction, its own
 * outcome. The summary and the logs contain counts and internal ids only.
 */
export async function processWebhookBatch(
  db: DbExecutor,
  options: ProcessBatchOptions,
): Promise<BatchSummary> {
  const batchSize = bounded("batchSize", options.batchSize ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
  const concurrency = bounded(
    "concurrency",
    options.concurrency ?? DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
  );
  const deps: ProcessDeps = {
    now: options.now ?? (() => new Date()),
    random: options.random ?? Math.random,
    newLockOwner: options.newLockOwner ?? randomUUID,
    leaseSeconds: options.leaseSeconds ?? LEASE_SECONDS,
    handlerTimeoutMs: options.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS,
    statementTimeoutMs: options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS,
  };
  // A live worker must not outlive its lease.
  if (deps.handlerTimeoutMs >= deps.leaseSeconds * 1000)
    throw new RangeError("handlerTimeoutMs must be shorter than the lease");

  const eventTypes = (Object.keys(options.handlers) as WebhookEventKind[]).filter(
    (type) => isKind(type) && typeof options.handlers[type] === "function",
  );
  const summary = emptySummary();
  if (eventTypes.length === 0) return summary;

  const started = performance.now();
  let budget = batchSize;
  const lane = async () => {
    while (budget > 0 && !options.stopSignal?.aborted) {
      budget--;
      const lockOwner = deps.newLockOwner();
      const [event] = await claimWebhookEventRows(db, {
        limit: 1,
        workerId: lockOwner,
        leaseSeconds: deps.leaseSeconds,
        eventTypes,
      });
      if (!event) {
        budget = 0; // nothing due for these types: every lane stops
        return;
      }
      summary.claimed++;
      const outcome = await processClaimedEvent(db, event, options.handlers, deps, lockOwner);
      summary[SUMMARY_KEY[outcome]]++;
    }
  };
  // A failing claim (database trouble) must not abandon a lane that is mid-event: wait for every lane, then report it.
  const lanes = await Promise.allSettled(Array.from({ length: concurrency }, lane));
  const failed = lanes.find((l): l is PromiseRejectedResult => l.status === "rejected");
  if (failed) throw failed.reason;

  if (summary.claimed > 0) {
    emitWebhookLog({
      event: "webhook.batch_completed",
      outcome: "success",
      durationMs: performance.now() - started,
      counts: {
        claimed: summary.claimed,
        processed: summary.processed,
        failed: summary.failed,
        dead: summary.dead,
        held: summary.held,
        ignored: summary.ignored,
        leaseLost: summary.leaseLost,
        unrecorded: summary.unrecorded,
      },
    });
  }
  return summary;
}
