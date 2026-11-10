import { assertPlatformCan, listAuditEvents, platformCan } from "@/modules/platform";
import { handlePlatformApi } from "@/lib/route-helpers";
import { ValidationError } from "@/shared/errors/http-errors";

// GET /api/platform/audit?limit=N&before=<event id>   newest first (default 50, max 200); `nextCursor` is the next `before`
// platform.audit.read_all: every row; platform.audit.read_own: only rows where the caller is the actor (on every page).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const limit = Number(params.get("limit") ?? 50);
  const before = params.get("before") ?? undefined;
  return handlePlatformApi(
    request,
    { mutation: false, action: "platform.audit.read", permission: "platform.audit.read_own" },
    async ({ actor }) => {
      assertPlatformCan(actor, "platform.audit.read_own");
      if (before !== undefined && !UUID.test(before)) throw new ValidationError(["before"]);
      const canReadAll = platformCan(actor.roles, "platform.audit.read_all");
      const page = await listAuditEvents({ userId: actor.userId, canReadAll }, { limit, before });
      return { data: { scope: canReadAll ? "all" : "own", ...page } };
    },
  );
}
