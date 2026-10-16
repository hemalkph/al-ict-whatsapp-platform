import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requestHeaders } from "@/lib/request-headers";
import { getPageAccess, pageRedirectFor } from "@/modules/access";
import { getLeadDetail } from "@/modules/leads";
import { NotFoundError } from "@/shared/errors/http-errors";
import { parseLeadFilters } from "../lead-filters";
import { LeadDetailApp } from "./lead-detail-app";
import { leadsListPath } from "./lead-detail";

export const metadata: Metadata = { title: "Lead · A/L ICT WhatsApp Platform" };

// The lead page (Phase 07D-3). Server component: it checks access, loads the lead of the actor's own organization and renders it,
// so the screen is useful before any JavaScript runs. The organization comes from the authenticated session, never from the
// browser. This check is a convenience gate, not the security boundary: getLeadDetail authorizes again (lead.read, contact.read,
// conversation.read) and scopes every statement to the organization, and so does every API route the client calls.
//
// A lead that does not exist, is not a valid id, or belongs to another organization all end in the SAME not-found page: nothing
// tells them apart. The query string carries only the Leads list's filters (so "Back to leads" can return to the same list);
// they are parsed and re-serialized by the list's own code, so the link can only ever point at /leads with canonical filters.

export default async function LeadDetailPage({ params, searchParams }: PageProps<"/leads/[id]">) {
  const { id } = await params;
  const access = await getPageAccess(await requestHeaders());
  if (access.status !== "ok")
    redirect(pageRedirectFor(access.status, `/leads/${encodeURIComponent(id)}`));
  const { ctx } = access;

  if (!ctx.can("lead.read") || !ctx.can("contact.read") || !ctx.can("conversation.read"))
    return (
      <main className="mx-auto w-full max-w-3xl p-6">
        <h1 className="text-xl font-semibold text-zinc-900">Lead</h1>
        <p role="alert" className="mt-3 text-sm text-zinc-700">
          You do not have permission to view this lead.
        </p>
      </main>
    );

  let detail;
  try {
    detail = await getLeadDetail(ctx, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  return (
    <LeadDetailApp
      key={detail.lead.id}
      initial={detail}
      backHref={leadsListPath(parseLeadFilters(await searchParams))}
      me={{
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        membershipId: ctx.membershipId,
      }}
    />
  );
}
