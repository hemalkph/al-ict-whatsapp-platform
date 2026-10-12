import { handleApi } from "@/lib/route-helpers";
import { addContactTag } from "@/modules/inbox";

// POST /api/inbox/contacts/:contactId/tags   { tagId }   (contact.edit). Attaching a tag changes nothing else about the contact.
export async function POST(request: Request, context: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await context.params;
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => {
    const result = await addContactTag(ctx, contactId, body);
    return { status: result.added ? 201 : 200, data: result };
  });
}
