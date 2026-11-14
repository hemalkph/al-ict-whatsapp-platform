import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { barrierKit } from "../bot-control/testing";
import { until } from "../bot-worker/testing";
import { startChild } from "../bot-worker/__fixtures__/process-harness";
import { SENDING_RECOVERY_AFTER_MS } from "./policy";
import { submitOutboundMessage } from "./submit";
import { ON, minutesAgo, textInput, world } from "./testing";

// Real outbound runner and owned pool, fake local transport only; never imports MetaTransport.
describe("outbound process shutdown and durable recovery", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  const children: ReturnType<typeof startChild>[] = [];
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  beforeEach(async () => {
    await t.pool.query("truncate organizations, webhook_requests cascade");
    kit = barrierKit(t);
  });
  afterEach(async () => {
    for (const w of children.splice(0)) {
      w.child.kill("SIGKILL");
      await w.done;
    }
    await kit.cleanup();
  });
  afterAll(async () => t.close());
  const start = (extra: Record<string, string> = {}) => {
    const w = startChild("src/modules/messaging/__tests__/shutdown-child.ts", {
      WORKER_TEST_DATABASE_URL: t.url,
      TEST_DATABASE_ADMIN_URL: process.env.TEST_DATABASE_ADMIN_URL!,
      ...extra,
    });
    children.push(w);
    return w;
  };
  const state = async (id: string) =>
    (
      await t.pool.query(
        "select state, attempt_count, failure_code from outbound_requests where id = $1",
        [id],
      )
    ).rows[0];
  const queue = async (x: Awaited<ReturnType<typeof world>>, key: string) =>
    submitOutboundMessage(x.actor.ctx, textInput(x.conversation.id, "synthetic", key), {
      db: t.db as never,
      config: ON,
    });
  const noSessions = () =>
    until(
      async () =>
        (
          await t.pool.query(
            "select 1 from pg_stat_activity where datname = current_database() and application_name = 'al-ict-outbound-worker'",
          )
        ).rowCount === 0,
      10_000,
      "outbound sessions closed",
    );

  it.each(["SIGTERM", "SIGINT"] as const)(
    "%s while a fake send is in flight drains it, claims no later request, closes all sessions",
    async (signal) => {
      const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
      const first = await queue(x, "shutdown-first-0001");
      const w = start();
      await w.waitFor(/fake-send-start/);
      expect(await state(first.requestId)).toMatchObject({ state: "SENDING", attempt_count: 1 });
      w.signal(signal);
      await w.waitFor(/outbound.worker_stopping/);
      const second = await queue(x, "shutdown-second-0002");
      expect(w.output()).not.toContain("worker_pool_closing");
      await w.release("release-send");
      const r = await w.done;
      expect(r, r.out).toMatchObject({ code: 0, signal: null });
      expect(await state(first.requestId)).toMatchObject({ state: "ACCEPTED", attempt_count: 1 });
      expect(await state(second.requestId)).toMatchObject({ state: "QUEUED", attempt_count: 0 });
      expect(r.out.match(/fake-send-start/g)).toHaveLength(1);
      await noSessions();
    },
  );

  it("a claim pending on the account lock when stopped is fenced, drained and never followed by another claim", async () => {
    const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
    const first = await queue(x, "shutdown-claim-0001");
    const lock = await kit.hold("select id from whatsapp_accounts where id = $1 for update", [
      x.account.id,
    ]);
    const w = start();
    await kit.waitUntilBlocked(lock.pid);
    w.signal("SIGTERM");
    await w.waitFor(/outbound.worker_stopping/);
    await lock.release();
    await w.waitFor(/fake-send-start/);
    await w.release("release-send");
    const r = await w.done;
    expect(r, r.out).toMatchObject({ code: 0, signal: null });
    expect(await state(first.requestId)).toMatchObject({ state: "ACCEPTED", attempt_count: 1 });
    expect(r.out.match(/fake-send-start/g)).toHaveLength(1);
    await noSessions();
  });

  it("SIGKILL during a fake HTTP attempt leaves SENDING; restart recovers UNKNOWN_OUTCOME after the recovery age and never resends", async () => {
    const x = await world(t.db, { lastInboundAt: minutesAgo(5) });
    const r = await queue(x, "shutdown-unknown-0001");
    const first = start();
    await first.waitFor(/fake-send-start/);
    first.signal("SIGKILL");
    expect(await first.done).toMatchObject({ code: null, signal: "SIGKILL" });
    await noSessions();
    expect(await state(r.requestId)).toMatchObject({ state: "SENDING", attempt_count: 1 });
    const young = start({ CHILD_SEND: "accept" });
    await young.waitFor(/poll-idle/);
    young.signal("SIGTERM");
    expect(await young.done).toMatchObject({ code: 0, signal: null });
    expect(young.output()).not.toContain("fake-send-start");
    expect(await state(r.requestId)).toMatchObject({ state: "SENDING", attempt_count: 1 });
    for (let i = 0; i < 2; i++) {
      const restarted = start({
        CHILD_SEND: "accept",
        CHILD_CLOCK_OFFSET_MS: String(SENDING_RECOVERY_AFTER_MS + 10_000),
      });
      await restarted.waitFor(/poll-idle/);
      restarted.signal("SIGTERM");
      const end = await restarted.done;
      expect(end, end.out).toMatchObject({ code: 0, signal: null });
      expect(end.out).not.toContain("fake-send-start");
      expect(await state(r.requestId)).toMatchObject({
        state: "UNKNOWN_OUTCOME",
        attempt_count: 1,
        failure_code: "process_died_after_dispatch_start",
      });
    }
    await noSessions();
  });

  it("ordinary concurrent load drains six independent accounts and closes the pool", async () => {
    const worlds = await Promise.all(
      Array.from({ length: 6 }, () => world(t.db, { lastInboundAt: minutesAgo(5) })),
    );
    const queued = await Promise.all(worlds.map((x, i) => queue(x, `shutdown-load-000${i}`)));
    const w = start({ CHILD_SEND: "accept" });
    await w.waitFor(/poll-idle/);
    for (const r of queued)
      expect(await state(r.requestId)).toMatchObject({ state: "ACCEPTED", attempt_count: 1 });
    w.signal("SIGTERM");
    const r = await w.done;
    expect(r, r.out).toMatchObject({ code: 0, signal: null });
    expect(r.out.match(/fake-send-start/g)).toHaveLength(6);
    await noSessions();
  });
});
