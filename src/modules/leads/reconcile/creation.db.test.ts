import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { insertAttributionOnce } from "@/db/ops/inbound-message";
import { changeLeadStatus, createManualLead } from "../index";
import { seedLead } from "../testing";
import {
  DAY,
  addContact,
  addTouch,
  daysAgo,
  fixture,
  makeDue,
  minutesAgo,
  type Fixture,
} from "./testing";
import { injectFailure, removeFailure } from "./testing";
import { DEFAULT_OPTIONS } from "./config";
import { recordFailure } from "./failure";
import { processCandidate } from "./process";
import { scanCandidates } from "./scan";

// The reconciler on REAL PostgreSQL (one disposable database per test, so a run's counts are exact): which touches create leads, which
// are linked to an open lead, which are skipped for good and why. Every assertion about a lead, its history or a decision is
// made on the database rows, not on what the service says.

describe("lead reconciler: eligibility, lead cycles and automatic creation", () => {
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

  const deps = () => ({ db: f.t.db });
  const lead = (id: string) =>
    f.one<{
      status: string;
      revision: number;
      closed_at: Date | null;
      cycle_started_at: Date;
      created_at: Date;
      status_changed_at: Date;
      initiating_attribution_id: string | null;
      contact_id: string;
    }>("select * from leads where id = $1", [id]);
  const leadsOf = (contactId: string) =>
    f.q<{ id: string; status: string; initiating_attribution_id: string | null }>(
      "select id, status, initiating_attribution_id from leads where contact_id = $1 order by created_at, id",
      [contactId],
    );
  const linkOf = async (touchId: string) =>
    (
      await f.one<{ lead_id: string | null }>(
        "select lead_id from lead_attributions where id = $1",
        [touchId],
      )
    ).lead_id;
  const decisionOf = async (touchId: string) =>
    (
      await f.q<{ decision: string; attempts: number; next_attempt_at: Date | null }>(
        "select decision, attempts, next_attempt_at from lead_reconcile_decisions where attribution_id = $1",
        [touchId],
      )
    )[0];
  const eventsOf = (leadId: string) =>
    f.q<{
      kind: string;
      origin: string | null;
      attribution_id: string | null;
      actor_membership_id: string | null;
      revision: number | null;
    }>(
      "select kind, origin, attribution_id, actor_membership_id, revision from lead_events where lead_id = $1 order by created_at, id",
      [leadId],
    );
  const count = async (table: string) =>
    (await f.one<{ n: number }>(`select count(*)::int n from ${table}`)).n;

  // ------------------------------------------------------------------------------------------ first lead
  it("a confirmed Meta ad touch creates exactly one NEW lead that names it, with CREATED and TOUCH_LINKED history, atomically", async () => {
    const touch = await addTouch(f.t.db, f.w, f.w.contact.id, {
      receivedAt: minutesAgo(5),
      occurredAt: new Date(minutesAgo(5).getTime() - 4_000), // the provider's time is a few seconds earlier, as usual
    });
    const before = {
      messages: await count("messages"),
      consents: await count("contact_consents"),
      conversations: await count("conversations"),
      outbound: await count("outbound_requests"),
      webhook: await count("webhook_events"),
    };
    const consent = await f.one<{ marketing_consent_status: string }>(
      "select marketing_consent_status from contacts where id = $1",
      [f.w.contact.id],
    );
    const evidence = await f.one("select * from lead_attributions where id = $1", [touch.id]);

    const report = await f.run();
    expect(report).toMatchObject({
      scanned: 1,
      processed: 1,
      created: 1,
      linked: 0,
      stopReason: "exhausted",
    });
    expect(report.remaining).toEqual({
      known: true,
      due: 0,
      dueCapped: false,
      retryWaiting: 0,
      parked: 0,
    });

    const leads = await leadsOf(f.w.contact.id);
    expect(leads).toHaveLength(1);
    const l = await lead(leads[0]!.id);
    expect(l).toMatchObject({
      status: "NEW",
      revision: 0,
      closed_at: null,
      initiating_attribution_id: touch.id,
    });
    // the database derived the cycle start from the touch's receipt time (to the microsecond)
    expect(
      (
        await f.one<{ ok: boolean }>(
          "select l.cycle_started_at = a.received_at as ok from leads l join lead_attributions a on a.id = l.initiating_attribution_id where l.id = $1",
          [l.contact_id && leads[0]!.id],
        )
      ).ok,
    ).toBe(true);
    expect(l.created_at).toEqual(l.status_changed_at);
    expect(await linkOf(touch.id)).toBe(leads[0]!.id);
    // the history reads in the order things happened: the link has a later time than the creation (not just a different id)
    expect(
      (
        await f.one<{ ok: boolean }>(
          `select (select created_at from lead_events where lead_id = $1 and kind = 'TOUCH_LINKED')
                > (select created_at from lead_events where lead_id = $1 and kind = 'CREATED') as ok`,
          [leads[0]!.id],
        )
      ).ok,
    ).toBe(true);
    expect(await eventsOf(leads[0]!.id)).toEqual([
      {
        kind: "CREATED",
        origin: "AD_REFERRAL",
        attribution_id: touch.id,
        actor_membership_id: null,
        revision: 0,
      },
      {
        kind: "TOUCH_LINKED",
        origin: null,
        attribution_id: touch.id,
        actor_membership_id: null,
        revision: null,
      },
    ]);
    expect(await decisionOf(touch.id)).toBeUndefined();
    // the provider evidence is exactly what Phase 04 stored, except that it is now linked
    const after = await f.one<Record<string, unknown>>(
      "select * from lead_attributions where id = $1",
      [touch.id],
    );
    expect({ ...after, lead_id: null }).toEqual(evidence);
    // no message, consent, conversation, outbound request or webhook event was created or changed
    expect({
      messages: await count("messages"),
      consents: await count("contact_consents"),
      conversations: await count("conversations"),
      outbound: await count("outbound_requests"),
      webhook: await count("webhook_events"),
    }).toEqual(before);
    expect(
      (
        await f.one<{ marketing_consent_status: string }>(
          "select marketing_consent_status from contacts where id = $1",
          [f.w.contact.id],
        )
      ).marketing_consent_status,
    ).toBe(consent.marketing_consent_status);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is idempotent, and a duplicate webhook delivery (the Phase 04 insert path) cannot produce a second touch, link or lead", async () => {
    const message = await f.one<{ id: string }>(
      `insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at, wamid)
       values ($1, $2, $3, 'INBOUND', 'TEXT', 'hi', now(), 'wamid.DUP1') returning id`,
      [f.w.org.id, f.w.conversation.id, f.w.account.id],
    );
    const input = {
      organizationId: f.w.org.id,
      contactId: f.w.contact.id,
      messageId: message.id,
      sourceType: "META_AD" as const,
      sourceId: "1200",
      sourceUrl: "https://fb.me/x",
      headline: "H",
      body: "B",
      mediaType: "image",
      mediaUrl: null,
      ctwaClid: "clid-0123456789-abc",
      providerData: null,
      receivedAt: new Date(),
    };
    expect(await insertAttributionOnce(f.t.db, input)).toBe(true);
    expect(await insertAttributionOnce(f.t.db, input)).toBe(false);
    expect((await f.run()).created).toBe(1);
    const again = await f.run();
    expect(again).toMatchObject({ scanned: 0, processed: 0, created: 0, linked: 0 });
    expect(await count("leads")).toBe(1);
    expect(await count("lead_events")).toBe(2);
  });

  it("only confirmed Meta ad touches that arrived with a message are ever considered: every other source and a touch without a message are ignored", async () => {
    const others = schema.ATTRIBUTION_SOURCE_TYPES.filter((s) => s !== "META_AD");
    for (const sourceType of others)
      await addTouch(f.t.db, f.w, (await addContact(f.t.db, f.w.org.id)).id, {
        sourceType,
        receivedAt: minutesAgo(3),
      });
    await addTouch(f.t.db, f.w, (await addContact(f.t.db, f.w.org.id)).id, {
      withMessage: false,
      receivedAt: minutesAgo(3),
    });
    const report = await f.run();
    expect(report).toMatchObject({ scanned: 0, processed: 0, created: 0 });
    expect(await count("leads")).toBe(0);
    expect(await count("lead_reconcile_decisions")).toBe(0);
    expect((await f.q("select 1 from lead_attributions where lead_id is not null")).length).toBe(0);
  });

  it("BSUID-only contacts are handled like any other contact", async () => {
    const contact = await addContact(f.t.db, f.w.org.id, {
      waId: null,
      bsuid: "US.13491208655302741918",
    });
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(2) });
    expect((await f.run()).created).toBe(1);
    expect(await linkOf(touch.id)).toBe((await leadsOf(contact.id))[0]!.id);
  });

  it("organizations stay apart: each touch creates a lead in its own organization, and nothing links across contacts", async () => {
    const other = await fixtureWorldInSameDatabase();
    const a = await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(4) });
    const b = await addTouch(f.t.db, other.w, other.w.contact.id, { receivedAt: minutesAgo(3) });
    // the first contact already has an open lead of its own; the other contact's touch must not join it
    expect((await f.run()).created).toBe(2);
    const la = await f.one<{ id: string; organization_id: string }>(
      "select id, organization_id from leads where initiating_attribution_id = $1",
      [a.id],
    );
    const lb = await f.one<{ id: string; organization_id: string }>(
      "select id, organization_id from leads where initiating_attribution_id = $1",
      [b.id],
    );
    expect(la.organization_id).toBe(f.w.org.id);
    expect(lb.organization_id).toBe(other.w.org.id);
    expect(la.id).not.toBe(lb.id);
    expect(await count("leads")).toBe(2);

    // a touch of a contact never joins ANOTHER contact's open lead, even in the same organization
    const second = await addContact(f.t.db, f.w.org.id);
    const open = await seedLead(f.t.db, f.w, second.id, { cycleStartedAt: minutesAgo(60) });
    const t3 = await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(1) });
    expect((await f.run()).linked).toBe(1);
    expect(await linkOf(t3.id)).toBe(la.id);
    expect(
      (await f.q("select 1 from lead_attributions where lead_id = $1", [open.id])).length,
    ).toBe(0);
  });

  async function fixtureWorldInSameDatabase() {
    const { world } = await import("../testing");
    return { w: await world(f.t.db) };
  }

  // ------------------------------------------------------------------------------------------- repeated inquiries
  it("a later ad touch is linked to the lead that is already open (automatic or manual), with TOUCH_LINKED history, never a second lead", async () => {
    const first = await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(30) });
    await f.run();
    const leadId = (await leadsOf(f.w.contact.id))[0]!.id;
    const second = await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(10) });
    const third = await addTouch(f.t.db, f.w, f.w.contact.id, { receivedAt: minutesAgo(5) });
    const report = await f.run();
    expect(report).toMatchObject({ processed: 2, linked: 2, created: 0 });
    expect(await leadsOf(f.w.contact.id)).toEqual([
      { id: leadId, status: "NEW", initiating_attribution_id: first.id },
    ]);
    expect(
      (await eventsOf(leadId)).map(
        (e) =>
          `${e.kind}:${e.attribution_id === first.id ? "first" : e.attribution_id === second.id ? "second" : "third"}`,
      ),
    ).toEqual(["CREATED:first", "TOUCH_LINKED:first", "TOUCH_LINKED:second", "TOUCH_LINKED:third"]);
    expect(await linkOf(second.id)).toBe(leadId);
    expect(await linkOf(third.id)).toBe(leadId);
    expect((await lead(leadId)).revision).toBe(0); // linking never changes the revision

    // a manual lead likewise
    const contact = await addContact(f.t.db, f.w.org.id);
    const manual = await createManualLead(f.w.staff.ctx, { contactId: contact.id }, deps());
    const t = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(Date.now() + 60_000),
    });
    expect((await f.run()).linked).toBe(1);
    expect(await linkOf(t.id)).toBe(manual.lead.id);
    expect(await leadsOf(contact.id)).toHaveLength(1);
    expect((await lead(manual.lead.id)).initiating_attribution_id).toBeNull(); // linking a touch never makes it an origin
  });

  it("a touch that predates a manual lead's cycle is skipped for good (the lead claims no history); a later one is linked", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const old = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(50) });
    const manual = await createManualLead(f.w.staff.ctx, { contactId: contact.id }, deps());
    const fresh = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(Date.now() + 30_000),
    });
    const report = await f.run();
    expect(report).toMatchObject({ processed: 2, linked: 1, skipped: { beforeCycle: 1 } });
    expect(await linkOf(old.id)).toBeNull();
    expect((await decisionOf(old.id))?.decision).toBe("SKIPPED_BEFORE_CYCLE");
    expect(await linkOf(fresh.id)).toBe(manual.lead.id);
    expect(await leadsOf(contact.id)).toHaveLength(1);
  });

  // ------------------------------------------------------------------------------------------ closed leads
  it("after every earlier lead is closed a later inquiry creates a new lead; one at or before the closure is skipped (strictly later is required)", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const closedAt = minutesAgo(30);
    const closed = await seedLead(f.t.db, f.w, contact.id, {
      status: "NO_RESPONSE",
      cycleStartedAt: minutesAgo(120),
      closedAt,
    });
    const before = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(60) });
    const atClosure = await addTouch(f.t.db, f.w, contact.id, { receivedAt: closedAt });
    const after = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(10) });
    const report = await f.run();
    expect(report).toMatchObject({ processed: 3, created: 1, skipped: { beforeCycle: 2 } });
    expect((await decisionOf(before.id))?.decision).toBe("SKIPPED_BEFORE_CYCLE");
    expect((await decisionOf(atClosure.id))?.decision).toBe("SKIPPED_BEFORE_CYCLE");
    const leads = await leadsOf(contact.id);
    expect(leads).toHaveLength(2);
    expect(leads.map((l) => l.id)).toContain(closed.id);
    const created = leads.find((l) => l.id !== closed.id)!;
    expect(created.initiating_attribution_id).toBe(after.id);
    expect(created.status).toBe("NEW");
    expect((await lead(closed.id)).status).toBe("NO_RESPONSE");
  });

  it("the boundary is the LATEST closure of any of the contact's leads, not just the most recent lead's", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    // an older lead that closed LATER than a newer one: the latest closure is the old lead's
    await seedLead(f.t.db, f.w, contact.id, {
      status: "NOT_INTERESTED",
      createdAt: minutesAgo(500),
      cycleStartedAt: minutesAgo(600),
      closedAt: minutesAgo(20),
    });
    await seedLead(f.t.db, f.w, contact.id, {
      status: "INVALID",
      createdAt: minutesAgo(100),
      cycleStartedAt: minutesAgo(200),
      closedAt: minutesAgo(90),
    });
    const between = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(50) });
    const report = await f.run();
    expect(report.skipped.beforeCycle).toBe(1);
    expect((await decisionOf(between.id))?.decision).toBe("SKIPPED_BEFORE_CYCLE");
    expect(await leadsOf(contact.id)).toHaveLength(2);
  });

  // ------------------------------------------------------------------------------------------ reopened leads
  it("a reopened lead (closed_at is NULL again) still keeps its history: a touch from before the reopening is skipped, a later one linked", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const created = await createManualLead(f.w.staff.ctx, { contactId: contact.id }, deps());
    // closed and reopened through the real services: the lead is open again and its closed_at is gone
    await changeLeadStatus(
      f.w.staff.ctx,
      created.lead.id,
      { to: "NO_RESPONSE", expectedRevision: 0 },
      deps(),
    );
    await changeLeadStatus(
      f.w.staff.ctx,
      created.lead.id,
      { to: "QUALIFIED", expectedRevision: 1 },
      deps(),
    );
    const reopened = await lead(created.lead.id);
    expect(reopened.closed_at).toBeNull();
    // evidence that arrived while the lead was closed (before the reopening) belongs to no cycle
    const whileClosed = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(reopened.cycle_started_at.getTime() - 5_000),
    });
    const afterReopen = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(reopened.cycle_started_at.getTime() + 60_000),
    });
    const report = await f.run();
    expect(report).toMatchObject({ processed: 2, linked: 1, skipped: { beforeCycle: 1 } });
    expect(await linkOf(whileClosed.id)).toBeNull();
    expect((await decisionOf(whileClosed.id))?.decision).toBe("SKIPPED_BEFORE_CYCLE");
    expect(await linkOf(afterReopen.id)).toBe(created.lead.id);
    expect(await leadsOf(contact.id)).toHaveLength(1);
  });

  it("closed again after a reopening: the latest closure (the current closed_at) is the boundary, so evidence from the reopened period is skipped, later evidence creates a new lead", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const created = await createManualLead(f.w.staff.ctx, { contactId: contact.id }, deps());
    const steps: Array<["NO_RESPONSE" | "QUALIFIED" | "INVALID", number]> = [
      ["NO_RESPONSE", 0],
      ["QUALIFIED", 1],
      ["INVALID", 2],
    ];
    for (const [to, expectedRevision] of steps)
      await changeLeadStatus(f.w.staff.ctx, created.lead.id, { to, expectedRevision }, deps());
    const closing = await lead(created.lead.id);
    expect(closing.status).toBe("INVALID");
    const duringReopened = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(closing.closed_at!.getTime() - 1_000),
    });
    const afterClosing = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(closing.closed_at!.getTime() + 60_000),
    });
    const report = await f.run();
    expect(report).toMatchObject({ created: 1, skipped: { beforeCycle: 1 } });
    expect((await decisionOf(duringReopened.id))?.decision).toBe("SKIPPED_BEFORE_CYCLE");
    expect(
      (await lead((await leadsOf(contact.id)).find((l) => l.id !== created.lead.id)!.id))
        .initiating_attribution_id,
    ).toBe(afterClosing.id);
  });

  it("a closed-to-closed move keeps the earlier closure boundary, so an inquiry between the two moves still starts a new lead", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const created = await createManualLead(f.w.staff.ctx, { contactId: contact.id }, deps());
    await changeLeadStatus(
      f.w.staff.ctx,
      created.lead.id,
      { to: "NO_RESPONSE", expectedRevision: 0 },
      deps(),
    );
    const firstClosure = (await lead(created.lead.id)).closed_at!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await changeLeadStatus(
      f.w.staff.ctx,
      created.lead.id,
      { to: "NOT_INTERESTED", expectedRevision: 1 },
      deps(),
    );
    const afterMove = await lead(created.lead.id);
    expect(afterMove.closed_at).toEqual(firstClosure); // the move did not become the boundary
    const touch = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(firstClosure.getTime() + 10),
    });
    expect((await f.run()).created).toBe(1);
    expect(
      (await leadsOf(contact.id)).find((l) => l.initiating_attribution_id === touch.id),
    ).toBeDefined();
  });

  // ------------------------------------------------------------------------------------------ converted history
  it("converted history suppresses AUTOMATIC creation only: skipped for good, and attribution to a lead staff created afterwards still works", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    await seedLead(f.t.db, f.w, contact.id, {
      status: "CONVERTED",
      cycleStartedAt: minutesAgo(300),
      closedAt: minutesAgo(200),
    });
    const afterConversion = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: minutesAgo(100),
    });
    const report = await f.run();
    expect(report).toMatchObject({ processed: 1, created: 0, skipped: { converted: 1 } });
    expect((await decisionOf(afterConversion.id))?.decision).toBe("SKIPPED_CONVERTED");
    expect(await leadsOf(contact.id)).toHaveLength(1);

    // staff then create a lead explicitly: a touch that arrives afterwards belongs to it
    const manual = await createManualLead(f.w.staff.ctx, { contactId: contact.id }, deps());
    const later = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(Date.now() + 60_000),
    });
    expect((await f.run()).linked).toBe(1);
    expect(await linkOf(later.id)).toBe(manual.lead.id);
    // the skipped evidence is not reactivated by the new lead, however often the reconciler runs
    expect(await linkOf(afterConversion.id)).toBeNull();
    expect((await f.run()).processed).toBe(0);
    expect((await decisionOf(afterConversion.id))?.decision).toBe("SKIPPED_CONVERTED");
  });

  // ------------------------------------------------------------------------------------- timestamps and freshness
  it("out-of-order provider times: evidence time is the EARLIER of receipt and provider time, and a provider time cannot make evidence fresh or newer", async () => {
    const mk = async (received: Date, occurred: Date) =>
      addTouch(f.t.db, f.w, (await addContact(f.t.db, f.w.org.id)).id, {
        receivedAt: received,
        occurredAt: occurred,
      });
    const lateDelivery = await mk(minutesAgo(1), daysAgo(20)); // sent 20 days ago, delivered now: stale
    const skewedClock = await mk(daysAgo(20), minutesAgo(1)); // received long ago, the provider claims "now": stale
    const farFuture = await mk(daysAgo(20), new Date(Date.now() + 365 * DAY)); // a wild provider time: still stale
    const ordinary = await mk(minutesAgo(2), minutesAgo(2));
    const report = await f.run();
    expect(report).toMatchObject({ processed: 4, created: 1, skipped: { stale: 3 } });
    for (const t of [lateDelivery, skewedClock, farFuture])
      expect((await decisionOf(t.id))?.decision).toBe("SKIPPED_STALE");
    expect(await decisionOf(ordinary.id)).toBeUndefined();
    expect(await linkOf(ordinary.id)).not.toBeNull();

    // against an open lead: received inside the cycle but SENT before it: the earlier time decides, so it is skipped
    const contact = await addContact(f.t.db, f.w.org.id);
    const manual = await createManualLead(f.w.staff.ctx, { contactId: contact.id }, deps());
    const started = (await lead(manual.lead.id)).cycle_started_at;
    const sentBefore = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(started.getTime() + 60_000),
      occurredAt: new Date(started.getTime() - 60_000),
    });
    expect((await f.run()).skipped.beforeCycle).toBe(1);
    expect((await decisionOf(sentBefore.id))?.decision).toBe("SKIPPED_BEFORE_CYCLE");
  });

  it("the freshness window: 14 days by default and configurable from 1 to 90, decided on the earlier time and the database clock", async () => {
    for (const [days, ageDays, expected] of [
      [14, 13.9, "fresh"],
      [14, 14.1, "stale"],
      [1, 0.9, "fresh"],
      [1, 1.1, "stale"],
      [90, 89.9, "fresh"],
      [90, 90.1, "stale"],
    ] as const) {
      const contact = await addContact(f.t.db, f.w.org.id);
      const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: daysAgo(ageDays) });
      await f.run({ freshnessDays: days });
      if (expected === "fresh")
        expect(await linkOf(touch.id), `${days}d window, ${ageDays}d old`).not.toBeNull();
      else
        expect((await decisionOf(touch.id))?.decision, `${days}d window, ${ageDays}d old`).toBe(
          "SKIPPED_STALE",
        );
    }
  });

  it("freshness is judged when a touch is FIRST considered: a retry that was fresh then is not stale now", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const control = await addContact(f.t.db, f.w.org.id);
    // a 10-day-old touch with a 1-day window: stale for a first look ...
    const staleNow = await addTouch(f.t.db, f.w, control.id, { receivedAt: daysAgo(10) });
    // ... but this one was first considered (its RETRY row was created) when it was about a minute old
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: daysAgo(10) });
    await f.q(
      "insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts, next_attempt_at, last_error_code, created_at) values ($1,$2,$3,'RETRY',1, clock_timestamp() + interval '1 hour', 'pg_p0001', $4)",
      [f.w.org.id, touch.id, contact.id, new Date(daysAgo(10).getTime() + 60_000)],
    );
    await makeDue(f.t, touch.id);
    const report = await f.run({ freshnessDays: 1 });
    expect(report).toMatchObject({ created: 1, skipped: { stale: 1 } });
    expect((await decisionOf(staleNow.id))?.decision).toBe("SKIPPED_STALE");
    expect(await linkOf(touch.id)).not.toBeNull();
    expect(await decisionOf(touch.id)).toBeUndefined(); // the RETRY row went with the link
  });

  // ---------------------------------------------------------------------------------------------- archived
  it("an archived contact is skipped for good, with or without an open lead; un-archiving later does not reactivate the evidence", async () => {
    const plain = await addContact(f.t.db, f.w.org.id, { archived: true });
    const withLead = await addContact(f.t.db, f.w.org.id, { archived: true });
    await seedLead(f.t.db, f.w, withLead.id, { cycleStartedAt: minutesAgo(60) });
    const a = await addTouch(f.t.db, f.w, plain.id, { receivedAt: minutesAgo(5) });
    const b = await addTouch(f.t.db, f.w, withLead.id, { receivedAt: minutesAgo(5) });
    const report = await f.run();
    expect(report).toMatchObject({ processed: 2, created: 0, linked: 0, skipped: { archived: 2 } });
    for (const t of [a, b]) {
      expect((await decisionOf(t.id))?.decision).toBe("SKIPPED_ARCHIVED");
      expect(await linkOf(t.id)).toBeNull();
    }
    expect(await leadsOf(plain.id)).toEqual([]);
    await f.q("update contacts set archived_at = null where id = any($1)", [
      [plain.id, withLead.id],
    ]);
    expect((await f.run()).processed).toBe(0);
    expect((await decisionOf(a.id))?.decision).toBe("SKIPPED_ARCHIVED");
    expect(await leadsOf(plain.id)).toEqual([]);
  });

  it("terminal decisions are never processed again and never change", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const stale = await addTouch(f.t.db, f.w, contact.id, { receivedAt: daysAgo(30) });
    await f.run();
    const first = await f.one<{ updated_at: Date; created_at: Date }>(
      "select updated_at, created_at from lead_reconcile_decisions where attribution_id = $1",
      [stale.id],
    );
    for (let i = 0; i < 3; i++) expect(await f.run()).toMatchObject({ scanned: 0, processed: 0 });
    expect(
      await f.one(
        "select updated_at, created_at from lead_reconcile_decisions where attribution_id = $1",
        [stale.id],
      ),
    ).toEqual(first);
    // and the database itself refuses to reactivate or delete it (07A)
    await expect(
      f.q(
        "update lead_reconcile_decisions set decision = 'RETRY', attempts = 1, next_attempt_at = now() + interval '1 hour' where attribution_id = $1",
        [stale.id],
      ),
    ).rejects.toThrow(/terminal decision is final/);
    await expect(
      f.q("delete from lead_reconcile_decisions where attribution_id = $1", [stale.id]),
    ).rejects.toThrow(/terminal decision is final/);
  });

  // ------------------------------------------------------------------------------------------------ order
  it("the first inquiry initiates the lead: chronological order within a contact, and the scan's order is (received_at, id)", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    // inserted in the WRONG order
    const later = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const first = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(20) });
    const middle = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(10) });
    expect(await f.run()).toMatchObject({ created: 1, linked: 2 });
    const [l] = await leadsOf(contact.id);
    expect(l!.initiating_attribution_id).toBe(first.id);
    expect(await linkOf(middle.id)).toBe(l!.id);
    expect(await linkOf(later.id)).toBe(l!.id);

    // identical receipt times: the id breaks the tie, the same way every time
    const tie = daysAgo(0.001);
    const contacts = [];
    for (let i = 0; i < 6; i++) contacts.push(await addContact(f.t.db, f.w.org.id));
    const touches = [];
    for (const c of contacts) touches.push(await addTouch(f.t.db, f.w, c.id, { receivedAt: tie }));
    await f.run({ pageSize: 1 });
    const order = (
      await f.q<{ initiating_attribution_id: string }>(
        "select initiating_attribution_id from leads where initiating_attribution_id = any($1) order by created_at, id",
        [touches.map((t) => t.id)],
      )
    ).map((r) => r.initiating_attribution_id);
    expect(order).toEqual(touches.map((t) => t.id).sort());
  });

  // ----------------------------------------------------------------------- the first-touch policy (revised)
  it("NEW LEAD: an earlier touch in its retry back-off holds a later one for at most 15 minutes from ITS first consideration; then the later one may initiate the lead and the earlier one is judged normally", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const a = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(20) });
    const b = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(10) });
    await injectFailure(f.t, "CREATED");
    const first = await f.run();
    // A failed and is waiting for its retry; B (in the same page) was held back: waiting, NOT busy, no attempt spent
    expect(first).toMatchObject({ retryScheduled: 1, waiting: 1, busy: 0, created: 0 });
    expect(first.errors).toEqual({ pg_p0001: 1 });
    expect((await decisionOf(a.id))?.decision).toBe("RETRY");
    expect(await decisionOf(b.id)).toBeUndefined();
    // within the hold the scan does not even offer B
    expect(await f.run()).toMatchObject({ scanned: 0, processed: 0, waiting: 0, busy: 0 });
    expect(await leadsOf(contact.id)).toEqual([]);

    // the hold is measured from A's FIRST consideration (the anchor of its RETRY row), not from its latest attempt: A's anchor is
    // now 20 minutes old although the row itself was updated just now
    await f.q(
      "update lead_reconcile_decisions set created_at = clock_timestamp() - interval '20 minutes' where attribution_id = $1",
      [a.id],
    );
    await removeFailure(f.t);
    expect(await f.run()).toMatchObject({ created: 1, linked: 0 });
    const [lead] = await leadsOf(contact.id);
    expect(lead!.initiating_attribution_id).toBe(b.id); // the later touch initiated the lead
    expect(await linkOf(a.id)).toBeNull(); // the earlier one is NOT forced onto it

    // A is evaluated under the normal cycle policy when its retry comes: it predates the lead's cycle, so a terminal skip
    await makeDue(f.t, a.id);
    expect(await f.run()).toMatchObject({ skipped: { beforeCycle: 1 }, created: 0, linked: 0 });
    expect((await decisionOf(a.id))?.decision).toBe("SKIPPED_BEFORE_CYCLE");
    expect(await linkOf(a.id)).toBeNull();
  });

  it("while the hold lasts and the earlier touch's retry succeeds, the EARLIER touch initiates the lead and the later one is linked", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const a = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(20) });
    const b = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(10) });
    await injectFailure(f.t, "CREATED");
    await f.run();
    await removeFailure(f.t);
    await makeDue(f.t, a.id);
    // A's retry is due; B is still held back by A's RETRY while the scan runs, so this run handles A only
    expect(await f.run()).toMatchObject({ created: 1, linked: 0 });
    // the next run links B to the lead A initiated
    expect(await f.run()).toMatchObject({ linked: 1, created: 0 });
    const [lead] = await leadsOf(contact.id);
    expect(lead!.initiating_attribution_id).toBe(a.id);
    expect(await linkOf(b.id)).toBe(lead!.id);
    expect(await count("lead_reconcile_decisions")).toBe(0);
  });

  it("EXISTING OPEN LEAD: nothing waits; a later touch is linked at once even though an earlier touch is in its retry back-off", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const manual = await createManualLead(f.w.staff.ctx, { contactId: contact.id }, deps());
    const a = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(Date.now() + 20_000),
    });
    const b = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(Date.now() + 40_000),
    });
    await injectFailure(f.t, "TOUCH_LINKED"); // A fails at the very end of linking
    const report = await f.run();
    // the injected fault hits every link, so B fails too; the point is that B was ATTEMPTED (not held back) and its failure is its own
    expect(report).toMatchObject({ waiting: 0, busy: 0 });
    expect(report.retryScheduled).toBe(2);
    await removeFailure(f.t);
    await makeDue(f.t, a.id);
    await makeDue(f.t, b.id);
    expect(await f.run()).toMatchObject({ linked: 2, waiting: 0 });
    expect(await linkOf(a.id)).toBe(manual.lead.id);
    expect(await linkOf(b.id)).toBe(manual.lead.id);

    // and with an earlier touch whose retry is NOT due: the later one still links at once (here: only B is injected to succeed)
    const contact2 = await addContact(f.t.db, f.w.org.id);
    const manual2 = await createManualLead(f.w.staff.ctx, { contactId: contact2.id }, deps());
    const a2 = await addTouch(f.t.db, f.w, contact2.id, {
      receivedAt: new Date(Date.now() + 20_000),
    });
    await f.q(
      "insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts, next_attempt_at, last_error_code) values ($1,$2,$3,'RETRY',1, clock_timestamp() + interval '1 hour', 'pg_p0001')",
      [f.w.org.id, a2.id, contact2.id],
    );
    const b2 = await addTouch(f.t.db, f.w, contact2.id, {
      receivedAt: new Date(Date.now() + 40_000),
    });
    expect(await f.run()).toMatchObject({ linked: 1, waiting: 0, busy: 0 });
    expect(await linkOf(b2.id)).toBe(manual2.lead.id);
    expect(await linkOf(a2.id)).toBeNull(); // still waiting for its own retry
  });

  it("an earlier touch that was never considered imposes no hold (only an actual RETRY does), and an earlier outbound touch never does", async () => {
    // never considered: B is handled while A has no decision at all
    const contact = await addContact(f.t.db, f.w.org.id);
    const a = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(20) });
    const b = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(10) });
    const candidate = {
      organizationId: f.w.org.id,
      attributionId: b.id,
      contactId: contact.id,
      receivedKey: "",
    };
    expect(await processCandidate(f.t.db, candidate, DEFAULT_OPTIONS)).toEqual({ kind: "created" });
    expect((await leadsOf(contact.id))[0]!.initiating_attribution_id).toBe(b.id);
    // A is then a candidate like any other, judged by the cycle rule
    expect(await f.run()).toMatchObject({ skipped: { beforeCycle: 1 } });
    expect((await decisionOf(a.id))?.decision).toBe("SKIPPED_BEFORE_CYCLE");

    // an earlier OUTBOUND touch with a RETRY row (however it got there) holds nobody
    const other = await addContact(f.t.db, f.w.org.id);
    const outbound = await addTouch(f.t.db, f.w, other.id, {
      receivedAt: minutesAgo(20),
      direction: "OUTBOUND",
    });
    await f.q(
      "insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision, attempts, next_attempt_at, last_error_code) values ($1,$2,$3,'RETRY',1, clock_timestamp() + interval '1 hour', 'pg_p0001')",
      [f.w.org.id, outbound.id, other.id],
    );
    const inbound = await addTouch(f.t.db, f.w, other.id, { receivedAt: minutesAgo(10) });
    const report = await f.run();
    expect(report).toMatchObject({ created: 1, waiting: 0 });
    expect((await leadsOf(other.id))[0]!.initiating_attribution_id).toBe(inbound.id);
    expect(await linkOf(outbound.id)).toBeNull();
  });

  // ------------------------------------------------------------------------------------------- inbound only
  it("only touches carried by INBOUND messages qualify: an outbound one never creates a lead, never links, and is never counted as work", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const outbound = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: minutesAgo(5),
      direction: "OUTBOUND",
    });
    const report = await f.run();
    expect(report).toMatchObject({ scanned: 0, processed: 0, created: 0, linked: 0 });
    expect(report.remaining).toMatchObject({ due: 0, parked: 0 });
    expect(await leadsOf(contact.id)).toEqual([]);
    expect(await decisionOf(outbound.id)).toBeUndefined();

    // and it cannot be linked to an OPEN lead either
    const manual = await createManualLead(f.w.staff.ctx, { contactId: contact.id }, deps());
    const later = await addTouch(f.t.db, f.w, contact.id, {
      receivedAt: new Date(Date.now() + 30_000),
      direction: "OUTBOUND",
    });
    expect(await f.run()).toMatchObject({ scanned: 0, linked: 0 });
    expect(await linkOf(later.id)).toBeNull();
    expect((await leadsOf(contact.id)).map((l) => l.id)).toEqual([manual.lead.id]);
  });

  it("an earlier outbound touch cannot block a later inbound one, and an inbound inquiry still creates its lead", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(30), direction: "OUTBOUND" });
    const inbound = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(10) });
    expect(await f.run()).toMatchObject({ processed: 1, created: 1 });
    expect((await leadsOf(contact.id))[0]!.initiating_attribution_id).toBe(inbound.id);
  });

  it("the direction is re-checked under the locks: a touch whose message stops being inbound between the scan and the handling is left alone, also by failure recording", async () => {
    const contact = await addContact(f.t.db, f.w.org.id);
    const touch = await addTouch(f.t.db, f.w, contact.id, { receivedAt: minutesAgo(5) });
    const candidate = {
      organizationId: f.w.org.id,
      attributionId: touch.id,
      contactId: contact.id,
      receivedKey: "",
    };
    const scanned = await scanCandidates(f.t.db, null, 10, DEFAULT_OPTIONS);
    expect(scanned.map((c) => c.attributionId)).toEqual([touch.id]);
    await f.q(
      "update messages set direction = 'OUTBOUND' where id = (select message_id from lead_attributions where id = $1)",
      [touch.id],
    );
    expect(await processCandidate(f.t.db, candidate, DEFAULT_OPTIONS)).toEqual({ kind: "gone" });
    expect(await recordFailure(f.t.db, candidate, "pg_p0001", DEFAULT_OPTIONS)).toEqual({
      kind: "gone",
    });
    expect(await leadsOf(contact.id)).toEqual([]);
    expect(await decisionOf(touch.id)).toBeUndefined();
    expect(await linkOf(touch.id)).toBeNull();
  });
});
