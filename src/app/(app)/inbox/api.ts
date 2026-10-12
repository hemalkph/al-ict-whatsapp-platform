// The browser's thin client for the inbox API. Same-origin fetch with the session cookie; every request has a timeout and can
// be aborted. Errors carry a status and the server's fixed error code, never a message that could contain content.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly detail: string | null = null,
  ) {
    super(code ?? `HTTP ${status}`);
    this.name = "ApiError";
  }
  /**
   * The outcome cannot be established: the request may or may not have reached the server (network failure, timeout, 5xx), or the
   * server answered but its answer could not be read (BAD_RESPONSE). A retry of the same operation must reuse its idempotency key.
   */
  get uncertain() {
    return this.status === 0 || this.status >= 500 || this.code === "BAD_RESPONSE";
  }
}

// Who this page believes it is acting as (the server rendered it for this actor). Sent with every request as an ASSERTION
// (X-Expected-Actor); the server compares it with the authenticated session and refuses with 409 ACTOR_CHANGED when they differ
// (another tab signed this user out and someone else in). It authorizes nothing. See modules/access/expected-actor.ts.
export type ExpectedActor = { userId: string; organizationId: string; membershipId: string };
const ACTOR_HEADER = "x-expected-actor";
let pageActor: ExpectedActor | null = null;
export const setPageActor = (actor: ExpectedActor | null) => {
  pageActor = actor;
};
export const encodeActor = (a: ExpectedActor) =>
  encodeURIComponent(
    JSON.stringify({
      userId: a.userId,
      organizationId: a.organizationId,
      membershipId: a.membershipId,
    }),
  );

// Set (never reset) the first time the server says the session's actor is not the one this page was opened for. The inbox then
// stops: its content belongs to the previous actor and nothing from it may act as the current one. A reload starts fresh.
let actorChanged = false;
const actorListeners = new Set<() => void>();
export const subscribeActorChanged = (l: () => void) => {
  actorListeners.add(l);
  return () => void actorListeners.delete(l);
};
export const getActorChanged = () => actorChanged;
function markActorChanged() {
  if (actorChanged) return;
  actorChanged = true;
  actorListeners.forEach((l) => l());
}

export const isAbort = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

type Options = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Success statuses the endpoint documents; any other 2xx is not trusted (BAD_RESPONSE). */
  okStatuses?: number[];
  /** The actor this request is on behalf of; defaults to the page's actor. A pending send passes its own, frozen one. */
  expectedActor?: ExpectedActor;
};

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...((options.expectedActor ?? pageActor)
          ? { [ACTOR_HEADER]: encodeActor((options.expectedActor ?? pageActor)!) }
          : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
  } catch (error) {
    // A caller abort propagates as an abort; a timeout or a dropped connection is an uncertain network failure.
    if (options.signal?.aborted) throw error;
    throw new ApiError(0, "NETWORK");
  }
  if (response.ok) {
    if (options.okStatuses && !options.okStatuses.includes(response.status))
      throw new ApiError(response.status, "BAD_RESPONSE");
    try {
      return (await response.json()) as T;
    } catch (error) {
      // Headers said "success" but the body could not be read or parsed (truncated, malformed, connection dropped, timeout while
      // reading). The server may well have done the work: this is NOT a refusal. A caller abort still propagates as one.
      if (options.signal?.aborted) throw error;
      throw new ApiError(response.status, "BAD_RESPONSE");
    }
  }
  let code: string | null = null;
  let detail: string | null = null;
  try {
    const json = (await response.json()) as { error?: { code?: string; message?: string } };
    code = json.error?.code ?? null;
    detail = json.error?.message ?? null;
  } catch {
    // not JSON
  }
  if (response.status === 409 && code === "ACTOR_CHANGED") markActorChanged();
  throw new ApiError(response.status, code, detail);
}
