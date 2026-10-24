import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { terminationWatch } from "./testing";

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
