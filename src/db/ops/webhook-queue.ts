import { and, eq, sql } from "drizzle-orm";
import { webhookEvents } from "../schema";
import type { DbExecutor } from "./executor";

// The PostgreSQL inbox queue over webhook_events (ADR 0006). Policy (attempt limit, backoff, lease length) lives with
// the worker; these are the mechanical, individually fenced state transitions.
//
// Ownership model: a claim stamps `locked_by` with a value unique to that claim. Every later transition is
// `WHERE id = ? AND status = 'PROCESSING' AND locked_by = ?` ("the fence"): zero rows means the lease was lost (another
// worker reclaimed the event, or it already reached a final state) and the caller must not write anything else.

export type ClaimedWebhookEvent = {
  id: string;
  eventType: string;
  organizationId: string | null;
  whatsappAccountId: string | null;
  /** Number of claims including this one (1 on the first claim). */
  attempts: number;
  payload: unknown;
  receivedAt: Date;
};

type ClaimedRow = {
  id: string;
  event_type: string;
  organization_id: string | null;
  whatsapp_account_id: string | null;
  attempts: number;
  payload: unknown;
  received_at: Date | string;
};

/**
 * Claims up to `limit` events: due PENDING/FAILED rows, plus PROCESSING rows whose lease expired. FOR UPDATE SKIP LOCKED
 * lets concurrent workers claim disjoint rows; the claim is one committed statement, so a worker that dies afterwards
 * leaves a PROCESSING row that another worker reclaims once the lease expires. `attempts` is incremented exactly once
 * per claim, including a lease reclaim. `eventTypes` (when given) restricts the claim to types that have a handler;
 * an empty list claims nothing. Rows come back ordered by (received_at, id).
 */
export async function claimWebhookEventRows(
  db: DbExecutor,
  opts: { limit: number; workerId: string; leaseSeconds: number; eventTypes?: readonly string[] },
): Promise<ClaimedWebhookEvent[]> {
  if (opts.eventTypes?.length === 0) return [];
  const typeFilter = opts.eventTypes
    ? sql`AND event_type IN (${sql.join(
        opts.eventTypes.map((t) => sql`${t}`),
        sql`, `,
      )})`
    : sql``;
  const result = await db.execute<ClaimedRow>(sql`
    WITH candidates AS (
      SELECT id FROM webhook_events
      WHERE ((status IN ('PENDING', 'FAILED') AND next_attempt_at <= now())
         OR (status = 'PROCESSING'
             AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => ${opts.leaseSeconds}))))
        ${typeFilter}
      ORDER BY received_at, id
      LIMIT ${opts.limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE webhook_events e
    SET status = 'PROCESSING', locked_at = now(), locked_by = ${opts.workerId}, attempts = e.attempts + 1
    FROM candidates c
    WHERE e.id = c.id
    RETURNING e.id, e.event_type, e.organization_id, e.whatsapp_account_id, e.attempts, e.payload, e.received_at
  `);
  return result.rows
    .map((r) => ({
      id: r.id,
      eventType: r.event_type,
      organizationId: r.organization_id,
      whatsappAccountId: r.whatsapp_account_id,
      attempts: r.attempts,
      payload: r.payload,
      receivedAt: new Date(r.received_at),
    }))
    .sort(
      (a, b) =>
        a.receivedAt.getTime() - b.receivedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/** Claims and returns only the ids (see claimWebhookEventRows). */
export async function claimWebhookEvents(
  db: DbExecutor,
  opts: { limit: number; workerId: string; leaseSeconds: number },
): Promise<string[]> {
  return (await claimWebhookEventRows(db, opts)).map((e) => e.id);
}

export type Fence = { id: string; workerId: string };

const fenced = (f: Fence) =>
  and(
    eq(webhookEvents.id, f.id),
    eq(webhookEvents.status, "PROCESSING"),
    eq(webhookEvents.lockedBy, f.workerId),
  );

const released = { lockedAt: null, lockedBy: null } as const;

/** PROCESSING -> PROCESSED. false = lease lost (nothing was written). Pass the SAME transaction as the handler. */
export async function completeWebhookEvent(db: DbExecutor, f: Fence): Promise<boolean> {
  const rows = await db
    .update(webhookEvents)
    .set({ status: "PROCESSED", processedAt: sql`now()`, lastError: null, ...released })
    .where(fenced(f))
    .returning({ id: webhookEvents.id });
  return rows.length === 1;
}

/** PROCESSING -> FAILED, due again at `nextAttemptAt`. false = lease lost. */
export async function failWebhookEvent(
  db: DbExecutor,
  f: Fence & { reason: string; nextAttemptAt: Date },
): Promise<boolean> {
  const rows = await db
    .update(webhookEvents)
    .set({
      status: "FAILED",
      lastError: f.reason,
      nextAttemptAt: f.nextAttemptAt,
      ...released,
    })
    .where(fenced(f))
    .returning({ id: webhookEvents.id });
  return rows.length === 1;
}

/** PROCESSING -> DEAD (terminal). false = lease lost. */
export async function deadWebhookEvent(
  db: DbExecutor,
  f: Fence & { reason: string },
): Promise<boolean> {
  const rows = await db
    .update(webhookEvents)
    .set({ status: "DEAD", lastError: f.reason, ...released })
    .where(fenced(f))
    .returning({ id: webhookEvents.id });
  return rows.length === 1;
}

/**
 * PROCESSING -> UNROUTABLE (a hold) or IGNORED. Both KEEP organization_id/whatsapp_account_id: tenant provenance is never
 * erased by a hold. This is NOT a processing run, so the claim's attempt increment is undone: `attempts` returns to its
 * pre-claim value. false = lease lost.
 */
export async function holdWebhookEvent(
  db: DbExecutor,
  f: Fence & { status: "UNROUTABLE" | "IGNORED"; reason: string },
): Promise<boolean> {
  const rows = await db
    .update(webhookEvents)
    .set({
      status: f.status,
      lastError: f.reason,
      attempts: sql`GREATEST(${webhookEvents.attempts} - 1, 0)`,
      ...released,
    })
    .where(fenced(f))
    .returning({ id: webhookEvents.id });
  return rows.length === 1;
}
