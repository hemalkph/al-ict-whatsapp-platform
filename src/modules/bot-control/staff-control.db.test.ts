import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { changeConversationStatus } from "@/modules/inbox";
import { claimNext, executeClaim, type DispatchDeps } from "@/modules/messaging/dispatch";
import { submitOutboundMessage } from "@/modules/messaging/submit";
import { FakeTransport, ON, minutesAgo, textInput } from "@/modules/messaging/testing";
import { stopActiveSessions } from "./index";
import {
  BOTS_ON,
  barrierKit,
  dispatchWorld,
  insertSession,
  liveSessionFor,
  queueBotStep,
  settledState,
  textMessage,
  holdLeftoverQueued,
} from "./testing";

// Staff control sequences and lock order (Phase 08D, ADR 0020; V3.2 J.1, L.2) on disposable al_ict_test_* PostgreSQL. Staff
// submission now locks the conversation row FIRST; every staff request and conversation event gets a database-allocated
// control_seq; ordering is by control_seq (commit order), never by timestamps. Order is proved by lock ownership.

const T0 = new Date("2026-06-01T12:00:00Z");

describe("staff control sequences and lock order", () => {
  let t: TestDb;
  let kit: ReturnType<typeof barrierKit>;
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
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
    await holdLeftoverQueued(t);
    kit = barrierKit(t);
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    try {
      await kit.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  });
  afterAll(async () => t.close());

  const submit = (
    ctx: Parameters<typeof submitOutboundMessage>[0],
    conversationId: string,
    body = "hi",
  ) =>
    submitOutboundMessage(ctx, textInput(conversationId, body), {
      db: t.db as never,
      config: ON,
      now: () => T0,
    });
  it("staff submit and the Inbox status workflow, in both orders: no deadlock; control sequences follow commit order", async () => {
    for (const submitFirst of [true, false]) {
      const f = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
      const k = f.w.student.conversation.id;
      const inbox = () =>
        changeConversationStatus(
          f.w.staff.ctx,
          k,
          { to: "PENDING", expected: "OPEN" },
          { db: t.db as never },
        );
      // The first participant is parked on a gate row it takes only AFTER the conversation (so it provably holds it): the
      // submission waits for the account row; the Inbox workflow waits for its actor's membership (the event's foreign key).
      const gate = submitFirst
        ? await kit.hold("select id from whatsapp_accounts where id = $1 for update", [
            f.w.account.id,
          ])
        : await kit.hold("select id from organization_memberships where id = $1 for update", [
            f.w.staff.membershipId,
          ]);
      const first = kit.settle<unknown>(submitFirst ? submit(f.w.staff.ctx, k) : inbox());
      const firstPid = await kit.waitUntilBlocked(gate.pid);
      const second = kit.settle<unknown>(submitFirst ? inbox() : submit(f.w.staff.ctx, k));
      await kit.waitUntilBlocked(firstPid); // the second waits on the first's conversation lock
      await gate.release();
      const [a, b] = await Promise.all([first, second]);
      expect([settledState(a), settledState(b)]).toEqual([null, null]);
      expect(b.at).toBeGreaterThan(a.at);
      const request = Number(
        (await q("select control_seq from outbound_requests where conversation_id = $1", [k]))
          .rows[0].control_seq,
      );
      const event = Number(
        (await q("select control_seq from conversation_events where conversation_id = $1", [k]))
          .rows[0].control_seq,
      );
      expect(submitFirst ? request < event : event < request).toBe(true);
    }
  });

  it("the production staff submit takes the conversation lock FIRST: with a FOR UPDATE waiting behind it, it still completes (no upgrade)", async () => {
    const f = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
    const k = f.w.student.conversation.id;
    // park the submission AFTER its conversation lock (it waits for the account row)
    const account = await kit.hold("select id from whatsapp_accounts where id = $1 for update", [
      f.w.account.id,
    ]);
    const s = kit.settle(submit(f.w.staff.ctx, k));
    const sPid = await kit.waitUntilBlocked(account.pid);
    // the Inbox workflow's FOR UPDATE now waits behind the submission (it holds the row lock, not a KEY SHARE)
    const inbox = kit.settle(
      changeConversationStatus(
        f.w.staff.ctx,
        k,
        { to: "PENDING", expected: "OPEN" },
        { db: t.db as never },
      ),
    );
    await kit.waitUntilBlocked(sPid);
    await account.release();
    const [a, b] = await Promise.all([s, inbox]);
    expect([settledState(a), settledState(b)]).toEqual([null, null]);
    expect(b.at).toBeGreaterThan(a.at);
  });

  it("staff submit versus Stop, in both orders: no deadlock; the staff request is sequenced against the handover by commit order", async () => {
    for (const stopFirst of [true, false]) {
      const f = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
      const s = await liveSessionFor(t, f);
      const k = s.student.conversation.id;
      const stop = () =>
        stopActiveSessions(
          f.w.admin.ctx,
          { deploymentId: f.d.deployment.id, expectedLiveSessions: 1 },
          { db: t.db as never },
        );
      let first;
      let second;
      if (stopFirst) {
        // Stop parks holding the deployment and the conversation (it waits for the session row)
        const session = await kit.hold("select id from bot_sessions where id = $1 for update", [
          s.id,
        ]);
        first = kit.settle(stop());
        const stopPid = await kit.waitUntilBlocked(session.pid);
        second = kit.settle(submit(f.w.staff.ctx, k));
        await kit.waitUntilBlocked(stopPid); // the submission waits on Stop's conversation lock
        await session.release();
      } else {
        // the submission parks holding the conversation (it waits for the account row)
        const account = await kit.hold(
          "select id from whatsapp_accounts where id = $1 for update",
          [f.w.account.id],
        );
        first = kit.settle(submit(f.w.staff.ctx, k));
        const subPid = await kit.waitUntilBlocked(account.pid);
        second = kit.settle(stop());
        await kit.waitUntilBlocked(subPid); // Stop waits on the submission's conversation lock
        await account.release();
      }
      const [a, b] = await Promise.all([first, second]);
      expect([settledState(a), settledState(b)]).toEqual([null, null]);
      const handover = Number(
        (await q("select handover_control_seq from bot_sessions where id = $1", [s.id])).rows[0]
          .handover_control_seq,
      );
      const staffSeq = Number(
        (
          await q(
            "select control_seq from outbound_requests where conversation_id = $1 and origin = 'STAFF'",
            [k],
          )
        ).rows[0].control_seq,
      );
      expect(stopFirst ? handover < staffSeq : staffSeq < handover).toBe(true);
    }
  });

  it("staff submit versus the ACCEPTED record on the same conversation, in both orders: no deadlock, both commit", async () => {
    for (const submitFirst of [true, false]) {
      await holdLeftoverQueued(t); // the previous iteration's second submission must not be the row this claim takes
      const f = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
      const k = f.w.student.conversation.id;
      const queued = await submit(f.w.staff.ctx, k, "first");
      const transport = new FakeTransport().next({
        kind: "accepted",
        wamid: `wamid.L3.${submitFirst}`,
        providerStatus: "accepted",
        httpStatus: 200,
      });
      const deps: DispatchDeps = {
        db: t.db as never,
        transport,
        config: ON,
        now: () => T0,
        random: () => 0.5,
        accountMinIntervalMs: 0,
        conversationMinIntervalMs: 0,
      };
      const { claim } = await claimNext(deps);
      expect(claim?.requestId).toBe(queued.requestId);
      let first;
      let second;
      if (submitFirst) {
        const account = await kit.hold(
          "select id from whatsapp_accounts where id = $1 for update",
          [f.w.account.id],
        );
        first = kit.settle(submit(f.w.staff.ctx, k, "second"));
        const subPid = await kit.waitUntilBlocked(account.pid);
        second = kit.settle(executeClaim(deps, claim!));
        await kit.waitUntilBlocked(subPid); // the record waits for the conversation the submission holds
        await account.release();
      } else {
        const gate = await kit.hold("select id from conversations where id = $1 for update", [k]);
        first = kit.settle(executeClaim(deps, claim!));
        await kit.waitUntilBlocked(gate.pid);
        second = kit.settle(submit(f.w.staff.ctx, k, "second"));
        await gate.release();
      }
      const [a, b] = await Promise.all([first, second]);
      expect([settledState(a), settledState(b)]).toEqual([null, null]);
      expect(
        (await q("select state from outbound_requests where id = $1", [queued.requestId])).rows[0]
          .state,
      ).toBe("ACCEPTED");
      expect(transport.calls).toHaveLength(1);
    }
  });

  it("control_seq follows COMMIT order, not timestamps: a staff reply that started earlier but committed after a session start is a takeover", async () => {
    const f = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
    const k = f.w.student.conversation.id;
    // A bot-step-like transaction holds the conversation and starts a session (allocating started_control_seq).
    const step = await t.pool.connect();
    try {
      await step.query("begin");
      await step.query("select id from conversations where id = $1 for update", [k]);
      // the staff submission STARTS now (its transaction time, and so its created_at, is earlier than the session's)...
      const staff = kit.settle(submit(f.w.staff.ctx, k));
      const stepPid = (await step.query("select pg_backend_pid() pid")).rows[0].pid as number;
      await kit.waitUntilBlocked(stepPid);
      const session = await insertSession(step, {
        organizationId: f.w.org.id,
        botId: f.d.bot.id,
        versionId: f.d.version.id,
        deploymentId: f.d.deployment.id,
        whatsappAccountId: f.w.account.id,
        student: f.w.student,
      });
      await step.query("commit");
      const result = await staff;
      expect(result.ok).toBe(true);
      const staffRow = (
        await q(
          "select control_seq, created_at from outbound_requests where conversation_id = $1 and origin = 'STAFF'",
          [k],
        )
      ).rows[0];
      const sessionRow = (
        await q("select started_control_seq, started_at from bot_sessions where id = $1", [
          session.id,
        ])
      ).rows[0];
      expect(staffRow.created_at.getTime()).toBeLessThan(sessionRow.started_at.getTime()); // timestamps say "before"...
      expect(Number(staffRow.control_seq)).toBeGreaterThan(Number(sessionRow.started_control_seq)); // ...commit order says "after"
      // and the dispatch rule therefore treats it as a takeover of that session's output
      const live = { id: session.id as string, student: f.w.student, keys: {} as never };
      await expect(
        queueBotStep(t, f, live, { stepSeq: 1, message: textMessage(), now: T0, config: BOTS_ON }),
      ).rejects.toThrow(/staff_took_over/);
    } finally {
      await step.query("rollback").catch(() => undefined);
      step.release(true);
    }
  });

  it("a session start (allocation) versus the ACCEPTED record on the same conversation: no deadlock, both commit", async () => {
    const f = await dispatchWorld(t, { lastInboundAt: minutesAgo(30, T0) });
    const k = f.w.student.conversation.id;
    const queued = await submit(f.w.staff.ctx, k);
    const transport = new FakeTransport().next({
      kind: "accepted",
      wamid: "wamid.L3.8",
      providerStatus: "accepted",
      httpStatus: 200,
    });
    const deps: DispatchDeps = {
      db: t.db as never,
      transport,
      config: ON,
      now: () => T0,
      random: () => 0.5,
      accountMinIntervalMs: 0,
      conversationMinIntervalMs: 0,
    };
    const { claim } = await claimNext(deps);
    const step = await t.pool.connect();
    try {
      await step.query("begin");
      await step.query("select id from conversations where id = $1 for update", [k]);
      await insertSession(step, {
        organizationId: f.w.org.id,
        botId: f.d.bot.id,
        versionId: f.d.version.id,
        deploymentId: f.d.deployment.id,
        whatsappAccountId: f.w.account.id,
        student: f.w.student,
      });
      const stepPid = (await step.query("select pg_backend_pid() pid")).rows[0].pid as number;
      const record = kit.settle(executeClaim(deps, claim!));
      await kit.waitUntilBlocked(stepPid);
      await step.query("commit");
      expect(await record).toMatchObject({ ok: true, value: "accepted" });
      expect(
        (await q("select state from outbound_requests where id = $1", [queued.requestId])).rows[0]
          .state,
      ).toBe("ACCEPTED");
    } finally {
      await step.query("rollback").catch(() => undefined);
      step.release(true);
    }
  });
});
