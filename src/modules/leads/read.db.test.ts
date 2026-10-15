import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema, type Database } from "@/db";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import type { AccessContext } from "@/modules/access";
import {
  changeLeadStatus,
  createManualLead,
  getContactLeads,
  getLeadDetail,
  listLeadEvents,
  listLeads,
  type LeadItem,
} from "./index";
import {
  addActor,
  addContact,
  addTouch,
  linkTouch,
  minutesAgo,
  seedAutomaticLead,
  seedLead,
  world,
} from "./testing";

// The lead read side on REAL PostgreSQL: list, detail, history and the contact's leads. Tenant isolation, keyset pagination at
// microsecond precision, filters, and an attribution read model that keeps evidence LINKED TO A LEAD apart from the other
// evidence recorded for its contact, and never calls a lead "organic" because evidence is missing.

describe("lead reads", () => {
  let t: TestDb;
  const fetchSpy = vi.fn(() => {
    throw new Error("a lead service must never make a network request");
  });
  beforeAll(async () => {
    t = await createTestDatabase();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });
  const deps = () => ({ db: t.db });
  const q = (sql: string, params: unknown[] = []) => t.pool.query(sql, params);

  // --------------------------------------------------------------------------------------------------- the list
  describe("the lead list", () => {
    it("every role that can read leads may list; it is scoped to the caller's organization", async () => {
      const a = await world(t.db);
      const b = await world(t.db);
      const mine = await seedLead(t.db, a, a.contact.id);
      const theirs = await seedLead(t.db, b, b.contact.id);
      for (const actor of [a.admin, a.staff, a.viewer]) {
        const page = await listLeads(actor.ctx, {}, deps());
        expect(page.items.map((i) => i.id)).toEqual([mine.id]);
      }
      expect((await listLeads(b.viewer.ctx, {}, deps())).items.map((i) => i.id)).toEqual([
        theirs.id,
      ]);
      const outsider = await addActor(t.db, a.org.id, "VIEWER");
      // a role that holds nothing (an unknown role fails closed)
      const noPermission = { ...outsider.ctx, role: "NONE" } as unknown as AccessContext;
      await expect(listLeads(noPermission, {}, deps())).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("rejects unknown parameters, bad filters, bad limits, bad search lengths and garbage cursors (field names only)", async () => {
      const w = await world(t.db);
      const bad: Array<Record<string, string>> = [
        { organizationId: w.org.id },
        { state: "all" },
        { status: "BOGUS" },
        { attribution: "organic" },
        { limit: "0" },
        { limit: "51" },
        { limit: "abc" },
        { q: "a" },
        { q: " a " },
        { q: "x".repeat(65) },
        { cursor: "garbage" },
        { cursor: "x".repeat(201) },
        { cursor: Buffer.from('{"t":"2026-01-01","id":"x"}').toString("base64url") },
      ];
      for (const query of bad)
        await expect(
          listLeads(w.admin.ctx, query, deps()),
          JSON.stringify(query),
        ).rejects.toBeInstanceOf(ValidationError);
      // 2 and 64 characters are the bounds, 50 the largest page
      await listLeads(w.admin.ctx, { q: "ab" }, deps());
      await listLeads(w.admin.ctx, { q: "x".repeat(64), limit: "50" }, deps());
    });

    it("is newest first by (created_at, id) and keyset pages are exact at MICROSECOND precision, ties included", async () => {
      const w = await world(t.db);
      // 9 leads whose created_at values share the same millisecond (differing only in microseconds) or are identical
      const stamps = [
        "2026-03-01 10:00:00.000100+00",
        "2026-03-01 10:00:00.000200+00",
        "2026-03-01 10:00:00.000200+00",
        "2026-03-01 10:00:00.000300+00",
        "2026-03-01 10:00:00.000999+00",
        "2026-03-01 10:00:00.000999+00",
        "2026-03-01 10:00:00.000999+00",
        "2026-03-01 10:00:00.001000+00",
        "2026-03-01 09:59:59.999999+00",
      ];
      const ids: string[] = [];
      for (const stamp of stamps) {
        const c = await addContact(t.db, w.org.id);
        ids.push(
          (
            await q(
              "insert into leads (organization_id, contact_id, created_at, cycle_started_at, status_changed_at) values ($1, $2, $3, $3, $3) returning id",
              [w.org.id, c.id, stamp],
            )
          ).rows[0].id as string,
        );
      }
      const expected = (
        await q(
          "select id from leads where organization_id = $1 order by created_at desc, id desc",
          [w.org.id],
        )
      ).rows.map((r) => r.id as string);
      expect(expected).toHaveLength(stamps.length);
      for (const limit of [1, 2, 3, 4, 9, 50]) {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let pages = 0; pages < 20; pages++) {
          const page = await listLeads(
            w.viewer.ctx,
            { limit: String(limit), ...(cursor ? { cursor } : {}) },
            deps(),
          );
          expect(page.items.length).toBeLessThanOrEqual(limit);
          seen.push(...page.items.map((i) => i.id));
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        expect(seen, `limit ${limit}`).toEqual(expected);
      }
      // the key is the exact microsecond text
      const first = (await listLeads(w.viewer.ctx, { limit: "1" }, deps())).items[0]!;
      expect(first.createdKey).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(first.createdKey).toBe("2026-03-01T10:00:00.001000Z");
    });

    it("a page costs a constant number of statements (no N+1), however many leads it holds", async () => {
      const w = await world(t.db);
      for (let i = 0; i < 12; i++) {
        const c = await addContact(t.db, w.org.id, { profileName: `Student ${i}` });
        const lead = await seedLead(t.db, w, c.id, { cycleStartedAt: minutesAgo(60) });
        if (i % 3 === 0) {
          const touch = await addTouch(t.db, w, c.id, { receivedAt: minutesAgo(10) });
          await linkTouch(t.db, w, { id: lead.id, contactId: c.id }, touch.id);
        }
      }
      let statements = 0;
      // the list only ever calls execute(): count the statements it sends
      const counted = {
        execute: (query: Parameters<Database["execute"]>[0]) => {
          statements++;
          return t.db.execute(query);
        },
      } as unknown as Database;
      const page = await listLeads(w.viewer.ctx, { limit: "50" }, { db: counted });
      expect(page.items.length).toBeGreaterThanOrEqual(12);
      expect(statements).toBe(1);
    });

    it("filters by open or closed, by one status, by confirmed ad evidence linked to the lead, and by its absence", async () => {
      const w = await world(t.db);
      const make = async (status: (typeof schema.LEAD_STATUSES)[number], linked: boolean) => {
        const c = await addContact(t.db, w.org.id);
        const lead = await seedLead(t.db, w, c.id, {
          status,
          cycleStartedAt: minutesAgo(60),
          closedAt: minutesAgo(30),
        });
        if (linked) {
          const touch = await addTouch(t.db, w, c.id, { receivedAt: minutesAgo(10) });
          if (!(schema.CLOSED_LEAD_STATUSES as readonly string[]).includes(status))
            await linkTouch(t.db, w, { id: lead.id, contactId: c.id }, touch.id);
        }
        return lead.id;
      };
      const newAd = await make("NEW", true);
      const newPlain = await make("NEW", false);
      const interested = await make("INTERESTED", true);
      const closedPlain = await make("NO_RESPONSE", false);
      const closedWithEvidenceOnContact = await make("INVALID", true); // evidence exists for the contact, not linked to the lead
      const reserved = await make("PAID", false);
      const ids = (query: Record<string, string>) =>
        listLeads(w.viewer.ctx, query, deps()).then((p) => p.items.map((i) => i.id).sort());
      expect(await ids({})).toEqual(
        [newAd, newPlain, interested, closedPlain, closedWithEvidenceOnContact, reserved].sort(),
      );
      expect(await ids({ state: "open" })).toEqual([newAd, newPlain, interested, reserved].sort());
      expect(await ids({ state: "closed" })).toEqual(
        [closedPlain, closedWithEvidenceOnContact].sort(),
      );
      expect(await ids({ status: "NEW" })).toEqual([newAd, newPlain].sort());
      expect(await ids({ status: "PAID" })).toEqual([reserved]);
      expect(await ids({ status: "NEW", state: "closed" })).toEqual([]);
      expect(await ids({ attribution: "ad" })).toEqual([newAd, interested].sort());
      // "none" is "no ad touch linked to the lead": unlinked evidence of the contact does not count, and it is not "organic"
      expect(await ids({ attribution: "none" })).toEqual(
        [newPlain, closedPlain, closedWithEvidenceOnContact, reserved].sort(),
      );
      expect(await ids({ attribution: "ad", state: "open", status: "INTERESTED" })).toEqual([
        interested,
      ]);
      const items = (await listLeads(w.viewer.ctx, { limit: "50" }, deps())).items;
      const byId = new Map(items.map((i) => [i.id, i]));
      expect(byId.get(newAd)!.source).toMatchObject({
        kind: "META_AD",
        label: "Meta ad",
        adTouches: 1,
        linkedTouches: 1,
      });
      expect(byId.get(newPlain)!.source).toMatchObject({
        kind: "NONE",
        label: "No advertisement referral recorded",
        linkedTouches: 0,
      });
      expect(byId.get(closedWithEvidenceOnContact)!.source.kind).toBe("NONE");
      expect(byId.get(reserved)).toMatchObject({ readOnly: true, open: true });
      expect(JSON.stringify(items)).not.toMatch(/organic/i);
    });

    it("searches the contact by name, username, phone prefix and exact BSUID; wildcards are literal characters", async () => {
      const w = await world(t.db);
      const named = await addContact(t.db, w.org.id, {
        profileName: "Kamal Perera",
        waId: "94771110001",
      });
      const user = await addContact(t.db, w.org.id, {
        username: "ict_teacher",
        waId: "94771110002",
      });
      const bsuidOnly = await addContact(t.db, w.org.id, {
        waId: null,
        bsuid: "US.99887766554433221100",
        profileName: null,
      });
      const percent = await addContact(t.db, w.org.id, {
        profileName: "100% Sure",
        waId: "94771110004",
      });
      const other = await addContact(t.db, w.org.id, {
        profileName: "Nimali",
        waId: "94772220005",
      });
      const ids: Record<string, string> = {};
      for (const [key, c] of Object.entries({ named, user, bsuidOnly, percent, other }))
        ids[key] = (await seedLead(t.db, w, c.id)).id;
      const search = async (qText: string) =>
        (await listLeads(w.viewer.ctx, { q: qText }, deps())).items.map((i) => i.id).sort();
      expect(await search("kamal")).toEqual([ids.named]);
      expect(await search("amal Per")).toEqual([ids.named]);
      expect(await search("ict_t")).toEqual([ids.user]);
      expect(await search("9477111")).toEqual([ids.named, ids.user, ids.percent].sort());
      expect(await search("77111")).toEqual([]); // a phone is matched by prefix only
      expect(await search("US.99887766554433221100")).toEqual([ids.bsuidOnly]);
      expect(await search("US.998877")).toEqual([]); // a BSUID only by its exact value
      expect(await search("100%")).toEqual([ids.percent]);
      expect(await search("%%")).toEqual([]); // not "match everything"
      expect(await search("__")).toEqual([]);
      expect(await search("\\\\")).toEqual([]);
      // a BSUID-only contact is labelled safely
      const item = (await listLeads(w.viewer.ctx, { q: "US.99887766554433221100" }, deps()))
        .items[0]!;
      expect(item.contact.label).toEqual({
        displayName: "Unnamed contact",
        named: false,
        idHint: "…1100",
      });
    });

    it("never returns provider text raw: control and bidirectional characters are removed from names", async () => {
      const w = await world(t.db);
      const c = await addContact(t.db, w.org.id, {
        profileName: "Ruwan\u202E\u0007 <b>Silva</b>\n\n\u200B",
      });
      await seedLead(t.db, w, c.id);
      const item = (await listLeads(w.viewer.ctx, { q: "Ruwan" }, deps())).items[0]!;
      expect(item.contact.label.displayName).toBe("Ruwan <b>Silva</b>");
    });
  });

  // ------------------------------------------------------------------------------------------------- the detail
  describe("the lead detail and its attribution read model", () => {
    it("separates evidence linked to THIS lead from the other evidence recorded for the contact", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id, { profileName: "Dilani" });
      // an earlier lead (closed) with its own evidence, an unlinked touch, and the current automatic lead
      const old = await seedLead(t.db, w, contact.id, { cycleStartedAt: minutesAgo(900) });
      const oldTouch = await addTouch(t.db, w, contact.id, { receivedAt: minutesAgo(850) });
      await linkTouch(t.db, w, { id: old.id, contactId: contact.id }, oldTouch.id);
      await changeLeadStatus(
        w.staff.ctx,
        old.id,
        { to: "NO_RESPONSE", expectedRevision: 0 },
        deps(),
      );
      const unlinked = await addTouch(t.db, w, contact.id, {
        receivedAt: minutesAgo(600),
        headline: "Unlinked ad",
      });
      const origin = await addTouch(t.db, w, contact.id, {
        receivedAt: minutesAgo(100),
        headline: "The ad that started it",
      });
      const lead = await seedAutomaticLead(t.db, w, contact.id, origin.id);
      const later = await addTouch(t.db, w, contact.id, {
        receivedAt: minutesAgo(10),
        headline: "A later ad",
      });
      await linkTouch(t.db, w, { id: lead.id, contactId: contact.id }, later.id);
      const decided = await addTouch(t.db, w, contact.id, { receivedAt: minutesAgo(700) });
      await q(
        "insert into lead_reconcile_decisions (organization_id, attribution_id, contact_id, decision) values ($1, $2, $3, 'SKIPPED_STALE')",
        [w.org.id, decided.id, contact.id],
      );

      const d = await getLeadDetail(w.viewer.ctx, lead.id, deps());
      expect(d.lead).toMatchObject({
        id: lead.id,
        status: "NEW",
        revision: 0,
        open: true,
        closedAt: null,
        origin: "AD_REFERRAL",
      });
      expect(d.lead.cycleStartedAt).toBe(origin.receivedAt.toISOString());
      expect(d.contact).toMatchObject({
        id: contact.id,
        label: { displayName: "Dilani" },
        archived: false,
      });
      // A: linked to this lead, oldest first; the initiating touch is flagged
      expect(d.attribution.linked.map((x) => x.id)).toEqual([origin.id, later.id]);
      expect(d.attribution.linked.map((x) => x.initiating)).toEqual([true, false]);
      expect(d.attribution.linkedTotal).toBe(2);
      expect(d.attribution.first!.id).toBe(origin.id);
      expect(d.attribution.latest!.id).toBe(later.id);
      expect(d.attribution.source).toMatchObject({
        kind: "META_AD",
        label: "Meta ad",
        adTouches: 2,
        linkedTouches: 2,
      });
      // B: everything else of the contact, newest first, never mixed into A
      expect(d.attribution.otherForContact.map((x) => [x.id, x.attachment, x.decision])).toEqual([
        [unlinked.id, "UNLINKED", null],
        [decided.id, "UNLINKED", "SKIPPED_STALE"],
        [oldTouch.id, "OTHER_LEAD", null],
      ]);
      expect(d.attribution.otherTotal).toBe(3);
      for (const other of d.attribution.otherForContact)
        expect(d.attribution.linked.map((x) => x.id)).not.toContain(other.id);
    });

    it("an unlinked touch is NOT evidence for the lead: with no linked touch the source is 'no advertisement referral recorded'", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const unlinked = await addTouch(t.db, w, contact.id, { receivedAt: minutesAgo(5) });
      const created = await createManualLead(w.staff.ctx, { contactId: contact.id }, deps());
      const d = await getLeadDetail(w.viewer.ctx, created.lead.id, deps());
      expect(d.attribution.source).toEqual({
        kind: "NONE",
        label: "No advertisement referral recorded",
        adTouches: 0,
        linkedTouches: 0,
        firstReceivedAt: null,
        latestReceivedAt: null,
      });
      expect(d.attribution.linked).toEqual([]);
      expect(d.attribution.first).toBeNull();
      expect(d.attribution.latest).toBeNull();
      expect(d.attribution.otherForContact.map((x) => x.id)).toEqual([unlinked.id]);
      expect(d.lead.origin).toBe("MANUAL");
      expect(JSON.stringify(d.attribution.source)).not.toMatch(/organic/i);
      // a lead with neither touches nor history at all (it predates lead history) reads honestly too
      const bare = await seedLead(t.db, w, (await addContact(t.db, w.org.id)).id);
      const bareDetail = await getLeadDetail(w.viewer.ctx, bare.id, deps());
      expect(bareDetail.lead.origin).toBeNull();
      expect(bareDetail.attribution.source.kind).toBe("NONE");
      expect(bareDetail.attribution.otherForContact).toEqual([]);
      expect(bareDetail.history.events).toEqual([]);
    });

    it("first and latest are deterministic: received_at, then the touch id, when times tie", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const lead = await seedLead(t.db, w, contact.id, { cycleStartedAt: minutesAgo(60) });
      const same = minutesAgo(10);
      const touches = [
        await addTouch(t.db, w, contact.id, { receivedAt: same }),
        await addTouch(t.db, w, contact.id, { receivedAt: same }),
        await addTouch(t.db, w, contact.id, { receivedAt: same }),
        await addTouch(t.db, w, contact.id, { receivedAt: minutesAgo(5) }),
      ];
      for (const touch of touches)
        await linkTouch(t.db, w, { id: lead.id, contactId: contact.id }, touch.id);
      const tied = touches
        .slice(0, 3)
        .map((x) => x.id)
        .sort();
      for (let i = 0; i < 3; i++) {
        const d = await getLeadDetail(w.viewer.ctx, lead.id, deps());
        expect(d.attribution.linked.map((x) => x.id)).toEqual([...tied, touches[3]!.id]);
        expect(d.attribution.first!.id).toBe(tied[0]);
        expect(d.attribution.latest!.id).toBe(touches[3]!.id);
      }
    });

    it("is bounded: with more touches than the page, the totals stay exact and 'latest' is still the latest", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const lead = await seedLead(t.db, w, contact.id, { cycleStartedAt: minutesAgo(600) });
      let last = "";
      for (let i = 0; i < 28; i++) {
        const touch = await addTouch(t.db, w, contact.id, { receivedAt: minutesAgo(500 - i) });
        await linkTouch(t.db, w, { id: lead.id, contactId: contact.id }, touch.id);
        last = touch.id;
      }
      for (let i = 0; i < 27; i++)
        await addTouch(t.db, w, contact.id, { receivedAt: minutesAgo(400 - i) });
      const d = await getLeadDetail(w.viewer.ctx, lead.id, deps());
      expect(d.attribution.linked).toHaveLength(25);
      expect(d.attribution.linkedTotal).toBe(28);
      expect(d.attribution.latest!.id).toBe(last);
      expect(d.attribution.otherForContact).toHaveLength(25);
      expect(d.attribution.otherTotal).toBe(27);
      expect(d.attribution.source.linkedTouches).toBe(28);
    });

    it("provider text is untrusted: cleaned and bounded, links reduced to origin and path, the click id and provider data never returned", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const lead = await seedLead(t.db, w, contact.id, { cycleStartedAt: minutesAgo(60) });
      const clid = "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNpqrstuv";
      const touch = await addTouch(t.db, w, contact.id, {
        receivedAt: minutesAgo(5),
        headline: `Win\u202E big\u0007 ${"x".repeat(400)}`,
        body: `<script>alert(1)</script>\u2066${"y".repeat(900)}`,
        sourceId: `12\n34`,
        sourceUrl: "https://user:pw@evil.example/a",
        mediaUrl: "https://cdn.example.test/ad.jpg?sig=SECRETTOKEN#frag",
        ctwaClid: clid,
      });
      const javascript = await addTouch(t.db, w, contact.id, {
        receivedAt: minutesAgo(4),
        sourceUrl: "javascript:alert(1)",
        mediaUrl: `https://cdn.example.test/${"p".repeat(300)}`,
        ctwaClid: "short",
      });
      const plain = await addTouch(t.db, w, contact.id, {
        receivedAt: minutesAgo(3),
        sourceUrl: "https://fb.me/abc?utm=secret#frag",
      });
      for (const x of [touch, javascript, plain])
        await linkTouch(t.db, w, { id: lead.id, contactId: contact.id }, x.id);
      const d = await getLeadDetail(w.viewer.ctx, lead.id, deps());
      const [a, b, c] = d.attribution.linked;
      expect(a!.headline!.length).toBeLessThanOrEqual(200);
      expect(a!.headline).toMatch(/^Win big x+…?$/);
      expect(a!.headline).not.toMatch(/[\u202E\u0007]/);
      expect(a!.body!.length).toBeLessThanOrEqual(500);
      expect(a!.body).toContain("<script>alert(1)</script>"); // text, returned as text: it is rendered by React, never as HTML
      expect(a!.body).not.toContain("\u2066");
      expect(a!.sourceId).toBe("12 34");
      expect(a!.sourceLink).toBeNull(); // credentials in a URL: dropped
      expect(a!.mediaLink).toBe("https://cdn.example.test/ad.jpg"); // no query string, no fragment
      expect(a!.clickIdTail).toBe("…stuv");
      expect(b!.sourceLink).toBeNull(); // not http(s)
      expect(b!.mediaLink).toBeNull(); // too long to show whole
      expect(b!.clickIdTail).toBeNull(); // too short to mask meaningfully
      expect(c!.sourceLink).toBe("https://fb.me/abc");
      const json = JSON.stringify(d);
      for (const secret of [
        clid,
        "SECRETTOKEN",
        "provider-only",
        "utm=secret",
        "thumbnail_url",
        "pw@",
      ])
        expect(json).not.toContain(secret);
    });

    it("a click id that ends in a bidirectional override is masked safely, and the stored evidence is unchanged (review B-L1)", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const lead = await seedLead(t.db, w, contact.id, { cycleStartedAt: minutesAgo(60) });
      const stored = [
        "ARAkLkA8rmlFeiCktEJQ\u202E",
        "ARAkLkA8rmlFeiCktE\u202EJQ\u0007\u2066",
        "ARAkLkA8rmlFeiCkt\u200F\u061C\u2028EJQ",
      ];
      const ids: string[] = [];
      for (const [i, clid] of stored.entries()) {
        const touch = await addTouch(t.db, w, contact.id, {
          receivedAt: minutesAgo(30 - i),
          ctwaClid: clid,
        });
        await linkTouch(t.db, w, { id: lead.id, contactId: contact.id }, touch.id);
        ids.push(touch.id);
      }
      const d = await getLeadDetail(w.viewer.ctx, lead.id, deps());
      expect(d.attribution.linked.map((x) => x.clickIdTail)).toEqual(["…tEJQ", "…tEJQ", "…tEJQ"]);
      for (const tail of d.attribution.linked.map((x) => x.clickIdTail!))
        expect(tail).toMatch(/^…[A-Za-z0-9]{4}$/);
      // the provider evidence itself is exactly what Meta sent
      const rows = (
        await q("select id, ctwa_clid from lead_attributions where id = any($1)", [ids])
      ).rows as Array<{ id: string; ctwa_clid: string }>;
      expect(new Map(rows.map((r) => [r.id, r.ctwa_clid]))).toEqual(
        new Map(ids.map((id, i) => [id, stored[i]!])),
      );
    });

    it("lists the contact's conversations, the history newest first, and what the caller may do", async () => {
      const w = await world(t.db);
      const created = await createManualLead(w.staff.ctx, { contactId: w.contact.id }, deps());
      await changeLeadStatus(
        w.staff.ctx,
        created.lead.id,
        { to: "QUALIFIED", expectedRevision: 0 },
        deps(),
      );
      await changeLeadStatus(
        w.admin.ctx,
        created.lead.id,
        { to: "NOT_INTERESTED", expectedRevision: 1 },
        deps(),
      );
      const d = await getLeadDetail(w.viewer.ctx, created.lead.id, deps());
      expect(d.conversations.map((x) => x.id)).toEqual([w.conversation.id]);
      expect(d.conversations[0]).toMatchObject({ status: "OPEN" });
      expect(
        d.history.events.map((e) => `${e.kind}:${e.from ?? ""}>${e.to ?? ""}@${e.revision}`),
      ).toEqual(["STATUS:QUALIFIED>NOT_INTERESTED@2", "STATUS:NEW>QUALIFIED@1", "CREATED:>@0"]);
      expect(d.history.events[0]!.actorName).toBeTruthy();
      expect(d.lead.closedAt).not.toBeNull();
      expect(d.can).toEqual({ edit: false });
      expect((await getLeadDetail(w.staff.ctx, created.lead.id, deps())).can).toEqual({
        edit: true,
      });
    });

    it("another organization's lead, a missing lead and a malformed id are the same 404; permissions are all required", async () => {
      const a = await world(t.db);
      const b = await world(t.db);
      const lead = await seedLead(t.db, a, a.contact.id);
      for (const id of [lead.id, "00000000-0000-4000-8000-000000000001", "not-a-uuid"]) {
        const ctx = id === lead.id ? b.admin.ctx : a.admin.ctx;
        await expect(getLeadDetail(ctx, id, deps())).rejects.toBeInstanceOf(NotFoundError);
        await expect(listLeadEvents(ctx, id, {}, deps())).rejects.toBeInstanceOf(NotFoundError);
      }
      // a role that holds nothing is refused before anything is read (each of the three permissions is asserted: boundaries.test.ts)
      const nobody = { ...a.viewer.ctx, role: "NONE" } as unknown as AccessContext;
      await expect(getLeadDetail(nobody, lead.id, deps())).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listLeadEvents(nobody, lead.id, {}, deps())).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------------------------------------ the history
  describe("the lead history", () => {
    it("is paged newest first, exactly at microsecond precision, with the system as actor for automatic events", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id);
      const origin = await addTouch(t.db, w, contact.id, { receivedAt: minutesAgo(30) });
      const lead = await seedAutomaticLead(t.db, w, contact.id, origin.id);
      let revision = 0;
      for (const to of ["QUALIFIED", "INTERESTED", "NEW", "QUALIFIED", "INTERESTED"] as const)
        await changeLeadStatus(w.staff.ctx, lead.id, { to, expectedRevision: revision++ }, deps());
      const expected = (
        await q("select id from lead_events where lead_id = $1 order by created_at desc, id desc", [
          lead.id,
        ])
      ).rows.map((r) => r.id as string);
      expect(expected).toHaveLength(7);
      for (const limit of [1, 2, 3, 7, 50]) {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let pages = 0; pages < 10; pages++) {
          const page = await listLeadEvents(
            w.viewer.ctx,
            lead.id,
            { limit: String(limit), ...(cursor ? { cursor } : {}) },
            deps(),
          );
          seen.push(...page.events.map((e) => e.id));
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        expect(seen, `limit ${limit}`).toEqual(expected);
      }
      const all = (await listLeadEvents(w.viewer.ctx, lead.id, {}, deps())).events;
      const created = all.find((e) => e.kind === "CREATED")!;
      expect(created).toMatchObject({
        origin: "AD_REFERRAL",
        actorName: null,
        touch: { id: origin.id, label: "Meta ad" },
      });
      expect(all.find((e) => e.kind === "TOUCH_LINKED")).toMatchObject({
        actorName: null,
        touch: { id: origin.id },
      });
      expect(all.find((e) => e.kind === "STATUS")!.actorName).toBeTruthy();
      for (const e of all) expect(e.atKey).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    });

    it("validates its query like the list does", async () => {
      const w = await world(t.db);
      const lead = await seedLead(t.db, w, w.contact.id);
      for (const query of [
        { limit: "0" },
        { limit: "51" },
        { cursor: "nope" },
        { q: "ab" },
        { organizationId: w.org.id },
      ])
        await expect(listLeadEvents(w.viewer.ctx, lead.id, query, deps())).rejects.toBeInstanceOf(
          ValidationError,
        );
    });
  });

  describe("invalid calendar cursors (review B-M2)", () => {
    const id = "6f1c4d0a-8b5e-4a57-9d34-0c2d9a1b7e11";
    const cursorAt = (tt: string) =>
      Buffer.from(JSON.stringify({ t: tt, id })).toString("base64url");
    const invalid = [
      "2026-99-99T25:61:61.000000Z",
      "2026-13-01T00:00:00.000000Z",
      "2026-01-32T00:00:00.000000Z",
      "2026-01-01T24:00:00.000000Z",
      "2026-01-01T00:60:00.000000Z",
      "2026-01-01T00:00:60.000000Z",
      "2026-02-29T00:00:00.000000Z",
    ];

    it("are a validation error from the list and from the history, and never reach PostgreSQL as a timestamp", async () => {
      const w = await world(t.db);
      const lead = await seedLead(t.db, w, w.contact.id);
      let statements = 0;
      const counted = {
        execute: (query: Parameters<Database["execute"]>[0]) => {
          statements++;
          return t.db.execute(query);
        },
      } as unknown as Database;
      for (const tt of invalid) {
        await expect(
          listLeads(w.viewer.ctx, { cursor: cursorAt(tt) }, { db: counted }),
          tt,
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(
          listLeadEvents(w.viewer.ctx, lead.id, { cursor: cursorAt(tt) }, { db: counted }),
          tt,
        ).rejects.toBeInstanceOf(ValidationError);
      }
      expect(statements).toBe(0);
    });

    it("a real leap-day cursor is accepted, and pages with equal timestamps are still exact", async () => {
      const w = await world(t.db);
      const leap = "2024-02-29T12:00:00.000001Z";
      await listLeads(w.viewer.ctx, { cursor: cursorAt(leap) }, deps()); // does not throw
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const c = await addContact(t.db, w.org.id);
        ids.push(
          (
            await q(
              "insert into leads (organization_id, contact_id, created_at, cycle_started_at, status_changed_at) values ($1, $2, '2024-02-29 12:00:00.000001+00', '2024-02-29 12:00:00.000001+00', '2024-02-29 12:00:00.000001+00') returning id",
              [w.org.id, c.id],
            )
          ).rows[0].id as string,
        );
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await listLeads(
          w.viewer.ctx,
          { limit: "1", ...(cursor ? { cursor } : {}) },
          deps(),
        );
        seen.push(...page.items.map((x) => x.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen).toEqual([...ids].sort().reverse());
    });
  });

  // ------------------------------------------------------------------------------------------ the contact's leads
  describe("the leads of a contact", () => {
    it("reports the open lead, the history of leads, and whether a new one may be created", async () => {
      const w = await world(t.db);
      const contact = await addContact(t.db, w.org.id, { profileName: "Saman" });
      let r = await getContactLeads(w.staff.ctx, contact.id, deps());
      expect(r).toMatchObject({
        openLead: null,
        leads: [],
        can: { create: true },
        contact: { archived: false, label: { displayName: "Saman" } },
      });
      expect((await getContactLeads(w.viewer.ctx, contact.id, deps())).can.create).toBe(false);

      const closed = await seedLead(t.db, w, contact.id, {
        status: "CONVERTED",
        createdAt: minutesAgo(500),
      });
      r = await getContactLeads(w.staff.ctx, contact.id, deps());
      expect(r.openLead).toBeNull();
      expect(r.can.create).toBe(true); // a converted contact may get a new manual lead
      const created = await createManualLead(w.staff.ctx, { contactId: contact.id }, deps());
      r = await getContactLeads(w.staff.ctx, contact.id, deps());
      expect(r.openLead!.id).toBe(created.lead.id);
      expect(r.leads.map((l: LeadItem) => l.id)).toEqual([created.lead.id, closed.id]);
      expect(r.can.create).toBe(false);

      const archived = await addContact(t.db, w.org.id, { archived: true });
      expect((await getContactLeads(w.admin.ctx, archived.id, deps())).can.create).toBe(false);
    });

    it("finds an open lead that is older than the ten newest leads (review B-M1): openLead and can.create follow the database, not the window", async () => {
      const w = await world(t.db);
      for (const newerClosed of [0, 9, 10, 11, 25]) {
        const contact = await addContact(t.db, w.org.id);
        const open = await seedLead(t.db, w, contact.id, {
          status: "INTERESTED",
          createdAt: minutesAgo(10_000),
          cycleStartedAt: minutesAgo(10_100),
        });
        const closedIds: string[] = [];
        for (let i = 0; i < newerClosed; i++)
          closedIds.push(
            (
              await seedLead(t.db, w, contact.id, {
                status: i % 2 ? "NOT_INTERESTED" : "NO_RESPONSE",
                createdAt: minutesAgo(9_000 - i * 10),
                cycleStartedAt: minutesAgo(9_100 - i * 10),
                closedAt: minutesAgo(8_900 - i * 10),
              })
            ).id,
          );
        for (const actor of [w.staff, w.admin, w.viewer]) {
          const r = await getContactLeads(actor.ctx, contact.id, deps());
          expect(r.openLead?.id, `${newerClosed} newer closed leads`).toBe(open.id);
          expect(r.openLead?.status).toBe("INTERESTED");
          expect(r.can.create, `${actor.role}, ${newerClosed} newer`).toBe(false);
          // the history stays bounded: the ten newest, newest first
          expect(r.leads.length).toBe(Math.min(10, newerClosed + 1));
          expect(r.leads.map((l) => l.id)).toEqual(
            [...closedIds.slice().reverse(), open.id].slice(0, 10),
          );
        }
        // with the open lead beyond the window it is not in `leads`, and it is still found
        if (newerClosed >= 10)
          expect(
            (await getContactLeads(w.staff.ctx, contact.id, deps())).leads.map((l) => l.id),
          ).not.toContain(open.id);
        // closing it makes the contact creatable again, whatever the number of leads
        await changeLeadStatus(
          w.staff.ctx,
          open.id,
          { to: "INVALID", expectedRevision: 0 },
          deps(),
        );
        const after = await getContactLeads(w.staff.ctx, contact.id, deps());
        expect(after.openLead).toBeNull();
        expect(after.can.create).toBe(true);
        expect((await getContactLeads(w.viewer.ctx, contact.id, deps())).can.create).toBe(false);
      }
    });

    it("no open lead and many closed ones, an archived contact with an old open lead, and a reserved-status open lead", async () => {
      const w = await world(t.db);
      const many = await addContact(t.db, w.org.id);
      for (let i = 0; i < 12; i++)
        await seedLead(t.db, w, many.id, {
          status: "NOT_INTERESTED",
          createdAt: minutesAgo(5_000 - i),
          cycleStartedAt: minutesAgo(5_100 - i),
          closedAt: minutesAgo(4_900 - i),
        });
      const none = await getContactLeads(w.staff.ctx, many.id, deps());
      expect(none.openLead).toBeNull();
      expect(none.leads).toHaveLength(10);
      expect(none.can.create).toBe(true);

      // an archived contact that still has an old open lead: the lead is reported, and nothing can be created
      const archived = await addContact(t.db, w.org.id);
      const old = await seedLead(t.db, w, archived.id, {
        createdAt: minutesAgo(9_000),
        cycleStartedAt: minutesAgo(9_100),
      });
      for (let i = 0; i < 11; i++)
        await seedLead(t.db, w, archived.id, {
          status: "INVALID",
          createdAt: minutesAgo(100 - i),
          cycleStartedAt: minutesAgo(200 - i),
          closedAt: minutesAgo(50 - i),
        });
      await t.db
        .update(schema.contacts)
        .set({ archivedAt: new Date() })
        .where(eq(schema.contacts.id, archived.id));
      const frozen = await getContactLeads(w.staff.ctx, archived.id, deps());
      expect(frozen.openLead?.id).toBe(old.id);
      expect(frozen.contact.archived).toBe(true);
      expect(frozen.can.create).toBe(false);

      // an open lead in a reserved status is still the contact's open lead
      const paid = await addContact(t.db, w.org.id);
      const reservedLead = await seedLead(t.db, w, paid.id, {
        status: "PAID",
        createdAt: minutesAgo(9_000),
        cycleStartedAt: minutesAgo(9_100),
      });
      for (let i = 0; i < 10; i++)
        await seedLead(t.db, w, paid.id, {
          status: "NO_RESPONSE",
          createdAt: minutesAgo(100 - i),
          cycleStartedAt: minutesAgo(200 - i),
          closedAt: minutesAgo(50 - i),
        });
      const reserved = await getContactLeads(w.staff.ctx, paid.id, deps());
      expect(reserved.openLead).toMatchObject({
        id: reservedLead.id,
        status: "PAID",
        readOnly: true,
      });
      expect(reserved.can.create).toBe(false);
    });

    it("another organization's contact never exposes its leads, however many it has", async () => {
      const a = await world(t.db);
      const b = await world(t.db);
      const contact = await addContact(t.db, b.org.id);
      await seedLead(t.db, b, contact.id, {
        createdAt: minutesAgo(9_000),
        cycleStartedAt: minutesAgo(9_100),
      });
      for (let i = 0; i < 12; i++)
        await seedLead(t.db, b, contact.id, {
          status: "INVALID",
          createdAt: minutesAgo(100 - i),
          cycleStartedAt: minutesAgo(200 - i),
          closedAt: minutesAgo(50 - i),
        });
      await expect(getContactLeads(a.admin.ctx, contact.id, deps())).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect((await getContactLeads(b.admin.ctx, contact.id, deps())).openLead).not.toBeNull();
    });

    it("is read-only and tenant-safe: another organization's contact and a malformed id are the same 404", async () => {
      const a = await world(t.db);
      const b = await world(t.db);
      await expect(getContactLeads(b.admin.ctx, a.contact.id, deps())).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(getContactLeads(a.admin.ctx, "nope", deps())).rejects.toBeInstanceOf(
        NotFoundError,
      );
      const nobody = { ...a.viewer.ctx, role: "NONE" } as unknown as AccessContext;
      await expect(getContactLeads(nobody, a.contact.id, deps())).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });
});
