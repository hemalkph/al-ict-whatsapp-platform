import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerDatabase } from "@/db";
import { dispatchBatch } from "@/modules/messaging/dispatch";
import { runOutboundWorker } from "@/modules/messaging/worker";
import { processWebhookBatch } from "../queue/process";
import { runWorker } from "./run";

vi.mock("../queue/process", () => ({ processWebhookBatch: vi.fn() }));
vi.mock("@/modules/messaging/dispatch", () => ({ dispatchBatch: vi.fn() }));
const webhookZero = {
  claimed: 0,
  processed: 0,
  failed: 0,
  dead: 0,
  held: 0,
  ignored: 0,
  leaseLost: 0,
  unrecorded: 0,
};
const outboundZero = {
  claimed: 0,
  accepted: 0,
  rejected: 0,
  retryScheduled: 0,
  unknown: 0,
  held: 0,
  recoveredUnknown: 0,
  fenceLost: 0,
};

describe.each(["webhook", "outbound"] as const)("%s shutdown orchestration", (worker) => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const method of ["log", "info", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  function start(
    close: () => Promise<void>,
    execute = vi.fn(async () => ({ rows: [{ missing: 0, n: 0 }] })),
  ) {
    const controller = new AbortController();
    const database = { db: { execute } as unknown as WorkerDatabase["db"], close };
    const idle = (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    const common = {
      env: {
        WHATSAPP_WORKER_ENABLED: "true",
        WHATSAPP_OUTBOUND_ENABLED: "true",
        DATABASE_URL: "postgres://fake@127.0.0.1:1/al_ict_test_fake",
      },
      signal: controller.signal,
      createDatabase: () => database,
      sleep: idle,
      shutdownGraceMs: 1000,
    };
    const done =
      worker === "webhook"
        ? runWorker({ ...common, handlers: {} })
        : runOutboundWorker({
            ...common,
            injectedTransport: true,
            transport: {
              send: async () => {
                throw new Error("unexpected send");
              },
            },
          });
    return { controller, done, execute };
  }
  function batchBarrier() {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.mocked(processWebhookBatch).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return webhookZero;
    });
    vi.mocked(dispatchBatch).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return outboundZero;
    });
    return { entered, release };
  }
  const batchCalls = () =>
    worker === "webhook"
      ? vi.mocked(processWebhookBatch).mock.calls.length
      : vi.mocked(dispatchBatch).mock.calls.length;

  it("one deadline includes both the work drain and pool closure; repeats cannot reset it", async () => {
    const b = batchBarrier();
    const closing = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const close = vi.fn(() => {
      closing.resolve();
      return closed.promise;
    });
    const w = start(close);
    await b.entered.promise;
    w.controller.abort();
    await vi.advanceTimersByTimeAsync(600);
    expect(close).not.toHaveBeenCalled();
    b.release.resolve();
    await closing.promise;
    w.controller.abort();
    let settled = false;
    void w.done.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(399);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await w.done).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(batchCalls()).toBe(1);
    closed.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("shutdown_deadline"));
  });

  it("a started batch drains before closure and starts no further batch", async () => {
    const b = batchBarrier();
    const close = vi.fn(async () => undefined);
    const w = start(close);
    await b.entered.promise;
    w.controller.abort();
    expect(close).not.toHaveBeenCalled();
    b.release.resolve();
    expect(await w.done).toBe(0);
    expect(batchCalls()).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a successful preflight settling after stop initiates no batch", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const execute = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return { rows: [{ missing: 0, n: 0 }] };
    });
    const close = vi.fn(async () => undefined);
    const w = start(close, execute);
    await entered.promise;
    w.controller.abort();
    release.resolve();
    expect(await w.done).toBe(0);
    expect(batchCalls()).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(["reject", "throw"])(
    "pool close %s is a failure, including a fatal preflight exit without a signal",
    async (mode) => {
      const close = vi.fn(() => {
        if (mode === "throw") throw new Error("close failed");
        return Promise.reject(new Error("close failed"));
      });
      const execute = vi.fn(async () => {
        throw Object.assign(new Error("schema missing"), { code: "42P01" });
      });
      const w = start(close, execute);
      expect(await w.done).toBe(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("pool_close_failed"));
    },
  );

  it("a fatal preflight with a never-settling close is bounded even without an operator signal", async () => {
    const closing = Promise.withResolvers<void>();
    const close = vi.fn(() => {
      closing.resolve();
      return new Promise<void>(() => undefined);
    });
    const execute = vi.fn(async () => {
      throw Object.assign(new Error("schema missing"), { code: "42P01" });
    });
    const w = start(close, execute);
    await closing.promise;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await w.done).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
