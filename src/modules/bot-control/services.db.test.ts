import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { canonicalJson } from "@/shared/canonical-json";
import { logger } from "@/shared/logging/logger";
import { ForbiddenError, NotFoundError, ValidationError } from "@/shared/errors/http-errors";
import { validateFlow } from "@/modules/bots";
import { enquiryFlow, flowOfNormalizedSize, minimalFlow } from "@/modules/bots/testing";
import { setMembershipStatus } from "@/modules/inbox/testing";
import {
  BotControlError,
  EMERGENCY_STOP_PHRASE,
  activateDeployment,
  changeDeploymentVersion,
  createBot,
  emergencyStop,
  getBot,
  getVersion,
  listBots,
  listVersions,
  pauseDeployment,
  publishVersion,
  resumeDeployment,
  retireDeployment,
  stopActiveSessions,
  updateDraft,
  validateDraft,
} from "./index";
import {
  addStudent,
  botWorld,
  deployedBot,
  insertSession,
  publishedBot,
  type BotWorld,
} from "./testing";

// The bot-management services on a disposable al_ict_test_* database (Phase 08C, ADR 0019): drafts, publishing at the exact
// contract boundary, authorization (including revoked actors), the deployment lifecycle, Stop / Emergency Stop / Retire state
// changes, auditing and organization isolation.

const codeOf = (e: unknown) => (e as BotControlError).code;

describe("bot-control services", () => {
  let t: TestDb;
  let w: BotWorld;
  const deps = () => ({ db: t.db });
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
  const refused = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected a refusal");
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    w = await botWorld(t.db);
  });
  afterAll(async () => t.close());

  describe("drafts", () => {
    it("create, compare-and-set updates, dry runs and duplicate keys", async () => {
      const bot = (await createBot(w.admin.ctx, { key: "enquiry", name: "Enquiry" }, deps())).value;
      expect(bot).toMatchObject({ key: "enquiry", draftRevision: 0, hasDraft: false });
      expect(
        codeOf(await refused(createBot(w.admin.ctx, { key: "enquiry", name: "Again" }, deps()))),
      ).toBe("BOT_KEY_TAKEN");
      const dry = await updateDraft(
        w.admin.ctx,
        { botId: bot.id, expectedRevision: 0, config: minimalFlow() },
        deps(),
        { dryRun: true },
      );
      expect(dry.applied).toBe(false);
      expect((await getBot(w.admin.ctx, bot.id, deps())).hasDraft).toBe(false);
      await updateDraft(
        w.admin.ctx,
        { botId: bot.id, expectedRevision: 0, config: minimalFlow() },
        deps(),
      );
      expect(
        codeOf(
          await refused(
            updateDraft(
              w.admin.ctx,
              { botId: bot.id, expectedRevision: 0, config: minimalFlow() },
              deps(),
            ),
          ),
        ),
      ).toBe("STALE_REVISION");
      const loaded = await getBot(w.admin.ctx, bot.id, deps());
      expect(loaded.draftRevision).toBe(1);
      expect(loaded.draft).toEqual(JSON.parse(canonicalJson(minimalFlow())));
      // the stored text is exactly the canonical JSON
      const stored = (await q("select draft_config_canonical d from bots where id = $1", [bot.id]))
        .rows[0];
      expect(stored).toEqual({ d: canonicalJson(minimalFlow()) });
      expect((await validateDraft(w.admin.ctx, bot.id, deps())).ok).toBe(true);
    });

    it("saving an unchanged draft (identical, or the same JSON with keys reordered) is a no-op; stale saves are still refused", async () => {
      const bot = (await createBot(w.admin.ctx, { key: "noop", name: "No-op" }, deps())).value;
      await updateDraft(
        w.admin.ctx,
        { botId: bot.id, expectedRevision: 0, config: minimalFlow() },
        deps(),
      );
      const row = () => q("select to_jsonb(b) r from bots b where id = $1", [bot.id]);
      const before = (await row()).rows;
      const reversed = (v: unknown): unknown =>
        Array.isArray(v)
          ? v.map(reversed)
          : v !== null && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v)
                  .reverse()
                  .map(([k, x]) => [k, reversed(x)]),
              )
            : v;
      const reordered = reversed(minimalFlow());
      expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(minimalFlow()));
      const info = vi.spyOn(logger, "info");
      try {
        for (const config of [minimalFlow(), reordered]) {
          const saved = await updateDraft(
            w.admin.ctx,
            { botId: bot.id, expectedRevision: 1, config },
            deps(),
          );
          expect(saved).toMatchObject({
            applied: true,
            value: { draftRevision: 1, changed: false },
          });
        }
        expect(info).not.toHaveBeenCalledWith("bots.admin_action", expect.anything());
      } finally {
        info.mockRestore();
      }
      expect((await row()).rows).toEqual(before); // revision, metadata and text untouched
      for (const config of [minimalFlow(), reordered])
        expect(
          codeOf(
            await refused(
              updateDraft(w.admin.ctx, { botId: bot.id, expectedRevision: 0, config }, deps()),
            ),
          ),
        ).toBe("STALE_REVISION");
      // A real change still advances the revision.
      const changed = await updateDraft(
        w.admin.ctx,
        { botId: bot.id, expectedRevision: 1, config: { ...minimalFlow(), name: "renamed" } },
        deps(),
      );
      expect(changed.value).toMatchObject({ draftRevision: 2, changed: true });
    });

    it("STAFF may read but not edit; VIEWER may not read", async () => {
      expect(await listBots(w.staff.ctx, deps())).toBeInstanceOf(Array);
      expect(
        await refused(createBot(w.staff.ctx, { key: "staffbot", name: "S" }, deps())),
      ).toBeInstanceOf(ForbiddenError);
      expect(await refused(listBots(w.viewer.ctx, deps()))).toBeInstanceOf(ForbiddenError);
    });
  });

  describe("publishing at the contract boundary", () => {
    it("a flow of exactly 65,536 canonical bytes is saved, reloaded and published byte-for-byte", async () => {
      const flow = flowOfNormalizedSize(65_536);
      const { version } = await publishedBot(t.db, w, flow);
      expect(version.canonicalBytes).toBe(65_536);
      const row = (
        await q(
          `select octet_length(config_canonical) n,
                  config_sha256 = encode(sha256(convert_to(config_canonical, 'UTF8')), 'hex') hash_ok,
                  config = config_canonical::jsonb same
             from bot_versions where id = $1`,
          [version.id],
        )
      ).rows[0];
      expect(row).toEqual({ n: 65_536, hash_ok: true, same: true });
      const reloaded = await getVersion(w.admin.ctx, version.id, deps());
      expect(canonicalJson(reloaded.config)).toBe(canonicalJson(validateFlow(flow).config));
    });

    it("one byte more is refused: as a draft when its own canonical form is over, by validation when its normalized form is", async () => {
      const at = validateFlow(flowOfNormalizedSize(65_536)).config!;
      const bot = (await createBot(w.admin.ctx, { key: "over", name: "Over" }, deps())).value;
      const e = await refused(
        updateDraft(
          w.admin.ctx,
          { botId: bot.id, expectedRevision: 0, config: { ...at, name: `${at.name}x` } },
          deps(),
        ),
      );
      expect(e).toMatchObject({ code: "DRAFT_INVALID", reason: "CONFIG_TOO_LARGE" });
      // Fits as a draft, but its normalized (defaults added) form is one byte over the contract: publish refuses it.
      await updateDraft(
        w.admin.ctx,
        { botId: bot.id, expectedRevision: 0, config: flowOfNormalizedSize(65_537) },
        deps(),
      );
      const p = await refused(
        publishVersion(w.admin.ctx, { botId: bot.id, expectedRevision: 1 }, deps()),
      );
      expect(codeOf(p)).toBe("FLOW_INVALID");
      expect((p as BotControlError).diagnostics!.map((d) => d.code)).toContain("CONFIG_TOO_LARGE");
      expect(await listVersions(w.admin.ctx, bot.id, deps())).toEqual([]);
    });

    it("multilingual text and extreme valid coordinates survive storage exactly", async () => {
      const flow = enquiryFlow();
      const ids = Object.keys(flow.nodes as Record<string, unknown>);
      const xs = [5e-324, -1_000_000, 1_000_000, 0.1, 1e-7, 123456.789];
      flow.layout = Object.fromEntries(xs.map((x, i) => [ids[i]!, { x, y: -x }]));
      const { version } = await publishedBot(t.db, w, flow);
      const reloaded = await getVersion(w.admin.ctx, version.id, deps());
      expect(canonicalJson(reloaded.config)).toBe(canonicalJson(validateFlow(flow).config));
      const r = (
        await q(
          "select config_canonical like '%ආයුබෝවන්%' si, config_canonical like '%வணக்கம்%' ta, octet_length(config::text) > octet_length(config_canonical) wider from bot_versions where id = $1",
          [version.id],
        )
      ).rows[0];
      // PostgreSQL's own jsonb rendering is larger (decimal expansion, spaces): it never decides acceptance.
      expect(r).toEqual({ si: true, ta: true, wider: true });
    });

    it("stale revisions, missing drafts and invalid flows are refused; concurrent publishes get unique numbers", async () => {
      const bot = (await createBot(w.admin.ctx, { key: "numbers", name: "N" }, deps())).value;
      expect(
        codeOf(
          await refused(
            publishVersion(w.admin.ctx, { botId: bot.id, expectedRevision: 0 }, deps()),
          ),
        ),
      ).toBe("NO_DRAFT");
      await updateDraft(
        w.admin.ctx,
        { botId: bot.id, expectedRevision: 0, config: { nope: true } },
        deps(),
      );
      expect(
        codeOf(
          await refused(
            publishVersion(w.admin.ctx, { botId: bot.id, expectedRevision: 1 }, deps()),
          ),
        ),
      ).toBe("FLOW_INVALID");
      await updateDraft(
        w.admin.ctx,
        { botId: bot.id, expectedRevision: 1, config: minimalFlow() },
        deps(),
      );
      expect(
        codeOf(
          await refused(
            publishVersion(w.admin.ctx, { botId: bot.id, expectedRevision: 1 }, deps()),
          ),
        ),
      ).toBe("STALE_REVISION");
      const results = await Promise.all(
        [0, 1, 2].map(() =>
          publishVersion(w.admin.ctx, { botId: bot.id, expectedRevision: 2 }, deps()),
        ),
      );
      expect(results.map((r) => r.value.versionNumber).sort()).toEqual([1, 2, 3]);
      const dry = await publishVersion(
        w.admin.ctx,
        { botId: bot.id, expectedRevision: 2 },
        deps(),
        { dryRun: true },
      );
      expect(dry.applied).toBe(false);
      expect(await listVersions(w.admin.ctx, bot.id, deps())).toHaveLength(3);
      // Draft and publication leave no deployment event (their audit is the bot and version rows and the log line).
      expect(
        (await q("select count(*)::int n from bot_deployment_events where bot_id = $1", [bot.id]))
          .rows[0],
      ).toEqual({ n: 0 });
    });

    it("a suspended ADMIN cannot publish; a demoted ADMIN cannot activate", async () => {
      const own = await botWorld(t.db);
      const { bot, version } = await publishedBot(t.db, own);
      await updateDraft(
        own.admin.ctx,
        { botId: bot.id, expectedRevision: 1, config: minimalFlow() },
        deps(),
      );
      await setMembershipStatus(t.db, own.admin.membershipId, "SUSPENDED");
      expect(
        await refused(
          publishVersion(own.admin.ctx, { botId: bot.id, expectedRevision: 2 }, deps()),
        ),
      ).toBeInstanceOf(ForbiddenError);
      await setMembershipStatus(t.db, own.admin.membershipId, "ACTIVE");
      await q("update organization_memberships set role = 'STAFF' where id = $1", [
        own.admin.membershipId,
      ]);
      expect(
        await refused(
          activateDeployment(
            own.admin.ctx, // still says ADMIN: the locked membership row decides
            {
              botId: bot.id,
              versionId: version.id,
              whatsappAccountId: own.account.id,
              priority: 1,
            },
            deps(),
          ),
        ),
      ).toBeInstanceOf(ForbiddenError);
      expect(await listVersions(own.staff.ctx, bot.id, deps())).toHaveLength(1);
      expect(
        (await q("select count(*)::int n from bot_deployments where bot_id = $1", [bot.id]))
          .rows[0],
      ).toEqual({ n: 0 });
    });
  });

  describe("deployment lifecycle", () => {
    it("activate, refuse duplicates and taken priorities, pause, resume and change version", async () => {
      const own = await botWorld(t.db);
      const { bot, version, deployment } = await deployedBot(t.db, own, 5);
      expect(deployment).toMatchObject({ status: "ACTIVE", sendEpoch: 1, priority: 5 });
      expect(
        codeOf(
          await refused(
            activateDeployment(
              own.admin.ctx,
              {
                botId: bot.id,
                versionId: version.id,
                whatsappAccountId: own.account.id,
                priority: 6,
              },
              deps(),
            ),
          ),
        ),
      ).toBe("DEPLOYMENT_EXISTS");
      const second = await publishedBot(t.db, own);
      expect(
        codeOf(
          await refused(
            activateDeployment(
              own.admin.ctx,
              {
                botId: second.bot.id,
                versionId: second.version.id,
                whatsappAccountId: own.account.id,
                priority: 5,
              },
              deps(),
            ),
          ),
        ),
      ).toBe("PRIORITY_TAKEN");
      expect(
        await refused(
          activateDeployment(
            own.admin.ctx,
            {
              botId: second.bot.id,
              versionId: version.id,
              whatsappAccountId: own.account.id,
              priority: 9,
            },
            deps(),
          ),
        ),
      ).toBeInstanceOf(NotFoundError);

      const paused = (await pauseDeployment(own.admin.ctx, { deploymentId: deployment.id }, deps()))
        .value;
      expect(paused.status).toBe("PAUSED");
      expect(
        codeOf(
          await refused(pauseDeployment(own.admin.ctx, { deploymentId: deployment.id }, deps())),
        ),
      ).toBe("INVALID_TRANSITION");
      const resumed = (
        await resumeDeployment(own.admin.ctx, { deploymentId: deployment.id }, deps())
      ).value;
      expect(resumed.startEligibleFrom.getTime()).toBeGreaterThan(
        deployment.startEligibleFrom.getTime(),
      );
      await updateDraft(
        own.admin.ctx,
        { botId: bot.id, expectedRevision: 1, config: { ...minimalFlow(), name: "v2" } },
        deps(),
      );
      const v2 = (
        await publishVersion(own.admin.ctx, { botId: bot.id, expectedRevision: 2 }, deps())
      ).value;
      const changed = (
        await changeDeploymentVersion(
          own.admin.ctx,
          { deploymentId: deployment.id, versionId: v2.id },
          deps(),
        )
      ).value;
      expect(changed).toMatchObject({ versionId: v2.id, sendEpoch: 1 });
      expect(
        codeOf(
          await refused(
            changeDeploymentVersion(
              own.admin.ctx,
              { deploymentId: deployment.id, versionId: v2.id },
              deps(),
            ),
          ),
        ),
      ).toBe("SAME_VERSION");
      const kinds = (
        await q(
          "select kind, actor_membership_id from bot_deployment_events where deployment_id = $1 order by created_at",
          [deployment.id],
        )
      ).rows.map((r) => (r as { kind: string }).kind);
      expect(kinds).toEqual(["ACTIVATED", "PAUSED", "RESUMED", "VERSION_CHANGED"]);
    });

    it("Stop Active Sessions hands every live session over with output suppressed, pauses and bumps the epoch", async () => {
      const own = await botWorld(t.db);
      const d = await deployedBot(t.db, own);
      const keys = {
        organizationId: own.org.id,
        botId: d.bot.id,
        versionId: d.version.id,
        deploymentId: d.deployment.id,
        whatsappAccountId: own.account.id,
      };
      for (let i = 0; i < 2; i++)
        await insertSession(t.pool, {
          ...keys,
          student: await addStudent(t.db, own.org.id, own.account.id),
        });
      const stop = (n: number, dryRun = false) =>
        stopActiveSessions(
          own.admin.ctx,
          { deploymentId: d.deployment.id, expectedLiveSessions: n },
          deps(),
          { dryRun },
        );
      expect(codeOf(await refused(stop(1)))).toBe("CONFIRMATION_MISMATCH");
      expect((await stop(2, true)).applied).toBe(false);
      const r = (await stop(2)).value;
      expect(r).toMatchObject({
        sessionsStopped: 2,
        deployment: { status: "PAUSED", sendEpoch: 2 },
      });
      const sessions = (
        await q(
          "select state, end_reason, handover_reason, output_suppressed_at is not null suppressed, handover_control_seq > started_control_seq ordered, terminal_notice_step_seq, awaiting_token from bot_sessions where deployment_id = $1",
          [d.deployment.id],
        )
      ).rows;
      expect(sessions).toEqual(
        Array(2).fill({
          state: "HANDED_OVER",
          end_reason: "system_handover",
          handover_reason: "operator_stop",
          suppressed: true,
          ordered: true,
          terminal_notice_step_seq: null,
          awaiting_token: null,
        }),
      );
      const event = (
        await q(
          "select kind, sessions_affected, requests_suppressed, send_epoch from bot_deployment_events where deployment_id = $1 and kind = 'SESSIONS_STOPPED'",
          [d.deployment.id],
        )
      ).rows[0];
      expect(event).toEqual({
        kind: "SESSIONS_STOPPED",
        sessions_affected: 2,
        requests_suppressed: 0,
        send_epoch: "2",
      });
      expect(
        (
          await q(
            "select count(*)::int n from bot_session_events where kind = 'HANDED_OVER' and code = 'operator_stop' and organization_id = $1",
            [own.org.id],
          )
        ).rows[0],
      ).toEqual({ n: 2 });
    });

    it("Retire needs the bot key, stops sessions, is final, and releases the bot and priority slots", async () => {
      const own = await botWorld(t.db);
      const d = await deployedBot(t.db, own, 3);
      expect(
        codeOf(
          await refused(
            retireDeployment(
              own.admin.ctx,
              { deploymentId: d.deployment.id, expectedLiveSessions: 0, confirmBotKey: "wrong" },
              deps(),
            ),
          ),
        ),
      ).toBe("CONFIRMATION_MISMATCH");
      const r = (
        await retireDeployment(
          own.admin.ctx,
          { deploymentId: d.deployment.id, expectedLiveSessions: 0, confirmBotKey: d.bot.key },
          deps(),
        )
      ).value;
      expect(r.deployment).toMatchObject({ status: "RETIRED", sendEpoch: 2 });
      expect(
        codeOf(
          await refused(resumeDeployment(own.admin.ctx, { deploymentId: d.deployment.id }, deps())),
        ),
      ).toBe("INVALID_TRANSITION");
      const again = (
        await activateDeployment(
          own.admin.ctx,
          {
            botId: d.bot.id,
            versionId: d.version.id,
            whatsappAccountId: own.account.id,
            priority: 3,
          },
          deps(),
        )
      ).value;
      expect(again.id).not.toBe(d.deployment.id);
    });

    it("Emergency Stop: typed phrase and count, every ACTIVE/PAUSED deployment STOPPED with its epoch bumped, others untouched", async () => {
      const own = await botWorld(t.db);
      const other = await botWorld(t.db);
      const d1 = await deployedBot(t.db, own, 1);
      const d2 = await deployedBot(t.db, own, 2);
      const foreign = await deployedBot(t.db, other, 1);
      expect(
        await refused(
          emergencyStop(own.admin.ctx, { expectedDeployments: 2, confirmPhrase: "stop" }, deps()),
        ),
      ).toBeInstanceOf(ValidationError);
      expect(
        codeOf(
          await refused(
            emergencyStop(
              own.admin.ctx,
              { expectedDeployments: 3, confirmPhrase: EMERGENCY_STOP_PHRASE },
              deps(),
            ),
          ),
        ),
      ).toBe("CONFIRMATION_MISMATCH");
      expect(
        await refused(
          emergencyStop(
            own.staff.ctx,
            { expectedDeployments: 2, confirmPhrase: EMERGENCY_STOP_PHRASE },
            deps(),
          ),
        ),
      ).toBeInstanceOf(ForbiddenError);
      const r = (
        await emergencyStop(
          own.admin.ctx,
          { expectedDeployments: 2, confirmPhrase: EMERGENCY_STOP_PHRASE },
          deps(),
        )
      ).value;
      expect(r.deployments.map((d) => [d.id, d.status, d.sendEpoch]).sort()).toEqual(
        [
          [d1.deployment.id, "STOPPED", 2],
          [d2.deployment.id, "STOPPED", 2],
        ].sort(),
      );
      expect(
        (
          await q("select status, send_epoch from bot_deployments where id = $1", [
            foreign.deployment.id,
          ])
        ).rows[0],
      ).toEqual({
        status: "ACTIVE",
        send_epoch: "1",
      });
      // a stopped deployment may be resumed (start eligibility restarts)
      expect(
        (await resumeDeployment(own.admin.ctx, { deploymentId: d1.deployment.id }, deps())).value
          .status,
      ).toBe("ACTIVE");
    });
  });

  describe("organization isolation", () => {
    it("another organization's bots, versions and deployments are invisible and untouchable", async () => {
      const mine = await botWorld(t.db);
      const theirs = await botWorld(t.db);
      const d = await deployedBot(t.db, theirs);
      expect(await listBots(mine.admin.ctx, deps())).toEqual([]);
      // Thunks, started one at a time: each refusal is awaited (and so handled) as soon as its operation starts. An array of
      // already-started promises would leave the later ones rejecting with no handler attached yet.
      const attempts: Record<string, () => Promise<unknown>> = {
        getBot: () => getBot(mine.admin.ctx, d.bot.id, deps()),
        getVersion: () => getVersion(mine.admin.ctx, d.version.id, deps()),
        updateDraft: () =>
          updateDraft(
            mine.admin.ctx,
            { botId: d.bot.id, expectedRevision: 1, config: minimalFlow() },
            deps(),
          ),
        publishVersion: () =>
          publishVersion(mine.admin.ctx, { botId: d.bot.id, expectedRevision: 1 }, deps()),
        pauseDeployment: () =>
          pauseDeployment(mine.admin.ctx, { deploymentId: d.deployment.id }, deps()),
        stopActiveSessions: () =>
          stopActiveSessions(
            mine.admin.ctx,
            { deploymentId: d.deployment.id, expectedLiveSessions: 0 },
            deps(),
          ),
        activateDeployment: () =>
          activateDeployment(
            mine.admin.ctx,
            {
              botId: d.bot.id,
              versionId: d.version.id,
              whatsappAccountId: mine.account.id,
              priority: 9,
            },
            deps(),
          ),
      };
      const before = (
        await q(
          "select (select to_jsonb(b) from bots b where id = $1) bot, (select to_jsonb(x) from bot_deployments x where id = $2) deployment, (select count(*)::int from bot_versions where bot_id = $1) versions, (select count(*)::int from bot_deployment_events where organization_id = $3) events",
          [d.bot.id, d.deployment.id, theirs.org.id],
        )
      ).rows[0];
      for (const [name, attempt] of Object.entries(attempts))
        expect(await refused(attempt()), name).toBeInstanceOf(NotFoundError);
      // ...and nothing of theirs changed.
      expect(
        (
          await q(
            "select (select to_jsonb(b) from bots b where id = $1) bot, (select to_jsonb(x) from bot_deployments x where id = $2) deployment, (select count(*)::int from bot_versions where bot_id = $1) versions, (select count(*)::int from bot_deployment_events where organization_id = $3) events",
            [d.bot.id, d.deployment.id, theirs.org.id],
          )
        ).rows[0],
      ).toEqual(before);
      // my bot cannot be deployed on their account
      const own = await publishedBot(t.db, mine);
      expect(
        await refused(
          activateDeployment(
            mine.admin.ctx,
            {
              botId: own.bot.id,
              versionId: own.version.id,
              whatsappAccountId: theirs.account.id,
              priority: 1,
            },
            deps(),
          ),
        ),
      ).toBeInstanceOf(NotFoundError);
    });
  });
});
