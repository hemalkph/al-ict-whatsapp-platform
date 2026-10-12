import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_VIOLATION,
  FK_VIOLATION,
  UNIQUE_VIOLATION,
  createTestDatabase,
  expectPgError,
  type TestDb,
} from "@/db/__tests__/helpers";
import { addMessage, world } from "./testing";

// Migration 0005 on real PostgreSQL: the append-only triggers, CHECK constraints, tenant foreign keys and uniqueness of the
// staff-inbox tables. These are the database's own guarantees; the services above rely on them but do not replace them.

describe("migration 0005: staff inbox schema", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());
  const q = (sql: string, params: unknown[] = []) => t.pool.query(sql, params);

  const event = (
    x: { org: { id: string }; conversation: { id: string } },
    actor: string,
    cols: Record<string, unknown>,
  ) =>
    q(
      `insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_assignee_membership_id, to_assignee_membership_id, from_status, to_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        x.org.id,
        x.conversation.id,
        cols.kind,
        actor,
        cols.fromA ?? null,
        cols.toA ?? null,
        cols.fromS ?? null,
        cols.toS ?? null,
      ],
    );

  it("conversation history and notes are append-only: no UPDATE and no DELETE, enforced by a trigger", async () => {
    const x = await world(t.db);
    await event(x, x.actor.membershipId, { kind: "STATUS", fromS: "OPEN", toS: "PENDING" });
    await q(
      "insert into conversation_notes (organization_id, conversation_id, author_membership_id, body) values ($1,$2,$3,'n')",
      [x.org.id, x.conversation.id, x.actor.membershipId],
    );
    await expectPgError(
      q("update conversation_events set to_status = 'RESOLVED' where conversation_id = $1", [
        x.conversation.id,
      ]),
      CHECK_VIOLATION,
    );
    await expectPgError(
      q("delete from conversation_events where conversation_id = $1", [x.conversation.id]),
      CHECK_VIOLATION,
    );
    await expectPgError(
      q("update conversation_notes set body = 'edited' where conversation_id = $1", [
        x.conversation.id,
      ]),
      CHECK_VIOLATION,
    );
    await expectPgError(
      q("delete from conversation_notes where conversation_id = $1", [x.conversation.id]),
      CHECK_VIOLATION,
    );
    expect(
      (
        await q("select count(*)::int n from conversation_events where conversation_id = $1", [
          x.conversation.id,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it("history rows must have the shape of their kind", async () => {
    const x = await world(t.db);
    const m = x.actor.membershipId;
    await expectPgError(
      event(x, m, { kind: "STATUS", fromS: "OPEN", toS: "OPEN" }),
      CHECK_VIOLATION,
      "conversation_events_shape_check",
    );
    await expectPgError(
      event(x, m, { kind: "STATUS", fromS: "OPEN" }),
      CHECK_VIOLATION,
      "conversation_events_shape_check",
    );
    await expectPgError(
      event(x, m, { kind: "STATUS", fromS: "OPEN", toS: "PENDING", toA: m }),
      CHECK_VIOLATION,
      "conversation_events_shape_check",
    );
    await expectPgError(
      event(x, m, { kind: "ASSIGNMENT", fromA: m, toA: m }),
      CHECK_VIOLATION,
      "conversation_events_shape_check",
    );
    await expectPgError(
      event(x, m, { kind: "ASSIGNMENT", toA: m, toS: "OPEN" }),
      CHECK_VIOLATION,
      "conversation_events_shape_check",
    );
    await expectPgError(
      event(x, m, { kind: "OTHER", fromS: "OPEN", toS: "PENDING" }),
      CHECK_VIOLATION,
      "conversation_events_kind_check",
    );
    await expectPgError(
      event(x, m, { kind: "STATUS", fromS: "OPEN", toS: "DONE" }),
      CHECK_VIOLATION,
    );
    await event(x, m, { kind: "ASSIGNMENT", toA: m });
    await event(x, m, { kind: "ASSIGNMENT", fromA: m });
  });

  it("every membership and conversation reference is organization-aware: another organization's rows are refused by the database", async () => {
    const x = await world(t.db);
    const y = await world(t.db);
    const foreignMember = y.actor.membershipId;
    await expectPgError(
      event(x, foreignMember, { kind: "STATUS", fromS: "OPEN", toS: "PENDING" }),
      FK_VIOLATION,
      "conversation_events_org_actor_fk",
    );
    await expectPgError(
      event(x, x.actor.membershipId, { kind: "ASSIGNMENT", toA: foreignMember }),
      FK_VIOLATION,
      "conversation_events_org_to_assignee_fk",
    );
    await expectPgError(
      q(
        "insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_status, to_status) values ($1,$2,'STATUS',$3,'OPEN','PENDING')",
        [x.org.id, y.conversation.id, x.actor.membershipId],
      ),
      FK_VIOLATION,
      "conversation_events_org_conversation_fk",
    );
    await expectPgError(
      q(
        "insert into conversation_notes (organization_id, conversation_id, author_membership_id, body) values ($1,$2,$3,'n')",
        [x.org.id, x.conversation.id, foreignMember],
      ),
      FK_VIOLATION,
      "conversation_notes_org_author_fk",
    );
    await expectPgError(
      q(
        "insert into conversation_notes (organization_id, conversation_id, author_membership_id, body) values ($1,$2,$3,'n')",
        [x.org.id, y.conversation.id, x.actor.membershipId],
      ),
      FK_VIOLATION,
      "conversation_notes_org_conversation_fk",
    );
    await expectPgError(
      q("update conversations set assigned_membership_id = $2, assigned_at = now() where id = $1", [
        x.conversation.id,
        foreignMember,
      ]),
      FK_VIOLATION,
      "conversations_org_assignee_fk",
    );
    await expectPgError(
      q(
        "insert into quick_replies (organization_id, title, body, created_by_membership_id) values ($1,'t','b',$2)",
        [x.org.id, foreignMember],
      ),
      FK_VIOLATION,
      "quick_replies_org_creator_fk",
    );
    const mine = await addMessage(t.db, x, { direction: "INBOUND" });
    const theirs = await addMessage(t.db, y, { direction: "INBOUND" });
    await expectPgError(
      q(
        "insert into message_reads (organization_id, membership_id, message_id) values ($1,$2,$3)",
        [x.org.id, foreignMember, mine.id],
      ),
      FK_VIOLATION,
      "message_reads_org_membership_fk",
    );
    await expectPgError(
      q(
        "insert into message_reads (organization_id, membership_id, message_id) values ($1,$2,$3)",
        [x.org.id, x.actor.membershipId, theirs.id],
      ),
      FK_VIOLATION,
      "message_reads_org_message_fk",
    );
  });

  it("a conversation has either an assignee and an assignment time, or neither", async () => {
    const x = await world(t.db);
    await expectPgError(
      q("update conversations set assigned_membership_id = $2 where id = $1", [
        x.conversation.id,
        x.actor.membershipId,
      ]),
      CHECK_VIOLATION,
      "conversations_assignment_check",
    );
    await expectPgError(
      q("update conversations set assigned_at = now() where id = $1", [x.conversation.id]),
      CHECK_VIOLATION,
      "conversations_assignment_check",
    );
    await q(
      "update conversations set assigned_membership_id = $2, assigned_at = now() where id = $1",
      [x.conversation.id, x.actor.membershipId],
    );
    await q(
      "update conversations set assigned_membership_id = null, assigned_at = null where id = $1",
      [x.conversation.id],
    );
  });

  it("notes and quick replies are bounded and non-blank in the database", async () => {
    const x = await world(t.db);
    const note = (body: string) =>
      q(
        "insert into conversation_notes (organization_id, conversation_id, author_membership_id, body) values ($1,$2,$3,$4)",
        [x.org.id, x.conversation.id, x.actor.membershipId, body],
      );
    await expectPgError(note(""), CHECK_VIOLATION, "conversation_notes_body_check");
    await expectPgError(note("   "), CHECK_VIOLATION, "conversation_notes_body_check");
    await expectPgError(note("x".repeat(4001)), CHECK_VIOLATION, "conversation_notes_body_check");
    await note("x".repeat(4000));
    const reply = (title: string, body: string) =>
      q(
        "insert into quick_replies (organization_id, title, body, created_by_membership_id) values ($1,$2,$3,$4)",
        [x.org.id, title, body, x.actor.membershipId],
      );
    await expectPgError(reply("", "b"), CHECK_VIOLATION, "quick_replies_title_check");
    await expectPgError(reply("t".repeat(61), "b"), CHECK_VIOLATION, "quick_replies_title_check");
    await expectPgError(reply("ok", " "), CHECK_VIOLATION, "quick_replies_body_check");
    await expectPgError(reply("ok", "b".repeat(1001)), CHECK_VIOLATION, "quick_replies_body_check");
  });

  it("quick-reply titles are unique among ACTIVE replies per organization, ignoring case; archived ones free the title; organizations are independent", async () => {
    const x = await world(t.db);
    const y = await world(t.db);
    const ins = (w: typeof x, title: string) =>
      q(
        "insert into quick_replies (organization_id, title, body, created_by_membership_id) values ($1,$2,'b',$3) returning id",
        [w.org.id, title, w.actor.membershipId],
      );
    const first = await ins(x, "Greeting");
    await expectPgError(
      ins(x, " GREETING "),
      UNIQUE_VIOLATION,
      "quick_replies_org_active_title_uidx",
    );
    await ins(y, "Greeting");
    await q("update quick_replies set archived_at = now() where id = $1", [first.rows[0].id]);
    await ins(x, "Greeting");
  });

  it("a message can be marked seen by a member only once", async () => {
    const x = await world(t.db);
    const m = await addMessage(t.db, x, { direction: "INBOUND" });
    await q(
      "insert into message_reads (organization_id, membership_id, message_id) values ($1,$2,$3)",
      [x.org.id, x.actor.membershipId, m.id],
    );
    await expectPgError(
      q(
        "insert into message_reads (organization_id, membership_id, message_id) values ($1,$2,$3)",
        [x.org.id, x.actor.membershipId, m.id],
      ),
      UNIQUE_VIOLATION,
      "message_reads_pk",
    );
  });

  it("the indexes the inbox relies on exist", async () => {
    const names = (
      await q("select indexname from pg_indexes where schemaname = 'public'")
    ).rows.map((r) => r.indexname);
    for (const expected of [
      "conversations_org_activity_idx",
      "conversations_assignee_idx",
      "messages_inbound_conversation_idx",
      "conversation_events_conversation_idx",
      "conversation_notes_conversation_idx",
      "message_reads_message_idx",
      "quick_replies_org_active_title_uidx",
    ])
      expect(names).toContain(expected);
  });

  it("existing rows are untouched by the migration: the new conversation columns default to unassigned", async () => {
    const x = await world(t.db);
    const row = (
      await q(
        "select assigned_membership_id, assigned_at, status from conversations where id = $1",
        [x.conversation.id],
      )
    ).rows[0];
    expect(row).toEqual({ assigned_membership_id: null, assigned_at: null, status: "OPEN" });
  });
});
