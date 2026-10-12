import { handleApi } from "@/lib/route-helpers";
import { updateQuickReply } from "@/modules/inbox";

// PATCH /api/inbox/quick-replies/:id   { title?, body?, archived? }   (conversation.manage)
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => ({
    data: { quickReply: await updateQuickReply(ctx, id, body) },
  }));
}
