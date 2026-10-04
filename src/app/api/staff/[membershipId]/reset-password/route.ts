import { resetStaffPassword } from "@/modules/access";
import { handleApi, withTarget } from "@/lib/route-helpers";

// POST /api/staff/:membershipId/reset-password  body { newPassword }   (staff.manage)
// Never returns or logs the password or any reset token; shared identities are refused by the service.
export async function POST(
  request: Request,
  context: { params: Promise<{ membershipId: string }> },
) {
  const { membershipId } = await context.params;
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => ({
    data: await resetStaffPassword(ctx, withTarget(body, membershipId)),
  }));
}
