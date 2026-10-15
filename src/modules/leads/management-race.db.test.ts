import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { changeMemberRole, suspendMember, type AccessContext } from "@/modules/access";
import { ForbiddenError } from "@/shared/errors/http-errors";
import { changeLeadStatus, createManualLead } from "./index";
import { contactLockKey } from "./locks";
import { addContact, seedLead, world, type World } from "./testing";

// Review B-H1. A lead write holds the actor's ORGANIZATION (FOR KEY SHARE) and then the actor's MEMBERSHIP (FOR SHARE); staff
// management locks the ORGANIZATION (FOR UPDATE) and then the target MEMBERSHIP (FOR UPDATE). Both take organization -> membership,
// so they wait for each other and never deadlock. Before the correction a lead write took the membership first and reached the
// organization row only through the foreign key of its INSERT, which deadlocked (SQLSTATE 40P01) against a suspension or demotion
// of its own actor.
//
// Every scenario uses the ACTUAL services (createManualLead / changeLeadStatus against suspendMember / changeMemberRole) on real
// connections. The order is made by real locks held by the test and observed in pg_stat_activity: no sleeps.

const DEADLOCK = "40P01";

describe("lead writes against staff management (suspension and demotion of the writer)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());

  const deps = () => ({ db: t.db });
  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await t.pool.query(sql, params)).rows[0] as T;
  const settle = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  type Settled = Awaited<ReturnType<typeof settle>>;
  const code = (r: Settled) =>
    r.ok
      ? null
      : ((r.error as { code?: string; cause?: { code?: string } }).cause?.code ??
        (r.error as { code?: string }).code);

  /** Waits until at least `count` backends of this database are blocked on a lock. */
  async function waitUntilBlocked(count: number) {
    for (let i = 0; i < 1000; i++) {
      const r = await one<{ n: number }>(
        "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      );
      if (r.n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`fewer than ${count} statements blocked on a lock`);
  }
  /** A transaction of the test that holds one lock until it is released. */
  async function hold(sql: string, params: unknown[]) {
    const c = await t.pool.connect();
    await c.query("begin");
    await c.query(sql, params);
    return {
      async release() {
        await c.query("commit");
        c.release();
      },
    };
  }

  type Write = "create" | "status";
  type Manage = "suspend" | "demote";

  async function scenario(write: Write) {
    const w = await world(t.db);
    const contact = await addContact(t.db, w.org.id);
    const writer = w.staff; // the member who writes; the target of the management action
    const lead = write === "status" ? await seedLead(t.db, w, contact.id) : null;
    const doWrite = (ctx: AccessContext): Promise<unknown> =>
      write === "create"
        ? createManualLead(ctx, { contactId: contact.id }, deps())
        : changeLeadStatus(ctx, lead!.id, { to: "QUALIFIED", expectedRevision: 0 }, deps());
    const doManage = (kind: Manage): Promise<unknown> =>
      kind === "suspend"
        ? suspendMember(w.admin.ctx, { membershipId: writer.membershipId }, deps())
        : changeMemberRole(
            w.admin.ctx,
            { membershipId: writer.membershipId, role: "VIEWER" },
            deps(),
          );
    const membership = () =>
      one<{ status: string; role: string }>(
        "select status, role from organization_memberships where id = $1",
        [writer.membershipId],
      );
    const holdContact = () =>
      hold("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        contactLockKey(w.org.id, contact.id),
      ]);
    // the target membership row, locked by the test: staff management that takes it waits (after it has locked the organization)
    const holdTargetMembership = () =>
      hold("select id from organization_memberships where id = $1 for update", [
        writer.membershipId,
      ]);
    /** Everything the lead write may have left in the database. */
    const lifecycle = async () => ({
      leads: (
        await t.pool.query(
          "select id, status, revision, closed_at is null as open from leads where contact_id = $1 order by created_at, id",
          [contact.id],
        )
      ).rows,
      events: (
        await t.pool.query(
          "select kind, from_status, to_status, revision, actor_membership_id from lead_events where contact_id = $1 order by created_at, id",
          [contact.id],
        )
      ).rows,
    });
    return {
      w,
      contact,
      writer,
      lead,
      doWrite,
      doManage,
      membership,
      holdContact,
      holdTargetMembership,
      lifecycle,
    };
  }

  for (const write of ["create", "status"] as const)
    for (const manage of ["suspend", "demote"] as const) {
      const name = `${write === "create" ? "lead creation" : "lead status change"} and ${manage === "suspend" ? "suspension" : "demotion"} of the writer`;

      it(`${name}, the lead write first: no deadlock, the write stands, the management then completes and the writer is refused afterwards`, async () => {
        const s = await scenario(write);
        // the lead write holds its actor locks and waits for the contact lock (which the test holds)
        const held = await s.holdContact();
        const writing = settle(s.doWrite(s.writer.ctx));
        await waitUntilBlocked(1);
        // the management action starts now: it needs the organization row, which the lead write holds FOR KEY SHARE
        const managing = settle(s.doManage(manage));
        await waitUntilBlocked(2);
        expect((await s.membership()).status).toBe("ACTIVE"); // not yet
        await held.release();
        const [wrote, managed] = await Promise.all([writing, managing]);

        expect(code(wrote)).not.toBe(DEADLOCK);
        expect(code(managed)).not.toBe(DEADLOCK);
        expect(wrote.ok, "the write was made while the actor was allowed").toBe(true);
        expect(managed.ok, "the management action completed").toBe(true);
        const m = await s.membership();
        if (manage === "suspend") expect(m.status).toBe("SUSPENDED");
        else expect(m.role).toBe("VIEWER");

        // the write is whole: its lead and its history, with the actor
        const after = await s.lifecycle();
        if (write === "create") {
          expect(after.leads).toHaveLength(1);
          expect(after.events.map((e) => e.kind)).toEqual(["CREATED"]);
        } else {
          expect(after.leads).toMatchObject([{ status: "QUALIFIED", revision: 1 }]);
          expect(
            after.events.map((e) => `${e.kind}:${e.from_status}>${e.to_status}@${e.revision}`),
          ).toEqual(["STATUS:NEW>QUALIFIED@1"]);
        }
        expect(after.events.every((e) => e.actor_membership_id === s.writer.membershipId)).toBe(
          true,
        );

        // from now on the same (stale) context is refused, whatever it asks for, and nothing is written
        const again = await settle<unknown>(
          write === "create"
            ? createManualLead(
                s.writer.ctx,
                { contactId: (await addContact(t.db, s.w.org.id)).id },
                deps(),
              )
            : changeLeadStatus(
                s.writer.ctx,
                s.lead!.id,
                { to: "INTERESTED", expectedRevision: 1 },
                deps(),
              ),
        );
        expect(again.ok).toBe(false);
        if (!again.ok) expect(again.error).toBeInstanceOf(ForbiddenError);
        expect(await s.lifecycle()).toEqual(after);
      });

      it(`${name}, the management first: no deadlock, the management completes, and the waiting lead write is refused with nothing left behind`, async () => {
        const s = await scenario(write);
        const before = await s.lifecycle();
        // the management action locks the organization row and then waits for the target membership, which the test holds
        const target = await s.holdTargetMembership();
        const managing = settle(s.doManage(manage));
        await waitUntilBlocked(1);
        // the lead write starts now: it needs the organization row, which the management action holds FOR UPDATE
        const writing = settle(s.doWrite(s.writer.ctx));
        await waitUntilBlocked(2);
        await target.release();
        const [managed, wrote] = await Promise.all([managing, writing]);

        expect(code(managed)).not.toBe(DEADLOCK);
        expect(code(wrote)).not.toBe(DEADLOCK);
        expect(managed.ok, "the management action completed").toBe(true);
        const m = await s.membership();
        if (manage === "suspend") expect(m.status).toBe("SUSPENDED");
        else expect(m.role).toBe("VIEWER");
        // a completed suspension or demotion prevents the lead write that was waiting behind it
        expect(wrote.ok).toBe(false);
        if (!wrote.ok) expect(wrote.error).toBeInstanceOf(ForbiddenError);
        expect(await s.lifecycle()).toEqual(before); // no lead, no status change, no history
      });
    }

  it("lead writes of other members are not delayed by each other or by a management action on a different member", async () => {
    const w = await world(t.db);
    const contact = await addContact(t.db, w.org.id);
    const other = await addContact(t.db, w.org.id);
    // two writers and two management actions on another member, all at once: nothing deadlocks
    const results = await Promise.all([
      settle(createManualLead(w.staff.ctx, { contactId: contact.id }, deps())),
      settle(createManualLead(w.admin.ctx, { contactId: other.id }, deps())),
      settle(
        changeMemberRole(
          w.admin.ctx,
          { membershipId: w.viewer.membershipId, role: "STAFF" },
          deps(),
        ),
      ),
      settle(suspendMember(w.admin.ctx, { membershipId: w.viewer.membershipId }, deps())),
    ]);
    for (const r of results) {
      expect(code(r)).not.toBe(DEADLOCK);
    }
    expect(results[0]!.ok && results[1]!.ok).toBe(true);
    expect(
      (await t.db.select().from(schema.leads).where(eq(schema.leads.contactId, contact.id))).length,
    ).toBe(1);
  });

  it("the organization lock is taken from the authenticated context, never from the request, and is the weakest one that is needed", async () => {
    const w: World = await world(t.db);
    const contact = await addContact(t.db, w.org.id);
    // A lead write holds the organization row only FOR KEY SHARE: another lead write (also KEY SHARE) and a plain read of the
    // organization are not blocked while it waits for the contact lock, but a FOR UPDATE (staff management) is.
    const held = await hold("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      contactLockKey(w.org.id, contact.id),
    ]);
    const writing = settle(createManualLead(w.staff.ctx, { contactId: contact.id }, deps()));
    await waitUntilBlocked(1);
    const probe = await t.pool.connect();
    try {
      await probe.query("begin");
      await probe.query("set local lock_timeout = '300ms'");
      // KEY SHARE and a plain read go through
      await probe.query("select id from organizations where id = $1 for key share", [w.org.id]);
      await probe.query("select id from organizations where id = $1", [w.org.id]);
      // FOR NO KEY UPDATE and FOR UPDATE conflict only with FOR UPDATE / FOR NO KEY UPDATE; KEY SHARE is compatible with NO KEY UPDATE
      await probe.query("select id from organizations where id = $1 for no key update", [w.org.id]);
      await probe.query("rollback");
      await probe.query("begin");
      await probe.query("set local lock_timeout = '300ms'");
      await expect(
        probe.query("select id from organizations where id = $1 for update", [w.org.id]),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await probe.query("rollback").catch(() => undefined);
      probe.release();
    }
    await held.release();
    expect((await writing).ok).toBe(true);
  });
});
