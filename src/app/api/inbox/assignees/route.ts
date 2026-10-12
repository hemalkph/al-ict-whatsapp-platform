import { handleApi } from "@/lib/route-helpers";
import { listAssignees } from "@/modules/inbox";

// GET /api/inbox/assignees   (conversation.manage): ACTIVE staff of the caller's organization who can be assigned.
export async function GET(request: Request) {
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: { assignees: await listAssignees(ctx) },
  }));
}
