import { handleApi } from "@/lib/route-helpers";
import { listConversations } from "@/modules/inbox";

// GET /api/inbox/conversations?view=&accountId=&q=&cursor=&limit=   (conversation.read)
// One page of the caller's organization's conversations (keyset pagination). All validation and scoping is in the module.
export async function GET(request: Request) {
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: await listConversations(ctx, Object.fromEntries(new URL(request.url).searchParams)),
  }));
}
