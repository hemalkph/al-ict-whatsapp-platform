import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repo = fileURLToPath(new URL("../../../../", import.meta.url));
export const fixture = "src/modules/bot-worker/__fixtures__/shutdown-child.ts";
export type ProcessResult = {
  pid: number | undefined;
  code: number | null;
  signal: NodeJS.Signals | null;
  out: string;
  signals: Array<{ signal: NodeJS.Signals; at: number; target: number | undefined }>;
};

// TEST ONLY: resolve after CLOSE (all output), retain signal identity and errors, never inherit application credentials.
export function startChild(
  file: string,
  env: Record<string, string> = {},
  launcher: "node" | "tsx" = "node",
) {
  const child = spawn(
    process.execPath,
    launcher === "node" ? ["--import", "tsx", file] : ["node_modules/tsx/dist/cli.mjs", file],
    {
      cwd: repo,
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let out = "";
  let failure: Error | undefined;
  let closed = false;
  const signals: ProcessResult["signals"] = [];
  const checks = new Set<() => void>();
  const feed = (b: Buffer) => {
    out += b.toString();
    for (const check of checks) check();
  };
  child.stdout!.on("data", feed);
  child.stderr!.on("data", feed);
  child.on("error", (error) => {
    failure = error;
  });
  const timer = setTimeout(() => {
    failure = new Error(`child ${child.pid} did not close within 20s`);
    child.kill("SIGKILL");
  }, 20_000);
  const done = new Promise<ProcessResult>((resolve, reject) =>
    child.once("close", (code, signal) => {
      closed = true;
      clearTimeout(timer);
      for (const check of checks) check();
      if (failure) reject(new Error(`${failure.message}\n${out}`));
      else resolve({ pid: child.pid, code, signal, out, signals });
    }),
  );
  void done.catch(() => undefined);
  return {
    child,
    done,
    output: () => out,
    waitFor: (pattern: RegExp) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (pattern.test(out)) {
            checks.delete(check);
            resolve();
          } else if (closed) {
            checks.delete(check);
            reject(new Error(`child closed before ${pattern}:\n${out}`));
          }
        };
        checks.add(check);
        check();
      }),
    signal: (signal: NodeJS.Signals) => {
      signals.push({ signal, at: Date.now(), target: child.pid });
      if (!child.kill(signal)) throw new Error(`could not send ${signal} to ${child.pid}`);
    },
    release: (barrier: string) =>
      new Promise<void>((resolve, reject) =>
        child.send(barrier, (error) => (error ? reject(error) : resolve())),
      ),
  };
}
