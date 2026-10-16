import { describe, expect, it } from "vitest";
import type { LeadDetail, LeadEventView, TouchView } from "@/modules/leads";
import { DEFAULT_FILTERS } from "../lead-filters";
import {
  conversationStatusLabel,
  editNote,
  eventKindLabel,
  historyStatusText,
  inboxConversationPath,
  latestOutsideList,
  leadPath,
  leadsListPath,
  lifecycleRows,
  linkedCountText,
  otherCountText,
  touchFacts,
} from "./lead-detail";

const touch = (o: Partial<TouchView> = {}): TouchView => ({
  id: "t1",
  label: "Meta ad",
  receivedAt: "2026-01-01T00:00:00.000Z",
  receivedKey: "k",
  headline: null,
  body: null,
  sourceId: null,
  sourceLink: null,
  mediaType: null,
  mediaLink: null,
  clickIdTail: null,
  initiating: false,
  ...o,
});

describe("paths", () => {
  it("builds the list path from validated filters only, in canonical form", () => {
    expect(leadsListPath(DEFAULT_FILTERS)).toBe("/leads");
    expect(leadsListPath({ ...DEFAULT_FILTERS, state: "closed", q: "Ama" })).toBe(
      "/leads?state=closed&q=Ama",
    );
  });

  it("carries the filters on the lead path and encodes the id", () => {
    expect(leadPath("a-b", DEFAULT_FILTERS)).toBe("/leads/a-b");
    expect(leadPath("a-b", { ...DEFAULT_FILTERS, state: "open" })).toBe("/leads/a-b?state=open");
    expect(leadPath("a/../b?x=1#y", DEFAULT_FILTERS)).toBe("/leads/a%2F..%2Fb%3Fx%3D1%23y");
  });

  it("opens a conversation with the inbox's own parameter (`c`), and nothing can leave the site", () => {
    const id = "0b1e5b34-8f0e-4a46-8f6b-2a9d8f3c1d11";
    expect(inboxConversationPath(id)).toBe(`/inbox?c=${id}`);
    expect(inboxConversationPath("x&view=all//evil.example")).toBe(
      "/inbox?c=x%26view%3Dall%2F%2Fevil.example",
    );
  });
});

describe("lifecycle", () => {
  const lead = {
    createdAt: "2026-01-01T00:00:00.000Z",
    cycleStartedAt: "2026-01-02T00:00:00.000Z",
    statusChangedAt: "2026-01-03T00:00:00.000Z",
    closedAt: null,
  } as unknown as LeadDetail["lead"];

  it("lists the times in reading order and shows Closed only for a closed lead", () => {
    expect(lifecycleRows(lead).map((r) => r.label)).toEqual([
      "Created",
      "Current cycle started",
      "Last status change",
    ]);
    const closed = { ...lead, closedAt: "2026-01-04T00:00:00.000Z" };
    expect(lifecycleRows(closed).at(-1)).toEqual({ label: "Closed", at: closed.closedAt });
  });

  it("explains a view-only role, and stays silent for a reserved lead (its own note says why)", () => {
    expect(editNote({ readOnly: false }, false)).toMatch(/cannot change/);
    expect(editNote({ readOnly: false }, true)).toBeNull();
    expect(editNote({ readOnly: true }, false)).toBeNull();
  });
});

describe("conversations", () => {
  it("labels known statuses and never guesses an unknown one", () => {
    expect(conversationStatusLabel("OPEN")).toBe("Open");
    expect(conversationStatusLabel("PENDING")).toBe("Pending");
    expect(conversationStatusLabel("RESOLVED")).toBe("Resolved");
    expect(conversationStatusLabel("ARCHIVED")).toBe("Unknown");
    expect(conversationStatusLabel("toString")).toBe("Unknown");
  });
});

describe("evidence", () => {
  it("shows only the facts that were recorded, as given", () => {
    expect(touchFacts(touch())).toEqual([]);
    expect(
      touchFacts(
        touch({
          sourceId: "1200",
          sourceLink: "https://fb.me/abc",
          mediaType: "image",
          mediaLink: "https://cdn.example.test/a.jpg",
          clickIdTail: "…wxyz",
        }),
      ).map((f) => f.label),
    ).toEqual(["Source ID", "Source link", "Media type", "Media link", "Click ID ends with"]);
  });

  it("keeps untrusted text exactly as text: nothing is rewritten, linked or parsed", () => {
    const hostile = "<img src=x onerror=alert(1)> javascript:alert(1) https://evil.example/pay";
    const [fact] = touchFacts(touch({ sourceId: hostile }));
    expect(fact!.value).toBe(hostile);
  });

  it("states counts honestly: exact totals, and what part is shown when the list was cut short", () => {
    expect(linkedCountText(0, 0)).toBe("No referral evidence is linked to this lead.");
    expect(linkedCountText(1, 1)).toBe("1 referral record is linked to this lead.");
    expect(linkedCountText(3, 3)).toBe("3 referral records are linked to this lead.");
    expect(linkedCountText(40, 25)).toBe(
      "40 referral records are linked to this lead. Showing the earliest 25.",
    );
    expect(otherCountText(0, 0)).toBe("No other referral evidence is recorded for this contact.");
    expect(otherCountText(2, 2)).toBe("2 other records for this contact.");
    expect(otherCountText(30, 25)).toBe(
      "30 other records for this contact. Showing the newest 25.",
    );
  });

  it("shows the latest linked record separately only when the cut-short list does not hold it", () => {
    const a = touch({ id: "a" });
    const z = touch({ id: "z" });
    expect(latestOutsideList([a], 1, a)).toBeNull();
    expect(latestOutsideList([a], 2, null)).toBeNull();
    expect(latestOutsideList([a], 2, a)).toBeNull();
    expect(latestOutsideList([a], 2, z)).toBe(z);
  });
});

describe("history", () => {
  it("labels each kind by words, and an unknown kind as an event", () => {
    const kinds: LeadEventView["kind"][] = ["CREATED", "STATUS", "TOUCH_LINKED"];
    expect(kinds.map(eventKindLabel)).toEqual(["Created", "Status change", "Evidence linked"]);
    expect(eventKindLabel("NEW_KIND")).toBe("Event");
    expect(eventKindLabel("toString")).toBe("Event");
  });

  it("says how many events are shown, never a total, and whether the start was reached", () => {
    expect(historyStatusText(0, false)).toBe("No history is recorded for this lead.");
    expect(historyStatusText(1, false)).toBe(
      "1 event shown. This is the start of the recorded history.",
    );
    expect(historyStatusText(20, true)).toBe("20 events shown. Older events can be loaded.");
    expect(historyStatusText(20, true)).not.toMatch(/of \d|total/);
  });
});
