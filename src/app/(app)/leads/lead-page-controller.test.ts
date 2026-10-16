import { describe, expect, it } from "vitest";
import type { LeadItem, LeadPage } from "@/modules/leads";
import { ApiError } from "./lead-api";
import { DEFAULT_FILTERS, type LeadFilters } from "./lead-filters";
import { createLeadsController, type FetchLeadPage } from "./lead-page-controller";

// Deterministic races: every request the controller makes is held until the test resolves (or rejects) it, in any order.

// Lead ids are UUIDs (the controller refuses anything else); tests name rows "a1", "b1"… and `uid` makes the UUID of a name.
const NAMES = new Map<string, string>();
const BY_NAME = new Map<string, string>();
const uid = (name: string) => {
  let id = BY_NAME.get(name);
  if (!id) {
    id = `00000000-0000-4000-8000-${String(BY_NAME.size + 1).padStart(12, "0")}`;
    BY_NAME.set(name, id);
    NAMES.set(id, name);
  }
  return id;
};
const AT = "2026-01-01T00:00:00.000Z";
const lead = (name: string): LeadItem =>
  ({
    id: uid(name),
    status: "NEW",
    revision: 0,
    open: true,
    readOnly: false,
    createdAt: AT,
    createdKey: AT,
    statusChangedAt: AT,
    cycleStartedAt: AT,
    contact: {
      id: uid(`c-${name}`),
      label: { displayName: "Amaya", named: true, idHint: null },
      archived: false,
    },
    source: {
      kind: "NONE",
      label: "x",
      adTouches: 0,
      linkedTouches: 0,
      firstReceivedAt: null,
      latestReceivedAt: null,
    },
  }) as unknown as LeadItem;
const page = (ids: string[], nextCursor: string | null = null): LeadPage => ({
  items: ids.map(lead),
  nextCursor,
});

type Pending = {
  filters: LeadFilters;
  cursor: string | null;
  signal: AbortSignal;
  resolve: (p: LeadPage) => void;
  reject: (e: unknown) => void;
};

function harness(initial: LeadPage = page(["a1", "a2"], "C1"), filters = DEFAULT_FILTERS) {
  const requests: Pending[] = [];
  let actorChanged = false;
  const fetchPage: FetchLeadPage = (f, { cursor, signal }) =>
    new Promise((resolve, reject) =>
      requests.push({ filters: f, cursor, signal, resolve, reject }),
    );
  const ctl = createLeadsController({
    filters,
    page: initial,
    fetchPage,
    isActorChanged: () => actorChanged,
  });
  const ids = () => ctl.getState().list.items.map((i) => NAMES.get(i.id) ?? i.id);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { ctl, requests, ids, flush, changeActor: () => (actorChanged = true) };
}

const A: LeadFilters = { ...DEFAULT_FILTERS, state: "open" };
const B: LeadFilters = { ...DEFAULT_FILTERS, state: "closed" };

describe("first page and filters", () => {
  it("starts from the server-rendered page without requesting anything", () => {
    const h = harness();
    expect(h.ids()).toEqual(["a1", "a2"]);
    expect(h.ctl.getState().phase).toBe("ready");
    expect(h.requests).toHaveLength(0);
  });

  it("a filter change clears the rows (they answered another question), loads, then shows the new first page", async () => {
    const h = harness();
    h.ctl.setFilters(B);
    expect(h.ids()).toEqual([]);
    expect(h.ctl.getState().phase).toBe("loading");
    expect(h.requests[0]).toMatchObject({ filters: B, cursor: null });
    h.requests[0]!.resolve(page(["b1"]));
    await h.flush();
    expect(h.ids()).toEqual(["b1"]);
    expect(h.ctl.getState().phase).toBe("ready");
  });

  it("the same question twice (a still-too-short search) requests nothing", () => {
    const h = harness();
    h.ctl.setFilters({ ...DEFAULT_FILTERS, q: "" });
    h.ctl.setFilters({ ...DEFAULT_FILTERS, q: "x" }); // too short: same key as no search
    expect(h.requests).toHaveLength(0);
  });
});

describe("races", () => {
  it("A -> B -> A: the late answer to the FIRST A is dropped although its filters equal the current ones", async () => {
    const h = harness(page(["start"]));
    h.ctl.setFilters(A);
    h.ctl.setFilters(B);
    h.ctl.setFilters(A);
    const [a1, b, a2] = h.requests;
    expect([a1!.signal.aborted, b!.signal.aborted, a2!.signal.aborted]).toEqual([
      true,
      true,
      false,
    ]);
    a2!.resolve(page(["fresh-A"]));
    await h.flush();
    a1!.resolve(page(["STALE-A"])); // aborted, but resolves late anyway
    b!.resolve(page(["STALE-B"]));
    await h.flush();
    expect(h.ids()).toEqual(["fresh-A"]);
  });

  it("A -> B -> A with the old A answering FIRST: still dropped; the screen waits for the current request", async () => {
    const h = harness(page(["start"]));
    h.ctl.setFilters(A);
    h.ctl.setFilters(B);
    h.ctl.setFilters(A);
    h.requests[0]!.resolve(page(["STALE-A"]));
    await h.flush();
    expect(h.ids()).toEqual([]);
    expect(h.ctl.getState().phase).toBe("loading");
    h.requests[2]!.resolve(page(["fresh-A"]));
    await h.flush();
    expect(h.ids()).toEqual(["fresh-A"]);
  });

  it("two refreshes completing in reverse order: only the second applies", async () => {
    const h = harness();
    h.ctl.refresh();
    h.ctl.refresh();
    expect(h.ctl.getState().phase).toBe("refreshing");
    expect(h.ids()).toEqual(["a1", "a2"]); // rows stay visible while refreshing
    h.requests[1]!.resolve(page(["second"]));
    await h.flush();
    h.requests[0]!.resolve(page(["FIRST-LATE"]));
    await h.flush();
    expect(h.ids()).toEqual(["second"]);
  });

  it("a Load more answer arriving after a filter change is dropped", async () => {
    const h = harness();
    h.ctl.loadMore();
    expect(h.requests[0]).toMatchObject({ cursor: "C1" });
    h.ctl.setFilters(B);
    expect(h.requests[0]!.signal.aborted).toBe(true);
    h.requests[1]!.resolve(page(["b1"]));
    await h.flush();
    h.requests[0]!.resolve(page(["MORE-FROM-OLD-FILTER"]));
    await h.flush();
    expect(h.ids()).toEqual(["b1"]);
  });

  it("a Load more answer arriving after a refresh started is dropped (the refresh decides)", async () => {
    const h = harness();
    h.ctl.loadMore();
    // Load more is running: the toolbar's refresh supersedes it
    h.ctl.refresh();
    h.requests[0]!.resolve(page(["LATE-MORE"]));
    await h.flush();
    h.requests[1]!.resolve(page(["r1", "r2"], "C9"));
    await h.flush();
    expect(h.ids()).toEqual(["r1", "r2"]);
  });

  it("a failure of a superseded request is ignored too (no stale error on screen)", async () => {
    const h = harness();
    h.ctl.setFilters(A);
    h.ctl.setFilters(B);
    h.requests[1]!.resolve(page(["b1"]));
    await h.flush();
    h.requests[0]!.reject(new ApiError(500, "INTERNAL_ERROR"));
    await h.flush();
    expect(h.ctl.getState().error).toBeNull();
    expect(h.ids()).toEqual(["b1"]);
  });

  it("an aborted request that resolves late after the page was left changes nothing", async () => {
    const h = harness();
    h.ctl.setFilters(B);
    h.ctl.cancel(); // unmount
    expect(h.requests[0]!.signal.aborted).toBe(true);
    let notified = 0;
    h.ctl.subscribe(() => notified++);
    h.requests[0]!.resolve(page(["AFTER-UNMOUNT"]));
    h.requests[0]!.reject(new DOMException("aborted", "AbortError"));
    await h.flush();
    expect(notified).toBe(0);
    expect(h.ids()).toEqual([]);
  });
});

describe("Load more", () => {
  it("appends from the opaque cursor, never overlaps, and stops at the end", async () => {
    const h = harness();
    h.ctl.loadMore();
    h.ctl.loadMore(); // ignored while one is running
    expect(h.requests).toHaveLength(1);
    expect(h.ctl.getState().phase).toBe("loading-more");
    h.requests[0]!.resolve(page(["a2", "a3"], "C2")); // overlaps a2
    await h.flush();
    expect(h.ids()).toEqual(["a1", "a2", "a3"]);
    h.ctl.loadMore();
    expect(h.requests[1]).toMatchObject({ cursor: "C2" });
    h.requests[1]!.resolve(page([], "C2")); // an empty page ends the list
    await h.flush();
    h.ctl.loadMore();
    expect(h.requests).toHaveLength(2);
  });

  it("a failed Load more keeps the rows; Retry repeats the SAME next page", async () => {
    const h = harness();
    h.ctl.loadMore();
    h.requests[0]!.reject(new ApiError(0, "NETWORK"));
    await h.flush();
    expect(h.ctl.getState().error).toMatchObject({
      during: "more",
      info: { kind: "unavailable", next: "retry" },
    });
    expect(h.ids()).toEqual(["a1", "a2"]);
    h.ctl.retry();
    expect(h.requests[1]).toMatchObject({ cursor: "C1" });
  });
});

describe("errors", () => {
  it("a failed first page shows a retryable error (not an empty result); Retry loads it again", async () => {
    const h = harness();
    h.ctl.setFilters(B);
    h.requests[0]!.reject(new ApiError(503, null));
    await h.flush();
    expect(h.ctl.getState()).toMatchObject({
      phase: "ready",
      error: { during: "first", info: { next: "retry" } },
    });
    expect(h.ctl.getState().list.loaded).toBe(false);
    h.ctl.retry();
    expect(h.requests[1]).toMatchObject({ filters: B, cursor: null });
  });
});

describe("actor changes", () => {
  it("ACTOR_CHANGED from a response blocks the page; later responses and actions change nothing", async () => {
    const h = harness();
    h.ctl.refresh();
    h.requests[0]!.reject(new ApiError(409, "ACTOR_CHANGED"));
    await h.flush();
    expect(h.ctl.getState().blocked).toBe(true);
    h.ctl.setFilters(B);
    h.ctl.refresh();
    h.ctl.loadMore();
    h.ctl.retry();
    expect(h.requests).toHaveLength(1); // nothing new is requested
  });

  it("an earlier response arriving after the block is dropped", async () => {
    const h = harness();
    h.ctl.setFilters(B);
    h.ctl.block(); // the shared client reported the change (another request saw 409 ACTOR_CHANGED)
    expect(h.requests[0]!.signal.aborted).toBe(true);
    h.requests[0]!.resolve(page(["OTHER-ACCOUNT-DATA"]));
    await h.flush();
    expect(h.ids()).toEqual([]);
    expect(h.ctl.getState().blocked).toBe(true);
  });

  it("if the shared client already knows the account changed, no request is even started", () => {
    const h = harness();
    h.changeActor();
    h.ctl.setFilters(B);
    expect(h.requests).toHaveLength(0);
    expect(h.ctl.getState().blocked).toBe(true);
  });
});

describe("a page whose rows cannot be used is a failed read", () => {
  // a lone surrogate is a string by type; building the row's link from it throws and replaces the whole page by the error screen
  const bad = { ...lead("x"), id: "\uD800" } as LeadItem;
  const mixed = (): LeadPage => ({ items: [lead("b1"), bad], nextCursor: null });

  it("first page: nothing of it is held, the error is retryable, and the next good page is accepted", async () => {
    const h = harness();
    h.ctl.setFilters(B);
    h.requests[0]!.resolve(mixed());
    await h.flush();
    expect(h.ids()).toEqual([]); // not a mix of trusted and malformed rows
    expect(h.ctl.getState()).toMatchObject({ phase: "ready", error: { during: "first" } });
    h.ctl.retry();
    expect(h.requests).toHaveLength(2);
    h.requests[1]!.resolve(page(["b1"]));
    await h.flush();
    expect(h.ids()).toEqual(["b1"]);
    expect(h.ctl.getState().error).toBeNull();
  });

  it("Load more: the rows already shown stay, the page is dropped, Retry asks for the same cursor again", async () => {
    const h = harness();
    h.ctl.loadMore();
    h.requests[0]!.resolve(mixed());
    await h.flush();
    expect(h.ids()).toEqual(["a1", "a2"]);
    expect(h.ctl.getState()).toMatchObject({ phase: "ready", error: { during: "more" } });
    h.ctl.retry();
    expect(h.requests[1]).toMatchObject({ cursor: "C1" });
    h.requests[1]!.resolve(page(["a3"]));
    await h.flush();
    expect(h.ids()).toEqual(["a1", "a2", "a3"]);
  });

  it.each([
    ["no items", { nextCursor: null }],
    ["a null row", { items: [null], nextCursor: null }],
    ["an empty cursor", { items: [], nextCursor: "" }],
    ["an unknown status", { items: [{ ...lead("x"), status: "BOGUS" }], nextCursor: null }],
    ["a contact without its label", { items: [{ ...lead("x"), contact: {} }], nextCursor: null }],
  ])("%s", async (_name, body) => {
    const h = harness();
    h.ctl.refresh();
    h.requests[0]!.resolve(body as unknown as LeadPage);
    await h.flush();
    expect(h.ids()).toEqual(["a1", "a2"]);
    expect(h.ctl.getState()).toMatchObject({ phase: "ready", error: { during: "first" } });
  });
});
