import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import { ingestBytes } from "../identity/testing";
import { deliveryBytes } from "../inbound/testing";
import {
  activateAccount,
  archiveAccount,
  disableAccount,
  enableAccount,
  inspectAccount,
  listAccounts,
  registerAccount,
} from "./accounts";

// Operator account management on REAL PostgreSQL: registration rules, ownership immutability, the state machine and the
// activation requeue (only account_pending, only this account, only 30 days).

const PN_A = "100000000000001";
const WABA_A = "200000000000001";
const PN_B = "100000000000002";
const PN_C = "100000000000003";
const WABA_B = "200000000000002";

describe("operator: WhatsApp accounts", () => {
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
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation((line: unknown) => void logs.push(String(line)));
    await t.pool.query(
      "truncate webhook_events, webhook_requests, whatsapp_accounts, organizations cascade",
    );
  });
  afterEach(() => vi.restoreAllMocks());

  const rows = async (q: string, p: unknown[] = []) => (await t.pool.query(q, p)).rows;
  const base = (org: string, over: Record<string, unknown> = {}) => ({
    organization: org,
    wabaId: WABA_A,
    phoneNumberId: PN_A,
    displayPhoneNumber: "+94 77 000 0001",
    portfolioConfirmed: true,
    ...over,
  });
  const register = (input: unknown, apply = true) => registerAccount(t.db, input, { apply });
  const ok = async <T extends { ok: boolean }>(p: Promise<T>) => {
    const r = await p;
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    return r as Extract<T, { ok: true }>;
  };
  async function org(slug: string) {
    const o = await seedOrg(t.db);
    await t.pool.query("update organizations set slug = $2 where id = $1", [o.id, slug]);
    return { ...o, slug };
  }
  const post = (o: { pn: string; waba: string; id: string }) =>
    ingestBytes(
      t.db,
      deliveryBytes({ id: o.id, bsuid: `LK.${o.id}`, pn: o.pn, waba: o.waba }).bytes,
    );
  const ev = (wamid: string) =>
    rows("select * from webhook_events where provider_object_id = $1", [wamid]).then((r) => r[0]);

  // --------------------------------------------------------------------------------------- registration
  describe("register", () => {
    it("is a dry run by default: validated, previewed, nothing written", async () => {
      await org("alpha");
      const r = await register(base("alpha"), false);
      expect(r).toMatchObject({
        ok: true,
        applied: false,
        account: { status: "PENDING", organizationSlug: "alpha" },
      });
      expect((await rows("select count(*)::int n from whatsapp_accounts"))[0].n).toBe(0);
    });

    it("creates a PENDING account for the named organization (by slug or by id), with a credential NAME only", async () => {
      const a = await org("alpha");
      const r = await ok(
        register(base("alpha", { credentialRef: "WHATSAPP_TOKEN_ALPHA", verifiedName: "A/L ICT" })),
      );
      expect(r.account).toMatchObject({
        status: "PENDING",
        organizationId: a.id,
        credentialRef: "WHATSAPP_TOKEN_ALPHA",
        archivedAt: null,
      });
      const second = await ok(register(base(a.id, { wabaId: WABA_A, phoneNumberId: PN_B })));
      expect(second.otherWabasOfOrganization).toEqual([WABA_A]);
      expect(second.account.organizationId).toBe(a.id);
      expect(logs.join("\n")).toContain("operator.account_registered");
    });

    it("requires the explicit single-portfolio confirmation", async () => {
      await org("alpha");
      for (const portfolioConfirmed of [undefined, false, "yes"]) {
        const r = await register(base("alpha", { portfolioConfirmed }));
        expect(r).toMatchObject({
          ok: false,
          refused: expect.stringMatching(/portfolio_not_confirmed|invalid_input/),
        });
      }
      expect((await rows("select count(*)::int n from whatsapp_accounts"))[0].n).toBe(0);
    });

    it.each([
      ["waba not numeric", { wabaId: "abc123" }],
      ["phone id too short", { phoneNumberId: "123" }],
      ["a credential that looks like a token", { credentialRef: "EAAGm0PX4ZCpsBAKd9" }],
      ["a lower-case or long secret value", { credentialRef: "EAAB" + "x".repeat(150) }],
      ["a credential with spaces", { credentialRef: "MY TOKEN" }],
      ["control characters in the display number", { displayPhoneNumber: "+94\u0000 77" }],
      ["an unknown field", { organizationId: "x" }],
      ["a token smuggled as a field", { accessToken: "EAAG" }],
    ])("rejects %s and writes nothing", async (_n, over) => {
      await org("alpha");
      const r = await register(base("alpha", over));
      expect(r).toMatchObject({ ok: false, refused: "invalid_input" });
      expect((await rows("select count(*)::int n from whatsapp_accounts"))[0].n).toBe(0);
    });

    it("refuses an unknown or archived organization", async () => {
      expect(await register(base("nobody"))).toMatchObject({ refused: "organization_not_found" });
      const a = await org("alpha");
      await t.pool.query("update organizations set archived_at = now() where id = $1", [a.id]);
      expect(await register(base("alpha"))).toMatchObject({ refused: "organization_archived" });
    });

    it("never assigns a phone_number_id twice: same organization or another, the second registration is refused and the first is untouched", async () => {
      const a = await org("alpha");
      await org("beta");
      await ok(register(base("alpha")));
      const same = await register(base("alpha", { displayPhoneNumber: "changed" }));
      expect(same).toMatchObject({
        ok: false,
        refused: "phone_number_id_in_use",
        detail: expect.stringContaining("this organization"),
      });
      const other = await register(base("beta", { wabaId: WABA_B }));
      expect(other).toMatchObject({
        ok: false,
        refused: "phone_number_id_in_use",
        detail: expect.stringContaining("ANOTHER"),
      });
      const [row] = await rows("select * from whatsapp_accounts");
      expect(row).toMatchObject({ organization_id: a.id, display_phone_number: "+94 77 000 0001" });
    });

    it("never lets two organizations share a WABA; one organization may have several numbers on one", async () => {
      const a = await org("alpha");
      await org("beta");
      await ok(register(base("alpha")));
      await ok(register(base("alpha", { phoneNumberId: PN_B }))); // same org, same WABA: fine
      const r = await register(base("beta", { phoneNumberId: PN_C })); // same WABA, other org
      expect(r).toMatchObject({ ok: false, refused: "waba_owned_by_other_organization" });
      expect(
        (
          await rows("select count(*)::int n from whatsapp_accounts where organization_id = $1", [
            a.id,
          ])
        )[0].n,
      ).toBe(2);
    });

    it("reports events that arrived for this phone number before it was registered, and does NOT release them", async () => {
      await org("alpha");
      const [e] = await post({ pn: PN_A, waba: WABA_A, id: "wamid.EARLY" });
      expect(await ev("wamid.EARLY")).toMatchObject({
        status: "UNROUTABLE",
        last_error: "unknown_account",
        organization_id: null,
      });
      const r = await ok(register(base("alpha")));
      expect(r.unroutedEventsAwaitingReview).toBe(1);
      expect(await ev("wamid.EARLY")).toMatchObject({
        status: "UNROUTABLE",
        last_error: "unknown_account",
        organization_id: null,
        whatsapp_account_id: null,
      });
      expect(e).toBeDefined();
    });

    it("races: two organizations registering the same phone number, or the same WABA with different numbers, produce exactly one winner", async () => {
      await org("alpha");
      await org("beta");
      for (let round = 0; round < 4; round++) {
        const pn = `3000000000${round}0`;
        const phoneRace = await Promise.all([
          register(base("alpha", { phoneNumberId: pn, wabaId: `40000000${round}01` })),
          register(base("beta", { phoneNumberId: pn, wabaId: `40000000${round}02` })),
        ]);
        expect(
          phoneRace.filter((r) => r.ok),
          `phone round ${round}`,
        ).toHaveLength(1);
        const waba = `5000000${round}0001`;
        const wabaRace = await Promise.all([
          register(base("alpha", { phoneNumberId: `600000000${round}01`, wabaId: waba })),
          register(base("beta", { phoneNumberId: `600000000${round}02`, wabaId: waba })),
        ]);
        expect(
          wabaRace.filter((r) => r.ok),
          `waba round ${round}`,
        ).toHaveLength(1);
        expect(wabaRace.find((r) => !r.ok)).toMatchObject({
          refused: "waba_owned_by_other_organization",
        });
      }
      const owners = await rows(
        "select waba_id, count(distinct organization_id)::int n from whatsapp_accounts group by waba_id",
      );
      expect(owners.every((o) => o.n === 1)).toBe(true);
    });
  });

  // ------------------------------------------------------------------------------------- state machine
  describe("activate / enable / disable / archive", () => {
    it("activation is a dry run by default and then moves PENDING to ACTIVE", async () => {
      await org("alpha");
      const { account } = await ok(register(base("alpha")));
      const dry = await ok(activateAccount(t.db, account.id, { apply: false }));
      expect(dry.applied).toBe(false);
      expect((await rows("select status from whatsapp_accounts"))[0].status).toBe("PENDING");
      const real = await ok(activateAccount(t.db, account.id, { apply: true }));
      expect(real).toMatchObject({ applied: true, from: "PENDING", account: { status: "ACTIVE" } });
      expect(logs.join("\n")).toContain("operator.account_activated");
    });

    it("allows only the legal transitions; archived accounts never change", async () => {
      await org("alpha");
      const { account } = await ok(register(base("alpha")));
      const id = account.id;
      expect(await enableAccount(t.db, id, { apply: true })).toMatchObject({
        refused: "invalid_state",
      }); // PENDING cannot be enabled
      await ok(activateAccount(t.db, id, { apply: true }));
      expect(await activateAccount(t.db, id, { apply: true })).toMatchObject({
        refused: "invalid_state",
      });
      await ok(disableAccount(t.db, id, { apply: true }));
      expect(await disableAccount(t.db, id, { apply: true })).toMatchObject({
        refused: "invalid_state",
      });
      expect(await activateAccount(t.db, id, { apply: true })).toMatchObject({
        refused: "invalid_state",
      });
      await ok(enableAccount(t.db, id, { apply: true }));
      const archived = await ok(archiveAccount(t.db, id, { apply: true }));
      expect(archived.account).toMatchObject({ status: "DISABLED" });
      expect(archived.account.archivedAt).not.toBeNull();
      for (const fn of [activateAccount, enableAccount, disableAccount, archiveAccount])
        expect(await fn(t.db, id, { apply: true }), fn.name).toMatchObject({
          refused: "account_archived",
        });
      expect(await activateAccount(t.db, "not-a-uuid", { apply: true })).toMatchObject({
        refused: "invalid_input",
      });
      expect(
        await activateAccount(t.db, "00000000-0000-4000-8000-000000000000", { apply: true }),
      ).toMatchObject({ refused: "account_not_found" });
    });

    it("organization, phone_number_id, WABA and credential never change through any transition", async () => {
      await org("alpha");
      const { account } = await ok(register(base("alpha", { credentialRef: "TOKEN_ALPHA" })));
      const before = (
        await rows(
          "select organization_id, waba_id, phone_number_id, credential_ref, display_phone_number, verified_name, created_at from whatsapp_accounts",
        )
      )[0];
      for (const fn of [activateAccount, disableAccount, enableAccount, archiveAccount])
        await fn(t.db, account.id, { apply: true });
      const after = (
        await rows(
          "select organization_id, waba_id, phone_number_id, credential_ref, display_phone_number, verified_name, created_at from whatsapp_accounts",
        )
      )[0];
      expect(after).toEqual(before);
    });

    it("refuses to activate when the organization is archived or the WABA is registered under another organization", async () => {
      const a = await org("alpha");
      const b = await org("beta");
      const { account } = await ok(register(base("alpha")));
      await t.pool.query("update organizations set archived_at = now() where id = $1", [a.id]);
      expect(await activateAccount(t.db, account.id, { apply: true })).toMatchObject({
        refused: "organization_archived",
      });
      await t.pool.query("update organizations set archived_at = null where id = $1", [a.id]);
      // a pre-existing conflict created behind the tool's back (the schema has no constraint for it)
      await t.pool.query(
        "insert into whatsapp_accounts (organization_id, waba_id, phone_number_id, display_phone_number, status) values ($1, $2, $3, 'x', 'PENDING')",
        [b.id, WABA_A, PN_C],
      );
      expect(await activateAccount(t.db, account.id, { apply: true })).toMatchObject({
        refused: "waba_owned_by_other_organization",
      });
      expect(
        (await rows("select status from whatsapp_accounts where id = $1", [account.id]))[0].status,
      ).toBe("PENDING");
    });

    it("two simultaneous activations: one transitions and releases, the other is refused", async () => {
      await org("alpha");
      const { account } = await ok(register(base("alpha")));
      await post({ pn: PN_A, waba: WABA_A, id: "wamid.RACE" });
      const results = await Promise.all([
        activateAccount(t.db, account.id, { apply: true }),
        activateAccount(t.db, account.id, { apply: true }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ refused: "invalid_state" });
      expect(await ev("wamid.RACE")).toMatchObject({ status: "PENDING", attempts: 0 });
    });
  });

  // ------------------------------------------------------------------------------- activation requeue
  describe("activation releases only what it should", () => {
    it("releases account_pending events routed to exactly this account (within 30 days) and nothing else", async () => {
      const a = await org("alpha");
      const b = await org("beta");
      const A = await ok(register(base("alpha")));
      const A2 = await ok(register(base("alpha", { phoneNumberId: PN_B }))); // same org, same WABA, another number
      const B = await ok(register(base("beta", { wabaId: WABA_B, phoneNumberId: PN_C })));
      // held while PENDING: routed to their own accounts
      await post({ pn: PN_A, waba: WABA_A, id: "wamid.A1" });
      await post({ pn: PN_A, waba: WABA_A, id: "wamid.A2" });
      await post({ pn: PN_A, waba: WABA_A, id: "wamid.A3" });
      await post({ pn: PN_B, waba: WABA_A, id: "wamid.A2ND" });
      await post({ pn: PN_C, waba: WABA_B, id: "wamid.B1" });
      // old: more than 30 days
      await t.pool.query(
        "update webhook_events set received_at = now() - interval '40 days' where provider_object_id = 'wamid.A3'",
      );
      // unknown account (no registered number), and a disabled-account history for A
      await post({ pn: "100000000000999", waba: WABA_A, id: "wamid.UNKNOWN" });
      await post({ pn: PN_A, waba: "299999999999999", id: "wamid.WABAMISMATCH" });
      await t.pool.query(
        "insert into webhook_events (request_id, organization_id, whatsapp_account_id, event_type, idempotency_key, payload, status, last_error) select request_id, organization_id, whatsapp_account_id, event_type, 'disabled-hist', payload, 'IGNORED', 'account_disabled' from webhook_events where provider_object_id is null or provider_object_id = 'wamid.A1' limit 1",
      );
      const before = await rows(
        "select id, organization_id, whatsapp_account_id, status, last_error from webhook_events order by id",
      );

      const r = await ok(activateAccount(t.db, A.account.id, { apply: true }));
      expect(r.released).toEqual({ requeued: 2, staleHeldLeft: 1, skipped: null });
      expect(r.unroutedEventsAwaitingReview).toBe(1); // the wamid.WABAMISMATCH event names this phone number
      expect(await ev("wamid.A1")).toMatchObject({
        status: "PENDING",
        attempts: 0,
        organization_id: a.id,
        whatsapp_account_id: A.account.id,
      });
      expect(await ev("wamid.A2")).toMatchObject({ status: "PENDING" });
      expect(await ev("wamid.A3")).toMatchObject({
        status: "UNROUTABLE",
        last_error: "account_pending",
      }); // too old: kept, not discarded
      expect(await ev("wamid.A2ND")).toMatchObject({
        status: "UNROUTABLE",
        whatsapp_account_id: A2.account.id,
      }); // another account, same org
      expect(await ev("wamid.B1")).toMatchObject({
        status: "UNROUTABLE",
        organization_id: b.id,
        whatsapp_account_id: B.account.id,
      });
      expect(await ev("wamid.UNKNOWN")).toMatchObject({
        status: "UNROUTABLE",
        last_error: "unknown_account",
        organization_id: null,
      });
      expect(await ev("wamid.WABAMISMATCH")).toMatchObject({
        status: "UNROUTABLE",
        last_error: "waba_mismatch",
        organization_id: null,
      });
      const after = await rows(
        "select id, organization_id, whatsapp_account_id, status, last_error from webhook_events order by id",
      );
      // routing columns of every event are exactly what they were
      expect(after.map((e) => [e.id, e.organization_id, e.whatsapp_account_id])).toEqual(
        before.map((e) => [e.id, e.organization_id, e.whatsapp_account_id]),
      );
      expect(
        (await rows("select status from webhook_events where last_error = 'account_disabled'"))[0]
          .status,
      ).toBe("IGNORED");
    });

    it("a dry-run activation reports what would be released and changes no event", async () => {
      await org("alpha");
      const A = await ok(register(base("alpha")));
      await post({ pn: PN_A, waba: WABA_A, id: "wamid.DRY" });
      const r = await ok(activateAccount(t.db, A.account.id, { apply: false }));
      expect(r.released).toMatchObject({ requeued: 1 });
      expect(await ev("wamid.DRY")).toMatchObject({
        status: "UNROUTABLE",
        last_error: "account_pending",
      });
    });

    it("enable (DISABLED to ACTIVE) releases nothing: disabled-account history needs an explicit command", async () => {
      await org("alpha");
      const A = await ok(register(base("alpha")));
      await ok(activateAccount(t.db, A.account.id, { apply: true }));
      await ok(disableAccount(t.db, A.account.id, { apply: true }));
      await post({ pn: PN_A, waba: WABA_A, id: "wamid.WHILEOFF" });
      expect(await ev("wamid.WHILEOFF")).toMatchObject({
        status: "IGNORED",
        last_error: "account_disabled",
      });
      const r = await ok(enableAccount(t.db, A.account.id, { apply: true }));
      expect(r.released).toBeNull();
      expect(await ev("wamid.WHILEOFF")).toMatchObject({
        status: "IGNORED",
        last_error: "account_disabled",
      });
    });
  });

  // --------------------------------------------------------------------------------------------- inspect
  describe("inspect and list", () => {
    it("lists every organization's accounts and inspects one with event counts, without any secret or payload", async () => {
      await org("alpha");
      await org("beta");
      const A = await ok(register(base("alpha", { credentialRef: "TOKEN_ALPHA" })));
      await ok(register(base("beta", { wabaId: WABA_B, phoneNumberId: PN_B })));
      await post({ pn: PN_A, waba: WABA_A, id: "wamid.INSPECT" });
      const list = await listAccounts(t.db);
      expect(list.map((a) => a.organizationSlug)).toEqual(["alpha", "beta"]);
      const view = await ok(inspectAccount(t.db, A.account.id));
      expect(view.events).toEqual([{ status: "UNROUTABLE", reason: "account_pending", count: 1 }]);
      expect(view.account.credentialRef).toBe("TOKEN_ALPHA");
      expect(view.credentialNote).toContain("never read or shown");
      const text = JSON.stringify(view);
      expect(text).not.toContain("hello wamid");
      expect(await inspectAccount(t.db, "nope")).toMatchObject({ refused: "invalid_input" });
    });
  });
});
