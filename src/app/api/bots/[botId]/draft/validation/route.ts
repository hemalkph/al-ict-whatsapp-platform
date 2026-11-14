import { handleApi } from "@/lib/route-helpers";
import { validateDraft } from "@/modules/bot-control";

// GET /api/bots/:botId/draft/validation   (bot.read)
// Validates the STORED draft and returns the revision that was validated, `ok` and the diagnostics. Changes nothing.
// 409 NO_DRAFT when the bot has no draft yet.
export async function GET(request: Request, context: { params: Promise<{ botId: string }> }) {
  const { botId } = await context.params;
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: await validateDraft(ctx, botId),
  }));
}
