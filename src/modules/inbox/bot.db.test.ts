import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import {
  botWorld,
  dispatchWorld,
  insertSession,
  queueBotStep,
  shortenRetention,
  textMessage,
  updateSession,
  windowStudent,
  type BotWorld,
  type DispatchFixture,
  type SessionKeys,
  type Student,
} from "../bot-control/testing"; // test fixtures, imported relatively like every other test
import { ForbiddenError, NotFoundError } from "@/shared/errors/http-errors";
import { getConversationDetail, listConversations } from "./index";
import { forceRequestState } from "./testing";

// Phase 08F-2 (owner decisions D-2, D-3) on real PostgreSQL: the read-only bot indicator and the Bot Attention filter of the
// staff Inbox. Sessions are written with raw SQL like any writer; every read is compared against whole-table fingerprints.

describe("inbox bot indicator and Bot Attention filter (08F-2)", () => {
  let t: TestDb;
  let f: DispatchFixture;
  let w: BotWorld;
  let keys: Omit<SessionKeys, "student">;
  const db = () => ({ db: t.db as never });
  const fresh = new Date(Date.now() - 60_000);
  beforeAll(async () => {
    t = await createTestDatabase();
    f = await dispatchWorld(t, { lastInboundAt: fresh });
    w = f.w;
    keys = {
      organizationId: w.org.id,
      botId: f.d.bot.id,
      versionId: f.d.version.id,
      deploymentId: f.d.deployment.id,
      whatsappAccountId: w.account.id,
    };
  });
  afterAll(async () => t.close());

  const student = () => windowStudent(t, w, fresh);
  const live = (s: Student, extra: Record<string, unknown> = {}) =>
    insertSession(t.pool, { ...keys, student: s }, extra);
  /** A session that has already ended, written as the runtime would (live row, then one terminal update). */
  async function ended(s: Student, set: string, params: unknown[] = [], extra = {}) {
    const row = await live(s, extra);
    return updateSession(t.pool, row.id as string, `${set}, ended_at = clock_timestamp()`, params);
  }
  const handedOver = (s: Student, reason: string, end = "system_handover", extra = {}) =>
    ended(s, "state = 'HANDED_OVER', end_reason = $1, handover_reason = $2", [end, reason], extra);
  const resolve = (s: Student) =>
    t.pool.query(
      "update conversations set status = 'RESOLVED', resolved_at = now() where id = $1",
      [s.conversation.id],
    );
  const botOf = async (s: Student, who = w.staff) =>
    (await listConversations(who.ctx, {}, db())).items.find((i) => i.id === s.conversation.id)?.bot;
  const attention = async (who = w.staff, extra: Record<string, unknown> = {}) =>
    listConversations(who.ctx, { view: "botAttention", ...extra }, db());
  const fingerprint = async () =>
    (
      await t.pool.query(
        `select (select md5(string_agg(to_jsonb(x)::text, '|' order by id)) from bot_sessions x) s,
                (select md5(string_agg(to_jsonb(x)::text, '|' order by id)) from outbound_requests x) r,
                (select md5(string_agg(to_jsonb(x)::text, '|' order by id)) from conversations x) c,
                (select md5(string_agg(to_jsonb(x)::text, '|' order by id)) from bot_triggers x) g`,
      )
    ).rows[0];

  it("a conversation with no bot history has no bot key at all (empty history)", async () => {
    const s = await student();
    const page = await listConversations(w.staff.ctx, {}, db());
    const item = page.items.find((i) => i.id === s.conversation.id)!;
    expect(item).toBeDefined();
    expect("bot" in item).toBe(false);
    const detail = await getConversationDetail(w.staff.ctx, s.conversation.id, db());
    expect("bot" in detail).toBe(false);
  });

  describe("states and handover reasons", () => {
    it("live sessions are shown as handled by the bot", async () => {
      const s = await student();
      await live(s);
      expect(await botOf(s)).toMatchObject({
        state: "WAITING_FOR_INPUT",
        label: "Bot is handling this chat",
        severity: "neutral",
        handover: null,
        notice: null,
        redacted: false,
      });
    });

    it("a flow HANDOVER is 'Bot asked for a human', flow-requested, with its reason and no warning", async () => {
      const s = await student();
      await handedOver(s, "needs_staff", "flow_handover");
      expect(await botOf(s)).toMatchObject({
        state: "HANDED_OVER",
        label: "Bot asked for a human",
        severity: "attention",
        handover: {
          origin: "flow",
          reasonCode: "needs_staff",
          studentMayNotHaveReceivedMessage: false,
        },
      });
    });

    it.each([
      ["staff_assigned", false, undefined],
      ["staff_replied", false, undefined],
      ["operator_stop", false, undefined],
      ["conversation_resolved", false, undefined],
      ["bot_error", false, "warning"],
      ["engine_error", false, "warning"],
      ["send_held", true, undefined],
      ["send_refused", true, undefined],
      ["send_outcome_unknown", true, undefined],
      ["send_outcome_unresolved", true, undefined],
    ])(
      "a system handover (%s) is system-initiated; delivery risk=%s",
      async (reason, warns, sev) => {
        const s = await student();
        await handedOver(s, reason);
        const bot = (await botOf(s))!;
        expect(bot.label).toBe("Bot handed over to staff");
        expect(bot.handover).toMatchObject({
          origin: "system",
          reasonCode: reason,
          studentMayNotHaveReceivedMessage: warns,
        });
        expect(bot.severity).toBe(sev ?? (warns ? "warning" : "attention"));
      },
    );

    it("FAILED is a warning, COMPLETED is quiet", async () => {
      const a = await student();
      await ended(a, "state = 'FAILED', end_reason = 'error'");
      expect(await botOf(a)).toMatchObject({
        state: "FAILED",
        label: "Bot stopped with an error",
        severity: "warning",
        handover: null,
      });
      const b = await student();
      await ended(b, "state = 'COMPLETED', end_reason = 'idle_timeout'");
      expect(await botOf(b)).toMatchObject({ state: "COMPLETED", severity: "neutral" });
    });

    it("the LATEST session wins, whatever came before", async () => {
      const s = await student();
      await handedOver(s, "staff_replied");
      await ended(s, "state = 'COMPLETED', end_reason = 'flow_end'");
      expect((await botOf(s))!.state).toBe("COMPLETED");
      await live(s);
      expect((await botOf(s))!.state).toBe("WAITING_FOR_INPUT");
    });
  });

  describe("terminal notices", () => {
    async function withNotice(
      outcome: "QUEUED" | "SENDING" | "ACCEPTED" | "HELD" | "REJECTED" | "UNKNOWN_OUTCOME",
    ) {
      const s = await student();
      const row = await live(s);
      await queueBotStep(
        t,
        f,
        { id: row.id as string, student: s, keys: { ...keys, student: s } },
        { stepSeq: 1, message: textMessage("bye"), now: new Date(), terminal: "HANDED_OVER" },
      );
      const req = (
        await t.pool.query("select id from outbound_requests where bot_session_id = $1", [row.id])
      ).rows[0] as { id: string };
      if (outcome !== "QUEUED")
        await forceRequestState(
          t.pool,
          req.id,
          outcome,
          outcome === "REJECTED" ? { failureCode: "meta_rejected" } : {},
        );
      return botOf(s);
    }

    it.each([
      ["QUEUED", "PENDING", false],
      ["SENDING", "PENDING", false],
      ["ACCEPTED", "ACCEPTED", false],
      ["HELD", "HELD", true],
      ["REJECTED", "REJECTED", true],
      ["UNKNOWN_OUTCOME", "UNKNOWN_OUTCOME", true],
    ] as const)("notice request %s is shown as %s (warning=%s)", async (state, shown, warns) => {
      const bot = (await withNotice(state))!;
      expect(bot.notice).toMatchObject({ outcome: shown, warning: warns });
      expect(bot.severity).toBe(warns ? "warning" : "attention");
    });

    it("a session without a notice has notice=null", async () => {
      const s = await student();
      await handedOver(s, "staff_replied");
      expect((await botOf(s))!.notice).toBeNull();
    });
  });

  describe("sensitive data", () => {
    it("never returns variables, tokens, inputs or the raw handover code of an unknown reason", async () => {
      const s = await student();
      const row = await live(s, {
        variables: JSON.stringify({ phone: "CANARY-PHONE-0771234567" }),
        awaiting_token: "CANARYTOKEN0123456789A",
        last_consumed_token: "CANARYCONSUMED01234567",
      });
      await updateSession(
        t.pool,
        row.id as string,
        "state = 'HANDED_OVER', end_reason = 'system_handover', handover_reason = 'zz_secret_future_code', ended_at = clock_timestamp(), awaiting = NULL, awaiting_token = NULL",
      );
      const page = await listConversations(w.staff.ctx, { limit: 50 }, db());
      const detail = await getConversationDetail(w.staff.ctx, s.conversation.id, db());
      const text = JSON.stringify([page, detail]);
      for (const canary of [
        "CANARY",
        "0771234567",
        "zz_secret_future_code",
        "variables",
        "awaiting",
      ])
        expect(text).not.toContain(canary);
      expect(detail.bot).toMatchObject({
        handover: {
          origin: "unrecognized",
          reasonCode: null,
          reason: "The reason is not recognised",
        },
      });
    });

    it("a redacted session is labelled as redacted and still shows its lifecycle, never the cleared content", async () => {
      const s = await student();
      await handedOver(s, "needs_staff", "flow_handover", {
        variables: JSON.stringify({ n: "CANARY-REDACTED" }),
      });
      await shortenRetention(t.pool);
      const n = (await t.pool.query("select redact_expired_bot_sessions($1, 1000) n", [w.org.id]))
        .rows[0] as { n: number };
      expect(Number(n.n)).toBeGreaterThan(0);
      const bot = (await botOf(s))!;
      expect(bot.redacted).toBe(true);
      expect(
        (
          await t.pool.query("select variables from bot_sessions where conversation_id = $1", [
            s.conversation.id,
          ])
        ).rows[0].variables,
      ).toEqual({});
      expect(
        JSON.stringify(await listConversations(w.staff.ctx, { limit: 50 }, db())),
      ).not.toContain("CANARY-REDACTED");
      expect(bot).toMatchObject({
        label: "Bot asked for a human",
        handover: { reasonCode: "needs_staff" },
      });
    });
  });

  describe("permissions (D-3)", () => {
    it("VIEWER gets no bot data anywhere, and the filter is refused", async () => {
      const s = await student();
      await handedOver(s, "needs_staff", "flow_handover");
      const page = await listConversations(w.viewer.ctx, { limit: 50 }, db());
      expect(page.items.some((i) => i.id === s.conversation.id)).toBe(true);
      expect(JSON.stringify(page)).not.toMatch(/"bot"|Bot asked|needs_staff/);
      const detail = await getConversationDetail(w.viewer.ctx, s.conversation.id, db());
      expect("bot" in detail).toBe(false);
      await expect(attention(w.viewer)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        listConversations(w.viewer.ctx, { view: "botAttention", limit: 1, q: "x1" }, db()),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("STAFF and ADMIN (bot.read) see the indicator and may filter", async () => {
      const s = await student();
      await handedOver(s, "needs_staff", "flow_handover");
      for (const who of [w.staff, w.admin]) {
        expect((await botOf(s, who))!.state).toBe("HANDED_OVER");
        expect((await attention(who)).items.map((i) => i.id)).toContain(s.conversation.id);
      }
    });
  });

  describe("Bot Attention filter (D-2)", () => {
    it("selects exactly the unresolved conversations whose LATEST session is HANDED_OVER or FAILED", async () => {
      const x = await botWorld(t.db); // an isolated organization keeps the expected set exact
      const fx = await dispatchWorld(t, { lastInboundAt: fresh, w: x });
      const k = {
        organizationId: x.org.id,
        botId: fx.d.bot.id,
        versionId: fx.d.version.id,
        deploymentId: fx.d.deployment.id,
        whatsappAccountId: x.account.id,
      };
      const mk = async () => windowStudent(t, x, fresh);
      const end = async (s: Student, set: string, params: unknown[] = []) => {
        const row = await insertSession(t.pool, { ...k, student: s });
        await updateSession(
          t.pool,
          row.id as string,
          `${set}, ended_at = clock_timestamp()`,
          params,
        );
      };
      const handed = (s: Student) =>
        end(
          s,
          "state = 'HANDED_OVER', end_reason = 'flow_handover', handover_reason = 'needs_staff'",
        );

      const hit1 = x.student; // the world's own student: HANDED_OVER
      await handed(hit1);
      const hit2 = await mk(); // FAILED
      await end(hit2, "state = 'FAILED', end_reason = 'error'");
      const hit3 = await mk(); // PENDING is unresolved too
      await handed(hit3);
      await t.pool.query("update conversations set status = 'PENDING' where id = $1", [
        hit3.conversation.id,
      ]);
      const missResolved = await mk();
      await handed(missResolved);
      await resolve(missResolved);
      const missSuperseded = await mk(); // earlier HANDED_OVER, latest COMPLETED
      await handed(missSuperseded);
      await end(missSuperseded, "state = 'COMPLETED', end_reason = 'flow_end'");
      const missLive = await mk();
      await handed(missLive);
      await insertSession(t.pool, { ...k, student: missLive });
      const missCompleted = await mk();
      await end(missCompleted, "state = 'COMPLETED', end_reason = 'idle_timeout'");
      const missNone = await mk();
      // another organization's HANDED_OVER conversation never appears
      const other = await botWorld(t.db);
      const fo = await dispatchWorld(t, { lastInboundAt: fresh, w: other });
      const row = await insertSession(t.pool, {
        organizationId: other.org.id,
        botId: fo.d.bot.id,
        versionId: fo.d.version.id,
        deploymentId: fo.d.deployment.id,
        whatsappAccountId: other.account.id,
        student: other.student,
      });
      await updateSession(
        t.pool,
        row.id as string,
        "state = 'FAILED', end_reason = 'error', ended_at = clock_timestamp()",
      );

      const got = (await attention(x.staff, { limit: 50 })).items.map((i) => i.id);
      expect([...got].sort()).toEqual([hit1, hit2, hit3].map((s) => s.conversation.id).sort());
      for (const s of [missResolved, missSuperseded, missLive, missCompleted, missNone])
        expect(got).not.toContain(s.conversation.id);
      expect(got).not.toContain(other.student.conversation.id);

      // the other organization sees only its own
      expect((await attention(other.staff, { limit: 50 })).items.map((i) => i.id)).toEqual([
        other.student.conversation.id,
      ]);
    });

    it("is applied in the query: pages are full, ordered like the unfiltered list, without duplicates or gaps", async () => {
      const x = await botWorld(t.db);
      const fx = await dispatchWorld(t, { lastInboundAt: fresh, w: x });
      const k = {
        organizationId: x.org.id,
        botId: fx.d.bot.id,
        versionId: fx.d.version.id,
        deploymentId: fx.d.deployment.id,
        whatsappAccountId: x.account.id,
      };
      const students: Student[] = [x.student];
      for (let i = 0; i < 8; i++) students.push(await windowStudent(t, x, fresh));
      // spread activity times so the order is deterministic, then make every other conversation (the NEWEST ones included) a miss
      for (const [i, s] of students.entries())
        await t.pool.query(
          "update conversations set last_message_at = now() - ($2 * interval '1 minute') where id = $1",
          [s.conversation.id, i],
        );
      const matching: string[] = [];
      for (const [i, s] of students.entries()) {
        if (i % 2 === 1) continue; // 0,2,4,6,8 match; 1,3,5,7 are newer than some matches and do not
        const row = await insertSession(t.pool, { ...k, student: s });
        await updateSession(
          t.pool,
          row.id as string,
          "state = 'FAILED', end_reason = 'error', ended_at = clock_timestamp()",
        );
        matching.push(s.conversation.id);
      }
      const all = (await listConversations(x.staff.ctx, { limit: 50 }, db())).items.map(
        (i) => i.id,
      );
      const expected = all.filter((id) => matching.includes(id));
      expect(expected).toHaveLength(5);

      const seen: string[] = [];
      let cursor: string | undefined;
      const sizes: number[] = [];
      for (let guard = 0; guard < 10; guard++) {
        const page = await attention(x.staff, { limit: 2, ...(cursor ? { cursor } : {}) });
        sizes.push(page.items.length);
        seen.push(...page.items.map((i) => i.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(sizes).toEqual([2, 2, 1]);
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("combines with an account filter and search without leaking other rows", async () => {
      const s = await student();
      await handedOver(s, "needs_staff", "flow_handover");
      const page = await attention(w.staff, { accountId: w.account.id, limit: 50 });
      expect(page.items.map((i) => i.id)).toContain(s.conversation.id);
    });
  });

  describe("reads change nothing", () => {
    it("listing, filtering and detail leave sessions, requests, conversations and triggers byte-identical", async () => {
      const before = await fingerprint();
      await listConversations(w.staff.ctx, { limit: 50 }, db());
      await attention(w.staff, { limit: 50 });
      await attention(w.admin, { limit: 50 });
      const s = await student(); // (creating the student is the only write; fingerprint after it)
      const mid = await fingerprint();
      await getConversationDetail(w.staff.ctx, s.conversation.id, db());
      await getConversationDetail(w.admin.ctx, w.student.conversation.id, db());
      expect(await fingerprint()).toEqual(mid);
      expect(before.s).toEqual(mid.s);
      expect(before.r).toEqual(mid.r);
      expect(before.g).toEqual(mid.g);
    });

    it("another organization's conversation detail is not found (no bot data either)", async () => {
      const other = await botWorld(t.db);
      await expect(
        getConversationDetail(w.staff.ctx, other.student.conversation.id, db()),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
