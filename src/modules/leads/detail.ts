import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { assertCan, type AccessContext } from "@/modules/access";
import { NotFoundError } from "@/shared/errors/http-errors";
import { linkedTouches, otherTouches } from "./attribution";
import { identifierTail, iso, safeLine } from "./display";
import { selectEvents } from "./history";
import { itemOf, selectLeadRows, sourceSummary, type LeadsDeps } from "./items";
import { PAGE_SIZE_DEFAULT, uuid } from "./schemas";
import type { ConversationRef, LeadDetail } from "./types";

// Everything the lead screen needs, in a fixed number of organization-scoped statements (no N+1). The lead's own evidence and the
// contact's other evidence are separate sections: unlinked evidence is never presented as evidence for this lead.

const HISTORY_IN_DETAIL = 20;
const CONVERSATION_LIMIT = 10;

export async function getLeadDetail(
  ctx: AccessContext,
  leadId: string,
  deps: LeadsDeps = {},
): Promise<LeadDetail> {
  // The detail combines lead, contact and conversation data: all three are required (every role that can read leads has them).
  assertCan(ctx, "lead.read");
  assertCan(ctx, "contact.read");
  assertCan(ctx, "conversation.read");
  if (!uuid.safeParse(leadId).success) throw new NotFoundError();
  const db = deps.db ?? getDb();

  const [row] = await selectLeadRows(db, ctx.organizationId, [sql`l.id = ${leadId}::uuid`], 1);
  // Another organization's lead is indistinguishable from a missing one.
  if (!row) throw new NotFoundError();
  const item = itemOf(row);
  const lead = { id: row.id, contactId: row.contact_id };

  const contact = await db.execute<{
    first_seen_at: Date;
    last_seen_at: Date;
    wa_id: string | null;
    bsuid: string | null;
  }>(sql`
    SELECT ct.first_seen_at, ct.last_seen_at, ct.wa_id,
           (SELECT b.bsuid FROM contact_bsuids b WHERE b.organization_id = ct.organization_id AND b.contact_id = ct.id
             ORDER BY (b.retired_at IS NULL) DESC, b.last_seen_at DESC LIMIT 1) AS bsuid
    FROM contacts ct
    WHERE ct.organization_id = ${ctx.organizationId}::uuid AND ct.id = ${row.contact_id}::uuid`);
  const c = contact.rows[0]!;

  const conversations = await db.execute<{
    id: string;
    status: ConversationRef["status"];
    account_label: string;
    last_message_at: Date;
  }>(sql`
    SELECT c.id, c.status, a.display_phone_number AS account_label, c.last_message_at
    FROM conversations c
    JOIN whatsapp_accounts a ON a.organization_id = c.organization_id AND a.id = c.whatsapp_account_id
    WHERE c.organization_id = ${ctx.organizationId}::uuid AND c.contact_id = ${row.contact_id}::uuid
    ORDER BY c.last_message_at DESC, c.id DESC
    LIMIT ${CONVERSATION_LIMIT}`);

  const origin = await db.execute<{ origin: "MANUAL" | "AD_REFERRAL" }>(sql`
    SELECT origin FROM lead_events
    WHERE organization_id = ${ctx.organizationId}::uuid AND lead_id = ${leadId}::uuid AND kind = 'CREATED'`);

  const linked = await linkedTouches(db, ctx.organizationId, lead);
  const other = await otherTouches(db, ctx.organizationId, lead);
  const history = await selectEvents(
    db,
    ctx.organizationId,
    leadId,
    Math.min(HISTORY_IN_DETAIL, PAGE_SIZE_DEFAULT),
    null,
  );

  return {
    lead: {
      ...item,
      closedAt: iso(row.closed_at),
      origin: origin.rows[0]?.origin ?? null,
    },
    contact: {
      id: row.contact_id,
      label: item.contact.label,
      archived: item.contact.archived,
      firstSeenAt: iso(c.first_seen_at)!,
      lastSeenAt: iso(c.last_seen_at)!,
      identity: {
        bsuidTail: identifierTail(c.bsuid, 6, 1),
        // The phone-based id last observed: NOT verified as the person's current number.
        lastObservedPhone: c.wa_id ? safeLine(c.wa_id, 40) : null,
      },
    },
    conversations: conversations.rows.map((r) => ({
      id: r.id,
      status: r.status,
      accountLabel: safeLine(r.account_label, 40),
      lastMessageAt: iso(r.last_message_at)!,
    })),
    attribution: {
      source: sourceSummary({
        adTouches: row.ad_n,
        linkedTouches: row.total_n,
        first: row.first_at,
        latest: row.latest_at,
      }),
      linked: linked.touches,
      linkedTotal: linked.total,
      first: linked.touches[0] ?? null,
      latest: linked.latest,
      otherForContact: other.touches,
      otherTotal: other.total,
    },
    history,
    can: { edit: ctx.can("lead.edit") },
  };
}
