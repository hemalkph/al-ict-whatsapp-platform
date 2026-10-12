import { handleApi } from "@/lib/route-helpers";
import { createTag, listAvailableTags } from "@/modules/inbox";

// GET  /api/inbox/tags   (contact.edit): tags that can be attached (not archived).
// POST /api/inbox/tags   { name }   (tag.manage): define a tag.
export async function GET(request: Request) {
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: { tags: await listAvailableTags(ctx) },
  }));
}

export async function POST(request: Request) {
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => {
    const result = await createTag(ctx, body);
    return { status: result.created ? 201 : 200, data: result };
  });
}
