import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, seedMessage, type TestDb } from "@/db/__tests__/helpers";
import { claimNext, executeClaim } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { stopActiveSessions } from "../bot-control";
import { barrierKit } from "../bot-control/testing";
import { deferred, messageFlow, messageHandoverFlow, runtimeKit, type RuntimeFx } from "./testing";

// 08E-6 P2 regression (independent review J): a terminal notice the reconciler AUTHORIZES must stay QUEUED and dispatchable.
// Defect: after applyEngineResult the reconciler held every queued request of a session that ended, including the END/HANDOVER
// notice it had just enqueued and recorded as terminal_notice_step_seq, so the closing message could never be sent. Fix: the
// post-apply hold skips exactly the notice the result authorized (outbound_requests_bot_inflight_uidx makes it the session's one
// in-flight BOT request). Real PostgreSQL 17, real T1 sessions, the real reconciler and the real dispatcher with a FakeTransport.
// MUTATION: withholding the authorization from the reconciler (the defective unconditional hold) makes the notice HELD and
// undispatchable. NOT EXECUTED by the author of this change: no isolated PostgreSQL server was configured.

const mutate = vi.hoisted(() => ({ unconditionalHold: false }));
vi.mock("./apply", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./apply")>();
  return {
    ...orig,
    applyEngineResult: async (...a: Parameters<typeof orig.applyEngineResult>) => {
      const r = await orig.applyEngineResult(...a);
      return mutate.unconditionalHold ? { ...r, noticeRequestId: null } : r;
    },
  };
});

const IN_FLIGHT_INDEXES = [
  "outbound_requests_bot_inflight_uidx",
  "outbound_requests_bot_conv_inflight_uidx",
];

describe("a terminal notice authorized by reconciliation stays dispatchable (08E-6 P2)", () => {
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
    mutate.unconditionalHold = false;
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    mutate.unconditionalHold = false;
    k.releaseAll();
    try {
      await kit.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  });
  afterAll(async () => t.close());

  /** MESSAGE (real T1) -> its request ACCEPTED by the real dispatcher -> reconciled once: the notice is enqueued. */
  async function reconciledNotice(
    flow: Record<string, unknown>,
    before?: (f: RuntimeFx) => Promise<void>,
  ) {
    const f = await k.fixture(flow);
    const tr = await k.trigger(f, { first: true, body: "menu" });
    expect(await k.run(tr.id)).toMatchObject({ outcome: "session_started" });
    const s = await k.one("select * from bot_sessions where conversation_id = $1", [
      f.w.student.conversation.id,
    ]);
    const [message] = await k.botRequests(f);
    expect(s).toMatchObject({ state: "WAITING_FOR_SEND", step_seq: message!.bot_step_seq });
    expect(
      (
        await k.dispatchWith(
          k.accepted(`wamid.TEST08E6P2.MSG.${f.w.org.id}`),
          message!.id as string,
        )
      ).outcome,
    ).toBe("accepted");
    await before?.(f);
    const outcome = await k.reconcile(s);
    const session = await k.session(s.id as string);
    const requests = await k.botRequests(f);
    return { f, s, message: message!, outcome, session, requests, notice: requests[1] };
  }

  /** The notice is QUEUED, unheld, authorized by the session, and the session's output is NOT suppressed. */
  function expectAuthorizedQueuedNotice(x: Awaited<ReturnType<typeof reconciledNotice>>) {
    expect(x.requests).toHaveLength(2);
    expect(x.notice).toMatchObject({ state: "QUEUED", hold_reason: null, bot_session_id: x.s.id });
    expect(Number(x.session.terminal_notice_step_seq)).toBe(Number(x.notice!.bot_step_seq));
    expect(x.session.output_suppressed_at).toBeNull();
  }

  /** The real dispatcher sends exactly that notice, once, and records the provider id; nothing else is claimable afterwards. */
  async function expectNoticeDispatchedOnce(x: Awaited<ReturnType<typeof reconciledNotice>>) {
    const wamid = `wamid.TEST08E6P2.NOTICE.${x.notice!.id as string}`;
    const sent = await k.dispatchWith(k.accepted(wamid), x.notice!.id as string);
    expect(sent.outcome).toBe("accepted");
    expect(sent.transport.calls).toHaveLength(1);
    expect(await k.request(x.notice!.id as string)).toMatchObject({
      state: "ACCEPTED",
      hold_reason: null,
    });
    expect(
      (await k.one("select wamid from messages where id = $1", [x.notice!.message_id])).wamid,
    ).toBe(wamid);
    const again = new FakeTransport();
    expect((await claimNext(k.dispatchDeps(again))).claim).toBeNull();
    expect(again.calls).toHaveLength(0);
  }

  /** Further reconciliation leaves the terminal session and its requests exactly as they are. */
  async function expectIdempotent(x: Awaited<ReturnType<typeof reconciledNotice>>) {
    const s0 = await k.sessionJson(x.s.id as string);
    const r0 = await Promise.all(x.requests.map((r) => k.requestJson(r.id as string)));
    for (let i = 0; i < 2; i++) {
      expect(await k.reconcile(x.s)).toEqual({ kind: "skipped", reason: "not_live" });
      expect(await k.sessionJson(x.s.id as string)).toEqual(s0);
      expect(await Promise.all(x.requests.map((r) => k.requestJson(r.id as string)))).toEqual(r0);
    }
  }

  // ------------------------------------------------------------------------------------------------ A / B
  it("A: MESSAGE -> END: COMPLETED with the notice authorized and QUEUED (no hold); the dispatcher sends exactly it once; reconciliation is idempotent", async () => {
    const x = await reconciledNotice(messageFlow());
    expect(x.outcome).toEqual({
      kind: "applied",
      action: "send_result_accepted",
      finalState: "COMPLETED",
    });
    expect(x.session).toMatchObject({
      state: "COMPLETED",
      end_reason: "flow_end",
      handover_reason: null,
    });
    expectAuthorizedQueuedNotice(x);
    await expectIdempotent(x); // before the send ...
    await expectNoticeDispatchedOnce(x);
    await expectIdempotent({ ...x, requests: await k.botRequests(x.f) }); // ... and after it
  });

  it("B: MESSAGE -> HANDOVER: HANDED_OVER flow_handover/needs_staff with the notice authorized and QUEUED; sent exactly once; idempotent", async () => {
    const x = await reconciledNotice(messageHandoverFlow());
    expect(x.outcome).toMatchObject({ kind: "applied", finalState: "HANDED_OVER" });
    expect(x.session).toMatchObject({
      state: "HANDED_OVER",
      end_reason: "flow_handover",
      handover_reason: "needs_staff",
    });
    expect((await k.events(x.s.id as string)).map((e) => [e.kind, e.code])).toEqual([
      ["HANDED_OVER", "needs_staff"],
    ]);
    expectAuthorizedQueuedNotice(x);
    await expectNoticeDispatchedOnce(x);
    await expectIdempotent({ ...x, requests: await k.botRequests(x.f) });
  });

  // ------------------------------------------------------------------------------------------------ C: safety controls
  describe("C: every dispatcher rule still applies to the authorized notice", () => {
    it("staff intervention before the final authorization: refused staff_took_over, 0 calls", async () => {
      const x = await reconciledNotice(messageFlow());
      const transport = new FakeTransport();
      const { claim } = await claimNext(k.dispatchDeps(transport));
      expect(claim?.requestId).toBe(x.notice!.id);
      await k.assign(x.f);
      expect(await executeClaim(k.dispatchDeps(transport), claim!)).toBe("held");
      expect(await k.request(x.notice!.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "staff_took_over",
      });
      expect(transport.calls).toHaveLength(0);
    });

    const stop = (f: RuntimeFx) =>
      stopActiveSessions(
        f.w.admin.ctx,
        { deploymentId: f.deployment.id, expectedLiveSessions: 0 },
        { db: t.db as never },
      );

    it("Stop before the claim: Stop itself holds the notice (bot_stopped); nothing is claimed; 0 calls", async () => {
      const x = await reconciledNotice(messageHandoverFlow());
      expect((await stop(x.f)).value).toMatchObject({ requestsSuppressed: 1 });
      expect(await k.request(x.notice!.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_stopped",
      });
      const transport = new FakeTransport();
      expect((await claimNext(k.dispatchDeps(transport))).claim).toBeNull();
      expect(transport.calls).toHaveLength(0);
    });

    it("Stop after the claim, before the final authorization: the epoch is superseded, refused bot_epoch_superseded, 0 calls", async () => {
      const x = await reconciledNotice(messageFlow());
      const transport = new FakeTransport();
      const { claim } = await claimNext(k.dispatchDeps(transport));
      expect(claim?.requestId).toBe(x.notice!.id);
      expect((await stop(x.f)).value).toMatchObject({ requestsSuppressed: 0, requestsInFlight: 1 });
      expect(await executeClaim(k.dispatchDeps(transport), claim!)).toBe("held");
      expect(await k.request(x.notice!.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_epoch_superseded",
      });
      expect(transport.calls).toHaveLength(0);
    });

    it("the exemption covers ONLY the notice: no other QUEUED BOT request of the session can exist beside it (the in-flight index refuses one)", async () => {
      const x = await reconciledNotice(messageFlow());
      const other = await seedMessage(t.db, {
        organizationId: x.f.w.org.id,
        conversationId: x.f.w.student.conversation.id,
        whatsappAccountId: x.f.w.account.id,
        direction: "OUTBOUND",
      });
      const error = await t.pool
        .query(
          `insert into outbound_requests
           select (jsonb_populate_record(null::outbound_requests, to_jsonb(r) || jsonb_build_object(
             'id', gen_random_uuid(), 'message_id', $2::uuid, 'idempotency_key', 'bot-' || r.bot_session_id || '-' || (r.bot_step_seq + 1),
             'bot_step_seq', r.bot_step_seq + 1, 'state', 'QUEUED'))).*
             from outbound_requests r where r.id = $1`,
          [x.notice!.id, other.id],
        )
        .then(
          () => null,
          (e: { code?: string; constraint?: string }) => e,
        );
      expect(error?.code).toBe("23505");
      expect(IN_FLIGHT_INDEXES).toContain(error?.constraint);
    });

    it("a refused notice (contact archived before reconciliation): terminal with NULL notice authorization, the refusal event, no request, output suppressed", async () => {
      const x = await reconciledNotice(messageFlow(), async (f) => {
        await t.pool.query("update contacts set archived_at = clock_timestamp() where id = $1", [
          f.w.student.contact.id,
        ]);
      });
      expect(x.session).toMatchObject({
        state: "COMPLETED",
        end_reason: "flow_end",
        terminal_notice_step_seq: null,
      });
      expect(x.session.output_suppressed_at).toBeInstanceOf(Date);
      expect(x.requests.map((r) => r.id)).toEqual([x.message.id]);
      expect((await k.events(x.s.id as string)).map((e) => [e.kind, e.code])).toEqual([
        ["TERMINAL_NOTICE_NOT_QUEUED", "contact_archived"],
      ]);
    });

    it("final authorization already passed (transport in flight) when staff acts: the accepted window, ACCEPTED, exactly one call", async () => {
      const x = await reconciledNotice(messageFlow());
      const release = deferred();
      const transport = new FakeTransport().next(async () => {
        await release.promise;
        return k.accepted("wamid.TEST08E6P2.WINDOW");
      });
      const { claim } = await claimNext(k.dispatchDeps(transport));
      const c = kit.settle(executeClaim(k.dispatchDeps(transport), claim!));
      for (let i = 0; i < 500 && transport.calls.length === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(transport.calls).toHaveLength(1);
      await k.assign(x.f);
      release.resolve();
      expect(await c).toMatchObject({ ok: true, value: "accepted" });
      expect(await k.request(x.notice!.id as string)).toMatchObject({ state: "ACCEPTED" });
      expect(transport.calls).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------------------------ mutation
  for (const [name, flow] of [
    ["END", messageFlow],
    ["HANDOVER", messageHandoverFlow],
  ] as const)
    it(`MUTATION (the defective unconditional hold restored) for ${name}: the authorized notice becomes HELD bot_output_suppressed and is never sent`, async () => {
      mutate.unconditionalHold = true;
      const x = await reconciledNotice(flow());
      mutate.unconditionalHold = false;
      expect(Number(x.session.terminal_notice_step_seq)).toBe(Number(x.notice!.bot_step_seq)); // still "authorized" ...
      expect(x.notice).toMatchObject({ state: "HELD", hold_reason: "bot_output_suppressed" }); // ... but held
      const transport = new FakeTransport();
      expect((await claimNext(k.dispatchDeps(transport))).claim).toBeNull(); // the closing message can never be sent
      expect(transport.calls).toHaveLength(0);
      expect(await k.reconcile(x.s)).toEqual({ kind: "skipped", reason: "not_live" }); // and nothing repairs it
    });
});
