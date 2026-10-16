import type { LeadStatus } from "@/modules/leads";
import { LEAD_STATUSES } from "./lead-labels";

// The Leads page filters <-> URL query, and the query the list API accepts. Pure functions: no React, no environment.
//
// The API (GET /api/leads, a STRICT schema: an unknown key is a 400) accepts exactly:
//   state=open|closed         omitted = every lead (there is no "all" value: "All" is the absence of the parameter)
//   status=<any lead status>  reserved statuses included (a filter may show them; staff still cannot set them)
//   attribution=ad|none       ad = at least one confirmed Meta ad touch is LINKED to the lead; none = no Meta ad touch is linked
//                             (such a lead may still have another referral linked: "none" is NOT "no referral" and NOT "organic")
//   q=<2-64 chars after trimming>  contains on profile name and username, prefix on the phone-based id, exact BSUID
//   cursor=<opaque>, limit=1-50 (default 30)
// The page URL carries the filters only. The cursor is list state: a filter change always starts again from the first page.

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 64;
export const PAGE_LIMIT_MAX = 50;

export type StateFilter = "all" | "open" | "closed";
export type AttributionFilter = "any" | "ad" | "none";

export type LeadFilters = {
  readonly state: StateFilter;
  readonly status: LeadStatus | null;
  readonly attribution: AttributionFilter;
  /** Valid search text (2-64 characters after trimming) or "" for no search. */
  readonly q: string;
};

export const DEFAULT_FILTERS: LeadFilters = {
  state: "all",
  status: null,
  attribution: "any",
  q: "",
};

export const STATE_FILTER_LABEL: Record<StateFilter, string> = {
  all: "All",
  open: "Open",
  closed: "Closed",
};

export const ATTRIBUTION_FILTER_LABEL: Record<AttributionFilter, string> = {
  any: "Any source",
  ad: "Meta ad referral linked",
  none: "No Meta ad referral linked",
};

export type SearchCheck =
  | { readonly kind: "empty"; readonly value: "" }
  | { readonly kind: "too_short"; readonly value: "" }
  | { readonly kind: "ok"; readonly value: string; readonly truncated: boolean };

/**
 * Normalizes search input the way the server will judge it: trimmed, at least SEARCH_MIN characters (shorter input is "no search
 * yet", not an error), and at most SEARCH_MAX (longer input is cut, as the inbox does, without splitting a surrogate pair;
 * lengths are UTF-16 code units, as the server's schema counts them).
 */
export function checkSearch(input: unknown): SearchCheck {
  if (typeof input !== "string") return { kind: "empty", value: "" };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { kind: "empty", value: "" };
  if (trimmed.length < SEARCH_MIN) return { kind: "too_short", value: "" };
  if (trimmed.length <= SEARCH_MAX) return { kind: "ok", value: trimmed, truncated: false };
  let cut = trimmed.slice(0, SEARCH_MAX);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  cut = cut.trimEnd();
  return cut.length >= SEARCH_MIN
    ? { kind: "ok", value: cut, truncated: true }
    : { kind: "too_short", value: "" };
}

type RawParams = URLSearchParams | Record<string, string | string[] | undefined>;

/** The FIRST value of a parameter (repeated parameters: the first wins, as on the inbox page); undefined when absent. */
function first(params: RawParams, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The status filter decides the state by itself (every status is either open or closed), so a URL that names a status keeps no
 * state, and one that contradicts it (state=open&status=NOT_INTERESTED) is resolved in favour of the status.
 */
function canonical(f: LeadFilters): LeadFilters {
  return f.status ? { ...f, state: "all" } : f;
}

/** Page URL (or Next.js searchParams) -> filters. Never throws; anything unsupported falls back to its default. */
export function parseLeadFilters(params: RawParams): LeadFilters {
  const state = first(params, "state");
  const status = first(params, "status");
  const attribution = first(params, "attribution");
  return canonical({
    state: state === "open" || state === "closed" ? state : "all",
    status:
      status !== undefined && (LEAD_STATUSES as readonly string[]).includes(status)
        ? (status as LeadStatus)
        : null,
    attribution: attribution === "ad" || attribution === "none" ? attribution : "any",
    q: checkSearch(first(params, "q")).value,
  });
}

function filterParams(f: LeadFilters): URLSearchParams {
  const c = canonical(f);
  const p = new URLSearchParams();
  if (c.state !== "all") p.set("state", c.state);
  if (c.status) p.set("status", c.status);
  if (c.attribution !== "any") p.set("attribution", c.attribution);
  const q = checkSearch(c.q);
  if (q.kind === "ok") p.set("q", q.value);
  return p;
}

/** Filters -> the page's query string, canonical (fixed order, defaults omitted, each key once): "" or "?state=open&q=…". */
export function leadFiltersToSearch(f: LeadFilters): string {
  const s = filterParams(f).toString();
  return s ? `?${s}` : "";
}

/** A stable identity of a filter set: two filter sets that ask the server the same question have the same key. */
export const filtersKey = (f: LeadFilters) => filterParams(f).toString();

/** Filters + list position -> the query for GET /api/leads. Only keys the API accepts; never `state=all` or `attribution=any`. */
export function leadListQuery(
  f: LeadFilters,
  page: { readonly cursor?: string | null; readonly limit?: number } = {},
): string {
  const p = filterParams(f);
  if (page.cursor) p.set("cursor", page.cursor);
  if (page.limit !== undefined)
    p.set("limit", String(Math.min(PAGE_LIMIT_MAX, Math.max(1, Math.trunc(page.limit)))));
  return p.toString();
}
