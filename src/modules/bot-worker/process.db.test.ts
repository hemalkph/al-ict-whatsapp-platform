import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { barrierKit } from "../bot-control/testing";
import { expireClaim, runtimeKit, triggerRow } from "../bot-runtime/testing";
import { startChild } from "./__fixtures__/process-harness";
import { until, WORKER_ON, workerConnections } from "./testing";

// Real production entrypoint, real transactions, disposable database only. No transport exists in the bot worker.
describe("bot worker process recovery", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  let k: ReturnType<typeof runtimeKit>;
  const children: ReturnType<typeof startChild>[] = [];
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  beforeEach(async () => {
    await t.pool.query("truncate organizations, webhook_requests cascade");
    kit = barrierKit(t);
    k = runtimeKit(t);
  });
  afterEach(async () => {
    for (const w of children.splice(0)) {
      w.child.kill("SIGKILL");
      await w.done;
    }
    k.releaseAll();
    await kit.cleanup();
  });
  afterAll(async () => t.close());
  const start = () => {
    const w = startChild("scripts/bots-worker.ts", {
      ...WORKER_ON,
      DATABASE_URL: t.url,
      BOTS_WORKER_CONCURRENCY: "1",
    });
    children.push(w);
    return w;
  };
  const noSessions = () =>
    until(async () => (await workerConnections(t)).length === 0, 10_000, "bot pool closed");

  it.each(["SIGTERM", "SIGINT"] as const)(
    "%s drains a T1 waiting on a row lock, claims nothing further and closes its sessions",
    async (signal) => {
      const f = await k.fixture();
      const later = await k.fixture();
      const trigger = await k.trigger(f, { first: true });
      const lock = await kit.hold("select id from conversations where id = $1 for update", [
        f.w.student.conversation.id,
      ]);
      const w = start();
      await kit.waitUntilBlocked(lock.pid);
      expect(await triggerRow(t, trigger.id)).toMatchObject({ status: "PENDING", attempts: 1 });
      w.signal(signal);
      await w.waitFor(/bots.worker_stopping/);
      const second = await k.trigger(later, { first: true });
      await lock.release();
      const r = await w.done;
      expect(r, r.out).toMatchObject({ code: 0, signal: null });
      expect(await triggerRow(t, trigger.id)).toMatchObject({
        status: "PROCESSED",
        claim_token: null,
        attempts: 1,
      });
      expect(await triggerRow(t, second.id)).toMatchObject({
        status: "PENDING",
        claim_token: null,
        attempts: 0,
      });
      expect(await k.botRequests(f)).toHaveLength(1);
      expect(await k.botRequests(later)).toHaveLength(0);
      await noSessions();
    },
  );

  it("a claim already blocked in T0 settles after stop and its acquired trigger is processed safely", async () => {
    const f = await k.fixture();
    const trigger = await k.trigger(f, { first: true });
    const lock = await kit.hold("lock table bot_triggers in share mode", []);
    const w = start();
    await kit.waitUntilBlocked(lock.pid);
    w.signal("SIGTERM");
    await w.waitFor(/bots.worker_stopping/);
    await lock.release();
    const r = await w.done;
    expect(r, r.out).toMatchObject({ code: 0, signal: null });
    expect(await triggerRow(t, trigger.id)).toMatchObject({
      status: "PROCESSED",
      attempts: 1,
      claim_token: null,
    });
    expect(await k.botRequests(f)).toHaveLength(1);
    await noSessions();
  });

  it("SIGKILL during T1 rolls back; restart preserves the live lease, then processes once after lease expiry", async () => {
    const f = await k.fixture();
    const trigger = await k.trigger(f, { first: true });
    const lock = await kit.hold("select id from conversations where id = $1 for update", [
      f.w.student.conversation.id,
    ]);
    const first = start();
    await kit.waitUntilBlocked(lock.pid);
    const leased = await triggerRow(t, trigger.id);
    expect(leased.claim_token).not.toBeNull();
    first.signal("SIGKILL");
    expect(await first.done).toMatchObject({ code: null, signal: "SIGKILL" });
    await noSessions();
    await lock.release();
    expect(await k.botRequests(f)).toHaveLength(0);
    expect(await triggerRow(t, trigger.id)).toMatchObject({
      status: "PENDING",
      attempts: 1,
      claim_token: leased.claim_token,
    });
    const second = start();
    await second.waitFor(/bots.worker_started/);
    await until(async () => (await workerConnections(t)).length > 0, 10_000, "restart connected");
    expect(await triggerRow(t, trigger.id)).toMatchObject({
      attempts: 1,
      claim_token: leased.claim_token,
    });
    await expireClaim(t, trigger.id);
    await until(
      async () => (await triggerRow(t, trigger.id)).status === "PROCESSED",
      20_000,
      "lease recovery",
    );
    second.signal("SIGTERM");
    const r = await second.done;
    expect(r, r.out).toMatchObject({ code: 0, signal: null });
    expect(await triggerRow(t, trigger.id)).toMatchObject({ attempts: 2, claim_token: null });
    expect(await k.botRequests(f)).toHaveLength(1);
    await noSessions();
  });
});
