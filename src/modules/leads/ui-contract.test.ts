import { describe, expect, it } from "vitest";
import { schema } from "@/db";
import {
  ATTRIBUTION_FILTER_LABEL,
  DEFAULT_FILTERS,
  STATE_FILTER_LABEL,
  leadListQuery,
  type LeadFilters,
} from "@/app/(app)/leads/lead-filters";
import {
  LEAD_STATUSES,
  OPEN_LEAD_STATUSES,
  RESERVED_STATUSES,
  STAFF_SETTABLE_STATUSES,
  transitionKind,
} from "@/app/(app)/leads/lead-labels";
import { planTransition } from "./rules";
import {
  SEARCH_MAX,
  SEARCH_MIN,
  createLeadSchema,
  eventsQuerySchema,
  listQuerySchema,
  statusChangeSchema,
} from "./schemas";

// Phase 07D-1: the browser's lead logic (src/app/(app)/leads) checked against THIS module's own schemas, enums and transition
// rule, so the UI can neither drift from the server nor build a request the server would refuse. Lives here because only the
// module may read its internal schemas.

describe("UI constants are the server's", () => {
  it("statuses, open statuses, staff-settable and reserved statuses match the database enums", () => {
    expect([...LEAD_STATUSES]).toEqual([...schema.LEAD_STATUSES]);
    expect([...OPEN_LEAD_STATUSES]).toEqual([...schema.OPEN_LEAD_STATUSES]);
    expect([...STAFF_SETTABLE_STATUSES]).toEqual([...schema.STAFF_SETTABLE_LEAD_STATUSES]);
    expect([...RESERVED_STATUSES]).toEqual([...schema.RESERVED_LEAD_STATUSES]);
  });

  it("the transition classification is the server's planTransition for every staff-settable pair", () => {
    for (const from of STAFF_SETTABLE_STATUSES)
      for (const to of STAFF_SETTABLE_STATUSES)
        expect(transitionKind(from, to), `${from}->${to}`).toBe(
          ({ noop: "none", move: "move", close: "close", reopen: "reopen" } as const)[
            planTransition(from, to).kind
          ],
        );
  });

  it("search limits are the server's", async () => {
    const ui = await import("@/app/(app)/leads/lead-filters");
    expect([ui.SEARCH_MIN, ui.SEARCH_MAX]).toEqual([SEARCH_MIN, SEARCH_MAX]);
  });
});

describe("every list query the UI builds is accepted by GET /api/leads, and means what the UI says", () => {
  const parse = (query: string) =>
    listQuerySchema.safeParse(Object.fromEntries(new URLSearchParams(query)));

  it("all filter combinations (and a cursor and a limit) parse; state=all and attribution=any are never sent", () => {
    const states = Object.keys(STATE_FILTER_LABEL) as LeadFilters["state"][];
    const attributions = Object.keys(ATTRIBUTION_FILTER_LABEL) as LeadFilters["attribution"][];
    for (const state of states)
      for (const attribution of attributions)
        for (const status of [null, ...LEAD_STATUSES])
          for (const q of ["", "ab", "  Nimal Perera ", "x".repeat(200), "100%_\\"]) {
            const query = leadListQuery(
              { state, status, attribution, q },
              { cursor: "abc", limit: 999 },
            );
            const parsed = parse(query);
            expect(parsed.success, query).toBe(true);
            expect(query).not.toMatch(/state=all|attribution=any/);
          }
  });

  it("the defaults ask for every lead: no filter keys at all", () => {
    expect(leadListQuery(DEFAULT_FILTERS)).toBe("");
    expect(parse("").success).toBe(true);
  });

  it("the server itself refuses what the UI never sends", () => {
    for (const bad of [
      "state=all",
      "attribution=any",
      "q=a",
      `q=${"x".repeat(65)}`,
      "sort=name",
      "limit=51",
    ])
      expect(parse(bad).success, bad).toBe(false);
  });
});

describe("request bodies the UI sends are accepted", () => {
  it("create sends exactly { contactId }", () => {
    expect(
      createLeadSchema.safeParse({ contactId: "00000000-0000-4000-8000-000000000000" }).success,
    ).toBe(true);
  });
  it("status change accepts exactly the UI's staff-settable statuses and refuses every reserved one", () => {
    for (const to of STAFF_SETTABLE_STATUSES)
      expect(statusChangeSchema.safeParse({ to, expectedRevision: 3 }).success, to).toBe(true);
    for (const to of RESERVED_STATUSES)
      expect(statusChangeSchema.safeParse({ to, expectedRevision: 3 }).success, to).toBe(false);
  });
  it("history pages: cursor and a clamped limit", () => {
    expect(eventsQuerySchema.safeParse({ cursor: "abc", limit: "50" }).success).toBe(true);
  });
});
