import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { resolveStatusEventsForMessage } from "@/db/ops/message-status";
import { insertEvent } from "../queue/testing";
import { statusHandlers } from "./handler";
import {
  PN,
  WABA,
  addAccount,
  deliverStatus,
  epoch,
  eventStatus,
  handleStatusDirect,
  ingestFixture,
  minutesAgo,
  processBoth,
  processStatuses,
  seedMessage,
  tenant,
} from "./testing";

// The STATUS handler against REAL PostgreSQL, driven by genuine events from the real ingest path and run by the real queue
// worker. A status is not customer activity: after every test no lead, consent, tag or attribution exists, and no test
// below changes the number of contacts, conversations or messages through a status.

const PN2 = "100000000000002";
const WABA2 = "200000000000002";
const PRIORITY = { SENT: 1, FAILED: 2, DELIVERED: 3, READ: 4 } as const;
type S = keyof typeof PRIORITY;
const META: Record<S, string> = {
  SENT: "sent",
  DELIVERED: "delivered",
  READ: "read",
  FAILED: "failed",
};

describe("STATUS handler", () => {
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
    for (const table of [
      "leads",
      "lead_attributions",
      "contact_consents",
      "contact_tags",
      "tags",
      "contact_bsuids",
    ]) {
      const r = await t.pool.query(`select count(*)::int n from ${table}`);
      expect(r.rows[0].n, `${table} must stay empty: a status creates none`).toBe(0);
    }
  });

  const rows = async (query: string, params: unknown[] = []) =>
    (await t.pool.query(query, params)).rows;
  const count = async (table: string) =>
    (await rows(`select count(*)::int n from ${table}`))[0].n as number;
  const history = (wamid: string) =>
    rows("select * from message_status_events where wamid = $1 order by occurred_at, status", [
      wamid,
    ]);
  const messageRow = async (id: string) =>
    (await rows("select * from messages where id = $1", [id]))[0];
  const domainCounts = async () => ({
    contacts: await count("contacts"),
    conversations: await count("conversations"),
    messages: await count("messages"),
    leads: await count("leads"),
  });
  const conversationsSnapshot = () => rows("select * from conversations order by id");
  const replay = (id: string) =>
    t.pool.query(
      "update webhook_events set status='PENDING', attempts=0, locked_at=null, locked_by=null, last_error=null, next_attempt_at=now() where id=$1",
      [id],
    );
  const at = (secondsAfter: number, base = 1_790_000_000) => String(base + secondsAfter);
  const ts = (value: string) => new Date(Number(value) * 1000);

  // ------------------------------------------------------------------------------------------- each status
  describe("each documented status", () => {
    it.each(Object.keys(PRIORITY) as S[])(
      "%s is recorded in the history and applied to the outbound message",
      async (status) => {
        const { org, account } = await tenant(t.db);
        const { message } = await seedMessage(t.db, {
          organizationId: org.id,
          whatsappAccountId: account.id,
          wamid: "wamid.ONE",
        });
        const timestamp = at(10);
        const e = await deliverStatus(t.db, {
          id: "wamid.ONE",
          status: META[status],
          timestamp,
          recipient: "15550100123",
          extra:
            status === "FAILED" ? { errors: [{ code: 131026, message: "undeliverable" }] } : {},
        });
        expect(await processBoth(t.db)).toMatchObject({ claimed: 1, processed: 1 });
        expect(await eventStatus(t.db, e.id)).toMatchObject({
          status: "PROCESSED",
          lastError: null,
        });

        const [h] = await history("wamid.ONE");
        expect(h).toMatchObject({
          organization_id: org.id,
          whatsapp_account_id: account.id,
          message_id: message.id,
          wamid: "wamid.ONE",
          status,
          webhook_event_id: e.id,
          error_code: status === "FAILED" ? "131026" : null,
          error_message: status === "FAILED" ? "undeliverable" : null,
        });
        expect(h.occurred_at).toEqual(ts(timestamp));
        expect(await messageRow(message.id)).toMatchObject({
          latest_status: status,
          latest_status_at: ts(timestamp),
          error_code: status === "FAILED" ? "131026" : null,
          error_message: status === "FAILED" ? "undeliverable" : null,
          direction: "OUTBOUND",
        });
      },
    );

    it("the sanitized G0 fixtures: sent, delivered (phone + BSUID, BSUID only), read and failed all converge on READ", async () => {
      const { org, account } = await tenant(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.FAKE00000000000000000200",
      });
      for (const file of [
        "status-sent.json",
        "status-delivered-phone-bsuid.json",
        "status-failed.json",
        "status-read.json",
      ])
        await ingestFixture(t.db, file);
      expect(await processBoth(t.db)).toMatchObject({ claimed: 4, processed: 4 });
      expect(await messageRow(message.id)).toMatchObject({
        latest_status: "READ",
        error_code: null,
        error_message: null,
      });
      expect((await history("wamid.FAKE00000000000000000200")).map((h) => h.status).sort()).toEqual(
        ["DELIVERED", "FAILED", "READ", "SENT"],
      );
      const failed = (await history("wamid.FAKE00000000000000000200")).find(
        (h) => h.status === "FAILED",
      );
      expect(failed).toMatchObject({ error_code: "131049", message_id: message.id });
    });

    it("`played` is ignored at ingest and never claimed", async () => {
      await tenant(t.db);
      const [played] = await ingestFixture(t.db, "status-played.json");
      expect(await eventStatus(t.db, played!.id)).toMatchObject({ status: "IGNORED", attempts: 0 });
      expect(await processBoth(t.db)).toMatchObject({ claimed: 0 });
      expect(await count("message_status_events")).toBe(0);
    });
  });

  // ------------------------------------------------------------------------------------------- idempotency
  describe("duplicates", () => {
    it("re-processing the same event changes nothing at all (history, message, updated_at)", async () => {
      const { org, account } = await tenant(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.DUP",
      });
      const e = await deliverStatus(t.db, {
        id: "wamid.DUP",
        status: "delivered",
        timestamp: at(0),
      });
      await processBoth(t.db);
      const before = { history: await history("wamid.DUP"), message: await messageRow(message.id) };
      await replay(e.id);
      expect(await processBoth(t.db)).toMatchObject({ claimed: 1, processed: 1 });
      expect({
        history: await history("wamid.DUP"),
        message: await messageRow(message.id),
      }).toEqual(before);
      expect(logs.join("\n")).toContain("duplicate");
    });

    it("a second event for the same logical status adds no history row and never regresses a later status", async () => {
      const { org, account } = await tenant(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.DUP2",
      });
      const delivered = await deliverStatus(t.db, {
        id: "wamid.DUP2",
        status: "delivered",
        timestamp: at(0),
      });
      await processBoth(t.db);
      await deliverStatus(t.db, { id: "wamid.DUP2", status: "read", timestamp: at(30) });
      await processBoth(t.db);
      const copy = await insertEvent(t.db, {
        organizationId: delivered.organizationId,
        whatsappAccountId: delivered.whatsappAccountId,
        payload: delivered.payload,
        phoneNumberId: PN,
        wabaId: WABA,
        eventType: "STATUS",
      });
      expect(await processBoth(t.db)).toMatchObject({ claimed: 1, processed: 1 });
      expect(await eventStatus(t.db, copy.id)).toMatchObject({ status: "PROCESSED" });
      expect(await history("wamid.DUP2")).toHaveLength(2);
      expect(await messageRow(message.id)).toMatchObject({
        latest_status: "READ",
        latest_status_at: ts(at(30)),
      });
    });

    it("the same status with a different timestamp is a different observation and both are kept", async () => {
      const { org, account } = await tenant(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.DUP3",
      });
      await deliverStatus(t.db, { id: "wamid.DUP3", status: "delivered", timestamp: at(0) });
      await deliverStatus(t.db, { id: "wamid.DUP3", status: "delivered", timestamp: at(60) });
      await processBoth(t.db);
      expect(await history("wamid.DUP3")).toHaveLength(2);
      expect((await messageRow(message.id)).latest_status).toBe("DELIVERED");
    });
  });

  // ----------------------------------------------------------------------------------------- out of order
  describe("out-of-order delivery", () => {
    // every ordered selection of the four statuses: 4 + 12 + 24 + 24 = 64 sequences
    const sequences: S[][] = [];
    const all = Object.keys(PRIORITY) as S[];
    const extend = (prefix: S[]) => {
      if (prefix.length > 0) sequences.push(prefix);
      for (const s of all) if (!prefix.includes(s)) extend([...prefix, s]);
    };
    extend([]);
    const CHRONOLOGY: Record<S, number> = { SENT: 0, FAILED: 3, DELIVERED: 6, READ: 12 }; // seconds after the send

    it("every sequence of every subset ends at the highest-priority status with its own timestamp and a complete history", async () => {
      expect(sequences).toHaveLength(64);
      const { org, account } = await tenant(t.db);
      let n = 0;
      for (const sequence of sequences) {
        const wamid = `wamid.PERM${n++}`;
        const { message } = await seedMessage(t.db, {
          organizationId: org.id,
          whatsappAccountId: account.id,
          wamid,
        });
        for (const status of sequence) {
          await deliverStatus(t.db, {
            id: wamid,
            status: META[status],
            timestamp: at(CHRONOLOGY[status]),
            extra:
              status === "FAILED" ? { errors: [{ code: 131026, message: "undeliverable" }] } : {},
          });
          expect(await processBoth(t.db)).toMatchObject({ claimed: 1, processed: 1 });
        }
        const winner = [...sequence].sort((a, b) => PRIORITY[b] - PRIORITY[a])[0]!;
        const row = await messageRow(message.id);
        expect(row.latest_status, sequence.join(">")).toBe(winner);
        expect(row.latest_status_at, sequence.join(">")).toEqual(ts(at(CHRONOLOGY[winner])));
        expect(row.error_code, sequence.join(">")).toBe(winner === "FAILED" ? "131026" : null);
        const h = await history(wamid);
        expect(h.map((x) => x.status).sort(), sequence.join(">")).toEqual([...sequence].sort());
        for (const x of h) expect(x.occurred_at).toEqual(ts(at(CHRONOLOGY[x.status as S]))); // real provider time, never reordered
      }
    });

    it("a late lower-priority status never regresses the cache, and a late higher one advances it", async () => {
      const { org, account } = await tenant(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.LATE",
      });
      await deliverStatus(t.db, { id: "wamid.LATE", status: "read", timestamp: at(20) });
      await processBoth(t.db);
      await deliverStatus(t.db, { id: "wamid.LATE", status: "delivered", timestamp: at(10) });
      await deliverStatus(t.db, { id: "wamid.LATE", status: "sent", timestamp: at(0) });
      await processBoth(t.db);
      expect(await messageRow(message.id)).toMatchObject({
        latest_status: "READ",
        latest_status_at: ts(at(20)),
      });
      expect(await history("wamid.LATE")).toHaveLength(3);
    });

    it("FAILED then DELIVERED: the delivery supersedes the failure in the cache and clears its error, the history keeps both", async () => {
      const { org, account } = await tenant(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.FD",
      });
      await deliverStatus(t.db, {
        id: "wamid.FD",
        status: "failed",
        timestamp: at(0),
        extra: { errors: [{ code: 1, message: "boom" }] },
      });
      await processBoth(t.db);
      expect(await messageRow(message.id)).toMatchObject({
        latest_status: "FAILED",
        error_code: "1",
        error_message: "boom",
      });
      await deliverStatus(t.db, { id: "wamid.FD", status: "delivered", timestamp: at(5) });
      await processBoth(t.db);
      expect(await messageRow(message.id)).toMatchObject({
        latest_status: "DELIVERED",
        error_code: null,
        error_message: null,
      });
      expect((await history("wamid.FD")).map((h) => [h.status, h.error_code])).toEqual([
        ["FAILED", "1"],
        ["DELIVERED", null],
      ]);
    });
  });

  // ------------------------------------------------------------------------------------ status before message
  describe("status before the message exists", () => {
    it("is kept with message_id NULL, fabricates nothing, and is reconciled when the outbound message is created", async () => {
      const { org, account } = await tenant(t.db);
      const before = await domainCounts();
      for (const [status, offset] of [
        ["sent", 0],
        ["delivered", 10],
        ["read", 20],
      ] as const)
        await deliverStatus(t.db, {
          id: "wamid.EARLY",
          status,
          timestamp: at(offset),
          recipient: "15550100777",
        });
      expect(await processBoth(t.db)).toMatchObject({ claimed: 3, processed: 3 });
      const orphans = await history("wamid.EARLY");
      expect(orphans).toHaveLength(3);
      expect(
        orphans.every(
          (h) =>
            h.message_id === null &&
            h.organization_id === org.id &&
            h.whatsapp_account_id === account.id,
        ),
      ).toBe(true);
      expect(await domainCounts()).toEqual(before); // no message, conversation, contact (from recipient_id) or lead
      expect(logs.join("\n")).toContain("awaiting_message");

      // the future outbound writer inserts the message and calls the Phase 02 reconciliation
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.EARLY",
      });
      await t.db.transaction((tx) =>
        resolveStatusEventsForMessage(tx, {
          id: message.id,
          organizationId: org.id,
          whatsappAccountId: account.id,
          wamid: "wamid.EARLY",
        }),
      );
      expect((await history("wamid.EARLY")).every((h) => h.message_id === message.id)).toBe(true);
      expect(await messageRow(message.id)).toMatchObject({
        latest_status: "READ",
        latest_status_at: ts(at(20)),
      });
    });

    it("statuses that arrive after the message exists link immediately; earlier ones are reconciled together", async () => {
      const { org, account } = await tenant(t.db);
      await deliverStatus(t.db, { id: "wamid.MIX", status: "sent", timestamp: at(0) });
      await processBoth(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.MIX",
      });
      await t.db.transaction((tx) =>
        resolveStatusEventsForMessage(tx, {
          id: message.id,
          organizationId: org.id,
          whatsappAccountId: account.id,
          wamid: "wamid.MIX",
        }),
      );
      await deliverStatus(t.db, { id: "wamid.MIX", status: "delivered", timestamp: at(9) });
      await processBoth(t.db);
      expect((await history("wamid.MIX")).every((h) => h.message_id === message.id)).toBe(true);
      expect((await messageRow(message.id)).latest_status).toBe("DELIVERED");
    });

    it("an orphan status never makes the event fail, and replaying it keeps one row", async () => {
      await tenant(t.db);
      const e = await deliverStatus(t.db, {
        id: "wamid.NEVER",
        status: "failed",
        timestamp: at(0),
      });
      await processBoth(t.db);
      await replay(e.id);
      await processBoth(t.db);
      expect(await eventStatus(t.db, e.id)).toMatchObject({ status: "PROCESSED" });
      expect(await history("wamid.NEVER")).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------ tenant and account scoping
  describe("tenant and account scoping", () => {
    it("a status for another WhatsApp account of the same organization never touches this account's message", async () => {
      const { org, account } = await tenant(t.db);
      const other = await addAccount(t.db, org.id, PN2, WABA2);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.SCOPE",
      });
      await deliverStatus(t.db, {
        id: "wamid.SCOPE",
        status: "read",
        timestamp: at(0),
        pn: PN2,
        waba: WABA2,
      });
      await processBoth(t.db);
      expect(await messageRow(message.id)).toMatchObject({
        latest_status: null,
        latest_status_at: null,
      });
      const [h] = await history("wamid.SCOPE");
      expect(h).toMatchObject({
        whatsapp_account_id: other.id,
        organization_id: org.id,
        message_id: null,
      });
    });

    it("a status for another ORGANIZATION never touches this organization's message", async () => {
      const a = await tenant(t.db);
      const b = await tenant(t.db, { pn: PN2, waba: WABA2 });
      const { message } = await seedMessage(t.db, {
        organizationId: a.org.id,
        whatsappAccountId: a.account.id,
        wamid: "wamid.TENANT",
      });
      await deliverStatus(t.db, {
        id: "wamid.TENANT",
        status: "delivered",
        timestamp: at(0),
        pn: PN2,
        waba: WABA2,
      });
      await processBoth(t.db);
      expect((await messageRow(message.id)).latest_status).toBeNull();
      expect((await history("wamid.TENANT"))[0]).toMatchObject({
        organization_id: b.org.id,
        message_id: null,
      });
    });

    it("the same wamid on two accounts: each status updates only its own account's message", async () => {
      const { org, account } = await tenant(t.db);
      const other = await addAccount(t.db, org.id, PN2, WABA2);
      const first = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.TWIN",
      });
      const second = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: other.id,
        wamid: "wamid.TWIN",
      });
      await deliverStatus(t.db, { id: "wamid.TWIN", status: "delivered", timestamp: at(0) });
      await deliverStatus(t.db, {
        id: "wamid.TWIN",
        status: "read",
        timestamp: at(5),
        pn: PN2,
        waba: WABA2,
      });
      await processBoth(t.db);
      expect(await messageRow(first.message.id)).toMatchObject({ latest_status: "DELIVERED" });
      expect(await messageRow(second.message.id)).toMatchObject({ latest_status: "READ" });
      const h = await history("wamid.TWIN");
      expect(h.find((x) => x.status === "DELIVERED")).toMatchObject({
        whatsapp_account_id: account.id,
        message_id: first.message.id,
      });
      expect(h.find((x) => x.status === "READ")).toMatchObject({
        whatsapp_account_id: other.id,
        message_id: second.message.id,
      });
    });

    it("an organization named inside the payload is ignored", async () => {
      const a = await tenant(t.db);
      const b = await tenant(t.db, { pn: PN2, waba: WABA2 });
      const e = await deliverStatus(t.db, {
        id: "wamid.PAYLOAD",
        status: "sent",
        timestamp: at(0),
      });
      await t.pool.query(
        "update webhook_events set payload = jsonb_set(payload, '{organization_id}', to_jsonb($2::text)) where id = $1",
        [e.id, b.org.id],
      );
      await processBoth(t.db);
      expect((await history("wamid.PAYLOAD"))[0].organization_id).toBe(a.org.id);
    });

    it("the recipient is never used to find a message: a status carrying a known contact's phone attaches to nothing", async () => {
      const { org, account } = await tenant(t.db);
      const { message, contact } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.REAL",
      });
      await deliverStatus(t.db, {
        id: "wamid.OTHER",
        status: "read",
        timestamp: at(0),
        recipient: contact.waId!,
      });
      await processBoth(t.db);
      expect((await messageRow(message.id)).latest_status).toBeNull();
      expect((await history("wamid.OTHER"))[0].message_id).toBeNull();
    });
  });

  // ------------------------------------------------------------------------------------- direction safety
  describe("message direction", () => {
    it("a status whose wamid is an INBOUND message never changes it; the observation is kept unlinked, with a safe diagnostic", async () => {
      const { org, account } = await tenant(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.INBOUND",
        direction: "INBOUND",
      });
      const before = await messageRow(message.id);
      const e = await deliverStatus(t.db, {
        id: "wamid.INBOUND",
        status: "failed",
        timestamp: at(0),
        extra: { errors: [{ code: 9, message: "x" }] },
      });
      expect(await processBoth(t.db)).toMatchObject({ claimed: 1, processed: 1 });
      expect(await messageRow(message.id)).toEqual(before);
      expect(await history("wamid.INBOUND")).toMatchObject([
        { message_id: null, status: "FAILED", webhook_event_id: e.id },
      ]);
      expect(logs.join("\n")).toContain("inbound_message_wamid");
    });

    it("every status value is refused for an inbound message, in any order", async () => {
      const { org, account } = await tenant(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.INB2",
        direction: "INBOUND",
      });
      for (const [i, s] of (["read", "delivered", "sent", "failed"] as const).entries())
        await deliverStatus(t.db, { id: "wamid.INB2", status: s, timestamp: at(i) });
      await processBoth(t.db);
      expect(await messageRow(message.id)).toMatchObject({
        latest_status: null,
        latest_status_at: null,
        error_code: null,
      });
      expect((await history("wamid.INB2")).every((h) => h.message_id === null)).toBe(true);
    });

    it("reconciliation refuses to attach statuses to an inbound message", async () => {
      const { org, account } = await tenant(t.db);
      await deliverStatus(t.db, { id: "wamid.INB3", status: "read", timestamp: at(0) });
      await processBoth(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.INB3x",
        direction: "INBOUND",
      });
      await t.db.transaction((tx) =>
        resolveStatusEventsForMessage(tx, {
          id: message.id,
          organizationId: org.id,
          whatsappAccountId: account.id,
          wamid: "wamid.INB3",
        }),
      );
      expect((await history("wamid.INB3"))[0].message_id).toBeNull();
      expect((await messageRow(message.id)).latest_status).toBeNull();
    });
  });

  // ------------------------------------------------------------------------------------------- timestamps
  describe("timestamps", () => {
    it.each(["abc", "0", "-5", "12.5", "99999999999999"])(
      "an unusable timestamp (%s) is a permanent failure and writes nothing",
      async (timestamp) => {
        const { org, account } = await tenant(t.db);
        const { message } = await seedMessage(t.db, {
          organizationId: org.id,
          whatsappAccountId: account.id,
          wamid: "wamid.BADTS",
        });
        const e = await deliverStatus(t.db, { id: "wamid.BADTS", status: "delivered", timestamp });
        expect(await processBoth(t.db)).toMatchObject({ claimed: 1, dead: 1, processed: 0 });
        expect(await eventStatus(t.db, e.id)).toMatchObject({
          status: "DEAD",
          lastError: "invalid_timestamp",
          attempts: 1,
        });
        expect(await count("message_status_events")).toBe(0);
        expect((await messageRow(message.id)).latest_status).toBeNull();
      },
    );

    it("two different statuses with the same timestamp are both kept and the priority decides the cache", async () => {
      const { org, account } = await tenant(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.SAMETS",
      });
      await deliverStatus(t.db, { id: "wamid.SAMETS", status: "read", timestamp: at(0) });
      await deliverStatus(t.db, { id: "wamid.SAMETS", status: "delivered", timestamp: at(0) });
      await processBoth(t.db);
      expect(await history("wamid.SAMETS")).toHaveLength(2);
      expect((await messageRow(message.id)).latest_status).toBe("READ");
    });

    it("a far-future timestamp is stored as sent, is flagged, and cannot touch any conversation or customer-service window", async () => {
      const { org, account } = await tenant(t.db);
      const { message, conversation } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.FUTURE",
        occurredAt: minutesAgo(600),
      });
      await t.pool.query(
        "update conversations set status='RESOLVED', resolved_at = now() - interval '5 hours', last_inbound_at = now() - interval '9 hours'",
      );
      const frozen = await conversationsSnapshot();
      const future = Math.floor(Date.now() / 1000) + 365 * 86_400;
      await deliverStatus(t.db, { id: "wamid.FUTURE", status: "read", timestamp: future });
      await processBoth(t.db);
      expect((await history("wamid.FUTURE"))[0].occurred_at).toEqual(ts(String(future)));
      // the cached status follows priority, not time: only the display timestamp carries the provider value
      expect(await messageRow(message.id)).toMatchObject({
        latest_status: "READ",
        latest_status_at: ts(String(future)),
      });
      expect(await conversationsSnapshot()).toEqual(frozen);
      expect(frozen[0]).toMatchObject({ id: conversation.id, status: "RESOLVED" });
      expect(logs.join("\n")).toContain("timestamp_future");
    });

    it("a far-future status cannot block a later, real status: priority, not time, wins", async () => {
      const { org, account } = await tenant(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.FUT2",
      });
      const future = Math.floor(Date.now() / 1000) + 365 * 86_400;
      await deliverStatus(t.db, { id: "wamid.FUT2", status: "delivered", timestamp: future });
      await processBoth(t.db);
      await deliverStatus(t.db, {
        id: "wamid.FUT2",
        status: "read",
        timestamp: epoch(minutesAgo(1)),
      });
      await processBoth(t.db);
      expect(await messageRow(message.id)).toMatchObject({
        latest_status: "READ",
        latest_status_at: ts(epoch(minutesAgo(1))),
      });
    });

    it("a stale timestamp (older than the retry window) is stored and flagged", async () => {
      const { org, account } = await tenant(t.db);
      await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.STALE",
      });
      await deliverStatus(t.db, {
        id: "wamid.STALE",
        status: "sent",
        timestamp: String(Math.floor(Date.now() / 1000) - 20 * 86_400),
      });
      await processBoth(t.db);
      expect(await history("wamid.STALE")).toHaveLength(1);
      expect(logs.join("\n")).toContain("timestamp_stale");
    });
  });

  // -------------------------------------------------------------------------------------- failure details
  describe("failed-status error details", () => {
    it("stores the first error's code and a bounded description from the official-shape payload, and nothing else", async () => {
      const { org, account } = await tenant(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.FAKE00000000000000000200",
      });
      await ingestFixture(t.db, "status-failed.json");
      await processBoth(t.db);
      const [h] = await history("wamid.FAKE00000000000000000200");
      expect(h).toMatchObject({
        error_code: "131049",
        error_message: "This message was not delivered to maintain healthy ecosystem engagement.",
      });
      expect(JSON.stringify(h)).not.toMatch(/href|error_data|In order to maintain/);
      expect((await messageRow(message.id)).error_code).toBe("131049");
    });

    it("missing optional error fields are fine; oversized, NUL-containing and nested provider text is bounded and cleaned", async () => {
      const { org, account } = await tenant(t.db);
      await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.ERRS",
      });
      await deliverStatus(t.db, { id: "wamid.ERRS", status: "failed", timestamp: at(0) }); // no errors at all
      await deliverStatus(t.db, {
        id: "wamid.ERRS",
        status: "failed",
        timestamp: at(1),
        extra: { errors: [{ code: 7 }] },
      }); // no text
      await deliverStatus(t.db, {
        id: "wamid.ERRS",
        status: "failed",
        timestamp: at(2),
        extra: {
          errors: [
            {
              code: "9".repeat(300),
              message: `a\u0000${"x".repeat(5000)}`,
              error_data: { details: { deep: [1] } },
            },
          ],
        },
      });
      expect(await processBoth(t.db)).toMatchObject({ claimed: 3, processed: 3 });
      const [none, codeOnly, long] = await history("wamid.ERRS");
      expect(none).toMatchObject({ error_code: null, error_message: null });
      expect(codeOnly).toMatchObject({ error_code: "7", error_message: null });
      expect(long.error_code).toHaveLength(64);
      expect(long.error_message).toHaveLength(500);
      expect(long.error_message.startsWith("ax")).toBe(true);
    });

    it("errors on a non-failed status are ignored, and no error text reaches the logs", async () => {
      const { org, account } = await tenant(t.db);
      const { message } = await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.NOERR",
      });
      await deliverStatus(t.db, {
        id: "wamid.NOERR",
        status: "delivered",
        timestamp: at(0),
        extra: { errors: [{ code: 5, message: "SECRET PROVIDER TEXT" }] },
      });
      await deliverStatus(t.db, {
        id: "wamid.NOERR",
        status: "failed",
        timestamp: at(9),
        extra: { errors: [{ code: 6, message: "ANOTHER SECRET TEXT" }] },
        recipient: "15550100321",
      });
      await processBoth(t.db);
      expect((await history("wamid.NOERR")).find((h) => h.status === "DELIVERED")).toMatchObject({
        error_code: null,
        error_message: null,
      });
      expect((await messageRow(message.id)).latest_status).toBe("DELIVERED");
      const all = logs.join("\n");
      for (const secret of [
        "SECRET PROVIDER TEXT",
        "ANOTHER SECRET TEXT",
        "15550100321",
        "wamid.NOERR",
      ])
        expect(all, secret).not.toContain(secret);
    });
  });

  // --------------------------------------------------------------------------------------- no side effects
  describe("a status is not customer activity", () => {
    it("never reopens a conversation, moves any conversation timestamp, or creates a contact, conversation, message, lead or consent", async () => {
      const { org, account } = await tenant(t.db);
      await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.QUIET",
        occurredAt: minutesAgo(300),
      });
      await t.pool.query(
        "update conversations set status='RESOLVED', resolved_at = now() - interval '2 hours'",
      );
      const frozen = {
        conversations: await conversationsSnapshot(),
        counts: await domainCounts(),
        contacts: await rows("select * from contacts order by id"),
      };
      for (const [i, s] of (["sent", "delivered", "read", "failed"] as const).entries())
        await deliverStatus(t.db, {
          id: "wamid.QUIET",
          status: s,
          timestamp: epoch(minutesAgo(10 - i)),
          recipient: "15550109999",
        });
      await deliverStatus(t.db, {
        id: "wamid.ORPHAN",
        status: "read",
        timestamp: epoch(minutesAgo(1)),
        recipient: "15550108888",
      });
      expect(await processBoth(t.db)).toMatchObject({ claimed: 5, processed: 5 });
      expect(await conversationsSnapshot()).toEqual(frozen.conversations);
      expect(await domainCounts()).toEqual(frozen.counts);
      expect(await rows("select * from contacts order by id")).toEqual(frozen.contacts);
      expect((await conversationsSnapshot())[0]).toMatchObject({ status: "RESOLVED" });
    });
  });

  // ------------------------------------------------------------------------------------ worker integration
  describe("worker integration", () => {
    it("the STATUS registry holds STATUS only; MESSAGE events are not claimed by it", async () => {
      expect(Object.keys(statusHandlers)).toEqual(["STATUS"]);
      await tenant(t.db);
      const text = Buffer.from(
        JSON.stringify({
          object: "whatsapp_business_account",
          entry: [
            {
              id: WABA,
              changes: [
                {
                  field: "messages",
                  value: {
                    metadata: { phone_number_id: PN },
                    contacts: [{ wa_id: "1", profile: {} }],
                    messages: [
                      {
                        from: "1",
                        id: "wamid.M",
                        timestamp: at(0),
                        type: "text",
                        text: { body: "hi" },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );
      const { ingestBytes } = await import("./testing");
      const [message] = await ingestBytes(t.db, text);
      expect(await processStatuses(t.db)).toMatchObject({ claimed: 0 });
      expect(await eventStatus(t.db, message!.id)).toMatchObject({
        status: "PENDING",
        attempts: 0,
      });
    });

    it("system (OTHER) events are never claimed by either registry", async () => {
      await tenant(t.db);
      const [system] = await ingestFixture(t.db, "system-user-changed-user-id.json");
      expect(await processBoth(t.db)).toMatchObject({ claimed: 0 });
      expect(await eventStatus(t.db, system!.id)).toMatchObject({ status: "IGNORED", attempts: 0 });
    });

    it("an account that is no longer ACTIVE is refused (transient) and nothing is written", async () => {
      const { org, account } = await tenant(t.db);
      await seedMessage(t.db, {
        organizationId: org.id,
        whatsappAccountId: account.id,
        wamid: "wamid.INACT",
      });
      const e = await deliverStatus(t.db, { id: "wamid.INACT", status: "read", timestamp: at(0) });
      await t.pool.query("update whatsapp_accounts set status = 'DISABLED'");
      await expect(handleStatusDirect(t.db, e)).rejects.toThrow("account_not_active");
      expect(await count("message_status_events")).toBe(0);
    });

    it("a trusted event whose organization does not own the account is refused", async () => {
      const other = await tenant(t.db, { pn: PN2, waba: WABA2 });
      await tenant(t.db);
      const e = await deliverStatus(t.db, { id: "wamid.XORG", status: "read", timestamp: at(0) });
      await expect(
        handleStatusDirect(t.db, { ...e, organizationId: other.org.id }),
      ).rejects.toThrow("account_not_active");
      expect(await count("message_status_events")).toBe(0);
    });

    it("the handler returns without touching the event: only the queue sets its final state", async () => {
      await tenant(t.db);
      const e = await deliverStatus(t.db, { id: "wamid.PLAIN", status: "sent", timestamp: at(0) });
      await handleStatusDirect(t.db, e);
      expect(await eventStatus(t.db, e.id)).toMatchObject({ status: "PENDING", attempts: 0 });
      expect(await count("message_status_events")).toBe(1);
    });

    it("an unsupported status value reaching the handler directly is a permanent failure", async () => {
      await tenant(t.db);
      const e = await deliverStatus(t.db, {
        id: "wamid.PLAYED",
        status: "played",
        timestamp: at(0),
      });
      await expect(handleStatusDirect(t.db, e)).rejects.toMatchObject({
        code: "unsupported_status",
      });
      expect(await count("message_status_events")).toBe(0);
    });
  });
});
