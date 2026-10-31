import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, seedAccount, type TestDb } from "@/db/__tests__/helpers";
import { routingConflicts, validateFlow, type FlowConfig } from "@/modules/bots";
import {
  classInfoFlow,
  enquiryFlow,
  generalInfoFlow,
  paymentEnquiryFlow,
  registrationEnquiryFlow,
  staffRoutingFlow,
  type Json,
} from "@/modules/bots/testing";
import { NotFoundError } from "@/shared/errors/http-errors";
import { logger } from "@/shared/logging/logger";
import {
  BotControlError,
  activateDeployment,
  changeDeploymentVersion,
  pauseDeployment,
  publishVersion,
  resumeDeployment,
  updateDraft,
} from "./index";
import {
  addStudent,
  barrierKit,
  botWorld,
  insertSession,
  publishedBot,
  rowOf,
  type BotWorld,
} from "./testing";

// Phase 08G-7A: the activation routing guard (owner decision OD-1) on a disposable al_ict_test_* database. Activate, Resume
// and Change Version must refuse, atomically and with ROUTING_CONFLICT, any resulting ACTIVE set of one account in which a
// first_message deployment precedes a keyword deployment or two deployments share a keyword; concurrent changes are
// serialized by the account's routing advisory lock. The flows are the 08G SYNTHETIC fixtures; nothing here sends.
// WRITTEN, NOT EXECUTED (needs owner-authorized isolated database validation).

type Key =
  | "staff_routing"
  | "payment_enquiry"
  | "registration_enquiry"
  | "class_info"
  | "general_info"
  | "student_enquiry";
const FLOWS: Record<Key, () => Json> = {
  staff_routing: staffRoutingFlow,
  payment_enquiry: paymentEnquiryFlow,
  registration_enquiry: registrationEnquiryFlow,
  class_info: classInfoFlow,
  general_info: generalInfoFlow,
  student_enquiry: enquiryFlow,
};
/** 08G-0 section 4: priority 1..6 in this order. */
const APPROVED: Key[] = [
  "staff_routing",
  "payment_enquiry",
  "registration_enquiry",
  "class_info",
  "general_info",
  "student_enquiry",
];

const codeOf = (e: unknown) => (e as BotControlError).code;
const reasonOf = (e: unknown) => (e as BotControlError).reason;

describe("activation routing guard (08G-7A)", () => {
  let t: TestDb;
  let info: MockInstance;
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
  });
  afterAll(async () => t.close());
  beforeEach(() => {
    info = vi.spyOn(logger, "info");
  });
  afterEach(() => vi.restoreAllMocks());

  const published = (w: BotWorld, key: Key, flow: Json = FLOWS[key]()) =>
    publishedBot(t.db, w, flow, key);
  const activate = (
    w: BotWorld,
    b: { bot: { id: string }; version: { id: string } },
    priority: number,
    accountId = w.account.id,
  ) =>
    activateDeployment(
      w.admin.ctx,
      { botId: b.bot.id, versionId: b.version.id, whatsappAccountId: accountId, priority },
      deps(),
    );
  async function deploy(w: BotWorld, key: Key, priority: number, accountId = w.account.id) {
    const b = await published(w, key);
    return { ...b, deployment: (await activate(w, b, priority, accountId)).value };
  }
  /** A new published version of `botId` with `flow` (the draft revision is 1 after publishedBot). */
  async function newVersion(w: BotWorld, botId: string, flow: Json, revision = 1) {
    await updateDraft(w.admin.ctx, { botId, expectedRevision: revision, config: flow }, deps());
    return (await publishVersion(w.admin.ctx, { botId, expectedRevision: revision + 1 }, deps()))
      .value;
  }
  /** Every durable trace of deployment changes in the organization (rows, statuses, versions, events). */
  const snapshot = async (w: BotWorld) => ({
    deployments: (
      await q(
        "select id, bot_id, version_id, status, priority, send_epoch, start_eligible_from from bot_deployments where organization_id = $1 order by id",
        [w.org.id],
      )
    ).rows,
    events: (
      await q(
        "select deployment_id, kind from bot_deployment_events where organization_id = $1 order by id",
        [w.org.id],
      )
    ).rows,
  });
  const audits = () =>
    info.mock.calls
      .filter((c) => c[0] === "bots.admin_action")
      .map((c) => (c[1] as { action: string }).action);

  it("the approved six-bot order activates through the production path; all six end ACTIVE at 1..6", async () => {
    const w = await botWorld(t.db);
    for (const [i, key] of APPROVED.entries()) await deploy(w, key, i + 1);
    expect(
      (
        await q(
          "select b.key, d.priority, d.status from bot_deployments d join bots b on b.id = d.bot_id where d.organization_id = $1 order by d.priority",
          [w.org.id],
        )
      ).rows,
    ).toEqual(APPROVED.map((key, i) => ({ key, priority: i + 1, status: "ACTIVE" })));
  });

  it("nonconflicting keyword deployments activate in any priority order", async () => {
    const w = await botWorld(t.db);
    await deploy(w, "general_info", 3);
    await deploy(w, "payment_enquiry", 9);
    await deploy(w, "class_info", 1);
    expect((await snapshot(w)).deployments).toHaveLength(3);
  });

  it("Student Enquiry ahead of a keyword deployment is refused either way round, atomically: no row, no event, no audit", async () => {
    const w = await botWorld(t.db);
    await deploy(w, "student_enquiry", 1);
    const pay = await published(w, "payment_enquiry");
    const before = await snapshot(w);
    info.mockClear();
    const e = await refused(activate(w, pay, 2));
    expect(codeOf(e)).toBe("ROUTING_CONFLICT");
    expect(reasonOf(e)).toBe("student_enquiry precedes payment_enquiry");
    expect(await snapshot(w)).toEqual(before);
    expect(audits()).toEqual([]);

    const v = await botWorld(t.db);
    await deploy(v, "payment_enquiry", 2);
    await deploy(v, "general_info", 3);
    const se = await published(v, "student_enquiry");
    const e2 = await refused(activate(v, se, 1));
    expect(reasonOf(e2)).toBe(
      "student_enquiry precedes payment_enquiry; student_enquiry precedes general_info",
    );
    expect((await snapshot(v)).deployments).toHaveLength(2);
  });

  it("a keyword shared (after normalization) with an active deployment is refused; the earlier deployment is untouched", async () => {
    const w = await botWorld(t.db);
    const gi = await deploy(w, "general_info", 5);
    const flow = paymentEnquiryFlow();
    flow.triggers = [{ kind: "keyword", words: ["pay", "FAQ"] }];
    const other = await published(w, "payment_enquiry", flow);
    const before = await snapshot(w);
    const e = await refused(activate(w, other, 2));
    expect(codeOf(e)).toBe("ROUTING_CONFLICT");
    expect(reasonOf(e)).toBe("payment_enquiry shares a keyword with general_info");
    expect(await snapshot(w)).toEqual(before);
    expect(before.deployments).toMatchObject([{ id: gi.deployment.id, status: "ACTIVE" }]);
  });

  it("the existing refusals keep their codes: a second deployment of the same bot is DEPLOYMENT_EXISTS, a taken priority PRIORITY_TAKEN", async () => {
    const w = await botWorld(t.db);
    const gi = await deploy(w, "general_info", 5);
    expect(codeOf(await refused(activate(w, gi, 6)))).toBe("DEPLOYMENT_EXISTS");
    const ci = await published(w, "class_info");
    expect(codeOf(await refused(activate(w, ci, 5)))).toBe("PRIORITY_TAKEN");
  });

  it("a paused deployment does not block an activation, but resuming it into a conflict is refused and it stays PAUSED", async () => {
    const w = await botWorld(t.db);
    const se = await deploy(w, "student_enquiry", 1);
    await pauseDeployment(w.admin.ctx, { deploymentId: se.deployment.id }, deps());
    await deploy(w, "payment_enquiry", 2); // SE is not ACTIVE: no conflict now
    const before = await snapshot(w);
    info.mockClear();
    const e = await refused(
      resumeDeployment(w.admin.ctx, { deploymentId: se.deployment.id }, deps()),
    );
    expect(codeOf(e)).toBe("ROUTING_CONFLICT");
    expect(reasonOf(e)).toBe("student_enquiry precedes payment_enquiry");
    expect(await snapshot(w)).toEqual(before); // still PAUSED, start_eligible_from and events unchanged
    expect(audits()).toEqual([]);
  });

  it("a version change that adds another bot's keyword, or a first_message trigger ahead of a keyword bot, is refused; the deployment keeps its version and its pinned session is byte-identical", async () => {
    const w = await botWorld(t.db);
    await deploy(w, "payment_enquiry", 2);
    const gi = await deploy(w, "general_info", 5);
    await deploy(w, "student_enquiry", 6);
    const student = await addStudent(t.db, w.org.id, w.account.id);
    const session = await insertSession(t.pool, {
      organizationId: w.org.id,
      botId: gi.bot.id,
      versionId: gi.version.id,
      deploymentId: gi.deployment.id,
      whatsappAccountId: w.account.id,
      student,
    });
    const pinned = await rowOf(t.pool, "bot_sessions", session.id as string);

    const sharing = generalInfoFlow();
    sharing.triggers = [{ kind: "keyword", words: ["info", "Pay"] }];
    const v2 = await newVersion(w, gi.bot.id, sharing, 1);
    const catchAll = generalInfoFlow();
    catchAll.triggers = [{ kind: "keyword", words: ["info"] }, { kind: "first_message" }];
    const v3 = await newVersion(w, gi.bot.id, catchAll, 2);

    const before = await snapshot(w);
    const e2 = await refused(
      changeDeploymentVersion(
        w.admin.ctx,
        { deploymentId: gi.deployment.id, versionId: v2.id },
        deps(),
      ),
    );
    expect([codeOf(e2), reasonOf(e2)]).toEqual([
      "ROUTING_CONFLICT",
      "payment_enquiry shares a keyword with general_info",
    ]);
    const e3 = await refused(
      changeDeploymentVersion(
        w.admin.ctx,
        { deploymentId: gi.deployment.id, versionId: v3.id },
        deps(),
      ),
    );
    expect([codeOf(e3), reasonOf(e3)]).toEqual([
      "ROUTING_CONFLICT",
      "general_info precedes student_enquiry",
    ]);
    expect(await snapshot(w)).toEqual(before);
    expect(await rowOf(t.pool, "bot_sessions", session.id as string)).toEqual(pinned);
  });

  it("a conflicting version may be pinned while PAUSED (it routes nothing), and the resume is then refused", async () => {
    const w = await botWorld(t.db);
    await deploy(w, "payment_enquiry", 2);
    const gi = await deploy(w, "general_info", 5);
    await pauseDeployment(w.admin.ctx, { deploymentId: gi.deployment.id }, deps());
    const sharing = generalInfoFlow();
    sharing.triggers = [{ kind: "keyword", words: ["info", "payment"] }];
    const v2 = await newVersion(w, gi.bot.id, sharing, 1);
    await changeDeploymentVersion(
      w.admin.ctx,
      { deploymentId: gi.deployment.id, versionId: v2.id },
      deps(),
    );
    const e = await refused(
      resumeDeployment(w.admin.ctx, { deploymentId: gi.deployment.id }, deps()),
    );
    expect(reasonOf(e)).toBe("payment_enquiry shares a keyword with general_info");
    expect(
      (await q("select status from bot_deployments where id = $1", [gi.deployment.id])).rows,
    ).toEqual([{ status: "PAUSED" }]);
  });

  it("conflicting configurations on another account of the organization, or in another organization, do not interfere", async () => {
    const w = await botWorld(t.db);
    const second = await seedAccount(t.db, w.org.id);
    await deploy(w, "student_enquiry", 1, second.id); // a catch-all first on the OTHER account of the organization
    const v = await botWorld(t.db);
    await deploy(v, "student_enquiry", 1); // and in another organization
    await deploy(w, "payment_enquiry", 2); // neither is part of this account's ACTIVE set
    await deploy(w, "general_info", 3);
    expect((await snapshot(w)).deployments).toHaveLength(3);
    // another organization can neither resume this organization's deployment nor learn that it exists
    const pay = (
      await q(
        "select d.id from bot_deployments d join bots b on b.id = d.bot_id where d.organization_id = $1 and b.key = 'payment_enquiry'",
        [w.org.id],
      )
    ).rows[0] as { id: string };
    expect(
      await refused(resumeDeployment(v.admin.ctx, { deploymentId: pay.id }, deps())),
    ).toBeInstanceOf(NotFoundError);
  });

  // ------------------------------------------------------------------------------------------------ concurrency

  it("the guard's serialization argument holds here: transactions opened by the services' database run READ COMMITTED", async () => {
    // write() (common.ts) opens a plain db.transaction() and inherits the connection's level; the routing argument needs
    // READ COMMITTED (the second operation's re-read must see the first one's commit). Asserted, never assumed.
    const level = await t.db.transaction(
      async (tx) =>
        (
          await tx.execute<{ level: string }>(
            sql`select current_setting('transaction_isolation') as level`,
          )
        ).rows[0]!.level,
    );
    expect(level).toBe("read committed");
    expect((await q("show default_transaction_isolation")).rows).toEqual([
      { default_transaction_isolation: "read committed" },
    ]);
  });

  /**
   * Parks `first` on `gateBotId` (the bot row it locks right AFTER the routing lock), starts `second`, and proves by lock
   * ownership (pg_blocking_pids, no sleeps) that `second` is blocked by `first`'s backend, i.e. by the routing lock both
   * share; then lets both finish. Returns [first, second] settled.
   */
  async function race(
    gateBotId: string,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ) {
    const { settle, hold, waitUntilBlocked, blockersOf, cleanup } = barrierKit(t);
    try {
      const gate = await hold("select id from bots where id = $1 for update", [gateBotId]);
      const a = settle(first());
      const firstPid = await waitUntilBlocked(gate.pid);
      const b = settle(second());
      const secondPid = await waitUntilBlocked(firstPid);
      expect(await blockersOf(secondPid)).toEqual([firstPid]);
      await gate.release();
      return await Promise.all([a, b]);
    } finally {
      await cleanup();
    }
  }
  const activeRows = async (w: BotWorld) =>
    (
      await q(
        "select b.key, d.priority, d.status from bot_deployments d join bots b on b.id = d.bot_id where d.organization_id = $1 and d.status = 'ACTIVE' order by d.priority",
        [w.org.id],
      )
    ).rows as Array<{ key: Key; priority: number; status: string }>;
  const eventKinds = async (w: BotWorld) =>
    (
      await q(
        "select b.key, e.kind from bot_deployment_events e join bots b on b.id = e.bot_id where e.organization_id = $1 order by e.id",
        [w.org.id],
      )
    ).rows;
  /** The final ACTIVE set satisfies the production routing rule. */
  async function expectValidActiveSet(w: BotWorld) {
    const rows = (
      await q(
        `select b.key, d.priority, v.config from bot_deployments d join bots b on b.id = d.bot_id
           join bot_versions v on v.id = d.version_id where d.organization_id = $1 and d.status = 'ACTIVE'`,
        [w.org.id],
      )
    ).rows as Array<{ key: string; priority: number; config: unknown }>;
    expect(
      routingConflicts(
        rows.map((r) => ({
          key: r.key,
          priority: r.priority,
          triggers: (validateFlow(r.config).config as FlowConfig).triggers,
        })),
      ),
    ).toEqual([]);
  }

  it("two concurrent activations that are each valid alone but conflict together: the second waits on the first's routing lock, then is refused; exactly one commits", async () => {
    const w = await botWorld(t.db);
    const pay = await published(w, "payment_enquiry");
    const se = await published(w, "student_enquiry");
    const [a, b] = await race(
      pay.bot.id,
      () => activate(w, pay, 2),
      () => activate(w, se, 1),
    );
    expect(a.ok).toBe(true);
    expect(b.ok ? null : [codeOf(b.error), reasonOf(b.error)]).toEqual([
      "ROUTING_CONFLICT",
      "student_enquiry precedes payment_enquiry",
    ]);
    expect(await activeRows(w)).toEqual([
      { key: "payment_enquiry", priority: 2, status: "ACTIVE" },
    ]);
  });

  it("P2 regression: lower- and upper-case spellings of ONE account meet on the same routing lock; the second activation waits, sees the commit and is refused; nothing of it remains", async () => {
    const w = await botWorld(t.db);
    const lower = w.account.id.toLowerCase();
    const upper = w.account.id.toUpperCase();
    expect(upper).not.toBe(lower);
    const pay = await published(w, "payment_enquiry");
    const se = await published(w, "student_enquiry");
    info.mockClear();
    const [a, b] = await race(
      pay.bot.id,
      () => activate(w, pay, 2, lower),
      () => activate(w, se, 1, upper),
    );
    expect(a.ok).toBe(true);
    expect(b.ok ? null : [codeOf(b.error), reasonOf(b.error)]).toEqual([
      "ROUTING_CONFLICT",
      "student_enquiry precedes payment_enquiry",
    ]);
    expect(await activeRows(w)).toEqual([
      { key: "payment_enquiry", priority: 2, status: "ACTIVE" },
    ]);
    expect(
      (await q("select count(*)::int n from bot_deployments where bot_id = $1", [se.bot.id])).rows,
    ).toEqual([{ n: 0 }]);
    expect(await eventKinds(w)).toEqual([{ key: "payment_enquiry", kind: "ACTIVATED" }]);
    expect(audits()).toEqual(["bot.deployment_activated"]);
    await expectValidActiveSet(w);
  });

  for (const resumeFirst of [true, false])
    it(
      resumeFirst
        ? "P2 regression: a Resume (stored account id) holding the routing lock blocks an upper-case activation of the same account, which then sees the resumed deployment and is refused"
        : "P2 regression: an upper-case activation holding the routing lock blocks a Resume (stored account id) of the same account, which then sees the activation and is refused",
      async () => {
        const w = await botWorld(t.db);
        const se = await deploy(w, "student_enquiry", 1);
        await pauseDeployment(w.admin.ctx, { deploymentId: se.deployment.id }, deps());
        const pay = await published(w, "payment_enquiry");
        const upper = w.account.id.toUpperCase();
        const resume = () =>
          resumeDeployment(w.admin.ctx, { deploymentId: se.deployment.id }, deps());
        const activation = () => activate(w, pay, 2, upper);
        info.mockClear();
        const [first, second] = resumeFirst
          ? await race(se.bot.id, resume, activation) // Resume locks the SE bot right after the routing lock
          : await race(pay.bot.id, activation, resume);
        expect(first.ok).toBe(true);
        expect(second.ok ? null : [codeOf(second.error), reasonOf(second.error)]).toEqual([
          "ROUTING_CONFLICT",
          "student_enquiry precedes payment_enquiry",
        ]);
        expect(await activeRows(w)).toEqual(
          resumeFirst
            ? [{ key: "student_enquiry", priority: 1, status: "ACTIVE" }]
            : [{ key: "payment_enquiry", priority: 2, status: "ACTIVE" }],
        );
        expect(audits()).toEqual([
          resumeFirst ? "bot.deployment_resumed" : "bot.deployment_activated",
        ]);
        if (resumeFirst)
          expect(
            (await q("select count(*)::int n from bot_deployments where bot_id = $1", [pay.bot.id]))
              .rows,
          ).toEqual([{ n: 0 }]);
        else
          expect(
            (await q("select status from bot_deployments where id = $1", [se.deployment.id])).rows,
          ).toEqual([{ status: "PAUSED" }]);
        await expectValidActiveSet(w);
      },
    );
});
