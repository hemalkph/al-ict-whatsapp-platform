import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { assertCan, type AccessContext } from "@/modules/access";
import { NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import { decodeCursor, encodeCursor } from "./cursor";
import { deliveryView, describeMessage, mediaViews, safeLine } from "./display";
import type { InboxDeps } from "./list";
import { messagesQuerySchema } from "./schemas";
import { uuid } from "./text";
import type { MessagePage, TimelineMessage } from "./types";

type Row = {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  type: string;
  body: string | null;
  content: unknown;
  occurred_at: Date;
  cursor_t: string;
  latest_status: string | null;
  message_error_code: string | null;
  reply_to_message_id: string | null;
  reply_to_wamid: string | null;
  parent_direction: "INBOUND" | "OUTBOUND" | null;
  parent_type: string | null;
  parent_body: string | null;
  req_state: string | null;
  hold_reason: string | null;
  failure_code: string | null;
  provider_error_code: string | null;
  unseen: boolean;
  attachments: Array<{
    mimeType: string | null;
    filename: string | null;
    sizeBytes: number | null;
    storageStatus: string;
  }> | null;
};

/**
 * One page of a conversation's messages, newest page first but returned oldest-first for rendering. Scoped by organization,
 * conversation AND the conversation's WhatsApp account. Ordering is the provider's occurred_at with the row id as a tiebreak
 * (keyset pagination, stable while new messages arrive). Nothing is invented: a delivery indicator appears only from a real
 * outbound request or a real provider status; a stored provider timestamp is displayed but never rewritten.
 */
export async function listMessages(
  ctx: AccessContext,
  conversationId: string,
  rawQuery: unknown,
  deps: InboxDeps = {},
): Promise<MessagePage> {
  assertCan(ctx, "conversation.read");
  if (!uuid.safeParse(conversationId).success) throw new NotFoundError();
  const parsed = messagesQuerySchema.safeParse(rawQuery);
  if (!parsed.success)
    throw new ValidationError([
      ...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "query"))),
    ]);
  const q = parsed.data;
  const cursor = q.before === undefined ? null : decodeCursor(q.before);
  if (q.before !== undefined && cursor === null) throw new ValidationError(["before"]);
  const db = deps.db ?? getDb();

  const exists = await db.execute(sql`
    SELECT 1 FROM conversations WHERE organization_id = ${ctx.organizationId}::uuid AND id = ${conversationId}::uuid`);
  if (exists.rows.length === 0) throw new NotFoundError();

  const result = await db.execute<Row>(sql`
    SELECT m.id, m.direction, m.type, m.body, m.content, m.occurred_at,
           to_char(m.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_t,
           m.latest_status, m.error_code AS message_error_code, m.reply_to_message_id, m.reply_to_wamid,
           pm.direction AS parent_direction, pm.type AS parent_type, pm.body AS parent_body,
           o.state AS req_state, o.hold_reason, o.failure_code, o.provider_error_code,
           (m.direction = 'INBOUND' AND m.type NOT IN ('REACTION', 'SYSTEM')
             AND m.created_at >= (SELECT mm.created_at FROM organization_memberships mm
                                  WHERE mm.organization_id = ${ctx.organizationId}::uuid AND mm.id = ${ctx.membershipId}::uuid)
             AND NOT EXISTS (SELECT 1 FROM message_reads r
                             WHERE r.organization_id = m.organization_id AND r.membership_id = ${ctx.membershipId}::uuid
                               AND r.message_id = m.id)) AS unseen,
           att.items AS attachments
    FROM conversations c
    JOIN messages m ON m.organization_id = c.organization_id AND m.conversation_id = c.id
                   AND m.whatsapp_account_id = c.whatsapp_account_id
    LEFT JOIN messages pm ON pm.organization_id = m.organization_id AND pm.conversation_id = m.conversation_id
                         AND pm.id = m.reply_to_message_id
    LEFT JOIN outbound_requests o ON o.organization_id = m.organization_id AND o.message_id = m.id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('mimeType', a.mime_type, 'filename', a.filename,
                                        'sizeBytes', a.size_bytes, 'storageStatus', a.storage_status)
                      ORDER BY a.created_at, a.id) AS items
      FROM message_attachments a WHERE a.organization_id = m.organization_id AND a.message_id = m.id) att ON true
    WHERE c.organization_id = ${ctx.organizationId}::uuid AND c.id = ${conversationId}::uuid
      ${cursor ? sql`AND (m.occurred_at, m.id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : sql``}
    ORDER BY m.occurred_at DESC, m.id DESC
    LIMIT ${q.limit + 1}`);

  const page = result.rows.slice(0, q.limit);
  const messages = page.map((r): TimelineMessage => {
    const shown = describeMessage({ type: r.type, body: r.body, content: r.content });
    const parentShown = r.parent_type
      ? describeMessage({ type: r.parent_type, body: r.parent_body, content: null })
      : null;
    return {
      id: r.id,
      direction: r.direction,
      type: r.type,
      text: shown.text,
      placeholder: shown.placeholder,
      media: mediaViews(r.attachments ?? []),
      occurredAt: new Date(r.occurred_at).toISOString(),
      reply:
        r.reply_to_message_id || r.reply_to_wamid
          ? {
              resolved: r.reply_to_message_id !== null && r.parent_direction !== null,
              direction: r.parent_direction,
              preview: parentShown
                ? safeLine(parentShown.text ?? parentShown.placeholder, 140) || null
                : null,
            }
          : null,
      delivery:
        r.direction === "OUTBOUND"
          ? deliveryView({
              requestState: r.req_state,
              holdReason: r.hold_reason,
              failureCode: r.failure_code,
              providerStatus: r.latest_status,
              providerErrorCode: r.message_error_code ?? r.provider_error_code,
            })
          : null,
      unseen: r.direction === "INBOUND" && r.unseen,
    };
  });
  const oldest = page[page.length - 1];
  return {
    messages: messages.reverse(),
    olderCursor:
      result.rows.length > q.limit && oldest
        ? encodeCursor({ t: oldest.cursor_t, id: oldest.id })
        : null,
  };
}
