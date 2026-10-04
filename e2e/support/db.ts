import { Pool } from "pg";

// Read-only assertions against the disposable E2E database ("is the DB session really gone?"). Writes belong to the
// application under test, never to the tests.

let pool: Pool | undefined;

function getPool(): Pool {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is not set. Run with `npm run test:e2e`.");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) || !/\/al_ict_e2e_/.test(url)) {
    throw new Error("Refusing to touch anything but a local al_ict_e2e_* database.");
  }
  return (pool ??= new Pool({ connectionString: url, max: 2 }));
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await getPool().query(sql, params);
  if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}.`);
  return rows[0] as T;
}

export const sessionCount = async (email: string) =>
  (
    await one<{ n: number }>(
      "select count(*)::int n from sessions s join users u on u.id = s.user_id where u.email = $1",
      [email],
    )
  ).n;

export const passwordChangeRequired = async (email: string) =>
  (
    await one<{ required: boolean }>(
      `select coalesce((select password_change_required from user_security_state ss where ss.user_id = u.id), false) required
         from users u where u.email = $1`,
      [email],
    )
  ).required;

export const membershipOf = (email: string) =>
  one<{ id: string; organization_id: string; role: string; status: string }>(
    `select m.id, m.organization_id, m.role, m.status
       from organization_memberships m join users u on u.id = m.user_id where u.email = $1`,
    [email],
  );

export const userExists = async (email: string) =>
  (await one<{ n: number }>("select count(*)::int n from users where email = $1", [email])).n > 0;

export const userCount = async () =>
  (await one<{ n: number }>("select count(*)::int n from users", [])).n;
