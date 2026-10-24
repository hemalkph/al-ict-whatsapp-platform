import type { WorkerDatabase } from "@/db";
import { runBotWorker } from "../run";

// TEST-ONLY child process (process.test.ts): the real runBotWorker with the script's signal and exit wiring, but a database
// double whose pool close behaves as CHILD_CLOSE says ("ok", "reject", "hang"). Every statement fails as unavailable, so the
// loops idle in their backoff and stop as soon as SIGTERM arrives. It never connects anywhere.

const mode = process.env.CHILD_CLOSE;
const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => controller.abort());

const execute = async () => {
  throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
};
const database = {
  db: { execute, transaction: execute } as unknown as WorkerDatabase["db"],
  close: () =>
    mode === "reject"
      ? Promise.reject(new Error("close failed"))
      : mode === "hang"
        ? new Promise<void>(() => undefined)
        : Promise.resolve(),
};

process.stdout.write("child-ready\n");
runBotWorker({
  env: {
    BOTS_RUNTIME_ENABLED: "true",
    WHATSAPP_OUTBOUND_ENABLED: "true",
    DATABASE_URL: "postgres://child@127.0.0.1:1/al_ict_test_child",
  },
  signal: controller.signal,
  createDatabase: () => database,
  // short only where the test needs the deadline (a never-settling close); generous otherwise, so load cannot hit it
  shutdownGraceMs: Number(process.env.CHILD_GRACE_MS ?? "10000"),
}).then((code) => process.exit(code));
