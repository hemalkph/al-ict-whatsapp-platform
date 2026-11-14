import { createHash } from "node:crypto";
import { and, desc, eq, max } from "drizzle-orm";
import { schema } from "@/db";
import type { AccessContext } from "@/modules/access";
import { canonicalFlowJson, validateFlow, type FlowConfig } from "@/modules/bots";
import { NotFoundError } from "@/shared/errors/http-errors";
import {
  audit,
  reader,
  write,
  type BotControlDeps,
  type WriteOptions,
  type Written,
} from "./common";
import { lockBot } from "./drafts";
import { BotControlError } from "./errors";
import { parse, publishSchema } from "./schemas";

// Publishing (V3.2 F.1, K.2; ADR 0019): validate + canonicalise + hash + insert, one transaction under the bot lock. The version
// stores the canonical text, the equal jsonb and the SHA-256 of the canonical UTF-8 bytes; the database re-checks all three
// and makes the row immutable. Version numbers are max + 1 under the bot lock, backed by a unique constraint.

export type VersionSummary = {
  readonly id: string;
  readonly botId: string;
  readonly versionNumber: number;
  readonly configSha256: string;
  readonly canonicalBytes: number;
  readonly publishedByMembershipId: string;
  readonly publishedAt: Date;
  readonly changeNote: string | null;
};

const UTF8 = new TextEncoder();

/** The canonical text of a validated flow and its SHA-256 (hex) over the UTF-8 bytes. */
export function canonicalWithHash(config: FlowConfig): { canonical: string; sha256: string } {
  const canonical = canonicalFlowJson(config);
  return {
    canonical,
    sha256: createHash("sha256").update(UTF8.encode(canonical)).digest("hex"),
  };
}

const summaryColumns = {
  id: schema.botVersions.id,
  botId: schema.botVersions.botId,
  versionNumber: schema.botVersions.versionNumber,
  configSha256: schema.botVersions.configSha256,
  configCanonical: schema.botVersions.configCanonical,
  publishedByMembershipId: schema.botVersions.publishedByMembershipId,
  publishedAt: schema.botVersions.publishedAt,
  changeNote: schema.botVersions.changeNote,
};

const toSummary = ({
  configCanonical,
  ...row
}: Omit<VersionSummary, "canonicalBytes"> & { configCanonical: string }): VersionSummary => ({
  ...row,
  canonicalBytes: UTF8.encode(configCanonical).byteLength,
});

/** Publishes exactly the draft revision the publisher reviewed, if it is a valid flow. */
export async function publishVersion(
  ctx: AccessContext,
  raw: unknown,
  deps: BotControlDeps = {},
  options: WriteOptions = {},
): Promise<Written<VersionSummary>> {
  const input = parse(publishSchema, raw);
  const written = await write(ctx, "bot.publish", deps, options, async (tx) => {
    const bot = await lockBot(tx, ctx.organizationId, input.botId);
    if (bot.draftRevision !== input.expectedRevision)
      throw new BotControlError(
        "STALE_REVISION",
        "The draft changed since it was reviewed. Review it again.",
      );
    if (bot.draftConfigCanonical === null)
      throw new BotControlError("NO_DRAFT", "The bot has no draft to publish.");
    const validation = validateFlow(JSON.parse(bot.draftConfigCanonical));
    if (!validation.ok || !validation.config)
      throw new BotControlError(
        "FLOW_INVALID",
        "The draft is not a valid flow.",
        undefined,
        validation.diagnostics,
      );
    const { canonical, sha256 } = canonicalWithHash(validation.config);
    const [last] = await tx
      .select({ n: max(schema.botVersions.versionNumber) })
      .from(schema.botVersions)
      .where(
        and(
          eq(schema.botVersions.organizationId, ctx.organizationId),
          eq(schema.botVersions.botId, bot.id),
        ),
      );
    const [row] = await tx
      .insert(schema.botVersions)
      .values({
        organizationId: ctx.organizationId,
        botId: bot.id,
        versionNumber: (last?.n ?? 0) + 1,
        schemaVersion: validation.config.schemaVersion,
        config: JSON.parse(canonical) as unknown,
        configCanonical: canonical,
        configSha256: sha256,
        publishedByMembershipId: ctx.membershipId,
        changeNote: input.changeNote ?? null,
      })
      .returning(summaryColumns);
    return toSummary(row!);
  });
  if (written.applied)
    audit("bot.version_published", ctx, {
      bot_id: written.value.botId,
      version_id: written.value.id,
      version_number: written.value.versionNumber,
      config_sha256: written.value.configSha256,
    });
  return written;
}

export async function listVersions(
  ctx: AccessContext,
  botId: string,
  deps: BotControlDeps = {},
): Promise<VersionSummary[]> {
  const db = reader(ctx, deps);
  const rows = await db
    .select(summaryColumns)
    .from(schema.botVersions)
    .where(
      and(
        eq(schema.botVersions.organizationId, ctx.organizationId),
        eq(schema.botVersions.botId, botId),
      ),
    )
    .orderBy(desc(schema.botVersions.versionNumber));
  return rows.map(toSummary);
}

/** One version with its configuration (parsed from the stored canonical text: the exact bytes that were hashed). */
export async function getVersion(
  ctx: AccessContext,
  versionId: string,
  deps: BotControlDeps = {},
): Promise<VersionSummary & { readonly config: FlowConfig }> {
  const db = reader(ctx, deps);
  const [row] = await db
    .select(summaryColumns)
    .from(schema.botVersions)
    .where(
      and(
        eq(schema.botVersions.organizationId, ctx.organizationId),
        eq(schema.botVersions.id, versionId),
      ),
    );
  if (!row) throw new NotFoundError();
  return { ...toSummary(row), config: JSON.parse(row.configCanonical) as FlowConfig };
}
