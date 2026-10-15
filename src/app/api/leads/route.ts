import { handleApi } from "@/lib/route-helpers";
import { createManualLead, listLeads } from "@/modules/leads";

// GET /api/leads?state=&status=&attribution=&q=&cursor=&limit=   (lead.read)
// One page of the caller's organization's leads (keyset pagination). All validation and scoping is in the module.
export async function GET(request: Request) {
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: await listLeads(ctx, Object.fromEntries(new URL(request.url).searchParams)),
  }));
}

// POST /api/leads   { contactId }   (lead.edit)
// Manual creation. 201 with the new lead, or 200 with the contact's existing open lead (nothing was created).
export async function POST(request: Request) {
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => {
    const result = await createManualLead(ctx, body);
    return { status: result.created ? 201 : 200, data: result };
  });
}
