import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  UNIQUE_VIOLATION,
  createTestDatabase,
  expectPgError,
  type TestDb,
} from "@/db/__tests__/helpers";
import {
  addStudent,
  botWorld,
  deployedBot,
  insertSession,
  rowOf,
  shortenRetention,
  updateSession,
  type BotWorld,
  type SessionKeys,
} from "./testing";

// Terminal-session privacy redaction (V3.2 K.11, O.10 R10 cases A-H, J session part, K, L; ADR 0019), on its own disposable
// al_ict_test_* database because it replaces bot_session_redaction_after() to make sessions eligible. Every case compares whole
// rows (to_jsonb) before and after.

const CLEARED = ["variables", "awaiting", "awaiting_token", "last_consumed_token", "redacted_at"];
const without = (row: Record<string, unknown> | undefined, keys: string[]) =>
  Object.fromEntries(Object.entries(row ?? {}).filter(([k]) => !keys.includes(k)));

describe("terminal-session privacy redaction (R10)", () => {
  let t: TestDb;
  let a: BotWorld;
  let b: BotWorld;
  let keysA: SessionKeys;
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
  const redact = async (organizationId: string, limit = 100) =>
    Number(
      (
        (await q("select redact_expired_bot_sessions($1, $2) n", [organizationId, limit]))
          .rows[0] as { n: number }
      ).n,
    );
  const keysFor = async (w: BotWorld) => {
    const d = await deployedBot(t.db, w);
    return {
      organizationId: w.org.id,
      botId: d.bot.id,
      versionId: d.version.id,
      deploymentId: d.deployment.id,
      whatsappAccountId: w.account.id,
      student: w.student,
    };
  };
  const fresh = async (k: SessionKeys = keysA) => ({
    ...k,
    student: await addStudent(t.db, k.organizationId, k.whatsappAccountId),
  });

  /** A terminal session holding values, tokens and pending-prompt data. */
  async function terminal(set: string, k?: SessionKeys) {
    const s = await insertSession(t.pool, await fresh(k), {
      variables: JSON.stringify({ student_name: "Nimal Perera", grade: 12 }),
      awaiting: JSON.stringify({
        nodeId: "menu",
        kind: "BUTTONS",
        phase: "SENT",
        optionKeys: ["yes"],
      }),
      awaiting_token: `a${Math.random().toString(36).slice(2, 10).padEnd(21, "0")}`,
      last_consumed_token: `c${Math.random().toString(36).slice(2, 10).padEnd(21, "0")}`,
      step_seq: 4,
    });
    return updateSession(t.pool, s.id as string, set);
  }
  const completed = () => terminal("state = 'COMPLETED', end_reason = 'idle_timeout'");

  beforeAll(async () => {
    t = await createTestDatabase();
    a = await botWorld(t.db);
    b = await botWorld(t.db);
    keysA = await keysFor(a);
    await keysFor(b);
  });
  afterAll(async () => t.close());

  describe("with the retention period shortened (sessions eligible)", () => {
    beforeAll(() => shortenRetention(t.pool));

    it("A. an expired COMPLETED session: only the approved fields are cleared, everything else is byte-identical", async () => {
      const s = await completed();
      const before = await rowOf(t.pool, "bot_sessions", s.id as string);
      expect(await redact(a.org.id)).toBe(1);
      const after = await rowOf(t.pool, "bot_sessions", s.id as string);
      expect(after).toMatchObject({
        variables: {},
        awaiting: null,
        awaiting_token: null,
        last_consumed_token: null,
      });
      expect(after!.redacted_at).not.toBeNull();
      expect(without(after, CLEARED)).toEqual(without(before, CLEARED));
    });

    it("B. HANDED_OVER with a handover sequence and a terminal notice, and FAILED, behave the same", async () => {
      const handed = await terminal(
        "state = 'HANDED_OVER', end_reason = 'flow_handover', handover_reason = 'needs_staff', terminal_notice_step_seq = 4",
      );
      const failed = await terminal("state = 'FAILED', end_reason = 'error'");
      const before = [
        await rowOf(t.pool, "bot_sessions", handed.id as string),
        await rowOf(t.pool, "bot_sessions", failed.id as string),
      ];
      expect(await redact(a.org.id)).toBe(2);
      const after = [
        await rowOf(t.pool, "bot_sessions", handed.id as string),
        await rowOf(t.pool, "bot_sessions", failed.id as string),
      ];
      for (let i = 0; i < 2; i++)
        expect(without(after[i], CLEARED)).toEqual(without(before[i], CLEARED));
      // `handed` is a raw driver row, where pg returns bigint as a string ("2"); rowOf() reads to_jsonb, where it is a JSON
      // number (2). Compare the values, not the transport encodings.
      expect(after[0]).toMatchObject({
        terminal_notice_step_seq: 4,
        handover_control_seq: Number(handed.handover_control_seq),
      });
      expect(Number(handed.handover_control_seq)).toBeGreaterThanOrEqual(2);
    });

    const clearing =
      "variables = '{}'::jsonb, awaiting = NULL, awaiting_token = NULL, last_consumed_token = NULL, redacted_at = clock_timestamp()";

    it("D/E/F. redaction combined with any other change is refused and rolled back whole", async () => {
      const s = await completed();
      const before = await rowOf(t.pool, "bot_sessions", s.id as string);
      const extra = [
        "state = 'WAITING_FOR_INPUT'",
        "terminal_notice_step_seq = 4",
        "started_control_seq = started_control_seq + 1",
        "handover_control_seq = 99",
        "output_suppressed_at = clock_timestamp()",
        "step_seq = step_seq + 1",
        "current_node_id = 'other'",
        "deployment_id = gen_random_uuid()",
        "bot_version_id = gen_random_uuid()",
        "conversation_id = gen_random_uuid()",
        "organization_id = gen_random_uuid()",
        "ended_at = '2000-01-01'",
        "revision = revision + 1",
      ];
      for (const set of extra)
        await expect(
          updateSession(t.pool, s.id as string, `${clearing}, ${set}`, [], false),
          set,
        ).rejects.toThrow(/bot_session_terminal_immutable/);
      expect(await rowOf(t.pool, "bot_sessions", s.id as string)).toEqual(before);
    });

    it("a terminal notice cannot be removed or changed by redaction; re-stating an absent notice is no change", async () => {
      const noticed = await terminal(
        "state = 'COMPLETED', end_reason = 'flow_end', terminal_notice_step_seq = 4",
      );
      const before = await rowOf(t.pool, "bot_sessions", noticed.id as string);
      expect(before!.terminal_notice_step_seq).toBe(4);
      for (const set of ["terminal_notice_step_seq = NULL", "terminal_notice_step_seq = 3"])
        await expect(
          updateSession(t.pool, noticed.id as string, `${clearing}, ${set}`, [], false),
          set,
        ).rejects.toThrow(/bot_session_terminal_immutable/);
      expect(await rowOf(t.pool, "bot_sessions", noticed.id as string)).toEqual(before);
      // The same NULL assignment on a session that never had a notice changes only the approved fields: allowed.
      const plain = await completed();
      await updateSession(
        t.pool,
        plain.id as string,
        `${clearing}, terminal_notice_step_seq = NULL`,
        [],
        false,
      );
      expect(await rowOf(t.pool, "bot_sessions", plain.id as string)).toMatchObject({
        terminal_notice_step_seq: null,
        variables: {},
      });
    });

    it("an incomplete redaction is refused (all approved fields, together, to cleared values; JSON null is not SQL NULL)", async () => {
      const s = await completed();
      for (const set of [
        "variables = '{}'::jsonb, redacted_at = clock_timestamp()",
        "variables = '{}'::jsonb, awaiting = NULL, awaiting_token = NULL, last_consumed_token = NULL",
        "variables = '{\"a\":1}'::jsonb, awaiting = NULL, awaiting_token = NULL, last_consumed_token = NULL, redacted_at = clock_timestamp()",
      ])
        await expect(updateSession(t.pool, s.id as string, set, [], false), set).rejects.toThrow(
          /bot_session_redaction_incomplete/,
        );
      // JSON null in awaiting is refused by the object CHECK even before the guard's SQL-NULL test matters.
      await expect(
        updateSession(
          t.pool,
          s.id as string,
          `${clearing.replace("awaiting = NULL", "awaiting = 'null'::jsonb")}`,
          [],
          false,
        ),
      ).rejects.toThrow();
    });

    it("G. a redacted row accepts no change: removed data cannot be restored", async () => {
      const s = await completed();
      await redact(a.org.id);
      const before = await rowOf(t.pool, "bot_sessions", s.id as string);
      for (const set of [
        'variables = \'{"student_name":"Nimal Perera"}\'::jsonb',
        "awaiting_token = 'abcdefghijklmnopqrstuv'",
        "redacted_at = NULL, variables = '{\"a\":1}'::jsonb",
      ])
        await expect(updateSession(t.pool, s.id as string, set, [], false), set).rejects.toThrow(
          /bot_session_redacted|bot_sessions_redacted_check/,
        );
      expect(await rowOf(t.pool, "bot_sessions", s.id as string)).toEqual(before);
    });

    it("H. repeated cleanup changes nothing; an identical update of a redacted row is a no-op", async () => {
      const s = await completed();
      expect(await redact(a.org.id)).toBeGreaterThanOrEqual(1);
      const once = await rowOf(t.pool, "bot_sessions", s.id as string);
      expect(await redact(a.org.id)).toBe(0);
      await updateSession(t.pool, s.id as string, "variables = variables", [], false);
      expect(await rowOf(t.pool, "bot_sessions", s.id as string)).toEqual(once);
    });

    it("J. constraints still hold after redaction", async () => {
      const k = await fresh();
      const s = await insertSession(t.pool, k, { awaiting_token: "reusableToken000000000" });
      await updateSession(
        t.pool,
        s.id as string,
        "state = 'COMPLETED', end_reason = 'idle_timeout'",
      );
      await redact(a.org.id);
      const again = await insertSession(t.pool, k, { awaiting_token: "reusableToken000000000" }); // token reuse allowed
      await expectPgError(
        insertSession(t.pool, k),
        UNIQUE_VIOLATION,
        "bot_sessions_live_conversation_uidx",
      );
      expect(again.id).not.toBe(s.id);
    });

    it("K. one organization's call never touches another's rows", async () => {
      const s = await completed(); // organization A
      const before = await rowOf(t.pool, "bot_sessions", s.id as string);
      expect(await redact(b.org.id)).toBe(0);
      const direct = await q(
        `update bot_sessions set ${clearing} where id = $1 and organization_id = $2`,
        [s.id, b.org.id],
      );
      expect(direct.rowCount).toBe(0);
      expect(await rowOf(t.pool, "bot_sessions", s.id as string)).toEqual(before);
    });

    it("L. redaction writes no event and allocates no control sequence", async () => {
      const s = await completed();
      const events = await q("select count(*)::int n from bot_session_events");
      const seq = await q("select control_seq from conversations where id = $1", [
        s.conversation_id,
      ]);
      await redact(a.org.id);
      expect((await q("select count(*)::int n from bot_session_events")).rows).toEqual(events.rows);
      expect(
        (await q("select control_seq from conversations where id = $1", [s.conversation_id])).rows,
      ).toEqual(seq.rows);
    });

    it("refuses a missing organization or an unbounded limit", async () => {
      await expect(q("select redact_expired_bot_sessions(NULL, 10)")).rejects.toThrow(
        /organization and a limit/,
      );
      await expect(q("select redact_expired_bot_sessions($1, NULL)", [a.org.id])).rejects.toThrow(
        /organization and a limit/,
      );
      await expect(q("select redact_expired_bot_sessions($1, 0)", [a.org.id])).rejects.toThrow(
        /organization and a limit/,
      );
    });
  });

  describe("with the 30-day development default", () => {
    beforeAll(() => shortenRetention(t.pool, "30 days"));

    it("C. a session inside the retention period, and a live session, cannot be redacted", async () => {
      const s = await completed();
      const before = await rowOf(t.pool, "bot_sessions", s.id as string);
      expect(await redact(a.org.id)).toBe(0);
      await expect(
        updateSession(
          t.pool,
          s.id as string,
          "variables = '{}'::jsonb, awaiting = NULL, awaiting_token = NULL, last_consumed_token = NULL, redacted_at = clock_timestamp()",
          [],
          false,
        ),
      ).rejects.toThrow(/bot_session_redaction_not_eligible/);
      expect(await rowOf(t.pool, "bot_sessions", s.id as string)).toEqual(before);
      const live = await insertSession(t.pool, await fresh());
      await expect(
        updateSession(t.pool, live.id as string, "redacted_at = clock_timestamp()"),
      ).rejects.toThrow(/a live session cannot be redacted/);
    });
  });
});
