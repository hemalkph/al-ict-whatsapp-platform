import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { insertEvent } from "../queue/testing";
import { resolveInboundContact } from "./resolve";
import {
  DOMAIN_TABLES,
  PN2,
  WABA2,
  ingestFixture,
  minutesAgo,
  send,
  tenant,
  type SendOptions,
  type StoredEvent,
} from "./testing";

// Contact identity resolution against REAL PostgreSQL, always fed by genuine events from the real ingest path
// (sanitized G0 fixtures where one exists). No lead, conversation, message or consent row may ever appear.

describe("inbound contact identity resolution", () => {
  let t: TestDb;
  const logs: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    logs.length = 0;
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((line: unknown) => void logs.push(String(line)));
    }
    await t.pool.query(
      "truncate webhook_events, webhook_requests, whatsapp_accounts, organizations cascade",
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const table of DOMAIN_TABLES) {
      const r = await t.pool.query(`select count(*)::int n from ${table}`);
      expect(
        r.rows[0].n,
        `${table} must stay empty: identity resolution creates no such rows`,
      ).toBe(0);
    }
  });

  const resolve = (e: StoredEvent, observedAt = minutesAgo(1)) =>
    t.db.transaction((tx) => resolveInboundContact(tx, e, { observedAt }));
  const contacts = async (orgId?: string) =>
    (
      await t.pool.query(
        `select * from contacts ${orgId ? "where organization_id = $1" : ""} order by created_at, id`,
        orgId ? [orgId] : [],
      )
    ).rows;
  const contactRow = async (id: string) =>
    (await t.pool.query("select * from contacts where id = $1", [id])).rows[0];
  const aliases = async () =>
    (await t.pool.query("select * from contact_bsuids order by bsuid, id")).rows;
  const ownership = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await t.pool.query("select id, contact_id from contact_bsuids")).rows.map(
        (r) => [r.id, r.contact_id] as [string, string],
      ),
    );
  const sendTo = (o: SendOptions) => send(t.db, o);

  // ------------------------------------------------------------------------------------- new contacts (G0 fixtures)
  describe("new contacts", () => {
    it("BSUID only (official username fixture): a BSUID-owned contact, alias with provenance, no parent id stored", async () => {
      const { org } = await tenant(t.db);
      const [event] = await ingestFixture(t.db, "text-bsuid-only-username.json");
      const observedAt = minutesAgo(5);
      const result = await resolve(event!, observedAt);
      expect(result).toMatchObject({ created: true, conflicts: [] });

      const row = await contactRow(result.contactId);
      expect(row).toMatchObject({
        organization_id: org.id,
        wa_id: null,
        phone_e164: null,
        profile_name: "Test Student",
        username: "test.student",
        marketing_consent_status: "UNKNOWN",
        marketing_consent_updated_at: null,
        archived_at: null,
      });
      expect(row.first_seen_at).toEqual(observedAt);
      expect(row.last_seen_at).toEqual(observedAt);
      const all = await aliases();
      expect(all).toHaveLength(1); // the parent BSUID in the fixture is not an identity here
      expect(all[0]).toMatchObject({
        organization_id: org.id,
        contact_id: result.contactId,
        bsuid: "LK.100000000000000001",
        retired_at: null,
        source_webhook_event_id: event!.id,
      });
      expect(all[0].first_seen_at).toEqual(observedAt);
      expect(all.some((a) => String(a.bsuid).includes("ENT"))).toBe(false);
    });

    it("BSUID + wa_id (fixture): the contact keeps both identifiers", async () => {
      await tenant(t.db);
      const [event] = await ingestFixture(t.db, "text-phone-and-bsuid.json");
      const result = await resolve(event!);
      expect(result.created).toBe(true);
      expect(await contactRow(result.contactId)).toMatchObject({
        wa_id: "15550100123",
        profile_name: "Test Student",
      });
      expect(await aliases()).toMatchObject([
        { contact_id: result.contactId, bsuid: "LK.100000000000000001", retired_at: null },
      ]);
    });

    it("legacy wa_id only (fixture): a phone-identified contact and no alias", async () => {
      await tenant(t.db);
      const [event] = await ingestFixture(t.db, "text-phone.json");
      const result = await resolve(event!);
      expect(result).toMatchObject({ created: true, conflicts: [] });
      expect(await contactRow(result.contactId)).toMatchObject({
        wa_id: "15550100123",
        username: null,
      });
      expect(await aliases()).toEqual([]);
    });

    it("never creates marketing consent, a lead, a conversation or a student: the consent cache is UNKNOWN and every domain table stays empty", async () => {
      await tenant(t.db);
      const result = await resolve(
        await sendTo({ bsuid: "LK.A1", from: "15550100200", name: "A" }),
      );
      expect((await contactRow(result.contactId)).marketing_consent_status).toBe("UNKNOWN");
      // DOMAIN_TABLES are verified empty in afterEach
    });

    it("the multi-sender fixture resolves three distinct senders, each with only ITS own contacts[] element", async () => {
      await tenant(t.db);
      const events = await ingestFixture(t.db, "multi-sender-pairing.json");
      expect(events).toHaveLength(3);
      const byWamid = Object.fromEntries(events.map((e) => [e.providerObjectId, e]));
      const first = await resolve(byWamid["wamid.FAKE00000000000000000050"]!);
      const second = await resolve(byWamid["wamid.FAKE00000000000000000051"]!);
      const third = await resolve(byWamid["wamid.FAKE00000000000000000052"]!);
      expect(new Set([first.contactId, second.contactId, third.contactId]).size).toBe(3);
      expect(await contactRow(first.contactId)).toMatchObject({
        profile_name: "First Sender",
        wa_id: "15550100123",
      });
      expect(await contactRow(second.contactId)).toMatchObject({
        profile_name: "Second Sender",
        wa_id: "15550100124",
      });
      expect(await contactRow(third.contactId)).toMatchObject({ profile_name: null, wa_id: null });
    });
  });

  // --------------------------------------------------------------------------------------------- known identities
  describe("known BSUIDs", () => {
    it("a current alias resolves to its contact and only widens the seen windows", async () => {
      await tenant(t.db);
      const first = await resolve(await sendTo({ bsuid: "LK.B1", name: "First" }), minutesAgo(30));
      const again = await resolve(await sendTo({ bsuid: "LK.B1", name: "Second" }), minutesAgo(10));
      expect(again).toMatchObject({
        contactId: first.contactId,
        created: false,
      });
      expect(await contacts()).toHaveLength(1);
      const row = await contactRow(first.contactId);
      expect(row.profile_name).toBe("Second");
      expect(row.first_seen_at).toEqual((await aliases())[0].first_seen_at);
      expect(row.last_seen_at.getTime()).toBeGreaterThan(row.first_seen_at.getTime());
    });

    it("a BSUID-only contact later seen with a free phone gets that wa_id", async () => {
      await tenant(t.db);
      const first = await resolve(await sendTo({ bsuid: "LK.B2" }));
      expect((await contactRow(first.contactId)).wa_id).toBeNull();
      await resolve(await sendTo({ bsuid: "LK.B2", from: "15550100300" }));
      expect((await contactRow(first.contactId)).wa_id).toBe("15550100300");
      expect(await contacts()).toHaveLength(1);
    });

    it("a RETIRED alias still resolves to its contact, creates no second contact, and is not reactivated or touched", async () => {
      const { org } = await tenant(t.db);
      const x = await resolve(await sendTo({ bsuid: "LK.NEW", name: "Person" }), minutesAgo(200));
      await t.pool.query(
        `insert into contact_bsuids (organization_id, contact_id, bsuid, first_seen_at, last_seen_at, retired_at)
         values ($1, $2, 'LK.OLD', now() - interval '300 minutes', now() - interval '250 minutes', now() - interval '240 minutes')`,
        [org.id, x.contactId],
      );
      const before = (await t.pool.query("select * from contact_bsuids where bsuid = 'LK.OLD'"))
        .rows[0];

      const late = await resolve(await sendTo({ bsuid: "LK.OLD", name: "Person" }), minutesAgo(2));
      expect(late).toMatchObject({ contactId: x.contactId, created: false, conflicts: [] });
      expect(await contacts()).toHaveLength(1);
      const after = (await t.pool.query("select * from contact_bsuids where bsuid = 'LK.OLD'"))
        .rows[0];
      expect(after).toEqual(before); // untouched: not reactivated, not promoted, not re-pointed
      expect(after.retired_at).not.toBeNull();
      expect(
        (await t.pool.query("select count(*)::int n from contact_bsuids where retired_at is null"))
          .rows[0].n,
      ).toBe(1);
    });

    it("seeing an old BSUID with the contact's phone adds nothing and promotes nothing", async () => {
      const { org } = await tenant(t.db);
      const x = await resolve(await sendTo({ bsuid: "LK.CUR", from: "15550100400" }));
      await t.pool.query(
        `insert into contact_bsuids (organization_id, contact_id, bsuid, first_seen_at, last_seen_at, retired_at)
         values ($1, $2, 'LK.RET', now() - interval '9 days', now() - interval '8 days', now() - interval '8 days')`,
        [org.id, x.contactId],
      );
      const result = await resolve(await sendTo({ bsuid: "LK.RET", from: "15550100400" }));
      expect(result.contactId).toBe(x.contactId);
      expect(result.conflicts).toEqual([]);
      const retired = (await aliases()).find((a) => a.bsuid === "LK.RET");
      expect(retired.retired_at).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------------- phone rules
  describe("phone numbers are secondary and never merge established identities", () => {
    it("a known BSUID whose message phone belongs to ANOTHER contact stays with its own contact; nothing moves", async () => {
      const { org } = await tenant(t.db);
      const legacy = await resolve(await sendTo({ from: "15550100501", name: "Phone Person" }));
      const bsuidOwner = await resolve(await sendTo({ bsuid: "LK.C1", name: "Bsuid Person" }));
      const ownersBefore = await ownership();

      const result = await resolve(await sendTo({ bsuid: "LK.C1", from: "15550100501" }));
      expect(result.contactId).toBe(bsuidOwner.contactId);
      expect(result.conflicts).toEqual(["phone_owned_by_other_contact"]);
      expect(await contactRow(bsuidOwner.contactId)).toMatchObject({ wa_id: null });
      expect(await contactRow(legacy.contactId)).toMatchObject({
        wa_id: "15550100501",
        profile_name: "Phone Person",
      });
      expect(await ownership()).toEqual(ownersBefore);
      expect((await contacts(org.id)).length).toBe(2);

      const conflict = logs
        .map((l) => JSON.parse(l))
        .find((l) => l.webhook_event === "webhook.contact_identity_conflict");
      expect(conflict).toMatchObject({
        reason: "phone_owned_by_other_contact",
        organization_id: org.id,
        contact_id: bsuidOwner.contactId,
        other_contact_id: legacy.contactId,
      });
    });

    it("an existing contact's phone is never rewritten by a different phone on a later message", async () => {
      await tenant(t.db);
      const x = await resolve(await sendTo({ bsuid: "LK.C2", from: "15550100601" }));
      const result = await resolve(await sendTo({ bsuid: "LK.C2", from: "15550100602" }));
      expect(result.contactId).toBe(x.contactId);
      expect(result.conflicts).toEqual(["phone_differs_from_contact"]);
      expect((await contactRow(x.contactId)).wa_id).toBe("15550100601");
      expect((await contacts()).some((c) => c.wa_id === "15550100602")).toBe(false);
    });

    it("two BSUIDs sharing a (recycled) phone are NEVER merged: the second gets its own contact without the phone", async () => {
      const { org } = await tenant(t.db);
      const one = await resolve(
        await sendTo({ bsuid: "LK.P1", from: "15550100700", name: "First Owner" }),
      );
      const two = await resolve(
        await sendTo({ bsuid: "LK.P2", from: "15550100700", name: "New Owner" }),
      );
      expect(two.contactId).not.toBe(one.contactId);
      expect(two).toMatchObject({
        created: true,
        conflicts: ["phone_held_by_bsuid_contact"],
      });
      expect(await contactRow(one.contactId)).toMatchObject({
        wa_id: "15550100700",
        profile_name: "First Owner",
      });
      expect(await contactRow(two.contactId)).toMatchObject({
        wa_id: null,
        profile_name: "New Owner",
      });
      const owners = Object.fromEntries((await aliases()).map((a) => [a.bsuid, a.contact_id]));
      expect(owners).toEqual({ "LK.P1": one.contactId, "LK.P2": two.contactId });

      // each BSUID keeps resolving to its own contact afterwards
      expect((await resolve(await sendTo({ bsuid: "LK.P1", from: "15550100700" }))).contactId).toBe(
        one.contactId,
      );
      const again = await resolve(await sendTo({ bsuid: "LK.P2", from: "15550100700" }));
      expect(again.contactId).toBe(two.contactId);
      expect(again.conflicts).toEqual(["phone_owned_by_other_contact"]);
      expect((await contacts(org.id)).length).toBe(2);
    });

    it("a phone held by a contact whose only alias is RETIRED still counts as established: no merge", async () => {
      const { org } = await tenant(t.db);
      const x = await resolve(await sendTo({ bsuid: "LK.Q1", from: "15550100800" }));
      await t.pool.query(
        "update contact_bsuids set retired_at = now() where organization_id = $1",
        [org.id],
      );
      const other = await resolve(await sendTo({ bsuid: "LK.Q2", from: "15550100800" }));
      expect(other.contactId).not.toBe(x.contactId);
      expect(other.conflicts).toEqual(["phone_held_by_bsuid_contact"]);
    });

    it("logs carry internal ids and reason codes only: no phone, BSUID, name or message text", async () => {
      await tenant(t.db);
      await resolve(await sendTo({ bsuid: "LK.S1", from: "15550101100", name: "Secret Name" }));
      await resolve(await sendTo({ bsuid: "LK.S2", from: "15550101100", name: "Other Secret" }));
      const all = logs.join("\n");
      expect(all).toContain("phone_held_by_bsuid_contact");
      for (const secret of [
        "15550101100",
        "LK.S1",
        "LK.S2",
        "Secret Name",
        "Other Secret",
        "hello wamid",
      ])
        expect(all, secret).not.toContain(secret);
    });
  });

  // ----------------------------------------------------------------- phone number is not proof of identity
  describe("a phone number is not proof of identity: legacy contacts are never taken over", () => {
    const W = "15550100900";

    it("an unknown BSUID arriving with a legacy contact's phone gets a SEPARATE contact without the phone; the legacy contact is untouched", async () => {
      const { org } = await tenant(t.db);
      const legacy = await resolve(await sendTo({ from: W, name: "Old Student" }), minutesAgo(60));
      const legacyBefore = await contactRow(legacy.contactId);

      const fresh = await resolve(await sendTo({ bsuid: "LK.L1", from: W, name: "New Person" }));
      expect(fresh).toMatchObject({
        created: true,
        conflicts: ["legacy_phone_ownership_unverified"],
      });
      expect(fresh.contactId).not.toBe(legacy.contactId);
      // the legacy contact is byte-for-byte unchanged (seen window, profile, phone, updated_at)
      expect(await contactRow(legacy.contactId)).toEqual(legacyBefore);
      // the new contact owns the BSUID but did not take the phone
      expect(await contactRow(fresh.contactId)).toMatchObject({
        wa_id: null,
        profile_name: "New Person",
      });
      expect(await aliases()).toMatchObject([
        { bsuid: "LK.L1", contact_id: fresh.contactId, retired_at: null },
      ]);
      expect(await contacts(org.id)).toHaveLength(2);
    });

    it("later messages from that BSUID resolve to the new contact, and the phone stays with the legacy contact", async () => {
      await tenant(t.db);
      const legacy = await resolve(await sendTo({ from: W, name: "Old Student" }), minutesAgo(60));
      const legacyBefore = await contactRow(legacy.contactId);
      const fresh = await resolve(await sendTo({ bsuid: "LK.L1", from: W }));

      const bsuidOnly = await resolve(await sendTo({ bsuid: "LK.L1" }));
      expect(bsuidOnly).toMatchObject({
        contactId: fresh.contactId,
        created: false,
        conflicts: [],
      });
      const withPhone = await resolve(await sendTo({ bsuid: "LK.L1", from: W }));
      expect(withPhone).toMatchObject({
        contactId: fresh.contactId,
        created: false,
        conflicts: ["phone_owned_by_other_contact"],
      });
      expect((await contactRow(fresh.contactId)).wa_id).toBeNull();
      expect(await contactRow(legacy.contactId)).toEqual(legacyBefore);
    });

    it("another BSUID using the same phone is also separate; nothing is ever linked to the legacy contact", async () => {
      await tenant(t.db);
      const legacy = await resolve(await sendTo({ from: W }), minutesAgo(60));
      const one = await resolve(await sendTo({ bsuid: "LK.L1", from: W }));
      const two = await resolve(await sendTo({ bsuid: "LK.L2", from: W }));
      expect(new Set([legacy.contactId, one.contactId, two.contactId]).size).toBe(3);
      expect(one.conflicts).toEqual(["legacy_phone_ownership_unverified"]);
      expect(two.conflicts).toEqual(["legacy_phone_ownership_unverified"]);
      const owners = Object.fromEntries((await aliases()).map((a) => [a.bsuid, a.contact_id]));
      expect(owners).toEqual({ "LK.L1": one.contactId, "LK.L2": two.contactId });
      expect((await contactRow(legacy.contactId)).wa_id).toBe(W);
    });

    it("a phone-only message resolves a contact that has no BSUID (inherently uncertain, never BSUID-verified)", async () => {
      await tenant(t.db);
      const first = await resolve(await sendTo({ from: W, name: "Old" }), minutesAgo(30));
      expect(first.created).toBe(true);
      const again = await resolve(await sendTo({ from: W, name: "Newer" }), minutesAgo(10));
      expect(again).toMatchObject({ contactId: first.contactId, created: false, conflicts: [] });
      expect(await contactRow(first.contactId)).toMatchObject({ wa_id: W, profile_name: "Newer" });
      expect(await aliases()).toEqual([]); // no BSUID was ever invented for it
    });

    it("a phone-only message is refused for a BSUID-established contact: nothing is modified, nothing is created", async () => {
      await tenant(t.db);
      const established = await resolve(
        await sendTo({ bsuid: "LK.E1", from: "15550101000", name: "Established" }),
      );
      const before = await contactRow(established.contactId);
      const aliasesBefore = await aliases();

      await expect(
        resolve(await sendTo({ from: "15550101000", name: "Impostor" })),
      ).rejects.toMatchObject({
        code: "phone_only_identity_ambiguous",
      });
      expect(await contactRow(established.contactId)).toEqual(before);
      expect(await aliases()).toEqual(aliasesBefore);
      expect(await contacts()).toHaveLength(1);
      const conflict = logs
        .map((l) => JSON.parse(l))
        .find((l) => l.reason === "phone_only_identity_ambiguous");
      expect(conflict).toMatchObject({
        webhook_event: "webhook.contact_identity_conflict",
        other_contact_id: established.contactId,
      });
    });

    it("the same refusal applies when the contact's only alias is retired", async () => {
      await tenant(t.db);
      const established = await resolve(await sendTo({ bsuid: "LK.E2", from: "15550101001" }));
      await t.pool.query("update contact_bsuids set retired_at = now()");
      const before = await contactRow(established.contactId);
      await expect(resolve(await sendTo({ from: "15550101001" }))).rejects.toMatchObject({
        code: "phone_only_identity_ambiguous",
      });
      expect(await contactRow(established.contactId)).toEqual(before);
    });

    it("an entirely unknown phone creates a phone-only contact that is not BSUID-verified", async () => {
      await tenant(t.db);
      const result = await resolve(await sendTo({ from: "15550101002", name: "Phone Only" }));
      expect(result).toMatchObject({ created: true, conflicts: [] });
      expect(await contactRow(result.contactId)).toMatchObject({ wa_id: "15550101002" });
      expect(await aliases()).toEqual([]);
    });

    it("the same phone and BSUID in two organizations stay isolated: B has no legacy contact, so its contact keeps the phone", async () => {
      const a = await tenant(t.db);
      const b = await tenant(t.db, { pn: PN2, waba: WABA2 });
      const legacyA = await resolve(await sendTo({ from: W }));
      const inB = await resolve(await sendTo({ pn: PN2, waba: WABA2, bsuid: "LK.L1", from: W }));
      expect(inB).toMatchObject({ created: true, conflicts: [] });
      expect(await contactRow(inB.contactId)).toMatchObject({
        organization_id: b.org.id,
        wa_id: W,
      });
      const inA = await resolve(await sendTo({ bsuid: "LK.L1", from: W }));
      expect(inA.conflicts).toEqual(["legacy_phone_ownership_unverified"]);
      expect(await contactRow(inA.contactId)).toMatchObject({
        organization_id: a.org.id,
        wa_id: null,
      });
      // B's established contact does not make A's phone-only contact ambiguous, and vice versa
      expect((await resolve(await sendTo({ from: W }))).contactId).toBe(legacyA.contactId);
      await expect(resolve(await sendTo({ pn: PN2, waba: WABA2, from: W }))).rejects.toMatchObject({
        code: "phone_only_identity_ambiguous",
      });
      expect((await contactRow(legacyA.contactId)).organization_id).toBe(a.org.id);
    });

    it("conflicts are reported with reason codes and internal ids only (no phone, BSUID, name, username or text)", async () => {
      const { org } = await tenant(t.db);
      const legacy = await resolve(await sendTo({ from: "15550101100", name: "Legacy Secret" }));
      await resolve(
        await sendTo({
          bsuid: "LK.PII1",
          from: "15550101100",
          name: "Bsuid Secret",
          username: "secret.user",
        }),
      );
      await expect(resolve(await sendTo({ from: "15550101100" }))).resolves.toMatchObject({
        contactId: legacy.contactId,
      });
      const established = await resolve(
        await sendTo({ bsuid: "LK.PII2", from: "15550101101", name: "Other Secret" }),
      );
      await expect(resolve(await sendTo({ from: "15550101101" }))).rejects.toMatchObject({
        code: "phone_only_identity_ambiguous",
      });
      const all = logs.join("\n");
      expect(all).toContain("legacy_phone_ownership_unverified");
      expect(all).toContain("phone_only_identity_ambiguous");
      expect(all).toContain(org.id);
      expect(all).toContain(established.contactId);
      for (const secret of [
        "15550101100",
        "15550101101",
        "LK.PII1",
        "LK.PII2",
        "Legacy Secret",
        "Bsuid Secret",
        "Other Secret",
        "secret.user",
        "hello wamid",
      ])
        expect(all, secret).not.toContain(secret);
    });

    it("a transaction that rolls back leaves no partially created contact or alias, and a refusal writes nothing", async () => {
      await tenant(t.db);
      const legacy = await resolve(await sendTo({ from: W }));
      const aliasEvent = await sendTo({ bsuid: "LK.RB1", from: W });
      await expect(
        t.db.transaction(async (tx) => {
          const r = await resolveInboundContact(tx, aliasEvent, { observedAt: minutesAgo(1) });
          expect(r.created).toBe(true); // created inside the transaction...
          throw new Error("later step failed");
        }),
      ).rejects.toThrow("later step failed");
      expect(await contacts()).toHaveLength(1); // ...and gone again: only the legacy contact remains
      expect(await aliases()).toEqual([]);

      const established = await resolve(await sendTo({ bsuid: "LK.RB2", from: "15550101200" }));
      const countBefore = (await contacts()).length;
      await expect(resolve(await sendTo({ from: "15550101200" }))).rejects.toMatchObject({
        code: "phone_only_identity_ambiguous",
      });
      expect(await contacts()).toHaveLength(countBefore);
      expect((await contactRow(established.contactId)).wa_id).toBe("15550101200");
      expect((await contactRow(legacy.contactId)).wa_id).toBe(W);
    });
  });

  // ------------------------------------------------------------------------------------------------- tenant rules
  describe("organization scoping", () => {
    it("the same BSUID and the same phone in two organizations are independent identities", async () => {
      const a = await tenant(t.db);
      const b = await tenant(t.db, { pn: PN2, waba: WABA2 });
      const inA = await resolve(
        await sendTo({ bsuid: "LK.T1", from: "15550101200", name: "In A" }),
      );
      const inB = await resolve(
        await sendTo({ pn: PN2, waba: WABA2, bsuid: "LK.T1", from: "15550101200", name: "In B" }),
      );
      expect(inB.contactId).not.toBe(inA.contactId);
      expect(inB.created).toBe(true);
      expect(await contactRow(inA.contactId)).toMatchObject({
        organization_id: a.org.id,
        profile_name: "In A",
        wa_id: "15550101200",
      });
      expect(await contactRow(inB.contactId)).toMatchObject({
        organization_id: b.org.id,
        profile_name: "In B",
        wa_id: "15550101200",
      });
      const rows = await aliases();
      expect(rows.map((r) => [r.organization_id, r.contact_id]).sort()).toEqual(
        [
          [a.org.id, inA.contactId],
          [b.org.id, inB.contactId],
        ].sort(),
      );
      // messages in B never touch A
      await resolve(await sendTo({ pn: PN2, waba: WABA2, bsuid: "LK.T1", name: "In B v2" }));
      expect((await contactRow(inA.contactId)).profile_name).toBe("In A");
    });

    it("another organization's retired alias or phone is invisible", async () => {
      const a = await tenant(t.db);
      await tenant(t.db, { pn: PN2, waba: WABA2 });
      const inA = await resolve(await sendTo({ bsuid: "LK.U1", from: "15550101300" }));
      await t.pool.query(
        "update contact_bsuids set retired_at = now() where organization_id = $1",
        [a.org.id],
      );
      const inB = await resolve(
        await sendTo({ pn: PN2, waba: WABA2, bsuid: "LK.U1", from: "15550101300" }),
      );
      expect(inB).toMatchObject({ created: true, conflicts: [] });
      expect(inB.contactId).not.toBe(inA.contactId);
    });

    it("an organization named inside the Meta payload is ignored: the trusted event decides the tenant", async () => {
      const a = await tenant(t.db);
      const b = await tenant(t.db, { pn: PN2, waba: WABA2 });
      const event = await sendTo({ bsuid: "LK.V1", from: "15550101400" });
      const hostile = {
        ...(event.payload as object),
        organization_id: b.org.id,
        organizationId: b.org.id,
        message: { ...(event.payload as { message: object }).message, organization_id: b.org.id },
      };
      const result = await resolve({ ...event, payload: hostile });
      expect((await contactRow(result.contactId)).organization_id).toBe(a.org.id);
      expect(await contacts(b.org.id)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------- profile and time
  describe("profile text and seen-window ordering", () => {
    it("display text is cleaned, bounded, and keeps Sinhala/Tamil joiners", async () => {
      await tenant(t.db);
      const sinhala = "\u{DC1}\u{DCA}\u{200D}\u{DBB}\u{DD3}"; // contains a zero-width joiner, which must survive
      const dirty = `  Ab\u0000c\u{202E}D\n\te${"x".repeat(400)}  `;
      const a = await resolve(
        await sendTo({ bsuid: "LK.W1", name: dirty, username: "  user\u0007name  " }),
      );
      const row = await contactRow(a.contactId);
      expect(row.profile_name.startsWith("AbcD e")).toBe(true);
      expect(Array.from(row.profile_name).length).toBeLessThanOrEqual(200);
      expect(row.profile_name).not.toMatch(/[\u0000-\u001f\u{202E}]/u);
      expect(row.username).toBe("username");
      const b = await resolve(await sendTo({ bsuid: "LK.W2", name: sinhala }));
      expect((await contactRow(b.contactId)).profile_name).toBe(sinhala);
    });

    it("a name is never an identity: two different BSUIDs with the same name are two contacts", async () => {
      await tenant(t.db);
      const a = await resolve(await sendTo({ bsuid: "LK.X1", name: "Same Name" }));
      const b = await resolve(await sendTo({ bsuid: "LK.X2", name: "Same Name" }));
      expect(a.contactId).not.toBe(b.contactId);
    });

    it("an absent or empty profile never erases an existing name", async () => {
      await tenant(t.db);
      const a = await resolve(await sendTo({ bsuid: "LK.X3", name: "Kept" }), minutesAgo(20));
      await resolve(await sendTo({ bsuid: "LK.X3", name: "   " }), minutesAgo(10));
      await resolve(await sendTo({ bsuid: "LK.X3" }), minutesAgo(5));
      expect((await contactRow(a.contactId)).profile_name).toBe("Kept");
    });

    it("a delayed older event does not overwrite newer profile data, but still widens first_seen", async () => {
      await tenant(t.db);
      const t1 = minutesAgo(60);
      const t2 = minutesAgo(30);
      const t3 = minutesAgo(10);
      const first = await resolve(
        await sendTo({ bsuid: "LK.Y1", name: "Newest", username: "newest" }),
        t3,
      );
      await resolve(await sendTo({ bsuid: "LK.Y1", name: "Oldest", username: "oldest" }), t1);
      await resolve(await sendTo({ bsuid: "LK.Y1", name: "Middle", username: "middle" }), t2);
      const row = await contactRow(first.contactId);
      expect(row).toMatchObject({ profile_name: "Newest", username: "newest" });
      expect(row.first_seen_at).toEqual(t1);
      expect(row.last_seen_at).toEqual(t3);
      const alias = (await aliases())[0];
      expect(alias.first_seen_at).toEqual(t1);
      expect(alias.last_seen_at).toEqual(t3);
      expect(alias.last_seen_at.getTime()).toBeGreaterThanOrEqual(alias.first_seen_at.getTime());
    });

    it("a provider time in the far future is capped at receipt + 5 minutes", async () => {
      await tenant(t.db);
      const event = await sendTo({ bsuid: "LK.Y2", name: "Future" });
      const result = await resolve(event, new Date(Date.now() + 365 * 86_400_000));
      const row = await contactRow(result.contactId);
      expect(row.last_seen_at.getTime()).toBe(event.receivedAt.getTime() + 5 * 60_000);
    });
  });

  // ------------------------------------------------------------------------------------ alias ownership + inputs
  describe("alias ownership and input rules", () => {
    it("no sequence of resolutions ever re-points an alias to another contact", async () => {
      await tenant(t.db);
      await tenant(t.db, { pn: PN2, waba: WABA2 });
      const steps: SendOptions[] = [
        { bsuid: "LK.Z1", from: "15550101500" },
        { bsuid: "LK.Z2", from: "15550101500" },
        { from: "15550101500" },
        { bsuid: "LK.Z1", from: "15550101501" },
        { bsuid: "LK.Z2", from: "15550101501" },
        { bsuid: "LK.Z3" },
        { bsuid: "LK.Z3", from: "15550101500" },
        { from: "15550101502" },
        { bsuid: "LK.Z4", from: "15550101502" },
        { bsuid: "LK.Z1", from: "15550101502" },
        { pn: PN2, waba: WABA2, bsuid: "LK.Z1", from: "15550101500" },
      ];
      const owners: Record<string, string> = {};
      for (const step of steps) {
        // a phone-only message for a BSUID-established contact is refused by design; nothing may change either way
        await resolve(await sendTo(step)).catch((e) => {
          if (e?.code !== "phone_only_identity_ambiguous") throw e;
        });
        for (const [id, contactId] of Object.entries(await ownership())) {
          if (owners[id]) expect(contactId, `alias ${id} changed owner`).toBe(owners[id]);
          owners[id] = contactId;
        }
      }
      expect(Object.keys(owners).length).toBeGreaterThanOrEqual(5);
    });

    it("refuses to run outside a transaction, outside READ COMMITTED, for a non-message event, or without any sender identity", async () => {
      await tenant(t.db);
      const event = await sendTo({ bsuid: "LK.G1", from: "15550101600" });
      await expect(
        resolveInboundContact(t.db, event, { observedAt: minutesAgo(1) }),
      ).rejects.toThrow(/inside the worker's transaction/);

      await expect(
        t.db.transaction(async (tx) => {
          await tx.execute(sql.raw("set transaction isolation level repeatable read"));
          return resolveInboundContact(tx, event, { observedAt: minutesAgo(1) });
        }),
      ).rejects.toThrow(/READ COMMITTED/);

      await expect(resolve({ ...event, eventType: "STATUS" })).rejects.toMatchObject({
        code: "not_a_message_event",
      });
      await expect(resolve(event, new Date("nope"))).rejects.toMatchObject({
        code: "invalid_timestamp",
      });

      const noIdentity = await insertEvent(t.db, { payload: { v: 1, message: { id: "wamid.X" } } });
      await expect(
        resolve({ ...event, id: noIdentity.id, payload: noIdentity.payload }),
      ).rejects.toMatchObject({ code: "missing_sender_identity" });
      for (const payload of [null, { v: 1 }, { v: 1, message: 7 }])
        await expect(resolve({ ...event, payload })).rejects.toMatchObject({
          code: "invalid_event_payload",
        });
      await expect(
        resolve({ ...event, payload: { v: 1, message: { from_user_id: "x".repeat(300) } } }),
      ).rejects.toMatchObject({ code: "invalid_sender_identity" });
      expect(await contacts()).toHaveLength(0); // the refusals created nothing
    });

    it("ignores a contacts[] element that does not belong to this message (no enrichment, no wrong name)", async () => {
      await tenant(t.db);
      const stranger = {
        profile: { name: "Someone Else" },
        wa_id: "15550101700",
        user_id: "LK.OTHER",
      };
      const event = await sendTo({ bsuid: "LK.H1", from: "15550101701", contacts: [stranger] });
      const result = await resolve(event);
      expect((await contactRow(result.contactId)).profile_name).toBeNull();
      // and a hand-edited payload whose paired contact contradicts the message is ignored too
      const edited = await sendTo({ bsuid: "LK.H2", name: "Real Name" });
      const tampered = {
        ...(edited.payload as { contact: object }),
        contact: { ...(edited.payload as { contact: object }).contact, user_id: "LK.TAMPERED" },
      };
      const second = await resolve({ ...edited, payload: tampered });
      expect((await contactRow(second.contactId)).profile_name).toBeNull();
    });

    it("never reads identity-change fields: system messages are not MESSAGE events and are refused", async () => {
      await tenant(t.db);
      for (const name of [
        "system-user-changed-user-id.json",
        "system-user-changed-number-legacy.json",
      ]) {
        const events = await ingestFixture(t.db, name);
        expect(events.length).toBeGreaterThan(0);
        for (const e of events) {
          expect(e.eventType).toBe("OTHER");
          await expect(resolve(e)).rejects.toMatchObject({ code: "not_a_message_event" });
        }
      }
      expect(await contacts()).toHaveLength(0);
      expect(await aliases()).toHaveLength(0);
    });
  });
});
