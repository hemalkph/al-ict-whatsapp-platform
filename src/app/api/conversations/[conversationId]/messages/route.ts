import { submitOutboundMessage } from "@/modules/messaging";
import { handleApi } from "@/lib/route-helpers";
import { ValidationError } from "@/shared/errors/http-errors";

// POST /api/conversations/:conversationId/messages   (conversation.reply)
// Body: { "idempotencyKey": "...", "message": { "type": "text", "body": "..." } | { "type": "template", "templateId": "...", "parameters": [...] } }
// Queues an outbound WhatsApp message. It sends NOTHING itself: a separate, opt-in worker dispatches queued requests.
// The WhatsApp account, the contact and the recipient are derived from the conversation in the database; the browser can
// supply none of them. 201 = queued, 200 = a replay of an identical earlier request, 409 = key reused for a different request.
export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await context.params;
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => {
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new ValidationError(["body"]);
    if ("conversationId" in body) throw new ValidationError(["conversationId"]); // the id has exactly one source: the URL
    const result = await submitOutboundMessage(ctx, { ...body, conversationId });
    return {
      status: result.replayed ? 200 : 201,
      data: {
        requestId: result.requestId,
        messageId: result.messageId,
        state: result.state,
        replayed: result.replayed,
      },
    };
  });
}
