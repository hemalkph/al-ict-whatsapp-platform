import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestDb } from "@/db/__tests__/helpers";
import { handleWebhookPost } from "../handler";
import { TEST_APP_SECRET, webhookPost } from "../testing";
import { until } from "../queue/testing";

// TEST-ONLY helpers (excluded from the boundary scans). Deliveries enter through the REAL signed webhook handler; the
// worker is either run in-process (runWorker) or as the real script in a child process.

export { TEST_APP_SECRET };

/** A genuinely signed POST through the real webhook handler into the test database. Requires META_APP_SECRET to be stubbed. */
export const postSigned = (db: TestDb["db"], bytes: Uint8Array) =>
  handleWebhookPost(webhookPost(bytes), { db: db as never });

export const SCRIPT = fileURLToPath(
  new URL("../../../../scripts/whatsapp-worker.ts", import.meta.url),
);
export const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

export type WorkerProcess = {
  child: ChildProcess;
  /** Parsed JSON log lines (stdout and stderr), in order. */
  lines: Record<string, unknown>[];
  /** Everything written, raw. */
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Resolves once the worker finished its preflight and logged its first queue-depth heartbeat. */
  ready: () => Promise<void>;
  kill: (signal: NodeJS.Signals) => void;
};

/** The real `scripts/whatsapp-worker.ts` in its own process. The environment is explicit: nothing is inherited but PATH. */
export function spawnWorker(env: Record<string, string>): WorkerProcess {
  const child = spawn(process.execPath, ["--import", "tsx", SCRIPT], {
    cwd: REPO,
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: Record<string, unknown>[] = [];
  let raw = "";
  const feed = () => {
    let partial = "";
    return (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      raw += text;
      partial += text;
      const complete = partial.split("\n");
      partial = complete.pop() ?? ""; // the last piece may be a half-written line
      for (const line of complete) {
        if (!line.startsWith("{")) continue;
        try {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // not a log record
        }
      }
    };
  };
  child.stdout!.on("data", feed());
  child.stderr!.on("data", feed());
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return {
    child,
    lines,
    output: () => raw,
    exited,
    ready: () => until(() => lines.some((l) => l.webhook_event === "worker.stats"), 30_000),
    kill: (signal) => void child.kill(signal),
  };
}
