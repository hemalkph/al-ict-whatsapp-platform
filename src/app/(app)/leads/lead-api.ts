import type {
  ContactLeads,
  CreateLeadResult,
  LeadDetail,
  LeadEventPage,
  LeadPage,
  StatusChangeResult,
} from "@/modules/leads";
import { api } from "../inbox/api";
import { PAGE_LIMIT_MAX, leadListQuery, type LeadFilters } from "./lead-filters";
import type { StaffSettableStatus } from "./lead-labels";

// The browser's typed wrappers for the six lead endpoints (Phase 07B). Every request goes through the SHARED client of the inbox
// (src/app/(app)/inbox/api.ts): same-origin fetch with the session cookie, a timeout and abort signal, the fixed error code in an
// ApiError, and the X-Expected-Actor assertion that the server checks (409 ACTOR_CHANGED stops the page). That client sends the
// assertion only once the page has declared its actor: a Leads page must call `setPageActor` with the actor the server rendered
// it for, before its first request, exactly as the inbox does. Nothing here retries; see lead-errors.ts for what is safe.
//
// Types are imported with `import type` from the leads module's public API: erased at build time, so no server code reaches the
// browser bundle (a static test pins this). Path segments are encoded; the server validates every id and answers 404 for an
// invalid or foreign one. The client authorizes nothing: the server checks permissions and the organization on every call.

export { setPageActor, subscribeActorChanged, getActorChanged, ApiError } from "../inbox/api";

type Signal = { readonly signal?: AbortSignal };
const seg = (id: string) => encodeURIComponent(id);

/** GET /api/leads: one page of the organization's leads, newest first. */
export function fetchLeadPage(
  filters: LeadFilters,
  options: Signal & { readonly cursor?: string | null; readonly limit?: number } = {},
): Promise<LeadPage> {
  const query = leadListQuery(filters, { cursor: options.cursor, limit: options.limit });
  return api<LeadPage>(`/api/leads${query ? `?${query}` : ""}`, {
    signal: options.signal,
    okStatuses: [200],
  });
}

/** GET /api/leads/:id: the lead, its contact and conversations, its attribution and the first page of its history. */
export function fetchLeadDetail(leadId: string, options: Signal = {}): Promise<LeadDetail> {
  return api<LeadDetail>(`/api/leads/${seg(leadId)}`, {
    signal: options.signal,
    okStatuses: [200],
  });
}

/** GET /api/leads/:id/events: an older page of a lead's history (newest first), from the cursor the previous page returned. */
export function fetchLeadEvents(
  leadId: string,
  options: Signal & { readonly cursor?: string | null; readonly limit?: number } = {},
): Promise<LeadEventPage> {
  const p = new URLSearchParams();
  if (options.cursor) p.set("cursor", options.cursor);
  if (options.limit !== undefined)
    p.set("limit", String(Math.min(PAGE_LIMIT_MAX, Math.max(1, Math.trunc(options.limit)))));
  const query = p.toString();
  return api<LeadEventPage>(`/api/leads/${seg(leadId)}/events${query ? `?${query}` : ""}`, {
    signal: options.signal,
    okStatuses: [200],
  });
}

/** GET /api/leads/for-contact/:contactId: the contact's open lead (if any), recent leads and `can.create` (for the inbox card). */
export function fetchContactLeads(contactId: string, options: Signal = {}): Promise<ContactLeads> {
  return api<ContactLeads>(`/api/leads/for-contact/${seg(contactId)}`, {
    signal: options.signal,
    okStatuses: [200],
  });
}

/**
 * POST /api/leads { contactId }: manual creation. 201 `created: true` with the new lead, or 200 `created: false` with the
 * contact's EXISTING open lead (nothing was created). Any other success status is not trusted (BAD_RESPONSE).
 */
export function createLead(contactId: string, options: Signal = {}): Promise<CreateLeadResult> {
  return api<CreateLeadResult>("/api/leads", {
    method: "POST",
    body: { contactId },
    signal: options.signal,
    okStatuses: [200, 201],
  });
}

/**
 * POST /api/leads/:id/status { to, expectedRevision }: applies only if the lead still has the revision the user saw (else 409
 * STALE_STATE). `changed: false` means the lead already had that status. Only staff-settable statuses can be sent.
 */
export function changeLeadStatus(
  leadId: string,
  change: { readonly to: StaffSettableStatus; readonly expectedRevision: number },
  options: Signal = {},
): Promise<StatusChangeResult> {
  return api<StatusChangeResult>(`/api/leads/${seg(leadId)}/status`, {
    method: "POST",
    body: { to: change.to, expectedRevision: change.expectedRevision },
    signal: options.signal,
    okStatuses: [200],
  });
}
