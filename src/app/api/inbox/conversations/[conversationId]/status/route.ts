import { handleApi } from "@/lib/route-helpers";
import { changeConversationStatus } from "@/modules/inbox";

// POST /api/inbox/conversations/:conversationId/status   { to, expected }   (conversation.manage)
// 409 STALE_STATE when the conversation is no longer in the status the browser saw.
export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await context.params;
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => ({
    data: await changeConversationStatus(ctx, conversationId, body),
  }));
}
