import {
  EXPECTED_ACTOR_HEADER,
  assertExpectedActor,
  requireAccess,
  type AccessContext,
} from "@/modules/access";
import { getAllowedOrigins } from "@/modules/auth";
import { withPlatformActor, type PlatformActor, type PlatformPermission } from "@/modules/platform";
import { ValidationError, toErrorResponse } from "@/shared/errors/http-errors";
import { assertSameOrigin } from "@/shared/security/same-origin";

// HTTP BOUNDARY helpers shared by API route handlers. They contain no business logic: only same-origin protection
// for mutations, the server-side access context, JSON body reading and the common error mapping.

/** The raw request-body limit of every route that does not state its own: 16,384 BYTES as received (not characters). */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * The body as text, reading at most `maxBytes` raw bytes: a declared Content-Length over the limit is refused unread, and a
 * stream that passes the limit (absent or understated length) is cancelled at the chunk that crosses it, so excess input is
 * never accumulated. Decoding is what `request.text()` does (UTF-8, BOM dropped, malformed bytes replaced, never refused).
 */
async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes)
    throw new ValidationError(["body"]);
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ValidationError(["body"]);
    }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * Reads a JSON request body defensively. `optional` bodies may be absent (treated as `{}`). A body must be
 * `application/json` (a text/plain "JSON" body is what a cross-site form could send), at most `maxBytes` raw bytes, and
 * well-formed. Errors carry only a field name, never the content.
 */
export async function readJsonBody(
  request: Request,
  optional: boolean,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<unknown> {
  const text = await readBodyText(request, maxBytes);
  if (text.length === 0) {
    if (optional) return {};
    throw new ValidationError(["body"]);
  }
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
export function withTarget(body: unknown, id: string, key = "membershipId"): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  if (key in body) throw new ValidationError([key]);
  return { ...body, [key]: id };
}

/**
 * The query string of a paged listing as service input. A repeated key is refused (never silently last-wins) and `limit`
 * must be plain digits, converted to the number the listing services take; every other key is passed on as text for the
 * service's strict schema to accept or refuse. Errors carry a key name only when it is a plain identifier.
 */
export function pageQuery(url: string): Record<string, string | number> {
  const query = new Map<string, string | number>();
  for (const [key, value] of new URL(url).searchParams) {
    if (query.has(key))
      throw new ValidationError([/^[A-Za-z0-9_]{1,40}$/.test(key) ? key : "query"]);
    query.set(key, value);
  }
  const limit = query.get("limit");
  if (limit !== undefined) {
    if (!/^[1-9]\d{0,2}$/.test(String(limit))) throw new ValidationError(["limit"]);
    query.set("limit", Number(limit));
  }
  return Object.fromEntries(query);
}

type Handled = { readonly status?: number; readonly data: unknown };

/**
 * Wraps a route handler: same-origin guard (mutations), authenticated AccessContext, optional JSON body, safe JSON
 * response, and the common error mapper. Authorization of the specific operation (staff.read / staff.manage) and all
 * validation happen inside the service the handler calls.
 */
export async function handleApi(
  request: Request,
  options: {
    readonly mutation: boolean;
    readonly body?: "required" | "optional";
    /** Raw body limit in bytes for a route whose payload is legitimately larger than the default (bot drafts only). */
    readonly maxBodyBytes?: number;
  },
  run: (input: { ctx: AccessContext; body: unknown }) => Promise<Handled>,
): Promise<Response> {
  try {
    if (options.mutation) assertSameOrigin(request, getAllowedOrigins());
    const ctx = await requireAccess(request.headers);
    // A client that states who it believes it is (a tab that may have outlived its session) is refused before anything runs
    // if the authenticated actor differs. Never authorization: see modules/access/expected-actor.ts.
    const expectedActor = request.headers.get(EXPECTED_ACTOR_HEADER);
    if (expectedActor !== null) assertExpectedActor(ctx, expectedActor);
    const body = options.body
      ? await readJsonBody(request, options.body === "optional", options.maxBodyBytes)
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

/**
 * The platform variant of handleApi (C1A): same-origin guard (mutations), the platform actor from the session (never from
 * the request), optional JSON body, safe JSON response. Refusals after the user is known get a best-effort DENIED/FAILED
 * platform audit row under `action`. No tenant AccessContext is created.
 */
export async function handlePlatformApi(
  request: Request,
  options: {
    readonly mutation: boolean;
    readonly body?: "required" | "optional";
    readonly action: string;
    readonly permission: PlatformPermission;
  },
  run: (input: { actor: PlatformActor; body: unknown; correlationId: string }) => Promise<Handled>,
): Promise<Response> {
  try {
    if (options.mutation) assertSameOrigin(request, getAllowedOrigins());
    const result = await withPlatformActor(
      request.headers,
      options,
      async (actor, correlationId) => {
        const body = options.body
          ? await readJsonBody(request, options.body === "optional")
          : undefined;
        return run({ actor, body, correlationId });
      },
    );
    return Response.json(result.data, {
      status: result.status ?? 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
