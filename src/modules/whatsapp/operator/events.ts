import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { schema, type Database, type DbExecutor } from "@/db";
import { payloadPhoneNumberId } from "../envelope";
import { emitWebhookLog } from "../logging";
import {
  AUTO_REQUEUE_REASONS,
  OPERATOR_ROUTED_REASONS,
  UNROUTED_REASONS,
  requeueRoutedHeldEvents,
  requeueUnroutedEvent,
  type RoutedRequeueReason,
} from "../queue/requeue";
import { OperatorAbort, transact } from "./dryrun";

// OPERATOR-ONLY control of held events (UNROUTABLE / IGNORED). It is a thin, read-mostly layer over the approved requeue
// functions in ../queue/requeue.ts, which stay the only code that releases an event. This file adds: counts, listings
// WITHOUT payloads, a dry-run-by-default wrapper, and the explicit confirmations the decisions require. It never routes an
// event itself, never touches organization_id / whatsapp_account_id except through requeueUnroutedEvent (which derives
// them from the independently verified target account), and never merges identities.

export type EventRefusal = { ok: false; refused: string; detail?: string };
const refuse = (refused: string, detail?: string): EventRefusal => ({ ok: false, refused, detail });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HELD = ["UNROUTABLE", "IGNORED"] as const;
const ROUTED_REASONS: readonly string[] = [...AUTO_REQUEUE_REASONS, ...OPERATOR_ROUTED_REASONS];

/** How a held event can (or cannot) be released. */
export function releasePath(reason: string | null, routed: boolean): string {
  if (reason === "account_pending" && routed) return "activation_or_requeue_routed";
  if (reason !== null && ROUTED_REASONS.includes(reason) && routed)
    return "requeue_routed_explicit";
  if (reason !== null && (UNROUTED_REASONS as readonly string[]).includes(reason) && !routed)
    return "requeue_unrouted_single_event_explicit";
  return "none"; // nothing to process (status_not_mirrored, unsupported_field, ...)
}

export async function heldEventCounts(db: Database) {
  const rows = await db.execute<{
    status: string;
    reason: string | null;
    account_id: string | null;
    n: number;
    oldest: Date | null;
    newest: Date | null;
  }>(sql`
    SELECT status, last_error AS reason, whatsapp_account_id AS account_id, count(*)::int AS n,
           min(received_at) AS oldest, max(received_at) AS newest
    FROM webhook_events
    WHERE status IN ('UNROUTABLE', 'IGNORED')
    GROUP BY status, last_error, whatsapp_account_id
    ORDER BY status, last_error, whatsapp_account_id
  `);
  return rows.rows.map((r) => ({
    status: r.status,
    reason: r.reason,
    routed: r.account_id !== null,
    accountId: r.account_id,
    count: r.n,
    oldestReceivedAt: r.oldest ? new Date(r.oldest).toISOString() : null,
    newestReceivedAt: r.newest ? new Date(r.newest).toISOString() : null,
    releasePath: releasePath(r.reason, r.account_id !== null),
  }));
}

export type ListHeldOptions = {
  status?: (typeof HELD)[number];
  reason?: string;
  accountId?: string;
  limit?: number;
};

/** Identifiers, queue state and configuration ids only. The payload (message content, phone numbers, names) is NEVER selected. */
export async function listHeldEvents(db: Database, options: ListHeldOptions = {}) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const conditions: SQL[] = [
    inArray(schema.webhookEvents.status, [...(options.status ? [options.status] : HELD)]),
  ];
  if (options.reason) conditions.push(eq(schema.webhookEvents.lastError, options.reason));
  if (options.accountId)
    conditions.push(eq(schema.webhookEvents.whatsappAccountId, options.accountId));
  const rows = await db
    .select({
      id: schema.webhookEvents.id,
      eventType: schema.webhookEvents.eventType,
      status: schema.webhookEvents.status,
      reason: schema.webhookEvents.lastError,
      attempts: schema.webhookEvents.attempts,
      receivedAt: schema.webhookEvents.receivedAt,
      organizationId: schema.webhookEvents.organizationId,
      accountId: schema.webhookEvents.whatsappAccountId,
      phoneNumberId: payloadPhoneNumberId(schema.webhookEvents.payload),
    })
    .from(schema.webhookEvents)
    .where(and(...conditions))
    .orderBy(desc(schema.webhookEvents.receivedAt), schema.webhookEvents.id)
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    receivedAt: r.receivedAt.toISOString(),
    releasePath: releasePath(r.reason, r.accountId !== null),
  }));
}

const DAY_MS = 86_400_000;
function receivedAfter(maxAgeDays: number | undefined, now: Date): Date | EventRefusal {
  const days = maxAgeDays ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 365)
    return refuse("invalid_input", "max-age-days must be an integer from 1 to 365");
  return new Date(now.getTime() - days * DAY_MS);
}

async function guarded<T>(fn: () => Promise<T>): Promise<T | EventRefusal> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof OperatorAbort) return refuse(error.code, error.message);
    throw error;
  }
}

// -------------------------------------------------------------------------------------------- routed events

/**
 * Releases held events that ingest ALREADY routed to `accountId` (never re-homes anything). The selection is exactly the
 * approved requeueRoutedHeldEvents. Dry run unless `apply`; applying requires `expect` = the count a dry run reported, so a
 * selection that changed in between is refused instead of released.
 */
export async function requeueRouted(
  db: Database,
  options: {
    accountId: string;
    reason: string;
    maxAgeDays?: number;
    apply: boolean;
    expect?: number;
    now?: Date;
  },
) {
  const { accountId, reason } = options;
  if (!UUID.test(accountId)) return refuse("invalid_input", "account id must be a UUID");
  if (!ROUTED_REASONS.includes(reason))
    return refuse(
      "reason_not_routed",
      `reason must be one of ${ROUTED_REASONS.join(", ")}; unknown_account and waba_mismatch events are released one at a time with requeue-unrouted`,
    );
  const after = receivedAfter(options.maxAgeDays, options.now ?? new Date());
  if (after instanceof Date === false) return after as EventRefusal;
  if (options.apply && options.expect === undefined)
    return refuse(
      "expectation_required",
      "pass --expect <count> with the number a dry run reported",
    );

  return guarded(async () => {
    const { applied, value } = await transact(db, options.apply, async (tx) => {
      const result = await requeueRoutedHeldEvents(tx, {
        whatsappAccountId: accountId,
        reasons: [reason as RoutedRequeueReason],
        receivedAfter: after as Date,
      });
      if (options.apply && result.skipped === null && result.requeued !== options.expect)
        throw new OperatorAbort(
          "expectation_mismatch",
          `expected ${options.expect} event(s) but ${result.requeued} match now; nothing was changed. Re-run the dry run.`,
        );
      return result;
    });
    if (applied && value.requeued > 0)
      emitWebhookLog({
        event: "operator.events_requeued",
        outcome: "success",
        whatsappAccountId: accountId,
        reason,
        counts: { events: value.requeued },
      });
    return {
      ok: true as const,
      applied,
      reason,
      wouldRequeueOrRequeued: value.requeued,
      skipped: value.skipped,
      note:
        value.skipped === "account_not_active"
          ? "the account must be ACTIVE and not archived; archived accounts' held events are never released"
          : undefined,
    };
  });
}

// ------------------------------------------------------------------------------------- unrouted single event

export async function requeueUnrouted(
  db: Database,
  options: {
    eventId: string;
    accountId: string;
    maxAgeDays?: number;
    apply: boolean;
    approveOwnership?: boolean;
    reviewedWabaMismatch?: boolean;
    now?: Date;
  },
) {
  if (!UUID.test(options.eventId) || !UUID.test(options.accountId))
    return refuse("invalid_input", "event and account ids must be UUIDs");
  const after = receivedAfter(options.maxAgeDays, options.now ?? new Date());
  if (after instanceof Date === false) return after as EventRefusal;

  return guarded(async () => {
    const { applied, value } = await transact(db, options.apply, async (tx: DbExecutor) => {
      const [event] = await tx
        .select({
          reason: schema.webhookEvents.lastError,
          wabaId: sql<string | null>`${schema.webhookEvents.payload} ->> 'wabaId'`,
          phoneNumberId: payloadPhoneNumberId(schema.webhookEvents.payload),
        })
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.id, options.eventId));
      const [target] = await tx
        .select({ account: schema.whatsappAccounts, slug: schema.organizations.slug })
        .from(schema.whatsappAccounts)
        .innerJoin(
          schema.organizations,
          eq(schema.organizations.id, schema.whatsappAccounts.organizationId),
        )
        .where(eq(schema.whatsappAccounts.id, options.accountId));
      if (options.apply) {
        if (!options.approveOwnership)
          throw new OperatorAbort(
            "approval_required",
            "pass --approve-ownership: you are deciding that this event belongs to the target account's organization",
          );
        if (event?.reason === "waba_mismatch" && !options.reviewedWabaMismatch)
          throw new OperatorAbort(
            "waba_review_required",
            "this event was held for a WABA mismatch; review it and pass --reviewed-waba-mismatch",
          );
      }
      const result = await requeueUnroutedEvent(tx, {
        webhookEventId: options.eventId,
        targetWhatsappAccountId: options.accountId,
        receivedAfter: after as Date,
      });
      return {
        result,
        review: {
          eventReason: event?.reason ?? null,
          eventPhoneNumberId: event?.phoneNumberId ?? null,
          eventWabaId: event?.wabaId ?? null,
          targetOrganization: target?.slug ?? null,
          targetPhoneNumberId: target?.account.phoneNumberId ?? null,
          targetWabaId: target?.account.wabaId ?? null,
        },
      };
    });
    if (!value.result.requeued)
      return { ...refuse(value.result.refused ?? "refused"), review: value.review };
    if (applied)
      emitWebhookLog({
        event: "operator.events_requeued",
        outcome: "success",
        webhookEventId: options.eventId,
        whatsappAccountId: options.accountId,
        reason: value.review.eventReason ?? undefined,
        counts: { events: 1 },
      });
    return {
      ok: true as const,
      applied,
      review: value.review,
      effect:
        "the event acquires the target account's organization and account, and is queued for processing",
    };
  });
}
