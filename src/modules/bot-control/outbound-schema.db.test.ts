import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_VIOLATION,
  FK_VIOLATION,
  UNIQUE_VIOLATION,
  createTestDatabase,
  expectPgError,
  pgError,
  seedAccount,
  type TestDb,
} from "@/db/__tests__/helpers";
import { addTemplate } from "@/modules/messaging/testing";
import {
  addStudent,
  botWorld,
  dispatchWorld,
  liveSessionFor,
  windowStudent,
  type DispatchFixture,
  type LiveSession,
} from "./testing";

// Phase 08E-0.2: raw-SQL rejection regressions for migration 0008 (ADR 0020), closing the first outstanding Phase 08D
// condition. Everything here reaches outbound_requests, conversation_events and bot_deployment_events with plain SQL, exactly
// as any future writer would, so the DATABASE (CHECKs, the composite foreign key, the unique indexes, the guard trigger and
// the allocation triggers) is what is tested, never an application service. Disposable al_ict_test_* databases only.
//
// Method: the first test proves a valid baseline row of each kind is ACCEPTED; every later test changes exactly one thing
// from that baseline and expects the named constraint (or the guard's message), so a rejection can never be an artifact of a
// broken fixture. Where a violation necessarily breaks two constraints at once (a NULL step also breaks the key check, an
// unknown type also breaks the origin-type check) the test accepts that named set instead of relying on the order in which
// PostgreSQL evaluates constraints.

describe("migration 0008: raw-SQL guarantees on outbound requests, control sequences and deployment events", () => {
  let t: TestDb;
  let f: DispatchFixture;
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);

  beforeAll(async () => {
    t = await createTestDatabase();
    f = await dispatchWorld(t, { lastInboundAt: new Date() });
  });
  afterAll(async () => t.close());

  // ------------------------------------------------------------------------------------------------------ fixtures

  /** A new student (own contact, conversation and inbound message) with a live session: nothing is shared between tests. */
  async function fresh(): Promise<LiveSession> {
    return liveSessionFor(t, f, await windowStudent(t, f.w, new Date()));
  }

  async function outboundMessage(
    organizationId: string,
    conversationId: string,
    accountId: string,
    type = "TEXT",
  ): Promise<string> {
    const r = await q(
      `insert into messages (organization_id, conversation_id, whatsapp_account_id, direction, type, body, occurred_at)
       values ($1, $2, $3, 'OUTBOUND', $4, 'x', now()) returning id`,
      [organizationId, conversationId, accountId, type],
    );
    return r.rows[0].id as string;
  }

  /** Columns of a valid BOT request for session `s` (the baseline every negative test varies by exactly one thing). */
  async function botCols(
    s: LiveSession,
    over: Record<string, unknown> = {},
    messageType = "TEXT",
  ): Promise<Record<string, unknown>> {
    return {
      organization_id: s.keys.organizationId,
      whatsapp_account_id: s.keys.whatsappAccountId,
      conversation_id: s.student.conversation.id,
      message_id: await outboundMessage(
        s.keys.organizationId,
        s.student.conversation.id,
        s.keys.whatsappAccountId,
        messageType,
      ),
      requested_by_membership_id: null,
      origin: "BOT",
      bot_session_id: s.id,
      bot_step_seq: 1,
      bot_send_epoch: 1,
      idempotency_key: `bot-${s.id}-1`,
      request_fingerprint: "a".repeat(64),
      message_type: messageType,
      recipient_kind: "PHONE",
      recipient_id: "94770000001",
      payload: JSON.stringify({ body: "x" }),
      dispatch_deadline: new Date(Date.now() + 120_000).toISOString(),
      ...over,
    };
  }

  /** Columns of a valid STAFF request in the student's conversation. */
  async function staffCols(
    s: LiveSession,
    over: Record<string, unknown> = {},
    messageType = "TEXT",
  ): Promise<Record<string, unknown>> {
    return {
      organization_id: s.keys.organizationId,
      whatsapp_account_id: s.keys.whatsappAccountId,
      conversation_id: s.student.conversation.id,
      message_id: await outboundMessage(
        s.keys.organizationId,
        s.student.conversation.id,
        s.keys.whatsappAccountId,
        messageType,
      ),
      requested_by_membership_id: f.w.staff.membershipId,
      idempotency_key: `staff-${randomUUID()}`,
      request_fingerprint: "a".repeat(64),
      message_type: messageType,
      recipient_kind: "PHONE",
      recipient_id: "94770000001",
      payload: JSON.stringify({ body: "x" }),
      dispatch_deadline: new Date(Date.now() + 900_000).toISOString(),
      ...over,
    };
  }

  const insert = async (cols: Record<string, unknown>) => {
    const keys = Object.keys(cols);
    const r = await q(
      `insert into outbound_requests (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
      keys.map((k) => cols[k]),
    );
    return r.rows[0] as Record<string, unknown> & { id: string };
  };

  const update = (id: string, set: string, params: unknown[] = []) =>
    q(`update outbound_requests set ${set} where id = $${params.length + 1}`, [...params, id]);

  const snapshot = async (id: string) =>
    (await q("select to_jsonb(r) as row from outbound_requests r where id = $1", [id])).rows[0]
      .row as Record<string, unknown>;

  /** The statement fails with `code` and the violated constraint is one of `names` (never relies on evaluation order). */
  async function expectOneOf(p: Promise<unknown>, code: string, names: readonly string[]) {
    let caught: unknown;
    try {
      await p;
    } catch (e) {
      caught = e;
    }
    if (!caught)
      throw new Error(`Expected ${code} (${names.join(" | ")}), but the statement succeeded`);
    const got = pgError(caught);
    if (got.code !== code || !names.includes(got.constraint ?? "")) {
      throw new Error(
        `Expected ${code} (${names.join(" | ")}), got ${got.code} (${got.constraint}): ${got.message}`,
      );
    }
  }

  /** The guard trigger refuses (check_violation, no constraint name) with a message containing `fragment`. */
  async function expectGuard(p: Promise<unknown>, fragment: string) {
    let caught: unknown;
    try {
      await p;
    } catch (e) {
      caught = e;
    }
    if (!caught)
      throw new Error(`Expected the guard to refuse "${fragment}", but the statement succeeded`);
    const got = pgError(caught);
    if (got.code !== CHECK_VIOLATION || !got.message.includes(fragment)) {
      throw new Error(
        `Expected guard "${fragment}" (${CHECK_VIOLATION}), got ${got.code}: ${got.message}`,
      );
    }
  }

  const origin = "outbound_requests_origin_check";
  const shape = "outbound_requests_origin_shape_check";
  const typeOrigin = "outbound_requests_origin_type_check";
  const key = "outbound_requests_bot_key_check";
  const typeAll = "outbound_requests_type_check";

  // ----------------------------------------------------------------------------------------------------- baseline

  it("baseline: a valid BOT text, BOT interactive, STAFF text and STAFF template request are each accepted, and the database sequences them", async () => {
    const bot = await insert(await botCols(await fresh()));
    const interactive = await insert(await botCols(await fresh(), {}, "INTERACTIVE"));
    const staff = await insert(await staffCols(await fresh()));
    const template = await addTemplate(t.db, f.w);
    const staffTemplate = await insert(
      await staffCols(await fresh(), { template_id: template.id }, "TEMPLATE"),
    );
    expect(bot).toMatchObject({ origin: "BOT", requested_by_membership_id: null, state: "QUEUED" });
    expect(interactive).toMatchObject({ origin: "BOT", message_type: "INTERACTIVE" });
    expect(staff).toMatchObject({ origin: "STAFF", bot_session_id: null, bot_step_seq: null });
    expect(staffTemplate).toMatchObject({ origin: "STAFF", message_type: "TEMPLATE" });
    for (const r of [bot, interactive, staff, staffTemplate]) expect(r.control_seq).not.toBeNull();
  });

  // ---------------------------------------------------------------------------------------------------- CHECK constraints

  it("origin must be STAFF or BOT", async () => {
    // an unknown origin also falls outside both branches of the shape check, so either may be the one reported
    await expectOneOf(insert(await botCols(await fresh(), { origin: "ROBOT" })), CHECK_VIOLATION, [
      origin,
      shape,
    ]);
    await expectOneOf(insert(await staffCols(await fresh(), { origin: "bot" })), CHECK_VIOLATION, [
      origin,
      shape,
    ]);
  });

  it("a STAFF row needs its member and carries no bot column", async () => {
    const s = await fresh();
    await expectPgError(
      insert(await staffCols(s, { requested_by_membership_id: null })),
      CHECK_VIOLATION,
      shape,
    ); // the member became optional for BOT, never for STAFF
    await expectPgError(
      insert(await staffCols(s, { bot_session_id: s.id })),
      CHECK_VIOLATION,
      shape,
    );
    await expectPgError(insert(await staffCols(s, { bot_step_seq: 1 })), CHECK_VIOLATION, shape);
    await expectPgError(insert(await staffCols(s, { bot_send_epoch: 1 })), CHECK_VIOLATION, shape);
  });

  it("a BOT row has no member and a session, a step of at least 1 and an epoch of at least 1", async () => {
    const s = await fresh();
    await expectPgError(
      insert(await botCols(s, { requested_by_membership_id: f.w.staff.membershipId })),
      CHECK_VIOLATION,
      shape,
    );
    await expectPgError(
      insert(await botCols(s, { bot_step_seq: 0, idempotency_key: `bot-${s.id}-0` })),
      CHECK_VIOLATION,
      shape,
    );
    await expectPgError(insert(await botCols(s, { bot_send_epoch: 0 })), CHECK_VIOLATION, shape);
    await expectPgError(insert(await botCols(s, { bot_send_epoch: null })), CHECK_VIOLATION, shape);
    // a NULL session or step also makes the derived key NULL, so the key check fails with it
    await expectOneOf(insert(await botCols(s, { bot_step_seq: null })), CHECK_VIOLATION, [
      shape,
      key,
    ]);
    await expectOneOf(insert(await botCols(s, { bot_session_id: null })), CHECK_VIOLATION, [
      shape,
      key,
    ]);
  });

  it("BOT rows are TEXT or INTERACTIVE only, STAFF rows TEXT or TEMPLATE only, and no other type exists", async () => {
    const template = await addTemplate(t.db, f.w);
    await expectPgError(
      insert(await botCols(await fresh(), { template_id: template.id }, "TEMPLATE")),
      CHECK_VIOLATION,
      typeOrigin,
    ); // a bot never sends a template (unapproved marketing)
    await expectPgError(
      insert(await staffCols(await fresh(), {}, "INTERACTIVE")),
      CHECK_VIOLATION,
      typeOrigin,
    ); // staff never send interactive messages
    await expectOneOf(insert(await botCols(await fresh(), {}, "VIDEO")), CHECK_VIOLATION, [
      typeAll,
      typeOrigin,
    ]);
    await expectOneOf(insert(await staffCols(await fresh(), {}, "VIDEO")), CHECK_VIOLATION, [
      typeAll,
      typeOrigin,
    ]);
  });

  it("a BOT request's idempotency key is exactly bot-<session>-<step>", async () => {
    const s = await fresh();
    const other = await fresh();
    await expectPgError(
      insert(await botCols(s, { idempotency_key: `bot-${other.id}-1` })),
      CHECK_VIOLATION,
      key,
    );
    await expectPgError(
      insert(await botCols(s, { idempotency_key: `bot-${s.id}-2` })),
      CHECK_VIOLATION,
      key,
    );
    await expectPgError(
      insert(await botCols(s, { idempotency_key: "free-form-key-001" })),
      CHECK_VIOLATION,
      key,
    );
    // a STAFF key is free-form, as before
    await insert(await staffCols(s, { idempotency_key: "free-form-staff-key" }));
  });

  // ------------------------------------------------------------------------------------------------- composite foreign key

  it("the BOT session foreign key binds session, conversation, account and organization together", async () => {
    const fk = "outbound_requests_bot_session_fk";
    const s = await fresh();
    const s2 = await fresh();
    // a session of ANOTHER conversation (same organization and account)
    await expectPgError(
      insert(await botCols(s, { bot_session_id: s2.id, idempotency_key: `bot-${s2.id}-1` })),
      FK_VIOLATION,
      fk,
    );
    // a conversation of another WHATSAPP ACCOUNT of the same organization
    const accountB = await seedAccount(t.db, f.w.org.id);
    const studentB = await addStudent(t.db, f.w.org.id, accountB.id);
    await expectPgError(
      insert({
        ...(await botCols(s)),
        whatsapp_account_id: accountB.id,
        conversation_id: studentB.conversation.id,
        message_id: await outboundMessage(f.w.org.id, studentB.conversation.id, accountB.id),
      }),
      FK_VIOLATION,
      fk,
    );
    // a conversation, account and message of ANOTHER ORGANIZATION naming this organization's session
    const foreign = await botWorld(t.db);
    await expectPgError(
      insert({
        ...(await botCols(s)),
        organization_id: foreign.org.id,
        whatsapp_account_id: foreign.account.id,
        conversation_id: foreign.student.conversation.id,
        message_id: await outboundMessage(
          foreign.org.id,
          foreign.student.conversation.id,
          foreign.account.id,
        ),
      }),
      FK_VIOLATION,
      fk,
    );
    // no such session at all
    const ghost = randomUUID();
    await expectPgError(
      insert(await botCols(s, { bot_session_id: ghost, idempotency_key: `bot-${ghost}-1` })),
      FK_VIOLATION,
      fk,
    );
    // MATCH SIMPLE: a STAFF row (NULL session) is not constrained by it
    await insert(await staffCols(s));
  });

  // ------------------------------------------------------------------------------------------------------ unique indexes

  it("one request per session step, and one request in flight per session", async () => {
    const s = await fresh();
    const first = await insert(await botCols(s));
    // the step index is the only thing violated once the first request is final (HELD is a legal, final move from QUEUED)
    await update(first.id, "state = 'HELD', hold_reason = 'test_hold', finished_at = now()");
    await expectPgError(
      insert(await botCols(s)),
      UNIQUE_VIOLATION,
      "outbound_requests_bot_step_uidx",
    );
    // the next step is a new request ...
    await insert(await botCols(s, { bot_step_seq: 2, idempotency_key: `bot-${s.id}-2` }));
    // ... but a third step while step 2 is still QUEUED breaks the in-flight rule (session and conversation index)
    await expectOneOf(
      insert(await botCols(s, { bot_step_seq: 3, idempotency_key: `bot-${s.id}-3` })),
      UNIQUE_VIOLATION,
      ["outbound_requests_bot_inflight_uidx", "outbound_requests_bot_conv_inflight_uidx"],
    );
  });

  // ----------------------------------------------------------------------------------------------------- guard: immutable

  it("origin, the bot bindings, the control sequence and the requester can never be changed", async () => {
    const s = await fresh();
    const s2 = await fresh();
    const bot = await insert(await botCols(s));
    const staff = await insert(await staffCols(await fresh()));
    const before = { bot: await snapshot(bot.id), staff: await snapshot(staff.id) };
    const immutable = "the request itself is immutable";
    for (const [set, params] of [
      ["origin = 'STAFF'", []],
      ["bot_session_id = $1", [s2.id]],
      ["bot_step_seq = 2", []],
      ["bot_send_epoch = 2", []],
      ["control_seq = control_seq + 1", []],
      ["requested_by_membership_id = $1", [f.w.staff.membershipId]],
    ] as const)
      await expectGuard(update(bot.id, set, [...params]), immutable);
    for (const [set, params] of [
      ["origin = 'BOT'", []],
      ["bot_session_id = $1", [s.id]],
      ["bot_step_seq = 1", []],
      ["bot_send_epoch = 1", []],
      ["control_seq = control_seq + 1", []],
      ["requested_by_membership_id = NULL", []],
    ] as const)
      await expectGuard(update(staff.id, set, [...params]), immutable);
    // every refusal left both rows exactly as they were
    expect(await snapshot(bot.id)).toEqual(before.bot);
    expect(await snapshot(staff.id)).toEqual(before.staff);
  });

  it("a BOT request moves only forward and is never re-queued after SENDING, while STAFF keeps the old path", async () => {
    const claim =
      "state = 'SENDING', claimed_by = 'w1', claimed_at = now(), send_started_at = now(), attempt_count = 1";
    const requeue = "state = 'QUEUED', claimed_by = NULL, claimed_at = NULL";
    const bot = await insert(await botCols(await fresh()));
    await expectGuard(
      update(
        bot.id,
        "state = 'ACCEPTED', accepted_at = now(), send_started_at = now(), finished_at = now()",
      ),
      "illegal state change QUEUED -> ACCEPTED (BOT)",
    );
    await update(bot.id, claim);
    await expectGuard(update(bot.id, requeue), "illegal state change SENDING -> QUEUED (BOT)");
    await update(bot.id, "state = 'ACCEPTED', accepted_at = now(), finished_at = now()");
    await expectGuard(
      update(bot.id, "state = 'QUEUED', claimed_by = NULL, claimed_at = NULL, finished_at = NULL"),
      "illegal state change ACCEPTED -> QUEUED (BOT)",
    );
    expect((await snapshot(bot.id)).state).toBe("ACCEPTED");
    // STAFF: SENDING -> QUEUED (provably not sent) is still allowed
    const staff = await insert(await staffCols(await fresh()));
    await update(staff.id, claim);
    await update(staff.id, requeue);
    expect((await snapshot(staff.id)).state).toBe("QUEUED");
  });

  // ------------------------------------------------------------------------------------------------- control sequences

  it("the database overwrites a supplied control sequence on outbound requests and conversation events", async () => {
    const s = await fresh();
    const conversation = s.student.conversation.id;
    const seq = async () =>
      (await q("select control_seq from conversations where id = $1", [conversation])).rows[0]
        .control_seq as string;
    const bot = await insert(await botCols(s, { control_seq: 999999 }));
    expect(bot.control_seq).not.toBe("999999");
    expect(bot.control_seq).toBe(await seq()); // the latest allocation on this conversation
    const event = (
      await q(
        `insert into conversation_events (organization_id, conversation_id, kind, actor_membership_id, from_status, to_status, control_seq)
         values ($1, $2, 'STATUS', $3, 'OPEN', 'PENDING', 777777) returning control_seq`,
        [f.w.org.id, conversation, f.w.staff.membershipId],
      )
    ).rows[0] as { control_seq: string };
    expect(event.control_seq).not.toBe("777777");
    expect(event.control_seq).toBe(await seq());
    expect(Number(event.control_seq)).toBe(Number(bot.control_seq) + 1); // one allocation each, in commit order
  });

  it("a conversation of another organization is left to the foreign keys: no sequence is allocated, the insert is refused", async () => {
    const s = await fresh();
    const foreign = await botWorld(t.db);
    const before = (
      await q("select control_seq from conversations where id = $1", [
        foreign.student.conversation.id,
      ])
    ).rows[0].control_seq as string;
    await expectPgError(
      insert({
        ...(await staffCols(s)),
        conversation_id: foreign.student.conversation.id,
        message_id: await outboundMessage(
          foreign.org.id,
          foreign.student.conversation.id,
          foreign.account.id,
        ),
      }),
      FK_VIOLATION,
    );
    expect(
      (
        await q("select control_seq from conversations where id = $1", [
          foreign.student.conversation.id,
        ])
      ).rows[0].control_seq,
    ).toBe(before);
  });

  // ------------------------------------------------------------------------------------------- deployment event counts

  it("a deployment event's in-flight count cannot be negative (and defaults to zero)", async () => {
    const event = (requestsInFlight: number) =>
      q(
        `insert into bot_deployment_events (organization_id, deployment_id, whatsapp_account_id, bot_id, kind, actor_membership_id, from_status, to_status, send_epoch, requests_in_flight)
         values ($1, $2, $3, $4, 'PAUSED', $5, 'ACTIVE', 'PAUSED', 1, $6) returning requests_in_flight`,
        [
          f.w.org.id,
          f.d.deployment.id,
          f.w.account.id,
          f.d.bot.id,
          f.w.admin.membershipId,
          requestsInFlight,
        ],
      );
    expect((await event(0)).rows[0].requests_in_flight).toBe(0); // valid baseline
    await expectPgError(event(-1), CHECK_VIOLATION, "bot_deployment_events_counts_check");
    const defaulted = await q(
      `insert into bot_deployment_events (organization_id, deployment_id, whatsapp_account_id, bot_id, kind, actor_membership_id, from_status, to_status, send_epoch)
       values ($1, $2, $3, $4, 'RESUMED', $5, 'PAUSED', 'ACTIVE', 1) returning requests_in_flight`,
      [f.w.org.id, f.d.deployment.id, f.w.account.id, f.d.bot.id, f.w.admin.membershipId],
    );
    expect(defaulted.rows[0].requests_in_flight).toBe(0);
  });

  // --------------------------------------------------------------------------------------------------------- catalog

  it("catalog: every object migration 0008 created exists with the intended shape", async () => {
    const names = async (sql: string, params: unknown[] = []) =>
      (await q(sql, params)).rows.map((r) => (r as { n: string }).n).sort();
    expect(
      await names(
        `select conname as n from pg_constraint
          where conrelid = 'outbound_requests'::regclass
            and conname = any($1) and convalidated`,
        [[origin, shape, typeOrigin, key, typeAll, "outbound_requests_bot_session_fk"]],
      ),
    ).toEqual([origin, shape, typeOrigin, key, typeAll, "outbound_requests_bot_session_fk"].sort());
    // the session foreign key is MATCH SIMPLE (skipped for STAFF rows), four columns wide, onto bot_sessions
    expect(
      (
        await q(
          `select confmatchtype::text as m, array_length(conkey, 1) as w, confrelid::regclass::text as t
             from pg_constraint where conname = 'outbound_requests_bot_session_fk'`,
        )
      ).rows,
    ).toEqual([{ m: "s", w: 4, t: "bot_sessions" }]);
    // three unique partial indexes, and the staff-control and event indexes
    const indexes = (
      await q(
        `select indexname as n, indexdef as d from pg_indexes
          where indexname = any($1)`,
        [
          [
            "outbound_requests_bot_step_uidx",
            "outbound_requests_bot_inflight_uidx",
            "outbound_requests_bot_conv_inflight_uidx",
            "outbound_requests_staff_control_idx",
            "conversation_events_control_idx",
            "conversation_events_resolved_control_idx",
          ],
        ],
      )
    ).rows as Array<{ n: string; d: string }>;
    expect(indexes.map((i) => i.n).sort()).toEqual(
      [
        "conversation_events_control_idx",
        "conversation_events_resolved_control_idx",
        "outbound_requests_bot_conv_inflight_uidx",
        "outbound_requests_bot_inflight_uidx",
        "outbound_requests_bot_step_uidx",
        "outbound_requests_staff_control_idx",
      ].sort(),
    );
    // every index except the plain event index is partial; the three step/in-flight indexes are unique
    for (const i of indexes.filter((x) => x.n !== "conversation_events_control_idx"))
      expect(i.d, i.n).toMatch(/ WHERE /);
    for (const i of indexes.filter((x) => x.n.endsWith("_uidx")))
      expect(i.d, i.n).toMatch(/UNIQUE/);
    // functions and triggers
    expect(
      await names(`select proname as n from pg_proc where proname = any($1)`, [
        [
          "bot_request_hold_code",
          "outbound_requests_guard",
          "outbound_requests_allocate_control_seq",
          "conversation_events_allocate_control_seq",
        ],
      ]),
    ).toEqual(
      [
        "bot_request_hold_code",
        "conversation_events_allocate_control_seq",
        "outbound_requests_allocate_control_seq",
        "outbound_requests_guard",
      ].sort(),
    );
    expect(
      await names(
        `select tgname as n from pg_trigger where not tgisinternal and tgname = any($1)`,
        [
          [
            "outbound_requests_guard_trg",
            "outbound_requests_allocate_control_seq_trg",
            "conversation_events_allocate_control_seq_trg",
          ],
        ],
      ),
    ).toEqual(
      [
        "conversation_events_allocate_control_seq_trg",
        "outbound_requests_allocate_control_seq_trg",
        "outbound_requests_guard_trg",
      ].sort(),
    );
    // columns
    const cols = (
      await q(
        `select column_name as c, data_type as d, is_nullable as nullable, column_default as def
           from information_schema.columns
          where table_name = 'outbound_requests'
            and column_name in ('origin','bot_session_id','bot_step_seq','bot_send_epoch','control_seq','requested_by_membership_id')`,
      )
    ).rows as Array<{ c: string; d: string; nullable: string; def: string | null }>;
    const col = (c: string) => cols.find((x) => x.c === c);
    expect(col("origin")).toMatchObject({ d: "text", nullable: "NO" });
    expect(col("origin")?.def).toMatch(/'STAFF'/);
    expect(col("bot_session_id")).toMatchObject({ d: "uuid", nullable: "YES" });
    expect(col("bot_step_seq")).toMatchObject({ d: "integer", nullable: "YES" });
    expect(col("bot_send_epoch")).toMatchObject({ d: "bigint", nullable: "YES" });
    expect(col("control_seq")).toMatchObject({ d: "bigint", nullable: "YES" });
    expect(col("requested_by_membership_id")?.nullable).toBe("YES");
    expect(
      (
        await q(
          `select data_type as d, is_nullable as nullable from information_schema.columns
            where table_name = 'bot_deployment_events' and column_name = 'requests_in_flight'`,
        )
      ).rows,
    ).toEqual([{ d: "integer", nullable: "NO" }]);
  });
});
