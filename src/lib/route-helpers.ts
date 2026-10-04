import { requireAccess, type AccessContext } from "@/modules/access";
import { getAllowedOrigins } from "@/modules/auth";
import { ValidationError, toErrorResponse } from "@/shared/errors/http-errors";
import { assertSameOrigin } from "@/shared/security/same-origin";

// HTTP BOUNDARY helpers shared by API route handlers. They contain no business logic: only same-origin protection
// for mutations, the server-side access context, JSON body reading and the common error mapping.

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Reads a JSON request body defensively. `optional` bodies may be absent (treated as `{}`). A body must be
 * `application/json` (a text/plain "JSON" body is what a cross-site form could send), small, and well-formed.
 * Errors carry only a field name, never the content.
 */
export async function readJsonBody(request: Request, optional: boolean): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new ValidationError(["body"]);
  const text = await request.text();
  if (text.length === 0) {
    if (optional) return {};
    throw new ValidationError(["body"]);
  }
  if (text.length > MAX_BODY_BYTES) throw new ValidationError(["body"]);
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    throw new ValidationError(["content-type"]);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError(["body"]);
  }
}

/**
 * Merges the target id from the URL into a body, refusing a body that tries to supply its own: the id has exactly
 * one source. Non-object bodies are returned untouched so the service's strict schema rejects them.
 */
export function withTarget(body: unknown, membershipId: string): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  if ("membershipId" in body) throw new ValidationError(["membershipId"]);
  return { ...body, membershipId };
}

type Handled = { readonly status?: number; readonly data: unknown };

/**
 * Wraps a route handler: same-origin guard (mutations), authenticated AccessContext, optional JSON body, safe JSON
 * response, and the common error mapper. Authorization of the specific operation (staff.read / staff.manage) and all
 * validation happen inside the service the handler calls.
 */
export async function handleApi(
  request: Request,
  options: { readonly mutation: boolean; readonly body?: "required" | "optional" },
  run: (input: { ctx: AccessContext; body: unknown }) => Promise<Handled>,
): Promise<Response> {
  try {
    if (options.mutation) assertSameOrigin(request, getAllowedOrigins());
    const ctx = await requireAccess(request.headers);
    const body = options.body
      ? await readJsonBody(request, options.body === "optional")
      : undefined;
    const result = await run({ ctx, body });
    return Response.json(result.data, {
      status: result.status ?? 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
