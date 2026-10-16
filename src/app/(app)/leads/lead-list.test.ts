import { describe, expect, it } from "vitest";
import {
  appendPage,
  canLoadMore,
  emptyList,
  firstPage,
  isEmptyResult,
  resetFor,
  type ListState,
} from "./lead-list";

type Row = { id: string; v?: number };
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const ids = (s: ListState<Row>) => s.items.map((r) => r.id);

describe("first page", () => {
  it("keeps the server's order and its cursor", () => {
    const s = firstPage("k", { items: rows("c", "b", "a"), nextCursor: "C1" });
    expect(ids(s)).toEqual(["c", "b", "a"]); // never re-sorted
    expect(s.nextCursor).toBe("C1");
    expect(canLoadMore(s)).toBe(true);
    expect(isEmptyResult(s)).toBe(false);
  });

  it("an empty first page is an empty result with nothing more to load", () => {
    const s = firstPage<Row>("k", { items: [], nextCursor: null });
    expect(isEmptyResult(s)).toBe(true);
    expect(canLoadMore(s)).toBe(false);
  });

  it("nothing is loadable or 'empty' before the first page arrives", () => {
    const s = emptyList<Row>("k");
    expect(canLoadMore(s)).toBe(false);
    expect(isEmptyResult(s)).toBe(false);
  });
});

describe("load more", () => {
  const start = firstPage("k", { items: rows("e", "d"), nextCursor: "C1" });

  it("appends in arrival order and follows the new cursor to the end", () => {
    const two = appendPage(start, "k", "C1", { items: rows("c", "b"), nextCursor: "C2" });
    expect(ids(two)).toEqual(["e", "d", "c", "b"]);
    const end = appendPage(two, "k", "C2", { items: rows("a"), nextCursor: null });
    expect(ids(end)).toEqual(["e", "d", "c", "b", "a"]);
    expect(canLoadMore(end)).toBe(false);
  });

  it("overlapping pages: a repeated lead keeps its first position and takes the newer data", () => {
    const s = firstPage("k", {
      items: [
        { id: "e", v: 1 },
        { id: "d", v: 1 },
      ],
      nextCursor: "C1",
    });
    const next = appendPage(s, "k", "C1", {
      items: [
        { id: "d", v: 2 },
        { id: "c", v: 1 },
      ],
      nextCursor: null,
    });
    expect(next.items).toEqual([
      { id: "e", v: 1 },
      { id: "d", v: 2 },
      { id: "c", v: 1 },
    ]);
  });

  it("duplicates inside one page are collapsed too", () => {
    const s = firstPage("k", { items: rows("a", "a", "b"), nextCursor: null });
    expect(ids(s)).toEqual(["a", "b"]);
  });

  it("an empty page ends the list even if it carries a cursor (no request loop)", () => {
    const s = appendPage(start, "k", "C1", { items: [], nextCursor: "C1" });
    expect(ids(s)).toEqual(["e", "d"]);
    expect(canLoadMore(s)).toBe(false);
  });

  it("a page for an older filter set, an older cursor, or before the first page is ignored", () => {
    expect(appendPage(start, "other", "C1", { items: rows("x"), nextCursor: null })).toBe(start);
    const moved = appendPage(start, "k", "C1", { items: rows("c"), nextCursor: "C2" });
    expect(appendPage(moved, "k", "C1", { items: rows("zz"), nextCursor: null })).toBe(moved); // a late answer for C1
    const blank = emptyList<Row>("k");
    expect(appendPage(blank, "k", null, { items: rows("x"), nextCursor: null })).toBe(blank);
    const ended = appendPage(moved, "k", "C2", { items: rows("b"), nextCursor: null });
    expect(appendPage(ended, "k", null, { items: rows("q"), nextCursor: null })).toBe(ended);
  });
});

describe("filter changes", () => {
  it("a new key drops the rows and the cursor; the same key keeps them", () => {
    const s = firstPage("k", { items: rows("b", "a"), nextCursor: "C1" });
    expect(resetFor(s, "k")).toBe(s);
    const fresh = resetFor(s, "k2");
    expect(fresh).toEqual({ key: "k2", items: [], nextCursor: null, loaded: false });
    expect(canLoadMore(fresh)).toBe(false);
  });
});
