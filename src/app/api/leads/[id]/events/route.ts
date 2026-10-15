import { handleApi } from "@/lib/route-helpers";
import { listLeadEvents } from "@/modules/leads";

// GET /api/leads/:id/events?cursor=&limit=   (lead.read + contact.read + conversation.read)
// Read-only: there is no endpoint that writes lead history.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: await listLeadEvents(ctx, id, Object.fromEntries(new URL(request.url).searchParams)),
  }));
}
