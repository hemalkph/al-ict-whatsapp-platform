import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema, type Database } from "@/db";
import { emitSecurityEvent } from "@/shared/security/events";
import type { PlatformPermission } from "./permissions";

// Durable platform audit (plan 7.2). SUCCEEDED rows are written by recordAudit INSIDE the mutation's transaction, so the
// change and its audit commit or roll back together. DENIED/FAILED rows are best effort in their own short transaction: a
// failure to write them never turns a refusal into a success. A human's refusals are throttled (recordRefusalThrottled) so a
// signed-in caller cannot write audit rows at request rate. Rows hold ids and fixed codes only.

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type AuditEntry = {
  readonly correlationId: string;
  readonly actorKind: "HUMAN" | "BOOTSTRAP";
  readonly actorUserId: string | null;
  readonly action: string;
  readonly permission: PlatformPermission | null;
  readonly outcome: "SUCCEEDED" | "DENIED" | "FAILED";
  readonly targetUserId?: string | null;
  readonly targetOrganizationId?: string | null;
  readonly approvalRef?: string | null;
  readonly resultCode?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recordAudit(tx: Tx | Database, entry: AuditEntry): Promise<void> {
  await tx.insert(schema.platformAuditEvents).values({
    ...entry,
    // A denied request may name a malformed target; keep only a well-formed id.
    targetUserId: entry.targetUserId && UUID.test(entry.targetUserId) ? entry.targetUserId : null,
  });
}

export async function recordAuditBestEffort(db: Database, entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(db, entry);
  } catch {
    emitSecurityEvent({
      event: "platform.audit_write_failed",
      outcome: "failure",
      userId: entry.actorUserId ?? undefined,
      permission: entry.permission ?? undefined,
      reason: `${entry.action}:${entry.outcome}`,
    });
  }
}

/** At most one durable DENIED/FAILED row per (actor, action, outcome) in this window. */
export const REFUSAL_AUDIT_WINDOW_SECONDS = 60;

/**
 * A human's DENIED/FAILED row, best effort and THROTTLED: one short transaction claims the (actor, action, outcome) slot in
 * platform_audit_throttle (an upsert that only succeeds when the last recorded row is older than the window; concurrent
 * callers and several app instances serialize on that one key row) and writes the audit row only if it won the slot. The
 * claim and the row commit together, so a failed audit write does not consume the slot. Refusals beyond the first in a
 * window are kept only as security log lines. Never changes the refusal itself.
 */
export async function recordRefusalThrottled(
  db: Database,
  entry: AuditEntry & { readonly actorUserId: string },
): Promise<void> {
  const th = schema.platformAuditThrottle;
  try {
    await db.transaction(async (tx) => {
      const won = await tx
        .insert(th)
        .values({
          actorUserId: entry.actorUserId,
          action: entry.action,
          outcome: entry.outcome,
          lastRecordedAt: sql`clock_timestamp()`,
        })
        .onConflictDoUpdate({
          target: [th.actorUserId, th.action, th.outcome],
          set: { lastRecordedAt: sql`clock_timestamp()` },
          setWhere: sql`${th.lastRecordedAt} <= clock_timestamp() - make_interval(secs => ${REFUSAL_AUDIT_WINDOW_SECONDS})`,
        })
        .returning({ action: th.action });
      if (won.length > 0) await recordAudit(tx, entry);
    });
  } catch {
    emitSecurityEvent({
      event: "platform.audit_write_failed",
      outcome: "failure",
      userId: entry.actorUserId,
      permission: entry.permission ?? undefined,
      reason: `${entry.action}:${entry.outcome}`,
    });
  }
}

const MAX_LIMIT = 200;

/**
 * One page of the audit rows the actor may see, newest first in the stable order (occurred_at, id): all rows with
 * platform.audit.read_all, otherwise only rows where the caller is the actor. `before` is the id of the last row of the
 * previous page (keyset cursor; its position is read from the database, so equal timestamps and microsecond precision are
 * exact). In the own-only scope a cursor naming someone else's row yields an empty page, never another actor's position.
 */
export async function listAuditEvents(
  actor: { readonly userId: string; readonly canReadAll: boolean },
  page: { readonly limit: number; readonly before?: string },
  db: Database = getDb(),
) {
  const t = schema.platformAuditEvents;
  const limit = Math.min(Math.max(1, Math.trunc(page.limit) || 50), MAX_LIMIT);
  const own = actor.canReadAll ? undefined : eq(t.actorUserId, actor.userId);
  const after = page.before
    ? sql`(${t.occurredAt}, ${t.id}) < (select c.occurred_at, c.id from platform_audit_events c where c.id = ${page.before}${
        actor.canReadAll ? sql`` : sql` and c.actor_user_id = ${actor.userId}`
      })`
    : undefined;
  const events = await db
    .select({
      id: t.id,
      occurredAt: t.occurredAt,
      correlationId: t.correlationId,
      actorKind: t.actorKind,
      actorUserId: t.actorUserId,
      action: t.action,
      permission: t.permission,
      outcome: t.outcome,
      targetUserId: t.targetUserId,
      targetOrganizationId: t.targetOrganizationId,
      approvalRef: t.approvalRef,
      resultCode: t.resultCode,
    })
    .from(t)
    .where(and(own, after))
    .orderBy(desc(t.occurredAt), desc(t.id))
    .limit(limit);
  return { events, nextCursor: events.length === limit ? events.at(-1)!.id : null };
}
