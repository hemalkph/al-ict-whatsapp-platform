import { handleApi } from "@/lib/route-helpers";
import { changeLeadStatus } from "@/modules/leads";

// POST /api/leads/:id/status   { to, expectedRevision }   (lead.edit)
// 409 STALE_STATE when the lead is no longer at the revision the browser saw; 409 ALREADY_OPEN when reopening would give the
// contact a second open lead. Only the statuses staff may set are accepted.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => ({
    data: await changeLeadStatus(ctx, id, body),
  }));
}
