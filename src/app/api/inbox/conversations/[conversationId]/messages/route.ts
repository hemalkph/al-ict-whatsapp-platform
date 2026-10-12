import { handleApi } from "@/lib/route-helpers";
import { listMessages } from "@/modules/inbox";

// GET /api/inbox/conversations/:conversationId/messages?before=&limit=   (conversation.read)
// READ-ONLY timeline. Sending is POST /api/conversations/:conversationId/messages (the Phase 05 endpoint), not this route.
export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await context.params;
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: await listMessages(
      ctx,
      conversationId,
      Object.fromEntries(new URL(request.url).searchParams),
    ),
  }));
}
