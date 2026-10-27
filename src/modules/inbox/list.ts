import { sql, type SQL } from "drizzle-orm";
import { getDb, type Database } from "@/db";
import { assertCan, type AccessContext } from "@/modules/access";
import { ValidationError } from "@/shared/errors/http-errors";
import { decodeCursor, encodeCursor } from "./cursor";
import {
  BOT_ATTENTION_SQL,
  BOT_COLUMNS_SQL,
  botField,
  botJoinSql,
  type BotRow,
} from "./bot-indicator";
import { contactLabel, safeLine } from "./display";
import { listQuerySchema } from "./schemas";
import type { ConversationListItem, ConversationPage, ConversationStatus } from "./types";

// The inbox list. Everything is decided in ONE query scoped by organization: filters, search, keyset pagination, the latest
// message preview and this staff member's unread count come from lateral joins, so a page of N conversations costs one round
// trip, not N+1. Ordering is (last_message_at DESC, id DESC) on the existing activity indexes; last_message_at is the effective
// activity time the inbound handler wrote (a provider timestamp is capped at receipt + 5 minutes), never a raw provider time.

export type InboxDeps = { readonly db?: Database };

/** Unread is counted up to this many per conversation: a bounded query, shown as "99+". */
export const UNREAD_CAP = 99;

// Reactions and system notices are not customer activity worth an unread badge (the inbound handler also leaves them out
// of conversation activity); the same two types are excluded in unreadCountSql below.

const FALLBACK_PREVIEWS: Record<string, string> = {
  IMAGE: "Photo",
  VIDEO: "Video",
  AUDIO: "Voice message",
  DOCUMENT: "Document",
  STICKER: "Sticker",
  LOCATION: "Location",
  CONTACT: "Shared contact",
  INTERACTIVE: "Interactive reply",
  BUTTON: "Button reply",
  FLOW: "Form response",
  TEMPLATE: "Template message",
  SYSTEM: "System notice",
  REACTION: "Reaction",
  UNKNOWN: "Unsupported message",
};

/** LIKE/ILIKE wildcards in staff-typed search text are literal characters, not patterns. */
export function likePattern(term: string, mode: "contains" | "prefix"): string {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return mode === "contains" ? `%${escaped}%` : `${escaped}%`;
}

type Row = BotRow & {
  id: string;
  status: ConversationStatus;
  account_id: string;
  account_label: string;
  last_message_at: string;
  last_inbound_at: string | null;
  cursor_t: string;
  profile_name: string | null;
  username: string | null;
  wa_id: string | null;
  bsuid: string | null;
  assignee_membership_id: string | null;
  assignee_name: string | null;
  assignee_status: string | null;
  preview_direction: "INBOUND" | "OUTBOUND" | null;
  preview_type: string | null;
  preview_body: string | null;
  unread: number;
};

export function unreadCountSql(
  membershipId: string,
  organizationId: string,
  conversationAlias = "c",
) {
  const c = sql.raw(conversationAlias);
  // Messages older than the membership itself are not "unread" for it: a new staff member does not inherit a backlog.
  return sql`(SELECT count(*)::int FROM (
      SELECT 1 FROM messages um
      WHERE um.organization_id = ${organizationId}::uuid AND um.conversation_id = ${c}.id
        AND um.direction = 'INBOUND' AND um.type NOT IN ('REACTION', 'SYSTEM')
        AND um.created_at >= (SELECT mm.created_at FROM organization_memberships mm
                              WHERE mm.organization_id = ${organizationId}::uuid AND mm.id = ${membershipId}::uuid)
        AND NOT EXISTS (SELECT 1 FROM message_reads r
                        WHERE r.organization_id = ${organizationId}::uuid AND r.membership_id = ${membershipId}::uuid
                          AND r.message_id = um.id)
      LIMIT ${UNREAD_CAP + 1}) q)`;
}

export async function listConversations(
  ctx: AccessContext,
  rawQuery: unknown,
  deps: InboxDeps = {},
): Promise<ConversationPage> {
  assertCan(ctx, "conversation.read");
  const parsed = listQuerySchema.safeParse(rawQuery);
  if (!parsed.success)
    throw new ValidationError([
      ...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "query"))),
    ]);
  const q = parsed.data;
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
  if (q.cursor !== undefined && cursor === null) throw new ValidationError(["cursor"]);
  // Bot data and the Bot Attention filter need bot.read as well (owner decision D-3): without it the request is refused and no
  // response field carries bot data.
  if (q.view === "botAttention") assertCan(ctx, "bot.read");
  const withBot = ctx.can("bot.read");
  const db = deps.db ?? getDb();

  const where: SQL[] = [sql`c.organization_id = ${ctx.organizationId}::uuid`];
  if (q.view === "botAttention") where.push(BOT_ATTENTION_SQL);
  if (q.accountId) where.push(sql`c.whatsapp_account_id = ${q.accountId}::uuid`);
  if (q.view === "OPEN" || q.view === "PENDING" || q.view === "RESOLVED")
    where.push(sql`c.status = ${q.view}`);
  if (q.view === "mine") where.push(sql`c.assigned_membership_id = ${ctx.membershipId}::uuid`);
  if (q.view === "unassigned") where.push(sql`c.assigned_membership_id IS NULL`);
  if (q.view === "unread") where.push(sql`unread.n > 0`);
  if (q.q) {
    const contains = likePattern(q.q, "contains");
    const prefix = likePattern(q.q, "prefix");
    where.push(sql`(ct.profile_name ILIKE ${contains} ESCAPE '\\'
        OR ct.username ILIKE ${contains} ESCAPE '\\'
        OR ct.wa_id LIKE ${prefix} ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM contact_bsuids sb
                   WHERE sb.organization_id = c.organization_id AND sb.contact_id = ct.id AND sb.bsuid = ${q.q}))`);
  }
  if (cursor)
    where.push(sql`(c.last_message_at, c.id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)`);

  const result = await db.execute<Row>(sql`
    SELECT c.id, c.status, c.whatsapp_account_id AS account_id, a.display_phone_number AS account_label,
           c.last_message_at, c.last_inbound_at,
           to_char(c.last_message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_t,
           ct.profile_name, ct.username, ct.wa_id,
           (SELECT b.bsuid FROM contact_bsuids b
             WHERE b.organization_id = c.organization_id AND b.contact_id = ct.id
             ORDER BY (b.retired_at IS NULL) DESC, b.last_seen_at DESC LIMIT 1) AS bsuid,
           c.assigned_membership_id AS assignee_membership_id, au.name AS assignee_name, am.status AS assignee_status,
           lm.direction AS preview_direction, lm.type AS preview_type, lm.body AS preview_body,
           unread.n AS unread${withBot ? sql`, ${BOT_COLUMNS_SQL}` : sql``}
    FROM conversations c
    JOIN contacts ct ON ct.organization_id = c.organization_id AND ct.id = c.contact_id
    JOIN whatsapp_accounts a ON a.organization_id = c.organization_id AND a.id = c.whatsapp_account_id
    LEFT JOIN organization_memberships am
           ON am.organization_id = c.organization_id AND am.id = c.assigned_membership_id
    LEFT JOIN users au ON au.id = am.user_id
    LEFT JOIN LATERAL (
      SELECT m.direction, m.type, m.body FROM messages m
      WHERE m.organization_id = c.organization_id AND m.conversation_id = c.id
      ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1) lm ON true
    CROSS JOIN LATERAL (SELECT ${unreadCountSql(ctx.membershipId, ctx.organizationId)} AS n) unread
    ${withBot ? botJoinSql(ctx.organizationId) : sql``}
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY c.last_message_at DESC, c.id DESC
    LIMIT ${q.limit + 1}`);

  const rows = result.rows;
  const page = rows.slice(0, q.limit);
  const items: ConversationListItem[] = page.map((r) => ({
    ...botField(r, withBot),
    id: r.id,
    status: r.status,
    account: { id: r.account_id, label: safeLine(r.account_label, 40) },
    contact: contactLabel({
      profileName: r.profile_name,
      username: r.username,
      waId: r.wa_id,
      bsuid: r.bsuid,
    }),
    lastMessageAt: new Date(r.last_message_at).toISOString(),
    activityKey: r.cursor_t,
    lastInboundAt: r.last_inbound_at ? new Date(r.last_inbound_at).toISOString() : null,
    preview:
      r.preview_direction === null
        ? null
        : {
            direction: r.preview_direction,
            text:
              safeLine(r.preview_body, 120) || FALLBACK_PREVIEWS[r.preview_type ?? ""] || "Message",
          },
    assignee: r.assignee_membership_id
      ? {
          membershipId: r.assignee_membership_id,
          name: safeLine(r.assignee_name, 80) || "Staff member",
          suspended: r.assignee_status !== "ACTIVE",
        }
      : null,
    unreadCount: Math.min(r.unread, UNREAD_CAP),
    unreadCapped: r.unread > UNREAD_CAP,
  }));
  const last = page[page.length - 1];
  return {
    items,
    nextCursor:
      rows.length > q.limit && last ? encodeCursor({ t: last.cursor_t, id: last.id }) : null,
  };
}

/** The organization's WhatsApp numbers, for the inbox account filter (whatsapp_account.read: every role). */
export async function listInboxAccounts(
  ctx: AccessContext,
  deps: InboxDeps = {},
): Promise<Array<{ id: string; label: string }>> {
  assertCan(ctx, "whatsapp_account.read");
  const db = deps.db ?? getDb();
  const result = await db.execute<{ id: string; label: string }>(sql`
    SELECT id, display_phone_number AS label FROM whatsapp_accounts
    WHERE organization_id = ${ctx.organizationId}::uuid AND archived_at IS NULL
    ORDER BY display_phone_number, id`);
  return result.rows.map((r) => ({ id: r.id, label: safeLine(r.label, 40) }));
}
