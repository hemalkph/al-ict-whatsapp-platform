import { sql } from "drizzle-orm";
import type { Database } from "@/db";
import { LEASE_SECONDS } from "../queue/policy";
import { readQueueStats } from "../queue/stats";
import { classifyDead } from "./dead";
import { heldEventCounts } from "./events";

// OPERATOR-ONLY read-only health report for the webhook pipeline. It reuses readQueueStats and adds counts the operator
// needs to investigate a stuck pipeline. Everything is a count, an age or a fixed code: no payload, phone number, BSUID or
// message text is selected. There is no heartbeat table (that would need a migration), so "is a worker running?" is
// INFERRED from whether due work is being completed.

/**
 * The event types the opt-in worker has handlers for. Kept equal to Object.keys(webhookWorkerHandlers) by a test; the
 * operator layer deliberately does not import the worker.
 */
export const CLAIMABLE_EVENT_TYPES = ["MESSAGE", "STATUS"] as const;

/** A due event older than this with nothing completed recently means the queue is not draining. */
export const NOT_DRAINING_AFTER_SECONDS = LEASE_SECONDS;
const RECENT_MINUTES = 5;

export type Finding = {
  code:
    | "expired_leases"
    | "queue_not_draining"
    | "dead_events"
    | "failed_events_waiting"
    | "held_events"
    | "unrouted_events_need_review"
    | "no_active_account"
    | "unclaimable_events_waiting";
  severity: "attention" | "info";
  meaning: string;
  next: string;
};

export async function pipelineHealth(db: Database) {
  const stats = await readQueueStats(db, LEASE_SECONDS, CLAIMABLE_EVENT_TYPES);
  const [activity] = (
    await db.execute<{
      processed_recent: number;
      last_processed: Date | null;
      unclaimable: number;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM webhook_events
          WHERE status = 'PROCESSED' AND processed_at > now() - make_interval(mins => ${RECENT_MINUTES})) AS processed_recent,
        (SELECT max(processed_at) FROM webhook_events) AS last_processed,
        (SELECT count(*)::int FROM webhook_events
          WHERE status = 'PENDING' AND event_type NOT IN ('MESSAGE', 'STATUS')) AS unclaimable
    `)
  ).rows;
  const accounts = (
    await db.execute<{ status: string; archived: boolean; n: number }>(sql`
      SELECT status, (archived_at IS NOT NULL) AS archived, count(*)::int AS n
      FROM whatsapp_accounts GROUP BY 1, 2 ORDER BY 1, 2`)
  ).rows;
  const held = await heldEventCounts(db);
  const dead = (
    await db.execute<{ reason: string | null; n: number }>(
      sql`SELECT last_error AS reason, count(*)::int AS n FROM webhook_events WHERE status = 'DEAD' GROUP BY 1 ORDER BY n DESC`,
    )
  ).rows.map((r) => ({ reason: r.reason, category: classifyDead(r.reason).category, count: r.n }));
  // Informational only: provider media that exists but has not been fetched. No downloader exists yet, so these are NOT
  // failed or stuck jobs and never counted as queue problems.
  const [attachments] = (
    await db.execute<{ pending: number }>(
      sql`SELECT count(*)::int AS pending FROM message_attachments WHERE storage_status = 'PENDING'`,
    )
  ).rows;
  const [retention] = (
    await db.execute<{
      requests_30d: number;
      request_bytes_30d: string | null;
      events_30d: number;
      protected_30d: number;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM webhook_requests WHERE received_at < now() - interval '30 days') AS requests_30d,
        (SELECT sum(octet_length(raw_body))::text FROM webhook_requests WHERE received_at < now() - interval '30 days') AS request_bytes_30d,
        (SELECT count(*)::int FROM webhook_events WHERE received_at < now() - interval '30 days') AS events_30d,
        (SELECT count(*)::int FROM webhook_events
          WHERE received_at < now() - interval '30 days' AND status IN ('UNROUTABLE', 'IGNORED', 'DEAD', 'PENDING', 'FAILED', 'PROCESSING')) AS protected_30d
    `)
  ).rows;

  const processedRecent = activity?.processed_recent ?? 0;
  const activeAccounts = accounts
    .filter((a) => a.status === "ACTIVE" && !a.archived)
    .reduce((n, a) => n + a.n, 0);
  const heldTotal = held.reduce((n, h) => n + h.count, 0);
  const unroutedHeld = held
    .filter((h) => !h.routed && h.status === "UNROUTABLE")
    .reduce((n, h) => n + h.count, 0);
  const deadTotal = stats.byStatus.DEAD;
  const dueBacklog = stats.byStatus.PENDING + stats.byStatus.FAILED;

  const findings: Finding[] = [];
  if (stats.expiredLeases > 0)
    findings.push({
      code: "expired_leases",
      severity: "attention",
      meaning: `${stats.expiredLeases} event(s) are PROCESSING with an expired lease: a worker died or stalled mid-event.`,
      next: "Start (or restart) the worker; the next claim reclaims them after the lease. If they come back, find why handlers hang or the worker crashes (worker.* logs).",
    });
  if (
    stats.oldestDueAgeSeconds !== null &&
    stats.oldestDueAgeSeconds > NOT_DRAINING_AFTER_SECONDS &&
    processedRecent === 0
  )
    findings.push({
      code: "queue_not_draining",
      severity: "attention",
      meaning: `The oldest due event has waited ${stats.oldestDueAgeSeconds}s and nothing was processed in the last ${RECENT_MINUTES} minutes.`,
      next: "Is the worker running (WHATSAPP_WORKER_ENABLED=true)? Check its worker.fatal / worker.database_unavailable log lines, then database connectivity.",
    });
  if (deadTotal > 0)
    findings.push({
      code: "dead_events",
      severity: "attention",
      meaning: `${deadTotal} DEAD event(s) need review.`,
      next: "npm run whatsapp:events -- dead summary, then dead inspect <id>.",
    });
  if (stats.byStatus.FAILED > 0)
    findings.push({
      code: "failed_events_waiting",
      severity: "info",
      meaning: `${stats.byStatus.FAILED} event(s) failed transiently and wait for their scheduled retry (30 s up to 32 min between runs).`,
      next: "Normal after a brief outage. If the number keeps growing, read the worker logs for the failure code.",
    });
  if (heldTotal > 0)
    findings.push({
      code: "held_events",
      severity: "info",
      meaning: `${heldTotal} event(s) are UNROUTABLE or IGNORED (some are expected: unsupported fields, played statuses).`,
      next: "npm run whatsapp:events -- counts; releasable ones show a releasePath.",
    });
  if (unroutedHeld > 0)
    findings.push({
      code: "unrouted_events_need_review",
      severity: "attention",
      meaning: `${unroutedHeld} event(s) arrived for a phone_number_id with no registered account (or a WABA mismatch).`,
      next: "Register the account if it is yours (whatsapp:accounts register), then release events one by one with requeue-unrouted after review. Never released automatically.",
    });
  if (activeAccounts === 0 && heldTotal + dueBacklog > 0)
    findings.push({
      code: "no_active_account",
      severity: "attention",
      meaning: "There is queued or held work but no ACTIVE WhatsApp account.",
      next: "whatsapp:accounts list; activate the account that should receive traffic.",
    });
  if ((activity?.unclaimable ?? 0) > 0)
    findings.push({
      code: "unclaimable_events_waiting",
      severity: "info",
      meaning: `${activity?.unclaimable} PENDING event(s) are of a type no handler exists for (IDENTITY / OTHER); the worker will never claim them.`,
      next: "Expected until identity handling exists (blocker 8). They are not stuck jobs.",
    });

  return {
    generatedAt: new Date().toISOString(),
    queue: {
      byStatus: stats.byStatus,
      oldestDueAgeSeconds: stats.oldestDueAgeSeconds,
      expiredLeases: stats.expiredLeases,
      note: "oldestDueAgeSeconds counts only MESSAGE and STATUS events, the types a worker can claim",
    },
    workerActivity: {
      processedLast5Minutes: processedRecent,
      lastProcessedAt: activity?.last_processed
        ? new Date(activity.last_processed).toISOString()
        : null,
      inference:
        "There is no worker heartbeat. A running worker is inferred from due events being completed; see the worker.stats log lines for depth over time.",
    },
    accounts: accounts.map((a) => ({ status: a.status, archived: a.archived, count: a.n })),
    heldEvents: held,
    deadEvents: dead,
    attachments: {
      pendingMediaFetch: attachments?.pending ?? 0,
      note: "provider media that has not been fetched; no downloader exists yet, so this is informational and not a failed job",
    },
    retention: {
      olderThan30Days: {
        webhookRequests: retention?.requests_30d ?? 0,
        webhookRequestRawBytes: retention?.request_bytes_30d
          ? Number(retention.request_bytes_30d)
          : 0,
        webhookEvents: retention?.events_30d ?? 0,
        eventsAwaitingAction: retention?.protected_30d ?? 0,
      },
      note: "No retention job exists. Events that are held, DEAD, PENDING, FAILED or PROCESSING must not be deleted by any future job.",
    },
    findings,
    needsAttention: findings.some((f) => f.severity === "attention"),
  };
}
