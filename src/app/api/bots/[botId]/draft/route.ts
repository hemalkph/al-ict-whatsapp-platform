import { handleApi, withTarget } from "@/lib/route-helpers";
import { updateDraft } from "@/modules/bot-control";

// Raw request allowance of a draft save, in bytes as received. It is a TRANSPORT limit (whitespace and escaping count), not
// the draft limit: the canonical draft stays capped at 65,536 UTF-8 bytes by the service and the database.
const MAX_DRAFT_BODY_BYTES = 512 * 1024;

// PUT /api/bots/:botId/draft   { expectedRevision, config }   (bot.edit)
// Replaces the draft if it is still at the revision the editor loaded (409 STALE_REVISION otherwise). The bot id has exactly
// one source: the URL. Saving identical content is a 200 with changed: false. Nothing is published, deployed or sent.
export async function PUT(request: Request, context: { params: Promise<{ botId: string }> }) {
  const { botId } = await context.params;
  return handleApi(
    request,
    { mutation: true, body: "required", maxBodyBytes: MAX_DRAFT_BODY_BYTES },
    async ({ ctx, body }) => ({
      data: (await updateDraft(ctx, withTarget(body, botId, "botId"))).value,
    }),
  );
}
