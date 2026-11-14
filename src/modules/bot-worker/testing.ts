import type { TestDb } from "@/db/__tests__/helpers";
import { runBotWorker } from "./run";

// TEST-ONLY helpers for the bot worker's database tests (excluded from the boundary scans). The worker runs with its REAL pool
// (the J.6 session settings), real loops and the production dependency composition, against the disposable test database only.

export const WORKER_ON = {
  BOTS_RUNTIME_ENABLED: "true",
  WHATSAPP_OUTBOUND_ENABLED: "true",
} as const;
export const WORKER_APP = "al-ict-bots-worker";

/** Starts one real worker on the disposable database; `stop()` aborts it and resolves to its exit code. */
export function startWorker(t: TestDb, env: Record<string, string> = {}) {
  const controller = new AbortController();
  const printed: string[] = [];
  const running = runBotWorker({
    env: { ...WORKER_ON, DATABASE_URL: t.url, BOTS_WORKER_CONCURRENCY: "2", ...env },
    signal: controller.signal,
    print: (m) => void printed.push(m),
    shutdownGraceMs: 40_000,
  });
  return {
    running,
    printed,
    stop: async () => {
      controller.abort();
      return running;
    },
  };
}

/** Polls `check` until it holds (bounded; never a fixed sleep standing in for an ordering proof). */
export async function until(
  check: () => Promise<boolean>,
  ms = 20_000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`${label} not reached within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Sessions of the worker's pool still connected to the test database. */
export async function workerConnections(
  t: TestDb,
): Promise<Array<{ pid: number; state: string | null }>> {
  const r = await t.pool.query(
    "select pid, state from pg_stat_activity where datname = current_database() and application_name = $1",
    [WORKER_APP],
  );
  return r.rows as Array<{ pid: number; state: string | null }>;
}
