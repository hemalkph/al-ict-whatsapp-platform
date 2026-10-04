import { changeMemberRole } from "@/modules/access";
import { handleApi, withTarget } from "@/lib/route-helpers";

// PATCH /api/staff/:membershipId/role  body { role }   (staff.manage)
export async function PATCH(
  request: Request,
  context: { params: Promise<{ membershipId: string }> },
) {
  const { membershipId } = await context.params;
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => ({
    data: await changeMemberRole(ctx, withTarget(body, membershipId)),
  }));
}
