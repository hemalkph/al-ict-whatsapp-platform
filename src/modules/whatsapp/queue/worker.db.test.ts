import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { claimWebhookEventRows } from "@/db/ops/webhook-queue";
import {
  completeWebhookEvent,
  deadWebhookEvent,
  failWebhookEvent,
  holdWebhookEvent,
} from "@/db/ops/webhook-queue";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { PermanentWebhookError } from "./errors";
import { MAX_ATTEMPTS } from "./policy";
import {
  processClaimedEvent,
  processWebhookBatch,
  type ProcessBatchOptions,
  type ProcessDeps,
  type WebhookHandler,
  type WebhookHandlerRegistry,
} from "./process";
import {
  FIXED_NOW,
  FIXTURE_DDL,
  FIXTURE_DEFERRED_DDL,
  deferred,
  expireLeases,
  getEvent,
  insertEvent,
  lockOwners,
  makeFailedDue,
  pending,
  seeded,
  until,
  world,
} from "./testing";

// The worker core against REAL PostgreSQL with fake handlers only. A fake domain table (queue_fixture_notes) stands in
// for future contact/message writes; no domain handler exists in this checkpoint.

describe("webhook worker core", () => {
  let t: TestDb;
  let owners: () => string;
  const logs: string[] = [];
  // Every gate a test creates is opened again in afterEach, so a failing assertion cannot leave a handler (and its open
  // transaction) blocked for the tests that follow.
  const gates: Array<() => void> = [];
  const newGate = () => {
    const d = deferred();
    gates.push(d.resolve);
    return d;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    await t.pool.query(FIXTURE_DDL);
    for (const ddl of FIXTURE_DEFERRED_DDL) await t.pool.query(ddl);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    owners = lockOwners();
    logs.length = 0;
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((line: unknown) => void logs.push(String(line)));
    }
    await t.pool.query(
      "truncate webhook_events, webhook_requests, whatsapp_accounts, organizations, queue_fixture_notes, queue_fixture_parents cascade",
    );
  });
  afterEach(async () => {
    gates.splice(0).forEach((open) => open());
    vi.restoreAllMocks();
    // No stray transaction may outlive a test (a stale handler would otherwise leak into the next one).
    await until(async () => {
      const r = await t.pool.query(
        "select count(*)::int n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'",
      );
      return r.rows[0].n === 0;
    });
  });

  const options = (
    handlers: WebhookHandlerRegistry,
    extra: Partial<ProcessBatchOptions> = {},
  ): ProcessBatchOptions => ({
    handlers,
    now: () => FIXED_NOW,
    random: () => 0.5, // jitter factor exactly 1.0
    newLockOwner: owners,
    ...extra,
  });
  const batch = (handlers: WebhookHandlerRegistry, extra: Partial<ProcessBatchOptions> = {}) =>
    processWebhookBatch(t.db, options(handlers, extra));
  const note = (tx: Parameters<WebhookHandler>[0], eventId: string, text: string) =>
    tx.execute(sql`insert into queue_fixture_notes (event_id, note) values (${eventId}, ${text})`);
  const notes = async () =>
    (await t.pool.query("select event_id, note from queue_fixture_notes order by id"))
      .rows as Array<{
      event_id: string;
      note: string;
    }>;
  const ok: WebhookHandler = async () => undefined;
  const boom: WebhookHandler = async () => {
    throw new Error("boom");
  };

  // ------------------------------------------------------------------------------------------------ outcomes
  describe("outcomes", () => {
    it("success: PROCESSED, processed_at set, lease and last_error cleared, handler gets its event and the attempt", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w, { status: "FAILED", attempts: 1, lastError: "pg_40p01" });
      const seen: unknown[] = [];
      const summary = await batch({
        MESSAGE: async (_tx, event, context) => {
          seen.push({ event, attempt: context.attempt, max: context.maxAttempts });
        },
      });
      expect(summary).toEqual({
        claimed: 1,
        processed: 1,
        failed: 0,
        dead: 0,
        held: 0,
        ignored: 0,
        leaseLost: 0,
        unrecorded: 0,
      });
      expect(seen).toEqual([
        {
          event: expect.objectContaining({
            id: e.id,
            eventType: "MESSAGE",
            organizationId: w.org.id,
            whatsappAccountId: w.account.id,
          }),
          attempt: 2,
          max: MAX_ATTEMPTS,
        },
      ]);
      expect(await getEvent(t.pool, e.id)).toMatchObject({
        status: "PROCESSED",
        attempts: 2,
        locked_at: null,
        locked_by: null,
        last_error: null,
      });
      expect((await getEvent(t.pool, e.id)).processed_at).toBeInstanceOf(Date);
    });

    it("the handler's writes and the PROCESSED mark commit together; a throw rolls the writes back", async () => {
      const w = await world(t.db);
      const good = await pending(t.db, w, { receivedAt: new Date("2026-01-01T00:00:00Z") });
      const bad = await pending(t.db, w, { receivedAt: new Date("2026-01-01T00:00:01Z") });
      await batch({
        MESSAGE: async (tx, event) => {
          await note(tx, event.id, "written");
          if (event.id === bad.id) throw new Error("after the write");
        },
      });
      expect((await notes()).map((n) => n.event_id)).toEqual([good.id]);
      expect((await getEvent(t.pool, good.id)).status).toBe("PROCESSED");
      expect((await getEvent(t.pool, bad.id)).status).toBe("FAILED");
    });

    it("a failure at COMMIT of the handler's writes leaves the event unprocessed: the completion shares that transaction", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w);
      const summary = await batch({
        // the foreign key is deferred, so the violation only surfaces when the transaction commits
        MESSAGE: async (tx) =>
          void (await tx.execute(sql`insert into queue_fixture_children (parent_id) values (999)`)),
      });
      expect(summary).toMatchObject({ claimed: 1, processed: 0, failed: 1 });
      expect(await getEvent(t.pool, e.id)).toMatchObject({
        status: "FAILED",
        last_error: "pg_23503",
      });
      const children = await t.pool.query("select count(*)::int n from queue_fixture_children");
      expect(children.rows[0].n).toBe(0);
    });

    it("a poison event cannot roll back or block its neighbours", async () => {
      const w = await world(t.db);
      const ids: string[] = [];
      for (let i = 0; i < 6; i++)
        ids.push(
          (await pending(t.db, w, { receivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) })).id,
        );
      const poison = ids[2]!;
      const summary = await batch({
        MESSAGE: async (tx, event) => {
          await note(tx, event.id, "x");
          if (event.id === poison) throw new PermanentWebhookError("invalid_envelope");
        },
      });
      expect(summary).toMatchObject({ claimed: 6, processed: 5, dead: 1 });
      expect((await notes()).map((n) => n.event_id).sort()).toEqual(
        ids.filter((i) => i !== poison).sort(),
      );
      expect(await getEvent(t.pool, poison)).toMatchObject({
        status: "DEAD",
        last_error: "invalid_envelope",
        attempts: 1,
      });
    });

    it("a permanent error goes DEAD after exactly one run, with only its fixed code stored", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w);
      let runs = 0;
      await batch({
        MESSAGE: async () => {
          runs++;
          throw new PermanentWebhookError("invalid_timestamp");
        },
      });
      expect(runs).toBe(1);
      expect(await getEvent(t.pool, e.id)).toMatchObject({
        status: "DEAD",
        attempts: 1,
        last_error: "invalid_timestamp",
        locked_by: null,
      });
      await makeFailedDue(t.pool);
      expect((await batch({ MESSAGE: ok })).claimed).toBe(0);
      expect(runs).toBe(1);
    });

    it("an unsafe permanent code is replaced, never stored", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w);
      await batch({
        MESSAGE: async () => {
          throw new PermanentWebhookError("bad payload from 15550100123: hello");
        },
      });
      expect((await getEvent(t.pool, e.id)).last_error).toBe("permanent_error");
    });

    it("an unknown exception is transient and its message never reaches last_error or the logs", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w, {
        payload: { v: 1, text: "secret message text 15550100123" },
      });
      await batch({
        MESSAGE: async () => {
          throw new Error("secret message text 15550100123 LK.100000000000000001 token-abc");
        },
      });
      const row = await getEvent(t.pool, e.id);
      expect(row).toMatchObject({ status: "FAILED", last_error: "unexpected_error", attempts: 1 });
      const all = logs.join("\n");
      for (const secret of ["secret message text", "15550100123", "LK.1000", "token-abc"])
        expect(all, secret).not.toContain(secret);
      expect(all).toContain(e.id);
    });

    it("PostgreSQL errors inside a handler are transient, never auto-permanent (constraint errors included)", async () => {
      const w = await world(t.db);
      const division = await pending(t.db, w, { receivedAt: new Date("2026-01-01T00:00:00Z") });
      const unique = await pending(t.db, w, { receivedAt: new Date("2026-01-01T00:00:01Z") });
      await batch({
        MESSAGE: async (tx, event) => {
          if (event.id === division.id) await tx.execute(sql`select 1/0`);
          await tx.execute(
            sql`insert into organizations (name, slug) select name, slug from organizations limit 1`,
          );
        },
      });
      expect(await getEvent(t.pool, division.id)).toMatchObject({
        status: "FAILED",
        last_error: "pg_22012",
      });
      expect(await getEvent(t.pool, unique.id)).toMatchObject({
        status: "FAILED",
        last_error: "pg_23505",
      });
    });

    it("a missing handler type is never claimed and never marked PROCESSED", async () => {
      const w = await world(t.db);
      const message = await pending(t.db, w, { eventType: "MESSAGE" });
      const status = await pending(t.db, w, { eventType: "STATUS" });
      expect((await batch({})).claimed).toBe(0);
      const summary = await batch({ STATUS: ok });
      expect(summary).toMatchObject({ claimed: 1, processed: 1 });
      expect(await getEvent(t.pool, message.id)).toMatchObject({ status: "PENDING", attempts: 0 });
      expect((await getEvent(t.pool, status.id)).status).toBe("PROCESSED");
    });

    it("a PENDING event without routing is DEAD (missing_routing) and its handler never runs", async () => {
      const e = await insertEvent(t.db, {});
      let runs = 0;
      const summary = await batch({
        MESSAGE: async () => {
          runs++;
        },
      });
      expect(summary).toMatchObject({ claimed: 1, dead: 1 });
      expect(runs).toBe(0);
      expect(await getEvent(t.pool, e.id)).toMatchObject({
        status: "DEAD",
        last_error: "missing_routing",
      });
    });
  });

  // ------------------------------------------------------------------------------------------- retry schedule
  describe("retry schedule and the attempt limit", () => {
    it("follows the exact nominal backoff 30s,1m,2m,4m,8m,16m,32m, then DEAD on attempt 8 with no ninth run", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w);
      const attempts: number[] = [];
      const handlers = {
        MESSAGE: async (_tx: unknown, _e: unknown, c: { attempt: number }) => {
          attempts.push(c.attempt);
          throw new Error("transient");
        },
      } as WebhookHandlerRegistry;
      const expected = [30, 60, 120, 240, 480, 960, 1920];
      for (let n = 1; n <= 7; n++) {
        expect(await batch(handlers)).toMatchObject({ claimed: 1, failed: 1, dead: 0 });
        const row = await getEvent(t.pool, e.id);
        expect(row).toMatchObject({
          status: "FAILED",
          attempts: n,
          locked_by: null,
          locked_at: null,
        });
        expect(row.next_attempt_at.getTime() - FIXED_NOW.getTime()).toBe(expected[n - 1]! * 1000);
        await makeFailedDue(t.pool);
      }
      expect(await batch(handlers)).toMatchObject({ claimed: 1, failed: 0, dead: 1 });
      expect(await getEvent(t.pool, e.id)).toMatchObject({
        status: "DEAD",
        attempts: 8,
        last_error: "exhausted_unexpected_error",
        locked_by: null,
      });
      expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      await makeFailedDue(t.pool);
      await expireLeases(t.pool);
      expect((await batch(handlers)).claimed).toBe(0);
      expect(attempts).toHaveLength(8);
    });

    it("jitter stays within +/-20% of the nominal delay", async () => {
      const w = await world(t.db);
      for (const [random, seconds] of [
        [0, 24],
        [0.5, 30],
        [0.999999, 36],
      ] as const) {
        await t.pool.query("truncate webhook_events, webhook_requests cascade");
        const e = await pending(t.db, w);
        await batch({ MESSAGE: boom }, { random: () => random });
        const row = await getEvent(t.pool, e.id);
        expect(row.next_attempt_at.getTime() - FIXED_NOW.getTime()).toBe(seconds * 1000);
      }
    });

    it("claim #8 still runs the handler; a success there is PROCESSED", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w, { status: "FAILED", attempts: 7 });
      let runs = 0;
      await batch({
        MESSAGE: async (_tx, _e, c) => {
          runs++;
          expect(c.attempt).toBe(8);
        },
      });
      expect(runs).toBe(1);
      expect(await getEvent(t.pool, e.id)).toMatchObject({ status: "PROCESSED", attempts: 8 });
    });

    it("a transient failure on attempt 8 is DEAD immediately (no retry scheduled), a permanent one keeps its code", async () => {
      const w = await world(t.db);
      const transient = await pending(t.db, w, { status: "FAILED", attempts: 7 });
      await batch({ MESSAGE: boom });
      expect(await getEvent(t.pool, transient.id)).toMatchObject({ status: "DEAD", attempts: 8 });
      await t.pool.query("truncate webhook_events, webhook_requests cascade");
      const permanent = await pending(t.db, w, { status: "FAILED", attempts: 7 });
      await batch({
        MESSAGE: async () => {
          throw new PermanentWebhookError("invalid_envelope");
        },
      });
      expect(await getEvent(t.pool, permanent.id)).toMatchObject({
        status: "DEAD",
        last_error: "invalid_envelope",
      });
    });

    it("eight claims that die without recording anything, then the next claim goes DEAD without a handler run", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w);
      for (let n = 1; n <= 8; n++) {
        const [claimed] = await claimWebhookEventRows(t.db, {
          limit: 1,
          workerId: owners(),
          leaseSeconds: 120,
        });
        expect(claimed!.attempts).toBe(n);
        await expireLeases(t.pool);
      }
      let runs = 0;
      const summary = await batch({
        MESSAGE: async () => {
          runs++;
        },
      });
      expect(summary).toMatchObject({ claimed: 1, dead: 1 });
      expect(runs).toBe(0);
      expect(await getEvent(t.pool, e.id)).toMatchObject({
        status: "DEAD",
        attempts: MAX_ATTEMPTS + 1,
        last_error: "max_attempts_exhausted",
        locked_by: null,
      });
    });
  });

  // -------------------------------------------------- real handler runs that crash (the handler started, nothing recorded)
  describe("handler runs that never report back", () => {
    // A "crash" is a handler that started and never returns on its own: the worker is abandoned mid-run, the lease is
    // then back-dated, and the run is only released AFTER a newer claim exists (so it is a stale run when it wakes).
    function harness() {
      const runs = new Map<string, number>();
      const releasers: Array<() => void> = [];
      const abandoned: Array<Promise<unknown>> = [];
      let plan: (id: string, attempt: number) => "ok" | "transient" | "permanent" | "crash" = () =>
        "ok";
      let onCrash: () => void = () => undefined;
      const deps: ProcessDeps = {
        now: () => FIXED_NOW,
        random: () => 0.5,
        newLockOwner: owners,
        leaseSeconds: 120,
        handlerTimeoutMs: 60_000,
        statementTimeoutMs: 15_000,
      };
      const handler: WebhookHandler = async (_tx, event, context) => {
        runs.set(event.id, (runs.get(event.id) ?? 0) + 1);
        const action = plan(event.id, context.attempt);
        if (action === "crash") {
          const gate = newGate();
          releasers.push(gate.resolve);
          onCrash();
          await gate.promise;
        } else if (action === "transient") throw new Error("transient");
        else if (action === "permanent") throw new PermanentWebhookError("invalid_envelope");
      };
      const releaseStale = async () => {
        releasers.splice(0).forEach((release) => release());
        return Promise.all(abandoned.splice(0));
      };
      async function claimAndRun() {
        const owner = owners();
        const [event] = await claimWebhookEventRows(t.db, {
          limit: 1,
          workerId: owner,
          leaseSeconds: 120,
          eventTypes: ["MESSAGE"],
        });
        if (!event) return null;
        await releaseStale(); // anything abandoned earlier now wakes up as a stale run
        const crashed = newGate();
        onCrash = crashed.resolve;
        const run = processClaimedEvent(t.db, event, { MESSAGE: handler }, deps, owner);
        const winner = await Promise.race([
          run.then(() => "done" as const),
          crashed.promise.then(() => "crashed" as const),
        ]);
        if (winner === "crashed") abandoned.push(run);
        return event;
      }
      return {
        runs,
        handler,
        releaseStale,
        claimAndRun,
        setPlan: (p: typeof plan) => void (plan = p),
        totalRuns: (id: string) => runs.get(id) ?? 0,
      };
    }

    it("eight crashed handler runs, then the ninth claim is DEAD and the handler is never called again", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w);
      const h = harness();
      h.setPlan(() => "crash");
      for (let n = 1; n <= 8; n++) {
        expect((await h.claimAndRun())!.attempts).toBe(n);
        await expireLeases(t.pool);
      }
      expect(h.totalRuns(e.id)).toBe(8);
      expect(await getEvent(t.pool, e.id)).toMatchObject({ status: "PROCESSING", attempts: 8 });

      h.setPlan(() => "ok");
      const summary = await batch({ MESSAGE: h.handler });
      expect(summary).toMatchObject({ claimed: 1, dead: 1 });
      expect(h.totalRuns(e.id)).toBe(8);
      const dead = await getEvent(t.pool, e.id);
      expect(dead).toMatchObject({
        status: "DEAD",
        attempts: 9,
        last_error: "max_attempts_exhausted",
      });

      // the abandoned eighth run wakes up now: it is fenced out and cannot revive the event
      await h.releaseStale();
      expect(await getEvent(t.pool, e.id)).toEqual(dead);
      expect(h.totalRuns(e.id)).toBe(8);
    });

    it("any mix of crashes, transient and permanent failures never runs a handler more than eight times", async () => {
      const w = await world(t.db);
      let exhaustedByCrash = 0;
      let exhaustedByFailure = 0;
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        await t.pool.query("truncate webhook_events, webhook_requests cascade");
        const ids: string[] = [];
        for (let i = 0; i < 5; i++)
          ids.push(
            (await pending(t.db, w, { receivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) })).id,
          );
        const h = harness();
        const rng = seeded(seed);
        h.setPlan(() => {
          const r = rng();
          return r < 0.03 ? "ok" : r < 0.05 ? "permanent" : r < 0.5 ? "crash" : "transient";
        });
        for (let round = 0; round < 40; round++) {
          await makeFailedDue(t.pool);
          while (await h.claimAndRun()) {
            /* drain everything currently eligible */
          }
          const open = await t.pool.query(
            "select count(*)::int n from webhook_events where status not in ('PROCESSED','DEAD')",
          );
          if (open.rows[0].n === 0) break;
          await expireLeases(t.pool);
        }
        await h.releaseStale();
        // finish anything left by exhausting through the real batch entry point
        for (let round = 0; round < 12; round++) {
          await expireLeases(t.pool);
          await makeFailedDue(t.pool);
          await batch({ MESSAGE: boom }).catch(() => undefined);
        }
        for (const id of ids) {
          const row = await getEvent(t.pool, id);
          expect(["PROCESSED", "DEAD"], `seed ${seed}`).toContain(row.status);
          expect(row.attempts, `seed ${seed}`).toBeLessThanOrEqual(MAX_ATTEMPTS + 1);
          expect(h.totalRuns(id), `seed ${seed}`).toBeLessThanOrEqual(MAX_ATTEMPTS);
          expect(h.totalRuns(id), `seed ${seed}`).toBeLessThanOrEqual(row.attempts);
          if (row.status === "DEAD" && row.last_error === "max_attempts_exhausted")
            exhaustedByCrash++;
          if (row.status === "DEAD" && row.last_error?.startsWith("exhausted_"))
            exhaustedByFailure++;
        }
      }
      // the property is not vacuous: both exhaustion routes were actually exercised
      expect(exhaustedByCrash).toBeGreaterThan(0);
      expect(exhaustedByFailure).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------------------------ racing workers and exhaustion
  describe("racing workers", () => {
    it("many workers racing a retrying event never produce a ninth run", async () => {
      const w = await world(t.db);
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push((await pending(t.db, w)).id);
      const runs = new Map<string, number>();
      const handlers: WebhookHandlerRegistry = {
        MESSAGE: async (_tx, event) => {
          runs.set(event.id, (runs.get(event.id) ?? 0) + 1);
          throw new Error("transient");
        },
      };
      for (let round = 0; round < 14; round++) {
        await makeFailedDue(t.pool);
        await Promise.all(Array.from({ length: 6 }, () => batch(handlers)));
      }
      for (const id of ids) {
        expect(runs.get(id)).toBe(MAX_ATTEMPTS);
        expect(await getEvent(t.pool, id)).toMatchObject({
          status: "DEAD",
          attempts: MAX_ATTEMPTS,
        });
      }
    });

    it("racing reclaimers of an event that crashed on its eighth run: exactly one recognises exhaustion, none runs the handler", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w, { status: "PROCESSING", attempts: 8 });
      await t.pool.query(
        "update webhook_events set locked_at = now() - interval '5 minutes', locked_by = 'dead' where id = $1",
        [e.id],
      );
      let runs = 0;
      const summaries = await Promise.all(
        Array.from({ length: 6 }, () =>
          batch({
            MESSAGE: async () => {
              runs++;
            },
          }),
        ),
      );
      expect(summaries.reduce((n, s) => n + s.claimed, 0)).toBe(1);
      expect(summaries.reduce((n, s) => n + s.dead, 0)).toBe(1);
      expect(runs).toBe(0);
      expect(await getEvent(t.pool, e.id)).toMatchObject({ status: "DEAD", attempts: 9 });
    });

    it("racing reclaimers of an event that crashed on its seventh run: exactly one gets the eighth and final run", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w, { status: "PROCESSING", attempts: 7 });
      await t.pool.query(
        "update webhook_events set locked_at = now() - interval '5 minutes', locked_by = 'dead' where id = $1",
        [e.id],
      );
      let runs = 0;
      await Promise.all(
        Array.from({ length: 6 }, () =>
          batch({
            MESSAGE: async () => {
              runs++;
              throw new Error("transient");
            },
          }),
        ),
      );
      expect(runs).toBe(1);
      expect(await getEvent(t.pool, e.id)).toMatchObject({ status: "DEAD", attempts: 8 });
    });
  });

  // ------------------------------------------------------------------------------------------------- fencing
  describe("lease loss and fencing", () => {
    it("a stale worker cannot complete: its domain writes roll back and the live outcome is untouched", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w);
      const started = newGate();
      const gate = newGate();
      const aRun = batch({
        MESSAGE: async (tx, event) => {
          await note(tx, event.id, "A");
          started.resolve();
          await gate.promise;
        },
      });
      await started.promise;
      await expireLeases(t.pool);
      const b = await batch({ MESSAGE: async (tx, event) => void (await note(tx, event.id, "B")) });
      expect(b).toMatchObject({ claimed: 1, processed: 1 });
      const afterB = await getEvent(t.pool, e.id);
      expect(afterB).toMatchObject({ status: "PROCESSED", attempts: 2 });

      gate.resolve();
      const a = await aRun;
      expect(a).toMatchObject({ claimed: 1, leaseLost: 1, processed: 0, failed: 0, dead: 0 });
      expect((await notes()).map((n) => n.note)).toEqual(["B"]);
      expect(await getEvent(t.pool, e.id)).toEqual(afterB);
    });

    it("a stale worker cannot schedule a retry over a live owner's claim", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w);
      const aStarted = newGate();
      const aGate = newGate();
      const bStarted = newGate();
      const bGate = newGate();
      const aRun = batch({
        MESSAGE: async () => {
          aStarted.resolve();
          await aGate.promise;
          throw new Error("late failure");
        },
      });
      await aStarted.promise;
      await expireLeases(t.pool);
      const bRun = batch({
        MESSAGE: async () => {
          bStarted.resolve();
          await bGate.promise;
        },
      });
      await bStarted.promise;
      const live = await getEvent(t.pool, e.id);
      expect(live).toMatchObject({ status: "PROCESSING", attempts: 2 });

      aGate.resolve();
      expect(await aRun).toMatchObject({ leaseLost: 1, failed: 0 });
      expect(await getEvent(t.pool, e.id)).toEqual(live); // still B's, no FAILED, no last_error

      bGate.resolve();
      expect(await bRun).toMatchObject({ processed: 1 });
      expect((await getEvent(t.pool, e.id)).status).toBe("PROCESSED");
    });

    it("a stale worker cannot overwrite DEAD", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w);
      const started = newGate();
      const gate = newGate();
      const aRun = batch({
        MESSAGE: async () => {
          started.resolve();
          await gate.promise;
        },
      });
      await started.promise;
      await expireLeases(t.pool);
      await batch({
        MESSAGE: async () => {
          throw new PermanentWebhookError("invalid_envelope");
        },
      });
      const dead = await getEvent(t.pool, e.id);
      expect(dead.status).toBe("DEAD");
      gate.resolve();
      expect(await aRun).toMatchObject({ leaseLost: 1, processed: 0 });
      expect(await getEvent(t.pool, e.id)).toEqual(dead);
    });

    it("every fenced transition refuses a wrong owner, a finished event, and works for the owner", async () => {
      const w = await world(t.db);
      const claimAs = async (owner: string) => {
        await t.pool.query("truncate webhook_events, webhook_requests cascade");
        const e = await pending(t.db, w);
        await claimWebhookEventRows(t.db, { limit: 1, workerId: owner, leaseSeconds: 120 });
        return e.id;
      };
      const ops: Array<[string, (id: string, owner: string) => Promise<boolean>]> = [
        ["complete", (id, owner) => completeWebhookEvent(t.db, { id, workerId: owner })],
        [
          "fail",
          (id, owner) =>
            failWebhookEvent(t.db, { id, workerId: owner, reason: "x", nextAttemptAt: FIXED_NOW }),
        ],
        ["dead", (id, owner) => deadWebhookEvent(t.db, { id, workerId: owner, reason: "x" })],
        [
          "hold",
          (id, owner) =>
            holdWebhookEvent(t.db, {
              id,
              workerId: owner,
              status: "UNROUTABLE",
              reason: "account_pending",
            }),
        ],
      ];
      for (const [name, op] of ops) {
        const id = await claimAs("real-owner");
        const before = await getEvent(t.pool, id);
        expect(await op(id, "someone-else"), `${name} wrong owner`).toBe(false);
        expect(await getEvent(t.pool, id), `${name} wrong owner`).toEqual(before);
        expect(await op(id, "real-owner"), `${name} owner`).toBe(true);
        const after = await getEvent(t.pool, id);
        expect(after.locked_by).toBeNull();
        expect(await op(id, "real-owner"), `${name} replay`).toBe(false); // no longer PROCESSING
        expect(await getEvent(t.pool, id), `${name} replay`).toEqual(after);
      }
    });

    it("each claim gets its own lock owner by default", async () => {
      const w = await world(t.db);
      for (let i = 0; i < 6; i++) await pending(t.db, w);
      const seen: string[] = [];
      await processWebhookBatch(t.db, {
        handlers: {
          MESSAGE: async (tx, event) => {
            const r = await tx.execute<{ locked_by: string }>(
              sql`select locked_by from webhook_events where id = ${event.id}`,
            );
            seen.push(r.rows[0]!.locked_by);
          },
        },
        now: () => FIXED_NOW,
      });
      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);
      for (const owner of seen) expect(owner).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  // ------------------------------------------------------------------------------------------------ budgets
  describe("time budgets", () => {
    it("a handler that exceeds its budget is aborted, rolled back and retried later (transient handler_timeout)", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w);
      let aborted = false;
      const summary = await batch(
        {
          MESSAGE: async (tx, event, context) => {
            await note(tx, event.id, "never committed");
            await new Promise<void>((resolve) =>
              context.signal.addEventListener("abort", () => {
                aborted = true;
                resolve();
              }),
            );
          },
        },
        { handlerTimeoutMs: 100 },
      );
      expect(summary).toMatchObject({ claimed: 1, failed: 1, processed: 0 });
      expect(aborted).toBe(true);
      await until(
        async () =>
          (await notes()).length === 0 && (await getEvent(t.pool, e.id)).status === "FAILED",
      );
      expect(await getEvent(t.pool, e.id)).toMatchObject({
        status: "FAILED",
        last_error: "handler_timeout",
        attempts: 1,
      });
    });

    it("a late handler that ignores the abort still cannot commit or mark PROCESSED", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w);
      const release = newGate();
      const finished = newGate();
      const summary = await batch(
        {
          MESSAGE: async (tx, event) => {
            await note(tx, event.id, "late");
            await release.promise; // ignores context.signal
            finished.resolve();
          },
        },
        { handlerTimeoutMs: 100 },
      );
      expect(summary).toMatchObject({ failed: 1 });
      release.resolve();
      await finished.promise;
      await until(
        async () =>
          (
            await t.pool.query(
              "select 1 from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'",
            )
          ).rowCount === 0,
      );
      expect((await getEvent(t.pool, e.id)).status).toBe("FAILED");
      expect(await notes()).toEqual([]);
    });

    it("a statement over the statement timeout fails the run as transient (pg_57014)", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w);
      await batch(
        { MESSAGE: async (tx) => void (await tx.execute(sql`select pg_sleep(5)`)) },
        { statementTimeoutMs: 150 },
      );
      expect(await getEvent(t.pool, e.id)).toMatchObject({
        status: "FAILED",
        last_error: "pg_57014",
      });
    });

    it("the handler budget must be shorter than the lease", async () => {
      await expect(batch({ MESSAGE: ok }, { handlerTimeoutMs: 120_000 })).rejects.toThrow(
        RangeError,
      );
      await expect(
        batch({ MESSAGE: ok }, { handlerTimeoutMs: 200_000, leaseSeconds: 120 }),
      ).rejects.toThrow(RangeError);
    });
  });

  // ----------------------------------------------------------------------------------------- batch limits
  describe("batch limits", () => {
    it("processes at most batchSize events and runs at most `concurrency` handlers at once (default 2)", async () => {
      const w = await world(t.db);
      for (let i = 0; i < 30; i++)
        await pending(t.db, w, { receivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
      let inFlight = 0;
      let peak = 0;
      const summary = await batch({
        MESSAGE: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 15));
          inFlight--;
        },
      });
      expect(summary).toMatchObject({ claimed: 20, processed: 20 });
      expect(peak).toBe(2);
      const left = await t.pool.query(
        "select count(*)::int n from webhook_events where status = 'PENDING'",
      );
      expect(left.rows[0].n).toBe(10);
    });

    it("honours explicit limits and rejects out-of-range ones", async () => {
      const w = await world(t.db);
      for (let i = 0; i < 12; i++) await pending(t.db, w);
      let inFlight = 0;
      let peak = 0;
      const summary = await batch(
        {
          MESSAGE: async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 15));
            inFlight--;
          },
        },
        { batchSize: 7, concurrency: 4 },
      );
      expect(summary.claimed).toBe(7);
      expect(peak).toBe(4);
      for (const bad of [
        { batchSize: 0 },
        { batchSize: 101 },
        { concurrency: 0 },
        { concurrency: 9 },
        { batchSize: 1.5 },
      ])
        await expect(batch({ MESSAGE: ok }, bad)).rejects.toThrow(RangeError);
    });

    it("a failing claim does not abandon a lane that is mid-event: the batch settles after it, then rejects", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w);
      let claims = 0;
      const flaky = new Proxy(t.db, {
        get(target, prop) {
          if (prop === "execute")
            return (...args: Parameters<typeof target.execute>) => {
              if (++claims === 2) throw new Error("database went away");
              return target.execute(...args);
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const g = newGate();
      let finished = false;
      const run = processWebhookBatch(
        flaky,
        options({
          MESSAGE: async () => {
            await g.promise;
            finished = true;
          },
        }),
      );
      let settled = false;
      run.then(
        () => (settled = true),
        () => (settled = true),
      );
      await until(() => claims >= 2);
      await new Promise((r) => setTimeout(r, 100));
      expect(settled).toBe(false); // the healthy lane is still running its handler
      g.resolve();
      await expect(run).rejects.toThrow("database went away");
      expect(finished).toBe(true);
      expect((await getEvent(t.pool, e.id)).status).toBe("PROCESSED");
    });

    it("an idle queue claims nothing and logs nothing", async () => {
      expect(await batch({ MESSAGE: ok })).toMatchObject({ claimed: 0 });
      expect(logs).toEqual([]);
    });

    it("the summary and every log line carry only counts and internal ids (no payload, phone, BSUID or text)", async () => {
      const w = await world(t.db);
      await pending(t.db, w, {
        payload: {
          v: 1,
          message: {
            text: { body: "SECRET BODY" },
            from: "15550100123",
            from_user_id: "LK.100000000000000009",
          },
        },
      });
      const summary = await batch({ MESSAGE: ok });
      expect(Object.keys(summary).sort()).toEqual(
        [
          "claimed",
          "dead",
          "failed",
          "held",
          "ignored",
          "leaseLost",
          "processed",
          "unrecorded",
        ].sort(),
      );
      expect(Object.values(summary).every((v) => typeof v === "number")).toBe(true);
      expect(logs.length).toBeGreaterThan(0);
      for (const line of logs) {
        for (const secret of ["SECRET BODY", "15550100123", "LK.1000"])
          expect(line).not.toContain(secret);
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed.webhook_event).toMatch(/^webhook\.(event_|batch_)/);
      }
    });
  });

  // ------------------------------------------------------------ account changes after the claim, before the handler
  describe("account state is rechecked before the handler", () => {
    const run = async (mutate: string, o: { attempts?: number } = {}) => {
      const w = await world(t.db);
      const e = await pending(t.db, w, {
        status: o.attempts ? "FAILED" : "PENDING",
        attempts: o.attempts ?? 0,
      });
      await t.pool.query(mutate, [w.account.id]);
      let runs = 0;
      const summary = await batch({
        MESSAGE: async () => {
          runs++;
        },
      });
      return { w, e, summary, runs, row: await getEvent(t.pool, e.id) };
    };

    it("PENDING account: back to an UNROUTABLE hold, tenant routing KEPT, attempt restored, handler not run", async () => {
      const { w, summary, runs, row } = await run(
        "update whatsapp_accounts set status = 'PENDING' where id = $1",
      );
      expect(runs).toBe(0);
      expect(summary).toMatchObject({ claimed: 1, held: 1, ignored: 0, failed: 0, dead: 0 });
      expect(row).toMatchObject({
        status: "UNROUTABLE",
        attempts: 0,
        last_error: "account_pending",
        organization_id: w.org.id,
        whatsapp_account_id: w.account.id,
        locked_by: null,
        locked_at: null,
      });
    });

    it("DISABLED account: IGNORED (routing kept), attempt restored", async () => {
      const { w, summary, runs, row } = await run(
        "update whatsapp_accounts set status = 'DISABLED' where id = $1",
      );
      expect(runs).toBe(0);
      expect(summary).toMatchObject({ claimed: 1, ignored: 1, held: 0 });
      expect(row).toMatchObject({
        status: "IGNORED",
        attempts: 0,
        last_error: "account_disabled",
        organization_id: w.org.id,
        whatsapp_account_id: w.account.id,
        locked_by: null,
      });
    });

    it("archived account: IGNORED account_archived, even when it is also disabled", async () => {
      const { summary, row } = await run(
        "update whatsapp_accounts set archived_at = now() where id = $1",
      );
      expect(summary).toMatchObject({ ignored: 1 });
      expect(row).toMatchObject({ status: "IGNORED", last_error: "account_archived", attempts: 0 });
      const both = await run(
        "update whatsapp_accounts set archived_at = now(), status = 'DISABLED' where id = $1",
      );
      expect(both.row.last_error).toBe("account_archived");
    });

    it("restores the pre-claim attempts for a retried event, not zero", async () => {
      const { row } = await run("update whatsapp_accounts set status = 'PENDING' where id = $1", {
        attempts: 3,
      });
      expect(row).toMatchObject({ status: "UNROUTABLE", attempts: 3 });
    });

    it("restores the pre-claim attempts for a lease-reclaimed event", async () => {
      const w = await world(t.db);
      const e = await pending(t.db, w);
      await claimWebhookEventRows(t.db, { limit: 1, workerId: owners(), leaseSeconds: 120 }); // attempts 1, then dies
      await expireLeases(t.pool);
      await t.pool.query("update whatsapp_accounts set status = 'DISABLED' where id = $1", [
        w.account.id,
      ]);
      await batch({ MESSAGE: boom });
      expect(await getEvent(t.pool, e.id)).toMatchObject({ status: "IGNORED", attempts: 1 });
    });

    it("an ACTIVE account runs the handler normally", async () => {
      const { summary, runs } = await run(
        "update whatsapp_accounts set status = 'ACTIVE' where id = $1",
      );
      expect(runs).toBe(1);
      expect(summary).toMatchObject({ processed: 1 });
    });
  });

  // ----------------------------------------------------------------------------------------------- observability
  describe("queue statistics", () => {
    it("reports zeros and no age for an empty queue", async () => {
      const { readQueueStats } = await import("./stats");
      expect(await readQueueStats(t.db)).toEqual({
        byStatus: Object.fromEntries(schema.WEBHOOK_EVENT_STATUSES.map((s) => [s, 0])),
        oldestDueAgeSeconds: null,
        expiredLeases: 0,
      });
    });

    it("counts every status, the oldest due age and expired leases, and exposes no event content", async () => {
      const { readQueueStats } = await import("./stats");
      const w = await world(t.db);
      const due = await pending(t.db, w);
      await pending(t.db, w, { status: "FAILED", attempts: 2 });
      const future = await pending(t.db, w);
      await pending(t.db, w, { status: "PROCESSED" });
      await pending(t.db, w, { status: "DEAD" });
      await pending(t.db, w, { status: "UNROUTABLE" });
      await pending(t.db, w, { status: "IGNORED" });
      await pending(t.db, w, { status: "IGNORED" });
      const live = await pending(t.db, w, { status: "PROCESSING", attempts: 1 });
      const expired = await pending(t.db, w, { status: "PROCESSING", attempts: 1 });
      await t.pool.query(
        "update webhook_events set next_attempt_at = now() - interval '300 seconds' where id = $1",
        [due.id],
      );
      await t.pool.query(
        "update webhook_events set next_attempt_at = now() + interval '1 hour' where id = $1",
        [future.id],
      );
      await t.pool.query("update webhook_events set locked_at = now() where id = $1", [live.id]);
      await t.pool.query(
        "update webhook_events set locked_at = now() - interval '10 minutes' where id = $1",
        [expired.id],
      );

      const stats = await readQueueStats(t.db);
      expect(stats.byStatus).toEqual({
        PENDING: 2,
        PROCESSING: 2,
        PROCESSED: 1,
        FAILED: 1,
        DEAD: 1,
        UNROUTABLE: 1,
        IGNORED: 2,
      });
      expect(stats.oldestDueAgeSeconds).toBeGreaterThanOrEqual(299);
      expect(stats.oldestDueAgeSeconds).toBeLessThan(330);
      expect(stats.expiredLeases).toBe(1);
      expect(Object.keys(stats).sort()).toEqual([
        "byStatus",
        "expiredLeases",
        "oldestDueAgeSeconds",
      ]);
    });
  });
});
