import { handleApi } from "@/lib/route-helpers";
import { getConversationDetail } from "@/modules/inbox";

// GET /api/inbox/conversations/:conversationId   (conversation.read)
export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await context.params;
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: { conversation: await getConversationDetail(ctx, conversationId) },
  }));
}
