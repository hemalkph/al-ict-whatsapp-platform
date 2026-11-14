import type { WorkerDatabase } from "@/db";
import { runWorker } from "@/modules/whatsapp/worker/run";
import { runOutboundWorker } from "@/modules/messaging/worker";
import { runBotWorker } from "../run";

// TEST ONLY: real orchestration, no sockets or transport. IPC barriers order signals, work and pool closure.
const controller = new AbortController();
const report = (event: string, detail: object = {}) =>
  process.stdout.write(
    JSON.stringify({ event, pid: process.pid, ppid: process.ppid, ...detail }) + "\n",
  );
const pending = new Map<string, () => void>();
process.on("message", (message: string) => pending.get(message)?.());
const barrier = (name: string) => new Promise<void>((resolve) => pending.set(name, resolve));
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    report("signal-ack", { signal });
    controller.abort();
  });
controller.signal.addEventListener("abort", () => report("shutdown-start"), { once: true });
// Retain a handle even if the test's close/preflight promise never settles (as a real pool would).
setInterval(() => undefined, 1000);
report("identity");
const execute = async () => {
  report("operation-start");
  if (process.env.CHILD_WORK === "pending") {
    await barrier("release-work");
    report("operation-complete");
  }
  throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
};
const database = {
  db: { execute, transaction: execute } as unknown as WorkerDatabase["db"],
  close: async () => {
    report("pool-close-start");
    if (process.env.CHILD_CLOSE === "hold") await barrier("release-close");
    if (process.env.CHILD_CLOSE === "reject") throw new Error("close failed");
    if (process.env.CHILD_CLOSE === "hang") await new Promise(() => undefined);
    report("pool-close-complete");
  },
};
const sleep = async (_ms: number, signal: AbortSignal) => {
  report("work-idle");
  report("child-ready");
  // Diagnostic only: a bounded event-loop stall exposes a launcher's signal acknowledgement timeout.
  const end = performance.now() + Number(process.env.CHILD_BLOCK_MS ?? "0");
  while (performance.now() < end) {
    /* controlled CPU contention */
  }
  if (!signal.aborted)
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
};
const options = {
  env: {
    BOTS_RUNTIME_ENABLED: "true",
    WHATSAPP_WORKER_ENABLED: "true",
    WHATSAPP_OUTBOUND_ENABLED: "true",
    DATABASE_URL: "postgres://child@127.0.0.1:1/al_ict_test_child",
  },
  signal: controller.signal,
  createDatabase: () => database,
  sleep,
  shutdownGraceMs: Number(process.env.CHILD_GRACE_MS ?? "10000"),
};
const running =
  process.env.CHILD_WORKER === "webhook"
    ? runWorker(options)
    : process.env.CHILD_WORKER === "outbound"
      ? runOutboundWorker({
          ...options,
          injectedTransport: true,
          transport: {
            send: async () => {
              throw new Error("unexpected send");
            },
          },
        })
      : runBotWorker(options);
running
  .then((code) => {
    report("exit", { code });
    process.stdout.write("", () => process.exit(code));
  })
  .catch(() => {
    report("shutdown-error");
    process.exit(1);
  });
