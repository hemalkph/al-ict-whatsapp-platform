import { describe, expect, it } from "vitest";
import { abortWatch } from "./testing";

const settled = (p: Promise<void>) =>
  Promise.race([p.then(() => "resolved"), new Promise((r) => setTimeout(() => r("pending"), 30))]);

/** A signal that counts listener traffic. */
function spied() {
  const controller = new AbortController();
  const counts = { add: 0, remove: 0 };
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((...a: Parameters<typeof add>) => {
    counts.add++;
    return add(...a);
  }) as typeof add;
  controller.signal.removeEventListener = ((...a: Parameters<typeof remove>) => {
    counts.remove++;
    return remove(...a);
  }) as typeof remove;
  return { controller, counts };
}

describe("abortWatch (race-safe test-handler abort wait)", () => {
  it("A: abort BEFORE registration resolves immediately and registers no listener", async () => {
    const { controller, counts } = spied();
    controller.abort();
    const w = abortWatch(controller.signal);
    expect(await settled(w.aborted)).toBe("resolved");
    expect(counts.add).toBe(0);
    w.dispose();
  });

  it("B: abort AFTER registration resolves via the event", async () => {
    const { controller, counts } = spied();
    const w = abortWatch(controller.signal);
    expect(await settled(w.aborted)).toBe("pending");
    controller.abort();
    expect(await settled(w.aborted)).toBe("resolved");
    expect(counts.add).toBe(1);
  });

  it("C: no abort leaves the wait pending, and dispose removes the listener (D), idempotently", async () => {
    const { controller, counts } = spied();
    const w = abortWatch(controller.signal);
    expect(await settled(w.aborted)).toBe("pending");
    w.dispose();
    w.dispose();
    expect(counts.remove).toBe(2); // harmless repeat; the first removal is the effective one
    controller.abort();
    expect(await settled(w.aborted)).toBe("pending"); // listener gone: the late abort is not delivered
  });

  it("E: a handler failing before/while waiting still disposes via finally", async () => {
    const { controller, counts } = spied();
    const run = async () => {
      const w = abortWatch(controller.signal);
      try {
        throw new Error("fixture setup failed");
      } finally {
        w.dispose();
      }
    };
    await expect(run()).rejects.toThrow("fixture setup failed");
    expect(counts).toEqual({ add: 1, remove: 1 });
  });

  it("F: the ORIGINAL pattern (listener only) hangs on an already-aborted signal — the missed-abort bug", async () => {
    const controller = new AbortController();
    controller.abort();
    const original = new Promise<void>((resolve) =>
      controller.signal.addEventListener("abort", () => resolve()),
    );
    expect(await settled(original)).toBe("pending");
    expect(await settled(abortWatch(controller.signal).aborted)).toBe("resolved");
  });
});
