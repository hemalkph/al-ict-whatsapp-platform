import { handleApi } from "@/lib/route-helpers";
import { getContactLeads } from "@/modules/leads";

// GET /api/leads/for-contact/:contactId   (lead.read + contact.read)
// The contact's open lead (if any) and recent leads, for the inbox lead card.
export async function GET(request: Request, context: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await context.params;
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: await getContactLeads(ctx, contactId),
  }));
}
