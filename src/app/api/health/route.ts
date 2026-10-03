import { getHealth } from "@/modules/health";

export function GET() {
  return Response.json(getHealth(), { headers: { "Cache-Control": "no-store" } });
}
