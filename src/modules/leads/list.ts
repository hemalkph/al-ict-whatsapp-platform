import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { assertCan, type AccessContext } from "@/modules/access";
import { ValidationError } from "@/shared/errors/http-errors";
import { decodeCursor, encodeCursor } from "./cursor";
import {
  closedStatusesSql,
  itemOf,
  openStatusesSql,
  selectLeadRows,
  type LeadsDeps,
} from "./items";
import { listQuerySchema, parseOrThrow } from "./schemas";
import type { LeadPage } from "./types";

// The lead list: one organization-scoped, keyset-paginated statement (created_at DESC, id DESC on leads_org_created_idx).
// created_at never changes, so a page that is being polled stays stable while leads change status.

/** LIKE/ILIKE wildcards in staff-typed search text are literal characters, not patterns. */
export function likePattern(term: string, mode: "contains" | "prefix"): string {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return mode === "contains" ? `%${escaped}%` : `${escaped}%`;
}

export async function listLeads(
  ctx: AccessContext,
  rawQuery: unknown,
  deps: LeadsDeps = {},
): Promise<LeadPage> {
  assertCan(ctx, "lead.read");
  const q = parseOrThrow(listQuerySchema.safeParse(rawQuery));
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
  if (q.cursor !== undefined && cursor === null) throw new ValidationError(["cursor"]);
  const db = deps.db ?? getDb();

  const where: SQL[] = [];
  if (q.state === "open") where.push(sql`l.status IN (${openStatusesSql()})`);
  if (q.state === "closed") where.push(sql`l.status IN (${closedStatusesSql()})`);
  if (q.status) where.push(sql`l.status = ${q.status}`);
  // "ad": a confirmed Meta ad touch is LINKED TO THE LEAD. "none": none is. Missing evidence is not "organic".
  if (q.attribution === "ad") where.push(sql`src.ad_n > 0`);
  if (q.attribution === "none") where.push(sql`src.ad_n = 0`);
  if (q.q) {
    const contains = likePattern(q.q, "contains");
    const prefix = likePattern(q.q, "prefix");
    where.push(sql`(ct.profile_name ILIKE ${contains} ESCAPE '\\'
        OR ct.username ILIKE ${contains} ESCAPE '\\'
        OR ct.wa_id LIKE ${prefix} ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM contact_bsuids sb
                   WHERE sb.organization_id = l.organization_id AND sb.contact_id = ct.id AND sb.bsuid = ${q.q}))`);
  }
  if (cursor)
    where.push(sql`(l.created_at, l.id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)`);

  const rows = await selectLeadRows(db, ctx.organizationId, where, q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(itemOf),
    nextCursor:
      rows.length > q.limit && last ? encodeCursor({ t: last.cursor_t, id: last.id }) : null,
  };
}
