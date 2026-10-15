import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { seedAccount, seedConversation } from "@/db/__tests__/helpers";
import { seedLead, world } from "../testing";
import { DEFAULT_OPTIONS } from "./config";
import { recordFailure } from "./failure";
import { processCandidate } from "./process";
import { readRemaining, scanCandidates } from "./scan";
import { addContact, addTouch, fixture, makeDue, minutesAgo, type Fixture } from "./testing";

// Review (evidence integrity): an attribution's message must belong to the attribution's OWN contact. The schema ties a touch to a
// message of the same ORGANIZATION only (lead_attributions (organization_id, message_id) -> messages), so a touch of contact B may
// reference an inbound message of contact A. Ownership is proved through the message's conversation (messages.conversation_id ->
// conversations.contact_id). Such evidence is never a candidate, never linked, never initiates a lead, never gets a decision,
// never holds another touch back and is never counted. Real PostgreSQL, every production trigger enabled.

describe("lead reconciler: a touch's message must belong to the touch's own contact", () => {
  let f: Fixture;
  const fetchSpy = vi.fn(() => {
    throw new Error("the reconciler must never make a network request");
  });
  beforeEach(async () => {
    f = await fixture();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await f.close();
  });

  const count = async (sql: string, params: unknown[] = []) =>
    (await f.one<{ n: number }>(`select count(*)::int n from ${sql}`, params)).n;
  const linkOf = async (id: string) =>
    (
      await f.one<{ lead_id: string | null }>(
        "select lead_id from lead_attributions where id = $1",
        [id],
      )
    ).lead_id;
  const candidateOf = (organizationId: string, attributionId: string, contactId: string) => ({
    organizationId,
    attributionId,
    contactId,
    receivedKey: "",
  });

  type W = { org: { id: string }; account: { id: string } };
  /** An INBOUND message in the conversation of `contactId` on `accountId` (the conversation is created when missing). */
  async function inboundMessage(
    w: W,
    contactId: string,
    accountId = w.account.id,
    occurredAt = minutesAgo(10),
  ) {
    let conversation = (
      await f.q<{ id: string }>(
        "select id from conversations where organization_id = $1 and whatsapp_account_id = $2 and contact_id = $3",
        [w.org.id, accountId, contactId],
      )
    )[0];
    conversation ??= await seedConversation(f.t.db, {
      organizationId: w.org.id,
      whatsappAccountId: accountId,
      contactId,
    });
    const [message] = await f.t.db
      .insert(schema.messages)
      .values({
        organizationId: w.org.id,
        conversationId: conversation.id,
        whatsappAccountId: accountId,
        direction: "INBOUND",
        type: "TEXT",
        body: "hello",
        occurredAt,
        wamid: `wamid.O${Math.random().toString(36).slice(2)}${Date.now()}`,
      })
      .returning();
    return message!.id;
  }
  /** An unlinked META_AD touch of `contactId` that names `messageId` (written the way any writer could: production rules on). */
  async function touchWithMessage(
    w: W,
    contactId: string,
    messageId: string,
    receivedAt = minutesAgo(5),
  ) {
    const [touch] = await f.t.db
      .insert(schema.leadAttributions)
      .values({
        organizationId: w.org.id,
        contactId,
        messageId,
        sourceType: "META_AD",
        sourceId: "120000000000001",
        receivedAt,
      })
      .returning();
    return touch!;
  }
  /** A RETRY decision for a touch, as a failed attempt would have recorded it (not due). */
  async function retryOf(w: W, touchId: string, contactId: string) {
    await f.q(
      `insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts, next_attempt_at)
       values ($1, $2, $3, 'RETRY', 1, clock_timestamp() + interval '1 hour')`,
      [w.org.id, touchId, contactId],
    );
  }
  async function parkedOf(w: W, touchId: string, contactId: string) {
    await f.q(
      `insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts)
       values ($1, $2, $3, 'PARKED', 5)`,
      [w.org.id, touchId, contactId],
    );
  }

  it("A. the reproduction: B's touch names A's inbound message; the database accepts it, and the reconciler does nothing with it anywhere", async () => {
    const a = f.w.contact; // owns the fixture's conversation
    const b = await addContact(f.t.db, f.w.org.id);
    const message = await inboundMessage(f.w, a.id);
    const wrong = await touchWithMessage(f.w, b.id, message); // accepted: the schema checks the organization only
    expect(wrong.contactId).toBe(b.id);

    expect(await scanCandidates(f.t.db, null, 100, DEFAULT_OPTIONS)).toEqual([]);
    const report = await f.run();
    expect(report).toMatchObject({ fetched: 0, scanned: 0, processed: 0, created: 0, linked: 0 });
    // a scan result is never trusted: handled directly (as if a stale scan had returned it), it is still refused under the locks
    expect(
      await processCandidate(f.t.db, candidateOf(f.w.org.id, wrong.id, b.id), DEFAULT_OPTIONS),
    ).toEqual({ kind: "gone" });
    // failure recording refuses it too: no RETRY, no PARKED
    expect(
      await recordFailure(
        f.t.db,
        candidateOf(f.w.org.id, wrong.id, b.id),
        "pg_p0001",
        DEFAULT_OPTIONS,
        {
          prior: { kind: "absent" },
        },
      ),
    ).toEqual({ kind: "gone" });
    expect(await count("leads")).toBe(0);
    expect(await count("leads where initiating_attribution_id is not null")).toBe(0);
    expect(await count("lead_events")).toBe(0);
    expect(await linkOf(wrong.id)).toBeNull();
    expect(await count("lead_reconcile_decisions")).toBe(0);
    expect(await readRemaining(f.t.db, DEFAULT_OPTIONS)).toMatchObject({
      known: true,
      due: 0,
      retryWaiting: 0,
      parked: 0,
    });
    // the evidence itself is untouched
    expect(
      await f.one("select contact_id, message_id from lead_attributions where id = $1", [wrong.id]),
    ).toEqual({ contact_id: b.id, message_id: message });
  });

  it("B and I. a touch naming its OWN contact's inbound message is a candidate and creates one lead with correct provenance and history", async () => {
    const b = await addContact(f.t.db, f.w.org.id);
    const own = await touchWithMessage(f.w, b.id, await inboundMessage(f.w, b.id));
    expect(
      (await scanCandidates(f.t.db, null, 100, DEFAULT_OPTIONS)).map((c) => c.attributionId),
    ).toEqual([own.id]);
    expect(await f.run()).toMatchObject({ created: 1, processed: 1 });
    const lead = await f.one<{ id: string; initiating_attribution_id: string; contact_id: string }>(
      "select id, initiating_attribution_id, contact_id from leads",
    );
    expect(lead).toMatchObject({ initiating_attribution_id: own.id, contact_id: b.id });
    expect(await linkOf(own.id)).toBe(lead.id);
    expect(
      await f.q("select kind, origin, attribution_id from lead_events order by created_at"),
    ).toEqual([
      { kind: "CREATED", origin: "AD_REFERRAL", attribution_id: own.id },
      { kind: "TOUCH_LINKED", origin: null, attribution_id: own.id },
    ]);
    expect(await count("lead_reconcile_decisions")).toBe(0);
    // run again: nothing duplicated
    expect(await f.run()).toMatchObject({ created: 0, linked: 0 });
    expect(await count("leads")).toBe(1);
  });

  it("C. a contact with an OPEN lead: wrong-contact evidence is never linked to it (no TOUCH_LINKED); its own evidence is", async () => {
    const a = f.w.contact;
    const b = await addContact(f.t.db, f.w.org.id);
    const lead = await seedLead(f.t.db, f.w, b.id, { cycleStartedAt: minutesAgo(60) });
    const wrong = await touchWithMessage(f.w, b.id, await inboundMessage(f.w, a.id), minutesAgo(6));
    expect(await f.run()).toMatchObject({ linked: 0, created: 0, scanned: 0 });
    expect(
      await processCandidate(f.t.db, candidateOf(f.w.org.id, wrong.id, b.id), DEFAULT_OPTIONS),
    ).toEqual({ kind: "gone" });
    expect(await linkOf(wrong.id)).toBeNull();
    expect(await count("lead_events where kind = 'TOUCH_LINKED'")).toBe(0);
    // the contact's own evidence links normally
    const own = await touchWithMessage(f.w, b.id, await inboundMessage(f.w, b.id), minutesAgo(4));
    expect(await f.run()).toMatchObject({ linked: 1 });
    expect(await linkOf(own.id)).toBe(lead.id);
    expect(await linkOf(wrong.id)).toBeNull();
    expect(await count("leads where closed_at is null and contact_id = $1", [b.id])).toBe(1);
  });

  it("D. an earlier RETRY on wrong-contact evidence does not hold a later valid touch back (a valid earlier RETRY still does)", async () => {
    const a = f.w.contact;
    // contact B: earlier wrong-contact touch with a RETRY, later valid touch
    const b = await addContact(f.t.db, f.w.org.id);
    const wrong = await touchWithMessage(f.w, b.id, await inboundMessage(f.w, a.id), minutesAgo(8));
    await retryOf(f.w, wrong.id, b.id);
    const later = await touchWithMessage(f.w, b.id, await inboundMessage(f.w, b.id), minutesAgo(3));
    // contact C (the control): earlier VALID touch with a RETRY, later valid touch: held back
    const c = await addContact(f.t.db, f.w.org.id);
    const held = await touchWithMessage(f.w, c.id, await inboundMessage(f.w, c.id), minutesAgo(8));
    await retryOf(f.w, held.id, c.id);
    const heldLater = await touchWithMessage(
      f.w,
      c.id,
      await inboundMessage(f.w, c.id),
      minutesAgo(3),
    );

    const report = await f.run();
    expect(report).toMatchObject({ created: 1, waiting: 0 });
    expect(await linkOf(later.id)).not.toBeNull();
    expect(await linkOf(heldLater.id)).toBeNull(); // still held by C's valid RETRY (left out of the scan by the hold)
    // and handled directly, the held touch is `waiting` while B's is not
    expect(
      await processCandidate(f.t.db, candidateOf(f.w.org.id, heldLater.id, c.id), DEFAULT_OPTIONS),
    ).toEqual({ kind: "waiting" });
    expect(await linkOf(wrong.id)).toBeNull();
  });

  it("E. remaining counts take only correctly owned evidence: undecided, RETRY waiting, RETRY due and PARKED", async () => {
    const a = f.w.contact;
    const own = async () => {
      const c = await addContact(f.t.db, f.w.org.id);
      return { c, t: await touchWithMessage(f.w, c.id, await inboundMessage(f.w, c.id)) };
    };
    const wrong = async () => {
      const c = await addContact(f.t.db, f.w.org.id);
      return { c, t: await touchWithMessage(f.w, c.id, await inboundMessage(f.w, a.id)) };
    };
    for (const make of [own, wrong]) {
      await make(); // undecided
      const waiting = await make();
      await retryOf(f.w, waiting.t.id, waiting.c.id);
      const due = await make();
      await retryOf(f.w, due.t.id, due.c.id);
      await makeDue(f.t, due.t.id);
      const parked = await make();
      await parkedOf(f.w, parked.t.id, parked.c.id);
    }
    expect(await readRemaining(f.t.db, DEFAULT_OPTIONS)).toEqual({
      known: true,
      due: 2, // own undecided + own due RETRY
      dueCapped: false,
      retryWaiting: 1,
      parked: 1,
    });
    // and the scan agrees: exactly the two own due touches
    expect(await scanCandidates(f.t.db, null, 100, DEFAULT_OPTIONS)).toHaveLength(2);
  });

  it("F. a contact with conversations on TWO WhatsApp accounts: its evidence on either account is eligible", async () => {
    const second = await seedAccount(f.t.db, f.w.org.id);
    const b = await addContact(f.t.db, f.w.org.id);
    const one = await touchWithMessage(
      f.w,
      b.id,
      await inboundMessage(f.w, b.id, f.w.account.id, minutesAgo(9)),
      minutesAgo(9),
    );
    const two = await touchWithMessage(
      f.w,
      b.id,
      await inboundMessage(f.w, b.id, second.id, minutesAgo(4)),
      minutesAgo(4),
    );
    expect(
      (await scanCandidates(f.t.db, null, 100, DEFAULT_OPTIONS)).map((c) => c.attributionId),
    ).toEqual([one.id, two.id]); // in order, one row each (the ownership join multiplies nothing)
    expect(await f.run()).toMatchObject({ created: 1, linked: 1 });
    expect(await linkOf(one.id)).not.toBeNull();
    expect(await linkOf(two.id)).toBe(await linkOf(one.id));
  });

  it("G and H. tenants are never mixed, and every negative case stays rejected: outbound, no message, non-META_AD, wrong contact, wrong organization", async () => {
    const a = f.w.contact;
    const other = await world(f.t.db);
    // wrong organization: the schema itself refuses a touch naming another organization's message
    const foreignMessage = await inboundMessage(other, other.contact.id);
    const b = await addContact(f.t.db, f.w.org.id);
    await expect(touchWithMessage(f.w, b.id, foreignMessage)).rejects.toThrow();
    // the negatives in this organization
    await addTouch(f.t.db, f.w, b.id, { direction: "OUTBOUND", receivedAt: minutesAgo(9) });
    await addTouch(f.t.db, f.w, b.id, { withMessage: false, receivedAt: minutesAgo(8) });
    await addTouch(f.t.db, f.w, b.id, { sourceType: "FACEBOOK_AD", receivedAt: minutesAgo(7) });
    const wrong = await touchWithMessage(f.w, b.id, await inboundMessage(f.w, a.id), minutesAgo(6));
    // one valid touch in each organization
    const mine = await touchWithMessage(f.w, b.id, await inboundMessage(f.w, b.id), minutesAgo(5));
    const theirs = await touchWithMessage(other, other.contact.id, foreignMessage, minutesAgo(5));
    const scanned = await scanCandidates(f.t.db, null, 100, DEFAULT_OPTIONS);
    expect(scanned.map((c) => c.attributionId).sort()).toEqual([mine.id, theirs.id].sort());
    expect(await f.run()).toMatchObject({ created: 2, scanned: 2 });
    expect(await count("leads where organization_id = $1", [f.w.org.id])).toBe(1);
    expect(await count("leads where organization_id = $1", [other.org.id])).toBe(1);
    expect(await linkOf(wrong.id)).toBeNull();
    // every lead and link stays inside its own organization and contact
    expect(
      await count(
        `lead_attributions t join leads l on l.id = t.lead_id
         where l.organization_id <> t.organization_id or l.contact_id <> t.contact_id`,
      ),
    ).toBe(0);
    expect(await count("lead_reconcile_decisions")).toBe(0);
  });
});
