import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { claimNext, executeClaim } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { stopActiveSessions } from "../bot-control";
import { barrierKit } from "../bot-control/testing";
import { deferred, runtimeKit, type RuntimeFx } from "./testing";

// R5 (Phase 08E-5; plan I.2, K.4, K.6) on disposable PostgreSQL 17: Stop against a BOT request the real step transaction
// created, at each dispatch boundary, with the real dispatcher and a FakeTransport. Before the final pre-transmission
// authorization Stop prevents the send (0 calls); after it, the attempt cannot be recalled (the accepted limitation, V3.2 I.4 /
// blocker 42): exactly ONE call, never a second. After Stop, the student's next message creates no BOT request. NOT EXECUTED
// by the author of this change: no isolated PostgreSQL server was configured.

describe("Stop at each dispatch boundary of a T1-created request (R5)", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  let k: ReturnType<typeof runtimeKit>;

  beforeAll(async () => {
    t = await createTestDatabase({
      sessionTimeouts: {
        lock_timeout: 15_000,
        statement_timeout: 20_000,
        idle_in_transaction_session_timeout: 25_000,
      },
    });
  });
  beforeEach(async () => {
    await t.pool.query("truncate organizations, webhook_requests cascade");
    kit = barrierKit(t);
    k = runtimeKit(t);
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    k.releaseAll();
    try {
      await kit.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  });
  afterAll(async () => t.close());

  async function world() {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    return { f, s: session, r: request };
  }
  const stop = (f: RuntimeFx) =>
    stopActiveSessions(
      f.w.admin.ctx,
      { deploymentId: f.deployment.id, expectedLiveSessions: 1 },
      { db: t.db as never },
    );
  /** After Stop: the session is handed over (operator_stop) and a further student message creates no BOT request. */
  async function afterStop(x: Awaited<ReturnType<typeof world>>) {
    expect(await k.session(x.s.id as string)).toMatchObject({
      state: "HANDED_OVER",
      handover_reason: "operator_stop",
    });
    const tr = await k.trigger(x.f, { body: "hello?" });
    expect(await k.run(tr.id)).toMatchObject({ kind: "finished", status: "IGNORED" });
    expect(await k.botRequests(x.f)).toHaveLength(1);
  }

  it("Stop before the dispatch claim: Stop holds R itself (bot_stopped); nothing is claimed; 0 calls", async () => {
    const x = await world();
    expect((await stop(x.f)).value).toMatchObject({ requestsSuppressed: 1, requestsInFlight: 0 });
    expect(await k.request(x.r.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "bot_stopped",
    });
    const transport = new FakeTransport();
    expect((await claimNext(k.dispatchDeps(transport))).claim).toBeNull();
    expect(transport.calls).toHaveLength(0);
    await afterStop(x);
  });

  it("Stop while a claim holds R but has not decided: Stop skips R (no wait); the claim holds it (bot_epoch_superseded); 0 calls", async () => {
    const x = await world();
    const account = await kit.hold("select id from whatsapp_accounts where id = $1 for update", [
      x.f.w.account.id,
    ]);
    const transport = new FakeTransport();
    const b = kit.settle(claimNext(k.dispatchDeps(transport)));
    const bPid = await kit.waitUntilBlocked(account.pid);
    expect((await stop(x.f)).value).toMatchObject({ requestsSuppressed: 0, requestsInFlight: 1 });
    expect(await kit.blockersOf(bPid)).toEqual([account.pid]);
    await account.release();
    expect(await b).toMatchObject({ ok: true, value: { claim: null, held: 1 } });
    expect(await k.request(x.r.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "bot_epoch_superseded",
    });
    expect(transport.calls).toHaveLength(0);
    await afterStop(x);
  });

  it("Stop after the claim committed SENDING, before the final authorization: refused (bot_epoch_superseded); 0 calls", async () => {
    const x = await world();
    const transport = new FakeTransport();
    const { claim } = await claimNext(k.dispatchDeps(transport));
    expect(claim?.requestId).toBe(x.r.id);
    expect((await stop(x.f)).value).toMatchObject({ requestsSuppressed: 0, requestsInFlight: 1 });
    expect(await executeClaim(k.dispatchDeps(transport), claim!)).toBe("held");
    expect(await k.request(x.r.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "bot_epoch_superseded",
    });
    expect(transport.calls).toHaveLength(0);
    await afterStop(x);
  });

  it("Stop after the final authorization (transport in flight): ACCEPTED, exactly ONE call — the accepted limitation, never a second attempt", async () => {
    const x = await world();
    const release = deferred();
    const transport = new FakeTransport().next(async () => {
      await release.promise;
      return k.accepted("wamid.TEST08E5.R5");
    });
    const { claim } = await claimNext(k.dispatchDeps(transport));
    const c = kit.settle(executeClaim(k.dispatchDeps(transport), claim!));
    for (let i = 0; i < 500 && transport.calls.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(transport.calls).toHaveLength(1);
    expect((await stop(x.f)).value).toMatchObject({ requestsSuppressed: 0, requestsInFlight: 1 });
    release.resolve();
    expect(await c).toMatchObject({ ok: true, value: "accepted" });
    expect(await k.request(x.r.id as string)).toMatchObject({ state: "ACCEPTED" });
    // V3.2 I.4 / blocker 42: an attempt whose final authorization preceded Stop cannot be recalled; it is sent at most once
    expect(
      transport.calls,
      "accepted post-final-authorization window: at most one attempt",
    ).toHaveLength(1);
    // a further dispatcher pass finds nothing to send
    expect((await claimNext(k.dispatchDeps(transport))).claim).toBeNull();
    expect(transport.calls).toHaveLength(1);
    await afterStop(x);
  });
});
