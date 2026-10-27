import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import { BOT_DEPLOYMENT_STATUSES, BOT_SESSION_STATES } from "@/db/schema/enums";
import type { AccessContext } from "@/modules/access";
import { reader, type BotControlDeps } from "./common";
import { parse } from "./schemas";

// Read-only operator listings (Phase 08F-2; V3.2 08F; owner decision D-3): bot sessions, DEAD triggers and deployments. Each is
// bounded (limit 1..100, keyset pages), organization-scoped from the AccessContext, and gated by bot.read through `reader`.
// They SELECT named lifecycle columns only: never session variables, awaiting/consumed tokens, input payloads, message text or
// any secret. Nothing here writes, retries, redeploys or resurrects.

export const LISTING_LIMIT_DEFAULT = 50;
export const LISTING_LIMIT_MAX = 100;

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const uuid = z.uuid();
const limit = z.number().int().min(1).max(LISTING_LIMIT_MAX).default(LISTING_LIMIT_DEFAULT);
const cursor = z.string().min(1).max(300).optional();

const sessionsInput = z.strictObject({
  limit,
  cursor,
  state: z.enum(BOT_SESSION_STATES).optional(),
  deploymentId: uuid.optional(),
});
const triggersInput = z.strictObject({ limit, cursor });
const deploymentsInput = z.strictObject({
  limit,
  cursor,
  status: z.enum(BOT_DEPLOYMENT_STATUSES).optional(),
});

// The regex fixes the format; the round trip through Date rejects impossible calendar values (month 13, Feb 30, Feb 29 in a
// common year, hour 24), which Date rolls over instead. Date holds milliseconds, so the check uses the first 23 characters and
// the microseconds stay in the original string.
const calendarValid = (s: string) => {
  const ms = `${s.slice(0, 23)}Z`;
  const d = new Date(ms);
  return !Number.isNaN(d.getTime()) && d.toISOString() === ms;
};
const timeKey = z.tuple([z.string().regex(TS).refine(calendarValid), uuid]);
const deploymentKey = z.tuple([uuid, z.number().int().min(1).max(1000), uuid]);

const encode = (key: readonly unknown[]) => Buffer.from(JSON.stringify(key)).toString("base64url");
function decode<T extends z.ZodType>(schema: T, value: string | undefined): z.infer<T> | null {
  if (value === undefined) return null;
  const bad = (): never => parse(z.never(), undefined); // a ValidationError naming "body"
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return bad();
  try {
    const result = schema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return result.success ? result.data : bad();
  } catch {
    return bad();
  }
}

export type Page<T> = { readonly items: T[]; readonly nextCursor: string | null };

const TS_TEXT = (column: string) =>
  sql.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

type SessionRow = Record<string, unknown> & { cursor_key: unknown[] };

async function page<T>(
  db: ReturnType<typeof reader>,
  query: SQL,
  size: number,
  map: (row: SessionRow) => T,
): Promise<Page<T>> {
  const rows = (await db.execute<SessionRow>(query)).rows;
  const shown = rows.slice(0, size);
  const last = shown[shown.length - 1];
  return {
    items: shown.map(map),
    nextCursor: rows.length > size && last ? encode(last.cursor_key) : null,
  };
}

export type SessionListItem = {
  readonly id: string;
  readonly botId: string;
  readonly botVersionId: string;
  readonly deploymentId: string;
  readonly whatsappAccountId: string;
  readonly conversationId: string;
  readonly state: (typeof BOT_SESSION_STATES)[number];
  readonly endReason: string | null;
  readonly handoverReason: string | null;
  readonly stepSeq: number;
  readonly sendCount: number;
  readonly hasTerminalNotice: boolean;
  readonly redacted: boolean;
  readonly startedAt: string;
  readonly endedAt: string | null;
};

/** Newest first by (started_at, id). Uses bot_sessions_deployment_live_idx or the organization-wide scan, always LIMIT-bounded. */
export async function listBotSessions(
  ctx: AccessContext,
  raw: unknown,
  deps: BotControlDeps = {},
): Promise<Page<SessionListItem>> {
  const db = reader(ctx, deps);
  const q = parse(sessionsInput, raw);
  const after = decode(timeKey, q.cursor);
  const where: SQL[] = [sql`s.organization_id = ${ctx.organizationId}::uuid`];
  if (q.state) where.push(sql`s.state = ${q.state}`);
  if (q.deploymentId) where.push(sql`s.deployment_id = ${q.deploymentId}::uuid`);
  if (after) where.push(sql`(s.started_at, s.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)`);
  return page(
    db,
    sql`SELECT s.id, s.bot_id, s.bot_version_id, s.deployment_id, s.whatsapp_account_id, s.conversation_id, s.state,
               s.end_reason, s.handover_reason, s.step_seq, s.send_count,
               (s.terminal_notice_step_seq IS NOT NULL) AS has_notice, (s.redacted_at IS NOT NULL) AS redacted,
               ${TS_TEXT("s.started_at")} AS started_at, ${TS_TEXT("s.ended_at")} AS ended_at,
               jsonb_build_array(${TS_TEXT("s.started_at")}, s.id) AS cursor_key
        FROM bot_sessions s WHERE ${sql.join(where, sql` AND `)}
        ORDER BY s.started_at DESC, s.id DESC LIMIT ${q.limit + 1}`,
    q.limit,
    (r: SessionRow): SessionListItem => ({
      id: r.id as string,
      botId: r.bot_id as string,
      botVersionId: r.bot_version_id as string,
      deploymentId: r.deployment_id as string,
      whatsappAccountId: r.whatsapp_account_id as string,
      conversationId: r.conversation_id as string,
      state: r.state as SessionListItem["state"],
      endReason: r.end_reason as string | null,
      handoverReason: r.handover_reason as string | null,
      stepSeq: r.step_seq as number,
      sendCount: r.send_count as number,
      hasTerminalNotice: r.has_notice as boolean,
      redacted: r.redacted as boolean,
      startedAt: r.started_at as string,
      endedAt: r.ended_at as string | null,
    }),
  );
}

export type DeadTriggerItem = {
  readonly id: string;
  readonly whatsappAccountId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly outcomeCode: string;
  readonly lastErrorCode: string | null;
  readonly attempts: number;
  readonly deferrals: number;
  readonly sessionId: string | null;
  readonly enqueuedAt: string;
  readonly processedAt: string;
};

/** DEAD trigger rows, newest first by (processed_at, id). Ids and codes only; the message text is never read. */
export async function listDeadTriggers(
  ctx: AccessContext,
  raw: unknown,
  deps: BotControlDeps = {},
): Promise<Page<DeadTriggerItem>> {
  const db = reader(ctx, deps);
  const q = parse(triggersInput, raw);
  const after = decode(timeKey, q.cursor);
  const where: SQL[] = [
    sql`t.organization_id = ${ctx.organizationId}::uuid`,
    sql`t.status = 'DEAD'`,
  ];
  if (after)
    where.push(sql`(t.processed_at, t.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)`);
  return page(
    db,
    sql`SELECT t.id, t.whatsapp_account_id, t.conversation_id, t.message_id, t.outcome_code, t.last_error_code,
               t.attempts, t.deferrals, t.session_id,
               ${TS_TEXT("t.enqueued_at")} AS enqueued_at, ${TS_TEXT("t.processed_at")} AS processed_at,
               jsonb_build_array(${TS_TEXT("t.processed_at")}, t.id) AS cursor_key
        FROM bot_triggers t WHERE ${sql.join(where, sql` AND `)}
        ORDER BY t.processed_at DESC, t.id DESC LIMIT ${q.limit + 1}`,
    q.limit,
    (r: SessionRow): DeadTriggerItem => ({
      id: r.id as string,
      whatsappAccountId: r.whatsapp_account_id as string,
      conversationId: r.conversation_id as string,
      messageId: r.message_id as string,
      outcomeCode: r.outcome_code as string,
      lastErrorCode: r.last_error_code as string | null,
      attempts: r.attempts as number,
      deferrals: r.deferrals as number,
      sessionId: r.session_id as string | null,
      enqueuedAt: r.enqueued_at as string,
      processedAt: r.processed_at as string,
    }),
  );
}

export type DeploymentListItem = {
  readonly id: string;
  readonly botId: string;
  readonly whatsappAccountId: string;
  readonly versionId: string;
  readonly status: (typeof BOT_DEPLOYMENT_STATUSES)[number];
  readonly priority: number;
  readonly sendEpoch: number;
  readonly startEligibleFrom: string | null;
  readonly statusChangedAt: string;
  readonly activatedAt: string | null;
};

/** Deployments in the same order as `listDeployments` ((account, priority), with the id as tie-break), one bounded page at a time. */
export async function listDeploymentsPage(
  ctx: AccessContext,
  raw: unknown,
  deps: BotControlDeps = {},
): Promise<Page<DeploymentListItem>> {
  const db = reader(ctx, deps);
  const q = parse(deploymentsInput, raw);
  const after = decode(deploymentKey, q.cursor);
  const where: SQL[] = [sql`d.organization_id = ${ctx.organizationId}::uuid`];
  if (q.status) where.push(sql`d.status = ${q.status}`);
  if (after)
    where.push(
      sql`(d.whatsapp_account_id, d.priority, d.id) > (${after[0]}::uuid, ${after[1]}::int, ${after[2]}::uuid)`,
    );
  return page(
    db,
    sql`SELECT d.id, d.bot_id, d.whatsapp_account_id, d.version_id, d.status, d.priority, d.send_epoch,
               ${TS_TEXT("d.start_eligible_from")} AS start_eligible_from,
               ${TS_TEXT("d.status_changed_at")} AS status_changed_at, ${TS_TEXT("d.activated_at")} AS activated_at,
               jsonb_build_array(d.whatsapp_account_id, d.priority, d.id) AS cursor_key
        FROM bot_deployments d WHERE ${sql.join(where, sql` AND `)}
        ORDER BY d.whatsapp_account_id, d.priority, d.id LIMIT ${q.limit + 1}`,
    q.limit,
    (r: SessionRow): DeploymentListItem => ({
      id: r.id as string,
      botId: r.bot_id as string,
      whatsappAccountId: r.whatsapp_account_id as string,
      versionId: r.version_id as string,
      status: r.status as DeploymentListItem["status"],
      priority: r.priority as number,
      sendEpoch: Number(r.send_epoch),
      startEligibleFrom: r.start_eligible_from as string | null,
      statusChangedAt: r.status_changed_at as string,
      activatedAt: r.activated_at as string | null,
    }),
  );
}
