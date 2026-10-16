import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requestHeaders } from "@/lib/request-headers";
import { getPageAccess, pageRedirectFor } from "@/modules/access";
import { listLeads } from "@/modules/leads";
import { leadListQuery, parseLeadFilters } from "./lead-filters";
import { LeadsApp } from "./leads-app";

export const metadata: Metadata = { title: "Leads · A/L ICT WhatsApp Platform" };

// The Leads page (Phase 07D-2). Server component: it checks access, reads the filters from the URL (unsupported values fall back
// to their defaults, never reach the API) and renders the first page of the actor's organization's leads, so the screen is useful
// before any JavaScript runs. The organization comes from the authenticated session, never from the browser. This check is a
// convenience gate, not the security boundary: listLeads authorizes again, and so does every API route the client calls.

export default async function LeadsPage({ searchParams }: PageProps<"/leads">) {
  const access = await getPageAccess(await requestHeaders());
  if (access.status !== "ok") redirect(pageRedirectFor(access.status, "/leads"));
  const { ctx } = access;

  if (!ctx.can("lead.read"))
    return (
      <main className="mx-auto w-full max-w-3xl p-6">
        <h1 className="text-xl font-semibold text-zinc-900">Leads</h1>
        <p role="alert" className="mt-3 text-sm text-zinc-700">
          You do not have permission to view leads.
        </p>
      </main>
    );

  const filters = parseLeadFilters(await searchParams);
  // the same query string the browser would send (lead-filters.ts), validated again by the module's strict schema
  const page = await listLeads(
    ctx,
    Object.fromEntries(new URLSearchParams(leadListQuery(filters))),
  );

  return (
    <LeadsApp
      initial={{ filters, page }}
      me={{
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        membershipId: ctx.membershipId,
      }}
    />
  );
}
