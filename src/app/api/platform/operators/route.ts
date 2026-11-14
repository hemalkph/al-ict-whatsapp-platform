import { grantPlatformRole, listOperators } from "@/modules/platform";
import { handlePlatformApi } from "@/lib/route-helpers";

// GET  /api/platform/operators                                          (platform.operator.read)
// POST /api/platform/operators  body { email, role, verificationRef }   (platform.operator.grant, re-authenticated)
// The actor is always the session user; a body naming any other actor field is rejected by the strict schema.
export async function GET(request: Request) {
  return handlePlatformApi(
    request,
    { mutation: false, action: "platform.operator.read", permission: "platform.operator.read" },
    async ({ actor }) => ({ data: { operators: await listOperators(actor) } }),
  );
}

export async function POST(request: Request) {
  return handlePlatformApi(
    request,
    {
      mutation: true,
      body: "required",
      action: "platform.operator.grant",
      permission: "platform.operator.grant",
    },
    async ({ actor, body, correlationId }) => ({
      status: 201,
      data: await grantPlatformRole(actor, body, { correlationId }),
    }),
  );
}
