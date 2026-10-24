import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { terminateThenResume, terminationWatch } from "./testing";

// The termination watch of the connection-loss regressions (Phase 08E-8A, E-DRAIN), without a database: pg emits the
// termination of a checked-out client in two orders (see terminationWatch). Both are the ONE expected termination of that
// backend; anything else still fails verify().

const FATAL = () =>
  Object.assign(new Error("terminating connection due to administrator command"), {
    code: "57P01",
  });
const END = () => new Error("Connection terminated unexpectedly");

function world() {
  const pool = Object.assign(new EventEmitter(), {
    query: async () => ({ rows: [{ ok: true }] }),
  });
  const victim = Object.assign(new EventEmitter(), { processID: 42 });
  const other = Object.assign(new EventEmitter(), { processID: 43 });
  const watch = terminationWatch(pool as never);
  pool.emit("acquire", victim);
  pool.emit("acquire", other);
  watch.stopCapturing();
  return { watch, victim, other };
}

describe("terminationWatch", () => {
  it("query in flight: only the end is emitted, and it is the expected termination", async () => {
    const { watch, victim } = world();
    await watch.terminate(42);
    victim.emit("error", END());
    await watch.terminated();
    await expect(watch.verify()).resolves.toBeUndefined();
  });

  it("idle in transaction (the E-DRAIN failure): the server's 57P01, then the end, is the same one termination", async () => {
    const { watch, victim } = world();
    await watch.terminate(42);
    victim.emit("error", FATAL());
    victim.emit("error", END());
    await watch.terminated();
    await expect(watch.verify()).resolves.toBeUndefined();
  });

  for (const [name, emit] of [
    [
      "a 57P01 from ANOTHER client",
      (w: ReturnType<typeof world>) => w.other.emit("error", FATAL()),
    ],
    ["a second 57P01", (w: ReturnType<typeof world>) => w.victim.emit("error", FATAL())],
    [
      "another server error on the victim",
      (w: ReturnType<typeof world>) =>
        w.victim.emit("error", Object.assign(new Error("deadlock detected"), { code: "40P01" })),
    ],
    ["a second end", (w: ReturnType<typeof world>) => w.victim.emit("error", END())],
  ] as const)
    it(`still fails on ${name}`, async () => {
      const w = world();
      await w.watch.terminate(42);
      w.victim.emit("error", FATAL());
      emit(w);
      w.victim.emit("error", END());
      await expect(w.watch.verify()).rejects.toThrow();
    });

  it("still fails on a 57P01 before any termination was requested", async () => {
    const { watch, victim } = world();
    victim.emit("error", FATAL());
    await watch.terminate(42);
    victim.emit("error", END());
    await expect(watch.verify()).rejects.toThrow("unexpected client error");
  });
});

// Phase 08E-8B (carried-forward finding A): the paused victim is resumed even when terminating it or observing the termination
// fails, so it never keeps its pooled connection checked out; the original failure is what the caller sees.
describe("terminateThenResume", () => {
  const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });

  it("resumes only after the victim's client saw the end", async () => {
    const { watch, victim } = world();
    const resume = vi.fn();
    const done = terminateThenResume(watch, 42, resume);
    await new Promise((r) => setTimeout(r, 30));
    expect(resume).not.toHaveBeenCalled();
    victim.emit("error", END());
    await done;
    expect(resume).toHaveBeenCalledTimes(1);
    await expect(watch.verify()).resolves.toBeUndefined();
  });

  it("terminated() rejects: the victim is still resumed once and the original failure propagates", async () => {
    const { watch, victim } = world();
    victim.emit("error", deadlock()); // an unexpected error: the watch never sees the termination
    const resume = vi.fn();
    await expect(terminateThenResume(watch, 42, resume)).rejects.toThrow(
      "terminationWatch: the client never saw the termination",
    );
    expect(resume).toHaveBeenCalledTimes(1);
    await expect(watch.verify()).rejects.toThrow("unexpected client error");
  });

  it("terminate() rejects (not a watched backend): resumed once, original failure propagates", async () => {
    const { watch } = world();
    const resume = vi.fn();
    await expect(terminateThenResume(watch, 99, resume)).rejects.toThrow(
      "the backend to terminate is not a watched client",
    );
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
