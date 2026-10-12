import { handleApi } from "@/lib/route-helpers";
import { removeContactTag } from "@/modules/inbox";

// DELETE /api/inbox/contacts/:contactId/tags/:tagId   (contact.edit)
export async function DELETE(
  request: Request,
  context: { params: Promise<{ contactId: string; tagId: string }> },
) {
  const { contactId, tagId } = await context.params;
  return handleApi(request, { mutation: true }, async ({ ctx }) => ({
    data: await removeContactTag(ctx, contactId, tagId),
  }));
}
