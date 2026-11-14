import { afterEach, describe, expect, it } from "vitest";
import { fixture, startChild } from "./__fixtures__/process-harness";

// Real application processes; explicit environments and database doubles. No Meta or application database.
const children: ReturnType<typeof startChild>[] = [];
const start: typeof startChild = (...args) => {
  const w = startChild(...args);
  children.push(w);
  return w;
};
afterEach(async () => {
  for (const w of children.splice(0)) {
    if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill("SIGKILL");
    await w.done;
  }
});
const ON = { BOTS_RUNTIME_ENABLED: "true", WHATSAPP_OUTBOUND_ENABLED: "true" };
const occurrences = (out: string, event: string) => out.split(`"event":"${event}"`).length - 1;

describe("worker process lifecycle (direct Node)", { timeout: 30_000 }, () => {
  it.each(["bots-worker", "whatsapp-worker", "whatsapp-outbound-worker"])(
    "%s refuses with gates off: exit 2 without connecting",
    async (script) => {
      const r = await start(`scripts/${script}.ts`).done;
      expect(r, r.out).toMatchObject({ code: 2, signal: null });
      expect(r.out).not.toMatch(/worker[._]started/);
    },
  );

  it("real bot script, unreachable database: SIGTERM closes the pool and exits 0 without printing credentials", async () => {
    const w = start("scripts/bots-worker.ts", {
      ...ON,
      DATABASE_URL: "postgres://worker:SECRETPW@127.0.0.1:1/al_ict_test_unreachable",
    });
    await w.waitFor(/bots\.database_unavailable/);
    w.signal("SIGTERM");
    const r = await w.done;
    expect(r, r.out).toMatchObject({ code: 0, signal: null });
    expect(r.out).toContain("bots.worker_pool_closed");
    expect(r.out).toMatch(/"bots_event":"bots\.worker_stopped".*"outcome":"success"/);
    expect(r.out).not.toContain("SECRETPW");
  });

  describe.each(["bot", "webhook", "outbound"])("%s", (worker) => {
    it.each(["SIGTERM", "SIGINT"] as const)(
      "%s drains and closes exactly once, exit 0",
      async (signal) => {
        const w = start(fixture, { CHILD_WORKER: worker, CHILD_CLOSE: "ok" });
        await w.waitFor(/child-ready/);
        w.signal(signal);
        const r = await w.done;
        expect(r, r.out).toMatchObject({ code: 0, signal: null });
        expect(r.out).toContain(`"signal":"${signal}"`);
        expect(occurrences(r.out, "shutdown-start")).toBe(1);
        expect(occurrences(r.out, "pool-close-start")).toBe(1);
        expect(occurrences(r.out, "pool-close-complete")).toBe(1);
        const identity = JSON.parse(r.out.split("\n")[0]!);
        expect(identity).toMatchObject({ pid: r.pid, ppid: process.pid });
        expect(r.out).toMatch(/worker[._]drained/);
      },
    );

    it("repeated signals during held pool closure retain one cleanup", async () => {
      const w = start(fixture, { CHILD_WORKER: worker, CHILD_CLOSE: "hold" });
      await w.waitFor(/child-ready/);
      w.signal("SIGTERM");
      await w.waitFor(/pool-close-start/);
      w.signal("SIGINT");
      await w.waitFor(/"signal":"SIGINT"/);
      w.signal("SIGTERM");
      await w.waitFor(/"signal":"SIGTERM"[\s\S]*"signal":"SIGTERM"/);
      await w.release("release-close");
      const r = await w.done;
      expect(r, r.out).toMatchObject({ code: 0, signal: null });
      expect(occurrences(r.out, "shutdown-start")).toBe(1);
      expect(occurrences(r.out, "pool-close-start")).toBe(1);
    });

    it.each(["reject", "hang"])("pool close %s exits 1, never a successful stop", async (mode) => {
      const w = start(fixture, { CHILD_WORKER: worker, CHILD_CLOSE: mode, CHILD_GRACE_MS: "300" });
      await w.waitFor(/child-ready/);
      w.signal("SIGTERM");
      const r = await w.done;
      expect(r, r.out).toMatchObject({ code: 1, signal: null });
      expect(r.out).toContain(mode === "reject" ? "pool_close_failed" : "shutdown_deadline");
      expect(r.out).not.toMatch(/worker[._]stopped/);
      expect(occurrences(r.out, "pool-close-start")).toBe(1);
    });

    it("signal during pending preflight waits for its settlement before closing", async () => {
      const w = start(fixture, { CHILD_WORKER: worker, CHILD_WORK: "pending" });
      await w.waitFor(/operation-start/);
      w.signal("SIGTERM");
      await w.waitFor(/shutdown-start/);
      expect(w.output()).not.toContain("pool-close-start");
      await w.release("release-work");
      const r = await w.done;
      expect(r, r.out).toMatchObject({ code: 0, signal: null });
      expect(occurrences(r.out, "operation-start")).toBe(1);
      expect(r.out.indexOf("operation-complete")).toBeLessThan(r.out.indexOf("pool-close-start"));
    });

    it("an unresponsive preflight hits the application deadline; external SIGKILL stays distinct", async () => {
      const w = start(fixture, {
        CHILD_WORKER: worker,
        CHILD_WORK: "pending",
        CHILD_GRACE_MS: "300",
      });
      await w.waitFor(/operation-start/);
      w.signal("SIGTERM");
      const r = await w.done;
      expect(r, r.out).toMatchObject({ code: 1, signal: null });
      expect(r.out).toContain("shutdown_deadline");
      expect(occurrences(r.out, "pool-close-start")).toBe(1);
      const killed = start(fixture, { CHILD_WORKER: worker, CHILD_WORK: "pending" });
      await killed.waitFor(/operation-start/);
      killed.signal("SIGKILL");
      expect(await killed.done).toMatchObject({ code: null, signal: "SIGKILL" });
    });
  });
});
