import { handleApi } from "@/lib/route-helpers";
import { markMessagesSeen } from "@/modules/inbox";

// POST /api/inbox/conversations/:conversationId/seen   { messageIds: [...] }   (conversation.read)
// Marks inbound messages as seen by the CALLER only. An internal staff marker: it is not a WhatsApp read receipt.
export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await context.params;
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => ({
    data: await markMessagesSeen(ctx, conversationId, body),
  }));
}
