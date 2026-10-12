import { describe, expect, it } from "vitest";
import type { ConversationListItem, TimelineMessage } from "@/modules/inbox";
import { mergeFirstPage, mergeMessages } from "./merge";

const item = (
  id: string,
  at: string,
  over: Partial<ConversationListItem> = {},
): ConversationListItem => ({
  id,
  status: "OPEN",
  account: { id: "a", label: "+94" },
  contact: { displayName: id, named: true, idHint: null },
  lastMessageAt: at,
  activityKey: at.replace("Z", "000Z"), // the server's key has microseconds; tests pass milliseconds and widen them
  lastInboundAt: at,
  preview: null,
  assignee: null,
  unreadCount: 0,
  unreadCapped: false,
  ...over,
});
const msg = (id: string, at: string, over: Partial<TimelineMessage> = {}): TimelineMessage => ({
  id,
  direction: "INBOUND",
  type: "TEXT",
  text: id,
  placeholder: null,
  media: [],
  occurredAt: at,
  reply: null,
  delivery: null,
  unseen: false,
  ...over,
});

describe("conversation list refresh", () => {
  const page = (items: ConversationListItem[], nextCursor: string | null = null) => ({
    items,
    nextCursor,
  });

  it("updates rows in place, adds new ones on top and never duplicates", () => {
    const old = [item("b", "2026-06-01T10:00:00.000Z"), item("a", "2026-06-01T09:00:00.000Z")];
    const merged = mergeFirstPage(
      old,
      page([
        item("c", "2026-06-01T11:00:00.000Z"),
        item("b", "2026-06-01T10:30:00.000Z", { unreadCount: 2 }),
        item("a", "2026-06-01T09:00:00.000Z"),
      ]),
      null,
    );
    expect(merged.items.map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(merged.items[1]!.unreadCount).toBe(2);
    expect(merged.nextCursor).toBeNull();
  });

  it("keeps pages the reader loaded, and drops a row inside the refreshed range that no longer matches", () => {
    const old = [
      item("x", "2026-06-01T12:00:00.000Z"),
      item("y", "2026-06-01T11:00:00.000Z"),
      item("older", "2026-05-01T00:00:00.000Z"),
    ];
    const merged = mergeFirstPage(old, page([item("y", "2026-06-01T11:00:00.000Z")], "c1"), "c2");
    // "x" is inside the refreshed range but absent from it, so it no longer matches and is dropped; "older" is a page the
    // reader loaded beyond the refreshed range, so it stays, and so does the cursor that continues after it
    expect(merged.items.map((i) => i.id)).toEqual(["y", "older"]);
    expect(merged.nextCursor).toBe("c2");
  });

  it("uses the fresh cursor when no loaded row lies beyond the refreshed range", () => {
    const merged = mergeFirstPage(
      [item("a", "2026-06-01T11:00:00.000Z")],
      page([item("a", "2026-06-01T11:00:00.000Z")], "fresh"),
      null,
    );
    expect(merged.nextCursor).toBe("fresh");
  });

  it("keeps rows that share the boundary's timestamp and sort after it (the id breaks the tie)", () => {
    // every row has exactly the same timestamp: the server orders them by id DESC
    const at = "2026-06-01T10:00:00.000Z";
    const ids = ["f", "e", "d", "c", "b", "a"];
    const loaded = ids.map((id) => item(id, at)); // three pages' worth, all loaded
    // the first page refreshes: it holds f, e, d (nextCursor says there is more)
    const merged = mergeFirstPage(loaded, page(loaded.slice(0, 3), "after-d"), "end");
    expect(merged.items.map((i) => i.id)).toEqual(ids); // c, b, a survive: they tie on time but sort after d
    expect(merged.nextCursor).toBe("end");
    // and a refresh that no longer contains "e" drops it (it lies inside the range) but keeps the tied rows after the boundary
    const without = mergeFirstPage(loaded, page([loaded[0]!, loaded[2]!, loaded[3]!], "x"), "end");
    expect(without.items.map((i) => i.id)).toEqual(["f", "d", "c", "b", "a"]);
  });

  it("orders by the microsecond key, not by the millisecond display time", () => {
    const a = item("a", "2026-06-01T10:00:00.000Z", {
      activityKey: "2026-06-01T10:00:00.000100Z",
    });
    const b = item("b", "2026-06-01T10:00:00.000Z", {
      activityKey: "2026-06-01T10:00:00.000900Z",
    });
    // same millisecond, different microseconds: b is newer although its id sorts lower... and a's id sorts lower than b's
    expect(mergeFirstPage([a], page([b, a], "c"), null).items.map((i) => i.id)).toEqual(["b", "a"]);
    const c = item("c", "2026-06-01T10:00:00.000Z", {
      activityKey: "2026-06-01T10:00:00.000500Z",
    });
    // a row loaded earlier with a key between the two stays where the server would put it
    expect(mergeFirstPage([a, c], page([b], "c"), "end").items.map((i) => i.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("re-orders when activity moves a conversation to the top", () => {
    const old = [item("b", "2026-06-01T10:00:00.000Z"), item("a", "2026-06-01T09:00:00.000Z")];
    const merged = mergeFirstPage(
      old,
      page([item("a", "2026-06-01T12:00:00.000Z"), item("b", "2026-06-01T10:00:00.000Z")]),
      null,
    );
    expect(merged.items.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("message refresh", () => {
  it("updates delivery in place and inserts only the new message, in time order", () => {
    const existing = [
      msg("1", "2026-06-01T10:00:00.000Z"),
      msg("2", "2026-06-01T10:01:00.000Z", { direction: "OUTBOUND" }),
    ];
    const fresh = [
      msg("2", "2026-06-01T10:01:00.000Z", {
        direction: "OUTBOUND",
        delivery: { phase: "DELIVERED", label: "Delivered", detail: null, severity: "good" },
      }),
      msg("3", "2026-06-01T10:02:00.000Z"),
    ];
    const merged = mergeMessages(existing, fresh);
    expect(merged).not.toBe("reset");
    expect((merged as TimelineMessage[]).map((m) => m.id)).toEqual(["1", "2", "3"]);
    expect((merged as TimelineMessage[])[1]!.delivery?.phase).toBe("DELIVERED");
  });

  it("does not duplicate on repeated refreshes", () => {
    const page = [msg("1", "2026-06-01T10:00:00.000Z"), msg("2", "2026-06-01T10:01:00.000Z")];
    const once = mergeMessages(page, page) as TimelineMessage[];
    expect(mergeMessages(once, page)).toHaveLength(2);
  });

  it("asks for a reset when more arrived than one page (no overlap), and starts from the fresh page when nothing was shown", () => {
    expect(
      mergeMessages([msg("1", "2026-06-01T10:00:00.000Z")], [msg("9", "2026-06-01T12:00:00.000Z")]),
    ).toBe("reset");
    const fresh = [msg("9", "2026-06-01T12:00:00.000Z")];
    expect(mergeMessages([], fresh)).toBe(fresh);
  });

  it("keeps older messages the reader loaded", () => {
    const existing = [msg("0", "2026-06-01T09:00:00.000Z"), msg("1", "2026-06-01T10:00:00.000Z")];
    expect(
      (
        mergeMessages(existing, [
          msg("1", "2026-06-01T10:00:00.000Z"),
          msg("2", "2026-06-01T10:05:00.000Z"),
        ]) as TimelineMessage[]
      ).map((m) => m.id),
    ).toEqual(["0", "1", "2"]);
  });
});
