import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  changeLeadStatus,
  createLead,
  fetchContactLeads,
  fetchLeadDetail,
  fetchLeadEvents,
  fetchLeadPage,
  getActorChanged,
  setPageActor,
} from "./lead-api";
import { describeLeadError, type LeadOperation } from "./lead-errors";
import { DEFAULT_FILTERS } from "./lead-filters";

// The wrappers run on the REAL shared client (src/app/(app)/inbox/api.ts); only the network (global fetch) is replaced. So these
// tests prove the requests that leave the browser and how the real error objects are interpreted.

const ACTOR = { userId: "u1", organizationId: "o1", membershipId: "m1" };
const LEAD = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[];
let reply: () => Promise<Response>;
const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status });
const failWith = (code: string, status: number) =>
  json(status, { error: { code, message: "server text" } });

beforeEach(() => {
  calls = [];
  reply = json(200, {});
  setPageActor(ACTOR);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: init.body === undefined ? undefined : JSON.parse(init.body as string),
      });
      return reply();
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  setPageActor(null);
});

const caught = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error("expected the request to fail");
};

describe("requests: exactly the approved endpoints, through the shared client", () => {
  it("list: filters, cursor and limit in the query; GET; the actor assertion is sent; one request", async () => {
    reply = json(200, { items: [], nextCursor: null });
    await fetchLeadPage(
      { ...DEFAULT_FILTERS, state: "closed", q: " Nimal " },
      { cursor: "Q1", limit: 20 },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "/api/leads?state=closed&q=Nimal&cursor=Q1&limit=20",
      method: "GET",
    });
    expect(decodeURIComponent(calls[0]!.headers["x-expected-actor"]!)).toBe(JSON.stringify(ACTOR));
  });

  it("list with no filters has no query string at all", async () => {
    reply = json(200, { items: [], nextCursor: null });
    await fetchLeadPage(DEFAULT_FILTERS);
    expect(calls[0]!.url).toBe("/api/leads");
  });

  it("detail, history, contact leads: ids are path-encoded", async () => {
    await fetchLeadDetail(LEAD);
    await fetchLeadEvents(LEAD, { cursor: "H1", limit: 99 });
    await fetchContactLeads(CONTACT);
    await fetchLeadDetail("../x?y");
    expect(calls.map((c) => c.url)).toEqual([
      `/api/leads/${LEAD}`,
      `/api/leads/${LEAD}/events?cursor=H1&limit=50`,
      `/api/leads/for-contact/${CONTACT}`,
      "/api/leads/..%2Fx%3Fy",
    ]);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("create: POST { contactId } only; 201 (created) and 200 (existing open lead) are both success", async () => {
    reply = json(201, { created: true, lead: { id: LEAD } });
    expect(await createLead(CONTACT)).toMatchObject({ created: true });
    reply = json(200, { created: false, lead: { id: LEAD } });
    expect(await createLead(CONTACT)).toMatchObject({ created: false });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", "/api/leads", { contactId: CONTACT }],
      ["POST", "/api/leads", { contactId: CONTACT }],
    ]);
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
  });

  it("status: POST { to, expectedRevision } only", async () => {
    reply = json(200, { changed: true, lead: { id: LEAD } });
    await changeLeadStatus(LEAD, { to: "QUALIFIED", expectedRevision: 4 });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `/api/leads/${LEAD}/status`,
      body: { to: "QUALIFIED", expectedRevision: 4 },
    });
  });

  it("an undocumented success status is not trusted: outcome unknown for a mutation, check before acting", async () => {
    reply = json(202, {});
    const e = await caught(changeLeadStatus(LEAD, { to: "NEW", expectedRevision: 0 }));
    expect(describeLeadError(e, "status")).toMatchObject({
      kind: "outcome_unknown",
      next: "check-first",
    });
    expect(calls).toHaveLength(1); // never re-sent
  });
});

describe("errors: the real codes, interpreted without losing their distinctions", () => {
  const cases: Array<[string, () => Promise<Response>, LeadOperation, string, string]> = [
    ["proxy 401", failWith("UNAUTHENTICATED", 401), "read", "unauthenticated", "sign-in"],
    ["403 forbidden", failWith("FORBIDDEN", 403), "status", "forbidden", "none"],
    [
      "403 password change",
      failWith("PASSWORD_CHANGE_REQUIRED", 403),
      "read",
      "password_change_required",
      "reload-page",
    ],
    [
      "409 organization",
      failWith("ORGANIZATION_SELECTION_REQUIRED", 409),
      "read",
      "organization_selection_required",
      "reload-page",
    ],
    ["404", failWith("NOT_FOUND", 404), "read", "not_found", "none"],
    ["400 validation", failWith("VALIDATION_ERROR", 400), "create", "validation", "none"],
    ["409 stale", failWith("STALE_STATE", 409), "status", "stale", "refetch"],
    [
      "409 already open (reopen)",
      failWith("ALREADY_OPEN", 409),
      "status",
      "already_open",
      "refetch",
    ],
    [
      "409 already open (create)",
      failWith("ALREADY_OPEN", 409),
      "create",
      "already_open",
      "refetch",
    ],
    ["409 reserved", failWith("RESERVED_STATUS", 409), "status", "reserved_status", "refetch"],
    ["409 archived", failWith("CONTACT_ARCHIVED", 409), "create", "contact_archived", "none"],
    ["500 on a read", failWith("INTERNAL_ERROR", 500), "read", "unavailable", "retry"],
    [
      "500 on a mutation",
      failWith("INTERNAL_ERROR", 500),
      "status",
      "outcome_unknown",
      "check-first",
    ],
    [
      "unreadable error body",
      async () => new Response("<html>", { status: 502 }),
      "create",
      "outcome_unknown",
      "check-first",
    ],
    [
      "network failure",
      async () => Promise.reject(new TypeError("Failed to fetch")),
      "create",
      "outcome_unknown",
      "check-first",
    ],
    [
      "timeout (the client's own deadline)",
      async () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      "status",
      "outcome_unknown",
      "check-first",
    ],
    [
      "network failure on a read",
      async () => Promise.reject(new TypeError("offline")),
      "read",
      "unavailable",
      "retry",
    ],
  ];

  it.each(cases)("%s", async (_name, response, operation, kind, next) => {
    reply = response;
    const run =
      operation === "read"
        ? fetchLeadDetail(LEAD)
        : operation === "create"
          ? createLead(CONTACT)
          : changeLeadStatus(LEAD, { to: "NEW", expectedRevision: 1 });
    const info = describeLeadError(await caught(run), operation);
    expect(info).toMatchObject({ kind, next });
    expect(info.message).not.toContain("server text"); // the server's message is never shown
    expect(calls).toHaveLength(1); // nothing is retried
  });

  it("a stale revision is identifiable and never re-sent with the old revision", async () => {
    reply = failWith("STALE_STATE", 409);
    const info = describeLeadError(
      await caught(changeLeadStatus(LEAD, { to: "INTERESTED", expectedRevision: 2 })),
      "status",
    );
    expect(info.kind).toBe("stale");
    expect(info.next).toBe("refetch");
    expect(calls).toHaveLength(1);
  });

  it("404 says nothing about whether the lead exists elsewhere (same text for 'missing' and 'not yours')", () => {
    const info = describeLeadError(new ApiError(404, "NOT_FOUND"), "read");
    expect(info.kind).toBe("not_found");
    expect(info.message).toBe("This lead or contact is not available.");
    expect(info.message).not.toMatch(/organization|tenant|permission|exist/i);
  });

  it("a request the page cancels is ignored, not reported as a failure", async () => {
    const controller = new AbortController();
    reply = () => {
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    };
    const info = describeLeadError(
      await caught(fetchLeadDetail(LEAD, { signal: controller.signal })),
      "read",
    );
    expect(info).toMatchObject({ kind: "aborted", next: "ignore" });
  });

  it("an error that is not from the client is unexpected; a mutation must still be checked first", () => {
    expect(describeLeadError(new Error("boom"), "read")).toMatchObject({
      kind: "unexpected",
      next: "retry",
    });
    expect(describeLeadError(new Error("boom"), "status")).toMatchObject({
      kind: "unexpected",
      next: "check-first",
    });
  });

  // last: the shared client's actor-changed flag stays set for the rest of the page's life (as intended)
  it("ACTOR_CHANGED is its own kind (reload, never retry), distinct from a stale revision, and stops the shared client", async () => {
    expect(getActorChanged()).toBe(false);
    reply = failWith("ACTOR_CHANGED", 409);
    const info = describeLeadError(
      await caught(changeLeadStatus(LEAD, { to: "NEW", expectedRevision: 1 })),
      "status",
    );
    expect(info).toMatchObject({ kind: "actor_changed", next: "reload-page" });
    expect(getActorChanged()).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
