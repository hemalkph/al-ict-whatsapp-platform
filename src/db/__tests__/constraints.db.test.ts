import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "../index";
import {
  CHECK_VIOLATION,
  NOT_NULL_VIOLATION,
  UNIQUE_VIOLATION,
  createTestDatabase,
  expectPgError,
  seedAccount,
  seedContact,
  seedConversation,
  seedMessage,
  seedOrg,
  seedTag,
  seedWebhookEvent,
  seedWebhookRequest,
  seedWorld,
  type TestDb,
} from "./helpers";

const T0 = new Date("2026-01-01T00:00:00Z");

describe("uniqueness, idempotency and CHECK constraints", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  });
  afterAll(async () => t.close());

  describe("contacts", () => {
    it("rejects a duplicate WhatsApp ID within an organization", async () => {
      const org = await seedOrg(db);
      await seedContact(db, org.id, "94770000001");
      await expectPgError(
        seedContact(db, org.id, "94770000001"),
        UNIQUE_VIOLATION,
        "contacts_org_wa_id_unique",
      );
    });
    it("allows the same WhatsApp ID in different organizations", async () => {
      const a = await seedOrg(db);
      const b = await seedOrg(db);
      await seedContact(db, a.id, "94770000002");
      await seedContact(db, b.id, "94770000002");
    });
    it("allows only one conversation per (organization, account, contact)", async () => {
      const w = await seedWorld(db);
      await expectPgError(
        seedConversation(db, {
          organizationId: w.org.id,
          whatsappAccountId: w.account.id,
          contactId: w.contact.id,
        }),
        UNIQUE_VIOLATION,
        "conversations_org_account_contact_unique",
      );
    });
  });

  describe("whatsapp accounts", () => {
    it("keeps Meta phone number IDs globally unique (webhook routing key)", async () => {
      const a = await seedOrg(db);
      const b = await seedOrg(db);
      const first = await seedAccount(db, a.id);
      await expectPgError(
        db.insert(schema.whatsappAccounts).values({
          organizationId: b.id,
          wabaId: "w2",
          phoneNumberId: first.phoneNumberId,
          displayPhoneNumber: "+94",
        }),
        UNIQUE_VIOLATION,
        "whatsapp_accounts_phone_number_id_uidx",
      );
    });
  });

  describe("tags and contact_tags", () => {
    it("makes tag names unique per organization, case/whitespace-insensitively, via a generated key", async () => {
      const a = await seedOrg(db);
      const b = await seedOrg(db);
      const tag = await seedTag(db, a.id, "  Theory ");
      expect(tag.nameKey).toBe("theory");
      await expectPgError(
        seedTag(db, a.id, "THEORY"),
        UNIQUE_VIOLATION,
        "tags_org_name_key_unique",
      );
      await seedTag(db, b.id, "THEORY"); // other org: fine
    });
    it("uses an organization-aware primary key", async () => {
      const w = await seedWorld(db);
      const tag = await seedTag(db, w.org.id);
      const row = { organizationId: w.org.id, contactId: w.contact.id, tagId: tag.id };
      await db.insert(schema.contactTags).values(row);
      await expectPgError(
        db.insert(schema.contactTags).values(row),
        UNIQUE_VIOLATION,
        "contact_tags_pk",
      );
      const pk = await t.pool.query(
        `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
         where i.indrelid = 'contact_tags'::regclass and i.indisprimary order by array_position(i.indkey, a.attnum)`,
      );
      expect(pk.rows.map((r) => r.attname)).toEqual(["organization_id", "contact_id", "tag_id"]);
    });
  });

  describe("message duplicate protection", () => {
    it("rejects a duplicate wamid for the same organization+account, allows it for another account, allows many NULL wamids", async () => {
      const w = await seedWorld(db);
      const account2 = await seedAccount(db, w.org.id);
      const contact2 = await seedContact(db, w.org.id);
      const conv2 = await seedConversation(db, {
        organizationId: w.org.id,
        whatsappAccountId: account2.id,
        contactId: contact2.id,
      });
      const base = {
        organizationId: w.org.id,
        conversationId: w.conversation.id,
        whatsappAccountId: w.account.id,
      };
      await seedMessage(db, { ...base, wamid: "wamid.DUP" });
      await expectPgError(
        seedMessage(db, { ...base, wamid: "wamid.DUP" }),
        UNIQUE_VIOLATION,
        "messages_account_wamid_uidx",
      );
      await seedMessage(db, {
        organizationId: w.org.id,
        conversationId: conv2.id,
        whatsappAccountId: account2.id,
        wamid: "wamid.DUP",
      });
      await seedMessage(db, { ...base, wamid: null });
      await seedMessage(db, { ...base, wamid: null });
    });
    it("rejects a duplicate outbound client_request_id within an organization", async () => {
      const w = await seedWorld(db);
      const base = {
        organizationId: w.org.id,
        conversationId: w.conversation.id,
        whatsappAccountId: w.account.id,
      };
      await seedMessage(db, { ...base, clientRequestId: "req-1" });
      await expectPgError(
        seedMessage(db, { ...base, clientRequestId: "req-1" }),
        UNIQUE_VIOLATION,
        "messages_client_request_uidx",
      );
    });
  });

  describe("webhook idempotency", () => {
    it("rejects a duplicate idempotency key and supports ON CONFLICT DO NOTHING", async () => {
      await seedWebhookEvent(db, { key: "msg:pn1:wamid.A" });
      await expectPgError(
        seedWebhookEvent(db, { key: "msg:pn1:wamid.A" }),
        UNIQUE_VIOLATION,
        "webhook_events_idempotency_key_unique",
      );
      const req = await seedWebhookRequest(db);
      const attempt = () =>
        db
          .insert(schema.webhookEvents)
          .values({
            requestId: req.id,
            eventType: "MESSAGE",
            idempotencyKey: "msg:pn1:wamid.A",
            payload: {},
          })
          .onConflictDoNothing({ target: schema.webhookEvents.idempotencyKey })
          .returning({ id: schema.webhookEvents.id });
      expect(await attempt()).toEqual([]); // duplicate delivery silently ignored
    });
    it("keeps keys scoped by routing: same event body on two numbers yields two distinct events", async () => {
      await seedWebhookEvent(db, { key: "hash:OTHER:pn1:abc" });
      await seedWebhookEvent(db, { key: "hash:OTHER:pn2:abc" });
    });
  });

  describe("CHECK constraints", () => {
    const bad = (v: string) => v as never;

    it("rejects invalid enumerated values", async () => {
      const w = await seedWorld(db);
      const org = w.org.id;
      const base = {
        organizationId: org,
        conversationId: w.conversation.id,
        whatsappAccountId: w.account.id,
      };
      const cases: Array<[string, string, () => Promise<unknown>]> = [
        [
          "leads_status_check",
          "lead",
          () =>
            db
              .insert(schema.leads)
              .values({ organizationId: org, contactId: w.contact.id, status: bad("BOGUS") }),
        ],
        [
          "conversations_status_check",
          "conv",
          async () => {
            const c = await seedContact(db, org);
            return db.insert(schema.conversations).values({
              organizationId: org,
              whatsappAccountId: w.account.id,
              contactId: c.id,
              lastMessageAt: T0,
              status: bad("BOGUS"),
            });
          },
        ],
        [
          "messages_direction_check",
          "dir",
          () => seedMessage(db, { ...base, direction: bad("SIDEWAYS") }),
        ],
        [
          "messages_latest_status_check",
          "latest",
          () =>
            db.insert(schema.messages).values({
              ...base,
              direction: "OUTBOUND",
              type: "TEXT",
              occurredAt: T0,
              latestStatus: bad("PENDING"),
            }),
        ],
        [
          "contact_consents_action_check",
          "action",
          () =>
            db.insert(schema.contactConsents).values({
              organizationId: org,
              contactId: w.contact.id,
              scope: "MARKETING",
              action: bad("MAYBE"),
              source: "META_AD",
              occurredAt: T0,
            }),
        ],
        [
          "contact_consents_source_check",
          "source",
          () =>
            db.insert(schema.contactConsents).values({
              organizationId: org,
              contactId: w.contact.id,
              scope: "MARKETING",
              action: "GRANTED",
              source: bad("TELEPATHY"),
              occurredAt: T0,
            }),
        ],
        [
          "contact_consents_scope_check",
          "scope",
          () =>
            db.insert(schema.contactConsents).values({
              organizationId: org,
              contactId: w.contact.id,
              scope: bad("UTILITY"),
              action: "GRANTED",
              source: "META_AD",
              occurredAt: T0,
            }),
        ],
        [
          "contacts_marketing_consent_status_check",
          "cstatus",
          () => db.update(schema.contacts).set({ marketingConsentStatus: bad("YES") }),
        ],
        [
          "whatsapp_accounts_status_check",
          "acct",
          () => db.update(schema.whatsappAccounts).set({ status: bad("BOGUS") }),
        ],
        ["webhook_events_status_check", "wh", () => seedWebhookEvent(db, { status: "BOGUS" })],
        [
          "message_attachments_storage_status_check",
          "att",
          async () => {
            const m = await seedMessage(db, base);
            return db
              .insert(schema.messageAttachments)
              .values({ organizationId: org, messageId: m.id, storageStatus: bad("BOGUS") });
          },
        ],
        [
          "lead_attributions_source_type_check",
          "attr",
          () =>
            db.insert(schema.leadAttributions).values({
              organizationId: org,
              contactId: w.contact.id,
              sourceType: bad("SMOKE_SIGNAL"),
              receivedAt: T0,
            }),
        ],
        [
          "message_status_events_status_check",
          "mse",
          () =>
            db.insert(schema.messageStatusEvents).values({
              organizationId: org,
              whatsappAccountId: w.account.id,
              wamid: "x",
              status: bad("PENDING"),
              occurredAt: T0,
            }),
        ],
      ];
      for (const [constraint, , run] of cases) {
        await expectPgError(Promise.resolve().then(run), CHECK_VIOLATION, constraint);
      }
    });

    it("conversations.last_message_at has no default and must be set explicitly", async () => {
      const w = await seedWorld(db);
      const c = await seedContact(db, w.org.id);
      await expectPgError(
        db.execute(
          sql`insert into conversations (organization_id, whatsapp_account_id, contact_id) values (${w.org.id}, ${w.account.id}, ${c.id})`,
        ),
        NOT_NULL_VIOLATION,
      );
    });

    it("keeps lead status values aligned with the TS list (all accepted)", async () => {
      const w = await seedWorld(db);
      for (const status of schema.LEAD_STATUSES) {
        await db
          .insert(schema.leads)
          .values({ organizationId: w.org.id, contactId: w.contact.id, status });
      }
      const n = await t.pool.query("select count(*)::int n from leads where contact_id = $1", [
        w.contact.id,
      ]);
      expect(n.rows[0].n).toBe(schema.LEAD_STATUSES.length);
    });
  });
});
