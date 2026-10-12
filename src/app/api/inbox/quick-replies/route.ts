import { handleApi } from "@/lib/route-helpers";
import { createQuickReply, listQuickReplies } from "@/modules/inbox";

// Quick replies are reusable TEXT, not Meta templates. Choosing one only fills the composer; nothing is sent by these routes.
// GET  /api/inbox/quick-replies?q=&includeArchived=   (conversation.reply; archived ones need conversation.manage)
// POST /api/inbox/quick-replies   { title, body }   (conversation.manage)
export async function GET(request: Request) {
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: {
      quickReplies: await listQuickReplies(
        ctx,
        Object.fromEntries(new URL(request.url).searchParams),
      ),
    },
  }));
}

export async function POST(request: Request) {
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => ({
    status: 201,
    data: { quickReply: await createQuickReply(ctx, body) },
  }));
}
