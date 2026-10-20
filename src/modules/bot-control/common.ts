import { getDb, type Database } from "@/db";
import {
  assertCan,
  lockAndRevalidateActor,
  type AccessContext,
  type Permission,
} from "@/modules/access";
import { logger } from "@/shared/logging/logger";

// Shared plumbing of every bot-management write (Phase 08C, ADR 0019).

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Dependency injection for tests; production uses the lazy default database. */
export type BotControlDeps = {
  readonly db?: Database;
  /**
   * TEST ONLY (the Phase 08D concurrency regression's barrier): replaces the first statement of the suppression primitive with
   * an equivalent that can be paused between rows. Production never passes it (pinned by a static test).
   */
  readonly lockSuppressionCandidates?: (
    tx: Tx,
    organizationId: string,
    deploymentIds: readonly string[],
  ) => Promise<string[]>;
};

export type WriteOptions = {
  /** Run every check and the whole change, then roll it back (operator dry run). Default false. */
  readonly dryRun?: boolean;
};

export type Written<T> = { readonly applied: boolean; readonly value: T };

class DryRunRollback {
  constructor(readonly value: unknown) {}
}

/**
 * The approved authorization sequence (ADR 0019, plan section C): `assertCan` fails fast; then, inside ONE transaction, the
 * organization (FOR KEY SHARE) and the actor's membership (FOR SHARE) are locked and the actor is re-validated from that locked
 * row BEFORE `work` takes any domain lock. A revocation that committed first is seen and refused; one that comes later waits
 * for this transaction. A dry run performs everything and rolls it back.
 */
export async function write<T>(
  ctx: AccessContext,
  permission: Permission,
  deps: BotControlDeps,
  options: WriteOptions,
  work: (tx: Tx) => Promise<T>,
): Promise<Written<T>> {
  assertCan(ctx, permission);
  const db = deps.db ?? getDb();
  try {
    const value = await db.transaction(async (tx) => {
      await lockAndRevalidateActor(tx, ctx, permission);
      const v = await work(tx);
      if (options.dryRun === true) throw new DryRunRollback(v);
      return v;
    });
    return { applied: true, value };
  } catch (error) {
    if (error instanceof DryRunRollback) return { applied: false, value: error.value as T };
    throw error;
  }
}

/** Read-only operations: the permission check, then plain organization-scoped reads. */
export function reader(ctx: AccessContext, deps: BotControlDeps): Database {
  assertCan(ctx, "bot.read");
  return deps.db ?? getDb();
}

/**
 * The audit line of a committed bot-management change. Ids, codes and counts only: never configuration text, flow wording,
 * variable values or student content. Deployment operations are also recorded durably in bot_deployment_events; drafts
 * and publications are recorded durably on their own rows (draft_updated_by / draft_revision, published_by / published_at).
 */
export function audit(
  action: string,
  ctx: AccessContext,
  fields: Record<string, string | number | null>,
): void {
  logger.info("bots.admin_action", {
    action,
    organization_id: ctx.organizationId,
    membership_id: ctx.membershipId,
    ...fields,
  });
}

/** The SQLSTATE of a database error (drizzle wraps the driver error as `cause`), or null. */
export function pgCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The constraint a database error names (unique and foreign-key violations), or null. */
export function pgConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const name = (current as { constraint?: unknown }).constraint;
    if (typeof name === "string") return name;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export const UNIQUE_VIOLATION = "23505";
