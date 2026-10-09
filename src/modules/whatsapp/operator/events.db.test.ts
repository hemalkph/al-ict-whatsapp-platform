import { spawn } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import { ingestBytes } from "../identity/testing";
import { deliveryBytes } from "../inbound/testing";
import { insertEvent } from "../queue/testing";
import { REPO } from "../worker/testing";
import {
  activateAccount,
  disableAccount,
  registerAccount,
  enableAccount,
  archiveAccount,
} from "./accounts";
import { runAccountsCli, runEventsCli, runStatusCli } from "./cli";
import { deadSummary, inspectDead, listDead } from "./dead";
import { heldEventCounts, listHeldEvents, requeueRouted, requeueUnrouted } from "./events";
import { pipelineHealth } from "./health";

const PN_A = "100000000000001";
const WABA_A = "200000000000001";
const PN_B = "100000000000002";
const WABA_B = "200000000000002";
const SECRET_TEXT = "SECRET-STUDENT-MESSAGE-TEXT";
const ENABLED = { WHATSAPP_ALLOW_PII_REVEAL: "true" };

describe("operator: held and DEAD events, health", () => {
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
  async function org(slug: string) {
    const o = await seedOrg(t.db);
    await t.pool.query("update organizations set slug = $2 where id = $1", [o.id, slug]);
    return { ...o, slug };
  }
  async function account(slug: string, pn: string, waba: string, activate = true) {
    const r = await registerAccount(
      t.db,
      {
        organization: slug,
        wabaId: waba,
        phoneNumberId: pn,
        displayPhoneNumber: "+94 77 000 0001",
        portfolioConfirmed: true,
      },
      { apply: true },
    );
    if (!r.ok) throw new Error(JSON.stringify(r));
    if (activate) await activateAccount(t.db, r.account.id, { apply: true });
    return r.account;
  }
  const post = (o: { pn: string; waba: string; id: string; text?: string }) =>
    ingestBytes(
      t.db,
      deliveryBytes({
        id: o.id,
        bsuid: `LK.${o.id}`,
        pn: o.pn,
        waba: o.waba,
        message: { type: "text", text: { body: o.text ?? SECRET_TEXT } },
      }).bytes,
    );
  const ev = (wamid: string) =>
    rows("select * from webhook_events where provider_object_id = $1", [wamid]).then((r) => r[0]);
  const addDead = (
    reason: string,
    payload: unknown = {
      v: 1,
      field: "messages",
      message: { id: "wamid.D", type: "text", text: { body: SECRET_TEXT } },
    },
    extra: Partial<Parameters<typeof insertEvent>[1]> = {},
  ) => insertEvent(t.db, { status: "DEAD", lastError: reason, attempts: 1, payload, ...extra });

  // ----------------------------------------------------------------------- counts and listing
  describe("counts and listing", () => {
    it("groups held events by status, reason, routing and account, with the way each can be released", async () => {
      await org("alpha");
      const A = await account("alpha", PN_A, WABA_A, false);
      await post({ pn: PN_A, waba: WABA_A, id: "wamid.P1" });
      await post({ pn: "100000000000999", waba: WABA_A, id: "wamid.U1" });
      await ingestBytes(
        t.db,
        Buffer.from(
          JSON.stringify({
            object: "whatsapp_business_account",
            entry: [
              {
                id: WABA_A,
                changes: [
                  {
                    field: "messages",
                    value: {
                      metadata: { phone_number_id: PN_A },
                      statuses: [{ id: "wamid.S", status: "played", timestamp: "1790000000" }],
                    },
                  },
                ],
              },
            ],
          }),
        ),
      );
      const counts = await heldEventCounts(t.db);
      expect(counts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "UNROUTABLE",
            reason: "account_pending",
            routed: true,
            accountId: A.id,
            count: 1,
            releasePath: "activation_or_requeue_routed",
          }),
          expect.objectContaining({
            status: "UNROUTABLE",
            reason: "unknown_account",
            routed: false,
            accountId: null,
            count: 1,
            releasePath: "requeue_unrouted_single_event_explicit",
          }),
          expect.objectContaining({
            status: "IGNORED",
            reason: "status_not_mirrored",
            releasePath: "none",
          }),
        ]),
      );
    });

    it("lists ids, state and configuration ids but never a payload or message text", async () => {
      await org("alpha");
      await account("alpha", PN_A, WABA_A, false);
      await post({ pn: PN_A, waba: WABA_A, id: "wamid.P2" });
      const list = await listHeldEvents(t.db, { status: "UNROUTABLE", reason: "account_pending" });
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ phoneNumberId: PN_A, reason: "account_pending" });
      const text = JSON.stringify(list);
      for (const leak of [SECRET_TEXT, "payload", "15550100123"])
        expect(text, leak).not.toContain(leak);
      expect(await listHeldEvents(t.db, { limit: 0 })).toHaveLength(1); // limit is clamped to at least 1
    });
  });

  // ------------------------------------------------------------------------------ routed requeue
  describe("requeue-routed", () => {
    async function heldDisabled() {
      const a = await org("alpha");
      const A = await account("alpha", PN_A, WABA_A);
      await disableAccount(t.db, A.id, { apply: true });
      await post({ pn: PN_A, waba: WABA_A, id: "wamid.R1" });
      await post({ pn: PN_A, waba: WABA_A, id: "wamid.R2" });
      return { a, A };
    }

    it("is a dry run by default and reports how many events would be released", async () => {
      const { A } = await heldDisabled();
      await enableAccount(t.db, A.id, { apply: true });
      const r = await requeueRouted(t.db, {
        accountId: A.id,
        reason: "account_disabled",
        apply: false,
      });
      expect(r).toMatchObject({ ok: true, applied: false, wouldRequeueOrRequeued: 2 });
      expect(await ev("wamid.R1")).toMatchObject({
        status: "IGNORED",
        last_error: "account_disabled",
      });
    });

    it("applying needs --expect, refuses a stale expectation without changing anything, and releases exactly the previewed events", async () => {
      const { A, a } = await heldDisabled();
      await enableAccount(t.db, A.id, { apply: true });
      expect(
        await requeueRouted(t.db, { accountId: A.id, reason: "account_disabled", apply: true }),
      ).toMatchObject({ refused: "expectation_required" });
      expect(
        await requeueRouted(t.db, {
          accountId: A.id,
          reason: "account_disabled",
          apply: true,
          expect: 5,
        }),
      ).toMatchObject({ refused: "expectation_mismatch" });
      expect(await ev("wamid.R1")).toMatchObject({ status: "IGNORED" });
      const done = await requeueRouted(t.db, {
        accountId: A.id,
        reason: "account_disabled",
        apply: true,
        expect: 2,
      });
      expect(done).toMatchObject({ ok: true, applied: true, wouldRequeueOrRequeued: 2 });
      expect(await ev("wamid.R1")).toMatchObject({
        status: "PENDING",
        attempts: 0,
        organization_id: a.id,
        whatsapp_account_id: A.id,
        last_error: null,
      });
      expect(logs.join("\n")).toContain("operator.events_requeued");
    });

    it("refuses while the account is not ACTIVE, and archived accounts' history is never released", async () => {
      const { A } = await heldDisabled();
      expect(
        await requeueRouted(t.db, { accountId: A.id, reason: "account_disabled", apply: false }),
      ).toMatchObject({ skipped: "account_not_active", wouldRequeueOrRequeued: 0 });
      await archiveAccount(t.db, A.id, { apply: true });
      expect(
        await requeueRouted(t.db, {
          accountId: A.id,
          reason: "account_disabled",
          apply: true,
          expect: 0,
        }),
      ).toMatchObject({ skipped: "account_not_active", wouldRequeueOrRequeued: 0 });
      expect(await ev("wamid.R1")).toMatchObject({ status: "IGNORED" });
    });

    it("never releases another account's or another organization's events, and refuses unrouted reasons and bad input", async () => {
      await org("alpha");
      await org("beta");
      const A = await account("alpha", PN_A, WABA_A);
      const B = await account("beta", PN_B, WABA_B);
      await disableAccount(t.db, A.id, { apply: true });
      await disableAccount(t.db, B.id, { apply: true });
      await post({ pn: PN_A, waba: WABA_A, id: "wamid.XA" });
      await post({ pn: PN_B, waba: WABA_B, id: "wamid.XB" });
      await enableAccount(t.db, A.id, { apply: true });
      await enableAccount(t.db, B.id, { apply: true });
      const r = await requeueRouted(t.db, {
        accountId: A.id,
        reason: "account_disabled",
        apply: true,
        expect: 1,
      });
      expect(r).toMatchObject({ wouldRequeueOrRequeued: 1 });
      expect(await ev("wamid.XA")).toMatchObject({ status: "PENDING" });
      expect(await ev("wamid.XB")).toMatchObject({
        status: "IGNORED",
        last_error: "account_disabled",
      });
      expect(
        await requeueRouted(t.db, { accountId: A.id, reason: "unknown_account", apply: false }),
      ).toMatchObject({ refused: "reason_not_routed" });
      expect(
        await requeueRouted(t.db, { accountId: "x", reason: "account_disabled", apply: false }),
      ).toMatchObject({ refused: "invalid_input" });
      expect(
        await requeueRouted(t.db, {
          accountId: A.id,
          reason: "account_disabled",
          maxAgeDays: 0,
          apply: false,
        }),
      ).toMatchObject({ refused: "invalid_input" });
      expect(
        await requeueRouted(t.db, {
          accountId: A.id,
          reason: "account_disabled",
          maxAgeDays: 400,
          apply: false,
        }),
      ).toMatchObject({ refused: "invalid_input" });
    });

    it("honours the age window: older events are kept, a wider explicit window releases them", async () => {
      const { A } = await heldDisabled();
      await t.pool.query(
        "update webhook_events set received_at = now() - interval '45 days' where provider_object_id = 'wamid.R2'",
      );
      await enableAccount(t.db, A.id, { apply: true });
      expect(
        await requeueRouted(t.db, { accountId: A.id, reason: "account_disabled", apply: false }),
      ).toMatchObject({ wouldRequeueOrRequeued: 1 });
      expect(
        await requeueRouted(t.db, {
          accountId: A.id,
          reason: "account_disabled",
          maxAgeDays: 60,
          apply: false,
        }),
      ).toMatchObject({ wouldRequeueOrRequeued: 2 });
    });

    it("two operators applying the same release concurrently: exactly one releases it", async () => {
      const { A } = await heldDisabled();
      await enableAccount(t.db, A.id, { apply: true });
      const results = await Promise.all([
        requeueRouted(t.db, {
          accountId: A.id,
          reason: "account_disabled",
          apply: true,
          expect: 2,
        }),
        requeueRouted(t.db, {
          accountId: A.id,
          reason: "account_disabled",
          apply: true,
          expect: 2,
        }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ refused: "expectation_mismatch" });
    });
  });

  // ---------------------------------------------------------------------------- unrouted single event
  describe("requeue-unrouted", () => {
    it("an unknown-account event is never released by registering or activating the account; one explicit, approved command routes it", async () => {
      const a = await org("alpha");
      await post({ pn: PN_A, waba: WABA_A, id: "wamid.UN" });
      const A = await account("alpha", PN_A, WABA_A); // registered AND activated afterwards
      expect(await ev("wamid.UN")).toMatchObject({
        status: "UNROUTABLE",
        last_error: "unknown_account",
        organization_id: null,
      });
      const id = (await ev("wamid.UN")).id;

      const dry = await requeueUnrouted(t.db, { eventId: id, accountId: A.id, apply: false });
      expect(dry).toMatchObject({
        ok: true,
        applied: false,
        review: {
          eventReason: "unknown_account",
          targetOrganization: "alpha",
          eventPhoneNumberId: PN_A,
          targetPhoneNumberId: PN_A,
        },
      });
      expect(await ev("wamid.UN")).toMatchObject({ organization_id: null });
      expect(
        await requeueUnrouted(t.db, { eventId: id, accountId: A.id, apply: true }),
      ).toMatchObject({ refused: "approval_required" });
      expect(await ev("wamid.UN")).toMatchObject({ organization_id: null });

      const done = await requeueUnrouted(t.db, {
        eventId: id,
        accountId: A.id,
        apply: true,
        approveOwnership: true,
      });
      expect(done).toMatchObject({ ok: true, applied: true });
      expect(await ev("wamid.UN")).toMatchObject({
        status: "PENDING",
        attempts: 0,
        organization_id: a.id,
        whatsapp_account_id: A.id,
      });
      // an event that already has an owner can never be moved again
      expect(
        await requeueUnrouted(t.db, {
          eventId: id,
          accountId: A.id,
          apply: true,
          approveOwnership: true,
        }),
      ).toMatchObject({ ok: false, refused: "event_not_unrouted" });
    });

    it("never routes an event to an account with another phone number, nor to another organization's account", async () => {
      await org("alpha");
      await org("beta");
      const A = await account("alpha", PN_A, WABA_A);
      await account("beta", PN_B, WABA_B);
      await post({ pn: "100000000000999", waba: WABA_A, id: "wamid.FOREIGN" });
      const id = (await ev("wamid.FOREIGN")).id;
      for (const target of [
        A.id,
        (await rows("select id from whatsapp_accounts where phone_number_id = $1", [PN_B]))[0].id,
      ])
        expect(
          await requeueUnrouted(t.db, {
            eventId: id,
            accountId: target,
            apply: true,
            approveOwnership: true,
          }),
        ).toMatchObject({ ok: false, refused: "phone_number_mismatch" });
      expect(await ev("wamid.FOREIGN")).toMatchObject({
        status: "UNROUTABLE",
        organization_id: null,
      });
    });

    it("a WABA-mismatch event needs an explicit review flag, and is still refused while the WABAs differ", async () => {
      await org("alpha");
      const A = await account("alpha", PN_A, WABA_A);
      await post({ pn: PN_A, waba: "299999999999999", id: "wamid.WM" });
      const id = (await ev("wamid.WM")).id;
      expect(await ev("wamid.WM")).toMatchObject({ last_error: "waba_mismatch" });
      expect(
        await requeueUnrouted(t.db, {
          eventId: id,
          accountId: A.id,
          apply: true,
          approveOwnership: true,
        }),
      ).toMatchObject({ refused: "waba_review_required" });
      expect(
        await requeueUnrouted(t.db, {
          eventId: id,
          accountId: A.id,
          apply: true,
          approveOwnership: true,
          reviewedWabaMismatch: true,
        }),
      ).toMatchObject({ ok: false, refused: "waba_mismatch" });
      expect(await ev("wamid.WM")).toMatchObject({ status: "UNROUTABLE", organization_id: null });
    });

    it("refuses events too old for the confirmed window and inactive targets", async () => {
      await org("alpha");
      const A = await account("alpha", PN_A, WABA_A, false);
      await post({ pn: "100000000000999", waba: WABA_A, id: "wamid.OLD" });
      const id = (await ev("wamid.OLD")).id;
      expect(
        await requeueUnrouted(t.db, { eventId: id, accountId: A.id, apply: false }),
      ).toMatchObject({ refused: "account_not_active" });
      await activateAccount(t.db, A.id, { apply: true });
      expect(
        await requeueUnrouted(t.db, { eventId: id, accountId: A.id, apply: false }),
      ).toMatchObject({ refused: "phone_number_mismatch" });
      await t.pool.query(
        "update webhook_events set payload = jsonb_set(payload, '{metadata,phone_number_id}', to_jsonb($1::text)), received_at = now() - interval '40 days' where id = $2",
        [PN_A, id],
      );
      expect(
        await requeueUnrouted(t.db, { eventId: id, accountId: A.id, apply: false }),
      ).toMatchObject({ refused: "event_too_old" });
      expect(
        await requeueUnrouted(t.db, { eventId: id, accountId: A.id, apply: false, maxAgeDays: 60 }),
      ).toMatchObject({ ok: true });
    });
  });

  // ------------------------------------------------------------------------------------- DEAD events
  describe("DEAD event review", () => {
    it("summarizes by reason and category and lists without payloads", async () => {
      await addDead("invalid_timestamp");
      await addDead("invalid_timestamp");
      await addDead("max_attempts_exhausted");
      await addDead("phone_only_identity_ambiguous");
      await addDead("account_missing");
      await addDead("some_new_code");
      const summary = await deadSummary(t.db);
      expect(summary.map((s) => [s.reason, s.category, s.count])).toEqual(
        expect.arrayContaining([
          ["invalid_timestamp", "invalid_provider_payload", 2],
          ["max_attempts_exhausted", "retries_exhausted", 1],
          ["phone_only_identity_ambiguous", "ambiguous_identity", 1],
          ["account_missing", "routing_inconsistent", 1],
          ["some_new_code", "permanent_failure", 1],
        ]),
      );
      const list = await listDead(t.db, { reason: "invalid_timestamp" });
      expect(list).toHaveLength(2);
      expect(JSON.stringify(list)).not.toContain(SECRET_TEXT);
    });

    it("inspect hides the payload by default, shows a content-free description, and cannot replay", async () => {
      const e = await addDead("phone_only_identity_ambiguous");
      const r = await inspectDead(t.db, e.id);
      expect(r).toMatchObject({
        ok: true,
        event: {
          category: "ambiguous_identity",
          field: "messages",
          messageType: "text",
          statusWord: null,
        },
      });
      const text = JSON.stringify(r);
      expect(text).not.toContain(SECRET_TEXT);
      expect(text).toContain("hidden");
      expect(text).toMatch(/Replay is not available/);
      expect(logs.join("\n")).not.toContain("payload_revealed");
    });

    it("revealing the payload is explicit, labelled as personal data, and logged without the content", async () => {
      const e = await addDead("invalid_timestamp");
      const r = await inspectDead(t.db, e.id, { revealPayload: true, env: ENABLED });
      expect(JSON.stringify(r)).toContain(SECRET_TEXT);
      expect(JSON.stringify(r)).toContain("UNAPPROVED FOR REAL CUSTOMER DATA");
      const logged = logs.join("\n");
      expect(logged).toContain("operator.payload_revealed");
      expect(logged).not.toContain(SECRET_TEXT);
    });

    it.each([undefined, "", "false", "FALSE", "TRUE", "1", "yes", " true", "true "])(
      "reveal is REFUSED when WHATSAPP_ALLOW_PII_REVEAL is %j: no payload, no value in the output or the log",
      async (value) => {
        const e = await addDead("invalid_timestamp");
        const env = value === undefined ? {} : { WHATSAPP_ALLOW_PII_REVEAL: value };
        const r = await inspectDead(t.db, e.id, { revealPayload: true, env });
        expect(r).toMatchObject({ ok: false, refused: "pii_reveal_disabled" });
        const text = JSON.stringify(r);
        expect(text).not.toContain(SECRET_TEXT);
        expect(text).toContain("WHATSAPP_ALLOW_PII_REVEAL=true"); // names the setting, never a value
        if (value) expect(text).not.toContain(`"${value}"`);
        const logged = logs.join("\n");
        expect(logged).toContain("operator.payload_reveal_refused");
        expect(logged).not.toContain("operator.payload_revealed");
        expect(logged).not.toContain(SECRET_TEXT);
      },
    );

    it("the refusal is decided before the database is read: even a non-existent event gets the same refusal", async () => {
      const r = await inspectDead(t.db, "00000000-0000-4000-8000-000000000000", {
        revealPayload: true,
        env: {},
      });
      expect(r).toMatchObject({ refused: "pii_reveal_disabled" });
    });

    it("without --reveal-payload inspection works whether or not the opt-in is set (and shows no content)", async () => {
      const e = await addDead("phone_only_identity_ambiguous");
      for (const env of [{}, ENABLED, { WHATSAPP_ALLOW_PII_REVEAL: "false" }]) {
        const r = await inspectDead(t.db, e.id, { env });
        expect(r).toMatchObject({ ok: true, event: { category: "ambiguous_identity" } });
        expect(JSON.stringify(r)).not.toContain(SECRET_TEXT);
      }
    });

    it("only DEAD events can be inspected, and nothing here changes any event", async () => {
      const pending = await insertEvent(t.db, { status: "PENDING" });
      expect(await inspectDead(t.db, pending.id)).toMatchObject({
        ok: false,
        refused: "event_not_dead",
      });
      expect(await inspectDead(t.db, "00000000-0000-4000-8000-000000000000")).toMatchObject({
        refused: "event_not_found",
      });
      const e = await addDead("invalid_timestamp");
      const before = await rows("select * from webhook_events order by id");
      await deadSummary(t.db);
      await listDead(t.db);
      await inspectDead(t.db, e.id, { revealPayload: true, env: ENABLED });
      expect(await rows("select * from webhook_events order by id")).toEqual(before);
    });
  });

  // ------------------------------------------------------------------------------------------- health
  describe("pipeline health", () => {
    it("an empty system has no findings", async () => {
      const h = await pipelineHealth(t.db);
      expect(h.findings).toEqual([]);
      expect(h.needsAttention).toBe(false);
    });

    it("reports expired leases, a queue that is not draining, DEAD and unrouted events", async () => {
      await org("alpha");
      await account("alpha", PN_A, WABA_A);
      const m = await post({ pn: PN_A, waba: WABA_A, id: "wamid.H1" });
      await t.pool.query(
        "update webhook_events set next_attempt_at = now() - interval '10 minutes' where id = $1",
        [m[0]!.id],
      );
      await insertEvent(t.db, { status: "PROCESSING", attempts: 1 }).then((e) =>
        t.pool.query(
          "update webhook_events set locked_at = now() - interval '1 day', locked_by = 'gone' where id = $1",
          [e.id],
        ),
      );
      await addDead("invalid_timestamp");
      await post({ pn: "100000000000999", waba: WABA_A, id: "wamid.H2" });
      const h = await pipelineHealth(t.db);
      const codes = h.findings.map((f) => f.code);
      expect(codes).toEqual(
        expect.arrayContaining([
          "expired_leases",
          "queue_not_draining",
          "dead_events",
          "unrouted_events_need_review",
        ]),
      );
      expect(h.needsAttention).toBe(true);
      expect(h.queue.expiredLeases).toBe(1);
      expect(JSON.stringify(h)).not.toContain(SECRET_TEXT);
    });

    it("a queue that is draining is not reported as stuck", async () => {
      await org("alpha");
      await account("alpha", PN_A, WABA_A);
      const m = await post({ pn: PN_A, waba: WABA_A, id: "wamid.H3" });
      await t.pool.query(
        "update webhook_events set next_attempt_at = now() - interval '10 minutes' where id = $1",
        [m[0]!.id],
      );
      await insertEvent(t.db, { status: "PROCESSED" }).then((e) =>
        t.pool.query("update webhook_events set processed_at = now() where id = $1", [e.id]),
      );
      expect((await pipelineHealth(t.db)).findings.map((f) => f.code)).not.toContain(
        "queue_not_draining",
      );
    });

    it("PENDING media attachments and unclaimable event types are informational, never failures", async () => {
      await org("alpha");
      await account("alpha", PN_A, WABA_A);
      const seeded = await post({ pn: PN_A, waba: WABA_A, id: "wamid.H4" });
      expect(seeded).toHaveLength(1);
      await insertEvent(t.db, {
        status: "PENDING",
        eventType: "IDENTITY",
        organizationId: (await rows("select organization_id o from whatsapp_accounts"))[0].o,
        whatsappAccountId: (await rows("select id from whatsapp_accounts"))[0].id,
      });
      await t.pool.query(
        "update webhook_events set received_at = now() - interval '2 days', next_attempt_at = now() - interval '2 days' where event_type = 'IDENTITY'",
      );
      const h = await pipelineHealth(t.db);
      const identity = h.findings.find((f) => f.code === "unclaimable_events_waiting");
      expect(identity).toMatchObject({ severity: "info" });
      expect(h.findings.map((f) => f.code)).not.toContain("queue_not_draining"); // an IDENTITY event is not "due work"
      expect(h.attachments.note).toMatch(/not a failed job/);
      expect(h.needsAttention).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------------------------- CLI
  describe("command line", () => {
    const capture = () => {
      const out: unknown[] = [];
      return { out, fn: (v: unknown) => void out.push(v) };
    };

    it("prints usage and exits 2 for unknown commands and options without touching the database", async () => {
      for (const run of [runAccountsCli, runEventsCli]) {
        for (const argv of [[], ["bogus"], ["list", "--nope"]]) {
          const c = capture();
          expect(
            await run(
              argv,
              new Proxy(
                {},
                {
                  get() {
                    throw new Error("db touched");
                  },
                },
              ) as never,
              c.fn,
            ),
            JSON.stringify(argv),
          ).toBe(2);
          expect(c.out[0]).toMatchObject({ ok: false, usage: expect.any(Array) });
        }
      }
    });

    it("walks the onboarding flow: register (dry run), register, activate, inspect, list, status", async () => {
      await org("alpha");
      const args = [
        "register",
        "--organization",
        "alpha",
        "--waba-id",
        WABA_A,
        "--phone-number-id",
        PN_A,
        "--display-phone-number",
        "+94 77 000 0001",
      ];
      let c = capture();
      expect(await runAccountsCli(args, t.db, c.fn)).toBe(1); // no portfolio confirmation
      expect(c.out[0]).toMatchObject({ ok: false, refused: "portfolio_not_confirmed" });
      c = capture();
      expect(await runAccountsCli([...args, "--confirm-single-portfolio"], t.db, c.fn)).toBe(0);
      expect(c.out[0]).toMatchObject({
        ok: true,
        applied: false,
        dryRun: true,
        next: expect.stringContaining("--apply"),
      });
      expect((await rows("select count(*)::int n from whatsapp_accounts"))[0].n).toBe(0);
      c = capture();
      expect(
        await runAccountsCli([...args, "--confirm-single-portfolio", "--apply"], t.db, c.fn),
      ).toBe(0);
      const id = (c.out[0] as { account: { id: string } }).account.id;
      c = capture();
      expect(await runAccountsCli(["activate", id, "--apply"], t.db, c.fn)).toBe(0);
      expect(c.out[0]).toMatchObject({ ok: true, account: { status: "ACTIVE" } });
      c = capture();
      expect(await runAccountsCli(["activate", id, "--apply"], t.db, c.fn)).toBe(1);
      c = capture();
      expect(await runAccountsCli(["list"], t.db, c.fn)).toBe(0);
      c = capture();
      expect(await runEventsCli(["counts"], t.db, c.fn)).toBe(0);
      c = capture();
      expect(await runEventsCli(["dead", "summary"], t.db, c.fn)).toBe(0);
      c = capture();
      expect(await runStatusCli([], t.db, c.fn)).toBe(0);
      expect(c.out[0]).toMatchObject({ ok: true, needsAttention: false });
      c = capture();
      expect(await runStatusCli(["--bogus"], t.db, c.fn)).toBe(2);
    });

    it("status --check exits 1 when something needs attention", async () => {
      await addDead("invalid_timestamp");
      const c = capture();
      expect(await runStatusCli(["--check"], t.db, c.fn)).toBe(1);
      expect(c.out[0]).toMatchObject({ needsAttention: true });
    });

    it("the real scripts run end to end (child process, JSON on stdout, exit code)", async () => {
      await org("alpha");
      const run = (script: string, args: string[]) =>
        new Promise<{ code: number | null; stdout: string }>((resolve) => {
          const child = spawn(process.execPath, ["--import", "tsx", `scripts/${script}`, ...args], {
            cwd: REPO,
            env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", DATABASE_URL: t.url },
          });
          let stdout = "";
          child.stdout.on("data", (d) => (stdout += d));
          child.on("exit", (code) => resolve({ code, stdout }));
        });
      const list = await run("whatsapp-accounts.ts", ["list"]);
      expect(list.code).toBe(0);
      expect(JSON.parse(list.stdout)).toEqual({ ok: true, accounts: [] });
      const status = await run("whatsapp-status.ts", []);
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, findings: [] });
      const usage = await run("whatsapp-events.ts", ["nonsense"]);
      expect(usage.code).toBe(2);
    }, 60_000);
  });
});
