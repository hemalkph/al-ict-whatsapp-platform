import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, pgError, type TestDb } from "@/db/__tests__/helpers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import { changeLeadStatus, createManualLead, LeadConflictError } from "./index";
import { contactLockKey } from "./locks";
import { addActor, addContact, addTouch, linkTouch, minutesAgo, seedLead, world } from "./testing";
import type { World } from "./testing";

// The lead services on REAL PostgreSQL (a disposable database): manual creation and status changes, with the database's own rules
// (migration 0006) underneath. Ordering between transactions is made by real locks (an advisory lock held by the test, observed
// through pg_stat_activity), never by sleeping for a guessed time.

describe("lead services: manual creation and status changes", () => {
  let t: TestDb;
  const fetchSpy = vi.fn(() => {
    throw new Error("a lead service must never make a network request");
  });
  beforeAll(async () => {
    t = await createTestDatabase();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.clearAllMocks());
  afterAll(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  const deps = () => ({ db: t.db });
  const q = (sql: string, params: unknown[] = []) => t.pool.query(sql, params);
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q(sql, params)).rows[0] as T;

  /** Waits until at least `count` backends of this database are blocked on a lock. */
  async function waitUntilBlocked(count = 1) {
    for (let i = 0; i < 1000; i++) {
      const r = await one<{ n: number }>(
        "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      );
      if (r.n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`fewer than ${count} statements blocked on a lock`);
  }
  /** Holds the contact's advisory lock (what every lead writer takes first) in a transaction of the test. */
  async function holdContactLock(w: World, contactId: string = w.contact.id) {
    const c = await t.pool.connect();
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      contactLockKey(w.org.id, contactId),
    ]);
    return {
      c,
      /** Commits and returns the DATABASE time (microsecond text) read just before the lock was released. */
      async release() {
        const at = (await c.query("select clock_timestamp()::text as t")).rows[0].t as string;
        await c.query("commit");
        c.release();
        return at;
      },
    };
  }
  /** Waits (on the database clock, not a fixed sleep) until the database time is `ms` past `since`. */
  async function untilPast(since: string, ms: number) {
    for (let i = 0; i < 1000; i++) {
      const r = await one<{ ok: boolean }>(
        "select clock_timestamp() > $1::timestamptz + ($2 || ' milliseconds')::interval as ok",
        [since, String(ms)],
      );
      if (r.ok) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the database clock did not advance");
  }
  const dbNow = async () => (await one<{ t: string }>("select clock_timestamp()::text as t")).t;
  const isAfter = async (column: string, id: string, instant: string, table = "leads") =>
    (
      await one<{ ok: boolean }>(
        `select ${column} >= $2::timestamptz as ok from ${table} where id = $1`,
        [id, instant],
      )
    ).ok;
  const settle = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

  const leadRow = (id: string) =>
    one<{
      status: string;
      revision: number;
      closed_at: Date | null;
      cycle_started_at: Date;
      status_changed_at: Date;
      created_at: Date;
      initiating_attribution_id: string | null;
    }>("select * from leads where id = $1", [id]);
  const events = async (leadId: string) =>
    (
      await q(
        "select kind, origin, from_status, to_status, revision, attribution_id, actor_membership_id, created_at from lead_events where lead_id = $1 order by created_at, id",
        [leadId],
      )
    ).rows;
  const leadCount = async (contactId: string) =>
    (
      await one<{ n: number }>("select count(*)::int n from leads where contact_id = $1", [
        contactId,
      ])
    ).n;
  const openCount = async (contactId: string) =>
    (
      await one<{ n: number }>(
        "select count(*)::int n from leads where contact_id = $1 and closed_at is null",
        [contactId],
      )
    ).n;
  const conflict = async (p: Promise<unknown>, code: string) => {
    const r = await settle(p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(LeadConflictError);
      expect((r.error as LeadConflictError).code).toBe(code);
      expect((r.error as LeadConflictError).httpStatus).toBe(409);
    }
  };

  // -------------------------------------------------------------------------------------------- manual creation
  describe("manual lead creation", () => {
    it("creates exactly one NEW lead at revision 0, with a MANUAL CREATED event for the actor, and nothing else", async () => {
      const w = await world(t.db);
      const before = {
        messages: (await one<{ n: number }>("select count(*)::int n from messages")).n,
        outbound: (await one<{ n: number }>("select count(*)::int n from outbound_requests")).n,
        consents: (await one<{ n: number }>("select count(*)::int n from contact_consents")).n,
      };
      const result = await createManualLead(w.staff.ctx, { contactId: w.contact.id }, deps());
      expect(result.created).toBe(true);
      expect(result.lead).toMatchObject({
        status: "NEW",
        revision: 0,
        open: true,
        readOnly: false,
        source: { kind: "NONE", label: "No advertisement referral recorded", linkedTouches: 0 },
        contact: { id: w.contact.id, archived: false },
      });
      const row = await leadRow(result.lead.id);
      expect(row).toMatchObject({
        status: "NEW",
        revision: 0,
        closed_at: null,
        initiating_attribution_id: null,
      });
      expect(await leadCount(w.contact.id)).toBe(1);
      const ev = await events(result.lead.id);
      expect(ev).toEqual([
        {
          kind: "CREATED",
          origin: "MANUAL",
          from_status: null,
          to_status: null,
          revision: 0,
          attribution_id: null,
          actor_membership_id: w.staff.membershipId,
          created_at: row.created_at,
        },
      ]);
      // one reading of the database clock stamps the whole creation
      expect(row.cycle_started_at).toEqual(row.created_at);
      expect(row.status_changed_at).toEqual(row.created_at);
      // no message, no outbound request, no consent
      expect((await one<{ n: number }>("select count(*)::int n from messages")).n).toBe(
        before.messages,
      );
      expect((await one<{ n: number }>("select count(*)::int n from outbound_requests")).n).toBe(
        before.outbound,
      );
      expect((await one<{ n: number }>("select count(*)::int n from contact_consents")).n).toBe(
        before.consents,
      );
      expect(
        (
          await one<{ marketing_consent_status: string }>(
            "select marketing_consent_status from contacts where id = $1",
            [w.contact.id],
          )
        ).marketing_consent_status,
      ).toBe("UNKNOWN");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("ADMIN and STAFF may create; VIEWER may not, and nothing is written", async () => {
      const w = await world(t.db);
      const a = await addContact(t.db, w.org.id);
      const b = await addContact(t.db, w.org.id);
      const c = await addContact(t.db, w.org.id);
      expect((await createManualLead(w.admin.ctx, { contactId: a.id }, deps())).created).toBe(true);
      expect((await createManualLead(w.staff.ctx, { contactId: b.id }, deps())).created).toBe(true);
      await expect(
        createManualLead(w.viewer.ctx, { contactId: c.id }, deps()),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await leadCount(c.id)).toBe(0);
    });

    it("an existing open lead is returned unchanged: no second lead and no duplicate history (every open status)", async () => {
      const w = await world(t.db);
      for (const status of schema.OPEN_LEAD_STATUSES) {
        const contact = await addContact(t.db, w.org.id);
        const existing = await seedLead(t.db, w, contact.id, { status });
        const result = await createManualLead(w.staff.ctx, { contactId: contact.id }, deps());
        expect(result.created).toBe(false);
        expect(result.lead.id).toBe(existing.id);
        expect(result.lead.status).toBe(status);
        expect(await leadCount(contact.id)).toBe(1);
        expect(await events(existing.id)).toEqual([]);
      }
      // asking twice for a fresh one yields the same lead
      const contact = await addContact(t.db, w.org.id);
      const first = await createManualLead(w.staff.ctx, { contactId: contact.id }, deps());
      const second = await createManualLead(w.staff.ctx, { contactId: contact.id }, deps());
      expect([first.created, second.created]).toEqual([true, false]);
      expect(second.lead.id).toBe(first.lead.id);
      expect(await events(first.lead.id)).toHaveLength(1);
    });

    it("when every earlier lead is closed (a converted contact included) staff may create a new one; the old ones stay as they were", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const converted = await seedLead(t.db, w, contact.id, { status: "CONVERTED" });
      const dropped = await seedLead(t.db, w, contact.id, { status: "NOT_INTERESTED" });
      const result = await createManualLead(w.staff.ctx, { contactId: contact.id }, deps());
      expect(result.created).toBe(true);
      expect([converted.id, dropped.id]).not.toContain(result.lead.id);
      expect(await leadCount(contact.id)).toBe(3);
      expect(await openCount(contact.id)).toBe(1);
      expect((await leadRow(converted.id)).status).toBe("CONVERTED");
      expect((await leadRow(dropped.id)).status).toBe("NOT_INTERESTED");
    });

    it("concurrent creations produce exactly one lead and one CREATED event, and every caller gets that lead", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          createManualLead((i % 2 ? w.staff : w.admin).ctx, { contactId: contact.id }, deps()),
        ),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.lead.id)).size).toBe(1);
      expect(await leadCount(contact.id)).toBe(1);
      expect(await events(results[0]!.lead.id)).toHaveLength(1);
    });

    it("two creations ordered by a real lock: the first creates, the second waits and then returns the same lead", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const held = await holdContactLock(w, contact.id);
      const first = settle(createManualLead(w.staff.ctx, { contactId: contact.id }, deps()));
      const second = settle(createManualLead(w.admin.ctx, { contactId: contact.id }, deps()));
      await waitUntilBlocked(2);
      await held.release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) {
        expect([a.value.created, b.value.created].sort()).toEqual([false, true]);
        expect(a.value.lead.id).toBe(b.value.lead.id);
      }
      expect(await leadCount(contact.id)).toBe(1);
    });

    it("the database backstop: a writer that ignores the lock order and holds an uncommitted open lead makes the service return that lead", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const rogue = await t.pool.connect();
      try {
        await rogue.query("begin");
        // no advisory lock, no history: only the partial unique index stands in the way
        const inserted = (
          await rogue.query(
            "insert into leads (organization_id, contact_id) values ($1, $2) returning id",
            [w.org.id, contact.id],
          )
        ).rows[0].id as string;
        const creating = settle(createManualLead(w.staff.ctx, { contactId: contact.id }, deps()));
        await waitUntilBlocked(); // the service's INSERT waits for the rogue transaction on the unique index
        await rogue.query("commit");
        const r = await creating;
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value.created).toBe(false);
          expect(r.value.lead.id).toBe(inserted);
        }
      } finally {
        await rogue.query("rollback").catch(() => undefined);
        rogue.release();
      }
      expect(await leadCount(contact.id)).toBe(1);
    });

    it("an archived contact is refused (nothing written); a BSUID-only contact works", async () => {
      const w = await world(t.db);
      const archived = await addContact(t.db, w.org.id, { archived: true });
      await conflict(
        createManualLead(w.staff.ctx, { contactId: archived.id }, deps()),
        "CONTACT_ARCHIVED",
      );
      expect(await leadCount(archived.id)).toBe(0);

      const bsuidOnly = await addContact(t.db, w.org.id, {
        waId: null,
        bsuid: "US.13491208655302741918",
        profileName: "Nimal",
      });
      const result = await createManualLead(w.staff.ctx, { contactId: bsuidOnly.id }, deps());
      expect(result.created).toBe(true);
      expect(result.lead.contact.label).toMatchObject({ displayName: "Nimal", idHint: "…1918" });
      expect(await events(result.lead.id)).toHaveLength(1);
    });

    it("another organization's contact and a malformed id are refused without revealing anything", async () => {
      const a = await world(t.db);
      const b = await world(t.db);
      await expect(
        createManualLead(a.staff.ctx, { contactId: b.contact.id }, deps()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        createManualLead(
          a.staff.ctx,
          { contactId: "00000000-0000-4000-8000-000000000001" },
          deps(),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        createManualLead(a.staff.ctx, { contactId: "not-a-uuid" }, deps()),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await leadCount(b.contact.id)).toBe(0);
    });

    it("the client can supply nothing but the contact: every lifecycle, history and tenant field is refused by name", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const forged: Record<string, unknown> = {
        cycleStartedAt: "2020-01-01T00:00:00Z",
        cycle_started_at: "2020-01-01T00:00:00Z",
        closedAt: null,
        statusChangedAt: "2020-01-01T00:00:00Z",
        createdAt: "2020-01-01T00:00:00Z",
        updatedAt: "2020-01-01T00:00:00Z",
        revision: 7,
        status: "QUALIFIED",
        origin: "AD_REFERRAL",
        organizationId: w.org.id,
        initiatingAttributionId: "00000000-0000-4000-8000-000000000001",
        attributionId: "00000000-0000-4000-8000-000000000001",
        events: [{ kind: "STATUS" }],
        kind: "CREATED",
        actorMembershipId: w.admin.membershipId,
      };
      for (const [key, value] of Object.entries(forged)) {
        const r = await settle(
          createManualLead(w.staff.ctx, { contactId: contact.id, [key]: value }, deps()),
        );
        expect(r.ok, key).toBe(false);
        if (!r.ok) {
          expect(r.error, key).toBeInstanceOf(ValidationError);
          expect((r.error as ValidationError).fields, key).toContain(key);
        }
      }
      for (const body of [null, "x", [], {}, { contactId: 5 }])
        await expect(createManualLead(w.staff.ctx, body, deps())).rejects.toBeInstanceOf(
          ValidationError,
        );
      expect(await leadCount(contact.id)).toBe(0);
    });

    it("a manual lead claims no earlier attribution: nothing is linked, no TOUCH_LINKED history, no origin touch", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const older = await addTouch(t.db, w, contact.id, { receivedAt: minutesAgo(600) });
      const recent = await addTouch(t.db, w, contact.id, { receivedAt: minutesAgo(1) });
      const result = await createManualLead(w.staff.ctx, { contactId: contact.id }, deps());
      expect(result.lead.source).toMatchObject({ kind: "NONE", linkedTouches: 0 });
      const touches = (
        await q("select id, lead_id from lead_attributions where contact_id = $1", [contact.id])
      ).rows;
      expect(touches).toHaveLength(2);
      for (const touch of touches) expect(touch.lead_id).toBeNull();
      expect([older.id, recent.id].sort()).toEqual(touches.map((x) => x.id as string).sort());
      expect((await events(result.lead.id)).map((e) => e.kind)).toEqual(["CREATED"]);
      expect((await leadRow(result.lead.id)).initiating_attribution_id).toBeNull();
    });

    it("the creation time is read from the database clock AFTER the contact lock: a request that waited is not stamped with its start", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const held = await holdContactLock(w, contact.id);
      const startedWaiting = await dbNow();
      const creating = settle(createManualLead(w.staff.ctx, { contactId: contact.id }, deps()));
      await waitUntilBlocked();
      await untilPast(startedWaiting, 300); // the request has been waiting for at least 300 ms of database time
      const released = await held.release();
      const r = await creating;
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const id = r.value.lead.id;
      // every lifecycle stamp is later than the release (so, taken after the lock) and later than the start of the wait by the wait
      for (const column of ["cycle_started_at", "created_at", "status_changed_at", "updated_at"])
        expect(await isAfter(column, id, released), column).toBe(true);
      const waited = await one<{ ok: boolean }>(
        "select cycle_started_at > $2::timestamptz + interval '250 milliseconds' as ok from leads where id = $1",
        [id, startedWaiting],
      );
      expect(waited.ok).toBe(true);
      const ev = await events(id);
      expect((await leadRow(id)).cycle_started_at).toEqual(ev[0]!.created_at);
    });

    it("the creation is attributed to the database clock, not to the client's: a skewed JavaScript clock changes nothing", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
      let created;
      try {
        created = await createManualLead(w.staff.ctx, { contactId: contact.id }, deps());
      } finally {
        vi.useRealTimers();
      }
      const row = await leadRow(created.lead.id);
      expect(row.cycle_started_at.getFullYear()).toBeGreaterThan(2024);
      expect(row.created_at.getFullYear()).toBeGreaterThan(2024);
    });
  });

  // ------------------------------------------------------------------------------------------------ actor checks
  describe("the actor is checked inside the transaction", () => {
    it("a suspended or demoted actor is refused by every write, and nothing is written", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const open = await seedLead(t.db, w, (await addContact(t.db, w.org.id)).id);
      const suspended = await addActor(t.db, w.org.id, "STAFF");
      const demoted = await addActor(t.db, w.org.id, "STAFF");
      await t.db
        .update(schema.organizationMemberships)
        .set({ status: "SUSPENDED" })
        .where(eq(schema.organizationMemberships.id, suspended.membershipId));
      await t.db
        .update(schema.organizationMemberships)
        .set({ role: "VIEWER" })
        .where(eq(schema.organizationMemberships.id, demoted.membershipId));
      // the contexts were built before the change and still claim STAFF
      for (const actor of [suspended, demoted]) {
        await expect(
          createManualLead(actor.ctx, { contactId: contact.id }, deps()),
        ).rejects.toBeInstanceOf(ForbiddenError);
        await expect(
          changeLeadStatus(actor.ctx, open.id, { to: "QUALIFIED", expectedRevision: 0 }, deps()),
        ).rejects.toBeInstanceOf(ForbiddenError);
      }
      expect(await leadCount(contact.id)).toBe(0);
      expect((await leadRow(open.id)).status).toBe("NEW");
    });

    it("a suspension that arrives while the write waits for its lock waits for the write (it is serialized after it)", async () => {
      for (const kind of ["create", "status"] as const) {
        const w = await world(t.db);
        const actor = await addActor(t.db, w.org.id, "STAFF");
        const contact = await addContact(t.db, w.org.id);
        const existing = kind === "status" ? await seedLead(t.db, w, contact.id) : null;
        const held = await holdContactLock(w, contact.id);
        const writing = settle<unknown>(
          kind === "create"
            ? createManualLead(actor.ctx, { contactId: contact.id }, deps())
            : changeLeadStatus(
                actor.ctx,
                existing!.id,
                { to: "QUALIFIED", expectedRevision: 0 },
                deps(),
              ),
        );
        await waitUntilBlocked(); // the write holds the actor's membership FOR SHARE and waits for the contact lock
        const suspending = settle(
          t.db
            .update(schema.organizationMemberships)
            .set({ status: "SUSPENDED" })
            .where(eq(schema.organizationMemberships.id, actor.membershipId)),
        );
        await waitUntilBlocked(2); // the suspension waits for the write to finish
        await held.release();
        const [written, suspended] = await Promise.all([writing, suspending]);
        expect(written.ok, kind).toBe(true); // made while the actor was still allowed
        expect(suspended.ok, kind).toBe(true);
        expect(
          (
            await one<{ status: string }>(
              "select status from organization_memberships where id = $1",
              [actor.membershipId],
            )
          ).status,
        ).toBe("SUSPENDED");
        expect(await leadCount(contact.id)).toBe(1);
        // from now on the same actor is refused
        await expect(
          changeLeadStatus(
            actor.ctx,
            (await q("select id from leads where contact_id = $1", [contact.id])).rows[0].id,
            { to: "INTERESTED", expectedRevision: kind === "create" ? 0 : 1 },
            deps(),
          ),
        ).rejects.toBeInstanceOf(ForbiddenError);
      }
    });
  });

  // --------------------------------------------------------------------------------------------- status changes
  describe("status changes", () => {
    it("staff move a lead between the settable statuses: each change is revision + 1 with its STATUS event for the actor", async () => {
      const w = await world(t.db);
      const lead = await seedLead(t.db, w, w.contact.id, { cycleStartedAt: minutesAgo(30) });
      const path: Array<(typeof schema.STAFF_SETTABLE_LEAD_STATUSES)[number]> = [
        "QUALIFIED",
        "INTERESTED",
        "NEW",
        "NOT_INTERESTED",
        "NO_RESPONSE",
        "INVALID",
        "QUALIFIED",
      ];
      let revision = 0;
      let from = "NEW";
      for (const to of path) {
        const actor = revision % 2 ? w.admin : w.staff;
        const r = await changeLeadStatus(
          actor.ctx,
          lead.id,
          { to, expectedRevision: revision },
          deps(),
        );
        revision++;
        expect(r).toMatchObject({ changed: true, lead: { id: lead.id, status: to, revision } });
        expect((await events(lead.id)).at(-1)).toMatchObject({
          kind: "STATUS",
          from_status: from,
          to_status: to,
          revision,
          actor_membership_id: actor.membershipId,
          origin: null,
          attribution_id: null,
        });
        from = to;
      }
      expect(await leadRow(lead.id)).toMatchObject({ status: "QUALIFIED", revision: 7 });
      expect((await events(lead.id)).filter((e) => e.kind === "STATUS")).toHaveLength(7);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("a change to the same status writes nothing and does not move the revision", async () => {
      const w = await world(t.db);
      const lead = await seedLead(t.db, w, w.contact.id);
      const r = await changeLeadStatus(
        w.staff.ctx,
        lead.id,
        { to: "NEW", expectedRevision: 0 },
        deps(),
      );
      expect(r).toMatchObject({ changed: false, lead: { status: "NEW", revision: 0 } });
      expect(await events(lead.id)).toEqual([]);
      expect((await leadRow(lead.id)).revision).toBe(0);
      // but a stale revision is refused even for the same status: the screen is out of date
      await changeLeadStatus(
        w.staff.ctx,
        lead.id,
        { to: "QUALIFIED", expectedRevision: 0 },
        deps(),
      );
      await conflict(
        changeLeadStatus(w.staff.ctx, lead.id, { to: "QUALIFIED", expectedRevision: 0 }, deps()),
        "STALE_STATE",
      );
    });

    it("reserved statuses cannot be set: they are not even accepted as a target", async () => {
      const w = await world(t.db);
      const lead = await seedLead(t.db, w, w.contact.id);
      for (const to of [...schema.RESERVED_LEAD_STATUSES, "BOGUS", "new", "", null, 3]) {
        const r = await settle(
          changeLeadStatus(w.admin.ctx, lead.id, { to, expectedRevision: 0 }, deps()),
        );
        expect(r.ok, String(to)).toBe(false);
        if (!r.ok) {
          expect(r.error, String(to)).toBeInstanceOf(ValidationError);
          expect((r.error as ValidationError).fields).toEqual(["to"]);
        }
      }
      expect(await leadRow(lead.id)).toMatchObject({ status: "NEW", revision: 0 });
      expect(await events(lead.id)).toEqual([]);
    });

    it("a lead already in a reserved status is read-only to staff (administrators included), whatever the target", async () => {
      const w = await world(t.db);
      for (const status of schema.RESERVED_LEAD_STATUSES) {
        const contact = await addContact(t.db, w.org.id);
        const lead = await seedLead(t.db, w, contact.id, { status });
        for (const to of schema.STAFF_SETTABLE_LEAD_STATUSES)
          await conflict(
            changeLeadStatus(w.admin.ctx, lead.id, { to, expectedRevision: 0 }, deps()),
            "RESERVED_STATUS",
          );
        expect(await leadRow(lead.id)).toMatchObject({ status, revision: 0 });
        expect(await events(lead.id)).toEqual([]);
      }
    });

    it("the revision is a real compare-and-set: a stale request is refused, also when the status came back to what the screen saw", async () => {
      const w = await world(t.db);
      const lead = await seedLead(t.db, w, w.contact.id);
      await changeLeadStatus(
        w.staff.ctx,
        lead.id,
        { to: "QUALIFIED", expectedRevision: 0 },
        deps(),
      );
      await conflict(
        changeLeadStatus(w.admin.ctx, lead.id, { to: "INTERESTED", expectedRevision: 0 }, deps()),
        "STALE_STATE",
      );
      // A -> B -> A: the status looks unchanged to a screen that saw revision 0, but the revision moved twice
      await changeLeadStatus(w.staff.ctx, lead.id, { to: "NEW", expectedRevision: 1 }, deps());
      expect((await leadRow(lead.id)).status).toBe("NEW");
      await conflict(
        changeLeadStatus(w.admin.ctx, lead.id, { to: "NO_RESPONSE", expectedRevision: 0 }, deps()),
        "STALE_STATE",
      );
      await conflict(
        changeLeadStatus(w.admin.ctx, lead.id, { to: "NO_RESPONSE", expectedRevision: 99 }, deps()),
        "STALE_STATE",
      );
      expect(await leadRow(lead.id)).toMatchObject({ status: "NEW", revision: 2 });
      expect((await events(lead.id)).filter((e) => e.kind === "STATUS")).toHaveLength(2);
    });

    it("simultaneous changes from the same revision: exactly one wins, the rest are 409, one event is written", async () => {
      const w = await world(t.db);
      const lead = await seedLead(t.db, w, w.contact.id);
      const targets = [
        "QUALIFIED",
        "INTERESTED",
        "NOT_INTERESTED",
        "NO_RESPONSE",
        "INVALID",
        "QUALIFIED",
      ] as const;
      const results = await Promise.all(
        targets.map((to, i) =>
          settle(
            changeLeadStatus(
              (i % 2 ? w.admin : w.staff).ctx,
              lead.id,
              { to, expectedRevision: 0 },
              deps(),
            ),
          ),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results)
        if (!r.ok) {
          expect(r.error).toBeInstanceOf(LeadConflictError);
          expect((r.error as LeadConflictError).code).toBe("STALE_STATE");
        }
      expect((await leadRow(lead.id)).revision).toBe(1);
      expect((await events(lead.id)).filter((e) => e.kind === "STATUS")).toHaveLength(1);
    });

    it("closing sets closed_at from the database clock; moving between closed statuses keeps it; reopening starts a new cycle at the reopening time", async () => {
      const w = await world(t.db);
      const lead = await seedLead(t.db, w, w.contact.id, { cycleStartedAt: minutesAgo(60) });
      const before = await dbNow();
      await changeLeadStatus(
        w.staff.ctx,
        lead.id,
        { to: "NO_RESPONSE", expectedRevision: 0 },
        deps(),
      );
      const closed = await leadRow(lead.id);
      expect(closed.closed_at).not.toBeNull();
      expect(await isAfter("closed_at", lead.id, before)).toBe(true);
      expect(closed.closed_at).toEqual(closed.status_changed_at);
      expect(closed.cycle_started_at).toEqual(lead.cycleStartedAt);

      await changeLeadStatus(
        w.staff.ctx,
        lead.id,
        { to: "NOT_INTERESTED", expectedRevision: 1 },
        deps(),
      );
      const moved = await leadRow(lead.id);
      expect(moved.status).toBe("NOT_INTERESTED");
      expect(moved.closed_at).toEqual(closed.closed_at); // the start of the closed period does not move
      expect(moved.cycle_started_at).toEqual(closed.cycle_started_at);

      const reopening = await dbNow();
      await changeLeadStatus(
        w.staff.ctx,
        lead.id,
        { to: "QUALIFIED", expectedRevision: 2 },
        deps(),
      );
      const reopened = await leadRow(lead.id);
      expect(reopened).toMatchObject({ status: "QUALIFIED", revision: 3, closed_at: null });
      expect(await isAfter("cycle_started_at", lead.id, reopening)).toBe(true);
      expect(reopened.cycle_started_at).toEqual(reopened.status_changed_at);
      expect(reopened.cycle_started_at.getTime()).toBeGreaterThan(moved.closed_at!.getTime());
      // the whole story is in the history, in order
      expect(
        (await events(lead.id)).map((e) => `${e.from_status}>${e.to_status}@${e.revision}`),
      ).toEqual([
        "NEW>NO_RESPONSE@1",
        "NO_RESPONSE>NOT_INTERESTED@2",
        "NOT_INTERESTED>QUALIFIED@3",
      ]);
    });

    it("another open lead of the contact blocks a reopening: ALREADY_OPEN, nothing changed, nothing written", async () => {
      const w = await world(t.db);
      const closed = await seedLead(t.db, w, w.contact.id, {
        status: "NO_RESPONSE",
        cycleStartedAt: minutesAgo(30),
        closedAt: minutesAgo(10),
      });
      const open = await seedLead(t.db, w, w.contact.id, { status: "INTERESTED" });
      for (const to of ["NEW", "QUALIFIED", "INTERESTED"] as const)
        await conflict(
          changeLeadStatus(w.staff.ctx, closed.id, { to, expectedRevision: 0 }, deps()),
          "ALREADY_OPEN",
        );
      expect(await leadRow(closed.id)).toMatchObject({ status: "NO_RESPONSE", revision: 0 });
      expect(await events(closed.id)).toEqual([]);
      expect(await openCount(w.contact.id)).toBe(1);
      // moving the closed lead to another closed status is still allowed
      await changeLeadStatus(
        w.staff.ctx,
        closed.id,
        { to: "INVALID", expectedRevision: 0 },
        deps(),
      );
      // once the other lead is closed, the reopening works
      await changeLeadStatus(
        w.staff.ctx,
        open.id,
        { to: "NOT_INTERESTED", expectedRevision: 0 },
        deps(),
      );
      await changeLeadStatus(w.staff.ctx, closed.id, { to: "NEW", expectedRevision: 1 }, deps());
      expect(await openCount(w.contact.id)).toBe(1);
    });

    it("the database backstop: a reopening that races an uncommitted open lead of a writer that ignores the lock order is ALREADY_OPEN", async () => {
      const w = await world(t.db);
      const closed = await seedLead(t.db, w, w.contact.id, {
        status: "NO_RESPONSE",
        cycleStartedAt: minutesAgo(30),
        closedAt: minutesAgo(10),
      });
      const rogue = await t.pool.connect();
      try {
        await rogue.query("begin");
        await rogue.query("insert into leads (organization_id, contact_id) values ($1, $2)", [
          w.org.id,
          w.contact.id,
        ]);
        const reopening = settle(
          changeLeadStatus(w.staff.ctx, closed.id, { to: "NEW", expectedRevision: 0 }, deps()),
        );
        await waitUntilBlocked(); // its UPDATE waits on the unique index
        await rogue.query("commit");
        const r = await reopening;
        expect(r.ok).toBe(false);
        if (!r.ok) expect((r.error as LeadConflictError).code).toBe("ALREADY_OPEN");
      } finally {
        await rogue.query("rollback").catch(() => undefined);
        rogue.release();
      }
      expect(await leadRow(closed.id)).toMatchObject({ status: "NO_RESPONSE", revision: 0 });
      expect(await events(closed.id)).toEqual([]);
      expect(await openCount(w.contact.id)).toBe(1);
    });

    it("lifecycle times that are ahead of the database clock (a skewed receipt time) never break the database's rules", async () => {
      const w = await world(t.db);
      // an automatic lead whose cycle starts at a receipt time slightly in the future of this database clock
      const future = new Date(Date.now() + 10 * 60_000);
      const lead = await seedLead(t.db, w, w.contact.id, { cycleStartedAt: future });
      await changeLeadStatus(
        w.staff.ctx,
        lead.id,
        { to: "NO_RESPONSE", expectedRevision: 0 },
        deps(),
      );
      const closed = await leadRow(lead.id);
      expect(closed.closed_at!.getTime()).toBeGreaterThanOrEqual(closed.cycle_started_at.getTime());
      // the conservative boundary is held back to the stored (future) cycle start ...
      expect(closed.closed_at!.getTime()).toBeGreaterThan(closed.status_changed_at.getTime());
      expect(closed.closed_at).toEqual(closed.cycle_started_at);
      // ... while the status time and the history row carry the real action time, and are never later than the boundary
      const closing = (await events(lead.id)).at(-1)!;
      expect(closing.created_at).toEqual(closed.status_changed_at);
      expect(closed.status_changed_at.getTime()).toBeLessThan(Date.now() + 5_000);
      await changeLeadStatus(
        w.staff.ctx,
        lead.id,
        { to: "QUALIFIED", expectedRevision: 1 },
        deps(),
      );
      const reopened = await leadRow(lead.id);
      expect(reopened.cycle_started_at.getTime()).toBeGreaterThanOrEqual(
        closed.closed_at!.getTime(),
      );
      // the reopened cycle also keeps the later boundary, and its history row the real action time
      expect(reopened.cycle_started_at).toEqual(closed.closed_at);
      expect((await events(lead.id)).at(-1)!.created_at).toEqual(reopened.status_changed_at);
      expect(reopened.status_changed_at.getTime()).toBeLessThan(
        reopened.cycle_started_at.getTime(),
      );
    });

    it("the transition time is read from the database clock AFTER the locks: a change that waited is not stamped with its start", async () => {
      const w = await world(t.db);
      // closing, then reopening, each after a wait for the contact's lock
      const lead = await seedLead(t.db, w, w.contact.id, { cycleStartedAt: minutesAgo(30) });
      for (const [to, revision] of [
        ["NOT_INTERESTED", 0],
        ["QUALIFIED", 1],
      ] as const) {
        const held = await holdContactLock(w);
        const startedWaiting = await dbNow();
        const changing = settle(
          changeLeadStatus(w.staff.ctx, lead.id, { to, expectedRevision: revision }, deps()),
        );
        await waitUntilBlocked();
        await untilPast(startedWaiting, 300);
        const released = await held.release();
        expect((await changing).ok, to).toBe(true);
        const row = await leadRow(lead.id);
        expect(await isAfter("status_changed_at", lead.id, released), to).toBe(true);
        expect(await isAfter("updated_at", lead.id, released), to).toBe(true);
        expect(row.status_changed_at.getTime(), to).toBeGreaterThan(
          new Date(startedWaiting).getTime() + 250,
        );
        const last = (await events(lead.id)).at(-1)!;
        expect(last.created_at, to).toEqual(row.status_changed_at);
        if (to === "NOT_INTERESTED") expect(row.closed_at).toEqual(row.status_changed_at);
        else expect(row.cycle_started_at).toEqual(row.status_changed_at);
      }
    });

    it("a change that waits behind another one sees that change: the stale request is refused after the wait, not before it", async () => {
      const w = await world(t.db);
      const lead = await seedLead(t.db, w, w.contact.id);
      const held = await holdContactLock(w);
      const first = settle(
        changeLeadStatus(w.staff.ctx, lead.id, { to: "QUALIFIED", expectedRevision: 0 }, deps()),
      );
      await waitUntilBlocked();
      const second = settle(
        changeLeadStatus(w.admin.ctx, lead.id, { to: "INTERESTED", expectedRevision: 0 }, deps()),
      );
      await waitUntilBlocked(2);
      await held.release();
      const [a, b] = await Promise.all([first, second]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect((await leadRow(lead.id)).revision).toBe(1);
    });

    it("a client can supply nothing but the target and the revision it saw: every other field is refused by name", async () => {
      const w = await world(t.db);
      const lead = await seedLead(t.db, w, w.contact.id);
      const base = { to: "QUALIFIED", expectedRevision: 0 };
      const forged: Record<string, unknown> = {
        cycleStartedAt: "2020-01-01T00:00:00Z",
        closedAt: "2020-01-01T00:00:00Z",
        statusChangedAt: "2020-01-01T00:00:00Z",
        createdAt: "2020-01-01T00:00:00Z",
        revision: 5,
        from: "NEW",
        fromStatus: "NEW",
        actorMembershipId: w.admin.membershipId,
        organizationId: w.org.id,
        contactId: w.contact.id,
        kind: "STATUS",
        origin: "MANUAL",
        attributionId: "00000000-0000-4000-8000-000000000001",
      };
      for (const [key, value] of Object.entries(forged)) {
        const r = await settle(
          changeLeadStatus(w.staff.ctx, lead.id, { ...base, [key]: value }, deps()),
        );
        expect(r.ok, key).toBe(false);
        if (!r.ok) {
          expect(r.error, key).toBeInstanceOf(ValidationError);
          expect((r.error as ValidationError).fields, key).toContain(key);
        }
      }
      for (const bad of [
        { to: "QUALIFIED" },
        { expectedRevision: 0 },
        { to: "QUALIFIED", expectedRevision: "0" },
        { to: "QUALIFIED", expectedRevision: -1 },
        { to: "QUALIFIED", expectedRevision: 0.5 },
        { to: "QUALIFIED", expectedRevision: 2 ** 31 },
        { to: "QUALIFIED", expectedRevision: null },
      ])
        await expect(changeLeadStatus(w.staff.ctx, lead.id, bad, deps())).rejects.toBeInstanceOf(
          ValidationError,
        );
      expect(await leadRow(lead.id)).toMatchObject({ status: "NEW", revision: 0 });
      expect(await events(lead.id)).toEqual([]);
    });

    it("a VIEWER cannot change a status; another organization's lead and a malformed id are the same 404", async () => {
      const a = await world(t.db);
      const b = await world(t.db);
      const lead = await seedLead(t.db, a, a.contact.id);
      const input = { to: "QUALIFIED", expectedRevision: 0 };
      await expect(changeLeadStatus(a.viewer.ctx, lead.id, input, deps())).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(changeLeadStatus(b.admin.ctx, lead.id, input, deps())).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        changeLeadStatus(a.admin.ctx, "00000000-0000-4000-8000-000000000001", input, deps()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        changeLeadStatus(a.admin.ctx, "not-a-uuid", input, deps()),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await leadRow(lead.id)).toMatchObject({ status: "NEW", revision: 0 });
      expect(await events(lead.id)).toEqual([]);
    });
  });

  // ------------------------------------------------------------------------------- creation versus other writers
  describe("creation racing a state change of the contact's open lead", () => {
    it("a closing that holds the contact lock first: the creation then sees no open lead and creates the new one", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const open = await seedLead(t.db, w, contact.id, { cycleStartedAt: minutesAgo(30) });
      // the closer, written by hand in the contract order: contact lock, lead row, update, history; not committed yet
      const closer = await t.pool.connect();
      try {
        await closer.query("begin");
        await closer.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          contactLockKey(w.org.id, contact.id),
        ]);
        await closer.query("select id from leads where id = $1 for update", [open.id]);
        await closer.query(
          "update leads set status = 'INVALID', revision = revision + 1, closed_at = clock_timestamp(), status_changed_at = clock_timestamp() where id = $1",
          [open.id],
        );
        await closer.query(
          "insert into lead_events (organization_id, lead_id, contact_id, kind, actor_membership_id, from_status, to_status, revision) values ($1,$2,$3,'STATUS',$4,'NEW','INVALID',1)",
          [w.org.id, open.id, contact.id, w.admin.membershipId],
        );
        const creating = settle(createManualLead(w.staff.ctx, { contactId: contact.id }, deps()));
        await waitUntilBlocked();
        await closer.query("commit");
        const r = await creating;
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value.created).toBe(true);
          expect(r.value.lead.id).not.toBe(open.id);
        }
      } finally {
        await closer.query("rollback").catch(() => undefined);
        closer.release();
      }
      expect(await leadCount(contact.id)).toBe(2);
      expect(await openCount(contact.id)).toBe(1);
      expect((await leadRow(open.id)).status).toBe("INVALID");
    });

    it("many creations and changes queued on one contact in any order always end with at most one open lead and a consistent history", async () => {
      for (let round = 0; round < 3; round++) {
        const w = await world(t.db);
        const contact = await addContact(t.db, w.org.id);
        const open = await seedLead(t.db, w, contact.id, { cycleStartedAt: minutesAgo(30) });
        const held = await holdContactLock(w, contact.id);
        const work = [
          settle(
            changeLeadStatus(
              w.staff.ctx,
              open.id,
              { to: "NO_RESPONSE", expectedRevision: 0 },
              deps(),
            ),
          ),
          settle(createManualLead(w.admin.ctx, { contactId: contact.id }, deps())),
          settle(createManualLead(w.staff.ctx, { contactId: contact.id }, deps())),
          settle(
            changeLeadStatus(
              w.admin.ctx,
              open.id,
              { to: "QUALIFIED", expectedRevision: 0 },
              deps(),
            ),
          ),
        ];
        await waitUntilBlocked(4);
        await held.release();
        const results = await Promise.all(work);
        // every outcome is either success or a clean 409; nothing is a raw database error
        for (const r of results) if (!r.ok) expect(r.error).toBeInstanceOf(LeadConflictError);
        expect(await openCount(contact.id)).toBeLessThanOrEqual(1);
        // the history of the first lead agrees with its row
        const row = await leadRow(open.id);
        const statuses = (await events(open.id)).filter((e) => e.kind === "STATUS");
        expect(statuses).toHaveLength(row.revision);
        if (statuses.length) expect(statuses.at(-1)!.to_status).toBe(row.status);
      }
    });
  });

  // ----------------------------------------------------------------------------------------- Phase 07A rules
  describe("compatibility with the Phase 07A database rules", () => {
    it("services satisfy the deferred history triggers at COMMIT, leave the evidence untouched and never link or decide anything", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const touch = await addTouch(t.db, w, contact.id, { receivedAt: minutesAgo(5) });
      const created = await createManualLead(w.staff.ctx, { contactId: contact.id }, deps());
      await changeLeadStatus(
        w.staff.ctx,
        created.lead.id,
        { to: "INVALID", expectedRevision: 0 },
        deps(),
      );
      await changeLeadStatus(
        w.staff.ctx,
        created.lead.id,
        { to: "NEW", expectedRevision: 1 },
        deps(),
      );
      const evidence = await one("select * from lead_attributions where id = $1", [touch.id]);
      expect(evidence).toMatchObject({ id: touch.id, lead_id: null });
      expect(
        (
          await one<{ n: number }>(
            "select count(*)::int n from lead_reconcile_decisions where attribution_id = $1",
            [touch.id],
          )
        ).n,
      ).toBe(0);
      expect((await events(created.lead.id)).map((e) => e.kind)).toEqual([
        "CREATED",
        "STATUS",
        "STATUS",
      ]);
    });

    it("evidence that arrives AFTER a manual lead was created can be linked to it by the database's rules; evidence from before cannot", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const before = await addTouch(t.db, w, contact.id, { receivedAt: minutesAgo(30) });
      const created = await createManualLead(w.staff.ctx, { contactId: contact.id }, deps());
      const after = await addTouch(t.db, w, contact.id, {
        receivedAt: new Date(Date.now() + 1000),
      });
      const asLead = { id: created.lead.id, contactId: contact.id };
      await expect(linkTouch(t.db, w, asLead, before.id)).rejects.toSatisfy((e: unknown) =>
        /cannot be linked to a lead cycle it predates/.test(pgError(e).message),
      );
      await linkTouch(t.db, w, asLead, after.id);
      expect(
        (
          await one<{ lead_id: string }>("select lead_id from lead_attributions where id = $1", [
            after.id,
          ])
        ).lead_id,
      ).toBe(created.lead.id);
    });
  });
});
