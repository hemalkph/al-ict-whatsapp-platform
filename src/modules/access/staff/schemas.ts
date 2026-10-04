import { z } from "zod";
import { ValidationError } from "@/shared/errors/http-errors";
import { ROLES } from "../permissions";

// STRICT input schemas for every staff operation. Unknown keys are REJECTED (not stripped), so a caller can
// never smuggle organizationId, userId, status, passwordChangeRequired or a role into an operation that does not
// accept one. The only identifiers accepted are TARGET resource ids (membershipId), which are always resolved
// inside ctx.organizationId and are never authority.

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const name = z.string().trim().min(1).max(100);
const password = z.string().min(12).max(128);
const role = z.enum(ROLES);
const membershipId = z.uuid();

export const createStaffSchema = z.strictObject({ email, name, role, initialPassword: password });
export const changeMemberRoleSchema = z.strictObject({ membershipId, role });
export const suspendMemberSchema = z.strictObject({ membershipId });
export const reactivateMemberSchema = z.strictObject({ membershipId });
export const resetStaffPasswordSchema = z.strictObject({ membershipId, newPassword: password });

export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type ChangeMemberRoleInput = z.infer<typeof changeMemberRoleSchema>;
export type SuspendMemberInput = z.infer<typeof suspendMemberSchema>;
export type ReactivateMemberInput = z.infer<typeof reactivateMemberSchema>;
export type ResetStaffPasswordInput = z.infer<typeof resetStaffPasswordSchema>;

/** Parses untrusted input; throws ValidationError carrying field names only (never values). */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = new Set<string>();
    for (const issue of result.error.issues) {
      if (issue.code === "unrecognized_keys") for (const k of issue.keys) fields.add(k);
      else fields.add(issue.path.join(".") || "(root)");
    }
    throw new ValidationError([...fields]);
  }
  return result.data;
}
