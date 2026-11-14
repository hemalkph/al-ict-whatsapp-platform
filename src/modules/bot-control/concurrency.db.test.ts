import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, signalTestBackends, type TestDb } from "@/db/__tests__/helpers";
import { changeMemberRole, suspendMember } from "@/modules/access";
import { changeConversationStatus } from "@/modules/inbox";
import { addActor } from "@/modules/messaging/testing";
import { minimalFlow } from "@/modules/bots/testing";
import { ForbiddenError } from "@/shared/errors/http-errors";
import { logger } from "@/shared/logging/logger";
import {
  activateDeployment,
  changeDeploymentVersion,
  createBot,
  pauseDeployment,
  publishVersion,
  stopActiveSessions,
  updateDraft,
} from "./index";
import { botWorld, deployedBot, insertSession, publishedBot, type BotWorld } from "./testing";

// Concurrency on a disposable al_ict_test_* database (Phase 08C, ADR 0019).
//
// ORDER is made by real locks and proved by lock OWNERSHIP, never by counting waiters or by sleeps: the test holds a row,
// finds the backend blocked by ITS pid (pg_blocking_pids), and then requires the competing statement to be blocked by THAT
// backend's pid. For two operations that contend for one row, the first is parked on a "gate" row it only takes AFTER the
// contended one (so it provably owns the contended row), and the second is then shown to wait on the first transaction itself.
// The committed order (settle timestamps), the committed rows, the deployment/session events and the audit lines are asserted.
//
//  1. Authorization versus revocation, for publish, activate AND Stop, in both orders. Revocation first: the bot write waits
//     on the revocation's transaction, then is refused and leaves no row, event or audit line. Bot write first: the revocation
//     waits on the write's transaction, and the write's rows, events and audit line are all there.
//  2. Lock order (L.2): Stop paired with publish, pause, version change, a session ending and the Inbox status workflow, in
//     BOTH orders, with no deadlock (40P01) and the committed state each order implies.
//
// Cleanup is bounded and server-enforced. The test pool's sessions carry PostgreSQL lock, statement and idle-in-transaction
// timeouts. Every held transaction and started operation is registered; afterEach rolls back what is still held (destroying a
// connection whose rollback fails or hangs), waits a bounded time for the operations, and if any is still running cancels
// (then terminates) its backend on the server and FAILS the test. The last describe block proves each of these paths.

const DEADLOCK = "40P01";
const QUERY_CANCELED = "57014";
const DELIBERATE = "DELIBERATE_CLEANUP_FAILURE";

describe("bot-control concurrency", () => {
  let t: TestDb;
  const deps = () => ({ db: t.db });
  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await t.pool.query(sql, params)).rows[0] as T;

  // ---- registries and bounded cleanup ----

  const held: { abort(): Promise<void> }[] = [];
  const running: Promise<unknown>[] = [];

  const settle = <T>(p: Promise<T>) => {
    const s = p.then(
      (value) => ({ ok: true as const, value, at: process.hrtime.bigint() }),
      (error: unknown) => ({ ok: false as const, error, at: process.hrtime.bigint() }),
    );
    running.push(s);
    return s;
  };
  type Settled = Awaited<ReturnType<typeof settle>>;
  const sqlState = (r: Settled) =>
    r.ok
      ? null
      : ((r.error as { code?: string; cause?: { code?: string } }).cause?.code ??
        (r.error as { code?: string }).code ??
        null);
  const codeOf = (r: Settled) => (r.ok ? null : ((r.error as { code?: string }).code ?? null));

  /** true if `p` settled within `ms` (the timer never outlives the call). */
  async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Opens a transaction holding `sql`'s locks. release() commits; afterEach rolls back whatever was never released. */
  async function hold(sql: string, params: unknown[]) {
    const c = await t.pool.connect();
    const ignore = () => undefined; // a server-ended session surfaces through the next query; never an unhandled 'error'
    c.on("error", ignore);
    let done = false;
    const finish = async (statement: "commit" | "rollback") => {
      if (done) return;
      done = true;
      c.off("error", ignore);
      try {
        const query = c.query(statement);
        if (await within(query, 5_000)) {
          await query;
          c.release();
        } else c.release(new Error(`${statement} did not return; connection destroyed`));
      } catch (error) {
        c.release(error as Error); // a broken connection is destroyed, never returned to the pool
        if (statement === "commit") throw error;
      }
    };
    const h = {
      pid: 0,
      release: () => finish("commit"),
      /** Never throws: a rollback that fails or hangs destroys the connection, which ends the transaction on the server. */
      abort: () => finish("rollback"),
    };
    held.push(h);
    await c.query("begin");
    h.pid = ((await c.query("select pg_backend_pid() pid")).rows[0] as { pid: number }).pid;
    await c.query(sql, params);
    return h;
  }

  /**
   * Rolls back every transaction still held, then waits (bounded) for every started operation. If one is still running, it
   * is blocked by something the test does not own: its SQL is cancelled on the server (then its backend terminated), and
   * cleanup throws so the test fails instead of passing or hanging.
   */
  async function cleanup({ settleMs = 10_000, graceMs = 5_000 } = {}) {
    for (const h of held.splice(0)) await h.abort();
    const pending = Promise.all(running.splice(0));
    if (await within(pending, settleMs)) return;
    const cancelled = await signalTestBackends(t.target, "cancel");
    if (await within(pending, graceMs))
      throw new Error(
        `cleanup cancelled ${cancelled} statement(s) still running after the test's locks were released`,
      );
    const terminated = await signalTestBackends(t.target, "terminate");
    const gone = await within(pending, graceMs);
    throw new Error(
      `cleanup terminated ${terminated} session(s) that ignored cancellation${gone ? "" : "; operations still unsettled"}`,
    );
  }

  /** The pid of the backend blocked by backend `by` (bounded; throws if none appears). */
  async function waitUntilBlocked(by: number, ms = 10_000): Promise<number> {
    const deadline = Date.now() + ms;
    for (;;) {
      const r = await t.pool.query(
        "select pid from pg_stat_activity where datname = current_database() and $1 = any(pg_blocking_pids(pid)) order by pid",
        [by],
      );
      if (r.rows.length > 0) return (r.rows[0] as { pid: number }).pid;
      if (Date.now() > deadline)
        throw new Error(`no statement became blocked by backend ${by} within ${ms} ms`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  let info: ReturnType<typeof vi.spyOn>;
  /** The bot-management audit actions logged since the last clear. */
  const audited = () =>
    (info.mock.calls as unknown[][])
      .filter(([message]) => message === "bots.admin_action")
      .map(([, fields]) => (fields as { action: string }).action);

  beforeAll(async () => {
    t = await createTestDatabase({
      // Server-side bounds for every session of this file (testTimeout is 30 s): no lock wait, statement or abandoned
      // transaction can outlive a failed test by much, whether or not anything still awaits it.
      sessionTimeouts: {
        lock_timeout: 15_000,
        statement_timeout: 20_000,
        idle_in_transaction_session_timeout: 25_000,
      },
    });
  });
  beforeEach(() => {
    info = vi.spyOn(logger, "info");
  });
  afterEach(async () => {
    try {
      await cleanup();
    } finally {
      info.mockRestore();
    }
  });
  afterAll(async () => t.close());

  /** Deploys a bot on the world's account with one live session on the world's student. */
  async function liveDeployment(w: BotWorld, priority: number) {
    const d = await deployedBot(t.db, w, priority);
    const session = await insertSession(t.pool, {
      organizationId: w.org.id,
      botId: d.bot.id,
      versionId: d.version.id,
      deploymentId: d.deployment.id,
      whatsappAccountId: w.account.id,
      student: w.student,
    });
    return { ...d, session };
  }

  describe("authorization versus revocation", () => {
    /**
     * A world whose bot writer is an ADMIN that a second ADMIN (the manager) can suspend or demote: a published bot with a
     * newer draft (publish, activate) and another bot deployed at priority 2 with one live session (Stop).
     */
    async function setup() {
      const w = await botWorld(t.db);
      const manager = await addActor(t.db, w.org.id, "ADMIN");
      const { bot, version } = await publishedBot(t.db, w);
      await updateDraft(
        w.admin.ctx,
        { botId: bot.id, expectedRevision: 1, config: { ...minimalFlow(), name: "v2" } },
        deps(),
      );
      const live = await liveDeployment(w, 2);
      info.mockClear();
      return { w, manager, bot, version, live };
    }
    type Setup = Awaited<ReturnType<typeof setup>>;
    type Effects = {
      versions: number;
      deployments: number;
      deploymentEvents: number;
      sessionEvents: number;
      sessionState: string;
      stopTarget: string;
    };
    const effects = (s: Setup) =>
      one<Effects>(
        `select
          (select count(*)::int from bot_versions where bot_id = $1) versions,
          (select count(*)::int from bot_deployments where bot_id = $1) deployments,
          (select count(*)::int from bot_deployment_events where organization_id = $2) "deploymentEvents",
          (select count(*)::int from bot_session_events where organization_id = $2) "sessionEvents",
          (select state from bot_sessions where id = $3) "sessionState",
          (select status || '/' || send_epoch from bot_deployments where id = $4) "stopTarget"`,
        [s.bot.id, s.w.org.id, s.live.session.id, s.live.deployment.id],
      );

    const operations: Record<
      string,
      {
        action: string;
        /** The domain row the write locks after authorization: holding it parks the write there. */
        domainRow: (s: Setup) => [string, string];
        run: (s: Setup) => Promise<unknown>;
        applied: (before: Effects) => Effects;
      }
    > = {
      publish: {
        action: "bot.version_published",
        domainRow: (s) => ["bots", s.bot.id],
        run: (s) => publishVersion(s.w.admin.ctx, { botId: s.bot.id, expectedRevision: 2 }, deps()),
        applied: (b) => ({ ...b, versions: b.versions + 1 }),
      },
      activate: {
        action: "bot.deployment_activated",
        domainRow: (s) => ["bots", s.bot.id],
        run: (s) =>
          activateDeployment(
            s.w.admin.ctx,
            {
              botId: s.bot.id,
              versionId: s.version.id,
              whatsappAccountId: s.w.account.id,
              priority: 1,
            },
            deps(),
          ),
        applied: (b) => ({
          ...b,
          deployments: b.deployments + 1,
          deploymentEvents: b.deploymentEvents + 1,
        }),
      },
      stop: {
        action: "bot.sessions_stopped",
        domainRow: (s) => ["bot_deployments", s.live.deployment.id],
        run: (s) =>
          stopActiveSessions(
            s.w.admin.ctx,
            { deploymentId: s.live.deployment.id, expectedLiveSessions: 1 },
            deps(),
          ),
        applied: (b) => ({
          ...b,
          deploymentEvents: b.deploymentEvents + 1,
          sessionEvents: b.sessionEvents + 1,
          sessionState: "HANDED_OVER",
          stopTarget: "PAUSED/2",
        }),
      },
    };
    const revocations: Record<string, (s: Setup) => Promise<unknown>> = {
      suspend: (s) =>
        suspendMember(s.manager.ctx, { membershipId: s.w.admin.membershipId }, deps()),
      demote: (s) =>
        changeMemberRole(
          s.manager.ctx,
          { membershipId: s.w.admin.membershipId, role: "STAFF" },
          deps(),
        ),
    };
    const revoked = async (s: Setup) => {
      const m = await one<{ status: string; role: string }>(
        "select status, role from organization_memberships where id = $1",
        [s.w.admin.membershipId],
      );
      return m.status === "SUSPENDED" || m.role === "STAFF";
    };

    for (const [opName, op] of Object.entries(operations))
      for (const [revName, revoke] of Object.entries(revocations)) {
        it(`${revName} first: ${opName} waits on the revocation's transaction, then is refused and leaves nothing`, async () => {
          const s = await setup();
          const before = await effects(s);
          // Hold the actor's membership row: the revocation locks the organization FOR UPDATE, then is parked here.
          const membership = await hold(
            "select id from organization_memberships where id = $1 for update",
            [s.w.admin.membershipId],
          );
          const revocation = settle(revoke(s));
          const revocationPid = await waitUntilBlocked(membership.pid);
          const write = settle(op.run(s));
          await waitUntilBlocked(revocationPid); // the write waits on the revocation itself (organization KEY SHARE)
          await membership.release();
          const [r, b] = await Promise.all([revocation, write]);
          expect([sqlState(r), sqlState(b)]).not.toContain(DEADLOCK);
          expect(r.ok).toBe(true);
          expect(b.ok).toBe(false);
          expect((b as { error: unknown }).error).toBeInstanceOf(ForbiddenError);
          expect(b.at).toBeGreaterThan(r.at);
          expect(await revoked(s)).toBe(true);
          expect(await effects(s)).toEqual(before);
          expect(audited()).toEqual([]);
        });

        it(`${opName} first: ${revName} waits on the bot write's transaction until it has committed`, async () => {
          const s = await setup();
          const before = await effects(s);
          // Hold the write's domain row: the write takes its organization and membership locks, validates, then is parked here.
          const [table, id] = op.domainRow(s);
          const domain = await hold(`select id from ${table} where id = $1 for update`, [id]);
          const write = settle(op.run(s));
          const writePid = await waitUntilBlocked(domain.pid);
          const revocation = settle(revoke(s));
          await waitUntilBlocked(writePid); // organization FOR UPDATE waits on the write's KEY SHARE
          await domain.release();
          const [b, r] = await Promise.all([write, revocation]);
          expect([sqlState(r), sqlState(b)]).not.toContain(DEADLOCK);
          expect(b.ok).toBe(true);
          expect(r.ok).toBe(true);
          expect(r.at).toBeGreaterThan(b.at);
          expect(await revoked(s)).toBe(true);
          expect(await effects(s)).toEqual(op.applied(before));
          expect(audited()).toEqual([op.action]);
        });
      }
  });

  it("two bot writes of one organization do not serialize on the authorization locks", async () => {
    const w = await botWorld(t.db);
    const a = await publishedBot(t.db, w);
    const b = await publishedBot(t.db, w);
    const v2 = { ...minimalFlow(), name: "v2" };
    // Hold bot A: a write on A is parked there; a write on bot B, holding the same organization and actor locks, completes.
    const botA = await hold("select id from bots where id = $1 for update", [a.bot.id]);
    const writeA = settle(
      updateDraft(w.admin.ctx, { botId: a.bot.id, expectedRevision: 1, config: v2 }, deps()),
    );
    await waitUntilBlocked(botA.pid);
    const writeB = await settle(
      updateDraft(w.admin.ctx, { botId: b.bot.id, expectedRevision: 1, config: v2 }, deps()),
    );
    expect(writeB).toMatchObject({ ok: true, value: { value: { draftRevision: 2 } } });
    await botA.release();
    const settledA = await writeA;
    expect(settledA).toMatchObject({ ok: true, value: { value: { draftRevision: 2 } } });
    expect(settledA.at).toBeGreaterThan(writeB.at);
  });

  describe("Stop against the other writers (L.2 lock order), in both orders", () => {
    async function stopWorld() {
      const w = await botWorld(t.db);
      const d = await liveDeployment(w, 1);
      const stop = () =>
        stopActiveSessions(
          w.admin.ctx,
          { deploymentId: d.deployment.id, expectedLiveSessions: 1 },
          deps(),
        );
      const state = () =>
        one<{
          status: string;
          epoch: number;
          versionId: string;
          session: string;
          events: string[];
          sessionEvents: number;
        }>(
          `select d.status, d.send_epoch::int epoch, d.version_id "versionId",
             (select state from bot_sessions where id = $2) session,
             (select coalesce(array_agg(kind order by created_at, id), '{}') from bot_deployment_events where deployment_id = $1) events,
             (select count(*)::int from bot_session_events where session_id = $2) "sessionEvents"
           from bot_deployments d where d.id = $1`,
          [d.deployment.id, d.session.id],
        );
      info.mockClear();
      return { w, d, stop, state };
    }
    type Lock = { sql: string; params: unknown[] };
    const row = (table: string, id: unknown): Lock => ({
      sql: `select id from ${table} where id = $1 for update`,
      params: [id],
    });

    /**
     * `first` and `second` contend for one row. `gate` is a row `first` locks only AFTER the contended one, so once `first`
     * is blocked by the gate's holder it provably owns the contended row. `second` is then required to be blocked by
     * `first`'s own backend. Releasing the gate lets `first` commit, then `second` proceed. Returns [first, second].
     */
    async function ordered(
      gate: Lock,
      first: () => Promise<unknown>,
      second: () => Promise<unknown>,
    ) {
      const g = await hold(gate.sql, gate.params);
      const a = settle(first());
      const firstPid = await waitUntilBlocked(g.pid);
      const b = settle(second());
      await waitUntilBlocked(firstPid);
      await g.release();
      const results = await Promise.all([a, b]);
      expect(results.map(sqlState)).not.toContain(DEADLOCK);
      expect(results[1].at).toBeGreaterThan(results[0].at);
      return results;
    }

    /**
     * `first` is parked on `lock`; `second` does not need it and must settle while `first` still waits. Returns [first,
     * second].
     */
    async function independent(
      lock: Lock,
      first: () => Promise<unknown>,
      second: () => Promise<unknown>,
    ) {
      const h = await hold(lock.sql, lock.params);
      const a = settle(first());
      await waitUntilBlocked(h.pid);
      const b = await settle(second());
      await waitUntilBlocked(h.pid); // first is still parked after second finished
      await h.release();
      const results = [await a, b] as const;
      expect(results.map(sqlState)).not.toContain(DEADLOCK);
      expect(results[0].at).toBeGreaterThan(results[1].at);
      return results;
    }

    async function withDraftV2(w: BotWorld, botId: string) {
      await updateDraft(
        w.admin.ctx,
        { botId, expectedRevision: 1, config: { ...minimalFlow(), name: "v2" } },
        deps(),
      );
      info.mockClear();
    }

    it("Stop parked on the deployment; publish of the same bot does not need it and commits first; then Stop commits", async () => {
      const { w, d, stop, state } = await stopWorld();
      await withDraftV2(w, d.bot.id);
      const publish = () =>
        publishVersion(w.admin.ctx, { botId: d.bot.id, expectedRevision: 2 }, deps());
      const [s, p] = await independent(row("bot_deployments", d.deployment.id), stop, publish);
      expect([s.ok, p.ok]).toEqual([true, true]);
      expect(await state()).toMatchObject({
        status: "PAUSED",
        epoch: 2,
        session: "HANDED_OVER",
        events: ["ACTIVATED", "SESSIONS_STOPPED"],
        sessionEvents: 1,
      });
      expect(
        await one("select count(*)::int n from bot_versions where bot_id = $1", [d.bot.id]),
      ).toEqual({ n: 2 });
      expect(audited()).toEqual(["bot.version_published", "bot.sessions_stopped"]);
    });

    it("publish parked on the bot row; Stop does not need it and commits first; then publish commits", async () => {
      const { w, d, stop, state } = await stopWorld();
      await withDraftV2(w, d.bot.id);
      const publish = () =>
        publishVersion(w.admin.ctx, { botId: d.bot.id, expectedRevision: 2 }, deps());
      const [p, s] = await independent(row("bots", d.bot.id), publish, stop);
      expect([p.ok, s.ok]).toEqual([true, true]);
      expect(await state()).toMatchObject({
        status: "PAUSED",
        epoch: 2,
        session: "HANDED_OVER",
        events: ["ACTIVATED", "SESSIONS_STOPPED"],
      });
      expect(
        await one("select count(*)::int n from bot_versions where bot_id = $1", [d.bot.id]),
      ).toEqual({ n: 2 });
      expect(audited()).toEqual(["bot.sessions_stopped", "bot.version_published"]);
    });

    it("Stop owns the deployment first (gate: the conversation); pause waits on Stop, then finds PAUSED and is refused", async () => {
      const { w, d, stop, state } = await stopWorld();
      const pause = () => pauseDeployment(w.admin.ctx, { deploymentId: d.deployment.id }, deps());
      const [s, p] = await ordered(row("conversations", w.student.conversation.id), stop, pause);
      expect(s).toMatchObject({ ok: true, value: { value: { sessionsStopped: 1 } } });
      expect(codeOf(p)).toBe("INVALID_TRANSITION");
      expect(await state()).toMatchObject({
        status: "PAUSED",
        epoch: 2,
        session: "HANDED_OVER",
        events: ["ACTIVATED", "SESSIONS_STOPPED"],
        sessionEvents: 1,
      });
      expect(audited()).toEqual(["bot.sessions_stopped"]);
    });

    it("pause owns the deployment first (gate: its version row, taken by the event's foreign key); Stop waits on pause, then stops the session", async () => {
      const { w, d, stop, state } = await stopWorld();
      const pause = () => pauseDeployment(w.admin.ctx, { deploymentId: d.deployment.id }, deps());
      const [p, s] = await ordered(row("bot_versions", d.version.id), pause, stop);
      expect(p.ok).toBe(true);
      expect(s).toMatchObject({ ok: true, value: { value: { sessionsStopped: 1 } } });
      expect(await state()).toMatchObject({
        status: "PAUSED",
        epoch: 2,
        session: "HANDED_OVER",
        events: ["ACTIVATED", "PAUSED", "SESSIONS_STOPPED"],
        sessionEvents: 1,
      });
      expect(audited()).toEqual(["bot.deployment_paused", "bot.sessions_stopped"]);
    });

    for (const stopFirst of [true, false])
      it(
        stopFirst
          ? "Stop owns the deployment first (gate: the conversation); the version change waits on Stop; both commit"
          : "the version change owns the deployment first (gate: the new version row, taken by its foreign key); Stop waits on it; both commit",
        async () => {
          const { w, d, stop, state } = await stopWorld();
          await withDraftV2(w, d.bot.id);
          const v2 = (
            await publishVersion(w.admin.ctx, { botId: d.bot.id, expectedRevision: 2 }, deps())
          ).value;
          info.mockClear();
          const change = () =>
            changeDeploymentVersion(
              w.admin.ctx,
              { deploymentId: d.deployment.id, versionId: v2.id },
              deps(),
            );
          const [x, y] = stopFirst
            ? await ordered(row("conversations", w.student.conversation.id), stop, change)
            : await ordered(row("bot_versions", v2.id), change, stop);
          expect([x.ok, y.ok]).toEqual([true, true]);
          expect(await state()).toMatchObject({
            status: "PAUSED",
            epoch: 2, // the version change keeps the epoch; only Stop bumped it
            versionId: v2.id,
            session: "HANDED_OVER",
            sessionEvents: 1,
            events: stopFirst
              ? ["ACTIVATED", "SESSIONS_STOPPED", "VERSION_CHANGED"]
              : ["ACTIVATED", "VERSION_CHANGED", "SESSIONS_STOPPED"],
          });
          expect(audited()).toEqual(
            stopFirst
              ? ["bot.sessions_stopped", "bot.deployment_version_changed"]
              : ["bot.deployment_version_changed", "bot.sessions_stopped"],
          );
        },
      );

    /** A raw session ending (conversation, then session; the L.2 order of the future runtime). */
    const rawEnding = (w: BotWorld, sessionId: string) => async () => {
      const c = await t.pool.connect();
      try {
        await c.query("begin");
        await c.query("select id from conversations where id = $1 for update", [
          w.student.conversation.id,
        ]);
        await c.query("select id from bot_sessions where id = $1 for update", [sessionId]);
        const r = await c.query(
          "update bot_sessions set state = 'COMPLETED', end_reason = 'idle_timeout', revision = revision + 1 where id = $1 and state = 'WAITING_FOR_INPUT'",
          [sessionId],
        );
        await c.query("commit");
        return r.rowCount;
      } catch (e) {
        await c.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        c.release(true); // destroyed, so a failed rollback can never return an open transaction to the pool
      }
    };

    it("a raw session ending owns the conversation first (gate: the session row); Stop waits on it, then stops nothing", async () => {
      const { w, d, stop, state } = await stopWorld();
      const [h, s] = await ordered(
        row("bot_sessions", d.session.id),
        rawEnding(w, d.session.id as string),
        stop,
      );
      expect(h).toMatchObject({ ok: true, value: 1 });
      expect(s).toMatchObject({ ok: true, value: { value: { sessionsStopped: 0 } } });
      expect(await state()).toMatchObject({
        status: "PAUSED",
        epoch: 2,
        session: "COMPLETED",
        events: ["ACTIVATED", "SESSIONS_STOPPED"],
        sessionEvents: 0,
      });
      expect(audited()).toEqual(["bot.sessions_stopped"]);
    });

    it("Stop owns the conversation first (gate: the session row); the raw ending waits on Stop, then finds the session no longer live", async () => {
      const { w, d, stop, state } = await stopWorld();
      const [s, h] = await ordered(
        row("bot_sessions", d.session.id),
        stop,
        rawEnding(w, d.session.id as string),
      );
      expect(s).toMatchObject({ ok: true, value: { value: { sessionsStopped: 1 } } });
      expect(h).toMatchObject({ ok: true, value: 0 });
      expect(await state()).toMatchObject({
        status: "PAUSED",
        epoch: 2,
        session: "HANDED_OVER",
        events: ["ACTIVATED", "SESSIONS_STOPPED"],
        sessionEvents: 1,
      });
    });

    for (const stopFirst of [true, false])
      it(
        stopFirst
          ? "Stop owns the conversation first (gate: the session row); the Inbox status change waits on Stop; both commit"
          : "the Inbox status change owns the conversation first (gate: its actor's membership, taken by the event's foreign key); Stop waits on it; both commit",
        async () => {
          const { w, d, stop, state } = await stopWorld();
          const staff = await addActor(t.db, w.org.id, "STAFF");
          const inbox = () =>
            changeConversationStatus(
              staff.ctx,
              w.student.conversation.id,
              { to: "PENDING", expected: "OPEN" },
              deps(),
            );
          const [x, y] = stopFirst
            ? await ordered(row("bot_sessions", d.session.id), stop, inbox)
            : await ordered(row("organization_memberships", staff.membershipId), inbox, stop);
          expect([x.ok, y.ok]).toEqual([true, true]);
          expect(await state()).toMatchObject({
            status: "PAUSED",
            epoch: 2,
            session: "HANDED_OVER",
            events: ["ACTIVATED", "SESSIONS_STOPPED"],
            sessionEvents: 1,
          });
          expect(
            await one(
              `select c.status, s.handover_control_seq is not null h,
                 (select count(*)::int from conversation_events e where e.conversation_id = c.id and e.kind = 'STATUS') "statusEvents"
               from conversations c join bot_sessions s on s.conversation_id = c.id where c.id = $1`,
              [w.student.conversation.id],
            ),
          ).toEqual({ status: "PENDING", h: true, statusEvents: 1 });
          expect(audited()).toEqual(["bot.sessions_stopped"]);
        },
      );

    it("creating a bot while a Stop runs in the same organization: both complete", async () => {
      const { w, stop, state } = await stopWorld();
      const [s, c] = await Promise.all([
        settle(stop()),
        settle(createBot(w.admin.ctx, { key: "parallel", name: "P" }, deps())),
      ]);
      expect([s.ok, c.ok]).toEqual([true, true]);
      expect(await state()).toMatchObject({ status: "PAUSED", session: "HANDED_OVER" });
      expect([...audited()].sort()).toEqual(["bot.created", "bot.sessions_stopped"]);
    });
  });

  describe("cleanup after a failure", () => {
    /**
     * Holds a bot row with a draft write queued behind it, passes `barrier`, marks the deliberate failure point as reached and
     * fails a real assertion tagged DELIBERATE. Whatever happens, the outcome is captured, never thrown.
     */
    async function failWhileHolding(barrier: (holderPid: number) => Promise<unknown>) {
      const w = await botWorld(t.db);
      const { bot } = await publishedBot(t.db, w);
      const progress = { reached: false };
      let queued: Promise<Settled> | undefined;
      const failure = await (async () => {
        const h = await hold("select id from bots where id = $1 for update", [bot.id]);
        queued = settle(
          updateDraft(
            w.admin.ctx,
            { botId: bot.id, expectedRevision: 1, config: { ...minimalFlow(), name: "v2" } },
            deps(),
          ),
        );
        await barrier(h.pid);
        progress.reached = true;
        expect("lock held", DELIBERATE).toBe("lock released"); // the deliberate failure: nothing is released before it
      })().then(
        () => undefined,
        (error: unknown) => error,
      );
      return { failure, reached: progress.reached, queued };
    }

    /** Throws unless `failure` is exactly the deliberate assertion failure AND its failure point was reached. */
    function assertDeliberate(failure: unknown, reached: boolean): void {
      if (!reached)
        throw new Error("the deliberate failure point was not reached", { cause: failure });
      const e = failure as { name?: unknown; message?: unknown } | undefined;
      if (
        !(failure instanceof Error) ||
        e?.name !== "AssertionError" ||
        typeof e.message !== "string" ||
        !e.message.includes(DELIBERATE)
      )
        throw new Error("the failure is not the deliberate assertion failure", { cause: failure });
    }

    async function expectNothingLeft() {
      expect(
        await one(
          `select count(*)::int n from pg_stat_activity
           where datname = current_database() and pid <> pg_backend_pid()
             and (wait_event_type = 'Lock' or state like 'idle in transaction%')`,
        ),
      ).toEqual({ n: 0 });
      expect(t.pool.waitingCount).toBe(0);
      expect(t.pool.idleCount).toBe(t.pool.totalCount); // every client returned (or destroyed)
    }

    it("a deliberately failed assertion while a lock is held: exactly that failure, then cleanup releases everything", async () => {
      const { failure, reached, queued } = await failWhileHolding((pid) => waitUntilBlocked(pid));
      assertDeliberate(failure, reached);
      expect(held).toHaveLength(1); // nothing was released by the failing code
      await cleanup();
      expect((await queued!).ok).toBe(true); // the queued writer was released by the rollback, not left hanging
      await expectNothingLeft();
    });

    it("if waitUntilBlocked() fails unexpectedly, the regression does NOT report success (and cleanup still runs)", async () => {
      // No backend is ever blocked by this pid (the test's own session), so the barrier fails after its deadline.
      const { failure, reached } = await failWhileHolding(() =>
        waitUntilBlocked(-1, 200).then(() => {
          throw new Error("unreachable: barrier unexpectedly passed");
        }),
      );
      expect(reached).toBe(false);
      expect(String((failure as Error).message)).toMatch(/no statement became blocked/);
      expect(() => assertDeliberate(failure, reached)).toThrow(
        /deliberate failure point was not reached/,
      );
      // A different assertion failure after the barrier is refused too.
      const other = Object.assign(new Error("expected 1 to be 2"), { name: "AssertionError" });
      expect(() => assertDeliberate(other, true)).toThrow(/not the deliberate assertion failure/);
      await cleanup();
      await expectNothingLeft();
    });

    it("cleanup is bounded: an operation blocked by a lock cleanup does not own is cancelled on the server, and cleanup fails", async () => {
      const w = await botWorld(t.db);
      const { bot } = await publishedBot(t.db, w);
      // A transaction the registries do not know about (as if leaked): cleanup cannot roll it back.
      const leaked = await t.pool.connect();
      try {
        await leaked.query("begin");
        const leakedPid = (
          (await leaked.query("select pg_backend_pid() pid")).rows[0] as { pid: number }
        ).pid;
        await leaked.query("select id from bots where id = $1 for update", [bot.id]);
        const stuck = settle(
          updateDraft(
            w.admin.ctx,
            { botId: bot.id, expectedRevision: 1, config: { ...minimalFlow(), name: "v2" } },
            deps(),
          ),
        );
        await waitUntilBlocked(leakedPid);
        await expect(cleanup({ settleMs: 200, graceMs: 5_000 })).rejects.toThrow(
          /cleanup cancelled 1 statement/,
        );
        const r = await stuck;
        expect(sqlState(r)).toBe(QUERY_CANCELED); // the SQL itself was cancelled, not merely abandoned
      } finally {
        await leaked.query("rollback").catch(() => undefined);
        leaked.release(true);
      }
      expect(await one("select draft_revision r from bots where id = $1", [bot.id])).toEqual({
        r: 1,
      });
      await expectNothingLeft();
    });

    it("the session timeouts are in force on every test-pool session", async () => {
      expect(
        await one(
          "select current_setting('lock_timeout') l, current_setting('statement_timeout') s, current_setting('idle_in_transaction_session_timeout') i",
        ),
      ).toEqual({ l: "15s", s: "20s", i: "25s" });
    });
  });
});
