import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The worker as a real CHILD PROCESS (review P2, shutdown): exit codes after SIGTERM, a pool close that rejects or never
// settles, and the real script's refusal. No PostgreSQL: the real script is pointed at an unreachable address (nothing
// listens on port 1) and the fixture uses a database double. Nothing here can reach Meta or a real database.

const repo = join(new URL(".", import.meta.url).pathname, "../../..");
const tsx = join(repo, "node_modules/.bin/tsx");

function run(
  file: string,
  env: Record<string, string>,
  sigtermOn: RegExp | null,
  timeoutMs = 20_000,
) {
  return new Promise<{ code: number | null; out: string; ms: number }>((resolve, reject) => {
    const child = spawn(tsx, [file], {
      cwd: repo,
      // a minimal environment: no DATABASE_URL, no .env.local
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let signalledAt = 0;
    const onData = (b: Buffer) => {
      out += b.toString();
      if (sigtermOn && !signalledAt && sigtermOn.test(out)) {
        signalledAt = Date.now();
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit in ${timeoutMs} ms:\n${out}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, ms: signalledAt ? Date.now() - signalledAt : 0 });
    });
  });
}

const ON = { BOTS_RUNTIME_ENABLED: "true", WHATSAPP_OUTBOUND_ENABLED: "true" };
const fixture = "src/modules/bot-worker/__fixtures__/shutdown-child.ts";

describe("the bot worker process", () => {
  it("the real script with a gate off refuses at once: exit 2, nothing connected", async () => {
    const r = await run("scripts/bots-worker.ts", { BOTS_RUNTIME_ENABLED: "true" }, null);
    expect(r.code).toBe(2);
    expect(r.out).toContain("WHATSAPP_OUTBOUND_ENABLED");
    expect(r.out).not.toContain("bots.worker_started");
  }, 30_000);

  it("the real script, database unreachable, SIGTERM: stops claiming, closes its pool, exit 0; the password is never printed", async () => {
    const r = await run(
      "scripts/bots-worker.ts",
      { ...ON, DATABASE_URL: "postgres://worker:SECRETPW@127.0.0.1:1/al_ict_test_unreachable" },
      /bots\.database_unavailable/,
    );
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("bots.worker_stopping");
    expect(r.out).toMatch(/"bots_event":"bots\.worker_stopped".*"outcome":"success"/);
    expect(r.out).not.toContain("SECRETPW");
  }, 30_000);

  it("pool close rejects: exit 1 (never a successful stop)", async () => {
    const r = await run(fixture, { CHILD_CLOSE: "reject" }, /child-ready/);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("pool_close_failed");
    expect(r.out).not.toMatch(/bots\.worker_stopped/);
  }, 30_000);

  it("pool close never settles: the process still exits 1 at the shutdown deadline", async () => {
    const r = await run(fixture, { CHILD_CLOSE: "hang", CHILD_GRACE_MS: "300" }, /child-ready/);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("shutdown_deadline");
    expect(r.ms).toBeLessThan(10_000); // 300 ms grace plus process start-up slack, never forever
  }, 30_000);

  it("a clean close: exit 0", async () => {
    const r = await run(fixture, { CHILD_CLOSE: "ok" }, /child-ready/);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("shutdown_deadline");
  }, 30_000);
});
