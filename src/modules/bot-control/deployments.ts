import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@/db";
import { BOT_LIVE_SESSION_STATES } from "@/db/schema/enums";
import type { AccessContext } from "@/modules/access";
import { NotFoundError } from "@/shared/errors/http-errors";
import {
  UNIQUE_VIOLATION,
  audit,
  pgCode,
  pgConstraint,
  reader,
  write,
  type BotControlDeps,
  type Tx,
  type WriteOptions,
  type Written,
} from "./common";
import { lockBot } from "./drafts";
import {
  holdLockedAndCount,
  lockSuppressionCandidates,
  type SuppressionCounts,
} from "./suppression";
import { BotControlError } from "./errors";
import {
  activateSchema,
  changeVersionSchema,
  deploymentSchema,
  emergencyStopSchema,
  parse,
  retireSchema,
  stopSessionsSchema,
} from "./schemas";

// Deployment lifecycle (V3.2 F.2-F.4, K.3, K.4; ADR 0019). Every operation runs the approved authorization sequence (common.ts)
// and then takes domain locks in the L.2 order: admin operations lock the bot, then the deployment; Stop / Emergency Stop /
// Retire lock the deployments (id order), the conversations of their live sessions (id order), then the sessions (id order).
// The database guard enforces the epoch, RETIRED and binding rules whatever the caller does, and stamps the times.
//
// Phase 08D: after handing the live sessions over, Stop / Emergency Stop / Retire suppress the deployments' QUEUED BOT
// requests (live sessions' and terminal notices alike) through the non-blocking primitive of suppression.ts (FOR UPDATE SKIP
// LOCKED; never waits on a request row), hold code `bot_stopped` for all three (the event kind tells them apart), and record
// requests_suppressed and requests_in_flight on the deployment event (semantics in schema/bots.ts and ADR 0020).

type Deployment = typeof schema.botDeployments.$inferSelect;

export type DeploymentSummary = Pick<
  Deployment,
  | "id"
  | "botId"
  | "whatsappAccountId"
  | "versionId"
  | "status"
  | "priority"
  | "sendEpoch"
  | "startEligibleFrom"
  | "statusChangedAt"
  | "activatedAt"
>;

const summaryColumns = {
  id: schema.botDeployments.id,
  botId: schema.botDeployments.botId,
  whatsappAccountId: schema.botDeployments.whatsappAccountId,
  versionId: schema.botDeployments.versionId,
  status: schema.botDeployments.status,
  priority: schema.botDeployments.priority,
  sendEpoch: schema.botDeployments.sendEpoch,
  startEligibleFrom: schema.botDeployments.startEligibleFrom,
  statusChangedAt: schema.botDeployments.statusChangedAt,
  activatedAt: schema.botDeployments.activatedAt,
};

type EventInput = {
  readonly deployment: DeploymentSummary;
  readonly kind: (typeof schema.botDeploymentEvents.$inferInsert)["kind"];
  readonly fromStatus: Deployment["status"] | null;
  readonly fromVersionId?: string | null;
  readonly sessionsAffected?: number;
  readonly requestsSuppressed?: number;
  readonly requestsInFlight?: number;
};

async function recordEvent(tx: Tx, ctx: AccessContext, e: EventInput): Promise<void> {
  await tx.insert(schema.botDeploymentEvents).values({
    organizationId: ctx.organizationId,
    deploymentId: e.deployment.id,
    whatsappAccountId: e.deployment.whatsappAccountId,
    botId: e.deployment.botId,
    kind: e.kind,
    actorMembershipId: ctx.membershipId,
    fromVersionId: e.fromVersionId ?? null,
    toVersionId: e.deployment.versionId,
    fromStatus: e.fromStatus,
    toStatus: e.deployment.status,
    sendEpoch: e.deployment.sendEpoch,
    sessionsAffected: e.sessionsAffected ?? 0,
    requestsSuppressed: e.requestsSuppressed ?? 0,
    requestsInFlight: e.requestsInFlight ?? 0,
  });
}

/** The deployment's bot, by a plain read (the binding never changes), so the bot can be locked before the deployment. */
async function botOf(tx: Tx, organizationId: string, deploymentId: string): Promise<string> {
  const [row] = await tx
    .select({ botId: schema.botDeployments.botId })
    .from(schema.botDeployments)
    .where(
      and(
        eq(schema.botDeployments.organizationId, organizationId),
        eq(schema.botDeployments.id, deploymentId),
      ),
    );
  if (!row) throw new NotFoundError();
  return row.botId;
}

async function lockDeployment(tx: Tx, organizationId: string, deploymentId: string) {
  const [row] = await tx
    .select(summaryColumns)
    .from(schema.botDeployments)
    .where(
      and(
        eq(schema.botDeployments.organizationId, organizationId),
        eq(schema.botDeployments.id, deploymentId),
      ),
    )
    .for("update");
  if (!row) throw new NotFoundError();
  return row;
}

/** Admin path of L.2: bot, then deployment. */
async function lockForAdmin(tx: Tx, organizationId: string, deploymentId: string) {
  await lockBot(tx, organizationId, await botOf(tx, organizationId, deploymentId));
  return lockDeployment(tx, organizationId, deploymentId);
}

async function updateDeployment(
  tx: Tx,
  organizationId: string,
  id: string,
  set: Partial<Pick<Deployment, "status" | "versionId">> & { bumpEpoch?: boolean },
): Promise<DeploymentSummary> {
  const { bumpEpoch, ...columns } = set;
  const [row] = await tx
    .update(schema.botDeployments)
    .set({
      ...columns,
      ...(bumpEpoch ? { sendEpoch: sql`${schema.botDeployments.sendEpoch} + 1` } : {}),
    })
    .where(
      and(
        eq(schema.botDeployments.organizationId, organizationId),
        eq(schema.botDeployments.id, id),
      ),
    )
    .returning(summaryColumns);
  return row!;
}

const refuseTransition = (status: string) =>
  new BotControlError(
    "INVALID_TRANSITION",
    "The deployment is not in a state that allows this.",
    status,
  );

export async function activateDeployment(
  ctx: AccessContext,
  raw: unknown,
  deps: BotControlDeps = {},
  options: WriteOptions = {},
): Promise<Written<DeploymentSummary>> {
  const input = parse(activateSchema, raw);
  try {
    const written = await write(ctx, "bot.publish", deps, options, async (tx) => {
      const bot = await lockBot(tx, ctx.organizationId, input.botId);
      const [version] = await tx
        .select({ id: schema.botVersions.id })
        .from(schema.botVersions)
        .where(
          and(
            eq(schema.botVersions.organizationId, ctx.organizationId),
            eq(schema.botVersions.botId, bot.id),
            eq(schema.botVersions.id, input.versionId),
          ),
        );
      const [account] = await tx
        .select({ id: schema.whatsappAccounts.id })
        .from(schema.whatsappAccounts)
        .where(
          and(
            eq(schema.whatsappAccounts.organizationId, ctx.organizationId),
            eq(schema.whatsappAccounts.id, input.whatsappAccountId),
          ),
        );
      if (!version || !account) throw new NotFoundError();
      const [row] = await tx
        .insert(schema.botDeployments)
        .values({
          organizationId: ctx.organizationId,
          whatsappAccountId: account.id,
          botId: bot.id,
          versionId: version.id,
          priority: input.priority,
        })
        .returning(summaryColumns);
      await recordEvent(tx, ctx, { deployment: row!, kind: "ACTIVATED", fromStatus: null });
      return row!;
    });
    if (written.applied)
      audit("bot.deployment_activated", ctx, {
        deployment_id: written.value.id,
        bot_id: written.value.botId,
        version_id: written.value.versionId,
      });
    return written;
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) {
      const constraint = pgConstraint(error);
      if (constraint === "bot_deployments_account_bot_uidx")
        throw new BotControlError(
          "DEPLOYMENT_EXISTS",
          "This bot is already deployed on this account (resume it or change its version).",
        );
      if (constraint === "bot_deployments_account_priority_uidx")
        throw new BotControlError(
          "PRIORITY_TAKEN",
          "Another deployment on this account has this priority.",
        );
    }
    throw error;
  }
}

/** Re-points the deployment to another version of its bot. The epoch does not change: pinned sessions can finish. */
export async function changeDeploymentVersion(
  ctx: AccessContext,
  raw: unknown,
  deps: BotControlDeps = {},
  options: WriteOptions = {},
): Promise<Written<DeploymentSummary>> {
  const input = parse(changeVersionSchema, raw);
  const written = await write(ctx, "bot.publish", deps, options, async (tx) => {
    const current = await lockForAdmin(tx, ctx.organizationId, input.deploymentId);
    if (current.status === "RETIRED") throw refuseTransition(current.status);
    if (current.versionId === input.versionId)
      throw new BotControlError("SAME_VERSION", "The deployment already runs this version.");
    const [version] = await tx
      .select({ id: schema.botVersions.id })
      .from(schema.botVersions)
      .where(
        and(
          eq(schema.botVersions.organizationId, ctx.organizationId),
          eq(schema.botVersions.botId, current.botId),
          eq(schema.botVersions.id, input.versionId),
        ),
      );
    if (!version) throw new NotFoundError();
    const row = await updateDeployment(tx, ctx.organizationId, current.id, {
      versionId: version.id,
    });
    await recordEvent(tx, ctx, {
      deployment: row,
      kind: "VERSION_CHANGED",
      fromStatus: current.status,
      fromVersionId: current.versionId,
    });
    return row;
  });
  if (written.applied)
    audit("bot.deployment_version_changed", ctx, {
      deployment_id: written.value.id,
      version_id: written.value.versionId,
    });
  return written;
}

/** Pause New Sessions (= graceful drain): existing sessions continue. */
export async function pauseDeployment(
  ctx: AccessContext,
  raw: unknown,
  deps: BotControlDeps = {},
  options: WriteOptions = {},
): Promise<Written<DeploymentSummary>> {
  const input = parse(deploymentSchema, raw);
  const written = await write(ctx, "bot.publish", deps, options, async (tx) => {
    const current = await lockForAdmin(tx, ctx.organizationId, input.deploymentId);
    if (current.status !== "ACTIVE") throw refuseTransition(current.status);
    const row = await updateDeployment(tx, ctx.organizationId, current.id, { status: "PAUSED" });
    await recordEvent(tx, ctx, { deployment: row, kind: "PAUSED", fromStatus: current.status });
    return row;
  });
  if (written.applied) audit("bot.deployment_paused", ctx, { deployment_id: written.value.id });
  return written;
}

/** Resume (from PAUSED or STOPPED): the database restarts `start_eligible_from`, so older triggers never start a session. */
export async function resumeDeployment(
  ctx: AccessContext,
  raw: unknown,
  deps: BotControlDeps = {},
  options: WriteOptions = {},
): Promise<Written<DeploymentSummary>> {
  const input = parse(deploymentSchema, raw);
  const written = await write(ctx, "bot.publish", deps, options, async (tx) => {
    const current = await lockForAdmin(tx, ctx.organizationId, input.deploymentId);
    if (current.status !== "PAUSED" && current.status !== "STOPPED")
      throw refuseTransition(current.status);
    const row = await updateDeployment(tx, ctx.organizationId, current.id, { status: "ACTIVE" });
    await recordEvent(tx, ctx, { deployment: row, kind: "RESUMED", fromStatus: current.status });
    return row;
  });
  if (written.applied) audit("bot.deployment_resumed", ctx, { deployment_id: written.value.id });
  return written;
}

// ------------------------------------------------------------------------------------------------- Stop, Emergency, Retire

const LIVE = [...BOT_LIVE_SESSION_STATES];

/**
 * Hands over every live session of the (already locked) deployments: conversations FOR UPDATE in id order, then sessions FOR
 * UPDATE in id order (L.2), then one update to HANDED_OVER (`system_handover`, `operator_stop`) with output suppressed. The
 * database allocates each session's `handover_control_seq` on the conversation row already held and stamps `ended_at`; a
 * system ending never carries a terminal notice. No new session can start meanwhile: a start takes the deployment FOR SHARE.
 * Returns the number of sessions handed over per deployment.
 */
async function handOverLiveSessions(
  tx: Tx,
  organizationId: string,
  deploymentIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(deploymentIds.map((id) => [id, 0]));
  if (deploymentIds.length === 0) return counts;
  const live = and(
    eq(schema.botSessions.organizationId, organizationId),
    inArray(schema.botSessions.deploymentId, [...deploymentIds]),
    inArray(schema.botSessions.state, LIVE),
  );
  const found = await tx
    .select({ id: schema.botSessions.id, conversationId: schema.botSessions.conversationId })
    .from(schema.botSessions)
    .where(live);
  if (found.length === 0) return counts;
  const conversationIds = [...new Set(found.map((s) => s.conversationId))].sort();
  await tx
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.organizationId, organizationId),
        inArray(schema.conversations.id, conversationIds),
      ),
    )
    .orderBy(asc(schema.conversations.id))
    .for("update");
  const sessions = await tx
    .select({ id: schema.botSessions.id })
    .from(schema.botSessions)
    .where(
      and(
        live,
        inArray(
          schema.botSessions.id,
          found.map((s) => s.id),
        ),
      ),
    )
    .orderBy(asc(schema.botSessions.id))
    .for("update");
  if (sessions.length === 0) return counts;
  const ended = await tx
    .update(schema.botSessions)
    .set({
      state: "HANDED_OVER",
      endReason: "system_handover",
      handoverReason: "operator_stop",
      outputSuppressedAt: sql`coalesce(${schema.botSessions.outputSuppressedAt}, clock_timestamp())`,
      awaiting: null,
      awaitingToken: null,
      expiresAt: null,
      sendWaitExpiresAt: null,
      revision: sql`${schema.botSessions.revision} + 1`,
    })
    .where(
      and(
        eq(schema.botSessions.organizationId, organizationId),
        inArray(
          schema.botSessions.id,
          sessions.map((s) => s.id),
        ),
      ),
    )
    .returning({
      id: schema.botSessions.id,
      conversationId: schema.botSessions.conversationId,
      deploymentId: schema.botSessions.deploymentId,
    });
  await tx.insert(schema.botSessionEvents).values(
    ended.map((s) => ({
      organizationId,
      sessionId: s.id,
      conversationId: s.conversationId,
      kind: "HANDED_OVER" as const,
      code: "operator_stop",
    })),
  );
  for (const s of ended) counts.set(s.deploymentId, (counts.get(s.deploymentId) ?? 0) + 1);
  return counts;
}

async function countLive(tx: Tx, organizationId: string, deploymentId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.botSessions)
    .where(
      and(
        eq(schema.botSessions.organizationId, organizationId),
        eq(schema.botSessions.deploymentId, deploymentId),
        inArray(schema.botSessions.state, LIVE),
      ),
    );
  return row?.n ?? 0;
}

/** The hold code of Stop, Emergency Stop and Retire suppression (O3: one code; the deployment event kind tells them apart). */
export const STOP_HOLD_CODE = "bot_stopped";

/** The suppression primitive on this transaction (or, in the concurrency regression only, its barrier-driven first statement). */
async function suppress(
  tx: Tx,
  deps: BotControlDeps,
  organizationId: string,
  deploymentIds: readonly string[],
): Promise<SuppressionCounts> {
  const lock = deps.lockSuppressionCandidates ?? lockSuppressionCandidates;
  const locked = await lock(tx, organizationId, deploymentIds);
  return holdLockedAndCount(tx, organizationId, deploymentIds, locked, STOP_HOLD_CODE);
}

const mismatch = () =>
  new BotControlError(
    "CONFIRMATION_MISMATCH",
    "The confirmation does not match the current state. Preview again.",
  );

export type StopResult = {
  readonly deployment: DeploymentSummary;
  readonly sessionsStopped: number;
  readonly requestsSuppressed: number;
  readonly requestsInFlight: number;
};

/** Stop Active Sessions (per deployment): PAUSED, epoch bumped, every live session handed over with output suppressed. */
export async function stopActiveSessions(
  ctx: AccessContext,
  raw: unknown,
  deps: BotControlDeps = {},
  options: WriteOptions = {},
): Promise<Written<StopResult>> {
  const input = parse(stopSessionsSchema, raw);
  const written = await write(ctx, "bot.publish", deps, options, async (tx) => {
    const current = await lockDeployment(tx, ctx.organizationId, input.deploymentId);
    if (current.status !== "ACTIVE" && current.status !== "PAUSED")
      throw refuseTransition(current.status);
    if ((await countLive(tx, ctx.organizationId, current.id)) !== input.expectedLiveSessions)
      throw mismatch();
    const counts = await handOverLiveSessions(tx, ctx.organizationId, [current.id]);
    const suppression = await suppress(tx, deps, ctx.organizationId, [current.id]);
    const row = await updateDeployment(tx, ctx.organizationId, current.id, {
      status: "PAUSED",
      bumpEpoch: true,
    });
    const sessionsStopped = counts.get(current.id) ?? 0;
    const requestsSuppressed = suppression.suppressed.get(current.id) ?? 0;
    const requestsInFlight = suppression.inFlight.get(current.id) ?? 0;
    await recordEvent(tx, ctx, {
      deployment: row,
      kind: "SESSIONS_STOPPED",
      fromStatus: current.status,
      sessionsAffected: sessionsStopped,
      requestsSuppressed,
      requestsInFlight,
    });
    return { deployment: row, sessionsStopped, requestsSuppressed, requestsInFlight };
  });
  if (written.applied)
    audit("bot.sessions_stopped", ctx, {
      deployment_id: written.value.deployment.id,
      sessions_affected: written.value.sessionsStopped,
      requests_suppressed: written.value.requestsSuppressed,
      requests_in_flight: written.value.requestsInFlight,
    });
  return written;
}

/** Retirement (terminal): live sessions are stopped first, in the same transaction; the deployment becomes RETIRED. */
export async function retireDeployment(
  ctx: AccessContext,
  raw: unknown,
  deps: BotControlDeps = {},
  options: WriteOptions = {},
): Promise<Written<StopResult>> {
  const input = parse(retireSchema, raw);
  const written = await write(ctx, "bot.publish", deps, options, async (tx) => {
    const current = await lockDeployment(tx, ctx.organizationId, input.deploymentId);
    if (current.status === "RETIRED") throw refuseTransition(current.status);
    const [bot] = await tx
      .select({ key: schema.bots.key })
      .from(schema.bots)
      .where(
        and(eq(schema.bots.organizationId, ctx.organizationId), eq(schema.bots.id, current.botId)),
      );
    if (bot?.key !== input.confirmBotKey) throw mismatch();
    if ((await countLive(tx, ctx.organizationId, current.id)) !== input.expectedLiveSessions)
      throw mismatch();
    const counts = await handOverLiveSessions(tx, ctx.organizationId, [current.id]);
    const suppression = await suppress(tx, deps, ctx.organizationId, [current.id]);
    const row = await updateDeployment(tx, ctx.organizationId, current.id, {
      status: "RETIRED",
      bumpEpoch: true,
    });
    const sessionsStopped = counts.get(current.id) ?? 0;
    const requestsSuppressed = suppression.suppressed.get(current.id) ?? 0;
    const requestsInFlight = suppression.inFlight.get(current.id) ?? 0;
    await recordEvent(tx, ctx, {
      deployment: row,
      kind: "RETIRED",
      fromStatus: current.status,
      sessionsAffected: sessionsStopped,
      requestsSuppressed,
      requestsInFlight,
    });
    return { deployment: row, sessionsStopped, requestsSuppressed, requestsInFlight };
  });
  if (written.applied)
    audit("bot.deployment_retired", ctx, {
      deployment_id: written.value.deployment.id,
      sessions_affected: written.value.sessionsStopped,
      requests_suppressed: written.value.requestsSuppressed,
      requests_in_flight: written.value.requestsInFlight,
    });
  return written;
}

export type EmergencyStopResult = {
  readonly deployments: readonly DeploymentSummary[];
  readonly sessionsStopped: number;
  readonly requestsSuppressed: number;
  readonly requestsInFlight: number;
};

/** Emergency Stop: every ACTIVE / PAUSED deployment of the organization (optionally one account) STOPPED, epochs bumped. */
export async function emergencyStop(
  ctx: AccessContext,
  raw: unknown,
  deps: BotControlDeps = {},
  options: WriteOptions = {},
): Promise<Written<EmergencyStopResult>> {
  const input = parse(emergencyStopSchema, raw);
  const written = await write(ctx, "bot.emergency_stop", deps, options, async (tx) => {
    const targets = await tx
      .select(summaryColumns)
      .from(schema.botDeployments)
      .where(
        and(
          eq(schema.botDeployments.organizationId, ctx.organizationId),
          inArray(schema.botDeployments.status, ["ACTIVE", "PAUSED"]),
          input.whatsappAccountId === undefined
            ? undefined
            : eq(schema.botDeployments.whatsappAccountId, input.whatsappAccountId),
        ),
      )
      .orderBy(asc(schema.botDeployments.id))
      .for("update");
    if (targets.length !== input.expectedDeployments) throw mismatch();
    const ids = targets.map((d) => d.id);
    const counts = await handOverLiveSessions(tx, ctx.organizationId, ids);
    const suppression = await suppress(tx, deps, ctx.organizationId, ids);
    const stopped: DeploymentSummary[] = [];
    for (const current of targets) {
      const row = await updateDeployment(tx, ctx.organizationId, current.id, {
        status: "STOPPED",
        bumpEpoch: true,
      });
      await recordEvent(tx, ctx, {
        deployment: row,
        kind: "STOPPED",
        fromStatus: current.status,
        sessionsAffected: counts.get(current.id) ?? 0,
        requestsSuppressed: suppression.suppressed.get(current.id) ?? 0,
        requestsInFlight: suppression.inFlight.get(current.id) ?? 0,
      });
      stopped.push(row);
    }
    const sum = (m: ReadonlyMap<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    return {
      deployments: stopped,
      sessionsStopped: sum(counts),
      requestsSuppressed: sum(suppression.suppressed),
      requestsInFlight: sum(suppression.inFlight),
    };
  });
  if (written.applied)
    audit("bot.emergency_stop", ctx, {
      deployments_affected: written.value.deployments.length,
      sessions_affected: written.value.sessionsStopped,
      requests_suppressed: written.value.requestsSuppressed,
      requests_in_flight: written.value.requestsInFlight,
      whatsapp_account_id: input.whatsappAccountId ?? null,
    });
  return written;
}

export async function listDeployments(
  ctx: AccessContext,
  deps: BotControlDeps = {},
): Promise<DeploymentSummary[]> {
  const db = reader(ctx, deps);
  return db
    .select(summaryColumns)
    .from(schema.botDeployments)
    .where(eq(schema.botDeployments.organizationId, ctx.organizationId))
    .orderBy(asc(schema.botDeployments.whatsappAccountId), asc(schema.botDeployments.priority));
}

/** The live-session count of a deployment: the preview a Stop or Retire confirmation must match. */
export async function liveSessionCount(
  ctx: AccessContext,
  deploymentId: string,
  deps: BotControlDeps = {},
): Promise<number> {
  const db = reader(ctx, deps);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.botSessions)
    .where(
      and(
        eq(schema.botSessions.organizationId, ctx.organizationId),
        eq(schema.botSessions.deploymentId, deploymentId),
        inArray(schema.botSessions.state, LIVE),
      ),
    );
  return row?.n ?? 0;
}
