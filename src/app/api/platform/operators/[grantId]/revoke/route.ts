import { revokePlatformRole } from "@/modules/platform";
import { handlePlatformApi } from "@/lib/route-helpers";

// POST /api/platform/operators/:grantId/revoke   no body
// Another user's grant: platform.operator.revoke; one's own grant: any ACTIVE platform role. Re-authenticated.
export async function POST(request: Request, context: { params: Promise<{ grantId: string }> }) {
  const { grantId } = await context.params;
  return handlePlatformApi(
    request,
    { mutation: true, action: "platform.operator.revoke", permission: "platform.operator.revoke" },
    async ({ actor, correlationId }) => ({
      data: await revokePlatformRole(actor, { grantId }, { correlationId }),
    }),
  );
}
