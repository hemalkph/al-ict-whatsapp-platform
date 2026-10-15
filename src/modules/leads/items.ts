import { sql, type SQL } from "drizzle-orm";
import { schema, type Database } from "@/db";
import { CURSOR_FORMAT } from "./cursor";
import { contactLabel, iso } from "./display";
import { isOpenStatus, isReserved } from "./rules";
import { NO_REFERRAL_LABEL, type LeadItem, type LeadStatus, type SourceSummary } from "./types";

// The one query that turns leads into list items: used by the list, by "leads of a contact" and by the write results, so a lead
// looks the same everywhere. Everything is decided in ONE statement scoped by organization: the contact and the summary of the
// advertisement evidence LINKED TO EACH LEAD come from a join and a lateral aggregate, so a page of N leads costs one round trip.

export type LeadsDeps = { readonly db?: Database };

export type ItemRow = {
  id: string;
  contact_id: string;
  status: LeadStatus;
  revision: number;
  created_at: Date;
  status_changed_at: Date;
  cycle_started_at: Date;
  closed_at: Date | null;
  cursor_t: string;
  profile_name: string | null;
  username: string | null;
  wa_id: string | null;
  bsuid: string | null;
  archived_at: Date | null;
  ad_n: number;
  total_n: number;
  first_at: Date | null;
  latest_at: Date | null;
};

type Executor = Pick<Database, "execute">;

/** The statuses as a SQL list of bound parameters. */
const statusList = (statuses: readonly string[]) =>
  sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  );
export const openStatusesSql = () => statusList(schema.OPEN_LEAD_STATUSES);
export const closedStatusesSql = () => statusList(schema.CLOSED_LEAD_STATUSES);

export function sourceSummary(counts: {
  adTouches: number;
  linkedTouches: number;
  first: Date | null;
  latest: Date | null;
}): SourceSummary {
  const kind =
    counts.adTouches > 0 ? "META_AD" : counts.linkedTouches > 0 ? "OTHER_REFERRAL" : "NONE";
  return {
    kind,
    // Honest labels: a lead without linked evidence is "no referral recorded", never "organic".
    label:
      kind === "META_AD"
        ? "Meta ad"
        : kind === "OTHER_REFERRAL"
          ? "Referral recorded (not a confirmed Meta ad)"
          : NO_REFERRAL_LABEL,
    adTouches: counts.adTouches,
    linkedTouches: counts.linkedTouches,
    firstReceivedAt: iso(counts.first),
    latestReceivedAt: iso(counts.latest),
  };
}

export function itemOf(r: ItemRow): LeadItem {
  return {
    id: r.id,
    status: r.status,
    revision: r.revision,
    open: isOpenStatus(r.status),
    readOnly: isReserved(r.status),
    createdAt: iso(r.created_at)!,
    createdKey: r.cursor_t,
    statusChangedAt: iso(r.status_changed_at)!,
    cycleStartedAt: iso(r.cycle_started_at)!,
    contact: {
      id: r.contact_id,
      label: contactLabel({
        profileName: r.profile_name,
        username: r.username,
        waId: r.wa_id,
        bsuid: r.bsuid,
      }),
      archived: r.archived_at !== null,
    },
    source: sourceSummary({
      adTouches: r.ad_n,
      linkedTouches: r.total_n,
      first: r.first_at,
      latest: r.latest_at,
    }),
  };
}

/**
 * Leads of one organization, newest first (created_at, id), `where` fragments ANDed after the organization scope, `limit` rows.
 * The caller supplies only trusted SQL fragments built from bound parameters.
 */
export async function selectLeadRows(
  db: Executor,
  organizationId: string,
  where: SQL[],
  limit: number,
): Promise<ItemRow[]> {
  const result = await db.execute<ItemRow>(sql`
    SELECT l.id, l.contact_id, l.status, l.revision, l.created_at, l.status_changed_at, l.cycle_started_at, l.closed_at,
           to_char(l.created_at AT TIME ZONE 'UTC', ${sql.raw(CURSOR_FORMAT)}) AS cursor_t,
           ct.profile_name, ct.username, ct.wa_id, ct.archived_at,
           (SELECT b.bsuid FROM contact_bsuids b
             WHERE b.organization_id = l.organization_id AND b.contact_id = ct.id
             ORDER BY (b.retired_at IS NULL) DESC, b.last_seen_at DESC LIMIT 1) AS bsuid,
           src.ad_n, src.total_n, src.first_at, src.latest_at
    FROM leads l
    JOIN contacts ct ON ct.organization_id = l.organization_id AND ct.id = l.contact_id
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE a.source_type = 'META_AD')::int AS ad_n, count(*)::int AS total_n,
             min(a.received_at) AS first_at, max(a.received_at) AS latest_at
      FROM lead_attributions a
      WHERE a.organization_id = l.organization_id AND a.contact_id = l.contact_id AND a.lead_id = l.id) src
    WHERE l.organization_id = ${organizationId}::uuid${where.length ? sql` AND ${sql.join(where, sql` AND `)}` : sql``}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${limit}`);
  return result.rows;
}

export async function getLeadItem(
  db: Executor,
  organizationId: string,
  leadId: string,
): Promise<LeadItem | null> {
  const [row] = await selectLeadRows(db, organizationId, [sql`l.id = ${leadId}::uuid`], 1);
  return row ? itemOf(row) : null;
}
