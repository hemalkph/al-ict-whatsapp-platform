import { and, asc, eq, sql } from "drizzle-orm";
import { schema } from "@/db";
import type { AccessContext } from "@/modules/access";
import { FLOW_LIMITS, checkJsonShape, validateFlow, type Diagnostic } from "@/modules/bots";
import { canonicalJson } from "@/shared/canonical-json";
import { NotFoundError } from "@/shared/errors/http-errors";
import {
  UNIQUE_VIOLATION,
  audit,
  pgCode,
  reader,
  write,
  type BotControlDeps,
  type Tx,
  type WriteOptions,
  type Written,
} from "./common";
import { BotControlError } from "./errors";
import { createBotSchema, parse, updateDraftSchema } from "./schemas";

// Bots and their one mutable draft (V3.2 F.1, K.1; ADR 0019). A draft is stored as the canonical (RFC 8785) JSON text of
// what the editor saved: the exact bytes the 65,536-byte contract limit measures. It need not be a valid flow yet; publishing
// validates it.

const UTF8 = new TextEncoder();

/** Canonical text of a draft, or DRAFT_INVALID (not JSON, too deep, or over the contract's canonical byte limit). */
export function draftCanonical(config: unknown): string {
  const shape = checkJsonShape(config);
  if (shape !== "ok")
    throw new BotControlError("DRAFT_INVALID", "The draft is not acceptable JSON.", shape);
  const text = canonicalJson(config);
  if (UTF8.encode(text).byteLength > FLOW_LIMITS.configBytesMax)
    throw new BotControlError(
      "DRAFT_INVALID",
      "The draft is not acceptable JSON.",
      "CONFIG_TOO_LARGE",
    );
  return text;
}

/** Locks one bot of the organization FOR UPDATE (another organization's bot is the same 404 as a missing one). */
export async function lockBot(tx: Tx, organizationId: string, botId: string) {
  const [bot] = await tx
    .select({
      id: schema.bots.id,
      key: schema.bots.key,
      draftConfigCanonical: schema.bots.draftConfigCanonical,
      draftRevision: schema.bots.draftRevision,
    })
    .from(schema.bots)
    .where(and(eq(schema.bots.organizationId, organizationId), eq(schema.bots.id, botId)))
    .for("update");
  if (!bot) throw new NotFoundError();
  return bot;
}

export type BotSummary = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly draftRevision: number;
  readonly hasDraft: boolean;
  readonly draftUpdatedAt: Date | null;
  readonly createdAt: Date;
};

const summaryColumns = {
  id: schema.bots.id,
  key: schema.bots.key,
  name: schema.bots.name,
  description: schema.bots.description,
  draftRevision: schema.bots.draftRevision,
  draftConfigCanonical: schema.bots.draftConfigCanonical,
  draftUpdatedAt: schema.bots.draftUpdatedAt,
  createdAt: schema.bots.createdAt,
};

type SummaryRow = Omit<BotSummary, "hasDraft"> & { readonly draftConfigCanonical: string | null };

const toSummary = ({ draftConfigCanonical, ...row }: SummaryRow): BotSummary => ({
  id: row.id,
  key: row.key,
  name: row.name,
  description: row.description,
  draftRevision: row.draftRevision,
  hasDraft: draftConfigCanonical !== null,
  draftUpdatedAt: row.draftUpdatedAt,
  createdAt: row.createdAt,
});

export async function createBot(
  ctx: AccessContext,
  raw: unknown,
  deps: BotControlDeps = {},
  options: WriteOptions = {},
): Promise<Written<BotSummary>> {
  const input = parse(createBotSchema, raw);
  try {
    const written = await write(ctx, "bot.edit", deps, options, async (tx) => {
      const [row] = await tx
        .insert(schema.bots)
        .values({
          organizationId: ctx.organizationId,
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          createdByMembershipId: ctx.membershipId,
        })
        .returning(summaryColumns);
      return toSummary(row!);
    });
    if (written.applied) audit("bot.created", ctx, { bot_id: written.value.id });
    return written;
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION)
      throw new BotControlError("BOT_KEY_TAKEN", "A bot with this key already exists.");
    throw error;
  }
}

/**
 * Replaces the draft, compare-and-set on the draft revision the editor last saw. Saving canonical content identical to the
 * stored draft (including JSON that differs only in key order) is a successful no-op: `changed` is false, the revision and
 * metadata stay as they are and nothing is audited. The revision is still checked first, so a stale save is refused either way.
 */
export async function updateDraft(
  ctx: AccessContext,
  raw: unknown,
  deps: BotControlDeps = {},
  options: WriteOptions = {},
): Promise<
  Written<{ botId: string; draftRevision: number; canonicalBytes: number; changed: boolean }>
> {
  const input = parse(updateDraftSchema, raw);
  const canonical = draftCanonical(input.config);
  const canonicalBytes = UTF8.encode(canonical).byteLength;
  const written = await write(ctx, "bot.edit", deps, options, async (tx) => {
    const bot = await lockBot(tx, ctx.organizationId, input.botId);
    if (bot.draftRevision !== input.expectedRevision)
      throw new BotControlError(
        "STALE_REVISION",
        "The draft changed since it was loaded. Reload and try again.",
      );
    if (bot.draftConfigCanonical === canonical)
      return { botId: bot.id, draftRevision: bot.draftRevision, canonicalBytes, changed: false };
    const [row] = await tx
      .update(schema.bots)
      .set({
        draftConfigCanonical: canonical,
        draftRevision: bot.draftRevision + 1,
        draftUpdatedByMembershipId: ctx.membershipId,
        draftUpdatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(schema.bots.organizationId, ctx.organizationId),
          eq(schema.bots.id, bot.id),
          eq(schema.bots.draftRevision, input.expectedRevision),
        ),
      )
      .returning({ draftRevision: schema.bots.draftRevision });
    return { botId: bot.id, draftRevision: row!.draftRevision, canonicalBytes, changed: true };
  });
  if (written.applied && written.value.changed)
    audit("bot.draft_updated", ctx, {
      bot_id: written.value.botId,
      draft_revision: written.value.draftRevision,
    });
  return written;
}

export async function listBots(
  ctx: AccessContext,
  deps: BotControlDeps = {},
): Promise<BotSummary[]> {
  const db = reader(ctx, deps);
  const rows = await db
    .select(summaryColumns)
    .from(schema.bots)
    .where(eq(schema.bots.organizationId, ctx.organizationId))
    .orderBy(asc(schema.bots.key));
  return rows.map(toSummary);
}

export async function getBot(
  ctx: AccessContext,
  botId: string,
  deps: BotControlDeps = {},
): Promise<BotSummary & { readonly draft: unknown }> {
  const db = reader(ctx, deps);
  const [row] = await db
    .select(summaryColumns)
    .from(schema.bots)
    .where(and(eq(schema.bots.organizationId, ctx.organizationId), eq(schema.bots.id, botId)));
  if (!row) throw new NotFoundError();
  return {
    ...toSummary(row),
    draft: row.draftConfigCanonical === null ? null : JSON.parse(row.draftConfigCanonical),
  };
}

/** Runs the 08A validator over the current draft. Changes nothing. */
export async function validateDraft(
  ctx: AccessContext,
  botId: string,
  deps: BotControlDeps = {},
): Promise<{ draftRevision: number; ok: boolean; diagnostics: readonly Diagnostic[] }> {
  const bot = await getBot(ctx, botId, deps);
  if (!bot.hasDraft) throw new BotControlError("NO_DRAFT", "The bot has no draft to validate.");
  const result = validateFlow(bot.draft);
  return { draftRevision: bot.draftRevision, ok: result.ok, diagnostics: result.diagnostics };
}
