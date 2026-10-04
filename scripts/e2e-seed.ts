import { eq } from "drizzle-orm";
import { schema } from "@/db";
import type { TestDb } from "@/db/__tests__/helpers";
import { bootstrapFirstAdmin } from "@/modules/access/operator";
import type { AuthEnv } from "@/modules/auth";
import { createProvisioningAuth } from "@/modules/auth/provisioning";
import { E2E_PASSWORD, FIRST_ADMIN, ORG_A, ORG_B, USERS } from "../e2e/support/identities";

// Seeds the DISPOSABLE E2E database with the minimum identities the browser tests need.
//  - The first admin is created by the real bootstrap workflow (organization + ADMIN, password_change_required).
//  - Every other account goes through the same private provisioning instance the services use, plus a membership
//    row: the same fixture pattern as the integration tests' provisionUser. No production auth logic is duplicated.

export async function seedE2E(t: TestDb, env: AuthEnv): Promise<void> {
  const provisioner = createProvisioningAuth({ db: t.db, env });

  await bootstrapFirstAdmin(
    {
      organizationName: ORG_A.name,
      organizationSlug: ORG_A.slug,
      email: FIRST_ADMIN.email,
      name: FIRST_ADMIN.name,
      password: E2E_PASSWORD,
    },
    { db: t.db, provisioner },
  );

  const [orgA] = await t.db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, ORG_A.slug));
  const [orgB] = await t.db.insert(schema.organizations).values(ORG_B).returning();
  if (!orgA || !orgB) throw new Error("E2E seed: organizations were not created.");
  const orgIds = { A: orgA.id, B: orgB.id };

  for (const u of Object.values(USERS)) {
    const created = await provisioner.api.signUpEmail({
      body: { name: u.name, email: u.email, password: E2E_PASSWORD },
    });
    await t.db.insert(schema.organizationMemberships).values({
      organizationId: orgIds[u.org],
      userId: created.user.id,
      role: u.role,
      status: "ACTIVE",
    });
  }
}
