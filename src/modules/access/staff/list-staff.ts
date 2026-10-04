import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { AccessContext } from "../access";
import { assertCan } from "../permissions";
import type { StaffDeps, StaffMember } from "./types";

/**
 * Staff of the CALLER'S organization only (requires staff.read). Returns the safe StaffMember view; the select
 * list below is explicit, so no password hashes, tokens, credential accounts, other organizations or
 * provisioning state can ever leak through it.
 */
export async function listStaff(ctx: AccessContext, deps: StaffDeps = {}): Promise<StaffMember[]> {
  assertCan(ctx, "staff.read");
  const db = deps.db ?? getDb();
  return db
    .select({
      membershipId: schema.organizationMemberships.id,
      userId: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.organizationMemberships.role,
      status: schema.organizationMemberships.status,
      passwordChangeRequired: schema.userSecurityState.passwordChangeRequired,
      createdAt: schema.organizationMemberships.createdAt,
    })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
    .leftJoin(schema.userSecurityState, eq(schema.userSecurityState.userId, schema.users.id))
    .where(eq(schema.organizationMemberships.organizationId, ctx.organizationId))
    .orderBy(asc(schema.users.email))
    .then((rows) =>
      rows.map((r) => ({ ...r, passwordChangeRequired: r.passwordChangeRequired ?? false })),
    );
}
