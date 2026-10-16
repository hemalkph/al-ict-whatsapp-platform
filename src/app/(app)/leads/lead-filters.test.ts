import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  checkSearch,
  filtersKey,
  leadFiltersToSearch,
  leadListQuery,
  parseLeadFilters,
  type LeadFilters,
} from "./lead-filters";

const fromUrl = (search: string) => parseLeadFilters(new URLSearchParams(search));

describe("parseLeadFilters: never throws, keeps what the server supports, defaults the rest", () => {
  it("an empty URL is every lead", () => {
    expect(fromUrl("")).toEqual(DEFAULT_FILTERS);
    expect(parseLeadFilters({})).toEqual(DEFAULT_FILTERS);
  });

  it("valid combinations are kept", () => {
    expect(fromUrl("state=open&attribution=ad&q=Nimal")).toEqual({
      state: "open",
      status: null,
      attribution: "ad",
      q: "Nimal",
    });
    expect(fromUrl("state=closed&attribution=none")).toMatchObject({
      state: "closed",
      attribution: "none",
    });
    expect(fromUrl("status=REGISTERED")).toMatchObject({ status: "REGISTERED" }); // reserved: may be FILTERED on
  });

  it("unsupported values fall back to the default (never sent on): state=all, wrong case, unknown status", () => {
    expect(fromUrl("state=all")).toEqual(DEFAULT_FILTERS);
    expect(fromUrl("state=OPEN&attribution=AD&status=new")).toEqual(DEFAULT_FILTERS);
    expect(fromUrl("status=ARCHIVED&attribution=organic")).toEqual(DEFAULT_FILTERS);
    expect(fromUrl("state=&status=&attribution=&q=")).toEqual(DEFAULT_FILTERS);
  });

  it("a status decides the state by itself, also when the URL contradicts it", () => {
    expect(fromUrl("state=open&status=NOT_INTERESTED")).toMatchObject({
      state: "all",
      status: "NOT_INTERESTED",
    });
    expect(fromUrl("state=closed&status=NEW")).toMatchObject({ state: "all", status: "NEW" });
  });

  it("repeated parameters: the first value wins (as on the inbox page), from URLSearchParams or Next.js searchParams", () => {
    expect(fromUrl("state=closed&state=open&q=ab&q=zz")).toMatchObject({
      state: "closed",
      q: "ab",
    });
    expect(parseLeadFilters({ state: ["open", "closed"], q: ["  Kamal  ", "x"] })).toMatchObject({
      state: "open",
      q: "Kamal",
    });
  });

  it("unknown parameters are ignored", () => {
    expect(fromUrl("sort=name&page=3&cursor=abc&limit=5")).toEqual(DEFAULT_FILTERS);
  });
});

describe("search text is judged as the server judges it", () => {
  it("empty and whitespace are no search; one character is 'too short', not an error", () => {
    expect(checkSearch("")).toEqual({ kind: "empty", value: "" });
    expect(checkSearch("   ")).toEqual({ kind: "empty", value: "" });
    expect(checkSearch(" a ")).toEqual({ kind: "too_short", value: "" });
    expect(checkSearch(undefined)).toEqual({ kind: "empty", value: "" });
    expect(checkSearch(42)).toEqual({ kind: "empty", value: "" });
  });

  it("2 and 64 characters are accepted after trimming; longer is cut to 64", () => {
    expect(checkSearch(" ab ")).toEqual({ kind: "ok", value: "ab", truncated: false });
    const max = "y".repeat(64);
    expect(checkSearch(`  ${max}  `)).toEqual({ kind: "ok", value: max, truncated: false });
    expect(checkSearch("z".repeat(80))).toEqual({
      kind: "ok",
      value: "z".repeat(64),
      truncated: true,
    });
  });

  it("a cut never leaves half a surrogate pair or trailing space", () => {
    const emoji = "😀"; // two UTF-16 code units
    const r = checkSearch(`${"a".repeat(63)}${emoji}tail`);
    expect(r).toEqual({ kind: "ok", value: "a".repeat(63), truncated: true });
    const s = checkSearch(`${"b".repeat(60)}    ${"c".repeat(10)}`);
    expect(s.kind === "ok" && s.value).toBe("b".repeat(60));
  });

  it("special characters are kept as text and survive the URL round trip", () => {
    for (const q of [
      "100%",
      "a_b",
      "back\\slash",
      "a&b=c",
      "සුබ සන්ධ්‍යාවක්",
      "+94 77",
      "<b>x</b>",
      "a#b?c",
    ]) {
      const f = { ...DEFAULT_FILTERS, q };
      const back = fromUrl(leadFiltersToSearch(f).slice(1));
      expect(back.q, q).toBe(q);
    }
  });
});

describe("serialization is canonical", () => {
  it("defaults are omitted, keys appear once, in a fixed order", () => {
    expect(leadFiltersToSearch(DEFAULT_FILTERS)).toBe("");
    expect(
      leadFiltersToSearch({ state: "open", status: null, attribution: "ad", q: "Nimal" }),
    ).toBe("?state=open&attribution=ad&q=Nimal");
    expect(
      leadFiltersToSearch({ state: "closed", status: "NO_RESPONSE", attribution: "any", q: "" }),
    ).toBe("?status=NO_RESPONSE");
  });

  it("an invalid search in the state object is not serialized", () => {
    expect(leadFiltersToSearch({ ...DEFAULT_FILTERS, q: "a" })).toBe("");
  });

  it("round trip: parse(serialize(f)) === f for every canonical filter set", () => {
    const states: LeadFilters["state"][] = ["all", "open", "closed"];
    const attributions: LeadFilters["attribution"][] = ["any", "ad", "none"];
    for (const state of states)
      for (const attribution of attributions)
        for (const q of ["", "ab", "Nimal Perera"]) {
          const f: LeadFilters = { state, status: null, attribution, q };
          expect(fromUrl(leadFiltersToSearch(f).replace(/^\?/, ""))).toEqual(f);
        }
    const withStatus: LeadFilters = {
      state: "all",
      status: "INTERESTED",
      attribution: "none",
      q: "ab",
    };
    expect(fromUrl(leadFiltersToSearch(withStatus).slice(1))).toEqual(withStatus);
  });

  it("serialize(parse(url)) is a fixed point (a messy URL becomes its canonical form once)", () => {
    const messy = "q=%20Nimal%20&attribution=ad&state=open&state=closed&junk=1";
    const once = leadFiltersToSearch(fromUrl(messy));
    expect(once).toBe("?state=open&attribution=ad&q=Nimal");
    expect(leadFiltersToSearch(fromUrl(once.slice(1)))).toBe(once);
  });
});

describe("the API query and pagination", () => {
  it("the cursor and limit are added to the filters; limits are clamped to 1-50", () => {
    expect(leadListQuery(DEFAULT_FILTERS)).toBe("");
    expect(
      leadListQuery({ ...DEFAULT_FILTERS, state: "open" }, { cursor: "eyJ0Ijoi", limit: 30 }),
    ).toBe("state=open&cursor=eyJ0Ijoi&limit=30");
    expect(leadListQuery(DEFAULT_FILTERS, { limit: 500 })).toBe("limit=50");
    expect(leadListQuery(DEFAULT_FILTERS, { limit: 0 })).toBe("limit=1");
    expect(leadListQuery(DEFAULT_FILTERS, { cursor: null })).toBe("");
  });

  it("the filter key changes exactly when the server would be asked a different question (and so the cursor is dropped)", () => {
    const a: LeadFilters = { state: "open", status: null, attribution: "any", q: "ab" };
    expect(filtersKey(a)).toBe(filtersKey({ ...a, q: "  ab " }));
    expect(filtersKey(a)).toBe(filtersKey({ ...a, q: "ab" }));
    expect(filtersKey(a)).not.toBe(filtersKey({ ...a, q: "abc" }));
    expect(filtersKey(a)).not.toBe(filtersKey({ ...a, attribution: "ad" }));
    // a status makes the state irrelevant: these ask the same question
    expect(filtersKey({ ...a, status: "NEW" })).toBe(
      filtersKey({ ...a, state: "closed", status: "NEW" }),
    );
    // an incomplete search is the same question as no search
    expect(filtersKey({ ...a, q: "x" })).toBe(filtersKey({ ...a, q: "" }));
  });
});
