import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "../index";
import {
  CHECK_VIOLATION,
  FK_VIOLATION,
  createTestDatabase,
  expectPgError,
  seedAccount,
  seedContact,
  seedConversation,
  seedLead,
  seedMessage,
  seedOrg,
  seedTag,
  seedWebhookEvent,
  seedWorld,
  type TestDb,
} from "./helpers";

const T0 = new Date("2026-01-01T00:00:00Z");

describe("tenant isolation (composite organization-aware FKs)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  });
  afterAll(async () => t.close());

  it("rejects a consent event in org B for a contact of org A", async () => {
    const a = await seedWorld(db);
    const b = await seedOrg(db);
    await expectPgError(
      db.insert(schema.contactConsents).values({
        organizationId: b.id,
        contactId: a.contact.id,
        scope: "MARKETING",
        action: "GRANTED",
        source: "META_AD",
        occurredAt: T0,
      }),
      FK_VIOLATION,
      "contact_consents_org_contact_fk",
    );
  });

  it("rejects a conversation that points at another organization's contact or account", async () => {
    const a = await seedWorld(db);
    const b = await seedWorld(db);
    await expectPgError(
      db.insert(schema.conversations).values({
        organizationId: b.org.id,
        whatsappAccountId: b.account.id,
        contactId: a.contact.id,
        lastMessageAt: T0,
      }),
      FK_VIOLATION,
      "conversations_org_contact_fk",
    );
    const contact2 = await seedContact(db, b.org.id);
    await expectPgError(
      db.insert(schema.conversations).values({
        organizationId: b.org.id,
        whatsappAccountId: a.account.id,
        contactId: contact2.id,
        lastMessageAt: T0,
      }),
      FK_VIOLATION,
      "conversations_org_account_fk",
    );
  });

  it("rejects a message in org B for a conversation of org A", async () => {
    const a = await seedWorld(db);
    const b = await seedWorld(db);
    await expectPgError(
      seedMessage(db, {
        organizationId: b.org.id,
        conversationId: a.conversation.id,
        whatsappAccountId: a.account.id,
      }),
      FK_VIOLATION,
      "messages_org_conversation_account_fk",
    );
  });

  it("rejects an attachment in org B for a message of org A", async () => {
    const a = await seedWorld(db);
    const msg = await seedMessage(db, {
      organizationId: a.org.id,
      conversationId: a.conversation.id,
      whatsappAccountId: a.account.id,
    });
    const b = await seedOrg(db);
    await expectPgError(
      db.insert(schema.messageAttachments).values({ organizationId: b.id, messageId: msg.id }),
      FK_VIOLATION,
      "message_attachments_org_message_fk",
    );
  });

  it("rejects a message whose account differs from its conversation's account", async () => {
    const a = await seedWorld(db);
    const account2 = await seedAccount(db, a.org.id); // same org, different account
    await expectPgError(
      seedMessage(db, {
        organizationId: a.org.id,
        conversationId: a.conversation.id,
        whatsappAccountId: account2.id,
      }),
      FK_VIOLATION,
      "messages_org_conversation_account_fk",
    );
  });

  describe("reply-to integrity", () => {
    it("allows a reply within the same conversation", async () => {
      const a = await seedWorld(db);
      const base = {
        organizationId: a.org.id,
        conversationId: a.conversation.id,
        whatsappAccountId: a.account.id,
      };
      const original = await seedMessage(db, base);
      const reply = await seedMessage(db, { ...base, replyToMessageId: original.id });
      expect(reply.replyToMessageId).toBe(original.id);
    });

    it("rejects a reply to a message from another conversation (same organization)", async () => {
      const a = await seedWorld(db);
      const contact2 = await seedContact(db, a.org.id);
      const conv2 = await seedConversation(db, {
        organizationId: a.org.id,
        whatsappAccountId: a.account.id,
        contactId: contact2.id,
      });
      const original = await seedMessage(db, {
        organizationId: a.org.id,
        conversationId: a.conversation.id,
        whatsappAccountId: a.account.id,
      });
      await expectPgError(
        seedMessage(db, {
          organizationId: a.org.id,
          conversationId: conv2.id,
          whatsappAccountId: a.account.id,
          replyToMessageId: original.id,
        }),
        FK_VIOLATION,
        "messages_reply_to_same_conversation_fk",
      );
    });

    it("rejects a reply to a message from another organization", async () => {
      const a = await seedWorld(db);
      const b = await seedWorld(db);
      const original = await seedMessage(db, {
        organizationId: a.org.id,
        conversationId: a.conversation.id,
        whatsappAccountId: a.account.id,
      });
      await expectPgError(
        seedMessage(db, {
          organizationId: b.org.id,
          conversationId: b.conversation.id,
          whatsappAccountId: b.account.id,
          replyToMessageId: original.id,
        }),
        FK_VIOLATION,
        "messages_reply_to_same_conversation_fk",
      );
    });
  });

  describe("message status events", () => {
    it("rejects a status event for account B that references a message of account A", async () => {
      const a = await seedWorld(db);
      const accountB = await seedAccount(db, a.org.id); // same org, different account
      const msg = await seedMessage(db, {
        organizationId: a.org.id,
        conversationId: a.conversation.id,
        whatsappAccountId: a.account.id,
      });
      await expectPgError(
        db.insert(schema.messageStatusEvents).values({
          organizationId: a.org.id,
          whatsappAccountId: accountB.id,
          messageId: msg.id,
          wamid: msg.wamid!,
          status: "SENT",
          occurredAt: T0,
        }),
        FK_VIOLATION,
        "message_status_events_org_message_account_fk",
      );
    });

    it("accepts matching account, and a NULL message_id (status before message)", async () => {
      const a = await seedWorld(db);
      const msg = await seedMessage(db, {
        organizationId: a.org.id,
        conversationId: a.conversation.id,
        whatsappAccountId: a.account.id,
      });
      await db.insert(schema.messageStatusEvents).values({
        organizationId: a.org.id,
        whatsappAccountId: a.account.id,
        messageId: msg.id,
        wamid: msg.wamid!,
        status: "SENT",
        occurredAt: T0,
      });
      await db.insert(schema.messageStatusEvents).values({
        organizationId: a.org.id,
        whatsappAccountId: a.account.id,
        messageId: null,
        wamid: "wamid.future",
        status: "SENT",
        occurredAt: T0,
      });
    });

    it("rejects a status event in org B referencing a message of org A", async () => {
      const a = await seedWorld(db);
      const b = await seedWorld(db);
      const msg = await seedMessage(db, {
        organizationId: a.org.id,
        conversationId: a.conversation.id,
        whatsappAccountId: a.account.id,
      });
      await expectPgError(
        db.insert(schema.messageStatusEvents).values({
          organizationId: b.org.id,
          whatsappAccountId: b.account.id,
          messageId: msg.id,
          wamid: msg.wamid!,
          status: "SENT",
          occurredAt: T0,
        }),
        FK_VIOLATION,
        "message_status_events_org_message_account_fk",
      );
    });
  });

  describe("webhook event references", () => {
    it("only allows referencing a webhook event routed to the same organization", async () => {
      const a = await seedWorld(db);
      const b = await seedWorld(db);
      const base = {
        organizationId: a.org.id,
        conversationId: a.conversation.id,
        whatsappAccountId: a.account.id,
      };

      const own = await seedWebhookEvent(db, {
        organizationId: a.org.id,
        whatsappAccountId: a.account.id,
      });
      const msg = await seedMessage(db, { ...base, sourceWebhookEventId: own.id });
      expect(msg.sourceWebhookEventId).toBe(own.id);

      const foreign = await seedWebhookEvent(db, {
        organizationId: b.org.id,
        whatsappAccountId: b.account.id,
      });
      await expectPgError(
        seedMessage(db, { ...base, sourceWebhookEventId: foreign.id }),
        FK_VIOLATION,
        "messages_org_source_webhook_event_fk",
      );

      const unrouted = await seedWebhookEvent(db);
      await expectPgError(
        seedMessage(db, { ...base, sourceWebhookEventId: unrouted.id }),
        FK_VIOLATION,
        "messages_org_source_webhook_event_fk",
      );
    });

    it("applies the same rule to message_status_events.webhook_event_id", async () => {
      const a = await seedWorld(db);
      const b = await seedWorld(db);
      const own = await seedWebhookEvent(db, {
        organizationId: a.org.id,
        whatsappAccountId: a.account.id,
      });
      const foreign = await seedWebhookEvent(db, {
        organizationId: b.org.id,
        whatsappAccountId: b.account.id,
      });
      const row = (webhookEventId: string) => ({
        organizationId: a.org.id,
        whatsappAccountId: a.account.id,
        wamid: `w-${webhookEventId}`,
        status: "SENT" as const,
        occurredAt: T0,
        webhookEventId,
      });
      await db.insert(schema.messageStatusEvents).values(row(own.id));
      await expectPgError(
        db.insert(schema.messageStatusEvents).values(row(foreign.id)),
        FK_VIOLATION,
        "message_status_events_org_webhook_event_fk",
      );
    });

    it("does not cascade or null on delete (retention cleanup must null references first)", async () => {
      const a = await seedWorld(db);
      const ev = await seedWebhookEvent(db, {
        organizationId: a.org.id,
        whatsappAccountId: a.account.id,
      });
      await seedMessage(db, {
        organizationId: a.org.id,
        conversationId: a.conversation.id,
        whatsappAccountId: a.account.id,
        sourceWebhookEventId: ev.id,
      });
      await expectPgError(
        t.pool.query("delete from webhook_events where id = $1", [ev.id]),
        FK_VIOLATION,
        "messages_org_source_webhook_event_fk",
      );
      await t.pool.query(
        "update messages set source_webhook_event_id = null where source_webhook_event_id = $1",
        [ev.id],
      );
      await t.pool.query("delete from webhook_events where id = $1", [ev.id]);
    });

    it("routing columns must be both set or both null, and match an account of that organization", async () => {
      const a = await seedWorld(db);
      const b = await seedWorld(db);
      await expectPgError(
        seedWebhookEvent(db, { organizationId: a.org.id }),
        CHECK_VIOLATION,
        "webhook_events_routing_check",
      );
      await expectPgError(
        seedWebhookEvent(db, { organizationId: a.org.id, whatsappAccountId: b.account.id }),
        FK_VIOLATION,
        "webhook_events_org_account_fk",
      );
    });
  });

  describe("lead attribution", () => {
    it("rejects an attribution for contact B referencing a lead of contact A", async () => {
      const a = await seedWorld(db);
      const contactB = await seedContact(db, a.org.id); // same org, different contact
      const leadA = await seedLead(db, a.org.id, a.contact.id);
      await expectPgError(
        db.insert(schema.leadAttributions).values({
          organizationId: a.org.id,
          contactId: contactB.id,
          leadId: leadA.id,
          sourceType: "META_AD",
          receivedAt: T0,
        }),
        FK_VIOLATION,
        "lead_attributions_org_lead_contact_fk",
      );
    });

    it("accepts matching contact/lead, a NULL lead, and rejects a cross-organization message", async () => {
      const a = await seedWorld(db);
      const b = await seedWorld(db);
      const lead = await seedLead(db, a.org.id, a.contact.id);
      const base = {
        organizationId: a.org.id,
        contactId: a.contact.id,
        sourceType: "META_AD" as const,
        receivedAt: T0,
      };
      await db.insert(schema.leadAttributions).values({ ...base, leadId: lead.id });
      await db.insert(schema.leadAttributions).values({ ...base, leadId: null });
      const foreignMsg = await seedMessage(db, {
        organizationId: b.org.id,
        conversationId: b.conversation.id,
        whatsappAccountId: b.account.id,
      });
      await expectPgError(
        db.insert(schema.leadAttributions).values({ ...base, messageId: foreignMsg.id }),
        FK_VIOLATION,
        "lead_attributions_org_message_fk",
      );
    });

    it("allows multiple leads for one contact", async () => {
      const a = await seedWorld(db);
      await seedLead(db, a.org.id, a.contact.id);
      await seedLead(db, a.org.id, a.contact.id);
      await seedLead(db, a.org.id, a.contact.id);
      const rows = await t.pool.query("select count(*)::int n from leads where contact_id = $1", [
        a.contact.id,
      ]);
      expect(rows.rows[0].n).toBe(3);
    });
  });

  describe("tags", () => {
    it("rejects tagging a contact with another organization's tag, and cross-organization contacts", async () => {
      const a = await seedWorld(db);
      const b = await seedWorld(db);
      const tagB = await seedTag(db, b.org.id, "2027");
      await expectPgError(
        db
          .insert(schema.contactTags)
          .values({ organizationId: a.org.id, contactId: a.contact.id, tagId: tagB.id }),
        FK_VIOLATION,
        "contact_tags_org_tag_fk",
      );
      const tagA = await seedTag(db, a.org.id, "2027");
      await expectPgError(
        db
          .insert(schema.contactTags)
          .values({ organizationId: b.org.id, contactId: a.contact.id, tagId: tagB.id }),
        FK_VIOLATION,
        "contact_tags_org_contact_fk",
      );
      await db
        .insert(schema.contactTags)
        .values({ organizationId: a.org.id, contactId: a.contact.id, tagId: tagA.id });
    });
  });
});
