import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_VIOLATION,
  FK_VIOLATION,
  NOT_NULL_VIOLATION,
  UNIQUE_VIOLATION,
  createTestDatabase,
  expectPgError,
  seedAccount,
  type TestDb,
} from "@/db/__tests__/helpers";
import { minimalFlow } from "@/modules/bots/testing";
import { changeDeploymentVersion, publishVersion, updateDraft } from "./index";
import {
  addStudent,
  botWorld,
  deployedBot,
  insertSession,
  publishedBot,
  rowOf,
  updateSession,
  type BotWorld,
  type SessionKeys,
} from "./testing";

// Migration 0007's database guarantees (Phase 08C, ADR 0019), exercised with RAW SQL on a disposable al_ict_test_* database:
// version immutability and canonical/hash/jsonb consistency, draft rules, the deployment guard, whole-relationship foreign keys,
// one live session per conversation, database-owned control sequences and timestamps, the NULL-safe terminal-notice and
// end-state rules, and SQL NULL versus JSON null.

const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

describe("migration 0007 guarantees", () => {
  let t: TestDb;
  let w: BotWorld;
  let keys: SessionKeys;
  let deploymentId: string;
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await q(text, params)).rows[0] as T;

  beforeAll(async () => {
    t = await createTestDatabase();
    w = await botWorld(t.db);
    const d = await deployedBot(t.db, w);
    deploymentId = d.deployment.id;
    keys = {
      organizationId: w.org.id,
      botId: d.bot.id,
      versionId: d.version.id,
      deploymentId,
      whatsappAccountId: w.account.id,
      student: w.student,
    };
  });
  afterAll(async () => t.close());

  const freshKeys = async (): Promise<SessionKeys> => ({
    ...keys,
    student: await addStudent(t.db, w.org.id, w.account.id),
  });

  describe("published versions", () => {
    it("can never be updated or deleted", async () => {
      await expect(
        q("update bot_versions set change_note = 'x' where id = $1", [keys.versionId]),
      ).rejects.toThrow(/a published version is immutable/);
      await expect(q("delete from bot_versions where id = $1", [keys.versionId])).rejects.toThrow(
        /a published version is immutable/,
      );
    });

    const insertVersion = (o: {
      canonical: string;
      config?: string;
      sha256?: string | null;
      n: number;
    }) =>
      q(
        `insert into bot_versions (organization_id, bot_id, version_number, schema_version, config, config_canonical,
           config_sha256, published_by_membership_id, published_at)
         values ($1, $2, $3, 1, $4::jsonb, $5, $6, $7, '2000-01-01T00:00:00Z') returning published_at`,
        [
          w.org.id,
          keys.botId,
          o.n,
          o.config ?? o.canonical,
          o.canonical,
          o.sha256 === undefined ? sha(o.canonical) : o.sha256,
          w.admin.membershipId,
        ],
      );

    it("are accepted only when jsonb, canonical text and SHA-256 agree; the database stamps published_at", async () => {
      const canonical = '{"schemaVersion":1,"x":"ආයුබෝවන්"}';
      const r = await insertVersion({ canonical, n: 100 });
      expect((r.rows[0] as { published_at: Date }).published_at.getFullYear()).toBeGreaterThan(
        2020,
      );
      await expect(
        insertVersion({ canonical, sha256: sha(`${canonical} `), n: 101 }),
      ).rejects.toThrow(/not the SHA-256 of the canonical text/);
      await expect(
        insertVersion({ canonical, config: '{"schemaVersion":1,"x":"other"}', n: 102 }),
      ).rejects.toThrow(/does not equal its canonical text/);
      await expect(insertVersion({ canonical: '{"schemaVersion":2}', n: 103 })).rejects.toThrow(
        /schema_version does not match/,
      );
      // A NULL hash is refused. The BEFORE INSERT guard runs ahead of the NOT NULL constraint and reports the mismatch itself.
      await expectPgError(insertVersion({ canonical, sha256: null, n: 104 }), CHECK_VIOLATION);
      await expect(insertVersion({ canonical, sha256: null, n: 104 })).rejects.toThrow(
        /not the SHA-256 of the canonical text/,
      );
      // Canonical text that is not JSON is refused by the cast in the guard.
      await expect(
        insertVersion({ canonical: "{not json", config: '{"schemaVersion":1}', n: 105 }),
      ).rejects.toThrow(/invalid input syntax for type json/);
    });

    it("canonical text is measured in UTF-8 bytes: 65,536 is accepted, 65,537 refused", async () => {
      const wrap = (bytes: number) => {
        const head = '{"schemaVersion":1,"x":"';
        const tail = '"}';
        return head + "a".repeat(bytes - head.length - tail.length) + tail;
      };
      await insertVersion({ canonical: wrap(65_536), n: 110 });
      await expectPgError(
        insertVersion({ canonical: wrap(65_537), n: 111 }),
        CHECK_VIOLATION,
        "bot_versions_canonical_size_check",
      );
      // Three-byte characters: 21,845 x 3 + the JSON around them.
      const head = '{"schemaVersion":1,"x":"';
      const pad = 65_536 - head.length - 2;
      const multibyte = head + "අ".repeat(Math.floor(pad / 3)) + "a".repeat(pad % 3) + '"}';
      expect(Buffer.byteLength(multibyte, "utf8")).toBe(65_536);
      await insertVersion({ canonical: multibyte, n: 112 });
    });
  });

  describe("drafts", () => {
    it("change only with draft_revision + 1, must be JSON, are never removed, and are measured in canonical bytes", async () => {
      const { bot } = await publishedBot(t.db, w);
      const set = (draft: string | null, revision: string) =>
        q(
          `update bots set draft_config_canonical = $1, draft_revision = ${revision}, draft_updated_by_membership_id = $2,
             draft_updated_at = clock_timestamp() where id = $3`,
          [draft, w.admin.membershipId, bot.id],
        );
      await expect(set('{"a":1}', "draft_revision")).rejects.toThrow(
        /increments draft_revision by exactly 1/,
      );
      await expect(set('{"a":1}', "draft_revision + 2")).rejects.toThrow(/exactly 1/);
      await expect(set("{nope", "draft_revision + 1")).rejects.toThrow(
        /invalid input syntax for type json/,
      );
      await expect(set(null, "draft_revision + 1")).rejects.toThrow(/a draft is never removed/);
      await expectPgError(
        set(`{"a":"${"x".repeat(65_536)}"}`, "draft_revision + 1"),
        CHECK_VIOLATION,
        "bots_draft_size_check",
      );
      // A draft may still contain an escaped NUL (json accepts it; only a published version needs jsonb).
      await set('{"a":"\\u0000"}', "draft_revision + 1");
      await expect(
        q("update bots set draft_revision = draft_revision + 1 where id = $1", [bot.id]),
      ).rejects.toThrow(/only together with the draft/);
    });
  });

  describe("deployments", () => {
    it("start ACTIVE at epoch 1, keep their binding, never lower or skip the epoch, and bump it to stop", async () => {
      const { deployment } = await deployedBot(t.db, await botWorld(t.db));
      const upd = (set: string) =>
        q(`update bot_deployments set ${set} where id = $1 returning *`, [deployment.id]);
      await expect(upd("send_epoch = 3")).rejects.toThrow(/rises by exactly 1/);
      await expect(upd("send_epoch = 0")).rejects.toThrow();
      await expect(upd("status = 'STOPPED'")).rejects.toThrow(/bumps send_epoch/);
      await expect(upd("bot_id = gen_random_uuid()")).rejects.toThrow(
        /binding of a deployment never changes/,
      );
      await expect(q("delete from bot_deployments where id = $1", [deployment.id])).rejects.toThrow(
        /never deleted/,
      );
      // The database stamps the times; application values are ignored.
      const before = await rowOf(t.pool, "bot_deployments", deployment.id);
      const paused = (
        await upd(
          "status = 'PAUSED', start_eligible_from = '2000-01-01', status_changed_at = '2000-01-01'",
        )
      ).rows[0] as { start_eligible_from: Date; status_changed_at: Date };
      expect(paused.start_eligible_from.toISOString()).toBe(
        new Date(before!.start_eligible_from as string).toISOString(),
      );
      expect(paused.status_changed_at.getFullYear()).toBeGreaterThan(2020);
      await upd("status = 'STOPPED', send_epoch = send_epoch + 1");
      const retired = (await upd("status = 'RETIRED', send_epoch = send_epoch + 1")).rows[0] as {
        send_epoch: string;
      };
      expect(Number(retired.send_epoch)).toBe(3);
      await expect(upd("priority = 7")).rejects.toThrow(/RETIRED deployment is immutable/);
      await expect(upd("status = 'ACTIVE'")).rejects.toThrow(/RETIRED deployment is immutable/);
    });

    it("must start ACTIVE at epoch 1", async () => {
      await expect(
        q(
          `insert into bot_deployments (organization_id, whatsapp_account_id, bot_id, version_id, status, priority)
           values ($1, $2, $3, $4, 'PAUSED', 900)`,
          [w.org.id, w.account.id, keys.botId, keys.versionId],
        ),
      ).rejects.toThrow(/starts ACTIVE at epoch 1/);
    });
  });

  describe("session relationships", () => {
    it("bind conversation, account, contact, messages, bot, version and deployment together", async () => {
      const k = await freshKeys();
      const other = await addStudent(t.db, w.org.id, w.account.id);
      const otherAccount = await seedAccount(t.db, w.org.id);
      const elsewhere = await addStudent(t.db, w.org.id, otherAccount.id);
      const otherBot = await publishedBot(t.db, w);
      const cases: Array<[string, Record<string, unknown>]> = [
        ["contact of another conversation", { contact_id: other.contact.id }],
        ["message of another conversation", { started_by_message_id: other.message.id }],
        ["input message of another conversation", { last_input_message_id: other.message.id }],
        [
          "conversation of another account",
          {
            conversation_id: elsewhere.conversation.id,
            contact_id: elsewhere.contact.id,
            started_by_message_id: elsewhere.message.id,
          },
        ],
        ["version of another bot", { bot_version_id: otherBot.version.id }],
        [
          "deployment of another bot",
          { bot_id: otherBot.bot.id, bot_version_id: otherBot.version.id },
        ],
      ];
      for (const [label, extra] of cases)
        await expectPgError(insertSession(t.pool, k, extra), FK_VIOLATION).catch((e: Error) => {
          throw new Error(`${label}: ${e.message}`);
        });
    });

    it("pin their version independently of the deployment's current version", async () => {
      const fresh = await botWorld(t.db);
      const d = await deployedBot(t.db, fresh);
      const s = await insertSession(t.pool, {
        organizationId: fresh.org.id,
        botId: d.bot.id,
        versionId: d.version.id,
        deploymentId: d.deployment.id,
        whatsappAccountId: fresh.account.id,
        student: fresh.student,
      });
      await updateDraft(
        fresh.admin.ctx,
        { botId: d.bot.id, expectedRevision: 1, config: { ...minimalFlow(), name: "v2" } },
        { db: t.db },
      );
      const v2 = (
        await publishVersion(
          fresh.admin.ctx,
          { botId: d.bot.id, expectedRevision: 2 },
          { db: t.db },
        )
      ).value;
      await changeDeploymentVersion(
        fresh.admin.ctx,
        { deploymentId: d.deployment.id, versionId: v2.id },
        { db: t.db },
      );
      const after = await updateSession(t.pool, s.id as string, "step_seq = step_seq + 1");
      expect(after.bot_version_id).toBe(d.version.id);
    });
  });

  describe("live sessions", () => {
    it("at most one live session per conversation; a new one may start after it ends", async () => {
      const k = await freshKeys();
      const s = await insertSession(t.pool, k);
      await expectPgError(
        insertSession(t.pool, k),
        UNIQUE_VIOLATION,
        "bot_sessions_live_conversation_uidx",
      );
      await updateSession(
        t.pool,
        s.id as string,
        "state = 'COMPLETED', end_reason = 'idle_timeout'",
      );
      await insertSession(t.pool, k);
    });

    it("an awaiting token is unique within the organization", async () => {
      const token = "tok_0123456789abcdefgh"; // 22 characters
      await insertSession(t.pool, await freshKeys(), { awaiting_token: token });
      await expectPgError(
        insertSession(t.pool, await freshKeys(), { awaiting_token: token }),
        UNIQUE_VIOLATION,
        "bot_sessions_awaiting_token_uidx",
      );
    });

    it("are inserted live, without end, notice, handover, suppression or redaction fields", async () => {
      for (const extra of [
        { state: "COMPLETED", end_reason: "flow_end" },
        { terminal_notice_step_seq: 0 },
        { handover_control_seq: 1 },
        { output_suppressed_at: new Date() },
        { redacted_at: new Date() },
      ])
        await expect(insertSession(t.pool, await freshKeys(), extra)).rejects.toThrow(
          /bot_sessions:/,
        );
    });

    it("every live change increments revision by exactly 1, and the owner, version and start never change", async () => {
      const s = await insertSession(t.pool, await freshKeys());
      await expect(
        updateSession(t.pool, s.id as string, "step_seq = 1", [], false),
      ).rejects.toThrow(/increments revision by exactly 1/);
      await expect(
        updateSession(t.pool, s.id as string, "started_control_seq = started_control_seq + 5"),
      ).rejects.toThrow(/never changes its owner/);
      await expect(
        updateSession(t.pool, s.id as string, "started_at = '2000-01-01'"),
      ).rejects.toThrow(/never changes its owner/);
    });
  });

  describe("conversation control sequence", () => {
    const seqOf = async (conversationId: string) =>
      Number(
        (
          await one<{ s: string }>("select control_seq s from conversations where id = $1", [
            conversationId,
          ])
        ).s,
      );

    it("is allocated by the database on session start and handover; supplied values are overwritten", async () => {
      const k = await freshKeys();
      const conversation = await one(
        "select updated_at, last_message_at from conversations where id = $1",
        [k.student.conversation.id],
      );
      const s = await insertSession(t.pool, k, { started_control_seq: 999 });
      expect(Number(s.started_control_seq)).toBe(await seqOf(k.student.conversation.id));
      expect(Number(s.started_control_seq)).toBe(1);
      const h = await updateSession(
        t.pool,
        s.id as string,
        "state = 'HANDED_OVER', end_reason = 'system_handover', handover_reason = 'operator_stop', handover_control_seq = 777",
      );
      expect(Number(h.handover_control_seq)).toBe(2);
      expect(await seqOf(k.student.conversation.id)).toBe(2);
      // Allocation touches nothing else on the conversation (Inbox ordering unchanged).
      expect(
        await one("select updated_at, last_message_at from conversations where id = $1", [
          k.student.conversation.id,
        ]),
      ).toEqual(conversation);
    });

    it("a rolled-back allocation leaves nothing behind; another organization's conversation is refused", async () => {
      const k = await freshKeys();
      const c = await t.pool.connect();
      try {
        await c.query("begin");
        await insertSession(c, k);
        await c.query("rollback");
      } finally {
        c.release(true); // destroyed, never returned to the pool inside a transaction
      }
      expect(await seqOf(k.student.conversation.id)).toBe(0);
      const otherOrg = await botWorld(t.db);
      await expectPgError(
        q("select allocate_conversation_control_seq($1, $2)", [
          otherOrg.org.id,
          k.student.conversation.id,
        ]),
        FK_VIOLATION,
      );
    });

    it("values follow commit order, even for a transaction that started earlier", async () => {
      const k = await freshKeys();
      const early = await t.pool.connect();
      const late = await t.pool.connect();
      try {
        await early.query("begin isolation level read committed");
        await early.query("select 1"); // started first
        await late.query("begin");
        const lateValue = await late.query("select allocate_conversation_control_seq($1, $2) v", [
          w.org.id,
          k.student.conversation.id,
        ]);
        const earlyAlloc = early.query("select allocate_conversation_control_seq($1, $2) v", [
          w.org.id,
          k.student.conversation.id,
        ]);
        earlyAlloc.catch(() => undefined); // awaited below; never an unhandled rejection if the test fails first
        for (let i = 0; i < 200; i++) {
          const r = await one<{ n: number }>(
            "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
          );
          if (r.n >= 1) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await late.query("commit");
        const earlyValue = await earlyAlloc;
        await early.query("commit");
        expect(Number((earlyValue.rows[0] as { v: string }).v)).toBeGreaterThan(
          Number((lateValue.rows[0] as { v: string }).v),
        );
      } finally {
        // Destroying both connections ends any transaction still open after a failure (and so releases its locks).
        early.release(true);
        late.release(true);
      }
    });
  });

  describe("terminal transitions (NULL-safe)", () => {
    const live = async () => insertSession(t.pool, await freshKeys(), { step_seq: 3 });
    const end = async (set: string) => updateSession(t.pool, (await live()).id as string, set);

    it("a terminal notice needs an affirmative flow ending in its own terminal state at the final step", async () => {
      const refused = [
        "state = 'COMPLETED', terminal_notice_step_seq = 3", // NULL end reason
        "state = 'COMPLETED', end_reason = 'idle_timeout', terminal_notice_step_seq = 3",
        "state = 'COMPLETED', end_reason = 'conversation_resolved', terminal_notice_step_seq = 3",
        "state = 'COMPLETED', end_reason = 'error', terminal_notice_step_seq = 3",
        "state = 'HANDED_OVER', end_reason = 'system_handover', handover_reason = 'operator_stop', terminal_notice_step_seq = 3",
        "state = 'HANDED_OVER', end_reason = 'error', handover_reason = 'engine_error', terminal_notice_step_seq = 3",
        "state = 'FAILED', end_reason = 'error', terminal_notice_step_seq = 3",
        "state = 'COMPLETED', end_reason = 'flow_end', terminal_notice_step_seq = 2",
        "state = 'WAITING_FOR_INPUT', terminal_notice_step_seq = 3",
      ];
      for (const set of refused)
        await expectPgError(end(set), CHECK_VIOLATION).catch((e: Error) => {
          throw new Error(`${set}: ${e.message}`);
        });
      const ok1 = await end(
        "state = 'COMPLETED', end_reason = 'flow_end', terminal_notice_step_seq = 3",
      );
      expect(ok1.terminal_notice_step_seq).toBe(3);
      const ok2 = await end(
        "state = 'HANDED_OVER', end_reason = 'flow_handover', handover_reason = 'needs_staff', terminal_notice_step_seq = 3",
      );
      expect(Number(ok2.handover_control_seq)).toBeGreaterThan(Number(ok2.started_control_seq));
    });

    it("state, end reason and handover reason agree", async () => {
      const refused = [
        "state = 'COMPLETED'", // a terminal state needs its end reason
        "end_reason = 'flow_end'", // a live state has none
        "state = 'COMPLETED', end_reason = 'flow_handover'",
        "state = 'HANDED_OVER', end_reason = 'flow_end', handover_reason = 'needs_staff'",
        "state = 'HANDED_OVER', end_reason = 'flow_handover'", // no handover reason
        "state = 'HANDED_OVER', end_reason = 'flow_handover', handover_reason = 'operator_stop'", // a system reason
        "state = 'HANDED_OVER', end_reason = 'system_handover', handover_reason = 'needs_staff'", // a flow reason
        "state = 'COMPLETED', end_reason = 'flow_end', handover_reason = 'needs_staff'",
        "state = 'FAILED', end_reason = 'idle_timeout'",
      ];
      for (const set of refused)
        await expectPgError(end(set), CHECK_VIOLATION).catch((e: Error) => {
          throw new Error(`${set}: ${e.message}`);
        });
    });

    it("a session that starts at END or HANDOVER: inserted live, made terminal with its notice in the same transaction", async () => {
      for (const [set, step] of [
        [
          "state = 'COMPLETED', end_reason = 'flow_end', step_seq = 1, terminal_notice_step_seq = 1",
          1,
        ],
        [
          "state = 'HANDED_OVER', end_reason = 'flow_handover', handover_reason = 'student_requested', step_seq = 1, terminal_notice_step_seq = 1",
          1,
        ],
      ] as const) {
        const k = await freshKeys();
        const c = await t.pool.connect();
        try {
          await c.query("begin");
          const s = await insertSession(c, k, { state: "ACTIVE", current_node_id: "done" });
          const ended = await updateSession(c, s.id as string, set);
          await c.query("commit");
          expect(ended.terminal_notice_step_seq).toBe(step);
          expect(ended.ended_at).not.toBeNull();
        } finally {
          c.release(true);
        }
      }
    });

    it("the database stamps ended_at; a terminal row's notice can never be set afterwards", async () => {
      const ended = await end(
        "state = 'COMPLETED', end_reason = 'flow_end', ended_at = '2000-01-01'",
      );
      expect((ended.ended_at as Date).getFullYear()).toBeGreaterThan(2020);
      await expect(
        updateSession(t.pool, ended.id as string, "terminal_notice_step_seq = step_seq", [], false),
      ).rejects.toThrow(/bot_session_terminal_immutable/);
    });
  });

  describe("SQL NULL versus JSON null", () => {
    it("variables must be a JSON object; awaiting is SQL NULL or an object, never JSON null", async () => {
      const s = await insertSession(t.pool, await freshKeys());
      await expectPgError(
        updateSession(t.pool, s.id as string, "variables = 'null'::jsonb"),
        CHECK_VIOLATION,
        "bot_sessions_variables_object_check",
      );
      await expectPgError(
        updateSession(t.pool, s.id as string, "variables = NULL"),
        NOT_NULL_VIOLATION,
      );
      await expectPgError(
        updateSession(t.pool, s.id as string, "awaiting = 'null'::jsonb"),
        CHECK_VIOLATION,
        "bot_sessions_awaiting_object_check",
      );
      await updateSession(t.pool, s.id as string, "awaiting = NULL");
    });
  });

  describe("append-only history", () => {
    it("deployment and session events can never be changed or deleted", async () => {
      await expect(q("update bot_deployment_events set sessions_affected = 9")).rejects.toThrow(
        /append-only/,
      );
      await expect(q("delete from bot_deployment_events")).rejects.toThrow(/append-only/);
      const s = await insertSession(t.pool, await freshKeys());
      await q(
        "insert into bot_session_events (organization_id, session_id, conversation_id, kind, code) values ($1, $2, $3, 'ERROR', 'x')",
        [w.org.id, s.id, s.conversation_id],
      );
      await expect(q("update bot_session_events set code = 'y'")).rejects.toThrow(/append-only/);
      await expect(q("delete from bot_session_events")).rejects.toThrow(/append-only/);
    });
  });

  describe("catalog", () => {
    it("has every function and trigger of 0007, and the guard runs before the allocator", async () => {
      const functions = (
        await q("select proname from pg_proc where proname = any($1) order by proname", [
          [
            "allocate_conversation_control_seq",
            "bot_deployments_guard",
            "bot_session_redaction_after",
            "bot_sessions_allocate_control_seq",
            "bot_sessions_guard",
            "bot_versions_guard",
            "bots_append_only",
            "bots_guard",
            "redact_expired_bot_sessions",
          ],
        ])
      ).rows.map((r) => (r as { proname: string }).proname);
      expect(functions).toHaveLength(9);
      const triggers = (
        await q(
          "select tgname from pg_trigger where tgrelid = 'bot_sessions'::regclass and not tgisinternal order by tgname",
        )
      ).rows.map((r) => (r as { tgname: string }).tgname);
      expect(triggers).toEqual([
        "bot_sessions_a_guard_trg",
        "bot_sessions_b_allocate_handover_trg",
        "bot_sessions_b_allocate_insert_trg",
      ]);
      // Every column of bot_sessions has an equality operator (the whole-row comparison of the guard depends on it).
      const types = (
        await q(
          "select distinct data_type from information_schema.columns where table_name = 'bot_sessions'",
        )
      ).rows.map((r) => (r as { data_type: string }).data_type);
      expect(types).not.toContain("json");
      expect(await one("select current_setting('server_encoding') e")).toEqual({ e: "UTF8" });
      // The owner-approved development default, as migrated (only test databases ever replace it).
      expect(await one("select bot_session_redaction_after()::text i")).toEqual({ i: "30 days" });
    });
  });
});
