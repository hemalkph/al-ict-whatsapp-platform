import { z } from "zod";
import { ValidationError } from "@/shared/errors/http-errors";

// Strict input schemas of the bot-management operations. Errors carry field NAMES only, never values.

const uuid = z.uuid();
const revision = z.number().int().min(0).max(2_147_483_647);

export const createBotSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  name: z
    .string()
    .min(1)
    .max(100)
    .refine((s) => s.trim() !== ""),
  description: z.string().max(500).optional(),
});

export const updateDraftSchema = z.strictObject({
  botId: uuid,
  expectedRevision: revision,
  /** Parsed JSON. Need not be a valid flow yet; it must be JSON within the contract's size limit. */
  config: z.unknown(),
});

export const publishSchema = z.strictObject({
  botId: uuid,
  /** The draft revision the publisher reviewed: exactly that draft is published, or nothing. */
  expectedRevision: revision,
  changeNote: z.string().max(500).optional(),
});

export const activateSchema = z.strictObject({
  botId: uuid,
  versionId: uuid,
  whatsappAccountId: uuid,
  priority: z.number().int().min(1).max(1000),
});

export const changeVersionSchema = z.strictObject({
  deploymentId: uuid,
  versionId: uuid,
});

export const deploymentSchema = z.strictObject({ deploymentId: uuid });

export const stopSessionsSchema = z.strictObject({
  deploymentId: uuid,
  /** The live-session count the operator was shown (count preview); a different count refuses the stop. */
  expectedLiveSessions: z.number().int().min(0),
});

export const retireSchema = z.strictObject({
  deploymentId: uuid,
  expectedLiveSessions: z.number().int().min(0),
  /** Typed confirmation: the bot's key. */
  confirmBotKey: z.string().min(1).max(64),
});

export const EMERGENCY_STOP_PHRASE = "EMERGENCY STOP";

export const emergencyStopSchema = z.strictObject({
  /** Only this account's deployments; all of the organization's when omitted. */
  whatsappAccountId: uuid.optional(),
  /** The number of deployments the operator was shown (count preview). */
  expectedDeployments: z.number().int().min(0),
  confirmPhrase: z.literal(EMERGENCY_STOP_PHRASE),
});

export function parse<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new ValidationError([
      ...new Set(result.error.issues.map((i) => String(i.path[0] ?? "body"))),
    ]);
  return result.data;
}
