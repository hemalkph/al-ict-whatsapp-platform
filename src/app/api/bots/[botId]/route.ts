import { handleApi } from "@/lib/route-helpers";
import { getBot } from "@/modules/bot-control";

// GET /api/bots/:botId   (bot.read)
// The bot's summary and its current draft (parsed JSON, or null). Another organization's id is the same 404 as a missing one.
export async function GET(request: Request, context: { params: Promise<{ botId: string }> }) {
  const { botId } = await context.params;
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: await getBot(ctx, botId),
  }));
}
