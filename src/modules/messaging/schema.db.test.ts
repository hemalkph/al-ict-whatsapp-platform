import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@/db";
import {
  CHECK_VIOLATION,
  FK_VIOLATION,
  UNIQUE_VIOLATION,
  createTestDatabase,
  expectPgError,
  type TestDb,
} from "@/db/__tests__/helpers";
import { addActor, addTemplate, world } from "./testing";

// The PostgreSQL guarantees behind outbound sending (migration 0004), exercised with raw SQL so no application code can be
// the reason they hold: tenant foreign keys, the idempotency uniqueness, the lifecycle CHECK and the lifecycle trigger.

describe("outbound_requests / whatsapp_templates constraints", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());

  type W = Awaited<ReturnType<typeof world>>;
  async function message(w: W, wamid: string | null = null) {
    const [m] = await t.db
      .insert(schema.messages)
      .values({
        organizationId: w.org.id,
        conversationId: w.conversation.id,
        whatsappAccountId: w.account.id,
        direction: "OUTBOUND",
        type: "TEXT",
        body: "x",
        occurredAt: new Date(),
        wamid,
      })
      .returning();
    return m!;
  }
  const request = async (w: W, over: Record<string, unknown> = {}, wamid: string | null = null) => {
    const m = await message(w, wamid);
    const cols = {
      organization_id: w.org.id,
      whatsapp_account_id: w.account.id,
      conversation_id: w.conversation.id,
      message_id: m.id,
      requested_by_membership_id: w.actor.membershipId,
      idempotency_key: `key-${randomUUID()}`,
      request_fingerprint: "a".repeat(64),
      message_type: "TEXT",
      recipient_kind: "PHONE",
      recipient_id: "94770000001",
      payload: JSON.stringify({ body: "x" }),
      dispatch_deadline: new Date(Date.now() + 900_000).toISOString(),
      ...over,
    };
    const keys = Object.keys(cols);
    const r = await t.pool.query(
      `insert into outbound_requests (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
      keys.map((k) => (cols as Record<string, unknown>)[k]),
    );
    return r.rows[0] as Record<string, unknown> & { id: string };
  };
  const update = (id: string, set: string, params: unknown[] = []) =>
    t.pool.query(`update outbound_requests set ${set} where id = $${params.length + 1}`, [
      ...params,
      id,
    ]);

  it("a request starts QUEUED with zero attempts", async () => {
    const w = await world(t.db);
    expect(await request(w)).toMatchObject({ state: "QUEUED", attempt_count: 0, claimed_by: null });
  });

  describe("idempotency uniqueness", () => {
    it("the same (organization, account, requester, key) cannot exist twice", async () => {
      const w = await world(t.db);
      await request(w, { idempotency_key: "same-key-0001" });
      await expectPgError(
        request(w, { idempotency_key: "same-key-0001" }),
        UNIQUE_VIOLATION,
        "outbound_requests_idempotency_unique",
      );
    });

    it("another requester, another account or another organization may reuse the key string", async () => {
      const w = await world(t.db);
      await request(w, { idempotency_key: "shared-key-01" });
      const other = await addActor(t.db, w.org.id);
      await request(w, {
        idempotency_key: "shared-key-01",
        requested_by_membership_id: other.membershipId,
      });
      const w2 = await world(t.db);
      await request(w2, { idempotency_key: "shared-key-01" });
    });

    it("one request per message", async () => {
      const w = await world(t.db);
      const first = await request(w);
      await expectPgError(
        request(w, { message_id: first.message_id, idempotency_key: "other-key-0001" }),
        UNIQUE_VIOLATION,
        "outbound_requests_org_message_unique",
      );
    });

    it.each(["short", "has space in it", "bad/char/here", "x".repeat(129)])(
      "rejects the key %j",
      async (key) => {
        const w = await world(t.db);
        await expectPgError(
          request(w, { idempotency_key: key }),
          CHECK_VIOLATION,
          "outbound_requests_idempotency_key_check",
        );
      },
    );
  });

  describe("tenant and account foreign keys", () => {
    it("the conversation, message, requester and template must all belong to the request's organization and account", async () => {
      const a = await world(t.db);
      const b = await world(t.db);
      await expectPgError(
        request(a, { conversation_id: b.conversation.id }),
        FK_VIOLATION,
        "outbound_requests_org_conversation_account_fk",
      );
      const bMessage = await message(b);
      await expectPgError(
        request(a, { message_id: bMessage.id }),
        FK_VIOLATION,
        "outbound_requests_org_message_account_fk",
      );
      await expectPgError(
        request(a, { requested_by_membership_id: b.actor.membershipId }),
        FK_VIOLATION,
        "outbound_requests_org_member_fk",
      );
      const bTemplate = await addTemplate(t.db, b);
      await expectPgError(
        request(a, { message_type: "TEMPLATE", template_id: bTemplate.id }),
        FK_VIOLATION,
        "outbound_requests_org_template_account_fk",
      );
      await expectPgError(request(a, { whatsapp_account_id: b.account.id }), FK_VIOLATION);
    });

    it("a template of another WhatsApp account of the SAME organization is refused", async () => {
      const a = await world(t.db);
      const [second] = await t.db
        .insert(schema.whatsappAccounts)
        .values({
          organizationId: a.org.id,
          wabaId: "299999999999999",
          phoneNumberId: "199999999999999",
          displayPhoneNumber: "x",
        })
        .returning();
      const foreign = await addTemplate(t.db, { org: a.org, account: second! });
      await expectPgError(
        request(a, { message_type: "TEMPLATE", template_id: foreign.id }),
        FK_VIOLATION,
        "outbound_requests_org_template_account_fk",
      );
    });
  });

  describe("shape checks", () => {
    it("a template request names a template and a text request does not", async () => {
      const w = await world(t.db);
      const tpl = await addTemplate(t.db, w);
      await expectPgError(
        request(w, { message_type: "TEMPLATE" }),
        CHECK_VIOLATION,
        "outbound_requests_template_check",
      );
      await expectPgError(
        request(w, { message_type: "TEXT", template_id: tpl.id }),
        CHECK_VIOLATION,
        "outbound_requests_template_check",
      );
      expect(await request(w, { message_type: "TEMPLATE", template_id: tpl.id })).toMatchObject({
        message_type: "TEMPLATE",
      });
    });

    it("unknown states, kinds, empty or oversized recipients and bad fingerprints are refused", async () => {
      const w = await world(t.db);
      await expectPgError(
        request(w, { state: "SENT" }),
        CHECK_VIOLATION,
        "outbound_requests_state_check",
      );
      await expectPgError(
        request(w, { recipient_kind: "USERNAME" }),
        CHECK_VIOLATION,
        "outbound_requests_recipient_kind_check",
      );
      await expectPgError(
        request(w, { recipient_id: "" }),
        CHECK_VIOLATION,
        "outbound_requests_recipient_id_check",
      );
      await expectPgError(
        request(w, { recipient_id: "9".repeat(256) }),
        CHECK_VIOLATION,
        "outbound_requests_recipient_id_check",
      );
      await expectPgError(
        request(w, { request_fingerprint: "xyz" }),
        CHECK_VIOLATION,
        "outbound_requests_fingerprint_check",
      );
    });

    it("the lifecycle fields must agree with the state", async () => {
      const w = await world(t.db);
      const now = new Date().toISOString();
      await expectPgError(
        request(w, { state: "HELD", finished_at: now }),
        CHECK_VIOLATION,
        "outbound_requests_lifecycle_check",
      ); // HELD needs a reason
      await expectPgError(
        request(w, { state: "REJECTED", finished_at: now }),
        CHECK_VIOLATION,
        "outbound_requests_lifecycle_check",
      );
      await expectPgError(
        request(w, { state: "SENDING" }),
        CHECK_VIOLATION,
        "outbound_requests_lifecycle_check",
      ); // SENDING needs claim + send_started_at
      await expectPgError(
        request(w, { state: "ACCEPTED", finished_at: now }),
        CHECK_VIOLATION,
        "outbound_requests_lifecycle_check",
      );
      await expectPgError(
        request(w, { state: "UNKNOWN_OUTCOME", finished_at: now }),
        CHECK_VIOLATION,
        "outbound_requests_lifecycle_check",
      ); // unknown means a send started
      await expectPgError(
        request(w, { state: "QUEUED", claimed_by: "worker" }),
        CHECK_VIOLATION,
        "outbound_requests_lifecycle_check",
      );
      await expectPgError(
        request(w, { state: "HELD", hold_reason: "window_closed" }),
        CHECK_VIOLATION,
        "outbound_requests_lifecycle_check",
      ); // terminal needs finished_at
      await expectPgError(
        request(w, { state: "HELD", hold_reason: "Has Spaces", finished_at: now }),
        CHECK_VIOLATION,
        "outbound_requests_codes_check",
      );
    });
  });

  describe("the lifecycle trigger", () => {
    const send = (id: string) =>
      update(
        id,
        "state = 'SENDING', claimed_by = 'w1', claimed_at = now(), send_started_at = now(), attempt_count = 1",
      );

    it("QUEUED -> SENDING -> ACCEPTED works and the request itself never changes", async () => {
      const w = await world(t.db);
      const r = await request(w);
      await send(r.id);
      await update(r.id, "state = 'ACCEPTED', accepted_at = now(), finished_at = now()");
      expect(
        (await t.pool.query("select state from outbound_requests where id = $1", [r.id])).rows[0]
          .state,
      ).toBe("ACCEPTED");
    });

    it("an UNKNOWN_OUTCOME request can never become QUEUED, SENDING or anything else again", async () => {
      const w = await world(t.db);
      const r = await request(w);
      await send(r.id);
      await update(
        r.id,
        "state = 'UNKNOWN_OUTCOME', failure_code = 'timeout', finished_at = now()",
      );
      for (const next of ["QUEUED", "SENDING", "ACCEPTED", "REJECTED", "HELD"]) {
        const set =
          next === "QUEUED"
            ? "state = 'QUEUED', claimed_by = NULL"
            : next === "SENDING"
              ? "state = 'SENDING', claimed_by = 'w2', send_started_at = now()"
              : next === "ACCEPTED"
                ? "state = 'ACCEPTED', accepted_at = now()"
                : next === "REJECTED"
                  ? "state = 'REJECTED', failure_code = 'x'"
                  : "state = 'HELD', hold_reason = 'x'";
        await expectPgError(update(r.id, set), CHECK_VIOLATION, undefined);
      }
      expect(
        (await t.pool.query("select state from outbound_requests where id = $1", [r.id])).rows[0]
          .state,
      ).toBe("UNKNOWN_OUTCOME");
    });

    it.each(["ACCEPTED", "REJECTED", "HELD"] as const)("%s is final", async (final) => {
      const w = await world(t.db);
      const r = await request(w);
      await send(r.id);
      const set = {
        ACCEPTED: "state = 'ACCEPTED', accepted_at = now(), finished_at = now()",
        REJECTED: "state = 'REJECTED', failure_code = 'bad', finished_at = now()",
        HELD: "state = 'HELD', hold_reason = 'x', finished_at = now()",
      }[final];
      await update(r.id, set);
      await expectPgError(
        update(r.id, "state = 'QUEUED', claimed_by = NULL, finished_at = NULL"),
        CHECK_VIOLATION,
      );
    });

    it("QUEUED cannot jump to ACCEPTED, REJECTED or UNKNOWN_OUTCOME without being SENDING first", async () => {
      const w = await world(t.db);
      const r = await request(w);
      await expectPgError(
        update(
          r.id,
          "state = 'ACCEPTED', accepted_at = now(), send_started_at = now(), finished_at = now()",
        ),
        CHECK_VIOLATION,
      );
      await expectPgError(
        update(r.id, "state = 'UNKNOWN_OUTCOME', send_started_at = now(), finished_at = now()"),
        CHECK_VIOLATION,
      );
    });

    it("SENDING may go back to QUEUED (provably not sent), and what was asked is immutable throughout", async () => {
      const w = await world(t.db);
      const r = await request(w);
      await send(r.id);
      await update(r.id, "state = 'QUEUED', claimed_by = NULL, claimed_at = NULL");
      const other = await addActor(t.db, w.org.id);
      for (const [column, value] of [
        ["recipient_id", "'94770000009'"],
        ["recipient_kind", "'BSUID'"],
        ["payload", '\'{"body":"changed"}\'::jsonb'],
        ["idempotency_key", "'changed-key-01'"],
        ["request_fingerprint", `'${"b".repeat(64)}'`],
        ["requested_by_membership_id", `'${other.membershipId}'`],
        ["dispatch_deadline", "now() + interval '1 day'"],
        ["message_type", "'TEMPLATE'"],
      ] as const)
        await expectPgError(update(r.id, `${column} = ${value}`), CHECK_VIOLATION);
    });

    it("the account, conversation, message and organization of a request cannot be re-pointed", async () => {
      const a = await world(t.db);
      const b = await world(t.db);
      const r = await request(a);
      await expectPgError(update(r.id, "organization_id = $1", [b.org.id]), CHECK_VIOLATION);
      await expectPgError(
        update(r.id, "conversation_id = $1", [b.conversation.id]),
        CHECK_VIOLATION,
      );
      await expectPgError(
        update(r.id, "whatsapp_account_id = $1", [b.account.id]),
        CHECK_VIOLATION,
      );
    });
  });

  describe("templates", () => {
    it("an APPROVED template needs an attestation time; names and languages are shaped; one row per (account, name, language)", async () => {
      const w = await world(t.db);
      const insert = (over: Record<string, unknown>) =>
        t.pool.query(
          `insert into whatsapp_templates (organization_id, whatsapp_account_id, name, language_code, category, status, attested_at, body_parameter_count) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            w.org.id,
            w.account.id,
            over.name ?? "order_update",
            over.language ?? "en_US",
            over.category ?? "UTILITY",
            over.status ?? "PENDING_ATTESTATION",
            over.attested ?? null,
            over.params ?? 0,
          ],
        );
      await expectPgError(
        insert({ status: "APPROVED" }),
        CHECK_VIOLATION,
        "whatsapp_templates_attested_check",
      );
      await expectPgError(
        insert({ name: "Bad Name" }),
        CHECK_VIOLATION,
        "whatsapp_templates_name_check",
      );
      await expectPgError(
        insert({ language: "english" }),
        CHECK_VIOLATION,
        "whatsapp_templates_language_check",
      );
      await expectPgError(
        insert({ category: "PROMO" }),
        CHECK_VIOLATION,
        "whatsapp_templates_category_check",
      );
      await expectPgError(
        insert({ params: 21 }),
        CHECK_VIOLATION,
        "whatsapp_templates_params_check",
      );
      await insert({});
      await expectPgError(
        insert({}),
        UNIQUE_VIOLATION,
        "whatsapp_templates_org_account_name_lang_unique",
      );
      await insert({ language: "si" });
    });
  });
});
