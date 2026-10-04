import { eq } from "drizzle-orm";
import { getDb, schema, type Database } from "@/db";
import type { AccessContext } from "./access";

export type AccessSummary = {
  readonly userName: string;
  readonly organizationName: string;
  readonly role: string;
};

/** Safe display information for the signed-in user, derived ONLY from the AccessContext. */
export async function getAccessSummary(
  ctx: AccessContext,
  deps: { db?: Database } = {},
): Promise<AccessSummary> {
  const db = deps.db ?? getDb();
  const [user] = await db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.userId));
  const [org] = await db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, ctx.organizationId));
  return { userName: user?.name ?? "", organizationName: org?.name ?? "", role: ctx.role };
}
