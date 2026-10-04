import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "../index";
import {
  hasActiveMembership,
  provisionUser,
  provisionerAuth,
  TEST_PASSWORD,
} from "./auth-fixtures";
import {
  FK_VIOLATION,
  UNIQUE_VIOLATION,
  createTestDatabase,
  expectPgError,
  seedOrg,
  type TestDb,
} from "./helpers";

// Database behavior required by the future staff-provisioning workflow. createStaff itself is NOT
// implemented; these tests exercise the schema with test-only fixtures that follow ADR 0012's mandatory order:
//   1 intent  ->  2 private provisioner  ->  3 (Better Auth, transaction: true)  ->
//   4 ONE application transaction: set auth_user_id + user_security_state(true) + ACTIVE membership + delete intent.

let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

describe("provisioning intent recovery model (real PostgreSQL + Better Auth 1.7.7)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  });
  afterAll(async () => t.close());

  const acquireIntent = (
    organizationId: string,
    emailKey: string,
    requestedByMembershipId: string | null = null,
  ) =>
    db
      .insert(schema.staffProvisioningIntents)
      .values({ organizationId, emailKey, requestedByMembershipId })
      .returning();

  /** Step 4 of the mandatory order, as a test fixture. `failAfterWrites` simulates an application failure. */
  async function reconcile(
    organizationId: string,
    emailKey: string,
    opts: { failAfterWrites?: boolean; role?: "ADMIN" | "STAFF" | "VIEWER" } = {},
  ) {
    return db.transaction(async (tx) => {
      const [intent] = await tx
        .select()
        .from(schema.staffProvisioningIntents)
        .where(
          and(
            eq(schema.staffProvisioningIntents.organizationId, organizationId),
            eq(schema.staffProvisioningIntents.emailKey, emailKey),
          ),
        )
        .for("update");
      if (!intent) throw new Error("no intent held by this organization for that email");
      const [user] = await tx.select().from(schema.users).where(eq(schema.users.email, emailKey));
      if (!user) throw new Error("no auth user to reconcile");
      // Guard required by ADR 0012: refuse an identity that already has any membership anywhere.
      const existing = await tx
        .select({ id: schema.organizationMemberships.id })
        .from(schema.organizationMemberships)
        .where(eq(schema.organizationMemberships.userId, user.id));
      if (existing.length > 0)
        throw new Error("identity already has a membership; refusing to reconcile");
      await tx
        .update(schema.staffProvisioningIntents)
        .set({ authUserId: user.id })
        .where(eq(schema.staffProvisioningIntents.id, intent.id));
      await tx
        .insert(schema.userSecurityState)
        .values({ userId: user.id, passwordChangeRequired: true });
      const [membership] = await tx
        .insert(schema.organizationMemberships)
        .values({ organizationId, userId: user.id, role: opts.role ?? "STAFF", status: "ACTIVE" })
        .returning();
      if (opts.failAfterWrites) throw new Error("simulated application failure before commit");
      await tx
        .delete(schema.staffProvisioningIntents)
        .where(eq(schema.staffProvisioningIntents.id, intent.id));
      return { userId: user.id, membershipId: membership!.id };
    });
  }

  const state = async (userId: string, emailKey: string) => {
    const r = await t.pool.query(
      `select (select count(*)::int from organization_memberships where user_id = $1) memberships,
              (select count(*)::int from user_security_state where user_id = $1) security_rows,
              (select count(*)::int from staff_provisioning_intents where email_key = $2) intents`,
      [userId, emailKey],
    );
    return r.rows[0] as { memberships: number; security_rows: number; intents: number };
  };

  it("A–D: crash after Better Auth fails closed, and a same-organization retry reconciles atomically", async () => {
    const org = await seedOrg(db);
    const email = `crash-${uniq()}@example.com`;

    // A: acquire the intent first
    const [intent] = await acquireIntent(org.id, email);
    expect(intent!.authUserId).toBeNull();

    // B: private provisioner creates the auth user + credential
    const user = await provisionUser(t, email);
    expect(user.email).toBe(email);

    // C: simulated crash before the application transaction -> fail closed
    expect(await state(user.id, email)).toEqual({ memberships: 0, security_rows: 0, intents: 1 });
    expect(await hasActiveMembership(t, user.id)).toBe(false);

    // D: same-organization retry reconciles in one transaction
    const done = await reconcile(org.id, email);
    expect(done.userId).toBe(user.id);
    expect(await state(user.id, email)).toEqual({ memberships: 1, security_rows: 1, intents: 0 });
    expect(await hasActiveMembership(t, user.id)).toBe(true);
    const sec = await db
      .select()
      .from(schema.userSecurityState)
      .where(eq(schema.userSecurityState.userId, user.id));
    expect(sec[0]!.passwordChangeRequired).toBe(true);
    const mem = await db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.userId, user.id));
    expect(mem[0]).toMatchObject({ organizationId: org.id, role: "STAFF", status: "ACTIVE" });
  });

  it("makes the ACTIVE membership and password_change_required=true visible atomically (not before commit)", async () => {
    const org = await seedOrg(db);
    const email = `atomic-${uniq()}@example.com`;
    await acquireIntent(org.id, email);
    const user = await provisionUser(t, email);

    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let wrote!: () => void;
    const wroteP = new Promise<void>((r) => (wrote = r));
    const tx = db.transaction(async (trx) => {
      await trx
        .update(schema.staffProvisioningIntents)
        .set({ authUserId: user.id })
        .where(eq(schema.staffProvisioningIntents.emailKey, email));
      await trx
        .insert(schema.userSecurityState)
        .values({ userId: user.id, passwordChangeRequired: true });
      await trx
        .insert(schema.organizationMemberships)
        .values({ organizationId: org.id, userId: user.id, role: "ADMIN" });
      wrote();
      await hold; // writes done, not yet committed
      await trx
        .delete(schema.staffProvisioningIntents)
        .where(eq(schema.staffProvisioningIntents.emailKey, email));
    });
    await wroteP;
    // another connection sees NEITHER the membership nor the security state, and the intent is still there
    expect(await state(user.id, email)).toEqual({ memberships: 0, security_rows: 0, intents: 1 });
    expect(await hasActiveMembership(t, user.id)).toBe(false);
    release();
    await tx;
    expect(await state(user.id, email)).toEqual({ memberships: 1, security_rows: 1, intents: 0 });
  });

  it("E: a failing application transaction leaves no membership, no security state, and the intent intact", async () => {
    const org = await seedOrg(db);
    const email = `fail-${uniq()}@example.com`;
    await acquireIntent(org.id, email);
    const user = await provisionUser(t, email);

    await expect(reconcile(org.id, email, { failAfterWrites: true })).rejects.toThrow(
      /simulated application failure/,
    );
    expect(await state(user.id, email)).toEqual({ memberships: 0, security_rows: 0, intents: 1 });
    const [intent] = await db
      .select()
      .from(schema.staffProvisioningIntents)
      .where(eq(schema.staffProvisioningIntents.emailKey, email));
    expect(intent!.authUserId).toBeNull(); // the auth_user_id update was rolled back too
    expect(await hasActiveMembership(t, user.id)).toBe(false);

    // and a constraint failure inside the transaction rolls back the same way
    await expect(
      db.transaction(async (trx) => {
        await trx
          .insert(schema.userSecurityState)
          .values({ userId: user.id, passwordChangeRequired: true });
        await trx.execute(
          sql`insert into organization_memberships (organization_id, user_id, role) values (${org.id}, ${user.id}, 'OWNER')`,
        );
      }),
    ).rejects.toThrow();
    expect(await state(user.id, email)).toEqual({ memberships: 0, security_rows: 0, intents: 1 });

    // retry succeeds afterwards
    await reconcile(org.id, email);
    expect(await state(user.id, email)).toEqual({ memberships: 1, security_rows: 1, intents: 0 });
  });

  it("F: another organization cannot acquire the same email while the original intent exists", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    const email = `claim-${uniq()}@example.com`;
    await acquireIntent(a.id, email);
    const user = await provisionUser(t, email);

    await expectPgError(
      acquireIntent(b.id, email),
      UNIQUE_VIOLATION,
      "staff_provisioning_intents_email_key_unique",
    );
    // B holds no intent, so the reconcile step has nothing to lock and refuses
    await expect(reconcile(b.id, email)).rejects.toThrow(/no intent held/);
    expect(await state(user.id, email)).toEqual({ memberships: 0, security_rows: 0, intents: 1 });
    expect(await hasActiveMembership(t, user.id)).toBe(false);
  });

  it("completed identities stay protected by the 'no membership anywhere' reconcile guard (intent uniqueness alone is not enough)", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    const email = `done-${uniq()}@example.com`;
    await acquireIntent(a.id, email);
    const user = await provisionUser(t, email);
    await reconcile(a.id, email, { role: "ADMIN" });

    // The intent was deleted on completion, so B *can* insert an intent for the now-established identity...
    await acquireIntent(b.id, email);
    // ...but the reconcile guard refuses it because the user already has a membership in organization A.
    await expect(reconcile(b.id, email)).rejects.toThrow(/already has a membership/);
    expect((await state(user.id, email)).memberships).toBe(1);
    const mem = await db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.userId, user.id));
    expect(mem.map((m) => m.organizationId)).toEqual([a.id]);
  });

  it("intent.requested_by_membership_id must belong to the intent's organization (recovery stays attributable)", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    const adminUser = await provisionUser(t, `admin-${uniq()}@example.com`);
    const [adminA] = await db
      .insert(schema.organizationMemberships)
      .values({ organizationId: a.id, userId: adminUser.id, role: "ADMIN" })
      .returning();
    await expectPgError(
      acquireIntent(b.id, `x-${uniq()}@example.com`, adminA!.id),
      FK_VIOLATION,
      "staff_provisioning_intents_org_requested_by_fk",
    );
    await acquireIntent(a.id, `y-${uniq()}@example.com`, adminA!.id);
  });

  it("a user without any ACTIVE membership (including SUSPENDED only) has no application access", async () => {
    const org = await seedOrg(db);
    const user = await provisionUser(t, `suspended-${uniq()}@example.com`);
    expect(await hasActiveMembership(t, user.id)).toBe(false);
    const [m] = await db
      .insert(schema.organizationMemberships)
      .values({ organizationId: org.id, userId: user.id, role: "STAFF" })
      .returning();
    expect(await hasActiveMembership(t, user.id)).toBe(true);
    await db
      .update(schema.organizationMemberships)
      .set({ status: "SUSPENDED" })
      .where(eq(schema.organizationMemberships.id, m!.id));
    expect(await hasActiveMembership(t, user.id)).toBe(false);
  });

  it("provisioning through the private instance never stores plaintext credentials anywhere in the intent flow", async () => {
    const org = await seedOrg(db);
    const email = `nocred-${uniq()}@example.com`;
    await acquireIntent(org.id, email);
    await provisionerAuth(t).api.signUpEmail({
      body: { name: "N", email, password: TEST_PASSWORD },
    });
    const dump = await t.pool.query(
      "select row_to_json(i)::text j from staff_provisioning_intents i where email_key = $1",
      [email],
    );
    expect(dump.rows[0].j).not.toContain(TEST_PASSWORD);
  });
});
