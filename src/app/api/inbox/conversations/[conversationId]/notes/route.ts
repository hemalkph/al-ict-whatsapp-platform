import { handleApi } from "@/lib/route-helpers";
import { createNote, listNotes } from "@/modules/inbox";

// Internal notes (conversation.manage for both). They are not WhatsApp messages and are never sent anywhere.
export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await context.params;
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: await listNotes(
      ctx,
      conversationId,
      Object.fromEntries(new URL(request.url).searchParams),
    ),
  }));
}

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await context.params;
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => ({
    status: 201,
    data: { note: await createNote(ctx, conversationId, body) },
  }));
}
