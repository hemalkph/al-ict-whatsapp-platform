import { reactivateMember } from "@/modules/access";
import { handleApi, withTarget } from "@/lib/route-helpers";

// POST /api/staff/:membershipId/reactivate   (staff.manage), no body
export async function POST(
  request: Request,
  context: { params: Promise<{ membershipId: string }> },
) {
  const { membershipId } = await context.params;
  return handleApi(request, { mutation: true, body: "optional" }, async ({ ctx, body }) => ({
    data: await reactivateMember(ctx, withTarget(body, membershipId)),
  }));
}
