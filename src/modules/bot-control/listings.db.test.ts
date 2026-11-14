import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { insertTrigger } from "../bot-runtime/testing";
import { ForbiddenError, ValidationError } from "@/shared/errors/http-errors";
import {
  LISTING_LIMIT_MAX,
  createBot,
  listBots,
  listBotSessions,
  listBotsPage,
  listDeadTriggers,
  listDeploymentsPage,
  listDeployments,
  updateDraft,
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

  describe("bots (DEV-1)", () => {
    const pages = async (who: BotWorld["staff"], limit: number) => {
      const keys: string[] = [];
      const sizes: number[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const p = await listBotsPage(who.ctx, { limit, ...(cursor ? { cursor } : {}) }, deps());
        sizes.push(p.items.length);
        keys.push(...p.items.map((i) => i.key));
        if (!p.nextCursor) break;
        cursor = p.nextCursor;
      }
      return { keys, sizes };
    };

    it("requires bot.read and returns summaries only: never a draft, whatever it contains", async () => {
      const x = await botWorld(t.db);
      await expect(listBotsPage(x.viewer.ctx, {}, deps())).rejects.toBeInstanceOf(ForbiddenError);
      expect(await listBotsPage(x.staff.ctx, {}, deps())).toEqual({ items: [], nextCursor: null });
      const empty = (await createBot(x.admin.ctx, { key: "empty", name: "Empty" }, deps())).value;
      const full = (
        await createBot(x.admin.ctx, { key: "full", name: "Full", description: "D" }, deps())
      ).value;
      await updateDraft(
        x.admin.ctx,
        { botId: full.id, expectedRevision: 0, config: { marker: "CANARY-DRAFT-TEXT" } },
        deps(),
      );
      const page = await listBotsPage(x.staff.ctx, {}, deps());
      expect(page.nextCursor).toBeNull();
      expect(page.items).toMatchObject([
        { id: empty.id, key: "empty", name: "Empty", description: null, draftRevision: 0 },
        { id: full.id, key: "full", name: "Full", description: "D", draftRevision: 1 },
      ]);
      expect(page.items.map((i) => [i.hasDraft, i.draftUpdatedAt === null])).toEqual([
        [false, true],
        [true, false],
      ]);
      for (const item of page.items) {
        expect(Object.keys(item).sort()).toEqual(
          [
            "createdAt",
            "description",
            "draftRevision",
            "draftUpdatedAt",
            "hasDraft",
            "id",
            "key",
            "name",
          ].sort(),
        );
        expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      }
      expect(JSON.stringify(page)).not.toMatch(/CANARY|marker/);
      // hasDraft agrees with the existing unbounded listing, which reads the draft column itself
      expect(page.items.map((i) => [i.key, i.hasDraft])).toEqual(
        (await listBots(x.staff.ctx, deps())).map((i) => [i.key, i.hasDraft]),
      );
    });

    it("pages a fixed set by key without gaps or repeats, in the existing listing's order, and stays inside the organization", async () => {
      const x = await botWorld(t.db);
      const y = await botWorld(t.db);
      for (const key of ["m", "a_b", "ab", "z9", "a", "b_1", "b1"])
        await createBot(x.admin.ctx, { key, name: key }, deps());
      for (const key of ["a", "c", "zz"]) await createBot(y.admin.ctx, { key, name: key }, deps());
      const existing = (await listBots(x.staff.ctx, deps())).map((i) => i.key);
      expect(existing).toHaveLength(7);
      for (const [limit, sizes] of [
        [1, [1, 1, 1, 1, 1, 1, 1]],
        [2, [2, 2, 2, 1]],
        [3, [3, 3, 1]],
        [7, [7]],
        [100, [7]],
      ] as const) {
        const got = await pages(x.staff, limit);
        expect(got.keys, `limit ${limit}`).toEqual(existing);
        expect(got.sizes, `limit ${limit}`).toEqual(sizes);
      }
      expect((await pages(y.staff, 2)).keys).toEqual(
        (await listBots(y.staff.ctx, deps())).map((i) => i.key),
      );
      // A cursor naming a key that exists only in the OTHER organization is just a starting point here: own rows after it.
      const cursorOf = (key: string) => Buffer.from(JSON.stringify([key])).toString("base64url");
      const fromForeign = await listBotsPage(x.staff.ctx, { cursor: cursorOf("c") }, deps());
      expect(fromForeign.items.map((i) => i.key)).toEqual(existing.slice(existing.indexOf("m")));
      expect(fromForeign.items.every((i) => existing.includes(i.key))).toBe(true);
      // Replay is not a snapshot: the same cursor reflects current data (a key created after it appears on the replay).
      const replay = cursorOf("m");
      const first = await listBotsPage(x.staff.ctx, { cursor: replay }, deps());
      expect(await listBotsPage(x.staff.ctx, { cursor: replay }, deps())).toEqual(first);
      await createBot(x.admin.ctx, { key: "n", name: "n" }, deps());
      const again = await listBotsPage(x.staff.ctx, { cursor: replay }, deps());
      expect(again.items.map((i) => i.key)).toEqual(["n", ...first.items.map((i) => i.key)]);
    });

    it("rejects out-of-range limits, unknown fields and malformed cursors, and is bounded", async () => {
      for (const bad of [
        { limit: 0 },
        { limit: LISTING_LIMIT_MAX + 1 },
        { limit: 1.5 },
        { limit: Number.NaN },
        { limit: "50" },
        { organizationId: b.org.id },
        { key: "a" },
        { cursor: "!!!" },
        { cursor: Buffer.from('["Not A Key"]').toString("base64url") },
        { cursor: Buffer.from('["a","b"]').toString("base64url") },
      ])
        await expect(
          listBotsPage(a.staff.ctx, bad, deps()),
          JSON.stringify(bad),
        ).rejects.toBeInstanceOf(ValidationError);
      expect(
        (await listBotsPage(a.staff.ctx, { limit: LISTING_LIMIT_MAX }, deps())).items.length,
      ).toBeLessThanOrEqual(LISTING_LIMIT_MAX);
    });
  });

  it("reading changes nothing: sessions, triggers, deployments, deployment events and requests are identical", async () => {
    const before = await fingerprint();
    const bots = async () =>
      (
        await t.pool.query(
          "select md5(string_agg(to_jsonb(x)::text, '|' order by id)) m from bots x",
        )
      ).rows[0];
    const botsBefore = await bots();
    for (const who of [a.staff, a.admin, b.staff]) {
      await listBotSessions(who.ctx, {}, deps());
      await listDeadTriggers(who.ctx, {}, deps());
      await listDeploymentsPage(who.ctx, {}, deps());
      await listBotsPage(who.ctx, {}, deps());
    }
    expect(await fingerprint()).toEqual(before);
    expect(await bots()).toEqual(botsBefore);
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
    it("the unbounded `list` is unchanged, and a malformed bot id is a validation error for `show` and `validate` (DEV-1)", async () => {
      const listed = await run(["list"], a.staff);
      expect(listed.code).toBe(0);
      expect((listed.doc as unknown as { bots: unknown[] }).bots).toEqual(
        await listBots(a.staff.ctx, deps()),
      );
      for (const command of ["show", "validate"]) {
        const bad = await run([command, "not-a-uuid"], a.staff);
        expect(bad.code, command).toBe(1);
        expect(bad.doc, command).toMatchObject({
          ok: false,
          error: "VALIDATION_ERROR",
          fields: ["botId"],
        });
      }
    });
  });
});
