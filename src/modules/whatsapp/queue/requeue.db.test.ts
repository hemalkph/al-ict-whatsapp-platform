import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { schema } from "@/db";
import {
  UNIQUE_VIOLATION,
  FK_VIOLATION,
  createTestDatabase,
  expectPgError,
  seedOrg,
  type TestDb,
} from "@/db/__tests__/helpers";
import { phoneNumberIdOf, wabaIdOf } from "../envelope";
import { MAX_ATTEMPTS, REQUEUE_MAX_AGE_MS } from "./policy";
import { processWebhookBatch } from "./process";
import {
  AUTO_REQUEUE_REASONS,
  OPERATOR_ROUTED_REASONS,
  UNROUTED_REASONS,
  requeueOnAccountActivation,
  requeueRoutedHeldEvents,
  requeueUnroutedEvent,
  type RoutedRequeueReason,
} from "./requeue";
import { deferred, delivery, getEvent, ingest, insertEvent, message, until } from "./testing";

// Held-event release against REAL PostgreSQL. Held events come from the REAL ingest path wherever possible.
// Rule under test: tenant provenance is stronger than current phone-number ownership. An event never changes
// organization or account; an unrouted event acquires routing only through an explicit, verified operator decision.

const PN = "100000000000001";
const WABA = "200000000000001";
const PN_B = "100000000000002";
const WABA_B = "200000000000002";
const EPOCH = new Date(0);
void UNIQUE_VIOLATION;

describe("release of held webhook events", () => {
  let t: TestDb;
  let n = 0;
  const onTestEnd: Array<() => void> = [];
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    onTestEnd.splice(0).forEach((open) => open());
  });
  beforeEach(async () => {
    await t.pool.query(
      "truncate webhook_events, webhook_requests, whatsapp_accounts, organizations cascade",
    );
  });

  async function account(
    o: {
      pn?: string;
      waba?: string;
      status?: "PENDING" | "ACTIVE" | "DISABLED";
      archived?: boolean;
      organizationId?: string;
    } = {},
  ) {
    const organizationId = o.organizationId ?? (await seedOrg(t.db)).id;
    const [row] = await t.db
      .insert(schema.whatsappAccounts)
      .values({
        organizationId,
        wabaId: o.waba ?? WABA,
        phoneNumberId: o.pn ?? PN,
        displayPhoneNumber: "15550100001",
        status: o.status ?? "ACTIVE",
        archivedAt: o.archived ? new Date() : null,
      })
      .returning();
    return row!;
  }
  const receive = async (pn = PN, waba = WABA) => {
    await ingest(t.db, delivery({ waba, pn, messages: [message(`wamid.TEST${++n}`)] }));
    const r = await t.pool.query<{ id: string }>(
      "select id from webhook_events order by created_at desc, id desc limit 1",
    );
    return r.rows[0]!.id;
  };
  const setAccount = (id: string, set: Partial<typeof schema.whatsappAccounts.$inferInsert>) =>
    t.db.update(schema.whatsappAccounts).set(set).where(eq(schema.whatsappAccounts.id, id));
  const accountRow = async (id: string) =>
    (await t.pool.query("select * from whatsapp_accounts where id = $1", [id])).rows[0];
  const routed = (
    accountId: string,
    reasons: readonly RoutedRequeueReason[],
    receivedAfter = EPOCH,
  ) =>
    t.db.transaction((tx) =>
      requeueRoutedHeldEvents(tx, { whatsappAccountId: accountId, reasons, receivedAfter }),
    );
  const unrouted = (eventId: string, targetId: string, receivedAfter = EPOCH) =>
    t.db.transaction((tx) =>
      requeueUnroutedEvent(tx, {
        webhookEventId: eventId,
        targetWhatsappAccountId: targetId,
        receivedAfter,
      }),
    );
  const activate = (accountId: string, now?: Date) =>
    t.db.transaction(async (tx) => {
      await tx
        .update(schema.whatsappAccounts)
        .set({ status: "ACTIVE" })
        .where(eq(schema.whatsappAccounts.id, accountId));
      return requeueOnAccountActivation(tx, { whatsappAccountId: accountId, now });
    });
  const snapshot = async (id: string) => getEvent(t.pool, id);

  describe("the stored envelope is read through one helper", () => {
    it("the JS and SQL readers agree with what the real normalizer stored", async () => {
      const id = await receive();
      const row = (await t.pool.query("select payload from webhook_events where id = $1", [id]))
        .rows[0];
      expect(phoneNumberIdOf(row.payload)).toBe(PN);
      expect(wabaIdOf(row.payload)).toBe(WABA);
      const viaSql = await t.pool.query(
        "select payload #>> '{metadata,phone_number_id}' as pn, payload ->> 'wabaId' as waba from webhook_events where id = $1",
        [id],
      );
      expect(viaSql.rows[0]).toEqual({ pn: PN, waba: WABA });
      expect(phoneNumberIdOf({})).toBeNull();
      expect(phoneNumberIdOf({ metadata: { phone_number_id: 7 } })).toBeNull();
      expect(phoneNumberIdOf(null)).toBeNull();
    });
  });

  describe("tenant provenance is recorded at ingest", () => {
    it("a PENDING account's hold keeps the account's organization and account", async () => {
      const acc = await account({ status: "PENDING" });
      const id = await receive();
      expect(await snapshot(id)).toMatchObject({
        status: "UNROUTABLE",
        last_error: "account_pending",
        organization_id: acc.organizationId,
        whatsapp_account_id: acc.id,
      });
    });

    it("an unknown number and a WABA mismatch have no proven owner, so they stay unrouted", async () => {
      const unknown = await receive();
      await account({ waba: "999999999999999" });
      const mismatch = await receive();
      expect(await snapshot(unknown)).toMatchObject({
        last_error: "unknown_account",
        organization_id: null,
        whatsapp_account_id: null,
      });
      expect(await snapshot(mismatch)).toMatchObject({
        last_error: "waba_mismatch",
        organization_id: null,
        whatsapp_account_id: null,
      });
    });
  });

  // ---------------------------------------------------------------------------------------------------- A
  describe("A. the original tenant is preserved", () => {
    it("a held account_pending event is released to ITS organization when ITS account is activated, and the worker processes it there", async () => {
      const a = await account({ status: "PENDING" });
      const b = await account({ pn: PN_B, waba: WABA_B, status: "PENDING" });
      const eventA = await receive(PN, WABA);
      const eventB = await receive(PN_B, WABA_B);

      expect(await activate(a.id)).toEqual({ requeued: 1, skipped: null, staleHeld: 0 });
      expect(await snapshot(eventA)).toMatchObject({
        status: "PENDING",
        attempts: 0,
        last_error: null,
        locked_at: null,
        locked_by: null,
        organization_id: a.organizationId,
        whatsapp_account_id: a.id,
      });
      // the other tenant's hold is untouched
      expect(await snapshot(eventB)).toMatchObject({
        status: "UNROUTABLE",
        organization_id: b.organizationId,
        whatsapp_account_id: b.id,
      });

      const seen: string[] = [];
      const summary = await processWebhookBatch(t.db, {
        handlers: {
          MESSAGE: async (_tx, event) => {
            seen.push(`${event.organizationId}/${event.whatsappAccountId}`);
          },
        },
      });
      expect(summary).toMatchObject({ claimed: 1, processed: 1 });
      expect(seen).toEqual([`${a.organizationId}/${a.id}`]);
    });

    it("resets attempts, clears the lease and last_error, and makes the event due now", async () => {
      const acc = await account();
      const e = await insertEvent(t.db, {
        organizationId: acc.organizationId,
        whatsappAccountId: acc.id,
        status: "UNROUTABLE",
        attempts: 3,
        lastError: "account_pending",
        phoneNumberId: PN,
        wabaId: WABA,
      });
      await t.pool.query(
        "update webhook_events set locked_at = now(), locked_by = 'ghost', next_attempt_at = now() + interval '1 day' where id = $1",
        [e.id],
      );
      expect((await routed(acc.id, ["account_pending"])).requeued).toBe(1);
      const row = await snapshot(e.id);
      expect(row).toMatchObject({
        status: "PENDING",
        attempts: 0,
        locked_at: null,
        locked_by: null,
        last_error: null,
        organization_id: acc.organizationId,
        whatsapp_account_id: acc.id,
      });
      expect(row.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 2000);
    });

    it("a requeued event gets a full attempt budget again", async () => {
      const acc = await account();
      const e = await insertEvent(t.db, {
        organizationId: acc.organizationId,
        whatsappAccountId: acc.id,
        status: "UNROUTABLE",
        attempts: MAX_ATTEMPTS,
        lastError: "account_pending",
        phoneNumberId: PN,
        wabaId: WABA,
      });
      await routed(acc.id, ["account_pending"]);
      expect(await snapshot(e.id)).toMatchObject({ status: "PENDING", attempts: 0 });
    });
  });

  // ---------------------------------------------------------------------------------------------------- B
  describe("B. organization change cannot re-home history", () => {
    it("the database refuses to move an account that has webhook history to another organization", async () => {
      const a = await account({ status: "PENDING" });
      const orgB = await seedOrg(t.db);
      await receive();
      await expectPgError(
        t.pool.query("update whatsapp_accounts set organization_id = $1 where id = $2", [
          orgB.id,
          a.id,
        ]),
        FK_VIOLATION,
        "webhook_events_org_account_fk",
      );
    });

    it("even if ownership drifted (FK checks bypassed), requeue refuses and rewrites nothing", async () => {
      const a = await account({ status: "PENDING" });
      const orgB = await seedOrg(t.db);
      const id = await receive();
      const before = await snapshot(id);
      const client = await t.pool.connect();
      try {
        await client.query("set session_replication_role = replica"); // corruption simulation only
        await client.query(
          "update whatsapp_accounts set organization_id = $1, status = 'ACTIVE' where id = $2",
          [orgB.id, a.id],
        );
        await client.query("reset session_replication_role");
      } finally {
        client.release();
      }
      expect(await routed(a.id, ["account_pending"])).toEqual({
        requeued: 0,
        skipped: "organization_mismatch",
      });
      expect(await requeueOnAccountActivation(t.db, { whatsappAccountId: a.id })).toMatchObject({
        requeued: 0,
        skipped: "organization_mismatch",
      });
      expect(await unrouted(id, a.id)).toEqual({ requeued: false, refused: "event_not_unrouted" });
      const after = await snapshot(id);
      expect(after).toEqual(before);
      expect(after.organization_id).toBe(a.organizationId);
      expect(after.organization_id).not.toBe(orgB.id);
    });

    it("a number that moved to another organization's account does not pull the old history along", async () => {
      const first = await account({ status: "DISABLED" });
      const old = await receive();
      await setAccount(first.id, { phoneNumberId: "retired-number", archivedAt: new Date() });
      const second = await account({ status: "ACTIVE" }); // another organization now owns PN
      expect(second.organizationId).not.toBe(first.organizationId);

      expect(
        await routed(second.id, [...OPERATOR_ROUTED_REASONS, ...AUTO_REQUEUE_REASONS]),
      ).toEqual({
        requeued: 0,
        skipped: null,
      });
      expect(await unrouted(old, second.id)).toEqual({
        requeued: false,
        refused: "event_not_unrouted",
      });
      expect(await snapshot(old)).toMatchObject({
        status: "IGNORED",
        last_error: "account_disabled",
        organization_id: first.organizationId,
        whatsapp_account_id: first.id,
      });
      // and the original account cannot release it either: it no longer owns that phone number
      await setAccount(first.id, { status: "ACTIVE", archivedAt: null });
      expect((await routed(first.id, ["account_disabled"])).requeued).toBe(0);
      expect((await snapshot(old)).status).toBe("IGNORED");
    });

    it("requeue never modifies the account row", async () => {
      const acc = await account({ status: "PENDING" });
      await receive();
      const before = await accountRow(acc.id);
      await setAccount(acc.id, { status: "ACTIVE" });
      const mid = await accountRow(acc.id);
      await routed(acc.id, ["account_pending"]);
      expect(await accountRow(acc.id)).toEqual(mid);
      expect({ ...mid, status: before.status, updated_at: before.updated_at }).toEqual(before);
    });
  });

  // ---------------------------------------------------------------------------------------------------- C
  describe("C. unknown_account events are never released automatically", () => {
    it("a matching account appearing later (even activated) releases nothing automatically", async () => {
      const early = await receive();
      const other = await receive();
      const created = await account();
      expect(await activate(created.id)).toEqual({ requeued: 0, skipped: null, staleHeld: 0 });
      expect(
        await routed(created.id, ["account_pending", "account_disabled", "account_archived"]),
      ).toEqual({
        requeued: 0,
        skipped: null,
      });
      for (const id of [early, other])
        expect(await snapshot(id)).toMatchObject({
          status: "UNROUTABLE",
          last_error: "unknown_account",
          organization_id: null,
          whatsapp_account_id: null,
        });
    });

    it("the routed function refuses to be asked for unrouted reasons", async () => {
      const acc = await account();
      for (const reason of UNROUTED_REASONS)
        await expect(routed(acc.id, [reason as never])).rejects.toThrow(RangeError);
    });

    it("an explicit operator decision releases exactly that event to the verified target, and the worker processes it there", async () => {
      const early = await receive();
      const untouched = await receive();
      const target = await account();
      expect(await unrouted(early, target.id)).toEqual({ requeued: true, refused: null });
      expect(await snapshot(early)).toMatchObject({
        status: "PENDING",
        attempts: 0,
        last_error: null,
        locked_by: null,
        organization_id: target.organizationId,
        whatsapp_account_id: target.id,
      });
      expect(await snapshot(untouched)).toMatchObject({
        status: "UNROUTABLE",
        organization_id: null,
      });
      const seen: string[] = [];
      await processWebhookBatch(t.db, {
        handlers: { MESSAGE: async (_tx, e) => void seen.push(e.organizationId) },
      });
      expect(seen).toEqual([target.organizationId]);
    });

    it("a second attempt on the same event is refused (it already has routing)", async () => {
      const id = await receive();
      const target = await account();
      expect((await unrouted(id, target.id)).requeued).toBe(true);
      expect(await unrouted(id, target.id)).toEqual({
        requeued: false,
        refused: "event_not_unrouted",
      });
    });
  });

  // ---------------------------------------------------------------------------------------------------- D
  describe("D. a wrong target is refused", () => {
    it("an unknown event for phone X cannot be released to an account for phone Y", async () => {
      const id = await receive(PN, WABA);
      const wrong = await account({ pn: PN_B, waba: WABA });
      const before = await snapshot(id);
      expect(await unrouted(id, wrong.id)).toEqual({
        requeued: false,
        refused: "phone_number_mismatch",
      });
      expect(await snapshot(id)).toEqual(before);
    });

    it("refuses a target that is missing, pending, disabled or archived, and an event that is missing or not a hold", async () => {
      const id = await receive();
      const unknownId = "00000000-0000-0000-0000-000000000000";
      expect(await unrouted(id, unknownId)).toEqual({
        requeued: false,
        refused: "account_not_found",
      });
      expect(await unrouted(unknownId, unknownId)).toEqual({
        requeued: false,
        refused: "event_not_found",
      });
      const acc = await account({ status: "PENDING" });
      expect((await unrouted(id, acc.id)).refused).toBe("account_not_active");
      await setAccount(acc.id, { status: "DISABLED" });
      expect((await unrouted(id, acc.id)).refused).toBe("account_not_active");
      await setAccount(acc.id, { status: "ACTIVE", archivedAt: new Date() });
      expect((await unrouted(id, acc.id)).refused).toBe("account_not_active");
      await setAccount(acc.id, { archivedAt: null });
      for (const status of ["DEAD", "PROCESSED", "PENDING", "IGNORED"] as const) {
        const e = await insertEvent(t.db, {
          status,
          phoneNumberId: PN,
          wabaId: WABA,
          lastError: "unknown_account",
        });
        expect((await unrouted(e.id, acc.id)).refused, status).toBe("event_not_unrouted");
      }
      const wrongReason = await insertEvent(t.db, {
        status: "UNROUTABLE",
        phoneNumberId: PN,
        wabaId: WABA,
        lastError: "missing_phone_number_id",
      });
      expect((await unrouted(wrongReason.id, acc.id)).refused).toBe("event_not_unrouted");
      expect((await snapshot(id)).status).toBe("UNROUTABLE");
    });

    it("an event whose payload carries no phone number can never be released", async () => {
      const acc = await account();
      const e = await insertEvent(t.db, {
        status: "UNROUTABLE",
        lastError: "unknown_account",
        payload: { v: 1 },
      });
      expect((await unrouted(e.id, acc.id)).refused).toBe("phone_number_mismatch");
    });
  });

  // ---------------------------------------------------------------------------------------------------- E
  describe("E. a routed event cannot be targeted at another organization", () => {
    it("explicitly targeting an Org B account for an Org A event is refused, and Org B's account releases none of A's events", async () => {
      const a = await account({ status: "PENDING" });
      const b = await account({ pn: PN_B, waba: WABA_B });
      const id = await receive(PN, WABA);
      const before = await snapshot(id);
      expect(await unrouted(id, b.id)).toEqual({ requeued: false, refused: "event_not_unrouted" });
      expect(
        await routed(b.id, ["account_pending", "account_disabled", "account_archived"]),
      ).toEqual({
        requeued: 0,
        skipped: null,
      });
      expect(await snapshot(id)).toEqual(before);
      expect(before.organization_id).toBe(a.organizationId);
    });

    it("a routed event is refused by the explicit path even if its reason text claims it is unrouted", async () => {
      const a = await account({ status: "PENDING" });
      const b = await account({ pn: PN_B, waba: WABA_B });
      for (const lastError of UNROUTED_REASONS) {
        const e = await insertEvent(t.db, {
          organizationId: a.organizationId,
          whatsappAccountId: a.id,
          status: "UNROUTABLE",
          lastError,
          phoneNumberId: PN_B,
          wabaId: WABA_B,
        });
        const before = await snapshot(e.id);
        expect(await unrouted(e.id, b.id), lastError).toEqual({
          requeued: false,
          refused: "event_not_unrouted",
        });
        expect(await snapshot(e.id)).toEqual(before);
        expect(before.organization_id).toBe(a.organizationId);
      }
    });

    it("the same refusal applies to every routed hold, whatever its reason", async () => {
      const a = await account({ status: "DISABLED" });
      const b = await account({ pn: PN_B, waba: WABA_B });
      const disabled = await receive();
      await setAccount(a.id, { status: "ACTIVE", archivedAt: new Date() });
      const archived = await receive();
      for (const id of [disabled, archived]) {
        const before = await snapshot(id);
        expect((await unrouted(id, b.id)).refused).toBe("event_not_unrouted");
        expect((await unrouted(id, a.id)).refused).toBe("event_not_unrouted");
        expect(await snapshot(id)).toEqual(before);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------- F
  describe("F. WABA must agree", () => {
    it("a waba_mismatch event stays unrouted and is refused until the account's configuration agrees", async () => {
      const acc = await account({ waba: "999999999999999" });
      const id = await receive(PN, WABA);
      expect((await snapshot(id)).last_error).toBe("waba_mismatch");
      expect(await activate(acc.id)).toMatchObject({ requeued: 0 });
      const before = await snapshot(id);
      expect(await unrouted(id, acc.id)).toEqual({ requeued: false, refused: "waba_mismatch" });
      expect(await snapshot(id)).toEqual(before);

      await setAccount(acc.id, { wabaId: WABA });
      expect(await unrouted(id, acc.id)).toEqual({ requeued: true, refused: null });
      expect(await snapshot(id)).toMatchObject({
        status: "PENDING",
        organization_id: acc.organizationId,
        whatsapp_account_id: acc.id,
      });
    });

    it("an unknown_account event that carries a different WABA is refused; one without a WABA is decided by the operator", async () => {
      const acc = await account({ waba: WABA_B });
      const differing = await receive(PN, WABA);
      expect((await unrouted(differing, acc.id)).refused).toBe("waba_mismatch");
      const noWaba = await insertEvent(t.db, {
        status: "UNROUTABLE",
        lastError: "unknown_account",
        phoneNumberId: PN,
      });
      expect((await unrouted(noWaba.id, acc.id)).requeued).toBe(true);
      const mismatchNoWaba = await insertEvent(t.db, {
        status: "UNROUTABLE",
        lastError: "waba_mismatch",
        phoneNumberId: PN,
      });
      expect((await unrouted(mismatchNoWaba.id, acc.id)).refused).toBe("waba_mismatch");
    });

    it("a routed event whose payload names another WABA than the account is not released", async () => {
      const acc = await account();
      const e = await insertEvent(t.db, {
        organizationId: acc.organizationId,
        whatsappAccountId: acc.id,
        status: "UNROUTABLE",
        lastError: "account_pending",
        phoneNumberId: PN,
        wabaId: "somebody-else",
      });
      expect((await routed(acc.id, ["account_pending"])).requeued).toBe(0);
      expect((await snapshot(e.id)).status).toBe("UNROUTABLE");
    });
  });

  // ---------------------------------------------------------------------------------------------------- G
  describe("G. disabled and archived history stays with its original account", () => {
    it("re-enabling an account releases nothing automatically; an explicit call releases against the SAME account only", async () => {
      const acc = await account({ status: "DISABLED" });
      const id = await receive();
      const before = await snapshot(id);
      expect(before).toMatchObject({
        status: "IGNORED",
        organization_id: acc.organizationId,
        whatsapp_account_id: acc.id,
      });
      expect(await routed(acc.id, ["account_disabled"])).toEqual({
        requeued: 0,
        skipped: "account_not_active",
      });
      expect(await activate(acc.id)).toEqual({ requeued: 0, skipped: null, staleHeld: 0 });
      expect((await snapshot(id)).status).toBe("IGNORED");
      expect((await routed(acc.id, ["account_disabled"])).requeued).toBe(1);
      expect(await snapshot(id)).toMatchObject({
        status: "PENDING",
        organization_id: acc.organizationId,
        whatsapp_account_id: acc.id,
      });
    });

    it("archived history is released only after the same account is un-archived", async () => {
      const acc = await account({ archived: true });
      const id = await receive();
      expect((await snapshot(id)).last_error).toBe("account_archived");
      expect((await routed(acc.id, ["account_archived"])).skipped).toBe("account_not_active");
      await setAccount(acc.id, { archivedAt: null });
      expect((await routed(acc.id, ["account_archived"])).requeued).toBe(1);
      expect(await snapshot(id)).toMatchObject({
        organization_id: acc.organizationId,
        whatsapp_account_id: acc.id,
      });
    });

    it("releases only the reasons that were asked for", async () => {
      const acc = await account({ status: "PENDING" });
      const pendingEvent = await receive();
      await setAccount(acc.id, { status: "DISABLED" });
      const disabledEvent = await receive();
      await setAccount(acc.id, { status: "ACTIVE" });
      expect((await routed(acc.id, ["account_disabled"])).requeued).toBe(1);
      expect((await snapshot(disabledEvent)).status).toBe("PENDING");
      expect((await snapshot(pendingEvent)).status).toBe("UNROUTABLE");
    });

    it("an event whose stored phone number is not the account's is not released", async () => {
      const acc = await account();
      const e = await insertEvent(t.db, {
        organizationId: acc.organizationId,
        whatsappAccountId: acc.id,
        status: "IGNORED",
        lastError: "account_disabled",
        phoneNumberId: PN_B,
        wabaId: WABA,
      });
      expect((await routed(acc.id, ["account_disabled"])).requeued).toBe(0);
      expect((await snapshot(e.id)).status).toBe("IGNORED");
    });
  });

  // ---------------------------------------------------------------------------------------- inputs, age, accounts
  describe("inputs and account eligibility", () => {
    it("the reason lists are exactly the approved ones", () => {
      expect([...AUTO_REQUEUE_REASONS]).toEqual(["account_pending"]);
      expect([...OPERATOR_ROUTED_REASONS]).toEqual(["account_disabled", "account_archived"]);
      expect([...UNROUTED_REASONS]).toEqual(["unknown_account", "waba_mismatch"]);
    });

    it("rejects an empty list, a reason that is not a routed hold reason, and an invalid cutoff", async () => {
      const acc = await account();
      await expect(routed(acc.id, [])).rejects.toThrow(RangeError);
      for (const reason of [
        "status_not_mirrored",
        "unsupported_field",
        "malformed_event",
        "waba_mismatch",
      ])
        await expect(routed(acc.id, [reason as never])).rejects.toThrow(RangeError);
      await expect(routed(acc.id, ["account_pending"], new Date("nope"))).rejects.toThrow(
        RangeError,
      );
      await expect(unrouted("x", "y", new Date("nope"))).rejects.toThrow(RangeError);
    });

    it.each([
      ["PENDING", "PENDING", false],
      ["DISABLED", "DISABLED", false],
      ["archived", "ACTIVE", true],
    ] as const)("a %s account releases nothing", async (_name, status, archived) => {
      const acc = await account({ status: "PENDING" });
      const id = await receive();
      await setAccount(acc.id, { status, archivedAt: archived ? new Date() : null });
      expect(await routed(acc.id, ["account_pending"])).toEqual({
        requeued: 0,
        skipped: "account_not_active",
      });
      expect((await snapshot(id)).status).toBe("UNROUTABLE");
    });

    it("an unknown account id releases nothing", async () => {
      expect(await routed("00000000-0000-0000-0000-000000000000", ["account_pending"])).toEqual({
        requeued: 0,
        skipped: "account_not_found",
      });
    });

    it("never touches ignored kinds that need no processing, or events in other states", async () => {
      const acc = await account();
      const base = {
        organizationId: acc.organizationId,
        whatsappAccountId: acc.id,
        phoneNumberId: PN,
        wabaId: WABA,
      };
      const unsupported = await insertEvent(t.db, {
        ...base,
        status: "IGNORED",
        lastError: "unsupported_field",
        eventType: "OTHER",
      });
      const dead = await insertEvent(t.db, {
        ...base,
        status: "DEAD",
        lastError: "account_pending",
      });
      const processed = await insertEvent(t.db, { ...base, status: "PROCESSED" });
      expect(
        (await routed(acc.id, [...AUTO_REQUEUE_REASONS, ...OPERATOR_ROUTED_REASONS])).requeued,
      ).toBe(0);
      expect((await snapshot(unsupported.id)).status).toBe("IGNORED");
      expect((await snapshot(dead.id)).status).toBe("DEAD");
      expect((await snapshot(processed.id)).status).toBe("PROCESSED");
    });

    it("ignores caller-supplied organization or account smuggled past the types", async () => {
      const a = await account({ status: "PENDING" });
      const held = await receive();
      const unknown = await receive(PN_B, WABA_B); // no account for this number yet: no proven owner
      const b = await account({ pn: PN_B, waba: WABA_B });
      await setAccount(a.id, { status: "ACTIVE" });
      const result = await t.db.transaction((tx) =>
        requeueRoutedHeldEvents(tx, {
          whatsappAccountId: a.id,
          reasons: ["account_pending"],
          receivedAfter: EPOCH,
          ...({ organizationId: b.organizationId, targetWhatsappAccountId: b.id } as object),
        }),
      );
      expect(result.requeued).toBe(1);
      expect(await snapshot(held)).toMatchObject({
        organization_id: a.organizationId,
        whatsapp_account_id: a.id,
      });

      const viaB = await t.db.transaction((tx) =>
        requeueUnroutedEvent(tx, {
          webhookEventId: unknown,
          targetWhatsappAccountId: b.id,
          receivedAfter: EPOCH,
          ...({ organizationId: a.organizationId } as object),
        }),
      );
      expect(viaB.requeued).toBe(true);
      expect(await snapshot(unknown)).toMatchObject({
        organization_id: b.organizationId,
        whatsapp_account_id: b.id,
      });
    });
  });

  describe("age limit", () => {
    it("automatic activation leaves routed account_pending events older than 30 days held (counted, payload intact); fresh ones are released", async () => {
      const acc = await account({ status: "PENDING" });
      const old = await receive();
      const fresh = await receive();
      const payloadBefore = (
        await t.pool.query("select payload from webhook_events where id = $1", [old])
      ).rows[0].payload;
      await t.pool.query(
        "update webhook_events set received_at = now() - interval '31 days' where id = $1",
        [old],
      );
      await t.pool.query(
        "update webhook_events set received_at = now() - interval '29 days' where id = $1",
        [fresh],
      );
      expect(await activate(acc.id)).toEqual({ requeued: 1, skipped: null, staleHeld: 1 });
      expect((await snapshot(fresh)).status).toBe("PENDING");
      expect(await snapshot(old)).toMatchObject({
        status: "UNROUTABLE",
        last_error: "account_pending",
        organization_id: acc.organizationId,
        whatsapp_account_id: acc.id,
      });
      const payloadAfter = (
        await t.pool.query("select payload from webhook_events where id = $1", [old])
      ).rows[0].payload;
      expect(payloadAfter).toEqual(payloadBefore);
      expect(REQUEUE_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it("an explicit operator cutoff can release the old routed event, to its own account", async () => {
      const acc = await account({ status: "PENDING" });
      const old = await receive();
      await t.pool.query(
        "update webhook_events set received_at = now() - interval '45 days' where id = $1",
        [old],
      );
      await setAccount(acc.id, { status: "ACTIVE" });
      expect(
        (await routed(acc.id, ["account_pending"], new Date(Date.now() - 60 * 86_400_000)))
          .requeued,
      ).toBe(1);
      expect(await snapshot(old)).toMatchObject({ status: "PENDING", whatsapp_account_id: acc.id });
    });

    it("the cutoff boundary is inclusive for routed events", async () => {
      const acc = await account();
      const e = await insertEvent(t.db, {
        organizationId: acc.organizationId,
        whatsappAccountId: acc.id,
        status: "UNROUTABLE",
        lastError: "account_pending",
        phoneNumberId: PN,
        wabaId: WABA,
      });
      const row = (
        await t.pool.query("select received_at from webhook_events where id = $1", [e.id])
      ).rows[0];
      expect((await routed(acc.id, ["account_pending"], row.received_at)).requeued).toBe(1);
    });

    it("an operator-confirmed cutoff newer than an unrouted event refuses it as too old", async () => {
      const id = await receive();
      const target = await account();
      await t.pool.query(
        "update webhook_events set received_at = now() - interval '40 days' where id = $1",
        [id],
      );
      expect(await unrouted(id, target.id, new Date(Date.now() - 30 * 86_400_000))).toEqual({
        requeued: false,
        refused: "event_too_old",
      });
      expect((await unrouted(id, target.id, new Date(Date.now() - 50 * 86_400_000))).requeued).toBe(
        true,
      );
    });
  });

  describe("concurrency and atomicity", () => {
    it("concurrent routed requeues release each event exactly once", async () => {
      const acc = await account({ status: "PENDING" });
      for (let i = 0; i < 12; i++) await receive();
      await setAccount(acc.id, { status: "ACTIVE" });
      const results = await Promise.all([
        routed(acc.id, ["account_pending"]),
        routed(acc.id, ["account_pending"]),
        routed(acc.id, ["account_pending"]),
      ]);
      expect(results.reduce((sum, r) => sum + r.requeued, 0)).toBe(12);
    });

    it("concurrent explicit requeues of one unrouted event: exactly one wins", async () => {
      const id = await receive();
      const target = await account();
      const results = await Promise.all(Array.from({ length: 4 }, () => unrouted(id, target.id)));
      expect(results.filter((r) => r.requeued)).toHaveLength(1);
      expect(
        results.filter((r) => !r.requeued).every((r) => r.refused === "event_not_unrouted"),
      ).toBe(true);
    });

    it("activation and requeue are one transaction: a rollback leaves the account and the holds untouched", async () => {
      const acc = await account({ status: "PENDING" });
      const id = await receive();
      await expect(
        t.db.transaction(async (tx) => {
          await tx
            .update(schema.whatsappAccounts)
            .set({ status: "ACTIVE" })
            .where(eq(schema.whatsappAccounts.id, acc.id));
          expect(
            (await requeueOnAccountActivation(tx, { whatsappAccountId: acc.id })).requeued,
          ).toBe(1);
          throw new Error("activation failed later");
        }),
      ).rejects.toThrow("activation failed later");
      expect((await snapshot(id)).status).toBe("UNROUTABLE");
      expect((await accountRow(acc.id)).status).toBe("PENDING");
    });

    it("the account cannot be disabled between the requeue and its commit (the row is locked FOR SHARE)", async () => {
      const acc = await account({ status: "PENDING" });
      await receive();
      await setAccount(acc.id, { status: "ACTIVE" });
      const hold = deferred();
      const inside = deferred();
      onTestEnd.push(hold.resolve);
      const requeuing = t.db.transaction(async (tx) => {
        await requeueRoutedHeldEvents(tx, {
          whatsappAccountId: acc.id,
          reasons: ["account_pending"],
          receivedAfter: EPOCH,
        });
        inside.resolve();
        await hold.promise;
      });
      await inside.promise;
      const disabling = setAccount(acc.id, { status: "DISABLED" }).then(() => "disabled");
      await until(
        async () =>
          (
            await t.pool.query(
              "select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
            )
          ).rowCount === 1,
      );
      hold.resolve();
      await requeuing;
      expect(await disabling).toBe("disabled");
      // released while the account was active; the worker's recheck now moves it aside, keeping its routing
      const summary = await processWebhookBatch(t.db, {
        handlers: { MESSAGE: async () => undefined },
      });
      expect(summary).toMatchObject({ claimed: 1, ignored: 1, processed: 0 });
    });
  });
});
