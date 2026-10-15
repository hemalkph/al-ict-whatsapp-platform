import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contactLockKey } from "../locks";
import { world } from "../testing";
import { DEFAULT_OPTIONS } from "./config";
import { readRemaining, scanCandidates } from "./scan";
import { addContact, addTouch, fixture, makeDue, minutesAgo, type Fixture } from "./testing";

// Second review: (1) the remaining-work counts describe the SAME population the reconciler can act on (confirmed Meta ad touches of
// INBOUND messages that are unlinked), so legacy decisions of outbound-tied touches are not reported as work; (2) the scan's test
// for "this contact's advisory lock is held" looks only at locks of THIS database: pg_locks lists the locks of the whole cluster,
// and an identical key held in another database must not hide a candidate here.

describe("lead reconciler: remaining-work counts", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => f.close());

  const decide = (org: string, touchId: string, contactId: string, decision: "RETRY" | "PARKED") =>
    f.q(
      decision === "RETRY"
        ? "insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts, next_attempt_at, last_error_code) values ($1,$2,$3,'RETRY',1, clock_timestamp() + interval '1 hour', 'pg_p0001')"
        : "insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts, last_error_code) values ($1,$2,$3,'PARKED',5,'pg_p0001')",
      [org, touchId, contactId],
    );

  it("legacy OUTBOUND decisions are not counted; valid INBOUND ones are, in both organizations; other evidence is excluded", async () => {
    const other = await world(f.t.db); // a second organization: its valid rows count too, nothing leaks between the two
    const org = f.w.org.id;
    const make = async (
      w: typeof f.w,
      o: Parameters<typeof addTouch>[3],
      decision?: "RETRY" | "PARKED",
    ) => {
      const contact = await addContact(f.t.db, w.org.id);
      const touch = await addTouch(f.t.db, w, contact.id, { receivedAt: minutesAgo(10), ...o });
      if (decision) await decide(w.org.id, touch.id, contact.id, decision);
      return touch;
    };
    // org 1
    await make(f.w, {}, "RETRY"); // counted: waiting
    await make(f.w, {}, "PARKED"); // counted: parked
    await make(f.w, { direction: "OUTBOUND" }, "RETRY"); // legacy, never processed: NOT counted
    await make(f.w, { direction: "OUTBOUND" }, "PARKED"); // legacy: NOT counted
    await make(f.w, { sourceType: "REFERRAL" }, "RETRY"); // not a Meta ad touch: NOT counted
    await make(f.w, { sourceType: "REFERRAL" }, "PARKED"); // NOT counted
    await make(f.w, { withMessage: false }, "RETRY"); // no message: NOT counted
    await make(f.w, { withMessage: false }, "PARKED"); // NOT counted
    // undecided work and a due retry
    await make(f.w, {}); // due
    await make(f.w, { direction: "OUTBOUND" }); // undecided outbound: NOT due
    const dueRetry = await make(f.w, {}, "RETRY");
    await makeDue(f.t, dueRetry.id); // due, no longer waiting
    const dueOutbound = await make(f.w, { direction: "OUTBOUND" }, "RETRY");
    await makeDue(f.t, dueOutbound.id); // outbound: NOT due
    // org 2: one valid waiting, one valid parked, one outbound of each
    await make(other, {}, "RETRY");
    await make(other, {}, "PARKED");
    await make(other, { direction: "OUTBOUND" }, "RETRY");
    await make(other, { direction: "OUTBOUND" }, "PARKED");
    // a LINKED touch of org 1 (it can have no decision) is neither work nor waiting nor parked
    const linkedContact = await addContact(f.t.db, org);
    await addTouch(f.t.db, f.w, linkedContact.id, { receivedAt: minutesAgo(5) });
    await f.run({ batchSize: 1000 });
    const remaining = await readRemaining(f.t.db, DEFAULT_OPTIONS);
    // waiting: the two valid RETRYs created above (org 1 and org 2), plus whatever the run just scheduled (nothing failed)
    expect(remaining).toMatchObject({ known: true, retryWaiting: 2, parked: 2 });
  });

  it("the definitions agree with the scan: exactly the touches the scan can return are 'due', and no waiting or parked row is one the scan could never return", async () => {
    const mk = async (o: Parameters<typeof addTouch>[3], decision?: "RETRY" | "PARKED") => {
      const contact = await addContact(f.t.db, f.w.org.id);
      const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(10), ...o });
      if (decision) await decide(f.w.org.id, touch.id, contact.id, decision);
      return touch;
    };
    await mk({}); // due
    await mk({ direction: "OUTBOUND" });
    await mk({}, "RETRY");
    await mk({ direction: "OUTBOUND" }, "RETRY");
    await mk({}, "PARKED");
    await mk({ direction: "OUTBOUND" }, "PARKED");
    const scanned = await scanCandidates(f.t.db, null, 100, DEFAULT_OPTIONS);
    const remaining = await readRemaining(f.t.db, DEFAULT_OPTIONS);
    expect(scanned).toHaveLength(1);
    expect(remaining).toMatchObject({ known: true, due: 1, retryWaiting: 1, parked: 1 });
  });
});

describe("lead reconciler: the busy-contact test of the scan is limited to this database", () => {
  let a: Fixture;
  let b: Fixture;
  beforeEach(async () => {
    a = await fixture();
    b = await fixture();
  });
  afterEach(async () => {
    await a.close();
    await b.close();
  });

  /** Holds the contact's advisory lock (the application's own key) in the given database until released. */
  async function hold(f: Fixture, key: string) {
    const c = await f.t.pool.connect();
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    return {
      async release() {
        await c.query("commit");
        c.release();
      },
    };
  }

  it("a lock held in ANOTHER database does not hide the candidate here; a lock held HERE does; for both signs of the key", async () => {
    // contacts until both a negative and a positive 64-bit key occur (the key is signed: its halves are rebuilt in SQL)
    const contacts: Array<{ id: string; negative: boolean; touchId: string }> = [];
    for (
      let i = 0;
      i < 60 && (contacts.length < 8 || new Set(contacts.map((c) => c.negative)).size < 2);
      i++
    ) {
      const contact = await addContact(a.t.db, a.w.org.id);
      const negative = (
        await a.one<{ n: boolean }>("select hashtextextended($1, 0) < 0 as n", [
          contactLockKey(a.w.org.id, contact.id),
        ])
      ).n;
      const touch = await addTouch(a.t.db, a.w, contact.id, {
        receivedAt: minutesAgo(30 - i / 10),
      });
      contacts.push({ id: contact.id, negative, touchId: touch.id });
    }
    expect(contacts.some((c) => c.negative)).toBe(true);
    expect(contacts.some((c) => !c.negative)).toBe(true);

    // database B holds the SAME keys (same organization and contact ids as text)
    const inB = [];
    for (const c of contacts) inB.push(await hold(b, contactLockKey(a.w.org.id, c.id)));
    try {
      // the keys are really in use in B, and really obtainable in A
      const locks = await a.one<{ n: number }>(
        "select count(*)::int n from pg_locks where locktype = 'advisory' and granted",
      );
      expect(locks.n).toBeGreaterThanOrEqual(contacts.length); // pg_locks shows them cluster-wide
      for (const c of contacts)
        expect(
          (
            await a.one<{ ok: boolean }>(
              "select pg_try_advisory_lock(hashtextextended($1, 0)) as ok",
              [contactLockKey(a.w.org.id, c.id)],
            )
          ).ok,
        ).toBe(true);
      await a.q("select pg_advisory_unlock_all()");
      // so nothing is hidden in A
      const seen = await scanCandidates(a.t.db, null, 100, DEFAULT_OPTIONS);
      expect(seen.map((s) => s.attributionId).sort()).toEqual(
        contacts.map((c) => c.touchId).sort(),
      );
    } finally {
      for (const h of inB) await h.release();
    }

    // locks held in A itself DO hide the matching candidates (both signs)
    const inA = [];
    for (const c of contacts) inA.push(await hold(a, contactLockKey(a.w.org.id, c.id)));
    try {
      expect(await scanCandidates(a.t.db, null, 100, DEFAULT_OPTIONS)).toEqual([]);
    } finally {
      for (const h of inA) await h.release();
    }
    expect(await scanCandidates(a.t.db, null, 100, DEFAULT_OPTIONS)).toHaveLength(contacts.length);
  }, 120_000);

  it("no false match across tenants: another organization's key, or another contact's, does not hide a candidate", async () => {
    const contact = await addContact(a.t.db, a.w.org.id);
    await addTouch(a.t.db, a.w, contact.id, { receivedAt: minutesAgo(5) });
    const otherOrg = await world(a.t.db);
    const otherContact = await addContact(a.t.db, otherOrg.org.id);
    const locks = [
      await hold(a, contactLockKey(otherOrg.org.id, contact.id)), // the contact's id under ANOTHER organization
      await hold(a, contactLockKey(a.w.org.id, otherContact.id)), // another contact in this organization's namespace
      await hold(a, `other-namespace:${a.w.org.id}:${contact.id}`), // the right ids under another key namespace
    ];
    try {
      expect(await scanCandidates(a.t.db, null, 100, DEFAULT_OPTIONS)).toHaveLength(1);
    } finally {
      for (const l of locks) await l.release();
    }
    // and the real key hides it
    const real = await hold(a, contactLockKey(a.w.org.id, contact.id));
    try {
      expect(await scanCandidates(a.t.db, null, 100, DEFAULT_OPTIONS)).toEqual([]);
    } finally {
      await real.release();
    }
  });
});
