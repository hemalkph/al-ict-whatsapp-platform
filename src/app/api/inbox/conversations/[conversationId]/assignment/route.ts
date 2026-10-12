import { handleApi } from "@/lib/route-helpers";
import { assignConversation } from "@/modules/inbox";

// POST /api/inbox/conversations/:conversationId/assignment
//   { assigneeMembershipId | null, expectedAssigneeMembershipId | null }   (conversation.manage)
// 409 STALE_STATE when the assignee is no longer the one the browser saw.
export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await context.params;
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => ({
    data: await assignConversation(ctx, conversationId, body),
  }));
}
