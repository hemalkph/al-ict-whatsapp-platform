import { describe, expect, it } from "vitest";
import { createLane } from "./latest";

// Deterministic interleavings: promises are resolved by hand, no timers.
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("latest-started-wins lane", () => {
  it("drops an old response that arrives after a newer request was applied", async () => {
    const lane = createLane();
    let shown = "OPEN";
    const poll = lane.begin(); // poll starts: the server will say OPEN
    const pollResponse = deferred<string>();
    const pollDone = pollResponse.promise.then((v) => poll.isCurrent() && (shown = v));

    // the status change completes; the refresh that follows starts and finishes with PENDING
    const refresh = lane.begin();
    const refreshed = "PENDING";
    if (refresh.isCurrent()) shown = refreshed;

    pollResponse.resolve("OPEN"); // the old OPEN arrives last
    await pollDone;
    expect(shown).toBe("PENDING");
    expect(poll.signal.aborted).toBe(true); // and the old request was aborted when the newer one began
  });

  it("a response is current only until the next request of the lane starts", () => {
    const lane = createLane();
    const a = lane.begin();
    expect(a.isCurrent()).toBe(true);
    const b = lane.begin();
    expect([a.isCurrent(), b.isCurrent()]).toEqual([false, true]);
  });

  it("cancel (selection changed, unmount) invalidates what is running and aborts it", () => {
    const lane = createLane();
    const req = lane.begin();
    lane.cancel();
    expect(req.isCurrent()).toBe(false);
    expect(req.signal.aborted).toBe(true);
    expect(lane.begin().isCurrent()).toBe(true);
  });

  it("lanes are independent, and an external abort (the poller's cleanup) aborts the request", () => {
    const list = createLane();
    const chat = createLane();
    const l = list.begin();
    chat.begin();
    expect(l.isCurrent()).toBe(true);
    const outer = new AbortController();
    const req = list.begin(outer.signal);
    outer.abort();
    expect(req.signal.aborted).toBe(true);
  });
});
