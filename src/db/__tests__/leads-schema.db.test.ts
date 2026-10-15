import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertAttributionOnce } from "../ops/inbound-message";
import { schema } from "../index";
import {
  CHECK_VIOLATION,
  FK_VIOLATION,
  UNIQUE_VIOLATION,
  createTestDatabase,
  expectPgError,
  pgError,
  seedContact,
  seedConversation,
  seedWorld,
  type TestDb,
} from "./helpers";

// Migration 0006 on real PostgreSQL (a disposable database): the lead lifecycle columns, one open lead per contact, lead
// history, reconcile decisions and the protection of attribution evidence. Everything here is a guarantee of the DATABASE: the
// statements are raw SQL, with no application service in between (none exists yet: checkpoint 07A is the schema only).

const INTEGRITY_VIOLATION = "23000";
const DEADLOCK_DETECTED = "40P01";
const OPEN = schema.OPEN_LEAD_STATUSES;
const CLOSED = schema.CLOSED_LEAD_STATUSES;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** Asserts a rejection raised by one of the hand-written triggers: its SQLSTATE and a part of its fixed message. */
async function expectRaise(p: Promise<unknown>, code: string, message: string | RegExp) {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  if (!caught) throw new Error(`Expected "${message}", but the statement succeeded`);
  const got = pgError(caught);
  expect(got.code, got.message).toBe(code);
  if (typeof message === "string") expect(got.message).toContain(message);
  else expect(got.message).toMatch(message);
}

describe("migration 0006: leads lifecycle, history, decisions and attribution evidence", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());

  const q = (sql: string, params: unknown[] = []) => t.pool.query(sql, params);
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q(sql, params)).rows[0] as T;

  /** Runs `fn` in one transaction on its own connection. A failure (also one raised at COMMIT) rolls back and is rethrown. */
  async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      const result = await fn(c);
      await c.query("commit");
      return result;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  /** Waits until some backend of this database is blocked on a lock (the statement under test is queued). */
  async function waitUntilBlocked() {
    for (let i = 0; i < 500; i++) {
      const r = await one<{ n: number }>(
        "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      );
      if (r.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the statement under test never blocked on a lock");
  }

  let n = 0;
  type World = Awaited<ReturnType<typeof world>>;
  async function world() {
    const w = await seedWorld(t.db);
    const user = await one<{ id: string }>(
      "insert into users (name, email) values ('Staff', $1) returning id",
      [`staff-${Date.now()}-${n++}@example.test`],
    );
    const member = await one<{ id: string }>(
      "insert into organization_memberships (organization_id, user_id, role) values ($1, $2, 'STAFF') returning id",
      [w.org.id, user.id],
    );
    return { ...w, memberId: member.id };
  }
  type TouchOptions = {
    source?: string;
    withMessage?: boolean;
    receivedAt?: Date;
    occurredAt?: Date;
    contactId?: string;
    conversationId?: string;
  };
  /** An attribution touch as the Phase 04 handler writes it: unlinked, for an inbound message of the contact. */
  async function touch(w: World, o: TouchOptions = {}) {
    const receivedAt = o.receivedAt ?? new Date();
    let messageId: string | null = null;
    if (o.withMessage !== false) {
      messageId = (
        await one<{ id: string }>(
          `insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at, wamid)
           values ($1, $2, $3, 'INBOUND', 'TEXT', 'hi', $4, $5) returning id`,
          [
            w.org.id,
            o.conversationId ?? w.conversation.id,
            w.account.id,
            o.occurredAt ?? receivedAt,
            `wamid.L${Date.now()}${n++}`,
          ],
        )
      ).id;
    }
    return (
      await one<{ id: string }>(
        `insert into lead_attributions (organization_id, contact_id, message_id, source_type, source_id, headline, received_at)
         values ($1, $2, $3, $4, 'ad-1', 'Headline', $5) returning id`,
        [w.org.id, o.contactId ?? w.contact.id, messageId, o.source ?? "META_AD", receivedAt],
      )
    ).id;
  }
  type LeadOptions = {
    status?: string;
    closedAt?: Date | null;
    cycleStartedAt?: Date;
    contactId?: string;
    /** the touch this lead is created from (an automatic lead); the INSERT is the only place it can be given */
    initiating?: string;
  };
  async function lead(w: World, o: LeadOptions = {}, c: { query: PoolClient["query"] } = t.pool) {
    const status = o.status ?? "NEW";
    const closedAt =
      o.closedAt !== undefined
        ? o.closedAt
        : (CLOSED as readonly string[]).includes(status)
          ? new Date()
          : null;
    const r = await c.query(
      `insert into leads (organization_id, contact_id, status, closed_at, cycle_started_at, initiating_attribution_id)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      // the default cycle start is a minute ago, so that a closed_at of "now" is not before it (leads_cycle_order_check)
      [
        w.org.id,
        o.contactId ?? w.contact.id,
        status,
        closedAt,
        o.cycleStartedAt ?? minutesAgo(1),
        o.initiating ?? null,
      ],
    );
    return r.rows[0] as {
      id: string;
      status: string;
      revision: number;
      closed_at: Date | null;
      cycle_started_at: Date;
      initiating_attribution_id: string | null;
    };
  }
  const linkOnly = (c: { query: PoolClient["query"] }, leadId: string, touchId: string) =>
    c.query("update lead_attributions set lead_id = $1 where id = $2", [leadId, touchId]);
  const linkedEvent = (
    c: { query: PoolClient["query"] },
    w: World,
    leadId: string,
    touchId: string,
  ) =>
    c.query(
      "insert into lead_events (organization_id, lead_id, contact_id, kind, attribution_id) values ($1, $2, $3, 'TOUCH_LINKED', $4)",
      [w.org.id, leadId, w.contact.id, touchId],
    );
  /** The only valid way to link: the link and its history event in one transaction. */
  const link = (w: World, leadId: string, touchId: string) =>
    tx(async (c) => {
      await linkOnly(c, leadId, touchId);
      await linkedEvent(c, w, leadId, touchId);
    });
  /** The CREATED history event of an automatic lead: it names the initiating touch. */
  const adCreatedEvent = (
    c: { query: PoolClient["query"] },
    w: World,
    leadId: string,
    touchId: string,
  ) =>
    c.query(
      "insert into lead_events (organization_id, lead_id, contact_id, kind, origin, attribution_id, revision) values ($1, $2, $3, 'CREATED', 'AD_REFERRAL', $4, 0)",
      [w.org.id, leadId, w.contact.id, touchId],
    );
  /**
   * An automatic lead: the lead (its INSERT names the initiating touch), its CREATED event, the link and the link's history,
   * atomically. The cycle start is whatever the caller passes: the database replaces it with the touch's receipt time.
   */
  const createFromTouch = (w: World, touchId: string, cycleStartedAt: Date = new Date()) =>
    tx(async (c) => {
      const l = await lead(w, { cycleStartedAt, initiating: touchId }, c);
      await adCreatedEvent(c, w, l.id, touchId);
      await linkOnly(c, l.id, touchId);
      await linkedEvent(c, w, l.id, touchId);
      return l;
    });
  /** A promise's outcome as a value: "done", or the PostgreSQL error. For statements that are expected to wait on a lock. */
  const settle = (p: Promise<unknown>) =>
    p.then(
      () => "done" as const,
      (e: unknown) => pgError(e),
    );
  /**
   * Runs `fn` with ONE trigger switched off, inside a transaction that is always rolled back. It shows what the declarative
   * constraint behind a trigger still refuses on its own (the trigger normally answers first).
   */
  async function withoutTrigger(
    table: string,
    trigger: string,
    fn: (c: PoolClient) => Promise<unknown>,
  ) {
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      await c.query(`alter table ${table} disable trigger ${trigger}`);
      await fn(c);
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  }
  /** A RETRY decision for a touch, due in an hour by the DATABASE clock. */
  const retryRow = (
    w: World,
    touchId: string,
    attempts = 1,
    c: { query: PoolClient["query"] } = t.pool,
  ) =>
    c.query(
      `insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts, next_attempt_at, last_error_code)
       values ($1, $2, $3, 'RETRY', $4, clock_timestamp() + interval '1 hour', 'db_timeout')`,
      [w.org.id, touchId, w.contact.id, attempts],
    );
  const decisionOf = async (touchId: string) =>
    (
      await q("select decision, attempts from lead_reconcile_decisions where attribution_id = $1", [
        touchId,
      ])
    ).rows[0] as { decision: string; attempts: number } | undefined;
  const PARK =
    "update lead_reconcile_decisions set decision = 'PARKED', attempts = 5, next_attempt_at = null where attribution_id = $1";
  const DELETE_DECISION = "delete from lead_reconcile_decisions where attribution_id = $1";
  /** A link as a compliant writer does it: the link, then the removal of a waiting RETRY row, then the history event. */
  const linkAndClean = (w: World, leadId: string, touchId: string) =>
    tx(async (c) => {
      await linkOnly(c, leadId, touchId);
      await c.query(DELETE_DECISION, [touchId]);
      await linkedEvent(c, w, leadId, touchId);
    });
  type StatusOptions = { closedAt?: Date; cycleStartedAt?: Date };
  /**
   * A status change exactly as it must be written: the lead (status, revision + 1, closed_at when it closes, a new cycle start
   * when it reopens) and its STATUS history event, on one connection. The caller owns the transaction.
   */
  async function changeStatus(
    c: { query: PoolClient["query"] },
    w: World,
    leadId: string,
    to: string,
    o: StatusOptions = {},
  ) {
    const cur = (
      await c.query(
        "select status, revision, contact_id, closed_at from leads where id = $1 for update",
        [leadId],
      )
    ).rows[0] as { status: string; revision: number; contact_id: string; closed_at: Date | null };
    const closing = (CLOSED as readonly string[]).includes(to);
    await c.query(
      `update leads set status = $2, revision = revision + 1, status_changed_at = clock_timestamp(),
         closed_at = case when $3::boolean then coalesce(closed_at, $4::timestamptz, clock_timestamp()) else null end,
         cycle_started_at = case when $5::boolean then coalesce($6::timestamptz, clock_timestamp()) else cycle_started_at end
       where id = $1`,
      [
        leadId,
        to,
        closing,
        o.closedAt ?? null,
        cur.closed_at !== null && !closing, // a reopen starts a new cycle
        o.cycleStartedAt ?? null,
      ],
    );
    await c.query(
      `insert into lead_events (organization_id, lead_id, contact_id, kind, actor_membership_id, from_status, to_status, revision)
       values ($1, $2, $3, 'STATUS', $4, $5, $6, $7)`,
      [w.org.id, leadId, cur.contact_id, w.memberId, cur.status, to, cur.revision + 1],
    );
  }
  const setStatus = (w: World, leadId: string, to: string, o: StatusOptions = {}) =>
    tx((c) => changeStatus(c, w, leadId, to, o));
  const stateOf = (leadId: string) =>
    one<{ status: string; revision: number; closed_at: Date | null; cycle_started_at: Date }>(
      "select status, revision, closed_at, cycle_started_at from leads where id = $1",
      [leadId],
    );
  const leadIdOf = async (touchId: string) =>
    (
      await one<{ lead_id: string | null }>("select lead_id from lead_attributions where id = $1", [
        touchId,
      ])
    ).lead_id;
  const eventCount = async (leadId: string) =>
    (
      await one<{ n: number }>("select count(*)::int n from lead_events where lead_id = $1", [
        leadId,
      ])
    ).n;

  // ------------------------------------------------------------------------------------------------- leads: columns
  describe("leads: revision, closed_at, cycle_started_at", () => {
    it("a plain insert gets revision 0, no closed_at and a cycle that starts now", async () => {
      const w = await world();
      const before = Date.now();
      const l = await one<{ revision: number; closed_at: Date | null; cycle_started_at: Date }>(
        "insert into leads (organization_id, contact_id) values ($1, $2) returning revision, closed_at, cycle_started_at",
        [w.org.id, w.contact.id],
      );
      expect(l.revision).toBe(0);
      expect(l.closed_at).toBeNull();
      expect(Math.abs(l.cycle_started_at.getTime() - before)).toBeLessThan(60_000);
    });

    it("closed_at is set exactly while the status is a closed one, for every status", async () => {
      const w = await world();
      for (const status of OPEN) {
        const c = await seedContact(t.db, w.org.id);
        await expectPgError(
          lead(w, { status, closedAt: new Date(), contactId: c.id }),
          CHECK_VIOLATION,
          "leads_status_closed_at_check",
        );
        expect((await lead(w, { status, contactId: c.id })).closed_at).toBeNull();
      }
      for (const status of CLOSED) {
        const c = await seedContact(t.db, w.org.id);
        await expectPgError(
          lead(w, { status, closedAt: null, contactId: c.id }),
          CHECK_VIOLATION,
          "leads_status_closed_at_check",
        );
        expect((await lead(w, { status, contactId: c.id })).closed_at).not.toBeNull();
      }
      // the two groups are exactly the ten statuses
      expect([...OPEN, ...CLOSED].sort()).toEqual([...schema.LEAD_STATUSES].sort());
    });

    it("a new lead starts at revision 0: a default alone is not the rule, an explicit other value is refused (review M1)", async () => {
      const w = await world();
      const insert = (
        revision: string,
        contactId: string,
        c: { query: PoolClient["query"] } = t.pool,
      ) =>
        c.query(
          `insert into leads (organization_id, contact_id, status, revision) values ($1, $2, 'QUALIFIED', ${revision}) returning id, revision`,
          [w.org.id, contactId],
        );
      const fresh = async () => (await seedContact(t.db, w.org.id)).id;
      expect((await insert("0", await fresh())).rows[0].revision).toBe(0);
      expect((await insert("default", await fresh())).rows[0].revision).toBe(0);
      for (const revision of ["1", "9", "-1", "2147483647"])
        await expectRaise(
          insert(revision, await fresh()),
          CHECK_VIOLATION,
          "a new lead starts at revision 0",
        );
      // the reviewer's fabrication: a lead that claims revision 9 from birth, plus a STATUS event "for" that revision
      const contactId = await fresh();
      await expectRaise(
        tx(async (c) => {
          const l = (await insert("9", contactId, c)).rows[0] as { id: string };
          await c.query(
            "insert into lead_events (organization_id, lead_id, contact_id, kind, actor_membership_id, from_status, to_status, revision) values ($1,$2,$3,'STATUS',$4,'NEW','QUALIFIED',9)",
            [w.org.id, l.id, contactId, w.memberId],
          );
        }),
        CHECK_VIOLATION,
        "a new lead starts at revision 0",
      );
      // ... and a lead that exists (at revision 0) cannot be given history for a change that never happened
      const l = (await insert("0", contactId)).rows[0] as { id: string };
      const status = (revision: number) =>
        q(
          "insert into lead_events (organization_id, lead_id, contact_id, kind, actor_membership_id, from_status, to_status, revision) values ($1,$2,$3,'STATUS',$4,'NEW','QUALIFIED',$5)",
          [w.org.id, l.id, contactId, w.memberId, revision],
        );
      for (const revision of [1, 9])
        await expectRaise(
          status(revision),
          INTEGRITY_VIOLATION,
          "needs the lead to be in that status at that revision",
        );
      await expectPgError(status(0), CHECK_VIOLATION, "lead_events_shape_check"); // revision 0 is never a status change
      await expectRaise(
        q("update leads set revision = 9 where id = $1", [l.id]),
        CHECK_VIOLATION,
        "revision changes only together with the status",
      );
      expect(await eventCount(l.id)).toBe(0);
      // a real change is still revision + 1 with its event
      await setStatus({ ...w, contact: { ...w.contact, id: contactId } }, l.id, "INTERESTED");
      expect(await stateOf(l.id)).toMatchObject({ status: "INTERESTED", revision: 1 });
      expect(await eventCount(l.id)).toBe(1);
      // the CHECK (revision >= 0) is still there behind the trigger
      await withoutTrigger("leads", "leads_insert_guard_trg", (c) =>
        expectPgError(insert("-1", contactId, c), CHECK_VIOLATION, "leads_revision_check"),
      );
    });

    it("a lead cannot close before its cycle began", async () => {
      const w = await world();
      await expectPgError(
        lead(w, { status: "INVALID", closedAt: minutesAgo(10), cycleStartedAt: minutesAgo(5) }),
        CHECK_VIOLATION,
        "leads_cycle_order_check",
      );
      await lead(w, { status: "INVALID", closedAt: minutesAgo(5), cycleStartedAt: minutesAgo(5) }); // equal is fine
    });
  });

  // ---------------------------------------------------------------------------------------------- one open lead
  describe("one open lead per contact", () => {
    it("a second open lead is refused whatever the two open statuses are; closed leads are not limited", async () => {
      const w = await world();
      for (const first of OPEN) {
        const c = await seedContact(t.db, w.org.id);
        await lead(w, { status: first, contactId: c.id });
        for (const second of OPEN)
          await expectPgError(
            lead(w, { status: second, contactId: c.id }),
            UNIQUE_VIOLATION,
            "leads_org_contact_open_uidx",
          );
        for (const closed of CLOSED) await lead(w, { status: closed, contactId: c.id });
        expect(
          (
            await one<{ n: number }>("select count(*)::int n from leads where contact_id = $1", [
              c.id,
            ])
          ).n,
        ).toBe(1 + CLOSED.length);
      }
    });

    it("is per contact and per organization", async () => {
      const a = await world();
      const b = await world();
      await lead(a);
      await lead(a, { contactId: (await seedContact(t.db, a.org.id)).id });
      await lead(b);
    });

    it("closing the open lead frees the contact; reopening a closed lead is refused while another one is open", async () => {
      const w = await world();
      const first = await lead(w);
      await setStatus(w, first.id, "NO_RESPONSE");
      const second = await lead(w); // a new cycle
      await expectPgError(
        setStatus(w, first.id, "NEW"),
        UNIQUE_VIOLATION,
        "leads_org_contact_open_uidx",
      );
      expect((await stateOf(first.id)).status).toBe("NO_RESPONSE");
      await setStatus(w, second.id, "INVALID");
      await setStatus(w, first.id, "NEW"); // no other open lead now
      expect(await stateOf(first.id)).toMatchObject({
        status: "NEW",
        revision: 2,
        closed_at: null,
      });
    });

    it("two transactions creating an open lead for the same contact at the same time: exactly one succeeds", async () => {
      const w = await world();
      const a = await t.pool.connect();
      const b = await t.pool.connect();
      try {
        await a.query("begin");
        await b.query("begin");
        await lead(w, {}, a); // inserted, not committed
        const second = lead(w, { status: "QUALIFIED" }, b).then(
          () => "inserted",
          (e: unknown) => pgError(e),
        );
        await waitUntilBlocked(); // the second insert waits for the first transaction
        await a.query("commit");
        expect(await second).toMatchObject({
          code: UNIQUE_VIOLATION,
          constraint: "leads_org_contact_open_uidx",
        });
        await b.query("rollback");
      } finally {
        a.release();
        b.release();
      }
      expect(
        (
          await one<{ n: number }>("select count(*)::int n from leads where contact_id = $1", [
            w.contact.id,
          ])
        ).n,
      ).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------------------ transitions
  describe("lead transitions (triggers)", () => {
    it("a status change must increase revision by exactly 1, and revision never changes on its own", async () => {
      const w = await world();
      const l = await lead(w);
      await expectRaise(
        q("update leads set status = 'QUALIFIED' where id = $1", [l.id]),
        CHECK_VIOLATION,
        "must increase revision by exactly 1",
      );
      await expectRaise(
        q("update leads set status = 'QUALIFIED', revision = revision + 2 where id = $1", [l.id]),
        CHECK_VIOLATION,
        "must increase revision by exactly 1",
      );
      await expectRaise(
        q("update leads set revision = revision + 1 where id = $1", [l.id]),
        CHECK_VIOLATION,
        "revision changes only together with the status",
      );
      await expectRaise(
        q("update leads set status = 'QUALIFIED', revision = 0 where id = $1", [l.id]),
        CHECK_VIOLATION,
        "must increase revision by exactly 1",
      );
      await setStatus(w, l.id, "QUALIFIED");
      await setStatus(w, l.id, "INTERESTED");
      expect(await stateOf(l.id)).toMatchObject({ status: "INTERESTED", revision: 2 });
      // an update that changes neither is allowed (for example updated_at)
      await q("update leads set updated_at = now() where id = $1", [l.id]);
    });

    it("a status change without its STATUS history event cannot commit, so every closure stays recoverable from history", async () => {
      const w = await world();
      const l = await lead(w);
      const bump =
        "update leads set status = 'NO_RESPONSE', closed_at = clock_timestamp(), revision = revision + 1 where id = $1";
      // as a single statement, and inside a transaction that does other valid work
      await expectRaise(
        q(bump, [l.id]),
        INTEGRITY_VIOLATION,
        "a status change was made without its STATUS history event",
      );
      await expectRaise(
        tx(async (c) => {
          await c.query(bump, [l.id]);
          await c.query("update leads set updated_at = now() where id = $1", [l.id]);
        }),
        INTEGRITY_VIOLATION,
        "a status change was made without its STATUS history event",
      );
      // an event that describes a different change does not satisfy it (wrong from, wrong to, wrong revision)
      for (const [from, to, revision] of [
        ["QUALIFIED", "NO_RESPONSE", 1],
        ["NEW", "NO_RESPONSE", 2],
      ] as const)
        await expectRaise(
          tx(async (c) => {
            await c.query(bump, [l.id]);
            await c.query(
              "insert into lead_events (organization_id, lead_id, contact_id, kind, actor_membership_id, from_status, to_status, revision) values ($1,$2,$3,'STATUS',$4,$5,$6,$7)",
              [w.org.id, l.id, w.contact.id, w.memberId, from, to, revision],
            );
          }),
          INTEGRITY_VIOLATION,
          /without its STATUS history event|needs the lead to be in that status at that revision/,
        );
      expect(await stateOf(l.id)).toMatchObject({ status: "NEW", revision: 0, closed_at: null });
      expect(await eventCount(l.id)).toBe(0);

      // written correctly, a close and a later reopen are both in the history, in order
      await setStatus(w, l.id, "NO_RESPONSE");
      await setStatus(w, l.id, "INVALID");
      await setStatus(w, l.id, "QUALIFIED");
      expect(
        (
          await q(
            "select from_status, to_status, revision from lead_events where lead_id = $1 and kind = 'STATUS' order by revision",
            [l.id],
          )
        ).rows,
      ).toEqual([
        { from_status: "NEW", to_status: "NO_RESPONSE", revision: 1 },
        { from_status: "NO_RESPONSE", to_status: "INVALID", revision: 2 },
        { from_status: "INVALID", to_status: "QUALIFIED", revision: 3 },
      ]);
    });

    it("no update can put a lead into a reserved status: history cannot record it, so the change cannot commit", async () => {
      const w = await world();
      const l = await lead(w);
      for (const reserved of schema.RESERVED_LEAD_STATUSES) {
        const closing = (CLOSED as readonly string[]).includes(reserved);
        const set = `update leads set status = '${reserved}', revision = revision + 1${closing ? ", closed_at = clock_timestamp()" : ""} where id = $1`;
        await expectRaise(
          q(set, [l.id]),
          INTEGRITY_VIOLATION,
          "a status change was made without its STATUS history event",
        );
        await expectPgError(
          tx(async (c) => {
            await c.query(set, [l.id]);
            await c.query(
              "insert into lead_events (organization_id, lead_id, contact_id, kind, actor_membership_id, from_status, to_status, revision) values ($1,$2,$3,'STATUS',$4,'NEW',$5,1)",
              [w.org.id, l.id, w.contact.id, w.memberId, reserved],
            );
          }),
          CHECK_VIOLATION,
          "lead_events_status_values_check",
        );
      }
      expect(await stateOf(l.id)).toMatchObject({ status: "NEW", revision: 0 });
      // ... and a lead that is already in a reserved status (it can only predate this migration) cannot be moved either
      const c = await seedContact(t.db, w.org.id);
      const reservedLead = await lead(w, { status: "REGISTERED", contactId: c.id });
      await expectPgError(
        tx(async (cl) => {
          await cl.query("update leads set status = 'NEW', revision = revision + 1 where id = $1", [
            reservedLead.id,
          ]);
          await cl.query(
            "insert into lead_events (organization_id, lead_id, contact_id, kind, actor_membership_id, from_status, to_status, revision) values ($1,$2,$3,'STATUS',$4,'REGISTERED','NEW',1)",
            [w.org.id, reservedLead.id, c.id, w.memberId],
          );
        }),
        CHECK_VIOLATION,
        "lead_events_status_values_check",
      );
    });

    it("every change between the six staff-settable statuses is possible, each recorded once with its revision", async () => {
      const w = await world();
      const l = await lead(w);
      let revision = 0;
      let current = "NEW";
      for (const from of schema.STAFF_SETTABLE_LEAD_STATUSES)
        for (const to of schema.STAFF_SETTABLE_LEAD_STATUSES) {
          if (from === to) continue;
          if (current !== from) {
            await setStatus(w, l.id, from);
            revision++;
          }
          await setStatus(w, l.id, to);
          revision++;
          current = to;
        }
      expect(await stateOf(l.id)).toMatchObject({ status: current, revision });
      expect(
        (
          await one<{ n: number }>(
            "select count(*)::int n from lead_events where lead_id = $1 and kind = 'STATUS'",
            [l.id],
          )
        ).n,
      ).toBe(revision);
    });

    it("cycle_started_at does not move while the lead is open or while it closes", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(30) });
      await expectRaise(
        q("update leads set cycle_started_at = now() where id = $1", [l.id]),
        CHECK_VIOLATION,
        "cycle_started_at changes only when a closed lead is reopened",
      );
      await expectRaise(
        q(
          "update leads set status = 'INVALID', closed_at = now(), cycle_started_at = now(), revision = revision + 1 where id = $1",
          [l.id],
        ),
        CHECK_VIOLATION,
        "cycle_started_at changes only when a closed lead is reopened",
      );
      await setStatus(w, l.id, "INVALID");
      expect((await stateOf(l.id)).cycle_started_at).toEqual(l.cycle_started_at);
    });

    it("closed_at is the start of the current closed period: it stays while the lead moves between closed statuses", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(30) });
      const closedAt = minutesAgo(20);
      await setStatus(w, l.id, "NO_RESPONSE", { closedAt });
      await expectRaise(
        q(
          "update leads set status = 'NOT_INTERESTED', closed_at = now(), revision = revision + 1 where id = $1",
          [l.id],
        ),
        CHECK_VIOLATION,
        "do not move while the lead stays closed",
      );
      await setStatus(w, l.id, "NOT_INTERESTED");
      expect(await stateOf(l.id)).toMatchObject({
        status: "NOT_INTERESTED",
        closed_at: closedAt,
        revision: 2,
      });
    });

    it("a reopened lead starts a new cycle at the reopening time, never before its closure", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      await setStatus(w, l.id, "NO_RESPONSE", { closedAt: minutesAgo(30) });
      await expectRaise(
        q(
          "update leads set status = 'NEW', closed_at = null, cycle_started_at = $2, revision = revision + 1 where id = $1",
          [l.id, minutesAgo(45)],
        ),
        CHECK_VIOLATION,
        "starts a new cycle at the reopening time",
      );
      // keeping the old cycle start is refused too: it is before the closure
      await expectRaise(
        q(
          "update leads set status = 'NEW', closed_at = null, revision = revision + 1 where id = $1",
          [l.id],
        ),
        CHECK_VIOLATION,
        "starts a new cycle at the reopening time",
      );
      const at = minutesAgo(10);
      await setStatus(w, l.id, "NEW", { cycleStartedAt: at });
      expect(await stateOf(l.id)).toEqual({
        status: "NEW",
        closed_at: null,
        cycle_started_at: at,
        revision: 2,
      });
    });

    it("a lead never moves to another contact or organization", async () => {
      const w = await world();
      const other = await world();
      const l = await lead(w);
      const c = await seedContact(t.db, w.org.id);
      await expectRaise(
        q("update leads set contact_id = $2 where id = $1", [l.id, c.id]),
        CHECK_VIOLATION,
        "never moves to another contact or organization",
      );
      await expectRaise(
        q("update leads set organization_id = $2 where id = $1", [l.id, other.org.id]),
        CHECK_VIOLATION,
        "never moves to another contact or organization",
      );
    });
  });

  // ----------------------------------------------------------------------------------------------- lead history
  describe("lead_events", () => {
    const ev = (
      w: World,
      leadId: string,
      cols: Record<string, unknown>,
      c: { query: PoolClient["query"] } = t.pool,
    ) =>
      c.query(
        `insert into lead_events (organization_id, lead_id, contact_id, kind, actor_membership_id, origin, from_status, to_status, attribution_id, revision)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          cols.org ?? w.org.id,
          leadId,
          cols.contact ?? w.contact.id,
          cols.kind,
          cols.actor ?? null,
          cols.origin ?? null,
          cols.from ?? null,
          cols.to ?? null,
          cols.touch ?? null,
          cols.revision ?? null,
        ],
      );

    it("accepts the three kinds in their exact shapes", async () => {
      const w = await world();
      const l = await lead(w);
      await ev(w, l.id, { kind: "CREATED", origin: "MANUAL", actor: w.memberId, revision: 0 });
      await setStatus(w, l.id, "QUALIFIED");
      const touchId = await touch(w);
      await link(w, l.id, touchId);
      expect(
        (
          await q(
            "select kind, origin, from_status, to_status, revision, attribution_id from lead_events where lead_id = $1 order by kind",
            [l.id],
          )
        ).rows,
      ).toEqual([
        {
          kind: "CREATED",
          origin: "MANUAL",
          from_status: null,
          to_status: null,
          revision: 0,
          attribution_id: null,
        },
        {
          kind: "STATUS",
          origin: null,
          from_status: "NEW",
          to_status: "QUALIFIED",
          revision: 1,
          attribution_id: null,
        },
        {
          kind: "TOUCH_LINKED",
          origin: null,
          from_status: null,
          to_status: null,
          revision: null,
          attribution_id: touchId,
        },
      ]);
    });

    it("refuses every malformed shape", async () => {
      const w = await world();
      const m = w.memberId;
      // `created` has no history yet (CREATED shapes); `moved` is QUALIFIED at revision 1 by a real, recorded change, so a
      // STATUS row that claims that change again passes the "matches the lead" trigger and is judged by its shape alone
      const created = await lead(w);
      const c2 = await seedContact(t.db, w.org.id);
      const conversation2 = await seedConversation(t.db, {
        organizationId: w.org.id,
        whatsappAccountId: w.account.id,
        contactId: c2.id,
      });
      const w2 = { ...w, contact: c2, conversation: conversation2 };
      const moved = await lead(w2);
      await setStatus(w2, moved.id, "QUALIFIED");
      const freshTouch = await touch(w);
      const linked = await touch(w);
      await link(w, created.id, linked);
      const status = {
        kind: "STATUS",
        actor: m,
        from: "NEW",
        to: "QUALIFIED",
        revision: 1,
        contact: c2.id,
      };
      const bad: Array<[string, string, Record<string, unknown>]> = [
        ["unknown kind", created.id, { kind: "OTHER", actor: m }],
        ["CREATED without an origin", created.id, { kind: "CREATED", actor: m, revision: 0 }],
        [
          "CREATED MANUAL without the staff member",
          created.id,
          { kind: "CREATED", origin: "MANUAL", revision: 0 },
        ],
        [
          "CREATED MANUAL naming a touch",
          created.id,
          { kind: "CREATED", origin: "MANUAL", actor: m, touch: freshTouch, revision: 0 },
        ],
        [
          "CREATED AD_REFERRAL without a touch",
          created.id,
          { kind: "CREATED", origin: "AD_REFERRAL", revision: 0 },
        ],
        [
          "CREATED AD_REFERRAL with a staff member",
          created.id,
          { kind: "CREATED", origin: "AD_REFERRAL", actor: m, touch: freshTouch, revision: 0 },
        ],
        [
          "CREATED with a revision other than 0",
          created.id,
          { kind: "CREATED", origin: "MANUAL", actor: m, revision: 1 },
        ],
        ["CREATED without a revision", created.id, { kind: "CREATED", origin: "MANUAL", actor: m }],
        [
          "CREATED with a status",
          created.id,
          { kind: "CREATED", origin: "MANUAL", actor: m, revision: 0, to: "NEW" },
        ],
        [
          "unknown origin",
          created.id,
          { kind: "CREATED", origin: "IMPORT", actor: m, revision: 0 },
        ],
        ["STATUS without the staff member", moved.id, { ...status, actor: null }],
        ["STATUS to the same status", moved.id, { ...status, from: "QUALIFIED" }],
        ["STATUS without from", moved.id, { ...status, from: null }],
        ["STATUS with an origin", moved.id, { ...status, origin: "MANUAL" }],
        [
          "TOUCH_LINKED with a revision",
          created.id,
          { kind: "TOUCH_LINKED", touch: linked, revision: 1 },
        ],
        [
          "TOUCH_LINKED with a status",
          created.id,
          { kind: "TOUCH_LINKED", touch: linked, to: "NEW" },
        ],
        [
          "TOUCH_LINKED with an origin",
          created.id,
          { kind: "TOUCH_LINKED", touch: linked, origin: "AD_REFERRAL" },
        ],
      ];
      for (const [name, leadId, cols] of bad) {
        let code: string | undefined;
        await ev(w, leadId, cols).catch((e: unknown) => (code = pgError(e).code));
        expect(code, name).toBe(CHECK_VIOLATION);
      }
      // rows that cannot describe anything real are refused before their shape is even looked at
      const unreal: Array<[string, string, Record<string, unknown>, string]> = [
        [
          "a TOUCH_LINKED event without a touch",
          created.id,
          { kind: "TOUCH_LINKED" },
          "needs the touch to be linked to that lead",
        ],
        [
          "STATUS without a revision",
          moved.id,
          { ...status, revision: null },
          "needs the lead to be in that status at that revision",
        ],
        [
          "STATUS with revision 0",
          moved.id,
          { ...status, revision: 0 },
          "needs the lead to be in that status at that revision",
        ],
        [
          "STATUS without to",
          moved.id,
          { ...status, to: null },
          "needs the lead to be in that status at that revision",
        ],
        [
          "STATUS for a change that did not happen",
          created.id,
          { ...status, contact: w.contact.id },
          "needs the lead to be in that status at that revision",
        ],
      ];
      for (const [name, leadId, cols, message] of unreal)
        await expectRaise(ev(w, leadId, cols), INTEGRITY_VIOLATION, message).catch((e: unknown) => {
          throw new Error(`${name}: ${String(e)}`);
        });
      expect(await eventCount(created.id)).toBe(1); // only the link's own event
      expect(await eventCount(moved.id)).toBe(1); // only the real status change
    });

    it("history can only record the staff-settable statuses: a reserved status is refused in either position", async () => {
      const w = await world();
      // each event matches the lead exactly (the change it describes is made in the same transaction), so only the status
      // rule decides
      for (const reserved of schema.RESERVED_LEAD_STATUSES) {
        const closing = reserved === "CONVERTED";
        const a = await seedContact(t.db, w.org.id);
        const toReserved = (await lead(w, { contactId: a.id })).id;
        await expectPgError(
          tx(async (c) => {
            await c.query(
              `update leads set status = $2, revision = revision + 1${closing ? ", closed_at = clock_timestamp()" : ""} where id = $1`,
              [toReserved, reserved],
            );
            await ev(
              w,
              toReserved,
              {
                kind: "STATUS",
                actor: w.memberId,
                from: "NEW",
                to: reserved,
                revision: 1,
                contact: a.id,
              },
              c,
            );
          }),
          CHECK_VIOLATION,
          "lead_events_status_values_check",
        );
        // a lead that sits in a reserved status (it can only predate this migration or come from outside the application)
        const b = await seedContact(t.db, w.org.id);
        // (explicit times: the reopening below uses the database clock, which need not agree with this process's clock)
        const fromReserved = (
          await lead(w, {
            status: reserved,
            contactId: b.id,
            cycleStartedAt: minutesAgo(10),
            closedAt: closing ? minutesAgo(5) : null,
          })
        ).id;
        await expectPgError(
          tx(async (c) => {
            await c.query(
              `update leads set status = 'NEW', revision = revision + 1${closing ? ", closed_at = null, cycle_started_at = clock_timestamp()" : ""} where id = $1`,
              [fromReserved],
            );
            await ev(
              w,
              fromReserved,
              {
                kind: "STATUS",
                actor: w.memberId,
                from: reserved,
                to: "NEW",
                revision: 1,
                contact: b.id,
              },
              c,
            );
          }),
          CHECK_VIOLATION,
          "lead_events_status_values_check",
        );
        expect(await stateOf(toReserved)).toMatchObject({ status: "NEW", revision: 0 });
        expect(await stateOf(fromReserved)).toMatchObject({ status: reserved, revision: 0 });
      }
    });

    it("is append-only: no UPDATE and no DELETE", async () => {
      const w = await world();
      const l = await lead(w);
      await ev(w, l.id, { kind: "CREATED", origin: "MANUAL", actor: w.memberId, revision: 0 });
      await expectRaise(
        q("update lead_events set revision = 0 where lead_id = $1", [l.id]),
        CHECK_VIOLATION,
        "lead_events is append-only: UPDATE is not allowed",
      );
      await expectRaise(
        q("delete from lead_events where lead_id = $1", [l.id]),
        CHECK_VIOLATION,
        "lead_events is append-only: DELETE is not allowed",
      );
      expect(await eventCount(l.id)).toBe(1);
    });

    it("a lead is created once, a touch creates at most one lead, and a revision is recorded once", async () => {
      const w = await world();
      const l = await lead(w);
      const created = { kind: "CREATED", origin: "MANUAL", actor: w.memberId, revision: 0 };
      await ev(w, l.id, created);
      await expectPgError(ev(w, l.id, created), UNIQUE_VIOLATION, "lead_events_created_uidx");
      await setStatus(w, l.id, "QUALIFIED");
      // a second event claiming the same revision of the same lead
      await expectPgError(
        ev(w, l.id, {
          kind: "STATUS",
          actor: w.memberId,
          from: "INTERESTED",
          to: "QUALIFIED",
          revision: 1,
        }),
        UNIQUE_VIOLATION,
        "lead_events_status_revision_uidx",
      );

      // the same touch cannot create a second lead (the first lead is closed so that the contact can have another one)
      const x = await world();
      const touchId = await touch(x);
      const first = await createFromTouch(x, touchId);
      await setStatus(x, first.id, "INVALID");
      await expectRaise(
        lead(x, { initiating: touchId }),
        CHECK_VIOLATION,
        "a touch that is already linked cannot create a lead",
      );
      // nor can history say so for another lead
      const second = await lead(x);
      await expectRaise(
        ev(x, second.id, { kind: "CREATED", origin: "AD_REFERRAL", touch: touchId, revision: 0 }),
        CHECK_VIOLATION,
        "names the touch recorded by the INSERT of the lead",
      );
    });

    it("every reference is organization-aware and contact-aware", async () => {
      const a = await world();
      const b = await world();
      const l = await lead(a);
      const manual = { kind: "CREATED", origin: "MANUAL", revision: 0 };
      // another organization's staff member
      await expectPgError(
        ev(a, l.id, { ...manual, actor: b.memberId }),
        FK_VIOLATION,
        "lead_events_org_actor_fk",
      );
      // the lead under another organization, or with another contact
      await expectPgError(
        ev(a, l.id, { ...manual, actor: b.memberId, org: b.org.id, contact: b.contact.id }),
        FK_VIOLATION,
        "lead_events_org_lead_contact_fk",
      );
      const otherContact = await seedContact(t.db, a.org.id);
      await expectPgError(
        ev(a, l.id, { ...manual, actor: a.memberId, contact: otherContact.id }),
        FK_VIOLATION,
        "lead_events_org_lead_contact_fk",
      );
      // a touch of ANOTHER contact (same organization) cannot be named by this lead's history
      const conversation = await seedConversation(t.db, {
        organizationId: a.org.id,
        whatsappAccountId: a.account.id,
        contactId: otherContact.id,
      });
      const foreignTouch = await touch(a, {
        contactId: otherContact.id,
        conversationId: conversation.id,
      });
      // and neither can a touch of another organization. The guard trigger refuses both first (the touch is not the one
      // the lead was created from); the composite foreign key refuses them on its own as well.
      const bTouch = await touch(b);
      for (const foreign of [foreignTouch, bTouch]) {
        const created = { kind: "CREATED", origin: "AD_REFERRAL", touch: foreign, revision: 0 };
        await expectRaise(
          ev(a, l.id, created),
          CHECK_VIOLATION,
          "names the touch recorded by the INSERT of the lead",
        );
        await withoutTrigger("lead_events", "lead_events_guard_trg", (c) =>
          expectPgError(
            ev(a, l.id, created, c),
            FK_VIOLATION,
            "lead_events_org_attribution_contact_fk",
          ),
        );
      }
      // the lead's own reference to its initiating touch is contact-aware and organization-aware too
      const free = await seedContact(t.db, a.org.id);
      for (const foreign of [foreignTouch, bTouch])
        await expectPgError(
          lead(a, { contactId: free.id, initiating: foreign }),
          FK_VIOLATION,
          "leads_org_initiating_attribution_contact_fk",
        );
      expect(await eventCount(l.id)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------- attribution evidence
  describe("lead_attributions: evidence is immutable and linked at most once", () => {
    it("the Phase 04 write path is unchanged: an unlinked touch is inserted, once per message", async () => {
      const w = await world();
      const messageId = (
        await one<{ id: string }>(
          "insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at, wamid) values ($1,$2,$3,'INBOUND','TEXT','hi', now(), $4) returning id",
          [w.org.id, w.conversation.id, w.account.id, `wamid.P4${Date.now()}`],
        )
      ).id;
      const input = {
        organizationId: w.org.id,
        contactId: w.contact.id,
        messageId,
        sourceType: "META_AD" as const,
        sourceId: "120000000000001",
        sourceUrl: "https://example.test/ad",
        headline: "A/L ICT",
        body: "Join",
        mediaType: "image",
        mediaUrl: null,
        ctwaClid: "clid-1",
        providerData: { thumbnail_url: "https://example.test/t.jpg" },
        receivedAt: new Date(),
      };
      expect(await insertAttributionOnce(t.db, input)).toBe(true);
      expect(await insertAttributionOnce(t.db, input)).toBe(false); // the NOT EXISTS guard, as before
      const row = await one(
        "select lead_id, source_type, ctwa_clid from lead_attributions where message_id = $1",
        [messageId],
      );
      expect(row).toEqual({ lead_id: null, source_type: "META_AD", ctwa_clid: "clid-1" });
    });

    it("a touch cannot be inserted already linked", async () => {
      const w = await world();
      const l = await lead(w);
      await expectRaise(
        q(
          "insert into lead_attributions (organization_id, contact_id, lead_id, source_type, received_at) values ($1, $2, $3, 'META_AD', now())",
          [w.org.id, w.contact.id, l.id],
        ),
        CHECK_VIOLATION,
        "inserted unlinked and linked to a lead afterwards",
      );
    });

    it("no evidence column can be changed, before or after linking, and a touch cannot be deleted", async () => {
      const w = await world();
      const other = await world();
      const otherContact = await seedContact(t.db, w.org.id);
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      const unlinked = await touch(w);
      const linked = await touch(w);
      await link(w, l.id, linked);
      const changes: Array<[string, unknown]> = [
        ["source_type", "REFERRAL"],
        ["source_id", "other"],
        ["source_url", "https://example.test/x"],
        ["headline", "changed"],
        ["body", "changed"],
        ["media_type", "video"],
        ["media_url", "https://example.test/m"],
        ["ctwa_clid", "changed"],
        ["provider_data", JSON.stringify({ a: 1 })],
        ["received_at", minutesAgo(999)],
        ["created_at", minutesAgo(999)],
        ["message_id", null],
        ["contact_id", otherContact.id],
        ["organization_id", other.org.id],
      ];
      for (const id of [unlinked, linked]) {
        const before = await one("select * from lead_attributions where id = $1", [id]);
        for (const [column, value] of changes)
          await expectRaise(
            q(`update lead_attributions set ${column} = $2 where id = $1`, [id, value]),
            CHECK_VIOLATION,
            "attribution evidence is immutable",
          );
        await expectRaise(
          q("delete from lead_attributions where id = $1", [id]),
          CHECK_VIOLATION,
          "attribution evidence cannot be deleted",
        );
        expect(await one("select * from lead_attributions where id = $1", [id])).toEqual(before);
      }
      // a link that also tries to change evidence is refused as a whole
      await expectRaise(
        q("update lead_attributions set lead_id = $2, headline = 'x' where id = $1", [
          unlinked,
          l.id,
        ]),
        CHECK_VIOLATION,
        "attribution evidence is immutable",
      );
      // an update that changes nothing is harmless
      await q(
        "update lead_attributions set headline = headline, lead_id = lead_id where id = any($1)",
        [[unlinked, linked]],
      );
    });

    it("a touch is linked once: it cannot be moved to another lead or unlinked", async () => {
      const w = await world();
      const first = await lead(w, { cycleStartedAt: minutesAgo(60) });
      const touchId = await touch(w);
      await link(w, first.id, touchId);
      expect(await leadIdOf(touchId)).toBe(first.id);
      await setStatus(w, first.id, "INVALID");
      const second = await lead(w, { cycleStartedAt: minutesAgo(60) });
      await expectRaise(
        linkOnly(t.pool, second.id, touchId),
        CHECK_VIOLATION,
        "linked once and the link never changes",
      );
      await expectRaise(
        q("update lead_attributions set lead_id = null where id = $1", [touchId]),
        CHECK_VIOLATION,
        "linked once and the link never changes",
      );
      expect(await leadIdOf(touchId)).toBe(first.id);
    });

    it("a link without its history event is refused at COMMIT, and nothing of it remains", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      const touchId = await touch(w);
      // the statement itself succeeds; the transaction cannot commit
      const c = await t.pool.connect();
      try {
        await c.query("begin");
        expect((await linkOnly(c, l.id, touchId)).rowCount).toBe(1);
        await expectRaise(
          c.query("commit"),
          INTEGRITY_VIOLATION,
          "linked to a lead without its TOUCH_LINKED history event",
        );
      } finally {
        c.release();
      }
      expect(await leadIdOf(touchId)).toBeNull();
      // outside an explicit transaction the single statement is its own transaction: refused the same way
      await expectRaise(
        linkOnly(t.pool, l.id, touchId),
        INTEGRITY_VIOLATION,
        "linked to a lead without its TOUCH_LINKED history event",
      );
      // a history event for a DIFFERENT touch or lead does not satisfy it
      const otherTouch = await touch(w);
      await link(w, l.id, otherTouch);
      await expectRaise(
        linkOnly(t.pool, l.id, touchId),
        INTEGRITY_VIOLATION,
        "linked to a lead without its TOUCH_LINKED history event",
      );
      // the check can be forced early; it is the same check
      await expectRaise(
        tx(async (c2) => {
          await linkOnly(c2, l.id, touchId);
          await c2.query("set constraints all immediate");
        }),
        INTEGRITY_VIOLATION,
        "linked to a lead without its TOUCH_LINKED history event",
      );
      expect(await leadIdOf(touchId)).toBeNull();
      expect(await eventCount(l.id)).toBe(1);
    });

    it("history without a matching link is refused", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      const touchId = await touch(w);
      await expectRaise(
        linkedEvent(t.pool, w, l.id, touchId), // the touch is not linked at all
        INTEGRITY_VIOLATION,
        "needs the touch to be linked to that lead",
      );
      // event first, link second, in one transaction: still refused (the event must describe an existing link)
      await expectRaise(
        tx(async (c) => {
          await linkedEvent(c, w, l.id, touchId);
          await linkOnly(c, l.id, touchId);
        }),
        INTEGRITY_VIOLATION,
        "needs the touch to be linked to that lead",
      );
      // linked to lead A, history claiming lead B
      await link(w, l.id, touchId);
      await setStatus(w, l.id, "INVALID");
      const other = await lead(w);
      await expectRaise(
        linkedEvent(t.pool, w, other.id, touchId),
        INTEGRITY_VIOLATION,
        "needs the touch to be linked to that lead",
      );
      expect(await eventCount(other.id)).toBe(0);
    });

    it("a second TOUCH_LINKED event for the same touch is refused", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      const touchId = await touch(w);
      await link(w, l.id, touchId);
      await expectPgError(
        linkedEvent(t.pool, w, l.id, touchId),
        UNIQUE_VIOLATION,
        "lead_events_touch_linked_uidx",
      );
      expect(await eventCount(l.id)).toBe(1);
    });

    it("a touch of another contact or another organization cannot be linked", async () => {
      const a = await world();
      const b = await world();
      const leadA = await lead(a, { cycleStartedAt: minutesAgo(60) });
      const otherContact = await seedContact(t.db, a.org.id);
      const conversation = await seedConversation(t.db, {
        organizationId: a.org.id,
        whatsappAccountId: a.account.id,
        contactId: otherContact.id,
      });
      const otherTouch = await touch(a, {
        contactId: otherContact.id,
        conversationId: conversation.id,
      });
      await expectPgError(
        linkOnly(t.pool, leadA.id, otherTouch),
        FK_VIOLATION,
        "lead_attributions_org_lead_contact_fk",
      );
      const bTouch = await touch(b);
      await expectPgError(
        linkOnly(t.pool, leadA.id, bTouch),
        FK_VIOLATION,
        "lead_attributions_org_lead_contact_fk",
      );
      expect(await leadIdOf(otherTouch)).toBeNull();
      expect(await leadIdOf(bTouch)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------------------------- link rules
  describe("which touch may be linked to which lead", () => {
    it("only a confirmed Meta ad referral that arrived with a message", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      for (const source of schema.ATTRIBUTION_SOURCE_TYPES.filter((s) => s !== "META_AD")) {
        const touchId = await touch(w, { source });
        await expectRaise(
          link(w, l.id, touchId),
          CHECK_VIOLATION,
          "only a confirmed Meta ad referral that arrived with a message can be linked",
        );
      }
      const noMessage = await touch(w, { withMessage: false });
      await expectRaise(
        link(w, l.id, noMessage),
        CHECK_VIOLATION,
        "only a confirmed Meta ad referral that arrived with a message can be linked",
      );
      await link(w, l.id, await touch(w)); // META_AD with a message
    });

    it("only to an open lead", async () => {
      const w = await world();
      for (const status of CLOSED) {
        const c = await seedContact(t.db, w.org.id);
        const conversation = await seedConversation(t.db, {
          organizationId: w.org.id,
          whatsappAccountId: w.account.id,
          contactId: c.id,
        });
        const x = { ...w, contact: c, conversation };
        const closed = await lead(x, {
          status,
          closedAt: new Date(),
          cycleStartedAt: minutesAgo(60),
        });
        await expectRaise(
          link(x, closed.id, await touch(x)),
          CHECK_VIOLATION,
          "can only be linked to an open lead",
        );
      }
    });

    it("never to a cycle the touch predates: the EARLIER of receipt time and provider time decides", async () => {
      const w = await world();
      const cycle = minutesAgo(30);
      const l = await lead(w, { cycleStartedAt: cycle });
      const before = minutesAgo(40);
      const after = minutesAgo(20);
      const farFuture = new Date(Date.now() + 365 * 24 * 3600_000);
      const cases: Array<[string, { receivedAt: Date; occurredAt: Date }, boolean]> = [
        ["both after the cycle start", { receivedAt: after, occurredAt: after }, true],
        ["exactly at the cycle start", { receivedAt: cycle, occurredAt: cycle }, true],
        ["both before", { receivedAt: before, occurredAt: before }, false],
        // delivered late: the message is old although we only received it now
        ["received after, sent before", { receivedAt: after, occurredAt: before }, false],
        // a provider timestamp that claims to be later than our own receipt does not make old evidence new
        ["received before, provider time after", { receivedAt: before, occurredAt: after }, false],
        [
          "received before, provider time far in the future",
          { receivedAt: before, occurredAt: farFuture },
          false,
        ],
        // ... and a wild future provider time on evidence we did receive in the cycle is judged by the receipt time
        [
          "received after, provider time far in the future",
          { receivedAt: after, occurredAt: farFuture },
          true,
        ],
      ];
      for (const [name, times, allowed] of cases) {
        const touchId = await touch(w, times);
        if (allowed) {
          await link(w, l.id, touchId);
          expect(await leadIdOf(touchId), name).toBe(l.id);
        } else {
          await expectRaise(
            link(w, l.id, touchId),
            CHECK_VIOLATION,
            "cannot be linked to a lead cycle it predates",
          );
          expect(await leadIdOf(touchId), name).toBeNull();
        }
      }
    });

    it("after a reopen the new cycle start applies: evidence from before the reopening is not attached", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(90) });
      await setStatus(w, l.id, "NO_RESPONSE", { closedAt: minutesAgo(60) });
      const whileClosed = await touch(w, {
        receivedAt: minutesAgo(45),
        occurredAt: minutesAgo(45),
      });
      await setStatus(w, l.id, "NEW", { cycleStartedAt: minutesAgo(30) });
      await expectRaise(
        link(w, l.id, whileClosed),
        CHECK_VIOLATION,
        "cannot be linked to a lead cycle it predates",
      );
      await link(
        w,
        l.id,
        await touch(w, { receivedAt: minutesAgo(10), occurredAt: minutesAgo(10) }),
      );
    });
  });

  // ------------------------------------------------------------------------------------------ automatic creation
  describe("a lead created by an ad referral", () => {
    it("lead, CREATED event, link and link history commit together; the initiating touch is exempt from the cycle rule", async () => {
      const w = await world();
      // the provider timestamp is (as usual) a little earlier than our receipt time, which is the cycle start
      const receivedAt = minutesAgo(5);
      const touchId = await touch(w, {
        receivedAt,
        occurredAt: new Date(receivedAt.getTime() - 4000),
      });
      const l = await createFromTouch(w, touchId, receivedAt);
      expect(await leadIdOf(touchId)).toBe(l.id);
      expect(l.cycle_started_at).toEqual(receivedAt);
      expect(l.initiating_attribution_id).toBe(touchId);
      expect(
        (
          await q(
            "select kind, origin, attribution_id, actor_membership_id, revision from lead_events where lead_id = $1 order by kind",
            [l.id],
          )
        ).rows,
      ).toEqual([
        {
          kind: "CREATED",
          origin: "AD_REFERRAL",
          attribution_id: touchId,
          actor_membership_id: null,
          revision: 0,
        },
        {
          kind: "TOUCH_LINKED",
          origin: null,
          attribution_id: touchId,
          actor_membership_id: null,
          revision: null,
        },
      ]);
      // a LATER touch with the same shape of timestamps is not exempt: it must not predate the cycle
      const earlier = await touch(w, {
        receivedAt: new Date(receivedAt.getTime() + 1000),
        occurredAt: new Date(receivedAt.getTime() - 3000),
      });
      await expectRaise(
        link(w, l.id, earlier),
        CHECK_VIOLATION,
        "cannot be linked to a lead cycle it predates",
      );
    });

    it("the initiating touch must be linked in the same transaction: otherwise nothing is created", async () => {
      const w = await world();
      const touchId = await touch(w);
      await expectRaise(
        tx(async (c) => {
          const l = await lead(w, { initiating: touchId }, c);
          await adCreatedEvent(c, w, l.id, touchId);
        }),
        INTEGRITY_VIOLATION,
        "the touch that created a lead must be linked to it in the same transaction",
      );
      // ... and so must its CREATED event be written: the lead alone cannot commit either
      await expectRaise(
        lead(w, { initiating: touchId }),
        INTEGRITY_VIOLATION,
        "a lead created by an ad referral was inserted without its CREATED history event",
      );
      await expectRaise(
        tx(async (c) => {
          const l = await lead(w, { initiating: touchId }, c);
          await linkOnly(c, l.id, touchId);
          await linkedEvent(c, w, l.id, touchId);
        }),
        INTEGRITY_VIOLATION,
        "a lead created by an ad referral was inserted without its CREATED history event",
      );
      expect(
        (
          await one<{ n: number }>("select count(*)::int n from leads where contact_id = $1", [
            w.contact.id,
          ])
        ).n,
      ).toBe(0);
      expect(await leadIdOf(touchId)).toBeNull();
    });

    it("only a confirmed Meta ad referral with a message can create a lead", async () => {
      const w = await world();
      for (const source of schema.ATTRIBUTION_SOURCE_TYPES.filter((x) => x !== "META_AD"))
        await expectRaise(
          lead(w, { initiating: await touch(w, { source }) }),
          CHECK_VIOLATION,
          "only a confirmed Meta ad referral that arrived with a message can create a lead",
        );
      await expectRaise(
        lead(w, { initiating: await touch(w, { withMessage: false }) }),
        CHECK_VIOLATION,
        "only a confirmed Meta ad referral that arrived with a message can create a lead",
      );
      expect(
        (
          await one<{ n: number }>("select count(*)::int n from leads where contact_id = $1", [
            w.contact.id,
          ])
        ).n,
      ).toBe(0);
    });
  });

  // ------------------------------------------------------------------------------------------------ concurrency
  describe("concurrent writers (two connections, ordered by real locks)", () => {
    it("a link that races the closing of its lead waits for it and is then refused", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      const touchId = await touch(w);
      const closer = await t.pool.connect();
      try {
        await closer.query("begin");
        await changeStatus(closer, w, l.id, "NOT_INTERESTED"); // closed and recorded, not committed yet
        const linking = link(w, l.id, touchId).then(
          () => "linked",
          (e: unknown) => pgError(e),
        );
        await waitUntilBlocked(); // the link reads the lead FOR SHARE and waits for the closing transaction
        await closer.query("commit");
        expect(await linking).toMatchObject({ code: CHECK_VIOLATION });
        expect(((await linking) as { message: string }).message).toContain(
          "can only be linked to an open lead",
        );
      } finally {
        closer.release();
      }
      expect(await leadIdOf(touchId)).toBeNull();
    });

    it("a closing that races a link waits for it: the link stands and the lead then closes", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      const touchId = await touch(w);
      const linker = await t.pool.connect();
      try {
        await linker.query("begin");
        await linkOnly(linker, l.id, touchId);
        await linkedEvent(linker, w, l.id, touchId);
        const closing = setStatus(w, l.id, "NOT_INTERESTED");
        await waitUntilBlocked();
        await linker.query("commit");
        await closing;
      } finally {
        linker.release();
      }
      expect(await leadIdOf(touchId)).toBe(l.id);
      expect(
        (await one<{ status: string }>("select status from leads where id = $1", [l.id])).status,
      ).toBe("NOT_INTERESTED");
    });

    it("two transactions linking the same touch: one link, one history event", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      const touchId = await touch(w);
      const first = await t.pool.connect();
      try {
        await first.query("begin");
        await linkOnly(first, l.id, touchId);
        await linkedEvent(first, w, l.id, touchId);
        const second = link(w, l.id, touchId).then(
          () => "linked",
          (e: unknown) => pgError(e),
        );
        await waitUntilBlocked();
        await first.query("commit");
        expect(await second).toMatchObject({
          code: UNIQUE_VIOLATION,
          constraint: "lead_events_touch_linked_uidx",
        });
      } finally {
        first.release();
      }
      expect(await leadIdOf(touchId)).toBe(l.id);
      expect(await eventCount(l.id)).toBe(1);
    });

    it("a terminal decision and a link for the same touch cannot both commit, whichever starts first", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      const decide = (c: { query: PoolClient["query"] }, touchId: string) =>
        c.query(
          "insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision) values ($1, $2, $3, 'SKIPPED_STALE')",
          [w.org.id, touchId, w.contact.id],
        );

      // the decision starts first: the link waits, then finds the touch terminally skipped
      const skipped = await touch(w);
      const decider = await t.pool.connect();
      try {
        await decider.query("begin");
        await decide(decider, skipped);
        const linking = link(w, l.id, skipped).then(
          () => "linked",
          (e: unknown) => pgError(e),
        );
        await waitUntilBlocked();
        await decider.query("commit");
        expect(((await linking) as { message: string }).message).toContain(
          "a touch with a terminal reconcile decision cannot be linked",
        );
      } finally {
        decider.release();
      }
      expect(await leadIdOf(skipped)).toBeNull();

      // the link starts first: the decision waits, then finds the touch linked
      const linked = await touch(w);
      const linker = await t.pool.connect();
      try {
        await linker.query("begin");
        await linkOnly(linker, l.id, linked);
        await linkedEvent(linker, w, l.id, linked);
        const deciding = decide(t.pool, linked).then(
          () => "decided",
          (e: unknown) => pgError(e),
        );
        await waitUntilBlocked();
        await linker.query("commit");
        expect(((await deciding) as { message: string }).message).toContain(
          "a linked touch has no reconcile decision",
        );
      } finally {
        linker.release();
      }
      expect(
        (
          await one<{ n: number }>(
            "select count(*)::int n from lead_reconcile_decisions where attribution_id = $1",
            [linked],
          )
        ).n,
      ).toBe(0);
    });
  });

  // ------------------------------------------------------------------------------------------------- decisions
  describe("lead_reconcile_decisions", () => {
    const decide = (w: World, touchId: string, cols: Record<string, unknown> = {}) =>
      q(
        `insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts, next_attempt_at, last_error_code)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          cols.org ?? w.org.id,
          touchId,
          cols.contact ?? w.contact.id,
          cols.decision ?? "SKIPPED_STALE",
          cols.attempts ?? 0,
          cols.next ?? null,
          cols.error ?? null,
        ],
      );
    const soon = () => new Date(Date.now() + 3600_000);

    it("accepts every decision in its exact shape, one row per touch", async () => {
      const w = await world();
      for (const decision of [
        "SKIPPED_STALE",
        "SKIPPED_BEFORE_CYCLE",
        "SKIPPED_CONVERTED",
        "SKIPPED_ARCHIVED",
      ])
        await decide(w, await touch(w), { decision });
      for (const attempts of [1, 2, 3, 4])
        await decide(w, await touch(w), {
          decision: "RETRY",
          attempts,
          next: soon(),
          error: "db_timeout",
        });
      await decide(w, await touch(w), { decision: "PARKED", attempts: 5, error: "unexpected" });
      // a terminal skip after earlier retries keeps their count
      await decide(w, await touch(w), { decision: "SKIPPED_ARCHIVED", attempts: 3 });
      const touchId = await touch(w);
      await decide(w, touchId);
      await expectPgError(
        decide(w, touchId, { decision: "SKIPPED_ARCHIVED" }),
        UNIQUE_VIOLATION,
        "lead_reconcile_decisions_pk",
      );
      expect([...schema.LEAD_RECONCILE_DECISIONS].sort()).toEqual([
        "PARKED",
        "RETRY",
        "SKIPPED_ARCHIVED",
        "SKIPPED_BEFORE_CYCLE",
        "SKIPPED_CONVERTED",
        "SKIPPED_STALE",
      ]);
    });

    it("refuses malformed rows: the retry policy is at most five attempts, then PARKED", async () => {
      const w = await world();
      const bad: Array<[string, Record<string, unknown>, string]> = [
        ["unknown decision", { decision: "SKIPPED" }, "lead_reconcile_decisions_decision_check"],
        [
          "RETRY without a due time",
          { decision: "RETRY", attempts: 1 },
          "lead_reconcile_decisions_shape_check",
        ],
        [
          "RETRY with no attempt",
          { decision: "RETRY", attempts: 0, next: soon() },
          "lead_reconcile_decisions_shape_check",
        ],
        [
          "RETRY after the fifth failure",
          { decision: "RETRY", attempts: 5, next: soon() },
          "lead_reconcile_decisions_shape_check",
        ],
        [
          "PARKED before the fifth failure",
          { decision: "PARKED", attempts: 4 },
          "lead_reconcile_decisions_shape_check",
        ],
        [
          "PARKED with a due time",
          { decision: "PARKED", attempts: 5, next: soon() },
          "lead_reconcile_decisions_shape_check",
        ],
        [
          "more than five attempts",
          { decision: "PARKED", attempts: 6 },
          "lead_reconcile_decisions_shape_check",
        ],
        [
          "a skip with a due time",
          { decision: "SKIPPED_STALE", next: soon() },
          "lead_reconcile_decisions_shape_check",
        ],
        [
          "a skip with five attempts",
          { decision: "SKIPPED_STALE", attempts: 5 },
          "lead_reconcile_decisions_shape_check",
        ],
        [
          "negative attempts",
          { decision: "SKIPPED_STALE", attempts: -1 },
          "lead_reconcile_decisions_shape_check",
        ],
        [
          "an error message instead of a code",
          { error: "Connection to 10.0.0.1 failed!" },
          "lead_reconcile_decisions_error_code_check",
        ],
        [
          "an over-long error code",
          { error: "x".repeat(65) },
          "lead_reconcile_decisions_error_code_check",
        ],
      ];
      for (const [name, cols, constraint] of bad) {
        let got: ReturnType<typeof pgError> | undefined;
        await decide(w, await touch(w), cols).catch((e: unknown) => (got = pgError(e)));
        expect(got?.code, name).toBe(CHECK_VIOLATION);
        expect(got?.constraint, name).toBe(constraint);
      }
    });

    it("a decision belongs to a touch of the same organization and contact", async () => {
      const a = await world();
      const b = await world();
      const touchId = await touch(a);
      const otherContact = await seedContact(t.db, a.org.id);
      await expectPgError(
        decide(a, touchId, { contact: otherContact.id }),
        FK_VIOLATION,
        "lead_reconcile_decisions_org_attribution_contact_fk",
      );
      await expectPgError(
        decide(a, touchId, { org: b.org.id, contact: b.contact.id }),
        FK_VIOLATION,
        "lead_reconcile_decisions_org_attribution_contact_fk",
      );
      await expectPgError(
        decide(a, "00000000-0000-4000-8000-000000000001"),
        FK_VIOLATION,
        "lead_reconcile_decisions_org_attribution_contact_fk",
      );
    });

    it("terminal decisions are final: never changed, never deleted, and the touch is never linked", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      const terminal: Array<Record<string, unknown>> = [
        { decision: "SKIPPED_STALE" },
        { decision: "SKIPPED_BEFORE_CYCLE" },
        { decision: "SKIPPED_CONVERTED" },
        { decision: "SKIPPED_ARCHIVED" },
        { decision: "PARKED", attempts: 5 },
      ];
      for (const cols of terminal) {
        const touchId = await touch(w);
        const evidence = await one("select * from lead_attributions where id = $1", [touchId]);
        await decide(w, touchId, cols);
        await expectRaise(
          q(
            "update lead_reconcile_decisions set decision = 'RETRY', attempts = 1, next_attempt_at = now() where attribution_id = $1",
            [touchId],
          ),
          CHECK_VIOLATION,
          "a terminal decision is final (UPDATE is not allowed)",
        );
        await expectRaise(
          q("update lead_reconcile_decisions set last_error_code = 'x' where attribution_id = $1", [
            touchId,
          ]),
          CHECK_VIOLATION,
          "a terminal decision is final (UPDATE is not allowed)",
        );
        await expectRaise(
          q("delete from lead_reconcile_decisions where attribution_id = $1", [touchId]),
          CHECK_VIOLATION,
          "a terminal decision is final (DELETE is not allowed)",
        );
        await expectRaise(
          link(w, l.id, touchId),
          CHECK_VIOLATION,
          "a touch with a terminal reconcile decision cannot be linked",
        );
        // the decision never touched the provider evidence
        expect(await one("select * from lead_attributions where id = $1", [touchId])).toEqual(
          evidence,
        );
      }
    });

    it("a RETRY row moves forward only: attempts never decrease; it can become terminal, or go away when the touch is linked", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      const upd = (touchId: string, set: string, params: unknown[] = []) =>
        q(`update lead_reconcile_decisions set ${set} where attribution_id = $1`, [
          touchId,
          ...params,
        ]);

      const a = await touch(w);
      await decide(w, a, { decision: "RETRY", attempts: 1, next: soon() });
      await upd(a, "attempts = 2, next_attempt_at = $2", [soon()]);
      await expectRaise(upd(a, "attempts = 1"), CHECK_VIOLATION, "attempts never decrease");
      await upd(a, "attempts = 4, next_attempt_at = $2", [soon()]);
      await upd(
        a,
        "decision = 'PARKED', attempts = 5, next_attempt_at = null, last_error_code = 'db_timeout'",
      );
      await expectRaise(upd(a, "attempts = 5"), CHECK_VIOLATION, "a terminal decision is final");

      const b = await touch(w);
      await decide(w, b, { decision: "RETRY", attempts: 2, next: soon() });
      await upd(b, "decision = 'SKIPPED_CONVERTED', next_attempt_at = null");
      await expectRaise(upd(b, "attempts = 3"), CHECK_VIOLATION, "a terminal decision is final");

      // a touch that is waiting for a retry can still be linked; its row is then removed by whoever links it
      const c = await touch(w);
      await decide(w, c, { decision: "RETRY", attempts: 1, next: soon() });
      await tx(async (cl) => {
        await linkOnly(cl, l.id, c);
        await linkedEvent(cl, w, l.id, c);
        await cl.query("delete from lead_reconcile_decisions where attribution_id = $1", [c]);
      });
      expect(await leadIdOf(c)).toBe(l.id);
      // and a decision cannot be recorded for a touch that is linked
      await expectRaise(decide(w, c), CHECK_VIOLATION, "a linked touch has no reconcile decision");
      // a decision does not move to another touch
      const d = await touch(w);
      const e = await touch(w);
      await decide(w, d, { decision: "RETRY", attempts: 1, next: soon() });
      await expectRaise(
        upd(d, "attribution_id = $2", [e]),
        CHECK_VIOLATION,
        "a decision stays with its touch",
      );
    });
  });

  // ------------------------------------------------------------------------------------------------- review H1
  describe("review H1: the initiating-touch exception cannot be fabricated after the fact", () => {
    const predates = "cannot be linked to a lead cycle it predates";
    const notTheOrigin = "names the touch recorded by the INSERT of the lead";
    /** The fabrication, in one transaction: an AD_REFERRAL CREATED event for a lead that exists, then the link and its history. */
    const fabricate = (w: World, leadId: string, touchId: string) =>
      tx(async (c) => {
        await adCreatedEvent(c, w, leadId, touchId);
        await linkOnly(c, leadId, touchId);
        await linkedEvent(c, w, leadId, touchId);
      });
    const touchAt = (w: World, minutes: number) =>
      touch(w, { receivedAt: minutesAgo(minutes), occurredAt: minutesAgo(minutes) });

    it("the reproduction: an existing lead without a CREATED event, an old touch, a fabricated CREATED event, the link", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(30) }); // revision 0, no history
      const old = await touchAt(w, 40);
      await expectRaise(fabricate(w, l.id, old), CHECK_VIOLATION, notTheOrigin);
      // the same statements in another order: now the link is what is refused
      await expectRaise(
        tx(async (c) => {
          await linkOnly(c, l.id, old);
          await linkedEvent(c, w, l.id, old);
          await adCreatedEvent(c, w, l.id, old);
        }),
        CHECK_VIOLATION,
        predates,
      );
      await expectRaise(link(w, l.id, old), CHECK_VIOLATION, predates);
      // the origin of a lead cannot be written afterwards, alone or together with a status change
      await expectRaise(
        q("update leads set initiating_attribution_id = $2 where id = $1", [l.id, old]),
        CHECK_VIOLATION,
        "recorded by its INSERT and never changes",
      );
      await expectRaise(
        q(
          "update leads set initiating_attribution_id = $2, status = 'QUALIFIED', revision = revision + 1 where id = $1",
          [l.id, old],
        ),
        CHECK_VIOLATION,
        "recorded by its INSERT and never changes",
      );
      expect(await leadIdOf(old)).toBeNull();
      expect(await eventCount(l.id)).toBe(0);
      expect(await stateOf(l.id)).toMatchObject({ status: "NEW", revision: 0 });
    });

    it("a reopened lead: neither its real origin nor a fabricated one attaches evidence from before the reopening", async () => {
      // an automatic lead (it has a real origin) and a lead without one, both closed and reopened
      for (const automatic of [true, false]) {
        const w = await world();
        const origin = await touchAt(w, 90);
        const l = automatic
          ? await createFromTouch(w, origin)
          : await lead(w, { cycleStartedAt: minutesAgo(90) });
        await setStatus(w, l.id, "NO_RESPONSE", { closedAt: minutesAgo(60) });
        const whileClosed = await touchAt(w, 45);
        await setStatus(w, l.id, "NEW", { cycleStartedAt: minutesAgo(30) });
        expect((await stateOf(l.id)).revision).toBe(2);
        await expectRaise(fabricate(w, l.id, whileClosed), CHECK_VIOLATION, notTheOrigin);
        await expectRaise(link(w, l.id, whileClosed), CHECK_VIOLATION, predates);
        if (automatic) {
          // the real origin is already linked and recorded: it cannot be used a second time
          await expectPgError(
            adCreatedEvent(t.pool, w, l.id, origin),
            UNIQUE_VIOLATION,
            "lead_events_created_uidx",
          );
        } else {
          // the old touch that could have been its origin is as stale as any other
          await expectRaise(fabricate(w, l.id, origin), CHECK_VIOLATION, notTheOrigin);
          await expectRaise(link(w, l.id, origin), CHECK_VIOLATION, predates);
          expect(await leadIdOf(origin)).toBeNull();
        }
        expect(await leadIdOf(whileClosed)).toBeNull();
        await link(w, l.id, await touchAt(w, 10)); // evidence of the new cycle is attached normally
      }
    });

    it("the genuine automatic creation still works, whatever the gap between provider time and receipt time; the database sets the cycle start", async () => {
      const cases: Array<[string, number, Date]> = [
        ["a few seconds, as usual", 4_000, new Date()],
        ["redelivered two days late", 2 * 24 * 3600_000, minutesAgo(10_000)],
        ["provider clock ahead of ours", -90_000, minutesAgo(1)],
      ];
      for (const [name, gapMs, suppliedCycleStart] of cases) {
        const w = await world();
        const receivedAt = minutesAgo(5);
        const origin = await touch(w, {
          receivedAt,
          occurredAt: new Date(receivedAt.getTime() - gapMs),
        });
        // whatever cycle start the writer supplies, the lead's cycle starts when its initiating touch was received
        const l = await createFromTouch(w, origin, suppliedCycleStart);
        expect(l.cycle_started_at, name).toEqual(receivedAt);
        expect(l.initiating_attribution_id, name).toBe(origin);
        expect(await leadIdOf(origin), name).toBe(l.id);
        expect(await eventCount(l.id), name).toBe(2);
        // the exception is that one touch's provider time and nothing else: another touch with the same shape is refused
        const lookalike = await touch(w, {
          receivedAt: new Date(receivedAt.getTime() + 1000),
          occurredAt: new Date(receivedAt.getTime() - 4_000),
        });
        await expectRaise(link(w, l.id, lookalike), CHECK_VIOLATION, predates);
        await expectRaise(fabricate(w, l.id, lookalike), CHECK_VIOLATION, notTheOrigin);
      }
    });

    it("inside the creating transaction too: once the lead has been closed and reopened, its origin belongs to the old cycle", async () => {
      const w = await world();
      const origin = await touchAt(w, 30);
      await expectRaise(
        tx(async (c) => {
          const l = await lead(w, { initiating: origin }, c);
          await adCreatedEvent(c, w, l.id, origin);
          await changeStatus(c, w, l.id, "NO_RESPONSE", { closedAt: minutesAgo(20) });
          await changeStatus(c, w, l.id, "NEW", { cycleStartedAt: minutesAgo(10) });
          await linkOnly(c, l.id, origin); // only the provider time is ever waived, never the receipt time
          await linkedEvent(c, w, l.id, origin);
        }),
        CHECK_VIOLATION,
        predates,
      );
      expect(await leadIdOf(origin)).toBeNull();
      expect(
        (
          await one<{ n: number }>("select count(*)::int n from leads where contact_id = $1", [
            w.contact.id,
          ])
        ).n,
      ).toBe(0);
    });

    it("a manual lead claims nothing: old touches stay unlinked and its history cannot name one", async () => {
      const w = await world();
      const old = await touchAt(w, 40);
      const manualEvent = (c: { query: PoolClient["query"] }, leadId: string) =>
        c.query(
          "insert into lead_events (organization_id, lead_id, contact_id, kind, actor_membership_id, origin, revision) values ($1, $2, $3, 'CREATED', $4, 'MANUAL', 0)",
          [w.org.id, leadId, w.contact.id, w.memberId],
        );
      // created as the application will: no cycle start supplied (the column default, the database's now)
      const l = await tx(async (c) => {
        const row = (
          await c.query(
            "insert into leads (organization_id, contact_id) values ($1, $2) returning id, cycle_started_at, initiating_attribution_id",
            [w.org.id, w.contact.id],
          )
        ).rows[0] as {
          id: string;
          cycle_started_at: Date;
          initiating_attribution_id: string | null;
        };
        await manualEvent(c, row.id);
        return row;
      });
      expect(l.initiating_attribution_id).toBeNull();
      await expectRaise(link(w, l.id, old), CHECK_VIOLATION, predates);
      await expectRaise(fabricate(w, l.id, old), CHECK_VIOLATION, notTheOrigin);
      expect(await leadIdOf(old)).toBeNull();
      // a touch that arrives after the lead was created belongs to its cycle (times taken from the lead row, not this clock)
      const after = new Date(l.cycle_started_at.getTime() + 1000);
      const later = await touch(w, { receivedAt: after, occurredAt: after });
      await link(w, l.id, later);
      expect(await leadIdOf(later)).toBe(l.id);
      // and an automatic lead cannot be recorded as a manual one
      const x = await world();
      const origin = await touch(x);
      await expectRaise(
        tx(async (c) => {
          const made = await lead(x, { initiating: origin }, c);
          await c.query(
            "insert into lead_events (organization_id, lead_id, contact_id, kind, actor_membership_id, origin, revision) values ($1, $2, $3, 'CREATED', $4, 'MANUAL', 0)",
            [x.org.id, made.id, x.contact.id, x.memberId],
          );
        }),
        CHECK_VIOLATION,
        notTheOrigin,
      );
    });

    it("several lead cycles of one contact: evidence of an earlier time cannot be moved into a later lead", async () => {
      const w = await world();
      const firstOrigin = await touchAt(w, 120);
      const a = await createFromTouch(w, firstOrigin);
      const duringA = await touchAt(w, 110); // arrived in the first cycle and was never linked
      await setStatus(w, a.id, "NOT_INTERESTED", { closedAt: minutesAgo(100) });
      const between = await touchAt(w, 80); // arrived while there was no open lead
      const secondOrigin = await touchAt(w, 60);
      const b = await createFromTouch(w, secondOrigin);
      for (const stale of [duringA, between]) {
        await expectRaise(fabricate(w, b.id, stale), CHECK_VIOLATION, notTheOrigin);
        await expectRaise(link(w, b.id, stale), CHECK_VIOLATION, predates);
        await expectRaise(
          link(w, a.id, stale),
          CHECK_VIOLATION,
          "can only be linked to an open lead",
        );
        expect(await leadIdOf(stale)).toBeNull();
      }
      // the first lead's origin is not an origin of the second, and stays where it is
      await expectRaise(fabricate(w, b.id, firstOrigin), CHECK_VIOLATION, notTheOrigin);
      await expectRaise(
        linkOnly(t.pool, b.id, firstOrigin),
        CHECK_VIOLATION,
        "linked once and the link never changes",
      );
      expect(await leadIdOf(firstOrigin)).toBe(a.id);
      expect(await leadIdOf(secondOrigin)).toBe(b.id);
      expect(await eventCount(a.id)).toBe(3); // CREATED, TOUCH_LINKED, the closing
      expect(await eventCount(b.id)).toBe(2);
    });

    it("two transactions creating a lead from the same touch at the same time: one lead, one link", async () => {
      const w = await world();
      const origin = await touch(w);
      const first = await t.pool.connect();
      let winner: string;
      try {
        await first.query("begin");
        winner = (await lead(w, { initiating: origin }, first)).id;
        await adCreatedEvent(first, w, winner, origin);
        await linkOnly(first, winner, origin);
        await linkedEvent(first, w, winner, origin);
        const second = settle(createFromTouch(w, origin));
        await waitUntilBlocked(); // the second INSERT waits on the one-open-lead index
        await first.query("commit");
        expect(await second).toMatchObject({
          code: UNIQUE_VIOLATION,
          constraint: "leads_org_contact_open_uidx",
        });
      } finally {
        first.release();
      }
      expect(
        (await q("select id from leads where contact_id = $1", [w.contact.id])).rows.map(
          (r) => r.id as string,
        ),
      ).toEqual([winner]);
      expect(await leadIdOf(origin)).toBe(winner);
      expect(await eventCount(winner)).toBe(2);
    });

    it("a link that races the reopening of its lead waits for it and is judged by the new cycle", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(90) });
      await setStatus(w, l.id, "NO_RESPONSE", { closedAt: minutesAgo(60) });
      const whileClosed = await touchAt(w, 45);
      const reopener = await t.pool.connect();
      try {
        await reopener.query("begin");
        await changeStatus(reopener, w, l.id, "NEW", { cycleStartedAt: minutesAgo(30) });
        const linking = settle(link(w, l.id, whileClosed));
        await waitUntilBlocked(); // the link reads the lead FOR SHARE and waits for the reopening
        await reopener.query("commit");
        expect(await linking).toMatchObject({
          code: CHECK_VIOLATION,
          message: expect.stringContaining(predates),
        });
      } finally {
        reopener.release();
      }
      expect(await leadIdOf(whileClosed)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------------------------- review H2, M2
  describe("review H2 and M2: a linked touch never has a reconcile decision, and a RETRY row cannot be deleted to start over", () => {
    const linkedHasNone = "a linked touch has no reconcile decision";
    const deleteNeedsLink = "a RETRY decision is deleted only after its touch has been linked";
    const stillDecided = "linked to a lead while it still has a reconcile decision";
    const setup = async (attempts = 4) => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      const touchId = await touch(w);
      await retryRow(w, touchId, attempts);
      return { w, l, touchId };
    };
    /** The contact-scoped advisory lock of the lock-order contract (step 1). */
    const contactLock = (c: { query: PoolClient["query"] }, w: World) =>
      c.query("select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [
        w.org.id,
        w.contact.id,
      ]);

    it("A, B. the RETRY decision of a linked touch cannot become PARKED or a terminal skip, and a link cannot commit beside it", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      const changes = [
        "decision = 'PARKED', attempts = 5, next_attempt_at = null",
        ...["SKIPPED_STALE", "SKIPPED_BEFORE_CYCLE", "SKIPPED_CONVERTED", "SKIPPED_ARCHIVED"].map(
          (d) => `decision = '${d}', next_attempt_at = null`,
        ),
        "attempts = attempts + 1, next_attempt_at = clock_timestamp() + interval '1 hour'",
        "last_error_code = 'other'",
      ];
      for (const set of changes) {
        const touchId = await touch(w);
        await retryRow(w, touchId, 3);
        await expectRaise(
          tx(async (c) => {
            await linkOnly(c, l.id, touchId);
            await linkedEvent(c, w, l.id, touchId);
            await c.query(`update lead_reconcile_decisions set ${set} where attribution_id = $1`, [
              touchId,
            ]);
          }),
          CHECK_VIOLATION,
          linkedHasNone,
        );
        expect(await leadIdOf(touchId), set).toBeNull();
        expect(await decisionOf(touchId), set).toEqual({ decision: "RETRY", attempts: 3 });
      }
      // a link that leaves the RETRY row where it is cannot commit: there is no committed state "linked, with a decision"
      const touchId = await touch(w);
      await retryRow(w, touchId, 3);
      await expectRaise(link(w, l.id, touchId), INTEGRITY_VIOLATION, stillDecided);
      expect(await leadIdOf(touchId)).toBeNull();
      expect(await decisionOf(touchId)).toEqual({ decision: "RETRY", attempts: 3 });
      expect(await eventCount(l.id)).toBe(0); // no failed transaction left anything behind
    });

    it("C. the decision UPDATE starts first: the link waits for it and is then refused", async () => {
      for (const set of [PARK, PARK.replace("'PARKED', attempts = 5", "'SKIPPED_STALE'")]) {
        const { w, l, touchId } = await setup();
        const decider = await t.pool.connect();
        try {
          await decider.query("begin");
          expect((await decider.query(set, [touchId])).rowCount).toBe(1); // not committed yet
          const linking = settle(linkAndClean(w, l.id, touchId));
          await waitUntilBlocked(); // the UPDATE holds the touch FOR SHARE; the link needs it exclusively
          await decider.query("commit");
          expect(await linking).toMatchObject({
            code: CHECK_VIOLATION,
            message: expect.stringContaining("a touch with a terminal reconcile decision"),
          });
        } finally {
          decider.release();
        }
        expect(await leadIdOf(touchId)).toBeNull();
        expect((await decisionOf(touchId))?.decision).toMatch(/^(PARKED|SKIPPED_STALE)$/);
        expect(await eventCount(l.id)).toBe(0);
      }
    });

    it("D. the link starts first and leaves the RETRY row: the decision UPDATE waits, the link cannot commit, the decision then stands", async () => {
      const { w, l, touchId } = await setup();
      const linker = await t.pool.connect();
      try {
        await linker.query("begin");
        await linkOnly(linker, l.id, touchId);
        await linkedEvent(linker, w, l.id, touchId);
        const deciding = settle(q(PARK, [touchId]));
        await waitUntilBlocked(); // the UPDATE has the decision row and waits for the touch
        // before the correction both committed here. Now the link is refused at COMMIT ...
        await expectRaise(linker.query("commit"), INTEGRITY_VIOLATION, stillDecided);
        expect(await deciding).toBe("done"); // ... and the UPDATE then finds the touch unlinked
      } finally {
        linker.release();
      }
      expect(await leadIdOf(touchId)).toBeNull();
      expect(await decisionOf(touchId)).toEqual({ decision: "PARKED", attempts: 5 });
      expect(await eventCount(l.id)).toBe(0);
    });

    it("D. the link starts first and removes the RETRY row: the decision UPDATE waits and then finds nothing to change", async () => {
      const { w, l, touchId } = await setup();
      const linker = await t.pool.connect();
      try {
        await linker.query("begin");
        await linkOnly(linker, l.id, touchId);
        await linker.query(DELETE_DECISION, [touchId]);
        await linkedEvent(linker, w, l.id, touchId);
        const deciding = q(PARK, [touchId]);
        await waitUntilBlocked(); // the UPDATE waits for the deleted row
        await linker.query("commit");
        expect((await deciding).rowCount).toBe(0);
      } finally {
        linker.release();
      }
      expect(await leadIdOf(touchId)).toBe(l.id);
      expect(await decisionOf(touchId)).toBeUndefined();
      expect(await eventCount(l.id)).toBe(1);
    });

    it("writers that follow the lock order (contact lock first) are simply serialized, in either order: no deadlock", async () => {
      // the decision first
      {
        const { w, l, touchId } = await setup();
        const decider = await t.pool.connect();
        try {
          await decider.query("begin");
          await contactLock(decider, w);
          await decider.query("select 1 from lead_attributions where id = $1 for update", [
            touchId,
          ]);
          await decider.query(PARK, [touchId]);
          const linking = settle(
            tx(async (c) => {
              await contactLock(c, w);
              await c.query("select 1 from leads where id = $1 for update", [l.id]);
              await linkOnly(c, l.id, touchId);
              await c.query(DELETE_DECISION, [touchId]);
              await linkedEvent(c, w, l.id, touchId);
            }),
          );
          await waitUntilBlocked(); // on the contact lock
          await decider.query("commit");
          expect(await linking).toMatchObject({
            code: CHECK_VIOLATION,
            message: expect.stringContaining("a touch with a terminal reconcile decision"),
          });
        } finally {
          decider.release();
        }
        expect(await leadIdOf(touchId)).toBeNull();
        expect(await decisionOf(touchId)).toEqual({ decision: "PARKED", attempts: 5 });
      }
      // the link first
      {
        const { w, l, touchId } = await setup();
        const linker = await t.pool.connect();
        try {
          await linker.query("begin");
          await contactLock(linker, w);
          await linker.query("select 1 from leads where id = $1 for update", [l.id]);
          await linkOnly(linker, l.id, touchId);
          await linker.query(DELETE_DECISION, [touchId]);
          await linkedEvent(linker, w, l.id, touchId);
          const deciding = settle(
            tx(async (c) => {
              await contactLock(c, w);
              await c.query("select 1 from lead_attributions where id = $1 for update", [touchId]);
              expect((await c.query(PARK, [touchId])).rowCount).toBe(0);
            }),
          );
          await waitUntilBlocked(); // on the contact lock
          await linker.query("commit");
          expect(await deciding).toBe("done");
        } finally {
          linker.release();
        }
        expect(await leadIdOf(touchId)).toBe(l.id);
        expect(await decisionOf(touchId)).toBeUndefined();
      }
    });

    it("writers that ignore the lock order can deadlock; PostgreSQL aborts one of them and the state stays valid", async () => {
      const { w, l, touchId } = await setup();
      const linker = await t.pool.connect();
      try {
        await linker.query("begin");
        await linkOnly(linker, l.id, touchId); // holds the touch
        const deciding = settle(q(PARK, [touchId])); // holds the decision row, waits for the touch
        await waitUntilBlocked();
        const cleaning = await settle(linker.query(DELETE_DECISION, [touchId])); // waits for the decision row: a cycle
        if (cleaning === "done") {
          // the UPDATE was the victim: the link goes through, with its cleanup and history
          expect(await deciding).toMatchObject({ code: DEADLOCK_DETECTED });
          await linkedEvent(linker, w, l.id, touchId);
          await linker.query("commit");
          expect(await leadIdOf(touchId)).toBe(l.id);
          expect(await decisionOf(touchId)).toBeUndefined();
        } else {
          // the link was the victim: its transaction is over, and the decision stands
          expect(cleaning).toMatchObject({ code: DEADLOCK_DETECTED });
          await linker.query("rollback");
          expect(await deciding).toBe("done");
          expect(await leadIdOf(touchId)).toBeNull();
          expect(await decisionOf(touchId)).toEqual({ decision: "PARKED", attempts: 5 });
        }
      } finally {
        await linker.query("rollback").catch(() => undefined);
        linker.release();
      }
    });

    it("M2. a RETRY row cannot be deleted before its touch is linked, so its attempts cannot be reset", async () => {
      const { w, l, touchId } = await setup(4);
      await expectRaise(q(DELETE_DECISION, [touchId]), CHECK_VIOLATION, deleteNeedsLink);
      // the reset, in one transaction
      await expectRaise(
        tx(async (c) => {
          await c.query(DELETE_DECISION, [touchId]);
          await retryRow(w, touchId, 1, c);
        }),
        CHECK_VIOLATION,
        deleteNeedsLink,
      );
      // a fresh row beside the old one, or the old one counted down
      await expectPgError(retryRow(w, touchId, 1), UNIQUE_VIOLATION, "lead_reconcile_decisions_pk");
      await expectRaise(
        q(
          "update lead_reconcile_decisions set attempts = 1, next_attempt_at = clock_timestamp() + interval '1 hour' where attribution_id = $1",
          [touchId],
        ),
        CHECK_VIOLATION,
        "attempts never decrease",
      );
      // DELETE before the link is refused inside the linking transaction as well: the order is link, then DELETE
      await expectRaise(
        tx(async (c) => {
          await c.query(DELETE_DECISION, [touchId]);
          await linkOnly(c, l.id, touchId);
          await linkedEvent(c, w, l.id, touchId);
        }),
        CHECK_VIOLATION,
        deleteNeedsLink,
      );
      expect(await decisionOf(touchId)).toEqual({ decision: "RETRY", attempts: 4 });
      expect(await leadIdOf(touchId)).toBeNull();

      // the legitimate cleanup: link, DELETE, history, one transaction
      await linkAndClean(w, l.id, touchId);
      expect(await leadIdOf(touchId)).toBe(l.id);
      expect(await decisionOf(touchId)).toBeUndefined();
      // and no new attempt sequence can be started for the touch afterwards
      await expectRaise(retryRow(w, touchId, 1), CHECK_VIOLATION, linkedHasNone);
    });

    it("M2. a DELETE that races a link: the link without its own cleanup cannot commit, and the row keeps its attempts", async () => {
      const { w, l, touchId } = await setup(4);
      const linker = await t.pool.connect();
      try {
        await linker.query("begin");
        await linkOnly(linker, l.id, touchId);
        await linkedEvent(linker, w, l.id, touchId);
        const deleting = settle(q(DELETE_DECISION, [touchId]));
        await waitUntilBlocked(); // the DELETE has the decision row and waits for the touch
        await expectRaise(linker.query("commit"), INTEGRITY_VIOLATION, stillDecided);
        expect(await deleting).toMatchObject({
          code: CHECK_VIOLATION,
          message: expect.stringContaining(deleteNeedsLink),
        });
      } finally {
        linker.release();
      }
      expect(await leadIdOf(touchId)).toBeNull();
      expect(await decisionOf(touchId)).toEqual({ decision: "RETRY", attempts: 4 });
      expect(await eventCount(l.id)).toBe(0);
    });

    it("M2. a DELETE that races a link which cleans up after itself waits and then finds nothing to delete", async () => {
      const { w, l, touchId } = await setup(4);
      const linker = await t.pool.connect();
      try {
        await linker.query("begin");
        await linkOnly(linker, l.id, touchId);
        await linker.query(DELETE_DECISION, [touchId]);
        await linkedEvent(linker, w, l.id, touchId);
        const deleting = q(DELETE_DECISION, [touchId]);
        await waitUntilBlocked();
        await linker.query("commit");
        expect((await deleting).rowCount).toBe(0);
      } finally {
        linker.release();
      }
      expect(await leadIdOf(touchId)).toBe(l.id);
      expect(await decisionOf(touchId)).toBeUndefined();
      expect(await eventCount(l.id)).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------------------- review M3
  describe("review M3: a retry is scheduled in the future, by the database clock", () => {
    const mustBeFuture = "a retry is scheduled in the future, by the database clock";
    /** `next` is SQL (evaluated by the database) unless a parameter is given. */
    const insertRetry = (w: World, touchId: string, next: string, params: unknown[] = []) =>
      q(
        `insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts, next_attempt_at)
         values ($1, $2, $3, 'RETRY', 1, ${next})`,
        [w.org.id, touchId, w.contact.id, ...params],
      );
    const upd = (touchId: string, set: string) =>
      q(`update lead_reconcile_decisions set ${set} where attribution_id = $1`, [touchId]);
    /** Waits until the DATABASE clock has passed the row's due time (a condition on the database, not a fixed sleep). */
    async function untilDue(touchId: string) {
      for (let i = 0; i < 500; i++) {
        const r = await one<{ due: boolean }>(
          "select clock_timestamp() > next_attempt_at as due from lead_reconcile_decisions where attribution_id = $1",
          [touchId],
        );
        if (r.due) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("the retry never became due");
    }
    const SHORTLY = "clock_timestamp() + interval '250 milliseconds'";

    it("a new RETRY is refused unless it is due later than now on the database clock; the writer's clock does not matter", async () => {
      const w = await world();
      for (const past of [
        "clock_timestamp() - interval '1 day'",
        "clock_timestamp() - interval '1 microsecond'",
        "now()",
      ])
        await expectRaise(insertRetry(w, await touch(w), past), CHECK_VIOLATION, mustBeFuture);
      for (const future of [
        "clock_timestamp() + interval '2 seconds'",
        "clock_timestamp() + interval '2 hours'",
      ])
        await insertRetry(w, await touch(w), future);
      // a writer whose own clock is an hour slow asks for "in one minute": that is 59 minutes ago here, and refused;
      // one whose clock is an hour fast gets a retry that is simply due later
      const writerClock = (offsetMs: number) => new Date(Date.now() + offsetMs + 60_000);
      await expectRaise(
        insertRetry(w, await touch(w), "$4", [writerClock(-3600_000)]),
        CHECK_VIOLATION,
        mustBeFuture,
      );
      await insertRetry(w, await touch(w), "$4", [writerClock(3600_000)]);
      // inside a transaction the comparison is with the clock at the moment of the write, not with the transaction's start
      const late = await touch(w);
      await expectRaise(
        tx(async (c) => {
          const start = (await c.query("select now() + interval '200 milliseconds' as t")).rows[0]
            .t as Date;
          for (let i = 0; i < 500; i++) {
            if ((await c.query("select clock_timestamp() > $1 as passed", [start])).rows[0].passed)
              break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          await c.query(
            "insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts, next_attempt_at) values ($1, $2, $3, 'RETRY', 1, now() + interval '200 milliseconds')",
            [w.org.id, late, w.contact.id],
          ); // later than the transaction's start, already past on the clock
        }),
        CHECK_VIOLATION,
        mustBeFuture,
      );
    });

    it("a waiting retry becomes due and stays valid: only assigning a schedule is checked", async () => {
      const w = await world();
      const l = await lead(w, { cycleStartedAt: minutesAgo(60) });
      const [advanced, parked, skipped, linked] = [
        await touch(w),
        await touch(w),
        await touch(w),
        await touch(w),
      ];
      for (const touchId of [advanced, parked, skipped, linked])
        await insertRetry(w, touchId, SHORTLY);
      await untilDue(linked); // the last one inserted: all four are due now, and nothing rejected them for it

      // updates that assign no schedule are fine on a due row
      await upd(advanced, "last_error_code = 'db_timeout', updated_at = now()");
      await upd(advanced, "next_attempt_at = next_attempt_at, attempts = attempts");
      // the next attempt cannot reuse the schedule that has already passed, nor be given another past time
      for (const set of [
        "attempts = attempts + 1",
        "next_attempt_at = clock_timestamp() - interval '1 second'",
        "attempts = 2, next_attempt_at = now()",
        "next_attempt_at = next_attempt_at + interval '1 microsecond'",
      ])
        await expectRaise(upd(advanced, set), CHECK_VIOLATION, mustBeFuture);
      expect(await decisionOf(advanced)).toEqual({ decision: "RETRY", attempts: 1 });
      // the next attempt with a new future schedule
      await upd(advanced, `attempts = 2, next_attempt_at = ${SHORTLY}`);
      expect(await decisionOf(advanced)).toEqual({ decision: "RETRY", attempts: 2 });
      await untilDue(advanced);
      await upd(advanced, "attempts = 4, next_attempt_at = clock_timestamp() + interval '2 hours'");

      // a due retry can be parked (in its exact shape), skipped for good, or linked and cleaned up
      await expectPgError(
        upd(parked, "decision = 'PARKED', attempts = 5"), // still carries a due time
        CHECK_VIOLATION,
        "lead_reconcile_decisions_shape_check",
      );
      await expectPgError(
        upd(parked, "decision = 'PARKED', attempts = 4, next_attempt_at = null"),
        CHECK_VIOLATION,
        "lead_reconcile_decisions_shape_check",
      );
      await q(PARK, [parked]);
      expect(await decisionOf(parked)).toEqual({ decision: "PARKED", attempts: 5 });
      await upd(skipped, "decision = 'SKIPPED_ARCHIVED', next_attempt_at = null");
      expect(await decisionOf(skipped)).toEqual({ decision: "SKIPPED_ARCHIVED", attempts: 1 });
      await linkAndClean(w, l.id, linked);
      expect(await leadIdOf(linked)).toBe(l.id);
      expect(await decisionOf(linked)).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------------------------------- catalog
  it("the indexes and triggers the design relies on exist", async () => {
    const indexes = new Map(
      (await q("select indexname, indexdef from pg_indexes where schemaname = 'public'")).rows.map(
        (r) => [r.indexname as string, r.indexdef as string],
      ),
    );
    expect(indexes.get("leads_org_contact_open_uidx")).toMatch(
      /CREATE UNIQUE INDEX .* \(organization_id, contact_id\) WHERE \(status = ANY \(ARRAY\['NEW'::text, 'QUALIFIED'::text, 'INTERESTED'::text, 'REGISTRATION_STARTED'::text, 'REGISTERED'::text, 'PAID'::text\]\)\)/,
    );
    expect(indexes.get("lead_attributions_unlinked_ad_idx")).toMatch(
      /\(received_at, id\) WHERE \(\(lead_id IS NULL\) AND \(source_type = 'META_AD'::text\) AND \(message_id IS NOT NULL\)\)/,
    );
    expect(indexes.get("lead_reconcile_decisions_due_idx")).toMatch(
      /\(next_attempt_at, attribution_id\) WHERE \(decision = 'RETRY'::text\)/,
    );
    for (const name of [
      "leads_org_created_idx",
      "lead_events_lead_idx",
      "lead_events_created_uidx",
      "lead_events_created_attribution_uidx",
      "lead_events_touch_linked_uidx",
      "lead_events_status_revision_uidx",
      "lead_attributions_org_id_contact_unique",
      "lead_attributions_org_message_uidx", // migration 0003, still there
    ])
      expect(indexes.has(name), name).toBe(true);
    const triggers = (
      await q(
        "select tgname, tgdeferrable, tginitdeferred from pg_trigger where not tgisinternal and tgname like 'lead%' order by tgname",
      )
    ).rows;
    expect(triggers).toEqual([
      { tgname: "lead_attributions_guard_trg", tgdeferrable: false, tginitdeferred: false },
      { tgname: "lead_attributions_link_history_trg", tgdeferrable: true, tginitdeferred: true },
      { tgname: "lead_events_append_only_trg", tgdeferrable: false, tginitdeferred: false },
      { tgname: "lead_events_creating_touch_trg", tgdeferrable: true, tginitdeferred: true },
      { tgname: "lead_events_guard_trg", tgdeferrable: false, tginitdeferred: false },
      { tgname: "lead_reconcile_decisions_guard_trg", tgdeferrable: false, tginitdeferred: false },
      { tgname: "leads_ad_creation_history_trg", tgdeferrable: true, tginitdeferred: true },
      { tgname: "leads_insert_guard_trg", tgdeferrable: false, tginitdeferred: false },
      { tgname: "leads_status_history_trg", tgdeferrable: true, tginitdeferred: true },
      { tgname: "leads_transition_guard_trg", tgdeferrable: false, tginitdeferred: false },
    ]);
  });
});
