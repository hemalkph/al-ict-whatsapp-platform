import { describe, expect, it } from "vitest";
import { classifyTakeover, type StaffControlEvent, type TakeoverOutcome } from "./takeover";

// Plan I.1: staff takeover of a live session. Precedence follows V3.2 J.2: assignment, reply, resolution, other status.

const assignment: StaffControlEvent = { kind: "assignment" };
const reply: StaffControlEvent = { kind: "reply" };
const resolved: StaffControlEvent = { kind: "status", to: "RESOLVED" };
const other: StaffControlEvent = { kind: "status", to: "PENDING" };

const handed = (
  reason: "staff_assigned" | "staff_replied" | "staff_status_changed",
): TakeoverOutcome => ({
  state: "HANDED_OVER",
  endReason: "system_handover",
  handoverReason: reason,
});
const completed: TakeoverOutcome = {
  state: "COMPLETED",
  endReason: "conversation_resolved",
  handoverReason: null,
};

describe("takeover classification", () => {
  it("no staff control event after the start is no takeover", () => {
    expect(classifyTakeover([])).toBeNull();
  });

  it("every subset of {assignment, reply, resolution, other status} follows the precedence table", () => {
    const kinds = [assignment, reply, resolved, other];
    for (let mask = 1; mask < 16; mask++) {
      const events = kinds.filter((_, i) => (mask & (1 << i)) !== 0);
      const expected = events.includes(assignment)
        ? handed("staff_assigned")
        : events.includes(reply)
          ? handed("staff_replied")
          : events.includes(resolved)
            ? completed
            : handed("staff_status_changed");
      expect(classifyTakeover(events), JSON.stringify(events)).toEqual(expected);
    }
  });

  it("a reply together with a resolution ends handed over, not completed", () => {
    expect(classifyTakeover([resolved, reply])).toEqual(handed("staff_replied"));
  });

  it("OPEN and PENDING status changes are both 'other status'", () => {
    expect(classifyTakeover([{ kind: "status", to: "OPEN" }])).toEqual(
      handed("staff_status_changed"),
    );
    expect(classifyTakeover([{ kind: "status", to: "PENDING" }])).toEqual(
      handed("staff_status_changed"),
    );
  });

  it("the order of the events does not matter", () => {
    expect(classifyTakeover([other, reply, assignment])).toEqual(
      classifyTakeover([assignment, reply, other]),
    );
    expect(classifyTakeover([resolved, other])).toEqual(classifyTakeover([other, resolved]));
  });

  it("no outcome carries a terminal notice reason: the end reasons are never flow_end or flow_handover", () => {
    for (const events of [[assignment], [reply], [resolved], [other]]) {
      const r = classifyTakeover(events)!;
      expect(["flow_end", "flow_handover"]).not.toContain(r.endReason);
    }
  });

  it("the handover reasons are the approved system reasons", () => {
    const reasons = [assignment, reply, other].map(
      (e) => (classifyTakeover([e]) as { handoverReason: string }).handoverReason,
    );
    expect(reasons).toEqual(["staff_assigned", "staff_replied", "staff_status_changed"]);
  });
});
