import { handleApi, pageQuery } from "@/lib/route-helpers";
import { createBot, listBotsPage } from "@/modules/bot-control";

// GET /api/bots?limit=&cursor=   (bot.read)
// One page of the caller's organization's bot summaries in key order (keyset pagination). Never a draft.
export async function GET(request: Request) {
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: await listBotsPage(ctx, pageQuery(request.url)),
  }));
}

// POST /api/bots   { key, name, description? }   (bot.edit)
// Creates a bot with no draft. 201 with its summary; 409 BOT_KEY_TAKEN when the organization already has the key.
export async function POST(request: Request) {
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => ({
    status: 201,
    data: (await createBot(ctx, body)).value,
  }));
}
