import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { insertTrigger } from "../bot-runtime/testing";
import { ForbiddenError, ValidationError } from "@/shared/errors/http-errors";
import {
  LISTING_LIMIT_MAX,
  listBotSessions,
  listDeadTriggers,
  listDeploymentsPage,
  listDeployments,
} from "./index";
import { runBotsCli } from "./operator";
import {
  botWorld,
  deployedBot,
  insertSession,
  updateSession,
  type BotWorld,
  type SessionKeys,
} from "./testing";

// Phase 08F-2 operator listings on real PostgreSQL: permission, tenant isolation, bounds, keyset paging, field whitelist and
// read-only behaviour.

type CliDoc = {
  ok: boolean;
  error?: string;
  sessions: unknown[];
  triggers: unknown[];
  deployments: unknown[];
  nextCursor?: unknown;
};

describe("operator listings (08F-2)", () => {
  let t: TestDb;
  let a: BotWorld;
  let b: BotWorld;
  let keysA: SessionKeys;
  const deps = () => ({ db: t.db as never });
  const fingerprint = async () =>
    (
      await t.pool.query(
        `select (select md5(string_agg(to_jsonb(x)::text, '|' order by id)) from bot_sessions x) s,
                (select md5(string_agg(to_jsonb(x)::text, '|' order by id)) from bot_triggers x) g,
                (select md5(string_agg(to_jsonb(x)::text, '|' order by id)) from bot_deployments x) d,
                (select md5(string_agg(to_jsonb(x)::text, '|' order by id)) from bot_deployment_events x) e,
                (select count(*) from outbound_requests) r`,
      )
    ).rows[0];

  beforeAll(async () => {
    t = await createTestDatabase();
    a = await botWorld(t.db);
    b = await botWorld(t.db);
    const d = await deployedBot(t.db, a);
    keysA = {
      organizationId: a.org.id,
      botId: d.bot.id,
      versionId: d.version.id,
      deploymentId: d.deployment.id,
      whatsappAccountId: a.account.id,
      student: a.student,
    };
  });
  afterAll(async () => t.close());

  it("requires bot.read: VIEWER is refused by every listing, STAFF and ADMIN are served", async () => {
    for (const list of [listBotSessions, listDeadTriggers, listDeploymentsPage])
      await expect(list(a.viewer.ctx, {}, deps())).rejects.toBeInstanceOf(ForbiddenError);
    for (const who of [a.staff, a.admin])
      for (const list of [listBotSessions, listDeadTriggers, listDeploymentsPage])
        await expect(list(who.ctx, {}, deps())).resolves.toMatchObject({
          items: expect.any(Array),
        });
  });

  describe("sessions", () => {
    it("returns lifecycle metadata only, newest first, and never variables, tokens or input ids", async () => {
      const live = await insertSession(t.pool, keysA, {
        variables: JSON.stringify({ phone: "CANARY-0771234567" }),
        awaiting_token: "CANARYTOKEN0123456789A",
      });
      const page = await listBotSessions(a.staff.ctx, {}, deps());
      const item = page.items.find((i) => i.id === live.id)!;
      expect(item).toMatchObject({
        state: "WAITING_FOR_INPUT",
        deploymentId: keysA.deploymentId,
        hasTerminalNotice: false,
        redacted: false,
        endedAt: null,
      });
      expect(Object.keys(item).sort()).toEqual(
        [
          "botId",
          "botVersionId",
          "conversationId",
          "deploymentId",
          "endReason",
          "endedAt",
          "handoverReason",
          "hasTerminalNotice",
          "id",
          "redacted",
          "sendCount",
          "startedAt",
          "state",
          "stepSeq",
          "whatsappAccountId",
        ].sort(),
      );
      expect(JSON.stringify(page)).not.toMatch(/CANARY|variables|awaiting|token/i);
    });

    it("pages by keyset without gaps or duplicates, honours state and deployment filters, and is bounded", async () => {
      const x = await botWorld(t.db);
      const d = await deployedBot(t.db, x);
      const k: SessionKeys = {
        organizationId: x.org.id,
        botId: d.bot.id,
        versionId: d.version.id,
        deploymentId: d.deployment.id,
        whatsappAccountId: x.account.id,
        student: x.student,
      };
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const row = await insertSession(t.pool, k);
        await updateSession(
          t.pool,
          row.id as string,
          "state = 'COMPLETED', end_reason = 'flow_end', ended_at = clock_timestamp()",
        );
        ids.unshift(row.id as string); // newest first
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      const sizes: number[] = [];
      for (let guard = 0; guard < 6; guard++) {
        const p = await listBotSessions(
          x.staff.ctx,
          { limit: 2, ...(cursor ? { cursor } : {}) },
          deps(),
        );
        sizes.push(p.items.length);
        seen.push(...p.items.map((i) => i.id));
        if (!p.nextCursor) break;
        cursor = p.nextCursor;
      }
      expect(sizes).toEqual([2, 2, 1]);
      expect(seen).toEqual(ids);
      expect((await listBotSessions(x.staff.ctx, { state: "FAILED" }, deps())).items).toEqual([]);
      expect(
        (
          await listBotSessions(
            x.staff.ctx,
            { state: "COMPLETED", deploymentId: d.deployment.id },
            deps(),
          )
        ).items,
      ).toHaveLength(5);
      expect(
        (await listBotSessions(x.staff.ctx, { deploymentId: keysA.deploymentId }, deps())).items,
      ).toEqual(
        [], // another organization's deployment id yields nothing
      );
    });

    it("rejects out-of-range limits, unknown fields, bad filters and forged cursors", async () => {
      for (const bad of [
        { limit: 0 },
        { limit: LISTING_LIMIT_MAX + 1 },
        { limit: 1.5 },
        { limit: Number.NaN },
        { organizationId: b.org.id },
        { state: "NOPE" },
        { deploymentId: "not-a-uuid" },
        { cursor: "!!!" },
        { cursor: Buffer.from('["x","y"]').toString("base64url") },
      ])
        await expect(
          listBotSessions(a.staff.ctx, bad, deps()),
          JSON.stringify(bad),
        ).rejects.toBeInstanceOf(ValidationError);
      expect(
        (await listBotSessions(a.staff.ctx, { limit: LISTING_LIMIT_MAX }, deps())).items.length,
      ).toBeLessThanOrEqual(LISTING_LIMIT_MAX);
    });
  });

  describe("DEAD triggers", () => {
    it("lists only DEAD rows of the caller's organization, as ids and codes", async () => {
      const ctxA = {
        organizationId: a.org.id,
        accountId: a.account.id,
        conversationId: a.student.conversation.id,
      };
      const ctxB = {
        organizationId: b.org.id,
        accountId: b.account.id,
        conversationId: b.student.conversation.id,
      };
      const dead = await insertTrigger(t, ctxA, { finished: "DEAD" });
      const processed = await insertTrigger(t, ctxA, { finished: "PROCESSED" });
      const pending = await insertTrigger(t, ctxA, {});
      const theirs = await insertTrigger(t, ctxB, { finished: "DEAD" });
      const page = await listDeadTriggers(a.staff.ctx, {}, deps());
      const got = page.items.map((i) => i.id);
      expect(got).toContain(dead.id);
      for (const other of [processed.id, pending.id, theirs.id]) expect(got).not.toContain(other);
      expect(page.items.find((i) => i.id === dead.id)).toMatchObject({
        outcomeCode: "attempts_exhausted",
        messageId: dead.messageId,
      });
      expect(Object.keys(page.items[0]!).sort()).toEqual(
        [
          "attempts",
          "conversationId",
          "deferrals",
          "enqueuedAt",
          "id",
          "lastErrorCode",
          "messageId",
          "outcomeCode",
          "processedAt",
          "sessionId",
          "whatsappAccountId",
        ].sort(),
      );
      expect((await listDeadTriggers(b.staff.ctx, {}, deps())).items.map((i) => i.id)).toEqual([
        theirs.id,
      ]);
    });

    it("pages by keyset and is bounded", async () => {
      const x = await botWorld(t.db);
      const c = {
        organizationId: x.org.id,
        accountId: x.account.id,
        conversationId: x.student.conversation.id,
      };
      const made: string[] = [];
      for (let i = 0; i < 3; i++)
        made.unshift((await insertTrigger(t, c, { finished: "DEAD" })).id);
      const first = await listDeadTriggers(x.staff.ctx, { limit: 2 }, deps());
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await listDeadTriggers(
        x.staff.ctx,
        { limit: 2, cursor: first.nextCursor! },
        deps(),
      );
      expect([...first.items, ...second.items].map((i) => i.id).sort()).toEqual([...made].sort());
      expect(second.nextCursor).toBeNull();
      await expect(listDeadTriggers(x.staff.ctx, { limit: 101 }, deps())).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  describe("deployments", () => {
    it("returns the same deployments, in the same order, as the existing listing, with a bounded page", async () => {
      const x = await botWorld(t.db);
      for (const priority of [3, 1, 2]) await deployedBot(t.db, x, priority);
      const existing = await listDeployments(x.staff.ctx, deps());
      const paged: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 5; guard++) {
        const p = await listDeploymentsPage(
          x.staff.ctx,
          { limit: 2, ...(cursor ? { cursor } : {}) },
          deps(),
        );
        paged.push(...p.items.map((i) => i.id));
        if (!p.nextCursor) break;
        cursor = p.nextCursor;
      }
      expect(paged).toEqual(existing.map((d) => d.id));
      expect(existing).toHaveLength(3);
      const item = (await listDeploymentsPage(x.staff.ctx, { status: "ACTIVE" }, deps())).items[0]!;
      expect(Object.keys(item).sort()).toEqual(
        [
          "activatedAt",
          "botId",
          "id",
          "priority",
          "sendEpoch",
          "startEligibleFrom",
          "statusChangedAt",
          "status",
          "versionId",
          "whatsappAccountId",
        ].sort(),
      );
      expect((await listDeploymentsPage(x.staff.ctx, { status: "RETIRED" }, deps())).items).toEqual(
        [],
      );
      // another organization's deployments never appear
      expect((await listDeploymentsPage(b.staff.ctx, {}, deps())).items).toEqual([]);
    });
  });

  it("reading changes nothing: sessions, triggers, deployments, deployment events and requests are identical", async () => {
    const before = await fingerprint();
    for (const who of [a.staff, a.admin, b.staff]) {
      await listBotSessions(who.ctx, {}, deps());
      await listDeadTriggers(who.ctx, {}, deps());
      await listDeploymentsPage(who.ctx, {}, deps());
    }
    expect(await fingerprint()).toEqual(before);
  });

  describe("operator command line", () => {
    const run = async (args: string[], who: BotWorld["staff"], w: BotWorld = a) => {
      const out: unknown[] = [];
      const user = (await t.pool.query("select email from users where id = $1", [who.userId]))
        .rows[0].email as string;
      const code = await runBotsCli(
        [...args, "--organization", w.org.id, "--actor", user],
        t.db as never,
        (v) => out.push(v),
      );
      return { code, doc: out[0] as CliDoc };
    };
    it("sessions, dead-triggers and deployments are bounded read-only commands", async () => {
      const s = await run(["sessions", "--limit", "1"], a.staff);
      expect(s.code).toBe(0);
      expect(s.doc.sessions).toHaveLength(1);
      expect(s.doc).toHaveProperty("nextCursor");
      expect((await run(["dead-triggers"], a.staff)).doc.triggers).toBeInstanceOf(Array);
      expect((await run(["deployments"], a.admin)).doc.deployments.length).toBeGreaterThan(0);
    });
    it("refuses a VIEWER (exit 1) and an out-of-range limit (exit 1) without output of data", async () => {
      const denied = await run(["sessions"], a.viewer);
      expect(denied.code).toBe(1);
      expect(denied.doc).toMatchObject({ ok: false });
      expect(JSON.stringify(denied.doc)).not.toContain("sessions");
      const big = await run(["sessions", "--limit", "1000"], a.staff);
      expect(big.code).toBe(1);
      expect(big.doc).toMatchObject({ ok: false, error: "VALIDATION_ERROR" });
      expect((await run(["sessions", "--limit", "abc"], a.staff)).code).toBe(1);
    });
  });
});
