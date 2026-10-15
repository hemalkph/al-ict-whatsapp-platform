import { handleApi } from "@/lib/route-helpers";
import { getLeadDetail } from "@/modules/leads";

// GET /api/leads/:id   (lead.read + contact.read + conversation.read)
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: await getLeadDetail(ctx, id),
  }));
}
