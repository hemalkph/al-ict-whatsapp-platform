import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { claimNext, executeClaim } from "@/modules/messaging/dispatch";
import { FakeTransport } from "@/modules/messaging/testing";
import { PN, WABA } from "@/modules/whatsapp/identity/testing";
import { handleInboundMessage } from "@/modules/whatsapp/inbound/handler";
import { deliver, handlerContext } from "@/modules/whatsapp/inbound/testing";
import type { WebhookEventKind } from "@/modules/whatsapp/queue/process";
import { barrierKit, settledState } from "../bot-control/testing";
import { deferred, runtimeKit } from "./testing";

// Phase 08E-5 review conditions due at 08E-6, on disposable PostgreSQL 17:
//   * inbound-first ordering (the reverse R3-P order): the REAL inbound handler holds its conversation changes uncommitted, T1
//     waits for the conversation, the handler commits, T1 proceeds; the message is durable; no 40P01.
//   * STAFF submission B4: a FEASIBILITY PROBE. The claim's only blocking lock before its bot-rule read is the account row FOR
//     SHARE, which the submission also takes, and the final authorization is one lock-free read; PostgreSQL does not make a
//     compatible FOR SHARE request queue behind a waiting conflicting locker. So no row barrier can park the claim while a
//     submission commits. The probe proves that on the real server (if it ever parks, the probe fails and tells the owner a
//     barrier exists), and the B2 order then asserts the invariant: 0 BOT calls, staff_took_over.
//   * participant isolation: no per-transaction override and READ COMMITTED as the database default for every new connection.
//   * deadlock_timeout: the observed server value and whether the test role may set the plan's 500 ms (recorded, not assumed).
// NOT EXECUTED by the author of this change: no isolated PostgreSQL server was configured.

describe("Phase 08E-5 review conditions", () => {
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

  it("inbound first: the real handler holds its conversation changes; T1 waits for the conversation, then proceeds; the message is durable; no 40P01", async () => {
    const f = await k.fixture();
    const { session } = await k.acceptedPrompt(f);
    await k.reconcile(session);
    const s = await k.session(session.id as string);
    const tap = await k.replyTrigger(f, s.awaiting_token as string, "a");
    const claim = await k.claimOf(tap.id);
    await t.pool.query(
      "update whatsapp_accounts set phone_number_id = $2, waba_id = $3 where id = $1",
      [f.w.account.id, PN, WABA],
    );
    await t.pool.query("update contacts set wa_id = '15550100123' where id = $1", [
      f.w.student.contact.id,
    ]);
    const event = await deliver(t.db, {});
    const ready = deferred<{ pid: number; isolation: string }>();
    const go = deferred();
    const handler = kit.settle(
      t.db.transaction(async (tx) => {
        await handleInboundMessage(
          tx,
          { ...event, eventType: event.eventType as WebhookEventKind },
          handlerContext(),
        );
        const pid = Number(
          (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`)).rows[0]!.pid,
        );
        const isolation = (
          await tx.execute<{ transaction_isolation: string }>(sql.raw("show transaction_isolation"))
        ).rows[0]!.transaction_isolation;
        ready.resolve({ pid, isolation });
        await go.promise; // the handler's writes (conversation activity) stay uncommitted
      }),
    );
    const h = await ready.promise;
    expect(h.isolation).toBe("read committed");
    let t1Isolation = "";
    const t1 = kit.settle(
      k.runClaim(claim, {
        hooks: {
          afterTriggerLock: async (tx) => {
            t1Isolation = (
              await tx.execute<{ transaction_isolation: string }>(
                sql.raw("show transaction_isolation"),
              )
            ).rows[0]!.transaction_isolation;
          },
        },
      }),
    );
    const t1Pid = await kit.waitUntilBlocked(h.pid);
    expect(await kit.blockersOf(t1Pid)).toEqual([h.pid]);
    go.resolve();
    const [hr, tr] = await Promise.all([handler, t1]);
    expect([settledState(hr), settledState(tr)]).not.toContain("40P01");
    expect(hr.ok).toBe(true);
    expect(t1Isolation).toBe("read committed");
    expect(tr).toMatchObject({
      ok: true,
      value: { status: "PROCESSED", outcome: "input_accepted" },
    });
    expect(
      Number(
        (
          await k.one("select count(*)::int n from messages where wamid = $1", [
            event.providerObjectId,
          ])
        ).n,
      ),
    ).toBe(1);
    expect(await k.botRequests(f)).toHaveLength(2); // the prompt and the next prompt, nothing else
  });

  it("STAFF submission B4 feasibility: with the submission holding the account FOR SHARE, a waiting FOR NO KEY UPDATE does not park the claim; the B2 order then holds R staff_took_over; 0 BOT calls", async () => {
    const f = await k.fixture();
    const { request } = await k.startedPrompt(f);
    // park the submission AFTER its conversation lock and account FOR SHARE: its request insert needs a KEY SHARE on the actor
    const member = await kit.hold(
      "select id from organization_memberships where id = $1 for update",
      [f.w.staff.membershipId],
    );
    const submission = kit.settle(k.submit(f));
    const subPid = await kit.waitUntilBlocked(member.pid);
    const probe = (text: string, id: string) =>
      t.pool.query(text, [id]).then(
        () => "free",
        (e: { code?: string }) => e.code ?? "error",
      );
    expect(
      await probe(
        "select 1 from conversations where id = $1 for update nowait",
        f.w.student.conversation.id,
      ),
    ).toBe("55P03");
    expect(
      await probe(
        "select 1 from whatsapp_accounts where id = $1 for no key update nowait",
        f.w.account.id,
      ),
    ).toBe("55P03");
    // a conflicting locker now waits behind the submission's share lock
    const h = await t.pool.connect();
    try {
      await h.query("begin");
      const hPid = Number((await h.query("select pg_backend_pid() pid")).rows[0].pid);
      const hq = h
        .query("select id from whatsapp_accounts where id = $1 for no key update", [f.w.account.id])
        .catch((e: unknown) => e);
      expect(await kit.waitUntilBlocked(subPid)).toBe(hPid);
      // the claim's FOR SHARE is compatible with the held share lock: it is NOT parked behind the waiting locker
      const transport = new FakeTransport();
      const claimed = claimNext(k.dispatchDeps(transport));
      expect(
        await kit.within(claimed, 5_000),
        "a compatible FOR SHARE parked behind the waiter: a B4 barrier exists",
      ).toBe(true);
      const { claim } = await claimed;
      expect(claim?.requestId).toBe(request.id); // decided before the staff fence was committed
      await member.release();
      expect((await submission).ok).toBe(true);
      await hq;
      await h.query("rollback");
      // B2: staff committed before the final authorization: refused, zero BOT calls
      expect(await executeClaim(k.dispatchDeps(transport), claim!)).toBe("held");
      expect(await k.request(request.id as string)).toMatchObject({
        state: "HELD",
        hold_reason: "staff_took_over",
      });
      expect(transport.calls).toHaveLength(0);
    } finally {
      h.release();
    }
  });

  it("participant isolation: no database- or role-level override, and every new connection starts READ COMMITTED", async () => {
    const overrides = await k.rows(
      "select setconfig from pg_db_role_setting where setdatabase in (0, (select oid from pg_database where datname = current_database()))",
    );
    for (const o of overrides)
      expect(JSON.stringify(o.setconfig)).not.toMatch(
        /default_transaction_isolation|transaction_isolation/,
      );
    const clients = await Promise.all([t.pool.connect(), t.pool.connect(), t.pool.connect()]);
    try {
      for (const c of clients)
        expect(
          (await c.query("show default_transaction_isolation")).rows[0]
            .default_transaction_isolation,
        ).toBe("read committed");
    } finally {
      for (const c of clients) c.release();
    }
  });

  it("deadlock_timeout: records the server value and whether the test role may set the plan's 500 ms (production configuration untouched)", async () => {
    const c = await t.pool.connect();
    try {
      const observed = String((await c.query("show deadlock_timeout")).rows[0].deadlock_timeout);
      const superuser = Boolean(
        (await c.query("select rolsuper from pg_roles where rolname = current_user")).rows[0]
          .rolsuper,
      );
      let settable: true | string = true;
      try {
        await c.query("begin");
        await c.query("set local deadlock_timeout = '500ms'");
        expect(String((await c.query("show deadlock_timeout")).rows[0].deadlock_timeout)).toBe(
          "500ms",
        );
      } catch (e) {
        settable = (e as { code?: string }).code ?? "error";
      } finally {
        await c.query("rollback");
      }
      process.stdout.write(
        `\n[08E-6] deadlock_timeout observed=${observed} superuser=${superuser} set500ms=${String(settable)}\n`,
      );
      expect(observed).toMatch(/^\d+(ms|s|min)$/);
      // deadlock_timeout is a superuser setting: settable exactly when the test role is a superuser
      expect(settable === true).toBe(superuser);
      if (settable !== true) expect(settable).toBe("42501");
    } finally {
      c.release();
    }
  });
});
