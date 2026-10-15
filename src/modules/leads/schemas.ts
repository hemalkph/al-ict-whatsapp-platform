import { z } from "zod";
import { schema } from "@/db";
import { ValidationError } from "@/shared/errors/http-errors";

// Strict input schemas: unknown keys are rejected (so a client can never supply a timestamp, a revision, an origin, an
// organization or a history row), every size is bounded, and nothing from the browser names an organization.

export const PAGE_SIZE_DEFAULT = 30;
export const PAGE_SIZE_MAX = 50;
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 64;

export const uuid = z.uuid();
const limit = z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT);
const cursor = z.string().min(1).max(200);

export const listQuerySchema = z.strictObject({
  state: z.enum(["open", "closed"]).optional(),
  status: z.enum(schema.LEAD_STATUSES).optional(),
  /** ad: at least one confirmed Meta ad touch is linked to the lead. none: no such touch is linked (not "organic"). */
  attribution: z.enum(["ad", "none"]).optional(),
  q: z.string().trim().min(SEARCH_MIN).max(SEARCH_MAX).optional(),
  cursor: cursor.optional(),
  limit,
});
export type LeadListQuery = z.infer<typeof listQuerySchema>;

export const eventsQuerySchema = z.strictObject({ cursor: cursor.optional(), limit });

/** Manual creation: the contact and nothing else. The server decides status, revision, origin and every timestamp. */
export const createLeadSchema = z.strictObject({ contactId: uuid });

/**
 * `to` is limited to the statuses staff may set in Phase 07 (the reserved ones are not even parseable). `expectedRevision` is
 * the revision the browser saw: the change applies only if the lead still has it.
 */
export const statusChangeSchema = z.strictObject({
  to: z.enum(schema.STAFF_SETTABLE_LEAD_STATUSES),
  expectedRevision: z.number().int().min(0).max(2_147_483_647),
});

/**
 * Field NAMES of the issues, never values. An unknown key (for example `cycleStartedAt`) is reported by its name when that is a
 * plain identifier, so the caller can see what was refused.
 */
export function fieldsOf(
  issues: ReadonlyArray<{ path: PropertyKey[]; code?: string; keys?: string[] }>,
): string[] {
  const names = new Set<string>();
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys" && issue.keys)
      for (const key of issue.keys) names.add(/^[A-Za-z0-9_]{1,40}$/.test(key) ? key : "body");
    else names.add(String(issue.path[0] ?? "body"));
  }
  return [...names];
}

export function parseOrThrow<T>(parsed: z.ZodSafeParseResult<T>): T {
  if (!parsed.success) throw new ValidationError(fieldsOf(parsed.error.issues));
  return parsed.data;
}
