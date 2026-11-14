import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { pausingDatabase } from "@/db/__tests__/pausing-database";
import { claimNext, executeClaim } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { barrierKit, settledState } from "../bot-control/testing";
import { deferred, runtimeKit, type RuntimeFx } from "./testing";
import { triggerRow } from "./testing";

// R3-S-B (Phase 08E-5; plan I.1, I.4, I.5.1 Scenario B) on disposable PostgreSQL 17 at READ COMMITTED: a GENUINE staff takeover
// of a live session whose prompt request R is in flight. The staff action is the real Inbox assignment or the real STAFF
// submission (database-allocated control_seq greater than S.started_control_seq; no forged event, no BOT-as-STAFF request). The
// session and R come from real T1; the hand-over is applied by real T1 (the takeover branch, with the session-scoped hold); the
// dispatcher is the real claim and executeClaim with a FakeTransport. Every other condition (deadline, window, gates, epoch)
// stays eligible so the asserted code is unambiguous. The STAFF request's own transport is never executed; BOT calls are
// counted by R. NOT EXECUTED by the author of this change: no isolated PostgreSQL server was configured.

type Action = "assign" | "submit";
const REASON: Record<Action, string> = { assign: "staff_assigned", submit: "staff_replied" };

describe("genuine staff takeover versus the dispatcher (R3-S-B)", () => {
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

  /** A live session WAITING_FOR_SEND with its one QUEUED prompt request R, both made by real T1. */
  async function world() {
    const f = await k.fixture();
    const { session, request } = await k.startedPrompt(f);
    return { f, s: session, r: request };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** The staff action, committed; returns its database-allocated control sequence. */
  async function staffAction(f: RuntimeFx, action: Action): Promise<number> {
    if (action === "assign") {
      expect((await k.assign(f)).changed).toBe(true);
      return Number(
        (
          await k.one(
            "select max(control_seq) s from conversation_events where conversation_id = $1 and kind = 'ASSIGNMENT'",
            [f.w.student.conversation.id],
          )
        ).s,
      );
    }
    await k.submit(f);
    return Number(
      (
        await k.one(
          "select max(control_seq) s from outbound_requests where conversation_id = $1 and origin = 'STAFF'",
          [f.w.student.conversation.id],
        )
      ).s,
    );
  }

  /** A dispatcher claim; a STAFF request it may claim is set aside (never executed). Returns R's claim or null. */
  async function claimR(x: World, transport: FakeTransport) {
    const result = await claimNext(k.dispatchDeps(transport));
    if (result.claim && result.claim.requestId !== x.r.id) {
      expect(
        (await k.request(result.claim.requestId)).origin,
        "only a STAFF request may be claimed instead of R",
      ).toBe("STAFF");
      return { claim: null, held: result.held };
    }
    return result;
  }

  /**
   * The runtime hand-over: real T1 for a fresh student message in the conversation (plus a later PENDING trigger that the
   * J.4a cleanup must end). Asserts the exact session outcome and returns the trigger ids.
   */
  async function runtimeHandover(x: World, action: Action, staffSeq: number) {
    const before = await k.session(x.s.id as string);
    const tr = await k.trigger(x.f, { body: "hello?" });
    const later = await k.trigger(x.f, { body: "anyone?" });
    const summary = await k.run(tr.id);
    expect(summary).toMatchObject({
      kind: "finished",
      status: "IGNORED",
      outcome: "session_ended",
      sessionId: x.s.id,
    });
    const after = await k.session(x.s.id as string);
    expect(after).toMatchObject({
      state: "HANDED_OVER",
      end_reason: "system_handover",
      handover_reason: REASON[action],
      awaiting: null,
      awaiting_token: null,
      terminal_notice_step_seq: null,
      revision: Number(before.revision) + 1,
    });
    expect(after.output_suppressed_at).toBeInstanceOf(Date);
    expect(Number(after.handover_control_seq)).toBeGreaterThan(staffSeq);
    expect(staffSeq).toBeGreaterThan(Number(after.started_control_seq));
    expect((await k.events(x.s.id as string)).map((e) => [e.kind, e.code])).toEqual([
      ["HANDED_OVER", REASON[action]],
    ]);
    expect(await triggerRow(t, later.id)).toMatchObject({
      status: "IGNORED",
      outcome_code: "session_ended",
    });
    // no BOT notice or other BOT request; the student's messages stay in the Inbox
    expect(await k.botRequests(x.f)).toHaveLength(1);
    expect(
      Number(
        (
          await k.one("select count(*)::int n from messages where id = any($1)", [
            [tr.messageId, later.messageId],
          ])
        ).n,
      ),
    ).toBe(2);
  }

  for (const action of ["assign", "submit"] as const) {
    describe(`${action === "assign" ? "real Inbox assignment" : "real STAFF submission"}`, () => {
      it("B1: staff commits before the claim, the runtime not yet: the claim holds R staff_took_over; 0 BOT calls; then the runtime hands over without changing R", async () => {
        const x = await world();
        const seq = await staffAction(x.f, action);
        const transport = new FakeTransport();
        const claimed = await claimR(x, transport);
        expect(claimed.claim).toBeNull();
        expect(claimed.held).toBe(1);
        expect(await k.request(x.r.id as string)).toMatchObject({
          state: "HELD",
          hold_reason: "staff_took_over",
        });
        expect(transport.calls).toHaveLength(0);
        expect(await k.inFlight(x.s.id as string)).toBe(0);
        await runtimeHandover(x, action, seq);
        expect(await k.request(x.r.id as string)).toMatchObject({
          state: "HELD",
          hold_reason: "staff_took_over",
        });
      });

      it("B2: R committed SENDING, staff commits before final authorization, runtime held back: refused staff_took_over; 0 BOT calls", async () => {
        const x = await world();
        const transport = new FakeTransport();
        const { claim } = await claimR(x, transport);
        expect(claim?.requestId).toBe(x.r.id);
        expect(await k.inFlight(x.s.id as string)).toBe(1);
        const seq = await staffAction(x.f, action);
        expect(await executeClaim(k.dispatchDeps(transport), claim!)).toBe("held");
        expect(await k.request(x.r.id as string)).toMatchObject({
          state: "HELD",
          hold_reason: "staff_took_over",
        });
        expect(transport.calls).toHaveLength(0);
        expect(await k.inFlight(x.s.id as string)).toBe(0);
        await runtimeHandover(x, action, seq);
      });

      it("B3: staff action AND the runtime hand-over commit before the claim: T1 holds R bot_output_suppressed (the suppression comes first); 0 BOT calls", async () => {
        const x = await world();
        const seq = await staffAction(x.f, action);
        await runtimeHandover(x, action, seq);
        expect(await k.request(x.r.id as string)).toMatchObject({
          state: "HELD",
          hold_reason: "bot_output_suppressed",
        });
        const transport = new FakeTransport();
        expect((await claimR(x, transport)).claim).toBeNull();
        expect(transport.calls).toHaveLength(0);
        expect(await k.inFlight(x.s.id as string)).toBe(0);
      });

      it("B3': R committed SENDING, then staff action and runtime hand-over commit before final authorization: T1 leaves SENDING untouched; refused bot_output_suppressed; 0 BOT calls", async () => {
        const x = await world();
        const transport = new FakeTransport();
        const { claim } = await claimR(x, transport);
        expect(claim?.requestId).toBe(x.r.id);
        const seq = await staffAction(x.f, action);
        const sending = await k.request(x.r.id as string);
        await runtimeHandover(x, action, seq);
        expect(await k.request(x.r.id as string)).toEqual(sending); // SENDING never touched by the runtime
        expect(await executeClaim(k.dispatchDeps(transport), claim!)).toBe("held");
        // output_suppressed_at is tested before the staff predicate in bot_request_hold_code: pinned precedence
        expect(await k.request(x.r.id as string)).toMatchObject({
          state: "HELD",
          hold_reason: "bot_output_suppressed",
        });
        expect(transport.calls).toHaveLength(0);
      });

      if (action === "assign")
        it("B4: the claim is parked before its bot-rule read while holding R; staff commits; the claim resumes and holds R staff_took_over; no circular wait", async () => {
          const x = await world();
          // The barrier: FOR NO KEY UPDATE on the account conflicts with the claim's FOR SHARE (loadAccount), so the claim parks
          // holding R, before its bot-rule read; it does NOT conflict with FOR KEY SHARE, the lock the assignment's foreign-key
          // re-check takes on the account (see the next test), so the staff action is not blocked by the TEST's lock.
          const account = await kit.hold(
            "select id from whatsapp_accounts where id = $1 for no key update",
            [x.f.w.account.id],
          );
          const transport = new FakeTransport();
          const b = kit.settle(claimNext(k.dispatchDeps(transport)));
          const bPid = await kit.waitUntilBlocked(account.pid);
          const staff = k.assign(x.f);
          expect(await kit.within(staff, 5_000)).toBe(true); // commits while B is still parked
          expect((await staff).changed).toBe(true);
          const seq = Number(
            (
              await k.one(
                "select max(control_seq) s from conversation_events where conversation_id = $1 and kind = 'ASSIGNMENT'",
                [x.f.w.student.conversation.id],
              )
            ).s,
          );
          expect(await kit.blockersOf(bPid)).toEqual([account.pid]);
          await account.release();
          const result = await b;
          expect(settledState(result)).toBeNull();
          expect(result).toMatchObject({ ok: true, value: { claim: null, held: 1 } });
          expect(await k.request(x.r.id as string)).toMatchObject({
            state: "HELD",
            hold_reason: "staff_took_over",
          });
          expect(transport.calls).toHaveLength(0);
          await runtimeHandover(x, action, seq);
        });

      if (action === "assign")
        it("B4 barrier evidence: a FOR UPDATE barrier on the account blocks the ASSIGNMENT itself (foreign-key KEY SHARE re-check), not via the claim; no cycle", async () => {
          const x = await world();
          const account = await kit.hold(
            "select id from whatsapp_accounts where id = $1 for update",
            [x.f.w.account.id],
          );
          const transport = new FakeTransport();
          const b = kit.settle(claimNext(k.dispatchDeps(transport)));
          const bPid = await kit.waitUntilBlocked(account.pid);
          const staff = kit.settle(k.assign(x.f));
          // the assignment's backend: blocked by the test's account holder only (never by the parked claim)
          let aPid = 0;
          for (let i = 0; i < 1_000 && aPid === 0; i++) {
            const r = await k.rows(
              "select pid from pg_stat_activity where datname = current_database() and $1 = any(pg_blocking_pids(pid)) and pid <> $2",
              [account.pid, bPid],
            );
            if (r.length > 0) aPid = Number(r[0]!.pid);
            else await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(aPid).toBeGreaterThan(0);
          expect(await kit.blockersOf(aPid)).toEqual([account.pid]);
          expect(await kit.blockersOf(bPid)).toEqual([account.pid]);
          // it waits for a tuple lock on whatsapp_accounts (the KEY SHARE of the conversations -> accounts FK re-check that
          // runs because the allocator updates a conversations row this transaction already updated)
          expect(
            (await k.one("select wait_event_type from pg_stat_activity where pid = $1", [aPid]))
              .wait_event_type,
          ).toBe("Lock");
          await account.release();
          const [claimResult, staffResult] = await Promise.all([b, staff]);
          expect([settledState(claimResult), settledState(staffResult)]).toEqual([null, null]);
          // which of the two then went first is not asserted here; nothing was sent
          expect(transport.calls).toHaveLength(0);
        });

      it("B5: final authorization already passed (transport paused) when staff and the runtime hand-over commit: the accepted limit, ACCEPTED, exactly 1 call", async () => {
        const x = await world();
        const release = deferred();
        const wamid = `wamid.TEST08E5.B5.${action}`;
        const transport = new FakeTransport().next(async () => {
          await release.promise;
          return k.accepted(wamid);
        });
        const { claim } = await claimR(x, transport);
        expect(claim?.requestId).toBe(x.r.id);
        const c = kit.settle(executeClaim(k.dispatchDeps(transport), claim!));
        for (let i = 0; i < 500 && transport.calls.length === 0; i++)
          await new Promise((r) => setTimeout(r, 10));
        expect(transport.calls).toHaveLength(1);
        const seq = await staffAction(x.f, action);
        await runtimeHandover(x, action, seq);
        release.resolve();
        expect(await c).toMatchObject({ ok: true, value: "accepted" });
        expect(await k.request(x.r.id as string)).toMatchObject({ state: "ACCEPTED" });
        expect(
          (await k.one("select wamid from messages where id = $1", [x.r.message_id])).wamid,
        ).toBe(wamid);
        expect(transport.calls).toHaveLength(1); // no second call, no resend
        expect(await k.inFlight(x.s.id as string)).toBe(0);
        expect((await k.session(x.s.id as string)).state).toBe("HANDED_OVER");
      });
    });
  }

  // ======================================================================== B4 for STAFF submission (Phase 08E-9 Batch 3)
  //
  // The submission takes the conversation FOR UPDATE, its own idempotency advisory lock and the account FOR SHARE, so no row
  // barrier can park the claim before its bot-rule read without also blocking the submission (review-conditions.db.test.ts).
  // The owner-authorized test-only pausing database parks the REAL claim on its own connection immediately before it transmits
  // `SELECT bot_request_hold_code($1, $2) AS code` (dispatch.ts, the claim-time bot rule; the final authorization's statement
  // is a different one and cannot match). The claim then holds R FOR UPDATE, the account advisory lock and the account FOR
  // SHARE; it holds no conversation lock. Nothing in the dispatcher is changed or stubbed.

  describe("B4: real STAFF submission while the claim is parked (pausing database)", () => {
    const CLAIM_BOT_RULE = /^SELECT bot_request_hold_code\(\$1, \$2\) AS code$/;
    /** The SENDING transition of the claim (only the claim sets send_started_at). */
    const CLAIM_SENDING = /^update "outbound_requests" set .*"send_started_at" = /;
    /** An independent NOWAIT probe in its own autocommit statement: "free" (and released at once) or the SQLSTATE. */
    const probe = (text: string, id: string) =>
      t.pool.query(text, [id]).then(
        () => "free",
        (e: { code?: string }) => e.code ?? "error",
      );
    const backendState = async (pid: number) =>
      (await k.one("select state from pg_stat_activity where pid = $1", [pid])).state as string;
    const advisoryLocks = async (pid: number) =>
      Number(
        (
          await k.one(
            "select count(*)::int n from pg_locks where pid = $1 and locktype = 'advisory' and granted",
            [pid],
          )
        ).n,
      );

    it("B4: the claim, parked holding R immediately before its bot-rule read, resumes after the submission committed; its READ COMMITTED read sees the staff fence: R HELD staff_took_over, 0 BOT calls; then the runtime hands over", async () => {
      const x = await world();
      const p = pausingDatabase(t);
      let seq = 0;
      try {
        const pause = p.arm(CLAIM_BOT_RULE);
        const transport = new FakeTransport();
        const claiming = kit.settle(claimNext(k.dispatchDeps(transport, { db: p.db as never })));
        const at = await p.reachedBefore(pause, claiming);
        expect(at.text).toMatch(CLAIM_BOT_RULE);

        // the claim is genuinely parked inside its transaction, holding exactly what the analysis says
        expect(await backendState(at.pid)).toBe("idle in transaction");
        const r = x.r.id as string;
        const account = x.f.w.account.id;
        expect(
          await probe("select 1 from outbound_requests where id = $1 for update nowait", r),
        ).toBe("55P03");
        expect(
          await probe("select 1 from whatsapp_accounts where id = $1 for update nowait", account),
        ).toBe("55P03"); // the claim's FOR SHARE conflicts with FOR UPDATE ...
        expect(
          await probe("select 1 from whatsapp_accounts where id = $1 for share nowait", account),
        ).toBe("free"); // ... but not with the submission's FOR SHARE
        expect(
          await probe(
            "select 1 from conversations where id = $1 for update nowait",
            x.f.w.student.conversation.id,
          ),
        ).toBe("free"); // the claim holds no conversation lock
        expect(await advisoryLocks(at.pid)).toBe(1); // the account's claimer lock
        expect(await k.request(r)).toMatchObject({ state: "QUEUED", claimed_by: null });

        // the real STAFF submission commits while the claim is parked; the claim waits on nothing
        const submission = kit.settle(staffAction(x.f, "submit"));
        expect(await kit.within(submission, 5_000), "the submission was blocked by the claim").toBe(
          true,
        );
        const sub = await submission;
        expect(sub.ok).toBe(true);
        seq = sub.ok ? sub.value : 0;
        expect(seq).toBeGreaterThan(Number(x.s.started_control_seq));
        expect(await kit.blockersOf(at.pid)).toEqual([]);
        expect(await backendState(at.pid)).toBe("idle in transaction");

        pause.release();
        const result = await claiming;
        expect(settledState(result)).toBeNull();
        expect(result).toMatchObject({ ok: true, value: { claim: null, held: 1 } });
        expect(pause.fired).toBe(1);
        // the bot-rule statement was sent exactly once, by the claim's backend, after the release
        expect(p.statements.filter((s) => CLAIM_BOT_RULE.test(s.text))).toEqual([
          { pid: at.pid, text: at.text },
        ]);
        expect(await k.request(r)).toMatchObject({
          state: "HELD",
          hold_reason: "staff_took_over",
          send_started_at: null,
        });
        expect(transport.calls).toHaveLength(0);
        expect(await k.inFlight(x.s.id as string)).toBe(0);
      } finally {
        await p.close();
      }
      await runtimeHandover(x, "submit", seq);
      // idempotent: a further dispatcher pass sends no BOT message (only the STAFF request may be claimed, and is set aside)
      const again = new FakeTransport();
      expect((await claimR(x, again)).claim).toBeNull();
      expect(again.calls).toHaveLength(0);
      expect(await k.request(x.r.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "staff_took_over",
      });
    });

    it("the pausing database's own guards: a pause that is never reached is a barrier failure; an unreleased pause fails the paused statement, the claim's transaction rolls back and every lock it held is released", async () => {
      const x = await world();
      const a = pausingDatabase(t);
      try {
        const never = a.arm(/^SELECT this_statement_is_never_sent$/);
        await expect(a.reachedBefore(never, a.db.execute(sql`select 1`))).rejects.toThrow(
          /barrier invalid/,
        );
        expect(never.fired).toBe(0);
      } finally {
        await a.close();
      }
      const b = pausingDatabase(t, { pauseLimitMs: 1_000 });
      try {
        const pause = b.arm(CLAIM_BOT_RULE);
        const transport = new FakeTransport();
        const claiming = kit.settle(claimNext(k.dispatchDeps(transport, { db: b.db as never })));
        const at = await b.reachedBefore(pause, claiming);
        // never released: the paused statement fails after the limit; the claim's transaction is rolled back
        const result = await claiming;
        expect(result.ok).toBe(false);
        // Drizzle wraps the driver error ("Failed query: ..."); the helper's own error is in the cause chain
        const chain: string[] = [];
        for (
          let e: unknown = (result as { error: unknown }).error, i = 0;
          e instanceof Error && i < 5;
          e = (e as { cause?: unknown }).cause, i++
        )
          chain.push(e.message);
        expect(chain.some((m) => /not released within 1000 ms/.test(m))).toBe(true);
        expect(b.statements.filter((s) => CLAIM_BOT_RULE.test(s.text))).toHaveLength(1);
        expect(await backendState(at.pid)).toBe("idle"); // back in the pool, no open transaction
        expect(
          await probe(
            "select 1 from outbound_requests where id = $1 for update nowait",
            x.r.id as string,
          ),
        ).toBe("free");
        expect(await advisoryLocks(at.pid)).toBe(0);
        expect(await k.request(x.r.id as string)).toMatchObject({
          state: "QUEUED",
          claimed_by: null,
          attempt_count: 0,
        });
        expect(transport.calls).toHaveLength(0);
      } finally {
        await b.close();
      }
    });

    it("NEGATIVE CONTROL (parked AFTER the bot-rule read, at the SENDING transition): the claim decided before the submission and claims R; the final authorization then refuses it staff_took_over (the B2 boundary); 0 BOT calls", async () => {
      const x = await world();
      const p = pausingDatabase(t);
      let seq = 0;
      try {
        const pause = p.arm(CLAIM_SENDING);
        const transport = new FakeTransport();
        const claiming = kit.settle(claimNext(k.dispatchDeps(transport, { db: p.db as never })));
        const at = await p.reachedBefore(pause, claiming);
        expect(at.text).toMatch(CLAIM_SENDING);
        // the bot rule was already read (before the submission existed)
        const ruleRead = p.statements.findIndex((s) => CLAIM_BOT_RULE.test(s.text));
        expect(ruleRead).toBeGreaterThanOrEqual(0);
        expect(ruleRead).toBeLessThan(p.statements.findIndex((s) => CLAIM_SENDING.test(s.text)));
        expect(
          await probe(
            "select 1 from outbound_requests where id = $1 for update nowait",
            x.r.id as string,
          ),
        ).toBe("55P03");
        const submission = kit.settle(staffAction(x.f, "submit"));
        expect(await kit.within(submission, 5_000)).toBe(true);
        const sub = await submission;
        seq = sub.ok ? sub.value : 0;
        pause.release();
        const result = await claiming;
        expect(result).toMatchObject({ ok: true });
        const claim = result.ok ? result.value.claim : null;
        expect(claim?.requestId).toBe(x.r.id); // DETECTED: parked after the rule, the staff fence came too late for the claim
        expect(pause.fired).toBe(1);
        expect(await executeClaim(k.dispatchDeps(transport), claim!)).toBe("held");
        expect(await k.request(x.r.id as string)).toMatchObject({
          state: "HELD",
          hold_reason: "staff_took_over",
        });
        expect(transport.calls).toHaveLength(0);
      } finally {
        await p.close();
      }
      await runtimeHandover(x, "submit", seq);
    });
  });

  it("a STAFF status change ends the session staff_status_changed; a resolution ends it COMPLETED conversation_resolved (its own path, not mislabelled)", async () => {
    for (const to of ["PENDING", "RESOLVED"] as const) {
      await t.pool.query("truncate organizations, webhook_requests cascade");
      const x = await world();
      const { changeConversationStatus } = await import("@/modules/inbox");
      await changeConversationStatus(
        x.f.w.staff.ctx,
        x.f.w.student.conversation.id,
        { to, expected: "OPEN" },
        { db: t.db as never },
      );
      const tr = await k.trigger(x.f, { body: "hello?" });
      expect(await k.run(tr.id)).toMatchObject({ status: "IGNORED", outcome: "session_ended" });
      const s = await k.session(x.s.id as string);
      if (to === "RESOLVED") {
        expect(s).toMatchObject({
          state: "COMPLETED",
          end_reason: "conversation_resolved",
          handover_reason: null,
          terminal_notice_step_seq: null,
        });
        expect(await k.events(x.s.id as string)).toEqual([]); // no HANDED_OVER event for a completion
      } else
        expect(s).toMatchObject({ state: "HANDED_OVER", handover_reason: "staff_status_changed" });
      expect(s.output_suppressed_at).toBeInstanceOf(Date);
      expect(await k.request(x.r.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "bot_output_suppressed",
      });
    }
  });

  it("precedence with several staff events: assignment beats a reply and a resolution; a reply beats a resolution", async () => {
    for (const [actions, reason] of [
      [["submit", "resolve", "assign"], "staff_assigned"],
      [["resolve_after_submit"], "staff_replied"],
    ] as const) {
      await t.pool.query("truncate organizations, webhook_requests cascade");
      const x = await world();
      const { changeConversationStatus } = await import("@/modules/inbox");
      for (const a of actions) {
        if (a === "submit" || a === "resolve_after_submit") await k.submit(x.f);
        if (a === "assign") await k.assign(x.f);
        if (a === "resolve" || a === "resolve_after_submit")
          await changeConversationStatus(
            x.f.w.staff.ctx,
            x.f.w.student.conversation.id,
            { to: "RESOLVED", expected: "OPEN" },
            { db: t.db as never },
          );
      }
      const tr = await k.trigger(x.f, { body: "hello?" });
      expect(await k.run(tr.id)).toMatchObject({ status: "IGNORED", outcome: "session_ended" });
      expect(await k.session(x.s.id as string)).toMatchObject({
        state: "HANDED_OVER",
        handover_reason: reason,
      });
    }
  });

  it("MUTATION (the dispatcher's committed staff fence bypassed in the disposable database): B1's zero-call check fails — one BOT call is made", async () => {
    const def = (
      await k.one("select pg_get_functiondef('bot_request_hold_code(uuid,uuid)'::regprocedure) d")
    ).d as string;
    expect(def.split("THEN 'staff_took_over'")).toHaveLength(2);
    try {
      await t.pool.query(def.replace("THEN 'staff_took_over'", "THEN NULL"));
      const x = await world();
      await staffAction(x.f, "assign");
      const transport = new FakeTransport().next(k.accepted("wamid.TEST08E5.MUT.B"));
      const { claim } = await claimR(x, transport);
      expect(claim?.requestId).toBe(x.r.id); // the fence no longer stops the claim ...
      expect(await executeClaim(k.dispatchDeps(transport), claim!)).toBe("accepted");
      expect(transport.calls).toHaveLength(1); // ... so the zero-BOT-call assertion of B1 would fail
    } finally {
      await t.pool.query(def); // restore the approved function
    }
    expect(
      (await k.one("select pg_get_functiondef('bot_request_hold_code(uuid,uuid)'::regprocedure) d"))
        .d,
    ).toBe(def);
  });
});
