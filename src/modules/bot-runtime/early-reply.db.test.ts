import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { claimNext, executeClaim } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { barrierKit } from "../bot-control/testing";
import { claimTriggers } from "./trigger-queue";
import {
  endFirstFlow,
  expireClaim,
  makeDue,
  runtimeKit,
  triggerRow,
  type RuntimeFx,
} from "./testing";

// R2, R9 and R8 refusals (Phase 08E-6; plan G.2, G.3, G.4, F.3, J.4, N.2) on disposable PostgreSQL 17, through the established
// trigger and T1 APIs and the reconciler: an early student reply while the prompt is still in flight is deferred (one
// PROMPT_INTERACTION per message, the attempt refunded, no token consumed); each later outcome is applied by the reconciler
// (ACCEPTED wakes the deferred reply, which is then applied ONCE; HELD/REJECTED/UNKNOWN/send-wait expiry hand over and end it);
// restart, duplicate taps and staff takeover keep exactly-once semantics. R9: staleness precedes every deferral, at the exact
// maxInputAge boundary. R8: a refused END or HANDOVER notice commits the terminal state with NO notice authorization, the
// refusal event and no request. NOT EXECUTED by the author of this change: no isolated PostgreSQL server was configured.

const MAX_AGE = 10 * 60_000;

describe("early replies, recovery and staleness (R2, R9, R8 refusals)", () => {
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

  const kinds = async (sessionId: string, kind: string) =>
    (await k.events(sessionId)).filter((e) => e.kind === kind);

  /** S WAITING_FOR_SEND with its prompt R claimed (SENDING) and a tap on it processed early: deferred. */
  async function deferredTap(o: { sending?: boolean } = {}) {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    const transport = new FakeTransport();
    const claim = o.sending === false ? null : (await claimNext(k.dispatchDeps(transport))).claim;
    const tap = await k.replyTrigger(f, session.awaiting_token as string, "a");
    expect(await k.run(tap.id)).toEqual({ kind: "deferred", reason: "request_in_flight" });
    expect(await triggerRow(t, tap.id)).toMatchObject({
      status: "PENDING",
      attempts: 0,
      deferrals: 1,
      claim_token: null,
    });
    expect(await kinds(session.id as string, "PROMPT_INTERACTION")).toHaveLength(1);
    expect((await k.session(session.id as string)).last_consumed_token).toBeNull(); // no token consumed
    return { f, s: session, r: request, tap, claim, transport };
  }
  type Tap = Awaited<ReturnType<typeof deferredTap>>;
  const assertEndedWithoutInput = async (x: Tap, reason: string) => {
    expect(await k.session(x.s.id as string)).toMatchObject({
      state: "HANDED_OVER",
      handover_reason: reason,
    });
    expect(await triggerRow(t, x.tap.id)).toMatchObject({
      status: "IGNORED",
      outcome_code: "session_ended",
    });
    expect(await kinds(x.s.id as string, "INPUT_ACCEPTED")).toEqual([]);
    expect(await kinds(x.s.id as string, "PROMPT_INTERACTION")).toHaveLength(1);
    expect((await k.botRequests(x.f)).map((r) => r.id)).toEqual([x.r.id]);
  };

  describe("R2: the deferred reply after each outcome", () => {
    it("ACCEPTED: the reconciler applies it and wakes the reply; the reply is applied ONCE (one INPUT_ACCEPTED, the token consumed, the next prompt)", async () => {
      const x = await deferredTap();
      expect(
        await executeClaim(
          k.dispatchDeps(x.transport.next(k.accepted("wamid.TEST08E6.R2A"))),
          x.claim!,
        ),
      ).toBe("accepted");
      expect(await k.reconcile(x.s)).toMatchObject({ finalState: "WAITING_FOR_INPUT" });
      expect(await k.run(x.tap.id)).toMatchObject({
        status: "PROCESSED",
        outcome: "input_accepted",
      }); // woken: claimable now
      expect(await kinds(x.s.id as string, "INPUT_ACCEPTED")).toHaveLength(1);
      expect(await kinds(x.s.id as string, "PROMPT_INTERACTION")).toHaveLength(1);
      const s = await k.session(x.s.id as string);
      expect(s.last_consumed_token).toBe(x.s.awaiting_token);
      expect(await k.botRequests(x.f)).toHaveLength(2);
    });

    it("HELD (claimed late, deadline_passed): the reconciler hands over send_held and ends the deferred reply; nothing consumed", async () => {
      const x = await deferredTap({ sending: false }); // deferred behind the QUEUED prompt
      expect(
        await claimNext(k.dispatchDeps(x.transport, { now: () => new Date(Date.now() + 200_000) })),
      ).toMatchObject({ held: 1 });
      expect(await k.reconcile(x.s)).toMatchObject({ finalState: "HANDED_OVER" });
      await assertEndedWithoutInput(x, "send_held");
    });

    for (const [name, result, reason] of [
      [
        "REJECTED",
        { kind: "rejected", reason: "test", httpStatus: 400, providerErrorCode: "131000" },
        "send_rejected",
      ],
      [
        "UNKNOWN_OUTCOME",
        { kind: "unknown", reason: "timeout", httpStatus: null },
        "send_outcome_unknown",
      ],
    ] as const)
      it(`${name}: handed over ${reason}; the deferred reply ends; no retry, no replacement request`, async () => {
        const x = await deferredTap();
        await executeClaim(k.dispatchDeps(x.transport.next(result as never)), x.claim!);
        expect(await k.reconcile(x.s)).toMatchObject({ finalState: "HANDED_OVER" });
        await assertEndedWithoutInput(x, reason);
        expect(x.transport.calls).toHaveLength(1);
      });

    it("send-wait expiry while SENDING: send_outcome_unresolved; the SENDING request is untouched; the reply ends", async () => {
      const x = await deferredTap();
      const r0 = await k.requestJson(x.r.id as string);
      const expiry = new Date(x.s.send_wait_expires_at as Date).getTime();
      expect(await k.reconcile(x.s, { readClock: k.at(new Date(expiry + 1)) })).toMatchObject({
        action: "send_outcome_unresolved",
      });
      await assertEndedWithoutInput(x, "send_outcome_unresolved");
      expect(await k.requestJson(x.r.id as string)).toEqual(r0);
    });

    it("worker restart: the reply's claim dies with its worker, the lease expires, a new worker defers it, then applies it once after ACCEPTED", async () => {
      const f = await k.fixture();
      const { session } = await k.startedPrompt(f);
      const transport = new FakeTransport().next(k.accepted("wamid.TEST08E6.R2R"));
      const { claim } = await claimNext(k.dispatchDeps(transport));
      const tap = await k.replyTrigger(f, session.awaiting_token as string, "a");
      await k.claimOf(tap.id); // the worker that dies before T1
      await expireClaim(t, tap.id);
      expect(await k.run(tap.id)).toEqual({ kind: "deferred", reason: "request_in_flight" });
      await executeClaim(k.dispatchDeps(transport), claim!);
      await k.reconcile(session);
      expect(await k.run(tap.id)).toMatchObject({ outcome: "input_accepted" });
      expect(await kinds(session.id as string, "INPUT_ACCEPTED")).toHaveLength(1);
      expect(await kinds(session.id as string, "PROMPT_INTERACTION")).toHaveLength(1);
    });

    it("a re-deferred tap adds no second PROMPT_INTERACTION; a duplicate tap after acceptance is duplicate_reply (no event, no consumption)", async () => {
      const x = await deferredTap();
      const second = await k.replyTrigger(x.f, x.s.awaiting_token as string, "a"); // a second tap on the same button
      await makeDue(t, x.tap.id);
      expect(await k.run(x.tap.id)).toEqual({ kind: "deferred", reason: "request_in_flight" }); // re-deferred
      expect(await kinds(x.s.id as string, "PROMPT_INTERACTION")).toHaveLength(1);
      await executeClaim(
        k.dispatchDeps(x.transport.next(k.accepted("wamid.TEST08E6.R2D"))),
        x.claim!,
      );
      await k.reconcile(x.s);
      expect(await k.run(x.tap.id)).toMatchObject({ outcome: "input_accepted" });
      // the session now waits on the NEXT prompt; once that is accepted and reconciled, the old tap is a duplicate
      expect(
        (
          await k.dispatchWith(
            k.accepted("wamid.TEST08E6.R2D2"),
            (await k.botRequests(x.f))[1]!.id as string,
          )
        ).outcome,
      ).toBe("accepted");
      await k.reconcile(x.s);
      expect(await k.run(second.id)).toMatchObject({
        status: "IGNORED",
        outcome: "duplicate_reply",
      });
      expect(await kinds(x.s.id as string, "INPUT_ACCEPTED")).toHaveLength(1);
      expect(await k.botRequests(x.f)).toHaveLength(2);
    });

    it("staff takeover while the reply is deferred, BEFORE the final authorization: the send is refused (staff_took_over, 0 calls); the reconciler hands over and ends the reply, which is no longer claimable", async () => {
      const x = await deferredTap();
      await k.assign(x.f);
      const transport = x.transport.next(k.accepted("wamid.TEST08E6.R2S"));
      expect(await executeClaim(k.dispatchDeps(transport), x.claim!)).toBe("held");
      expect(await k.request(x.r.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "staff_took_over",
      });
      expect(transport.calls).toHaveLength(0);
      expect(await k.reconcile(x.s)).toMatchObject({ kind: "applied", finalState: "HANDED_OVER" });
      expect(await k.session(x.s.id as string)).toMatchObject({
        state: "HANDED_OVER",
        handover_reason: "send_held",
      });
      expect(
        (await k.events(x.s.id as string))
          .filter((e) => e.kind === "HANDED_OVER")
          .map((e) => e.code),
      ).toEqual(["staff_took_over"]);
      // the deferred reply was ended in the hand-over transaction: durable, finished, never claimable again
      expect(await triggerRow(t, x.tap.id)).toMatchObject({
        status: "IGNORED",
        outcome_code: "session_ended",
        claim_token: null,
      });
      await makeDue(t, x.tap.id); // a no-op on a finished trigger
      expect((await claimTriggers(t.db, 50)).map((c) => c.id)).not.toContain(x.tap.id);
      expect(await kinds(x.s.id as string, "INPUT_ACCEPTED")).toEqual([]);
      expect((await k.session(x.s.id as string)).last_consumed_token).toBeNull();
      expect(await k.botRequests(x.f)).toHaveLength(1);
    });

    it("staff takeover while the reply is deferred, AFTER the provider accepted: the reconciler applies the acceptance (plan R-8), then the reply hands the session over (staff_assigned); no input applied", async () => {
      const x = await deferredTap();
      expect(
        await executeClaim(
          k.dispatchDeps(x.transport.next(k.accepted("wamid.TEST08E6.R2S2"))),
          x.claim!,
        ),
      ).toBe("accepted");
      await k.assign(x.f);
      expect(await k.reconcile(x.s)).toMatchObject({ finalState: "WAITING_FOR_INPUT" });
      expect(await k.run(x.tap.id)).toMatchObject({ status: "IGNORED", outcome: "session_ended" });
      expect(await k.session(x.s.id as string)).toMatchObject({
        state: "HANDED_OVER",
        handover_reason: "staff_assigned",
      });
      expect(await kinds(x.s.id as string, "INPUT_ACCEPTED")).toEqual([]);
      expect((await k.session(x.s.id as string)).last_consumed_token).toBeNull();
      expect(await k.botRequests(x.f)).toHaveLength(1);
      expect(x.transport.calls).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------------------------ R9
  describe("R9: staleness before any deferral, exact boundaries", () => {
    const inputAt = async (id: string) =>
      new Date((await triggerRow(t, id)).input_occurred_at as Date).getTime();

    it("start path behind an in-flight terminal notice: exactly maxInputAge old -> deferred; 1 ms older -> IGNORED stale_trigger, never DEAD", async () => {
      const f = await k.fixture(endFirstFlow("Bye"));
      const first = await k.trigger(f, { first: true, body: "menu" });
      await k.run(first.id); // COMPLETED; its notice QUEUED (in flight)
      const tr = await k.trigger(f, { body: "menu" });
      const at = await inputAt(tr.id);
      expect(await k.run(tr.id, { readClock: k.at(new Date(at + MAX_AGE)) })).toEqual({
        kind: "deferred",
        reason: "bot_request_in_flight",
      });
      await makeDue(t, tr.id);
      expect(await k.run(tr.id, { readClock: k.at(new Date(at + MAX_AGE + 1)) })).toMatchObject({
        status: "IGNORED",
        outcome: "stale_trigger",
      });
      expect(await triggerRow(t, tr.id)).toMatchObject({
        status: "IGNORED",
        outcome_code: "stale_trigger",
        attempts: 1,
      });
    });

    it("continuation behind a SENDING prompt: exactly maxInputAge old -> deferred; 1 ms older -> stale_trigger with the session byte-identical", async () => {
      const f = await k.fixture();
      const { session } = await k.startedPrompt(f);
      await claimNext(k.dispatchDeps(new FakeTransport()));
      const tap = await k.replyTrigger(f, session.awaiting_token as string, "a");
      const at = await inputAt(tap.id);
      expect(await k.run(tap.id, { readClock: k.at(new Date(at + MAX_AGE)) })).toEqual({
        kind: "deferred",
        reason: "request_in_flight",
      });
      const s0 = await k.sessionJson(session.id as string);
      await makeDue(t, tap.id);
      expect(await k.run(tap.id, { readClock: k.at(new Date(at + MAX_AGE + 1)) })).toMatchObject({
        outcome: "stale_trigger",
      });
      expect(await k.sessionJson(session.id as string)).toEqual(s0);
    });
  });

  // ------------------------------------------------------------------------------------------------ R8 refusals
  describe("R8: a refused terminal notice (deferred direct coverage)", () => {
    /** WAITING_FOR_INPUT on the menu's first prompt (accepted and reconciled). */
    async function waiting(f: RuntimeFx) {
      const { session } = await k.acceptedPrompt(f);
      await k.reconcile(session);
      return k.session(session.id as string);
    }
    const archiveContact = (f: RuntimeFx) =>
      t.pool.query("update contacts set archived_at = clock_timestamp() where id = $1", [
        f.w.student.contact.id,
      ]);

    it("HANDOVER notice refused: HANDED_OVER needs_staff with terminal_notice_step_seq NULL, TERMINAL_NOTICE_NOT_QUEUED (contact_archived), no request", async () => {
      const f = await k.fixture();
      const s = await waiting(f);
      await archiveContact(f);
      const tap = await k.replyTrigger(f, s.awaiting_token as string, "b"); // option b -> HANDOVER with a message
      expect(await k.run(tap.id)).toMatchObject({ status: "PROCESSED" });
      expect(await k.session(s.id as string)).toMatchObject({
        state: "HANDED_OVER",
        end_reason: "flow_handover",
        handover_reason: "needs_staff",
        terminal_notice_step_seq: null,
      });
      expect((await k.events(s.id as string)).map((e) => [e.kind, e.code]).sort()).toEqual(
        [
          ["HANDED_OVER", "needs_staff"],
          ["INPUT_ACCEPTED", null],
          ["TERMINAL_NOTICE_NOT_QUEUED", "contact_archived"],
        ].sort(),
      );
      expect(await k.botRequests(f)).toHaveLength(1); // only the original prompt
    });

    it("END notice refused: COMPLETED flow_end with terminal_notice_step_seq NULL, TERMINAL_NOTICE_NOT_QUEUED (contact_archived), no request", async () => {
      const f = await k.fixture();
      const s = await waiting(f);
      const first = await k.replyTrigger(f, s.awaiting_token as string, "a"); // -> the second prompt
      expect(await k.run(first.id)).toMatchObject({ outcome: "input_accepted" });
      expect(
        (
          await k.dispatchWith(
            k.accepted("wamid.TEST08E6.R8E"),
            (await k.botRequests(f))[1]!.id as string,
          )
        ).outcome,
      ).toBe("accepted");
      await k.reconcile(s);
      const s2 = await k.session(s.id as string);
      expect(s2.state).toBe("WAITING_FOR_INPUT");
      await archiveContact(f);
      const ok = await k.replyTrigger(f, s2.awaiting_token as string, "ok"); // -> END with a message
      expect(await k.run(ok.id)).toMatchObject({ status: "PROCESSED" });
      expect(await k.session(s.id as string)).toMatchObject({
        state: "COMPLETED",
        end_reason: "flow_end",
        terminal_notice_step_seq: null,
      });
      expect(
        (await k.events(s.id as string))
          .filter((e) => e.kind === "TERMINAL_NOTICE_NOT_QUEUED")
          .map((e) => e.code),
      ).toEqual(["contact_archived"]);
      expect(await k.botRequests(f)).toHaveLength(2); // the two prompts, no notice
    });
  });
});
