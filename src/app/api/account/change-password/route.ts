import { changeOwnPassword } from "@/modules/access";
import { getAllowedOrigins } from "@/modules/auth";
import { ValidationError, toErrorResponse } from "@/shared/errors/http-errors";
import { assertSameOrigin } from "@/shared/security/same-origin";

// The signed-in user's own password change (including the forced change). Same-origin only; the session is
// validated and the password changed by Better Auth inside changeOwnPassword(), which clears the application
// flag only after Better Auth confirms success.
export async function POST(request: Request) {
  try {
    assertSameOrigin(request, getAllowedOrigins());
    const body: unknown = await request.json().catch(() => {
      throw new ValidationError(["body"]);
    });
    const result = await changeOwnPassword(request.headers, body);
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    });
    // Better Auth replaced the session (other sessions were revoked): forward the new session cookie.
    for (const cookie of result.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}
