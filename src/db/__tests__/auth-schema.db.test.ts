import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "../index";
import {
  CHECK_VIOLATION,
  FK_VIOLATION,
  UNIQUE_VIOLATION,
  createTestDatabase,
  expectPgError,
  seedOrg,
  type TestDb,
} from "./helpers";

let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

describe("auth and access schema constraints (real PostgreSQL)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  });
  afterAll(async () => t.close());

  const seedUser = async (email = `u-${uniq()}@example.com`) =>
    (await db.insert(schema.users).values({ name: "U", email }).returning())[0]!;
  const futureDate = () => new Date(Date.now() + 3600_000);
  const seedMembership = async (
    organizationId: string,
    userId: string,
    role: "ADMIN" | "STAFF" | "VIEWER" = "STAFF",
  ) =>
    (
      await db
        .insert(schema.organizationMemberships)
        .values({ organizationId, userId, role })
        .returning()
    )[0]!;

  describe("Better Auth-owned tables", () => {
    it("keeps users.email unique", async () => {
      await seedUser("dup@example.com");
      await expectPgError(seedUser("dup@example.com"), UNIQUE_VIOLATION, "users_email_unique");
    });

    it("keeps sessions.token unique", async () => {
      const u = await seedUser();
      const row = { userId: u.id, token: `tok-${uniq()}`, expiresAt: futureDate() };
      await db.insert(schema.sessions).values(row);
      await expectPgError(
        db.insert(schema.sessions).values(row),
        UNIQUE_VIOLATION,
        "sessions_token_unique",
      );
    });

    it("keeps rate_limits.key unique", async () => {
      const row = { key: `k-${uniq()}`, count: 1, lastRequest: Date.now() };
      await db.insert(schema.rateLimits).values(row);
      await expectPgError(
        db.insert(schema.rateLimits).values(row),
        UNIQUE_VIOLATION,
        "rate_limits_key_unique",
      );
    });

    it("cascades sessions, accounts and user_security_state when the user is deleted", async () => {
      const u = await seedUser();
      await db
        .insert(schema.sessions)
        .values({ userId: u.id, token: `tok-${uniq()}`, expiresAt: futureDate() });
      await db
        .insert(schema.accounts)
        .values({ userId: u.id, accountId: u.id, providerId: "credential", password: "x:y" });
      await db
        .insert(schema.userSecurityState)
        .values({ userId: u.id, passwordChangeRequired: true });
      await t.pool.query("delete from users where id = $1", [u.id]);
      for (const table of ["sessions", "accounts", "user_security_state"]) {
        const r = await t.pool.query(`select count(*)::int n from ${table} where user_id = $1`, [
          u.id,
        ]);
        expect(r.rows[0].n, table).toBe(0);
      }
    });

    it("rejects sessions/accounts that reference a missing user", async () => {
      const missing = "00000000-0000-4000-8000-000000000000";
      await expectPgError(
        db
          .insert(schema.sessions)
          .values({ userId: missing, token: `tok-${uniq()}`, expiresAt: futureDate() }),
        FK_VIOLATION,
        "sessions_user_id_users_id_fk",
      );
      await expectPgError(
        db
          .insert(schema.accounts)
          .values({ userId: missing, accountId: "a", providerId: "credential" }),
        FK_VIOLATION,
        "accounts_user_id_users_id_fk",
      );
    });

    it("stores timestamps as timestamptz and ids as uuid", async () => {
      const uuidColumns: Record<string, string[]> = {
        users: ["id"],
        sessions: ["id", "user_id"],
        accounts: ["id", "user_id"],
        verifications: ["id"],
        rate_limits: ["id"],
        organization_memberships: ["id", "organization_id", "user_id"],
        user_security_state: ["user_id"],
        staff_provisioning_intents: [
          "id",
          "organization_id",
          "requested_by_membership_id",
          "auth_user_id",
        ],
      };
      const r = await t.pool.query(
        "select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = any($1)",
        [Object.keys(uuidColumns)],
      );
      const type = (table: string, column: string) =>
        r.rows.find((c) => c.table_name === table && c.column_name === column)?.data_type;
      for (const [table, cols] of Object.entries(uuidColumns)) {
        for (const c of cols) expect(type(table, c), `${table}.${c}`).toBe("uuid");
      }
      const tsColumns = r.rows.filter((c) => c.column_name.endsWith("_at"));
      expect(tsColumns.length).toBe(18);
      for (const c of tsColumns)
        expect(c.data_type, `${c.table_name}.${c.column_name}`).toBe("timestamp with time zone");
    });
  });

  describe("organization_memberships", () => {
    it("allows one membership per (organization, user)", async () => {
      const org = await seedOrg(db);
      const u = await seedUser();
      await seedMembership(org.id, u.id);
      await expectPgError(
        seedMembership(org.id, u.id, "ADMIN"),
        UNIQUE_VIOLATION,
        "organization_memberships_org_user_unique",
      );
    });

    it("allows the same user in different organizations", async () => {
      const a = await seedOrg(db);
      const b = await seedOrg(db);
      const u = await seedUser();
      await seedMembership(a.id, u.id);
      await seedMembership(b.id, u.id);
    });

    it("accepts ADMIN, STAFF and VIEWER and rejects other roles", async () => {
      const org = await seedOrg(db);
      for (const role of schema.MEMBERSHIP_ROLES)
        await seedMembership(org.id, (await seedUser()).id, role);
      const u = await seedUser();
      await expectPgError(
        t.pool.query(
          "insert into organization_memberships (organization_id, user_id, role) values ($1,$2,'OWNER')",
          [org.id, u.id],
        ),
        CHECK_VIOLATION,
        "organization_memberships_role_check",
      );
    });

    it("defaults to ACTIVE, accepts SUSPENDED and rejects other statuses", async () => {
      const org = await seedOrg(db);
      const m = await seedMembership(org.id, (await seedUser()).id);
      expect(m.status).toBe("ACTIVE");
      await db
        .update(schema.organizationMemberships)
        .set({ status: "SUSPENDED" })
        .where(eq(schema.organizationMemberships.id, m.id));
      await expectPgError(
        t.pool.query("update organization_memberships set status = 'REMOVED' where id = $1", [
          m.id,
        ]),
        CHECK_VIOLATION,
        "organization_memberships_status_check",
      );
    });

    it("has a user_id index and an (organization_id, id) FK-target unique constraint", async () => {
      const r = await t.pool.query(
        "select indexname from pg_indexes where tablename = 'organization_memberships' order by 1",
      );
      const names = r.rows.map((x) => x.indexname);
      expect(names).toContain("organization_memberships_user_id_idx");
      expect(names).toContain("organization_memberships_org_id_unique");
      // the lookup the access layer will do: all memberships of a user
      const org = await seedOrg(db);
      const u = await seedUser();
      await seedMembership(org.id, u.id);
      const found = await db
        .select()
        .from(schema.organizationMemberships)
        .where(eq(schema.organizationMemberships.userId, u.id));
      expect(found).toHaveLength(1);
    });

    it("rejects a membership for a missing user or organization", async () => {
      const org = await seedOrg(db);
      const u = await seedUser();
      const missing = "00000000-0000-4000-8000-000000000000";
      await expectPgError(
        seedMembership(org.id, missing),
        FK_VIOLATION,
        "organization_memberships_user_id_users_id_fk",
      );
      await expectPgError(
        seedMembership(missing, u.id),
        FK_VIOLATION,
        "organization_memberships_organization_id_organizations_id_fk",
      );
    });

    it("does not cascade: deleting a user or organization with a membership is refused", async () => {
      const org = await seedOrg(db);
      const u = await seedUser();
      await seedMembership(org.id, u.id);
      await expectPgError(t.pool.query("delete from users where id = $1", [u.id]), FK_VIOLATION);
      await expectPgError(
        t.pool.query("delete from organizations where id = $1", [org.id]),
        FK_VIOLATION,
      );
    });
  });

  describe("staff_provisioning_intents", () => {
    const insertIntent = (
      organizationId: string,
      emailKey: string,
      extra: Partial<typeof schema.staffProvisioningIntents.$inferInsert> = {},
    ) =>
      db
        .insert(schema.staffProvisioningIntents)
        .values({ organizationId, emailKey, ...extra })
        .returning();

    it("requires email_key to be already trimmed and lowercase, and non-blank", async () => {
      const org = await seedOrg(db);
      for (const bad of [
        "Upper@Example.com",
        " padded@example.com",
        "padded@example.com ",
        "",
        "   ",
      ]) {
        await expectPgError(
          insertIntent(org.id, bad),
          CHECK_VIOLATION,
          "staff_provisioning_intents_email_key_check",
        );
      }
      await insertIntent(org.id, `ok-${uniq()}@example.com`);
    });

    it("rejects a globally duplicate email_key, including across organizations", async () => {
      const a = await seedOrg(db);
      const b = await seedOrg(db);
      const email = `same-${uniq()}@example.com`;
      await insertIntent(a.id, email);
      await expectPgError(
        insertIntent(a.id, email),
        UNIQUE_VIOLATION,
        "staff_provisioning_intents_email_key_unique",
      );
      await expectPgError(
        insertIntent(b.id, email),
        UNIQUE_VIOLATION,
        "staff_provisioning_intents_email_key_unique",
      );
    });

    it("requires requested_by_membership_id to belong to the same organization, and allows NULL (bootstrap)", async () => {
      const a = await seedOrg(db);
      const b = await seedOrg(db);
      const adminA = await seedMembership(a.id, (await seedUser()).id, "ADMIN");
      const [bootstrap] = await insertIntent(a.id, `boot-${uniq()}@example.com`); // NULL requested_by
      expect(bootstrap!.requestedByMembershipId).toBeNull();
      await insertIntent(a.id, `own-${uniq()}@example.com`, { requestedByMembershipId: adminA.id });
      await expectPgError(
        insertIntent(b.id, `cross-${uniq()}@example.com`, { requestedByMembershipId: adminA.id }),
        FK_VIOLATION,
        "staff_provisioning_intents_org_requested_by_fk",
      );
    });

    it("keeps auth_user_id unique and sets it to NULL when the user is deleted", async () => {
      const org = await seedOrg(db);
      const u = await seedUser();
      const [first] = await insertIntent(org.id, `a-${uniq()}@example.com`, { authUserId: u.id });
      await expectPgError(
        insertIntent(org.id, `b-${uniq()}@example.com`, { authUserId: u.id }),
        UNIQUE_VIOLATION,
        "staff_provisioning_intents_auth_user_id_unique",
      );
      await t.pool.query("delete from users where id = $1", [u.id]);
      const [after] = await db
        .select()
        .from(schema.staffProvisioningIntents)
        .where(eq(schema.staffProvisioningIntents.id, first!.id));
      expect(after).toBeDefined();
      expect(after!.authUserId).toBeNull();
    });

    it("stores no credential or password material", async () => {
      const r = await t.pool.query(
        "select column_name from information_schema.columns where table_name = 'staff_provisioning_intents'",
      );
      const cols = r.rows.map((x) => x.column_name as string);
      expect(cols.sort()).toEqual(
        [
          "auth_user_id",
          "created_at",
          "email_key",
          "id",
          "organization_id",
          "requested_by_membership_id",
          "updated_at",
        ].sort(),
      );
      expect(cols.some((c) => /pass|secret|token|credential|hash/i.test(c))).toBe(false);
    });
  });

  describe("user_security_state", () => {
    it("defaults password_change_required to false and allows an explicit true", async () => {
      const a = await seedUser();
      const b = await seedUser();
      const [s1] = await db.insert(schema.userSecurityState).values({ userId: a.id }).returning();
      const [s2] = await db
        .insert(schema.userSecurityState)
        .values({ userId: b.id, passwordChangeRequired: true })
        .returning();
      expect(s1!.passwordChangeRequired).toBe(false);
      expect(s2!.passwordChangeRequired).toBe(true);
    });

    it("allows exactly one row per user and requires an existing user", async () => {
      const u = await seedUser();
      await db.insert(schema.userSecurityState).values({ userId: u.id });
      await expectPgError(
        db.insert(schema.userSecurityState).values({ userId: u.id }),
        UNIQUE_VIOLATION,
        "user_security_state_pkey",
      );
      await expectPgError(
        db
          .insert(schema.userSecurityState)
          .values({ userId: "00000000-0000-4000-8000-000000000000" }),
        FK_VIOLATION,
        "user_security_state_user_id_users_id_fk",
      );
    });

    it("has no organization_id column (global identity state)", async () => {
      const r = await t.pool.query(
        "select column_name from information_schema.columns where table_name = 'user_security_state'",
      );
      expect(r.rows.map((x) => x.column_name)).not.toContain("organization_id");
    });
  });
});
