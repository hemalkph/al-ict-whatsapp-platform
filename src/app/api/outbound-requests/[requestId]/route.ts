import { getOutboundRequest } from "@/modules/messaging";
import { handleApi } from "@/lib/route-helpers";

// GET /api/outbound-requests/:requestId   (conversation.read) - status of one outbound request in the caller's organization.
// ACCEPTED means Meta returned a message id, not that the message was delivered: delivery state comes from STATUS webhooks.
export async function GET(request: Request, context: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await context.params;
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: { request: await getOutboundRequest(ctx, requestId) },
  }));
}
