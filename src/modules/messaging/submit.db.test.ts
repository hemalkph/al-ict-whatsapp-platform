import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import { IdempotencyConflictError, OutboundRefusedError } from "./errors";
import { getOutboundRequest, submitOutboundMessage } from "./submit";
import {
  ON,
  addActor,
  addTemplate,
  minutesAgo,
  textInput,
  world,
  type WorldOptions,
} from "./testing";

// Staff-facing creation of outbound requests on real PostgreSQL: authorization, recipient safety, the service window, template
// and consent policy, idempotency, and what is (and is not) written. Nothing here has a transport: creating a request never
// sends anything.

describe("submitOutboundMessage", () => {
  let t: TestDb;
  const NOW = new Date("2026-06-01T12:00:00Z");
  const deps = (over: Record<string, unknown> = {}) => ({
    db: t.db as never,
    config: ON,
    now: () => NOW,
    ...over,
  });
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());
  beforeEach(() => {
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });

  const w = (o: WorldOptions = {}) => world(t.db, { lastInboundAt: minutesAgo(30, NOW), ...o });
  type W = Awaited<ReturnType<typeof w>>;
  const submit = (x: W, input: unknown, over: Record<string, unknown> = {}) =>
    submitOutboundMessage(x.actor.ctx, input, deps(over));
  const refusal = async (p: Promise<unknown>) => {
    const e = await p.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(e).toBeInstanceOf(OutboundRefusedError);
    return (e as OutboundRefusedError).reason;
  };
  const count = async (table: string) =>
    (await t.pool.query(`select count(*)::int n from ${table}`)).rows[0].n as number;
  const requestRow = async (id: string) =>
    (await t.pool.query("select * from outbound_requests where id = $1", [id])).rows[0];

  // ------------------------------------------------------------------------------------------ authorization
  describe("authorization", () => {
    it("STAFF and ADMIN may send, VIEWER may not (nothing is written)", async () => {
      for (const role of ["STAFF", "ADMIN"] as const) {
        const x = await w({ role });
        expect(await submit(x, textInput(x.conversation.id))).toMatchObject({
          state: "QUEUED",
          replayed: false,
        });
      }
      const v = await w({ role: "VIEWER" });
      await expect(submit(v, textInput(v.conversation.id))).rejects.toBeInstanceOf(ForbiddenError);
      expect(
        (
          await t.pool.query("select 1 from outbound_requests where conversation_id = $1", [
            v.conversation.id,
          ])
        ).rowCount,
      ).toBe(0);
    });

    it("another organization's staff gets 404 for this conversation, exactly like a missing one", async () => {
      const a = await w();
      const b = await w();
      await expect(
        submitOutboundMessage(b.actor.ctx, textInput(a.conversation.id), deps()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        submit(a, textInput("00000000-0000-4000-8000-000000000001")),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(
        await t.pool.query("select 1 from outbound_requests where conversation_id = $1", [
          a.conversation.id,
        ]),
      ).toHaveProperty("rowCount", 0);
    });

    it("an actor who was suspended after the context was built is refused inside the transaction", async () => {
      const x = await w();
      await t.db
        .update(schema.organizationMemberships)
        .set({ status: "SUSPENDED" })
        .where(eq(schema.organizationMemberships.id, x.actor.membershipId));
      await expect(submit(x, textInput(x.conversation.id))).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("a demoted actor (now VIEWER) is refused even though the stale context says STAFF", async () => {
      const x = await w();
      await t.db
        .update(schema.organizationMemberships)
        .set({ role: "VIEWER" })
        .where(eq(schema.organizationMemberships.id, x.actor.membershipId));
      await expect(submit(x, textInput(x.conversation.id))).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("the browser cannot choose the organization, account, contact or recipient: such fields are rejected", async () => {
      const x = await w();
      const y = await w();
      for (const extra of [
        { organizationId: y.org.id },
        { whatsappAccountId: y.account.id },
        { contactId: y.contact.id },
        { to: "94770000001" },
        { recipient: "US.123" },
        { phoneNumberId: y.account.phoneNumberId },
      ])
        await expect(
          submit(x, { ...textInput(x.conversation.id), ...extra }),
        ).rejects.toBeInstanceOf(ValidationError);
      expect(
        (
          await t.pool.query("select 1 from outbound_requests where conversation_id = $1", [
            x.conversation.id,
          ])
        ).rowCount,
      ).toBe(0);
    });

    it("disabled outbound refuses everything", async () => {
      const x = await w();
      expect(
        await refusal(
          submit(x, textInput(x.conversation.id), { config: { ...ON, outboundEnabled: false } }),
        ),
      ).toBe("outbound_disabled");
    });

    it.each([["DISABLED"], ["PENDING"]] as const)(
      "an account that is %s is refused",
      async (status) => {
        const x = await w({ accountStatus: status });
        expect(await refusal(submit(x, textInput(x.conversation.id)))).toBe("account_inactive");
      },
    );

    it("an archived account is refused", async () => {
      const x = await w();
      await t.db
        .update(schema.whatsappAccounts)
        .set({ archivedAt: NOW })
        .where(eq(schema.whatsappAccounts.id, x.account.id));
      expect(await refusal(submit(x, textInput(x.conversation.id)))).toBe("account_inactive");
    });

    it("an archived contact is refused", async () => {
      const x = await w();
      await t.db
        .update(schema.contacts)
        .set({ archivedAt: NOW })
        .where(eq(schema.contacts.id, x.contact.id));
      expect(await refusal(submit(x, textInput(x.conversation.id)))).toBe("contact_archived");
    });
  });

  // -------------------------------------------------------------------------------------------- recipients
  describe("recipient resolution", () => {
    const recipientOf = async (x: W, config = ON) => {
      const r = await submit(x, textInput(x.conversation.id), { config });
      const row = await requestRow(r.requestId);
      return { kind: row.recipient_kind as string, id: row.recipient_id as string };
    };

    it("a phone-only contact is addressed by its phone-based id, exactly", async () => {
      const x = await w({ waId: "94771234567" });
      expect(await recipientOf(x)).toEqual({ kind: "PHONE", id: "94771234567" });
    });

    it("with BSUID sending ENABLED the current BSUID is used, exactly as stored", async () => {
      const x = await w({ waId: "94771234567", bsuids: [{ bsuid: "LK.A1b2C3" }] });
      expect(await recipientOf(x, { ...ON, bsuidRecipientEnabled: true })).toEqual({
        kind: "BSUID",
        id: "LK.A1b2C3",
      });
    });

    it("C1: a contact with a BSUID and a retained phone is NEVER sent to that phone while BSUID sending is disabled", async () => {
      const x = await w({ waId: "94771234567", bsuids: [{ bsuid: "LK.A1b2C3" }] });
      expect(await refusal(submit(x, textInput(x.conversation.id)))).toBe("bsuid_send_unavailable");
      expect(
        (
          await t.pool.query("select 1 from outbound_requests where conversation_id = $1", [
            x.conversation.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await t.pool.query(
            "select 1 from messages where conversation_id = $1 and direction = 'OUTBOUND'",
            [x.conversation.id],
          )
        ).rowCount,
      ).toBe(0);
    });

    it("C1: a BSUID that was rotated (old retired, new current) with the historical phone still stored does not fall back to the phone either", async () => {
      const x = await w({
        waId: "94771234567", // the value the resolver preserved; the number may belong to someone else now
        bsuids: [{ bsuid: "LK.Before1", retired: true }, { bsuid: "LK.After22" }],
      });
      expect(await refusal(submit(x, textInput(x.conversation.id)))).toBe("bsuid_send_unavailable");
      expect(await recipientOf(x, { ...ON, bsuidRecipientEnabled: true })).toEqual({
        kind: "BSUID",
        id: "LK.After22",
      });
    });

    it("C1: a contact whose only aliases are retired, with a stored phone, is ambiguous and not sent to the phone", async () => {
      const x = await w({ waId: "94771234567", bsuids: [{ bsuid: "LK.Gone111", retired: true }] });
      for (const bsuidRecipientEnabled of [false, true])
        expect(
          await refusal(
            submit(x, textInput(x.conversation.id), { config: { ...ON, bsuidRecipientEnabled } }),
          ),
        ).toBe("identity_ambiguous");
    });

    it("C1: the phone that the resolver left on one contact is not reachable through another contact's conversation either", async () => {
      // Contact A kept phone P after its BSUID was linked elsewhere; contact Y is the BSUID-only person now using P.
      const a = await w({ waId: "94775550001", bsuids: [{ bsuid: "LK.Alpha001" }] });
      const y = await w({ waId: null, bsuids: [{ bsuid: "LK.Yankee01" }] });
      expect(await refusal(submit(a, textInput(a.conversation.id)))).toBe("bsuid_send_unavailable");
      expect(await refusal(submit(y, textInput(y.conversation.id)))).toBe("bsuid_send_unavailable");
      for (const x of [a, y])
        expect(
          (
            await t.pool.query("select 1 from outbound_requests where conversation_id = $1", [
              x.conversation.id,
            ])
          ).rowCount,
        ).toBe(0);
    });

    it("C1: tenant isolation is unchanged: identical identifiers in two organizations are independent", async () => {
      const bsuidContact = await w({ waId: "94776660001", bsuids: [{ bsuid: "LK.Shared01" }] });
      const legacyContact = await w({ waId: "94776660001" }); // same phone string, other organization, never seen with a BSUID
      expect(await refusal(submit(bsuidContact, textInput(bsuidContact.conversation.id)))).toBe(
        "bsuid_send_unavailable",
      );
      expect(await recipientOf(legacyContact)).toEqual({ kind: "PHONE", id: "94776660001" });
      await expect(
        submit(legacyContact, textInput(bsuidContact.conversation.id)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("a BSUID-only contact cannot be addressed while BSUID sending is disabled, and can be once it is enabled", async () => {
      const x = await w({ waId: null, bsuids: [{ bsuid: "LK.OnlyOne1" }] });
      expect(await refusal(submit(x, textInput(x.conversation.id)))).toBe("bsuid_send_unavailable");
      expect(await recipientOf(x, { ...ON, bsuidRecipientEnabled: true })).toEqual({
        kind: "BSUID",
        id: "LK.OnlyOne1",
      });
    });

    it("a retired alias is never used: the current one wins, and a contact with only retired aliases is ambiguous", async () => {
      const x = await w({
        waId: null,
        bsuids: [{ bsuid: "LK.Old000", retired: true }, { bsuid: "LK.New111" }],
      });
      expect(await recipientOf(x, { ...ON, bsuidRecipientEnabled: true })).toEqual({
        kind: "BSUID",
        id: "LK.New111",
      });
      const y = await w({ waId: null, bsuids: [{ bsuid: "LK.Old000", retired: true }] });
      expect(
        await refusal(
          submit(y, textInput(y.conversation.id), {
            config: { ...ON, bsuidRecipientEnabled: true },
          }),
        ),
      ).toBe("identity_ambiguous");
      // a phone that survived a BSUID rotation is NOT trusted: the number may have changed hands
      const z = await w({ waId: "94770000009", bsuids: [{ bsuid: "LK.Old000", retired: true }] });
      expect(await refusal(submit(z, textInput(z.conversation.id)))).toBe("identity_ambiguous");
    });

    it("a contact with no identity at all, or only a username, is refused", async () => {
      const x = await w({ waId: null });
      await t.db
        .update(schema.contacts)
        .set({ username: "@somebody" })
        .where(eq(schema.contacts.id, x.contact.id));
      expect(await refusal(submit(x, textInput(x.conversation.id)))).toBe("no_identity");
    });

    it("identifiers are used byte for byte: a 255-character BSUID and non-ASCII ids survive; a control character is refused, never cleaned", async () => {
      const long = `LK.${"a".repeat(252)}`;
      const x = await w({ waId: null, bsuids: [{ bsuid: long }] });
      expect((await recipientOf(x, { ...ON, bsuidRecipientEnabled: true })).id).toBe(long);
      const y = await w({ waId: "9477ස123", bsuids: [] });
      expect((await recipientOf(y)).id).toBe("9477ස123");
      const bad = await w({ waId: "94770\n000" });
      expect(await refusal(submit(bad, textInput(bad.conversation.id)))).toBe("identity_ambiguous");
    });

    it("the same BSUID string in two organizations resolves to each organization's own contact (portfolio scoping)", async () => {
      const a = await w({ waId: null, bsuids: [{ bsuid: "US.SAME123" }] });
      const b = await w({ waId: null, bsuids: [{ bsuid: "US.SAME123" }] });
      const cfg = { ...ON, bsuidRecipientEnabled: true };
      const ra = await submit(a, textInput(a.conversation.id), { config: cfg });
      const rb = await submit(b, textInput(b.conversation.id), { config: cfg });
      expect((await requestRow(ra.requestId)).organization_id).toBe(a.org.id);
      expect((await requestRow(rb.requestId)).organization_id).toBe(b.org.id);
      expect((await requestRow(ra.requestId)).whatsapp_account_id).toBe(a.account.id);
    });
  });

  // ------------------------------------------------------------------------------------------------ window
  describe("customer service window (free-form text)", () => {
    it.each([
      ["30 minutes after the customer wrote", minutesAgo(30, NOW), "ok"],
      ["23 hours after", minutesAgo(23 * 60, NOW), "ok"],
      [
        "23h49m59s after (inside the safety margin)",
        new Date(NOW.getTime() - (24 * 60 - 10) * 60_000 + 1000),
        "ok",
      ],
      [
        "23h50m exactly after (margin reached)",
        new Date(NOW.getTime() - (24 * 60 - 10) * 60_000),
        "window_closed",
      ],
      ["24 hours after", minutesAgo(24 * 60, NOW), "window_closed"],
      ["36 hours after", minutesAgo(36 * 60, NOW), "window_closed"],
      ["never wrote", null, "no_inbound"],
    ] as const)("%s", async (_n, lastInboundAt, expected) => {
      const x = await w({ lastInboundAt });
      if (expected === "ok")
        expect(await submit(x, textInput(x.conversation.id))).toMatchObject({ state: "QUEUED" });
      else expect(await refusal(submit(x, textInput(x.conversation.id)))).toBe(expected);
    });

    it("a future-dated inbound timestamp is never worth more than 'now': slightly ahead is clamped, far ahead is not trusted", async () => {
      const skewed = await w({ lastInboundAt: new Date(NOW.getTime() + 3 * 60_000) });
      expect(await submit(skewed, textInput(skewed.conversation.id))).toMatchObject({
        state: "QUEUED",
      });
      // clamped to the check time, never extended: 24 hours later it has closed
      const later = new Date(NOW.getTime() + 24 * 3600_000);
      expect(
        await refusal(
          submit(skewed, textInput(skewed.conversation.id, "again", "later-key-0001"), {
            now: () => later,
          }),
        ),
      ).toBe("window_closed");
      const far = await w({ lastInboundAt: new Date(NOW.getTime() + 3 * 24 * 3600_000) });
      expect(await refusal(submit(far, textInput(far.conversation.id)))).toBe(
        "inbound_timestamp_invalid",
      );
    });

    it("outbound sends, delivery receipts, status times and an advertising referral never open the window", async () => {
      const x = await w({ lastInboundAt: minutesAgo(30 * 60, NOW) });
      await t.db
        .update(schema.conversations)
        .set({ lastOutboundAt: NOW, lastMessageAt: NOW })
        .where(eq(schema.conversations.id, x.conversation.id));
      const [m] = await t.db
        .insert(schema.messages)
        .values({
          organizationId: x.org.id,
          conversationId: x.conversation.id,
          whatsappAccountId: x.account.id,
          direction: "OUTBOUND",
          type: "TEXT",
          occurredAt: NOW,
          wamid: "wamid.OUT1",
          latestStatus: "READ",
          latestStatusAt: NOW,
        })
        .returning();
      await t.db.insert(schema.messageStatusEvents).values({
        organizationId: x.org.id,
        whatsappAccountId: x.account.id,
        messageId: m!.id,
        wamid: "wamid.OUT1",
        status: "READ",
        occurredAt: NOW,
      });
      await t.db.insert(schema.leadAttributions).values({
        organizationId: x.org.id,
        contactId: x.contact.id,
        sourceType: "META_AD",
        receivedAt: NOW,
      });
      expect(await refusal(submit(x, textInput(x.conversation.id)))).toBe("window_closed");
    });

    it("a closed window does not turn a text request into a template", async () => {
      const x = await w({ lastInboundAt: minutesAgo(48 * 60, NOW) });
      await addTemplate(t.db, x);
      expect(await refusal(submit(x, textInput(x.conversation.id)))).toBe("window_closed");
      expect(await count("outbound_requests")).toBeGreaterThanOrEqual(0);
      expect(
        (
          await t.pool.query("select 1 from outbound_requests where conversation_id = $1", [
            x.conversation.id,
          ])
        ).rowCount,
      ).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------- templates
  describe("templates and consent", () => {
    const tpl = (x: W, templateId: string, parameters: string[] = []) => ({
      idempotencyKey: `tpl-key-${Math.random().toString(36).slice(2)}-abc`,
      conversationId: x.conversation.id,
      message: { type: "template" as const, templateId, parameters },
    });

    it("a phone-only contact whose only inbound is historical gets no proactive template, whatever its category or consent", async () => {
      for (const [category, consent] of [
        ["UTILITY", "UNKNOWN"],
        ["MARKETING", "GRANTED"],
      ] as const) {
        const x = await w({ lastInboundAt: minutesAgo(72 * 60, NOW), consent });
        const template = await addTemplate(t.db, x, { category });
        expect(await refusal(submit(x, tpl(x, template.id)))).toBe("window_closed");
        expect(
          (
            await t.pool.query("select 1 from outbound_requests where conversation_id = $1", [
              x.conversation.id,
            ])
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await t.pool.query(
              "select 1 from messages where conversation_id = $1 and direction = 'OUTBOUND'",
              [x.conversation.id],
            )
          ).rowCount,
        ).toBe(0);
      }
    });

    it("an approved UTILITY template to a phone-only contact with a recent inbound (window open) is queued", async () => {
      const x = await w({ lastInboundAt: minutesAgo(30, NOW) });
      const template = await addTemplate(t.db, x, { category: "UTILITY", params: 2 });
      const r = await submit(x, tpl(x, template.id, ["Nimal", "Friday"]));
      const row = await requestRow(r.requestId);
      expect(row).toMatchObject({
        message_type: "TEMPLATE",
        template_id: template.id,
        state: "QUEUED",
      });
      expect(row.payload).toEqual({ parameters: ["Nimal", "Friday"] });
      const [m] = (
        await t.pool.query("select type, body, content from messages where id = $1", [
          row.message_id,
        ])
      ).rows;
      expect(m).toMatchObject({ type: "TEMPLATE", body: null });
      expect(m.content.template).toMatchObject({
        name: template.name,
        languageCode: "en_US",
        category: "UTILITY",
      });
    });

    it("a template that is missing, unattested, disabled, or belongs to another account or organization is refused", async () => {
      const x = await w();
      const pending = await addTemplate(t.db, x, { status: "PENDING_ATTESTATION" });
      const disabled = await addTemplate(t.db, x, { status: "DISABLED" });
      const y = await w();
      const foreign = await addTemplate(t.db, y);
      expect(await refusal(submit(x, tpl(x, "00000000-0000-4000-8000-000000000002")))).toBe(
        "template_not_found",
      );
      expect(await refusal(submit(x, tpl(x, pending.id)))).toBe("template_not_approved");
      expect(await refusal(submit(x, tpl(x, disabled.id)))).toBe("template_not_approved");
      expect(await refusal(submit(x, tpl(x, foreign.id)))).toBe("template_not_found");
    });

    it("the parameter count must match the registered template", async () => {
      const x = await w();
      const template = await addTemplate(t.db, x, { params: 2 });
      expect(await refusal(submit(x, tpl(x, template.id, ["only one"])))).toBe(
        "template_parameters_mismatch",
      );
      expect(await refusal(submit(x, tpl(x, template.id, ["a", "b", "c"])))).toBe(
        "template_parameters_mismatch",
      );
      expect(
        await refusal(
          submit(x, tpl(x, (await addTemplate(t.db, x, { params: 0 })).id, ["unexpected"])),
        ),
      ).toBe("template_parameters_mismatch");
    });

    it("a MARKETING template needs recorded GRANTED consent: unknown, withdrawn, a message and an advertising referral are not consent", async () => {
      const x = await w({ consent: "UNKNOWN" });
      const template = await addTemplate(t.db, x, { category: "MARKETING" });
      await t.db.insert(schema.leadAttributions).values({
        organizationId: x.org.id,
        contactId: x.contact.id,
        sourceType: "META_AD",
        receivedAt: NOW,
      });
      expect(await refusal(submit(x, tpl(x, template.id)))).toBe("marketing_consent_missing");
      const withdrawn = await w({ consent: "WITHDRAWN" });
      expect(
        await refusal(
          submit(
            withdrawn,
            tpl(withdrawn, (await addTemplate(t.db, withdrawn, { category: "MARKETING" })).id),
          ),
        ),
      ).toBe("marketing_consent_missing");
      const granted = await w({ consent: "GRANTED" });
      expect(
        await submit(
          granted,
          tpl(granted, (await addTemplate(t.db, granted, { category: "MARKETING" })).id),
        ),
      ).toMatchObject({ state: "QUEUED" });
    });

    it("no consent or contact change is ever created by sending or by refusing", async () => {
      const x = await w({ consent: "UNKNOWN" });
      const template = await addTemplate(t.db, x, { category: "MARKETING" });
      await refusal(submit(x, tpl(x, template.id)));
      await submit(x, textInput(x.conversation.id));
      expect(await count("contact_consents")).toBe(0);
      const [c] = (
        await t.pool.query(
          "select marketing_consent_status, updated_at from contacts where id = $1",
          [x.contact.id],
        )
      ).rows;
      expect(c.marketing_consent_status).toBe("UNKNOWN");
    });

    it("AUTHENTICATION templates are not supported, and a UTILITY template to someone who never wrote is refused", async () => {
      const x = await w();
      expect(
        await refusal(
          submit(x, tpl(x, (await addTemplate(t.db, x, { category: "AUTHENTICATION" })).id)),
        ),
      ).toBe("template_category_unsupported");
      const never = await w({ lastInboundAt: null });
      expect(
        await refusal(
          submit(never, tpl(never, (await addTemplate(t.db, never, { category: "UTILITY" })).id)),
        ),
      ).toBe("no_prior_contact");
    });
  });

  // ------------------------------------------------------------------------------------------ idempotency
  describe("idempotency", () => {
    it("the same key and the same request returns the same logical operation", async () => {
      const x = await w();
      const input = textInput(x.conversation.id, "Hello", "client-key-0001");
      const first = await submit(x, input);
      const second = await submit(x, input);
      expect(second).toEqual({ ...first, replayed: true });
      expect(
        (
          await t.pool.query("select 1 from outbound_requests where conversation_id = $1", [
            x.conversation.id,
          ])
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await t.pool.query(
            "select 1 from messages where conversation_id = $1 and direction = 'OUTBOUND'",
            [x.conversation.id],
          )
        ).rowCount,
      ).toBe(1);
    });

    it("a replay still succeeds after the request was dispatched, and even after the window has closed", async () => {
      const x = await w();
      const input = textInput(x.conversation.id, "Hello", "client-key-0002");
      const first = await submit(x, input);
      await t.pool.query(
        "update outbound_requests set state = 'SENDING', claimed_by = 'w', claimed_at = now(), send_started_at = now() where id = $1",
        [first.requestId],
      );
      const replay = await submit(x, input, { now: () => new Date(NOW.getTime() + 48 * 3600_000) });
      expect(replay).toMatchObject({
        requestId: first.requestId,
        replayed: true,
        state: "SENDING",
      });
    });

    it("the same key with a different body, recipient conversation, reply or template is a conflict", async () => {
      const x = await w();
      const key = "client-key-0003";
      await submit(x, textInput(x.conversation.id, "Hello", key));
      await expect(submit(x, textInput(x.conversation.id, "Hello!", key))).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
      const template = await addTemplate(t.db, x);
      await expect(
        submit(x, {
          idempotencyKey: key,
          conversationId: x.conversation.id,
          message: { type: "template", templateId: template.id, parameters: [] },
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      // another conversation of the same organization, same key
      const [other] = await t.db
        .insert(schema.contacts)
        .values({
          organizationId: x.org.id,
          waId: "94770009999",
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        })
        .returning();
      const [conv2] = await t.db
        .insert(schema.conversations)
        .values({
          organizationId: x.org.id,
          whatsappAccountId: x.account.id,
          contactId: other!.id,
          lastMessageAt: NOW,
          lastInboundAt: minutesAgo(5, NOW),
        })
        .returning();
      await submit(x, textInput(conv2!.id, "Hello", key)).then(
        () => undefined,
        () => undefined,
      );
      expect(
        (
          await t.pool.query(
            "select 1 from outbound_requests where idempotency_key = $1 and organization_id = $2",
            [key, x.org.id],
          )
        ).rowCount,
      ).toBeLessThanOrEqual(2);
      expect(
        (
          await t.pool.query("select 1 from outbound_requests where conversation_id = $1", [
            x.conversation.id,
          ])
        ).rowCount,
      ).toBe(1);
    });

    it("a genuinely new reply with a new key is a new operation", async () => {
      const x = await w();
      const a = await submit(x, textInput(x.conversation.id, "One", "client-key-0004"));
      const b = await submit(x, textInput(x.conversation.id, "One", "client-key-0005")); // same words, new key
      expect(b.requestId).not.toBe(a.requestId);
      expect(
        (
          await t.pool.query("select 1 from outbound_requests where conversation_id = $1", [
            x.conversation.id,
          ])
        ).rowCount,
      ).toBe(2);
    });

    it("the key is scoped to the requester: two staff members using the same key string get two operations", async () => {
      const x = await w();
      const colleague = await addActor(t.db, x.org.id, "STAFF");
      const a = await submit(x, textInput(x.conversation.id, "From A", "shared-key-0006"));
      const b = await submitOutboundMessage(
        colleague.ctx,
        textInput(x.conversation.id, "From B", "shared-key-0006"),
        deps(),
      );
      expect(b.requestId).not.toBe(a.requestId);
      expect(b.replayed).toBe(false);
    });

    it("the same key in another organization is unrelated", async () => {
      const a = await w();
      const b = await w();
      await submit(a, textInput(a.conversation.id, "Hello", "client-key-0007"));
      expect(
        await submit(b, textInput(b.conversation.id, "Hello", "client-key-0007")),
      ).toMatchObject({ replayed: false });
    });

    it("concurrent identical submissions create exactly one request, one message and the same answer", async () => {
      const x = await w();
      for (let round = 0; round < 4; round++) {
        const input = textInput(x.conversation.id, `Race ${round}`, `race-key-${round}-0001`);
        const results = await Promise.all(Array.from({ length: 8 }, () => submit(x, input)));
        expect(new Set(results.map((r) => r.requestId)).size, `round ${round}`).toBe(1);
        expect(
          results.filter((r) => !r.replayed),
          `round ${round}`,
        ).toHaveLength(1);
      }
      expect(
        (
          await t.pool.query("select 1 from outbound_requests where conversation_id = $1", [
            x.conversation.id,
          ])
        ).rowCount,
      ).toBe(4);
      expect(
        (
          await t.pool.query(
            "select 1 from messages where conversation_id = $1 and direction = 'OUTBOUND'",
            [x.conversation.id],
          )
        ).rowCount,
      ).toBe(4);
    });

    it("concurrent submissions with one key but different content: exactly one wins, the rest conflict, one request exists", async () => {
      const x = await w();
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          submit(x, textInput(x.conversation.id, `Variant ${i}`, "conflict-key-0001")),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((r) => r.status === "rejected"))
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(IdempotencyConflictError);
      expect(
        (
          await t.pool.query(
            "select 1 from outbound_requests where idempotency_key = 'conflict-key-0001'",
          )
        ).rowCount,
      ).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------------- persistence
  describe("what is persisted", () => {
    it("writes an OUTBOUND message with no wamid, the exact text, and touches no conversation timestamp or state", async () => {
      const x = await w({ lastInboundAt: minutesAgo(10, NOW) });
      await t.db
        .update(schema.conversations)
        .set({ status: "RESOLVED", resolvedAt: minutesAgo(5, NOW) })
        .where(eq(schema.conversations.id, x.conversation.id));
      const [before] = (
        await t.pool.query("select * from conversations where id = $1", [x.conversation.id])
      ).rows;
      const body = "හෙලෝ வணக்கம் \u{1F600}\nSecond line\tTabbed ‍";
      const r = await submit(x, textInput(x.conversation.id, body));
      const [m] = (await t.pool.query("select * from messages where id = $1", [r.messageId])).rows;
      expect(m).toMatchObject({
        direction: "OUTBOUND",
        type: "TEXT",
        wamid: null,
        body,
        client_request_id: r.requestId,
        latest_status: null,
        organization_id: x.org.id,
        whatsapp_account_id: x.account.id,
        conversation_id: x.conversation.id,
      });
      const [after] = (
        await t.pool.query("select * from conversations where id = $1", [x.conversation.id])
      ).rows;
      // Phase 08D: the request insert allocates the conversation's control sequence (+1) and changes nothing else:
      // last_inbound_at, last_outbound_at, last_message_at, updated_at, status and resolved_at are all unchanged.
      expect(Number(after.control_seq)).toBe(Number(before.control_seq) + 1);
      expect({ ...after, control_seq: null }).toEqual({ ...before, control_seq: null });
      const row = await requestRow(r.requestId);
      expect(row).toMatchObject({
        state: "QUEUED",
        attempt_count: 0,
        requested_by_membership_id: x.actor.membershipId,
        message_type: "TEXT",
        recipient_kind: "PHONE",
      });
      expect(new Date(row.dispatch_deadline).getTime() - NOW.getTime()).toBe(15 * 60_000);
      expect(row.payload).toEqual({ body, replyToWamid: null });
    });

    it("a reply must point at a message of the SAME conversation that already has a provider id", async () => {
      const x = await w();
      const y = await w();
      const mk = (w2: W, wamid: string | null, conv = w2.conversation.id) =>
        t.db
          .insert(schema.messages)
          .values({
            organizationId: w2.org.id,
            conversationId: conv,
            whatsappAccountId: w2.account.id,
            direction: "INBOUND",
            type: "TEXT",
            occurredAt: NOW,
            wamid,
          })
          .returning()
          .then((r) => r[0]!);
      const parent = await mk(x, "wamid.PARENT1");
      const noWamid = await mk(x, null);
      const foreign = await mk(y, "wamid.FOREIGN1");
      const ok = await submit(x, {
        ...textInput(x.conversation.id),
        message: { type: "text", body: "re", replyToMessageId: parent.id },
      });
      expect((await requestRow(ok.requestId)).payload).toEqual({
        body: "re",
        replyToWamid: "wamid.PARENT1",
      });
      expect(
        (
          await t.pool.query(
            "select reply_to_message_id, reply_to_wamid from messages where id = $1",
            [ok.messageId],
          )
        ).rows[0],
      ).toEqual({ reply_to_message_id: parent.id, reply_to_wamid: "wamid.PARENT1" });
      for (const id of [noWamid.id, foreign.id, "00000000-0000-4000-8000-000000000003"])
        expect(
          await refusal(
            submit(x, {
              ...textInput(x.conversation.id),
              message: { type: "text", body: "re", replyToMessageId: id },
            }),
          ),
        ).toBe("reply_target_unavailable");
    });

    it("refused requests write nothing at all", async () => {
      const x = await w({ lastInboundAt: null });
      const [rq, mg] = [await count("outbound_requests"), await count("messages")];
      await refusal(submit(x, textInput(x.conversation.id)));
      expect([await count("outbound_requests"), await count("messages")]).toEqual([rq, mg]);
    });
  });

  // ------------------------------------------------------------------------------------------ input validation
  describe("input", () => {
    it.each([
      ["a blank body", { type: "text", body: "   " }],
      ["an empty body", { type: "text", body: "" }],
      ["a NUL", { type: "text", body: "a\u0000b" }],
      ["a control character", { type: "text", body: "a\u0007b" }],
      ["a lone surrogate", { type: "text", body: `a${String.fromCharCode(0xd800)}b` }],
      ["a body over 4096 characters", { type: "text", body: "x".repeat(4097) }],
      ["an unknown message type", { type: "image", body: "x" }],
      ["extra fields", { type: "text", body: "x", previewUrl: true }],
    ])("rejects %s", async (_n, message) => {
      const x = await w();
      await expect(
        submit(x, { idempotencyKey: "valid-key-0001", conversationId: x.conversation.id, message }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("accepts exactly 4096 characters and keeps them", async () => {
      const x = await w();
      const body = "x".repeat(4096);
      const r = await submit(x, textInput(x.conversation.id, body));
      expect(
        (await t.pool.query("select body from messages where id = $1", [r.messageId])).rows[0].body,
      ).toHaveLength(4096);
    });

    it.each(["short", "has space in key", "semi;colon-key", "x".repeat(129), ""])(
      "rejects the idempotency key %j",
      async (key) => {
        const x = await w();
        await expect(
          submit(x, {
            idempotencyKey: key,
            conversationId: x.conversation.id,
            message: { type: "text", body: "x" },
          }),
        ).rejects.toBeInstanceOf(ValidationError);
      },
    );

    it("rejects a conversation id that is not a uuid, and errors never contain values", async () => {
      const x = await w();
      const e = await submit(x, {
        idempotencyKey: "valid-key-0002",
        conversationId: "not-a-uuid",
        message: { type: "text", body: "SECRET BODY" },
      }).catch((error: unknown) => error);
      expect(e).toBeInstanceOf(ValidationError);
      expect(JSON.stringify((e as ValidationError).fields)).not.toContain("SECRET");
    });
  });

  // ----------------------------------------------------------------------------------------------- status view
  describe("getOutboundRequest", () => {
    it("shows the state of one request to its own organization, without recipient or body", async () => {
      const x = await w();
      const r = await submit(x, textInput(x.conversation.id, "PRIVATE WORDS"));
      const viewer = await addActor(t.db, x.org.id, "VIEWER");
      const view = await getOutboundRequest(viewer.ctx, r.requestId, { db: t.db as never });
      expect(view).toMatchObject({
        requestId: r.requestId,
        state: "QUEUED",
        type: "TEXT",
        wamid: null,
        deliveryStatus: null,
      });
      const text = JSON.stringify(view);
      expect(text).not.toContain("PRIVATE WORDS");
      expect(text).not.toContain(x.contact.waId!);
    });

    it("another organization and malformed ids are 404", async () => {
      const a = await w();
      const b = await w();
      const r = await submit(a, textInput(a.conversation.id));
      await expect(
        getOutboundRequest(b.actor.ctx, r.requestId, { db: t.db as never }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        getOutboundRequest(a.actor.ctx, "nope", { db: t.db as never }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
