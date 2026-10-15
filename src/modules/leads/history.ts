import { sql, type SQL } from "drizzle-orm";
import { getDb, type Database } from "@/db";
import { assertCan, type AccessContext } from "@/modules/access";
import { NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import { CURSOR_FORMAT, decodeCursor, encodeCursor } from "./cursor";
import { iso, safeLine, sourceLabel } from "./display";
import type { LeadsDeps } from "./items";
import { eventsQuerySchema, parseOrThrow, uuid } from "./schemas";
import type { LeadEventPage, LeadEventView, LeadStatus } from "./types";

// Lead history reads. The history is written only by the lead services (and, from 07C, the reconciler): there is no way to add,
// change or delete a row through any API, and the database makes the table append-only.

type EventRow = {
  id: string;
  kind: LeadEventView["kind"];
  created_at: Date;
  cursor_t: string;
  actor_name: string | null;
  actor_membership_id: string | null;
  origin: "MANUAL" | "AD_REFERRAL" | null;
  from_status: LeadStatus | null;
  to_status: LeadStatus | null;
  revision: number | null;
  attribution_id: string | null;
  source_type: string | null;
};

export function eventView(e: EventRow): LeadEventView {
  return {
    id: e.id,
    kind: e.kind,
    at: iso(e.created_at)!,
    atKey: e.cursor_t,
    // NULL actor = the system (an automatic lead, a linked touch). A staff member whose name is empty is still "a staff member".
    actorName: e.actor_membership_id ? safeLine(e.actor_name, 80) || "Staff member" : null,
    origin: e.origin,
    from: e.from_status,
    to: e.to_status,
    revision: e.revision,
    touch: e.attribution_id
      ? { id: e.attribution_id, label: sourceLabel(e.source_type ?? "") }
      : null,
  };
}

/** One page of a lead's history, newest first. The caller has already established that the lead exists in the organization. */
export async function selectEvents(
  db: Pick<Database, "execute">,
  organizationId: string,
  leadId: string,
  limit: number,
  cursor: { t: string; id: string } | null,
): Promise<LeadEventPage> {
  const where: SQL[] = [
    sql`e.organization_id = ${organizationId}::uuid`,
    sql`e.lead_id = ${leadId}::uuid`,
  ];
  if (cursor)
    where.push(sql`(e.created_at, e.id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)`);
  const result = await db.execute<EventRow>(sql`
    SELECT e.id, e.kind, e.created_at, to_char(e.created_at AT TIME ZONE 'UTC', ${sql.raw(CURSOR_FORMAT)}) AS cursor_t,
           e.actor_membership_id, au.name AS actor_name, e.origin, e.from_status, e.to_status, e.revision,
           e.attribution_id, a.source_type
    FROM lead_events e
    LEFT JOIN organization_memberships am ON am.organization_id = e.organization_id AND am.id = e.actor_membership_id
    LEFT JOIN users au ON au.id = am.user_id
    LEFT JOIN lead_attributions a ON a.organization_id = e.organization_id AND a.id = e.attribution_id
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ${limit + 1}`);
  const page = result.rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    events: page.map(eventView),
    nextCursor:
      result.rows.length > limit && last ? encodeCursor({ t: last.cursor_t, id: last.id }) : null,
  };
}

export async function listLeadEvents(
  ctx: AccessContext,
  leadId: string,
  rawQuery: unknown,
  deps: LeadsDeps = {},
): Promise<LeadEventPage> {
  // The same permissions as the detail: the history names staff and refers to the contact's evidence.
  assertCan(ctx, "lead.read");
  assertCan(ctx, "contact.read");
  assertCan(ctx, "conversation.read");
  const q = parseOrThrow(eventsQuerySchema.safeParse(rawQuery));
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
  if (q.cursor !== undefined && cursor === null) throw new ValidationError(["cursor"]);
  if (!uuid.safeParse(leadId).success) throw new NotFoundError();
  const db = deps.db ?? getDb();
  const found = await db.execute<{ id: string }>(
    sql`SELECT id FROM leads WHERE organization_id = ${ctx.organizationId}::uuid AND id = ${leadId}::uuid`,
  );
  // Another organization's lead is the same 404 as a missing one.
  if (!found.rows[0]) throw new NotFoundError();
  return selectEvents(db, ctx.organizationId, leadId, q.limit, cursor);
}
