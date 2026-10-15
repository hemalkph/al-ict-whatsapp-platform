import { sql } from "drizzle-orm";
import type { Database } from "@/db";
import { CURSOR_FORMAT } from "./cursor";
import { clickIdTail, displayLink, iso, safeLine, safeText, sourceLabel } from "./display";
import type { OtherEvidenceView, TouchView } from "./types";

// The attribution read model of a lead. Two kinds of evidence are kept apart on purpose:
//   A. touches LINKED TO THIS LEAD (lead_attributions.lead_id = the lead): evidence for it;
//   B. other evidence recorded for the CONTACT (unlinked, or linked to a different lead): NOT evidence for this lead.
// Both are ordered by (received_at, id) so "first" and "latest" are deterministic. Nothing here writes, fetches or follows a
// provider URL, and provider_data and the click id are never returned.

type Executor = Pick<Database, "execute">;

/** The most touches returned in each group; the totals are always exact. */
export const TOUCH_LIMIT = 25;

type TouchRow = {
  id: string;
  source_type: string;
  received_at: Date;
  received_key: string;
  headline: string | null;
  body: string | null;
  source_id: string | null;
  source_url: string | null;
  media_type: string | null;
  media_url: string | null;
  ctwa_clid: string | null;
  initiating: boolean;
  total: number;
  lead_id: string | null;
  decision: string | null;
};

const touchColumns = sql`a.id, a.source_type, a.received_at, a.lead_id,
  to_char(a.received_at AT TIME ZONE 'UTC', ${sql.raw(CURSOR_FORMAT)}) AS received_key,
  a.headline, a.body, a.source_id, a.source_url, a.media_type, a.media_url, a.ctwa_clid,
  (l.initiating_attribution_id = a.id) AS initiating`;

export function touchView(r: TouchRow): TouchView {
  return {
    id: r.id,
    label: sourceLabel(r.source_type),
    receivedAt: iso(r.received_at)!,
    receivedKey: r.received_key,
    headline: safeLine(r.headline, 200) || null,
    body: safeText(r.body, 500) || null,
    sourceId: safeLine(r.source_id, 64) || null,
    sourceLink: displayLink(r.source_url),
    mediaType: safeLine(r.media_type, 40) || null,
    mediaLink: displayLink(r.media_url),
    clickIdTail: clickIdTail(r.ctwa_clid),
    initiating: r.initiating === true,
  };
}

/** Evidence linked to the lead, oldest first, and its exact count. */
export async function linkedTouches(
  db: Executor,
  organizationId: string,
  lead: { id: string; contactId: string },
): Promise<{ touches: TouchView[]; total: number; latest: TouchView | null }> {
  const asc = await db.execute<TouchRow>(sql`
    SELECT ${touchColumns}, count(*) OVER ()::int AS total
    FROM lead_attributions a
    JOIN leads l ON l.organization_id = a.organization_id AND l.id = a.lead_id
    WHERE a.organization_id = ${organizationId}::uuid AND a.contact_id = ${lead.contactId}::uuid
      AND a.lead_id = ${lead.id}::uuid
    ORDER BY a.received_at ASC, a.id ASC
    LIMIT ${TOUCH_LIMIT}`);
  const touches = asc.rows.map(touchView);
  const total = asc.rows[0]?.total ?? 0;
  if (total <= TOUCH_LIMIT) return { touches, total, latest: touches[touches.length - 1] ?? null };
  const desc = await db.execute<TouchRow>(sql`
    SELECT ${touchColumns}, 0 AS total
    FROM lead_attributions a
    JOIN leads l ON l.organization_id = a.organization_id AND l.id = a.lead_id
    WHERE a.organization_id = ${organizationId}::uuid AND a.contact_id = ${lead.contactId}::uuid
      AND a.lead_id = ${lead.id}::uuid
    ORDER BY a.received_at DESC, a.id DESC
    LIMIT 1`);
  return { touches, total, latest: desc.rows[0] ? touchView(desc.rows[0]) : null };
}

/** Other evidence recorded for the contact (not linked to this lead), newest first. */
export async function otherTouches(
  db: Executor,
  organizationId: string,
  lead: { id: string; contactId: string },
): Promise<{ touches: OtherEvidenceView[]; total: number }> {
  const result = await db.execute<TouchRow>(sql`
    SELECT ${touchColumns}, d.decision, count(*) OVER ()::int AS total
    FROM lead_attributions a
    LEFT JOIN leads l ON l.organization_id = a.organization_id AND l.id = a.lead_id
    LEFT JOIN lead_reconcile_decisions d ON d.organization_id = a.organization_id AND d.attribution_id = a.id
    WHERE a.organization_id = ${organizationId}::uuid AND a.contact_id = ${lead.contactId}::uuid
      AND a.lead_id IS DISTINCT FROM ${lead.id}::uuid
    ORDER BY a.received_at DESC, a.id DESC
    LIMIT ${TOUCH_LIMIT}`);
  return {
    total: result.rows[0]?.total ?? 0,
    touches: result.rows.map((r): OtherEvidenceView => ({
      ...touchView(r),
      initiating: false,
      attachment: r.lead_id === null ? "UNLINKED" : "OTHER_LEAD",
      decision: r.decision ? safeLine(r.decision, 32) : null,
    })),
  };
}
