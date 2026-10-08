import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Database } from "@/db";
import { createTestDatabase, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import { useGlobalAuth } from "@/db/__tests__/real-auth";
import { MAX_WEBHOOK_BODY_BYTES } from "./body";
import { handleWebhookPost } from "./handler";
import { sha256Hex } from "./idempotency";
import {
  TEST_APP_SECRET,
  TEST_VERIFY_TOKEN,
  WEBHOOK_URL,
  fixture,
  sign,
  webhookPost,
} from "./testing";
import type { AccountLookup, AccountRow } from "./routing";

// The REAL route handlers against REAL PostgreSQL (migrations 0000-0002). The webhook stores a verified delivery and its
// per-item events, routes them, acknowledges, and does NOTHING else: every test also asserts that no contact,
// conversation, message, status, lead or alias row exists.

const PN = "100000000000001";
const WABA = "200000000000001";
const PN2 = "100000000000002";
const WABA2 = "200000000000002";
type Payload = { pairing: string; message: { text: { body: string } } };
const DOMAIN_TABLES = [
  "contacts",
  "contact_consents",
  "contact_bsuids",
  "conversations",
  "messages",
  "message_status_events",
  "message_attachments",
  "leads",
  "lead_attributions",
  "tags",
  "contact_tags",
];

describe("webhook ingest (route -> PostgreSQL)", () => {
  let t: TestDb;
  let release: () => Promise<void>;
  let route: typeof import("../../app/api/webhooks/whatsapp/route");
  const logs: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    release = useGlobalAuth(t);
    process.env.META_APP_SECRET = TEST_APP_SECRET;
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = TEST_VERIFY_TOKEN;
    route = await import("../../app/api/webhooks/whatsapp/route");
  });
  afterAll(async () => {
    delete process.env.META_APP_SECRET;
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    await release();
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
      expect(r.rows[0].n, `${table} must stay empty: the webhook creates no domain rows`).toBe(0);
    }
  });

  // ----------------------------------------------------------------------------------------------- helpers
  async function account(
    o: {
      phoneNumberId?: string;
      wabaId?: string;
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
        wabaId: o.wabaId ?? WABA,
        phoneNumberId: o.phoneNumberId ?? PN,
        displayPhoneNumber: "15550100001",
        status: o.status ?? "ACTIVE",
        archivedAt: o.archived ? new Date() : null,
      })
      .returning();
    return row!;
  }
  const post = (bytes: Uint8Array | string, options?: Parameters<typeof webhookPost>[1]) =>
    route.POST(webhookPost(bytes, options));
  const requests = async () =>
    (
      await t.pool.query(
        "select id, raw_body, payload_sha256, ingest_status, ingest_error_code from webhook_requests order by created_at, id",
      )
    ).rows as Array<{
      id: string;
      raw_body: Buffer;
      payload_sha256: string;
      ingest_status: string;
      ingest_error_code: string | null;
    }>;
  const events = async () =>
    (
      await t.pool.query(
        `select request_id, organization_id, whatsapp_account_id, event_type, provider_object_id, idempotency_key,
                payload, status, attempts, last_error, locked_at, processed_at
           from webhook_events order by created_at, id`,
      )
    ).rows as Array<{
      request_id: string;
      organization_id: string | null;
      whatsapp_account_id: string | null;
      event_type: string;
      provider_object_id: string | null;
      idempotency_key: string;
      payload: Payload;
      status: string;
      attempts: number;
      last_error: string | null;
      locked_at: Date | null;
      processed_at: Date | null;
    }>;
  const counts = async () => [(await requests()).length, (await events()).length];
  const stream = (total: number, chunk = 64 * 1024) => {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) return controller.close();
        const size = Math.min(chunk, total - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size).fill(0x20));
      },
    });
  };
  const message = (id: string, extra: Record<string, unknown> = {}) => ({
    from: "15550100123",
    id,
    timestamp: "1790000000",
    type: "text",
    text: { body: `hello ${id}` },
    ...extra,
  });
  const delivery = (
    entries: Array<{ waba: string; pn: string; messages?: unknown[]; statuses?: unknown[] }>,
  ) =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: entries.map((e) => ({
        id: e.waba,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550100001", phone_number_id: e.pn },
              contacts: [{ profile: { name: "Test Student" }, wa_id: "15550100123" }],
              ...(e.messages ? { messages: e.messages } : {}),
              ...(e.statuses ? { statuses: e.statuses } : {}),
            },
          },
        ],
      })),
    });

  // ------------------------------------------------------------------------------ normal ingest + exact bytes
  describe("a normal verified delivery", () => {
    it("stores the exact bytes and their SHA-256, then one routed PENDING event, and acknowledges", async () => {
      const acc = await account();
      const body = fixture("text-phone.json");
      const res = await post(body);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");

      const [request] = await requests();
      expect(await requests()).toHaveLength(1);
      expect(request!.ingest_status).toBe("ACCEPTED");
      expect(request!.ingest_error_code).toBeNull();
      expect(Buffer.compare(request!.raw_body, body)).toBe(0);
      expect(request!.payload_sha256).toBe(sha256Hex(body));
      const sql = await t.pool.query(
        "select encode(sha256(raw_body), 'hex') as h, octet_length(raw_body) as n from webhook_requests",
      );
      expect(sql.rows[0]).toEqual({ h: sha256Hex(body), n: body.length });

      const [event] = await events();
      expect(await events()).toHaveLength(1);
      expect(event).toMatchObject({
        request_id: request!.id,
        organization_id: acc.organizationId,
        whatsapp_account_id: acc.id,
        event_type: "MESSAGE",
        provider_object_id: "wamid.FAKE00000000000000000001",
        idempotency_key: `wa:msg:v1:${PN}:wamid.FAKE00000000000000000001`,
        status: "PENDING",
        attempts: 0,
        last_error: null,
        locked_at: null,
        processed_at: null,
      });
      expect(event!.payload.message.text.body).toBe("Does the ICT class start in January?");
      expect(event!.payload.pairing).toBe("wa_id");
    });

    it("keeps different byte forms of the same JSON as different requests, with identical idempotency by meaning", async () => {
      await account();
      const literal = fixture("text-sinhala-raw-utf8.json");
      const escaped = fixture("text-sinhala-escaped.json");
      expect((await post(literal)).status).toBe(200);
      expect((await post(escaped)).status).toBe(200);
      const rows = await requests();
      expect(rows).toHaveLength(2);
      expect(Buffer.compare(rows[0]!.raw_body, literal)).toBe(0);
      expect(Buffer.compare(rows[1]!.raw_body, escaped)).toBe(0);
      expect(rows[0]!.payload_sha256).not.toBe(rows[1]!.payload_sha256);
      expect(await events()).toHaveLength(1); // the same message, delivered twice in two spellings
    });

    it("never takes the organization from the body: a forged organization in the payload is ignored", async () => {
      const acc = await account();
      const other = await seedOrg(t.db);
      const body = delivery([
        {
          waba: WABA,
          pn: PN,
          messages: [message("w-forged", { organization_id: other.id, organizationId: other.id })],
        },
      ]);
      expect((await post(body)).status).toBe(200);
      const [event] = await events();
      expect(event!.organization_id).toBe(acc.organizationId);
      expect(event!.organization_id).not.toBe(other.id);
    });

    it("expands one delivery into one event per message and per status, across entries and numbers", async () => {
      const a = await account();
      const b = await account({ phoneNumberId: PN2, wabaId: WABA2 });
      expect((await post(fixture("multi-event-request.json"))).status).toBe(200);
      const rows = await events();
      // events written by one statement share a timestamp, so compare without relying on their order
      const shape = rows
        .map((r) => [
          r.event_type,
          r.status,
          r.organization_id === a.organizationId
            ? "A"
            : r.organization_id === b.organizationId
              ? "B"
              : "?",
        ])
        .map((t) => t.join("/"))
        .sort();
      expect(shape).toEqual(["MESSAGE/PENDING/A", "MESSAGE/PENDING/B", "STATUS/PENDING/A"]);
      expect(new Set(rows.map((r) => r.request_id)).size).toBe(1);
    });

    it("stores every official-derived fixture without creating anything but request and event rows", async () => {
      await account();
      let delivered = 0;
      for (const name of [
        "text-bsuid-only-username.json",
        "image.json",
        "video.json",
        "audio-voice.json",
        "document.json",
        "sticker.json",
        "location.json",
        "contacts-shared.json",
        "interactive-button-reply.json",
        "interactive-list-reply.json",
        "button-quick-reply.json",
        "reaction.json",
        "reaction-removed.json",
        "reply-context-product.json",
        "referral-ctwa-text.json",
        "unsupported-edit.json",
        "status-delivered-phone-bsuid.json",
        "status-delivered-bsuid-only.json",
        "status-failed.json",
        "unknown-type.json",
      ]) {
        expect((await post(fixture(name))).status, name).toBe(200);
        delivered++;
      }
      expect((await requests()).filter((r) => r.ingest_status === "ACCEPTED")).toHaveLength(
        delivered,
      );
      expect((await events()).length).toBeGreaterThanOrEqual(delivered - 3); // a few fixtures share a wamid or status key
    });
  });

  // ----------------------------------------------------------------------------------------------- routing
  describe("routing by phone_number_id", () => {
    const post1 = () => post(fixture("text-phone.json"));

    it("holds an event for a PENDING account (UNROUTABLE) and KEEPS its tenant provenance", async () => {
      const acc = await account({ status: "PENDING" });
      await post1();
      expect((await events())[0]).toMatchObject({
        status: "UNROUTABLE",
        last_error: "account_pending",
        organization_id: acc.organizationId,
        whatsapp_account_id: acc.id,
      });
    });

    it("ignores events for a DISABLED account, keeping the routing", async () => {
      const acc = await account({ status: "DISABLED" });
      await post1();
      expect((await events())[0]).toMatchObject({
        status: "IGNORED",
        last_error: "account_disabled",
        organization_id: acc.organizationId,
        whatsapp_account_id: acc.id,
      });
    });

    it("ignores events for an archived account, keeping the routing", async () => {
      const acc = await account({ archived: true });
      await post1();
      expect((await events())[0]).toMatchObject({
        status: "IGNORED",
        last_error: "account_archived",
        organization_id: acc.organizationId,
        whatsapp_account_id: acc.id,
      });
    });

    it("holds an unknown phone_number_id as UNROUTABLE", async () => {
      await account({ phoneNumberId: "100000000000777" });
      await post1();
      expect((await events())[0]).toMatchObject({
        status: "UNROUTABLE",
        last_error: "unknown_account",
        organization_id: null,
        whatsapp_account_id: null,
      });
    });

    it("never routes into another organization's account: an event only ever matches by its own phone_number_id", async () => {
      const a = await account({ phoneNumberId: PN, wabaId: WABA });
      await account({ phoneNumberId: PN2, wabaId: WABA2 });
      await post1();
      expect((await events())[0]!.organization_id).toBe(a.organizationId);
    });

    it("treats a WABA mismatch conservatively: held, not routed, not dropped", async () => {
      await account({ wabaId: "200000000000999" });
      await post1();
      const [event] = await events();
      expect(event).toMatchObject({
        status: "UNROUTABLE",
        last_error: "waba_mismatch",
        organization_id: null,
        whatsapp_account_id: null,
      });
      expect(event!.payload.message).toBeDefined(); // the item is preserved for a later, deliberate release
    });

    it("ignores a `played` status and a system message but keeps them", async () => {
      const acc = await account();
      await post(fixture("status-played.json"));
      await post(fixture("system-user-changed-user-id.json"));
      const rows = await events();
      expect(rows.map((r) => [r.event_type, r.status, r.last_error, r.organization_id])).toEqual([
        ["STATUS", "IGNORED", "status_not_mirrored", acc.organizationId],
        ["OTHER", "IGNORED", "system_message_pending_h1", acc.organizationId],
      ]);
    });

    it("stores a malformed element as DEAD instead of dropping the request", async () => {
      await account();
      await post(
        delivery([
          { waba: WABA, pn: PN, messages: [{ from: "1", type: "text" }, message("w-ok")] },
        ]),
      );
      const rows = (await events()).map((r) => `${r.status}/${r.last_error}`).sort();
      expect(rows).toEqual(["DEAD/malformed_event", "PENDING/null"]);
    });
  });

  // ----------------------------------------------------------------------------------------------- idempotency
  describe("idempotency and duplicates", () => {
    it("retains a duplicate delivery's request row but adds no duplicate event", async () => {
      await account();
      const body = fixture("text-phone.json");
      expect((await post(body)).status).toBe(200);
      expect((await post(body)).status).toBe(200);
      expect(await counts()).toEqual([2, 1]);
    });

    it("collapses concurrent identical deliveries to one event", async () => {
      await account();
      const body = fixture("text-phone.json");
      const results = await Promise.all(Array.from({ length: 6 }, () => post(body)));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(await counts()).toEqual([6, 1]);
    });

    it("inserts only the new child when one item is a duplicate and another is new", async () => {
      await account();
      await post(delivery([{ waba: WABA, pn: PN, messages: [message("w-1")] }]));
      await post(delivery([{ waba: WABA, pn: PN, messages: [message("w-1"), message("w-2")] }]));
      const rows = await events();
      expect(rows.map((r) => r.provider_object_id).sort()).toEqual(["w-1", "w-2"]);
      const byRequest = new Map<string, number>();
      for (const r of rows) byRequest.set(r.request_id, (byRequest.get(r.request_id) ?? 0) + 1);
      expect([...byRequest.values()].sort()).toEqual([1, 1]); // the second request contributed exactly one child
    });

    it("keeps the same wamid under two phone_number_ids as two events", async () => {
      await account();
      await account({ phoneNumberId: PN2, wabaId: WABA2 });
      expect((await post(fixture("same-message-two-numbers.json"))).status).toBe(200);
      const rows = await events();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(2);
      expect(new Set(rows.map((r) => r.organization_id)).size).toBe(2);
    });

    it("collapses a duplicated status but keeps a different status for the same message", async () => {
      await account();
      await post(fixture("status-delivered-phone-bsuid.json"));
      await post(fixture("status-delivered-phone-bsuid.json"));
      await post(fixture("status-read.json"));
      expect((await events()).map((r) => r.idempotency_key)).toEqual([
        `wa:status:v1:${PN}:wamid.FAKE00000000000000000200:delivered:1790000000`,
        `wa:status:v1:${PN}:wamid.FAKE00000000000000000200:read:1790000000`,
      ]);
    });

    it("collapses the same item twice inside one delivery", async () => {
      await account();
      await post(delivery([{ waba: WABA, pn: PN, messages: [message("w-1"), message("w-1")] }]));
      expect(await counts()).toEqual([1, 1]);
    });

    it("collapses a repeated OTHER item by meaning, not by spelling", async () => {
      await account();
      const a = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ id: WABA, changes: [{ field: "account_alerts", value: { b: 1, a: 2 } }] }],
      });
      const b = JSON.stringify(
        {
          entry: [{ changes: [{ value: { a: 2, b: 1 }, field: "account_alerts" }], id: WABA }],
          object: "whatsapp_business_account",
        },
        null,
        3,
      );
      await post(a);
      await post(b);
      expect(await counts()).toEqual([2, 1]);
    });
  });

  // ------------------------------------------------------------------ unparseable / unsupported / empty
  describe("signed content that cannot become events", () => {
    it.each([
      ["invalid JSON", "invalid-json.txt", "UNPARSEABLE", "invalid_json"],
      ["invalid UTF-8", "invalid-utf8.bin", "UNPARSEABLE", "invalid_utf8"],
      ["an unsupported envelope", "not-an-envelope.json", "UNSUPPORTED_SHAPE", "unexpected_object"],
    ])(
      "retains the exact bytes of %s, marks the state, creates no events and acknowledges",
      async (_name, file, status, code) => {
        const body = fixture(file);
        const res = await post(body);
        expect(res.status).toBe(200);
        const rows = await requests();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ ingest_status: status, ingest_error_code: code });
        expect(Buffer.compare(rows[0]!.raw_body, body)).toBe(0);
        expect(rows[0]!.payload_sha256).toBe(sha256Hex(body));
        expect(await events()).toHaveLength(0);
      },
    );

    it("accepts an empty entry list as ACCEPTED with no events", async () => {
      expect((await post(fixture("empty-entry.json"))).status).toBe(200);
      expect((await requests())[0]).toMatchObject({
        ingest_status: "ACCEPTED",
        ingest_error_code: null,
      });
      expect(await events()).toHaveLength(0);
    });

    it("stores a body that PostgreSQL could not hold as text (NUL byte, bare invalid bytes) byte for byte", async () => {
      const body = Buffer.from([0x7b, 0x00, 0xff, 0xfe, 0x80, 0x7d]);
      expect((await post(body)).status).toBe(200);
      const [row] = await requests();
      expect(Buffer.compare(row!.raw_body, body)).toBe(0);
      expect(row!.ingest_status).toBe("UNPARSEABLE");
    });

    it("stores a signed empty body as UNPARSEABLE", async () => {
      expect((await post(new Uint8Array(0))).status).toBe(200);
      expect((await requests())[0]).toMatchObject({
        ingest_status: "UNPARSEABLE",
        ingest_error_code: "invalid_json",
      });
    });

    it("strips a JSON \\u0000 escape from the stored event copy while the raw body keeps it", async () => {
      await account();
      const body = fixture("text-with-nul-escape.json");
      expect((await post(body)).status).toBe(200);
      expect((await events())[0]!.payload.message.text.body).toBe("beforeafter");
      expect((await requests())[0]!.raw_body.toString("utf8")).toContain("\\u0000");
    });

    it("never fails on absurdly nested JSON: the request is retained and acknowledged", async () => {
      await account();
      const depth = 150_000;
      const nested = "[".repeat(depth) + "]".repeat(depth);
      const body = `{"object":"whatsapp_business_account","entry":[{"id":"${WABA}","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"${PN}"},"messages":[{"id":"w-deep","type":"text","text":${nested}}]}}]}]}`;
      const res = await post(body);
      expect(res.status).toBe(200);
      const [row] = await requests();
      expect(["ACCEPTED", "EVENTS_REJECTED"]).toContain(row!.ingest_status);
      expect(row!.raw_body.length).toBe(Buffer.byteLength(body));
    });
  });

  // ------------------------------------------------------------------------------------ refusals store nothing
  describe("refused deliveries create zero rows", () => {
    const body = () => fixture("text-phone.json");

    it("rejects a missing, malformed or wrong signature with 403 and stores nothing", async () => {
      await account();
      for (const signature of [null, "", "sha256=zz", sign(body(), "wrong-secret-0123456789")]) {
        expect((await post(body(), { signature })).status).toBe(403);
      }
      expect(await counts()).toEqual([0, 0]);
    });

    it("rejects a signature over different bytes (raw-byte rule through the real route)", async () => {
      await account();
      const literal = fixture("text-sinhala-raw-utf8.json");
      const escaped = fixture("text-sinhala-escaped.json");
      expect((await post(escaped, { signature: sign(literal) })).status).toBe(403);
      expect((await post(literal, { signature: sign(escaped) })).status).toBe(403);
      expect(await counts()).toEqual([0, 0]);
    });

    it("rejects an oversized declared length with 413 and stores nothing", async () => {
      const res = await post(body(), {
        headers: { "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1) },
      });
      expect(res.status).toBe(413);
      expect(await counts()).toEqual([0, 0]);
    });

    it("rejects an oversized streamed body with 413 and stores nothing (not even a partial body)", async () => {
      const request = new Request(WEBHOOK_URL, {
        method: "POST",
        body: stream(MAX_WEBHOOK_BODY_BYTES + 1),
        duplex: "half",
        headers: { "x-hub-signature-256": sign(new Uint8Array(1)) },
      } as RequestInit);
      expect((await route.POST(request)).status).toBe(413);
      expect(await counts()).toEqual([0, 0]);
    });

    it("accepts a body of exactly the limit (it is then judged on its content, here: unparseable)", async () => {
      const exact = Buffer.alloc(MAX_WEBHOOK_BODY_BYTES, 0x20);
      expect((await post(exact)).status).toBe(200);
      const [row] = await requests();
      expect(row!.raw_body.length).toBe(MAX_WEBHOOK_BODY_BYTES);
      expect(row!.ingest_status).toBe("UNPARSEABLE");
    });
  });

  // ------------------------------------------------------------------------------ deterministic vs transient
  describe("failure policy", () => {
    const failingLookup =
      (rows: Map<string, AccountRow>): AccountLookup =>
      async () =>
        rows;
    const bogus = (phoneNumberId: string, wabaId: string): AccountRow => ({
      id: randomUUID(),
      organizationId: randomUUID(),
      wabaId,
      phoneNumberId,
      status: "ACTIVE",
      archivedAt: null,
    });

    it("keeps the request as EVENTS_REJECTED, creates no events and still acknowledges when the children deterministically fail", async () => {
      // The lookup returns an account that does not exist: inserting routed events violates the composite foreign key.
      const lookup = failingLookup(new Map([[PN, bogus(PN, WABA)]]));
      const res = await handleWebhookPost(webhookPost(fixture("text-phone.json")), {
        db: t.db,
        lookupAccounts: lookup,
      });
      expect(res.status).toBe(200);
      const [row] = await requests();
      expect(await requests()).toHaveLength(1);
      expect(row).toMatchObject({
        ingest_status: "EVENTS_REJECTED",
        ingest_error_code: "event_insert_data_error",
      });
      expect(Buffer.compare(row!.raw_body, fixture("text-phone.json"))).toBe(0);
      expect(await events()).toHaveLength(0);
    });

    it("leaves NO half-created events when a later chunk fails after an earlier chunk was inserted", async () => {
      const real = await account();
      const many = Array.from({ length: 500 }, (_, i) => message(`w-many-${i}`));
      const body = delivery([
        { waba: WABA, pn: PN, messages: many },
        { waba: "200000000000099", pn: "100000000000099", messages: [message("w-bad")] },
      ]);
      const rows = new Map<string, AccountRow>([
        [
          PN,
          {
            id: real.id,
            organizationId: real.organizationId,
            wabaId: WABA,
            phoneNumberId: PN,
            status: "ACTIVE",
            archivedAt: null,
          },
        ],
        ["100000000000099", bogus("100000000000099", "200000000000099")],
      ]);
      const res = await handleWebhookPost(webhookPost(body), {
        db: t.db,
        lookupAccounts: failingLookup(rows),
      });
      expect(res.status).toBe(200);
      expect((await requests())[0]).toMatchObject({ ingest_status: "EVENTS_REJECTED" });
      expect(await events()).toHaveLength(0); // the first 500 were rolled back with the savepoint
    });

    it("answers 500 and stores NOTHING when the database is unavailable (no false success)", async () => {
      const broken = {
        transaction: async () => {
          throw new Error("connection terminated unexpectedly");
        },
        insert: () => {
          throw new Error("connection terminated unexpectedly");
        },
      } as unknown as Database;
      for (const file of ["text-phone.json", "invalid-json.txt"]) {
        const res = await handleWebhookPost(webhookPost(fixture(file)), { db: broken });
        expect(res.status, file).toBe(500);
        expect(await res.text()).toBe("");
      }
      expect(await counts()).toEqual([0, 0]);
    });

    it.each([
      ["a deadlock", Object.assign(new Error("deadlock detected"), { code: "40P01" })],
      [
        "a serialization failure",
        Object.assign(new Error("could not serialize"), { code: "40001" }),
      ],
      ["a statement timeout", Object.assign(new Error("canceling statement"), { code: "57014" })],
      ["a connection failure", Object.assign(new Error("connection failure"), { code: "08006" })],
      ["a plain error", new Error("boom")],
    ])(
      "rolls back the raw request too and answers 500 on %s after the request row was written",
      async (_name, error) => {
        await account();
        const lookup: AccountLookup = async () => {
          throw error;
        };
        const res = await handleWebhookPost(webhookPost(fixture("text-phone.json")), {
          db: t.db,
          lookupAccounts: lookup,
        });
        expect(res.status).toBe(500);
        expect(await counts()).toEqual([0, 0]); // Meta will retry; nothing half-stored
      },
    );

    it("logs a storage failure by reason code only", async () => {
      const broken = {
        transaction: async () => {
          throw new Error("password=hunter2 host=db.internal");
        },
      } as unknown as Database;
      await handleWebhookPost(webhookPost(fixture("text-phone.json")), { db: broken });
      const output = logs.join("\n");
      expect(output).toContain("webhook.ingest_failed");
      expect(output).not.toContain("hunter2");
      expect(output).not.toContain("db.internal");
    });
  });

  // ---------------------------------------------------------------------------------------------------- logs
  it("writes nothing sensitive to the logs across accepted, refused and failed deliveries", async () => {
    await account();
    const body = fixture("text-phone.json");
    const bad = sign(body, "another-secret-0123456789");
    await post(body);
    await post(body, { signature: bad });
    await post(fixture("invalid-json.txt"));
    await route.GET(
      new Request(
        `${WEBHOOK_URL}?hub.mode=subscribe&hub.verify_token=SUPPLIED-WRONG-0123456789012345678&hub.challenge=1`,
      ),
    );
    const output = logs.join("\n");
    expect(output).toContain("webhook.request_accepted");
    for (const forbidden of [
      TEST_APP_SECRET,
      TEST_VERIFY_TOKEN,
      "SUPPLIED-WRONG",
      bad,
      bad.slice(7),
      sign(body),
      sign(body).slice(7),
      "Does the ICT class",
      "Test Student",
      "15550100123",
      "wamid.FAKE",
      "LK.1000",
      "raw_body",
      "x-hub-signature",
    ]) {
      expect(output, forbidden).not.toContain(forbidden);
    }
    for (const line of logs) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("does not need the global route to work with an injected database (route and handler agree)", async () => {
    await account();
    const body = fixture("text-phone.json");
    expect((await handleWebhookPost(webhookPost(body), { db: t.db })).status).toBe(200);
    expect(await counts()).toEqual([1, 1]);
  });
});
