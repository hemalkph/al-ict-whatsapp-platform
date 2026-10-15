import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changeMemberRole, suspendMember } from "@/modules/access";
import { changeLeadStatus, createManualLead } from "../index";
import { contactLockKey } from "../locks";
import { recordFailure } from "./failure";
import { processCandidate } from "./process";
import { DEFAULT_OPTIONS } from "./config";
import {
  addContact,
  addTouch,
  fixture,
  holdBarrier,
  installBarrier,
  makeDue,
  minutesAgo,
  removeBarrier,
  waitUntilBlocked,
  injectFailure,
  removeFailure,
  type Fixture,
} from "./testing";

// The reconciler against every other writer of leads, on real PostgreSQL with real locks. The order of two transactions is made by
// a lock the test holds and observes in pg_stat_activity; nothing relies on a sleep. A reconciler that has to wait uses a long
// lock timeout so that the wait lasts as long as the test needs.

const DEADLOCK = "40P01";

describe("lead reconciler: concurrent operation", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
    // every reconciler transaction that writes lead history passes the barrier; a test holds it to keep a reconciler inside its
    // transaction with all its locks (the reconciler never waits for a row lock, so this is how an overlap is made deterministic)
    await installBarrier(f.t);
  });
  afterEach(async () => f.close());

  const deps = () => ({ db: f.t.db });
  const count = async (sql: string, params: unknown[] = []) =>
    (await f.one<{ n: number }>(`select count(*)::int n from ${sql}`, params)).n;
  const linkOf = async (id: string) =>
    (
      await f.one<{ lead_id: string | null }>(
        "select lead_id from lead_attributions where id = $1",
        [id],
      )
    ).lead_id;
  const settle = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  const code = (r: { ok: boolean; error?: unknown }) =>
    r.ok
      ? null
      : ((r.error as { cause?: { code?: string } }).cause?.code ??
        (r.error as { code?: string }).code ??
        "other");

  async function holdContactLock(contactId: string) {
    const c = await f.t.pool.connect();
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      contactLockKey(f.w.org.id, contactId),
    ]);
    return {
      c,
      async done() {
        await c.query("commit");
        c.release();
      },
    };
  }
  /** Every invariant of the lead tables that concurrency could break. */
  async function assertConsistent() {
    // at most one open lead per contact (also the database's own index)
    expect(
      await count(
        "(select contact_id from leads where closed_at is null group by contact_id having count(*) > 1) x",
      ),
    ).toBe(0);
    // every touch is linked at most once, and a linked touch keeps no decision
    expect(
      await count(
        "lead_reconcile_decisions d join lead_attributions a on a.id = d.attribution_id where a.lead_id is not null",
      ),
    ).toBe(0);
    // history agrees with the data: one TOUCH_LINKED per linked touch, one CREATED per lead the reconciler created, no event for an unlinked touch
    expect(await count("lead_attributions where lead_id is not null")).toBe(
      await count("lead_events where kind = 'TOUCH_LINKED'"),
    );
    expect(
      await count(
        "lead_events e join lead_attributions a on a.id = e.attribution_id where e.kind = 'TOUCH_LINKED' and a.lead_id is distinct from e.lead_id",
      ),
    ).toBe(0);
    expect(await count("leads where initiating_attribution_id is not null")).toBe(
      await count("lead_events where kind = 'CREATED' and origin = 'AD_REFERRAL'"),
    );
    expect(
      await count(
        "leads l where l.initiating_attribution_id is not null and not exists (select 1 from lead_attributions a where a.id = l.initiating_attribution_id and a.lead_id = l.id)",
      ),
    ).toBe(0);
  }

  it("two reconcilers at the same time: no duplicate lead, no duplicate link, no contradictory decision, no lost history", async () => {
    const contacts = [];
    for (let i = 0; i < 10; i++) contacts.push(await addContact(f.t.db, f.w.org.id));
    const touches: string[] = [];
    for (const [i, c] of contacts.entries()) {
      for (let k = 0; k < 3; k++)
        touches.push(
          (await addTouch(f.t.db, f.w, c.id, { receivedAt: minutesAgo(60 - i - k * 10) })).id,
        );
    }
    // two of the contacts already have a manual open lead
    for (const c of contacts.slice(0, 2))
      await createManualLead(f.w.staff.ctx, { contactId: c.id }, deps());
    // their touches are older than the lead: skipped; make the touches of the others the interesting ones
    for (let round = 0; round < 6; round++) {
      const [a, b] = await Promise.all([f.run({ pageSize: 4 }), f.run({ pageSize: 4 })]);
      expect(a.errors).toEqual({});
      expect(b.errors).toEqual({});
      if (a.remaining.due === 0 && b.remaining.due === 0) break;
    }
    expect((await f.run()).remaining.due).toBe(0);
    await assertConsistent();
    // the eight contacts without a lead each got exactly one (from their FIRST touch), and linked the other two touches
    for (const c of contacts.slice(2)) {
      expect(await count("leads where contact_id = $1", [c.id])).toBe(1);
      expect(
        await count("lead_attributions where contact_id = $1 and lead_id is not null", [c.id]),
      ).toBe(3);
      const first = await f.one<{ id: string }>(
        "select id from lead_attributions where contact_id = $1 order by received_at, id limit 1",
        [c.id],
      );
      expect(
        (
          await f.one<{ initiating_attribution_id: string }>(
            "select initiating_attribution_id from leads where contact_id = $1",
            [c.id],
          )
        ).initiating_attribution_id,
      ).toBe(first.id);
    }
    expect(await count("lead_events where kind = 'CREATED'")).toBe(2 /* manual */ + 8);
    expect(touches).toHaveLength(30);
  });

  it("two reconcilers on ONE contact: the second does not see it (its lock is held) and does not wait or duplicate; the first completes", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const barrier = await holdBarrier(f.t);
    const first = settle(f.run());
    await waitUntilBlocked(f.t, 1); // it holds the contact lock, has inserted the lead, and waits at the barrier
    const started = Date.now();
    const second = await f.run(); // returns at once
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(second).toMatchObject({
      scanned: 0,
      processed: 0,
      created: 0,
      linked: 0,
      remaining: { due: 1 },
    });
    await barrier.release();
    const result = await first;
    expect(result.ok && result.value).toMatchObject({ created: 1 });
    expect(await count("leads where contact_id = $1", [contact.id])).toBe(1);
    expect(await linkOf(touch.id)).not.toBeNull();
    await assertConsistent();
  });

  it("a second reconciler that DOES attempt the touch (it read the candidate before the first took the lock) is told busy and spends nothing", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const candidate = {
      organizationId: f.w.org.id,
      attributionId: touch.id,
      contactId: contact.id,
      receivedKey: "",
    };
    const barrier = await holdBarrier(f.t);
    const first = settle(f.run());
    await waitUntilBlocked(f.t, 1);
    expect(await processCandidate(f.t.db, candidate, DEFAULT_OPTIONS)).toEqual({ kind: "busy" });
    await barrier.release();
    expect((await first).ok).toBe(true);
    expect(await count("lead_reconcile_decisions")).toBe(0);
    await assertConsistent();
  });

  it("a reconciler holding the contact lock and a manual creation: the creation waits, then returns the reconciler's lead; no second lead", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const barrier = await holdBarrier(f.t);
    const reconciling = settle(f.run());
    await waitUntilBlocked(f.t, 1);
    const creating = settle(createManualLead(f.w.staff.ctx, { contactId: contact.id }, deps()));
    await waitUntilBlocked(f.t, 2); // the creation waits for the contact lock
    await barrier.release();
    const [r, c] = await Promise.all([reconciling, creating]);
    expect(r.ok && r.value.created).toBe(1);
    expect(c.ok && c.value.created).toBe(false);
    expect(await count("leads where contact_id = $1", [contact.id])).toBe(1);
    expect(await count("lead_events where kind = 'CREATED'")).toBe(1);
    expect(await linkOf(touch.id)).not.toBeNull();
    await assertConsistent();
  });

  it("a manual creation holding the contact lock and a reconciler: the reconciler does not see the contact, and later judges the touches by the new cycle", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const before = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const after = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(Date.now() + 60_000),
    });
    // the creator, in the contract order, not committed yet
    const creator = await f.t.pool.connect();
    let leadId: string;
    try {
      await creator.query("begin");
      await creator.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        contactLockKey(f.w.org.id, contact.id),
      ]);
      leadId = (
        await creator.query(
          "insert into leads (organization_id, contact_id) values ($1,$2) returning id",
          [f.w.org.id, contact.id],
        )
      ).rows[0].id;
      await creator.query(
        "insert into lead_events (organization_id, lead_id, contact_id, kind, actor_membership_id, origin, revision) values ($1,$2,$3,'CREATED',$4,'MANUAL',0)",
        [f.w.org.id, leadId, contact.id, f.w.staff.membershipId],
      );
      expect(await f.run()).toMatchObject({
        scanned: 0,
        processed: 0,
        created: 0,
        remaining: { due: 2 },
      });
      await creator.query("commit");
    } finally {
      await creator.query("rollback").catch(() => undefined);
      creator.release();
    }
    const report = await f.run();
    expect(report).toMatchObject({ linked: 1, skipped: { beforeCycle: 1 }, created: 0 });
    expect(await linkOf(after.id)).toBe(leadId);
    expect(await linkOf(before.id)).toBeNull();
    await assertConsistent();
  });

  it("a reconciler and the closure of the lead: whichever holds the contact first, the result is consistent", async () => {
    // (a) the reconciler first: it links, then the closure (which waited) closes the lead
    const contact = await addContact(f.t.db, f.w.org.id);
    const manual = await createManualLead(f.w.staff.ctx, { contactId: contact.id }, deps());
    const touch = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(Date.now() + 60_000),
    });
    const barrier = await holdBarrier(f.t);
    const reconciling = settle(f.run());
    await waitUntilBlocked(f.t, 1);
    const closing = settle(
      changeLeadStatus(
        f.w.staff.ctx,
        manual.lead.id,
        { to: "NOT_INTERESTED", expectedRevision: 0 },
        deps(),
      ),
    );
    await waitUntilBlocked(f.t, 2);
    await barrier.release();
    const [r, c] = await Promise.all([reconciling, closing]);
    expect(r.ok && r.value.linked).toBe(1);
    expect(c.ok).toBe(true);
    expect(await linkOf(touch.id)).toBe(manual.lead.id);
    expect(
      (await f.one<{ status: string }>("select status from leads where id = $1", [manual.lead.id]))
        .status,
    ).toBe("NOT_INTERESTED");
    expect(
      (
        await f.q<{ kind: string }>(
          "select kind from lead_events where lead_id = $1 order by created_at, id",
          [manual.lead.id],
        )
      ).map((e) => e.kind),
    ).toEqual(["CREATED", "TOUCH_LINKED", "STATUS"]);

    // (b) the closure first (in the contract order, uncommitted): the reconciler does not see the contact; afterwards the touch from
    // before the closure is skipped and one after it starts a new lead
    const contact2 = await addContact(f.t.db, f.w.org.id);
    const m2 = await createManualLead(f.w.staff.ctx, { contactId: contact2.id }, deps());
    const beforeClosure = await addTouch(f.t.db, f.w, contact2.id, {
      receivedAt: new Date(Date.now() + 5_000),
    });
    const afterClosure = await addTouch(f.t.db, f.w, contact2.id, {
      receivedAt: new Date(Date.now() + 120_000),
    });
    const closer = await f.t.pool.connect();
    try {
      await closer.query("begin");
      await closer.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        contactLockKey(f.w.org.id, contact2.id),
      ]);
      await closer.query("select id from leads where id = $1 for update", [m2.lead.id]);
      await closer.query(
        "update leads set status = 'INVALID', revision = 1, closed_at = now() + interval '10 seconds', status_changed_at = clock_timestamp() where id = $1",
        [m2.lead.id],
      );
      await closer.query(
        "insert into lead_events (organization_id, lead_id, contact_id, kind, actor_membership_id, from_status, to_status, revision) values ($1,$2,$3,'STATUS',$4,'NEW','INVALID',1)",
        [f.w.org.id, m2.lead.id, contact2.id, f.w.staff.membershipId],
      );
      expect(await f.run()).toMatchObject({ scanned: 0, processed: 0 });
      await closer.query("commit");
    } finally {
      await closer.query("rollback").catch(() => undefined);
      closer.release();
    }
    expect(await f.run()).toMatchObject({ created: 1, skipped: { beforeCycle: 1 } });
    expect(await linkOf(beforeClosure.id)).toBeNull();
    expect(await linkOf(afterClosure.id)).not.toBeNull();
    expect(await linkOf(afterClosure.id)).not.toBe(m2.lead.id);
    await assertConsistent();
  });

  it("a reconciler and a reopening: the reopening that holds the contact first keeps the reconciler away, and its new cycle decides the touches", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const created = await createManualLead(f.w.staff.ctx, { contactId: contact.id }, deps());
    await changeLeadStatus(
      f.w.staff.ctx,
      created.lead.id,
      { to: "NO_RESPONSE", expectedRevision: 0 },
      deps(),
    );
    const closedAt = (
      await f.one<{ closed_at: Date }>("select closed_at from leads where id = $1", [
        created.lead.id,
      ])
    ).closed_at;
    // received while the lead was closed (just after the closure), well before the reopening below
    const whileClosed = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(closedAt.getTime() + 5),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const held = await holdContactLock(contact.id);
    let reopening;
    try {
      reopening = settle(
        changeLeadStatus(
          f.w.staff.ctx,
          created.lead.id,
          { to: "QUALIFIED", expectedRevision: 1 },
          deps(),
        ),
      );
      await waitUntilBlocked(f.t, 1);
      expect(await f.run()).toMatchObject({ scanned: 0, processed: 0 }); // the contact's lock is held: not a candidate, no waiting
    } finally {
      await held.done();
    }
    expect((await reopening).ok).toBe(true);
    const reopenedAt = (
      await f.one<{ cycle_started_at: Date }>("select cycle_started_at from leads where id = $1", [
        created.lead.id,
      ])
    ).cycle_started_at;
    const afterReopen = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(reopenedAt.getTime() + 60_000),
    });
    // the touch that arrived while the lead was closed and BEFORE the reopening is skipped, the later one is linked
    expect(whileClosed.receivedAt.getTime()).toBeLessThan(reopenedAt.getTime());
    const report = await f.run();
    expect(report).toMatchObject({ linked: 1, skipped: { beforeCycle: 1 } });
    expect(await linkOf(whileClosed.id)).toBeNull();
    expect(await linkOf(afterReopen.id)).toBe(created.lead.id);
    await assertConsistent();
  });

  it("a reconciler and staff management (suspension, demotion): both orders, no deadlock, no lost write, and the reconciler never waits for staff management", async () => {
    for (const manage of ["suspend", "demote"] as const) {
      const target = manage === "suspend" ? f.w.viewer : f.w.staff;
      const doManage = (): Promise<unknown> =>
        manage === "suspend"
          ? suspendMember(f.w.admin.ctx, { membershipId: target.membershipId }, deps())
          : changeMemberRole(
              f.w.admin.ctx,
              { membershipId: target.membershipId, role: "VIEWER" },
              deps(),
            );

      // (a) the reconciler first: it holds the organization (KEY SHARE) while it waits at the barrier; management waits behind it
      const c1 = await addContact(f.t.db, f.w.org.id);
      const t1 = await addTouch(f.t.db, f.w, c1.id, { receivedAt: minutesAgo(5) });
      const barrier = await holdBarrier(f.t);
      const reconciling = settle(f.run());
      await waitUntilBlocked(f.t, 1);
      const managing = settle<unknown>(doManage());
      await waitUntilBlocked(f.t, 2);
      await barrier.release();
      const [r, m] = await Promise.all([reconciling, managing]);
      expect(code(r)).not.toBe(DEADLOCK);
      expect(code(m)).not.toBe(DEADLOCK);
      expect(r.ok && r.value.created, manage).toBe(1);
      expect(m.ok, manage).toBe(true);
      expect(await linkOf(t1.id)).not.toBeNull();

      // (b) management first: it holds the organization (FOR UPDATE) and waits for a membership row; the reconciler does NOT wait
      // for it: its attempt is "busy" at once, and the touch is handled by the next run
      const other = manage === "suspend" ? f.w.staff : f.w.viewer;
      const c2 = await addContact(f.t.db, f.w.org.id);
      const t2 = await addTouch(f.t.db, f.w, c2.id, { receivedAt: minutesAgo(4) });
      const blocker = await f.t.pool.connect();
      try {
        await blocker.query("begin");
        await blocker.query("select id from organization_memberships where id = $1 for update", [
          other.membershipId,
        ]);
        const managing2 = settle<unknown>(
          manage === "suspend"
            ? suspendMember(f.w.admin.ctx, { membershipId: other.membershipId }, deps())
            : changeMemberRole(
                f.w.admin.ctx,
                { membershipId: other.membershipId, role: "STAFF" },
                deps(),
              ),
        );
        await waitUntilBlocked(f.t, 1);
        const started = Date.now();
        const during = await f.run();
        expect(Date.now() - started).toBeLessThan(2_500);
        expect(during).toMatchObject({
          busy: 0,
          scanned: 0,
          fetched: 0, // the scan itself skips the organization (FOR KEY SHARE ... SKIP LOCKED): the touch is never returned
          created: 0,
          processed: 0,
        });
        expect(await linkOf(t2.id)).toBeNull();
        await blocker.query("commit");
        expect(code(await managing2), manage).not.toBe(DEADLOCK);
        expect((await managing2).ok, manage).toBe(true);
      } finally {
        await blocker.query("rollback").catch(() => undefined);
        blocker.release();
      }
      expect(await f.run()).toMatchObject({ created: 1 });
      expect(await linkOf(t2.id)).not.toBeNull();
      // reset the members the next round uses
      await f.q(
        "update organization_memberships set status = 'ACTIVE', role = case id when $1 then 'VIEWER' when $2 then 'STAFF' else role end where organization_id = $3",
        [f.w.viewer.membershipId, f.w.staff.membershipId, f.w.org.id],
      );
    }
    await assertConsistent();
  });

  it("a reconciler linking a touch and a failure being recorded for it: the failure waits (bounded), finds the touch linked and records nothing; no decision beside a link", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    await injectFailure(f.t, "CREATED");
    await removeBarrier(f.t); // the injected fault fails the first run before it could reach the barrier anyway
    await f.run(); // a RETRY row exists
    await removeFailure(f.t);
    await installBarrier(f.t);
    await makeDue(f.t, touch.id);
    const c = {
      organizationId: f.w.org.id,
      attributionId: touch.id,
      contactId: contact.id,
      receivedKey: "",
    };
    const quick = { ...DEFAULT_OPTIONS, lockTimeoutMs: 400 };

    const barrier = await holdBarrier(f.t);
    const reconciling = settle(f.run());
    await waitUntilBlocked(f.t, 1);
    // another reconciler's failure path, while the first holds the contact: its bounded wait times out, nothing is recorded or charged
    expect(await recordFailure(f.t.db, c, "pg_p0001", quick)).toEqual({ kind: "busy" });
    await barrier.release();
    expect((await reconciling).ok).toBe(true);
    expect(await linkOf(touch.id)).not.toBeNull();
    expect(await count("lead_reconcile_decisions where attribution_id = $1", [touch.id])).toBe(0);
    // afterwards: the touch is linked, there is nothing to record, and no decision appears
    expect(await recordFailure(f.t.db, c, "pg_p0001", quick)).toEqual({ kind: "gone" });
    expect(await count("lead_reconcile_decisions where attribution_id = $1", [touch.id])).toBe(0);
    // and at the database level a RETRY cannot sneak in next to the link (07A): refused
    await expect(
      f.q(
        "insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts, next_attempt_at) values ($1,$2,$3,'RETRY',1, clock_timestamp() + interval '1 hour')",
        [f.w.org.id, touch.id, contact.id],
      ),
    ).rejects.toThrow(/linked touch has no reconcile decision/);
    await assertConsistent();
  });

  it("a row lock held by a writer that does not follow the contract is never waited for: the touch is busy at once, and nothing is lost", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const manual = await createManualLead(f.w.staff.ctx, { contactId: contact.id }, deps());
    const touch = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(Date.now() + 30_000),
    });
    for (const [what, sql, params] of [
      ["the lead row", "select id from leads where id = $1 for update", [manual.lead.id]],
      ["the touch row", "select id from lead_attributions where id = $1 for update", [touch.id]],
      ["the contact row", "select id from contacts where id = $1 for update", [contact.id]],
      [
        "the organization row",
        "select id from organizations where id = $1 for update",
        [f.w.org.id],
      ],
    ] as const) {
      const rogue = await f.t.pool.connect();
      try {
        await rogue.query("begin");
        await rogue.query(sql, params as unknown as unknown[]);
        const started = Date.now();
        const report = await f.run();
        expect(Date.now() - started, what).toBeLessThan(2_500); // the default lock timeout is 3 s: it was not even waited for
        // the organization is skipped by the scan itself, before any touch is examined; every other row is met by the attempt
        if (what === "the organization row")
          expect(report, what).toMatchObject({
            busy: 0,
            scanned: 0,
            fetched: 0,
            linked: 0,
            processed: 0,
          });
        else expect(report, what).toMatchObject({ busy: 1, linked: 0, processed: 0 });
        expect(await linkOf(touch.id), what).toBeNull();
        await rogue.query("commit");
      } finally {
        await rogue.query("rollback").catch(() => undefined);
        rogue.release();
      }
    }
    expect(await f.run()).toMatchObject({ linked: 1 });
    expect(await linkOf(touch.id)).toBe(manual.lead.id);
    await assertConsistent();
  });
});
