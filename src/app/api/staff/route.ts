import { createStaff, listStaff } from "@/modules/access";
import { handleApi } from "@/lib/route-helpers";

// GET  /api/staff  list this organization's staff (staff.read)
// POST /api/staff  create a staff account (staff.manage); the service enforces everything else
export function GET(request: Request) {
  return handleApi(request, { mutation: false }, async ({ ctx }) => ({
    data: { staff: await listStaff(ctx) },
  }));
}

export function POST(request: Request) {
  return handleApi(request, { mutation: true, body: "required" }, async ({ ctx, body }) => ({
    status: 201,
    data: { staff: await createStaff(ctx, body) },
  }));
}
