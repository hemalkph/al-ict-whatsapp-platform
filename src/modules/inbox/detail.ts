import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { assertCan, type AccessContext } from "@/modules/access";
import { getReplyReadiness } from "@/modules/messaging";
import { NotFoundError } from "@/shared/errors/http-errors";
import { BOT_COLUMNS_SQL, botField, botJoinSql, type BotRow } from "./bot-indicator";
import { contactLabel, safeLine } from "./display";
import type { InboxDeps } from "./list";
import { uuid } from "./text";
import type { ConversationDetail, ConversationStatus, HistoryEntry, TagView } from "./types";

type Row = BotRow & {
  id: string;
  status: ConversationStatus;
  created_at: Date;
  last_inbound_at: Date | null;
  last_outbound_at: Date | null;
  resolved_at: Date | null;
  account_id: string;
  account_label: string;
  assignee_membership_id: string | null;
  assignee_name: string | null;
  assignee_status: string | null;
  contact_id: string;
  profile_name: string | null;
  username: string | null;
  wa_id: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  consent: "UNKNOWN" | "GRANTED" | "WITHDRAWN";
  newest_bsuid: string | null;
  has_current_bsuid: boolean;
  has_any_bsuid: boolean;
};

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

/** Tags of a contact (organization-scoped). Archived tags are included and flagged so staff can still remove them. */
async function listContactTags(
  db: NonNullable<InboxDeps["db"]>,
  organizationId: string,
  contactId: string,
): Promise<TagView[]> {
  const rows = await db.execute<{
    id: string;
    name: string;
    color: string | null;
    archived_at: Date | null;
  }>(sql`
    SELECT t.id, t.name, t.color, t.archived_at
    FROM contact_tags ct
    JOIN tags t ON t.organization_id = ct.organization_id AND t.id = ct.tag_id
    WHERE ct.organization_id = ${organizationId}::uuid AND ct.contact_id = ${contactId}::uuid
    ORDER BY lower(t.name), t.id`);
  return rows.rows.map((r) => ({
    id: r.id,
    name: safeLine(r.name, 40),
    color: r.color ? safeLine(r.color, 16) : null,
    archived: r.archived_at !== null,
  }));
}

export async function getConversationDetail(
  ctx: AccessContext,
  conversationId: string,
  deps: InboxDeps & { now?: () => Date } = {},
): Promise<ConversationDetail> {
  assertCan(ctx, "conversation.read");
  if (!uuid.safeParse(conversationId).success) throw new NotFoundError();
  const withBot = ctx.can("bot.read");
  const db = deps.db ?? getDb();

  const found = await db.execute<Row>(sql`
    SELECT c.id, c.status, c.created_at, c.last_inbound_at, c.last_outbound_at, c.resolved_at,
           c.whatsapp_account_id AS account_id, a.display_phone_number AS account_label,
           c.assigned_membership_id AS assignee_membership_id, au.name AS assignee_name, am.status AS assignee_status,
           ct.id AS contact_id, ct.profile_name, ct.username, ct.wa_id, ct.first_seen_at, ct.last_seen_at,
           ct.marketing_consent_status AS consent,
           (SELECT b.bsuid FROM contact_bsuids b WHERE b.organization_id = c.organization_id AND b.contact_id = ct.id
             ORDER BY (b.retired_at IS NULL) DESC, b.last_seen_at DESC LIMIT 1) AS newest_bsuid,
           EXISTS (SELECT 1 FROM contact_bsuids b WHERE b.organization_id = c.organization_id AND b.contact_id = ct.id
                     AND b.retired_at IS NULL) AS has_current_bsuid,
           EXISTS (SELECT 1 FROM contact_bsuids b WHERE b.organization_id = c.organization_id AND b.contact_id = ct.id)
             AS has_any_bsuid${withBot ? sql`, ${BOT_COLUMNS_SQL}` : sql``}
    FROM conversations c
    JOIN contacts ct ON ct.organization_id = c.organization_id AND ct.id = c.contact_id
    JOIN whatsapp_accounts a ON a.organization_id = c.organization_id AND a.id = c.whatsapp_account_id
    LEFT JOIN organization_memberships am ON am.organization_id = c.organization_id AND am.id = c.assigned_membership_id
    LEFT JOIN users au ON au.id = am.user_id
    ${withBot ? botJoinSql(ctx.organizationId) : sql``}
    WHERE c.organization_id = ${ctx.organizationId}::uuid AND c.id = ${conversationId}::uuid`);
  const r = found.rows[0];
  // Another organization's conversation is indistinguishable from a missing one.
  if (!r) throw new NotFoundError();

  const history = await db.execute<{
    id: string;
    kind: "ASSIGNMENT" | "STATUS";
    created_at: Date;
    actor_name: string | null;
    from_assignee: string | null;
    to_assignee: string | null;
    from_status: string | null;
    to_status: string | null;
  }>(sql`
    SELECT e.id, e.kind, e.created_at, au.name AS actor_name,
           fu.name AS from_assignee, tu.name AS to_assignee, e.from_status, e.to_status
    FROM conversation_events e
    LEFT JOIN organization_memberships ac ON ac.organization_id = e.organization_id AND ac.id = e.actor_membership_id
    LEFT JOIN users au ON au.id = ac.user_id
    LEFT JOIN organization_memberships fm ON fm.organization_id = e.organization_id AND fm.id = e.from_assignee_membership_id
    LEFT JOIN users fu ON fu.id = fm.user_id
    LEFT JOIN organization_memberships tm ON tm.organization_id = e.organization_id AND tm.id = e.to_assignee_membership_id
    LEFT JOIN users tu ON tu.id = tm.user_id
    WHERE e.organization_id = ${ctx.organizationId}::uuid AND e.conversation_id = ${conversationId}::uuid
    ORDER BY e.created_at DESC, e.id DESC LIMIT 10`);

  const reply = await getReplyReadiness(ctx, conversationId, { db, now: deps.now });
  const tags = ctx.can("contact.read")
    ? await listContactTags(db, ctx.organizationId, r.contact_id)
    : [];

  return {
    id: r.id,
    status: r.status,
    createdAt: iso(r.created_at)!,
    lastInboundAt: iso(r.last_inbound_at),
    lastOutboundAt: iso(r.last_outbound_at),
    resolvedAt: iso(r.resolved_at),
    account: { id: r.account_id, label: safeLine(r.account_label, 40) },
    assignee: r.assignee_membership_id
      ? {
          membershipId: r.assignee_membership_id,
          name: safeLine(r.assignee_name, 80) || "Staff member",
          suspended: r.assignee_status !== "ACTIVE",
        }
      : null,
    contact: {
      id: r.contact_id,
      label: contactLabel({
        profileName: r.profile_name,
        username: r.username,
        waId: r.wa_id,
        bsuid: r.newest_bsuid,
      }),
      firstSeenAt: iso(r.first_seen_at)!,
      lastSeenAt: iso(r.last_seen_at)!,
      marketingConsent: r.consent,
      identity: {
        bsuidTail: r.newest_bsuid ? `…${r.newest_bsuid.slice(-6)}` : null,
        hasCurrentBsuid: r.has_current_bsuid,
        lastObservedPhone: r.wa_id ? safeLine(r.wa_id, 40) : null,
        // A phone that was stored for a contact that has since been seen with a BSUID is a historical value, not proof of
        // who owns that number now (Phase 05 never sends to it either).
        phoneIsHistorical: r.wa_id !== null && r.has_any_bsuid,
      },
      tags,
    },
    history: history.rows.map((e): HistoryEntry => ({
      id: e.id,
      kind: e.kind,
      at: iso(e.created_at)!,
      actorName: safeLine(e.actor_name, 80) || "Staff member",
      from: e.kind === "ASSIGNMENT" ? safeLine(e.from_assignee, 80) || null : e.from_status,
      to: e.kind === "ASSIGNMENT" ? safeLine(e.to_assignee, 80) || null : e.to_status,
    })),
    reply: {
      outboundEnabled: reply.outboundEnabled,
      canQueueText: reply.canQueueText,
      reason: reply.reason,
      windowClosesAt: iso(reply.windowClosesAt),
    },
    can: {
      reply: ctx.can("conversation.reply"),
      manage: ctx.can("conversation.manage"),
      editContact: ctx.can("contact.edit"),
      manageTags: ctx.can("tag.manage"),
    },
    ...botField(r, withBot),
  };
}
