import { afterEach, describe, expect, it, vi } from "vitest";

// The disposable-database safety preflight (Phase 08C, ADR 0019). No connection is ever made: pg's Pool (and Client) are
// replaced by spies that throw, so a URL that slipped past the preflight would fail loudly with "CONNECTION ATTEMPTED" instead
// of reaching a server. The driver's own ConnectionParameters (which opens nothing) stays real: it is what the preflight checks.

const attempts = vi.hoisted(() => [] as unknown[]);
vi.mock("pg", async (importOriginal) => {
  const real = await importOriginal<typeof import("pg")>();
  const refuse = function (config: unknown) {
    attempts.push(config);
    throw new Error("CONNECTION ATTEMPTED");
  } as unknown as typeof real.Pool;
  return {
    ...real,
    Pool: refuse,
    Client: refuse,
    default: { ...real.default, Pool: refuse, Client: refuse },
  };
});

const {
  DISPOSABLE_DATABASE_NAME,
  PERSISTENT_DATABASE,
  assertDisposableName,
  createTestDatabase,
  disposableTarget,
  resolveAdminTarget,
} = await import("./helpers");

const LOCAL = "postgresql://postgres:postgres@localhost:5432/postgres";

afterEach(() => {
  vi.unstubAllEnvs();
  attempts.length = 0;
});

const refused = (raw: string | undefined) => {
  expect(() => resolveAdminTarget(raw), String(raw)).toThrow(/^Refusing to run DB tests/);
};

describe("database test harness preflight", () => {
  it("accepts ordinary explicitly configured local maintenance URLs, as an explicit target", () => {
    expect(resolveAdminTarget(LOCAL)).toEqual({
      host: "localhost",
      port: 5432,
      database: "postgres",
      user: "postgres",
      password: "postgres",
    });
    expect(resolveAdminTarget("postgres://tester@127.0.0.1/postgres")).toEqual({
      host: "127.0.0.1",
      port: 5432,
      database: "postgres",
      user: "tester",
      password: "",
    });
    expect(resolveAdminTarget("postgresql://u:p%40ss@[::1]:5433/postgres")).toMatchObject({
      host: "::1",
      port: 5433,
      password: "p@ss",
    });
  });

  it("1. refuses host, port, database and option overrides through query parameters", () => {
    for (const raw of [
      "postgresql://u:p@127.0.0.1/postgres?host=203.0.113.10", // the reviewer's reproduction
      "postgresql://u:p@localhost/postgres?host=%2Fvar%2Frun%2Fpostgresql",
      "postgresql://u:p@localhost/postgres?port=6543",
      "postgresql://u:p@localhost/postgres?db=al_ict_whatsapp",
      "postgresql://u:p@localhost/postgres?database=al_ict_whatsapp",
      "postgresql://u:p@localhost/postgres?options=-c%20search_path%3Dx",
      "postgresql://u:p@localhost/postgres?sslmode=disable",
      "postgresql://u:p@localhost/postgres?",
    ])
      refused(raw);
  });

  it("2. refuses Unix-socket routing and unsupported protocols", () => {
    for (const raw of [
      "socket://localhost/postgres?db=al_ict_whatsapp", // the reviewer's reproduction
      "socket://localhost/postgres",
      "socket:/var/run/postgresql",
      "/var/run/postgresql postgres",
      "postgresql://u@%2Fvar%2Frun%2Fpostgresql/postgres",
      "http://localhost:5432/postgres",
      "https://u:p@localhost/postgres",
      "mysql://u:p@localhost/postgres",
      "file:///var/run/postgresql/.s.PGSQL.5432",
      "pg://u:p@localhost/postgres",
    ])
      refused(raw);
  });

  it("3. never lets the effective database be al_ict_whatsapp (path, encoding, query or environment)", () => {
    for (const raw of [
      "postgresql://u:p@localhost:5432/al_ict_whatsapp",
      "postgresql://u:p@localhost:5432/al%5Fict%5Fwhatsapp",
      "postgresql://u:p@localhost:5432/AL_ICT_WHATSAPP",
      "postgresql://u:p@localhost:5432/postgres?db=al_ict_whatsapp",
      "socket://localhost/postgres?db=al_ict_whatsapp",
    ])
      refused(raw);
    // PGDATABASE cannot redirect an explicit target: the database is always set, so the driver never falls back to it.
    vi.stubEnv("PGDATABASE", PERSISTENT_DATABASE);
    expect(resolveAdminTarget(LOCAL).database).toBe("postgres");
  });

  it("4. refuses remote hosts, and environment variables that would route the driver elsewhere", () => {
    for (const raw of [
      "postgresql://u:p@db.example.com:5432/postgres",
      "postgresql://u:p@203.0.113.10/postgres",
      "postgresql://u:p@localhost.example.com/postgres",
      "postgresql://u:p@0.0.0.0/postgres",
      "postgresql://u:p@[::2]/postgres",
      "postgresql://u:p@/postgres", // empty host: the driver would take PGHOST
    ])
      refused(raw);
    // No port in the URL: the driver would use PGPORT, which differs from what was validated.
    vi.stubEnv("PGPORT", "6543");
    refused("postgresql://u:p@localhost/postgres");
    expect(resolveAdminTarget("postgresql://u:p@localhost:5432/postgres").port).toBe(5432);
    // PGHOST cannot redirect an explicit host.
    vi.stubEnv("PGHOST", "203.0.113.10");
    expect(resolveAdminTarget(LOCAL).host).toBe("localhost");
  });

  it("5. requires the maintenance database postgres exactly", () => {
    for (const raw of [
      "postgresql://u:p@localhost:5432/template1",
      "postgresql://u:p@localhost:5432/",
      "postgresql://u:p@localhost:5432",
      "postgresql://u:p@localhost:5432/Postgres",
      "postgresql://u:p@localhost:5432/postgres/",
      "postgresql://u:p@localhost:5432/postgre%73",
      "postgresql://u:p@localhost:5432/al_ict_test_0123456789ab",
    ])
      refused(raw);
  });

  it("6. fails closed without an explicit TEST_DATABASE_ADMIN_URL (no default, no DATABASE_URL)", async () => {
    refused(undefined);
    refused("");
    vi.stubEnv("TEST_DATABASE_ADMIN_URL", "");
    vi.stubEnv("DATABASE_URL", LOCAL);
    expect(() => resolveAdminTarget()).toThrow(/TEST_DATABASE_ADMIN_URL is not set/);
    await expect(createTestDatabase()).rejects.toThrow(/TEST_DATABASE_ADMIN_URL is not set/);
    expect(attempts).toEqual([]);
  });

  it("7. refuses malformed or unsupported connection strings without echoing them", () => {
    for (const raw of [
      "not a url",
      "localhost:5432/postgres",
      " postgresql://u:p@localhost/postgres",
      "postgresql://u:p@localhost/postgres ",
      "postgresql://u:p@local host/postgres",
      "postgresql://u:p@localhost:99999/postgres",
      "postgresql://u:p@localhost:port/postgres",
      "postgresql://u:%zz@localhost/postgres",
      "postgresql://localhost/postgres", // no explicit user
      "postgresql://u:p@localhost/postgres#fragment",
    ])
      refused(raw);
    const secret = "postgresql://u:s3cretPassw0rd@localhost/postgres?host=203.0.113.10";
    expect(() => resolveAdminTarget(secret)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("s3cretPassw0rd") }),
    );
    expect(() => resolveAdminTarget("postgresql://u:s3cretPassw0rd@local host/postgres")).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("s3cretPassw0rd") }),
    );
  });

  it("8. creates and drops only generated disposable names, never the persistent database", () => {
    expect(() => assertDisposableName("al_ict_test_0123456789ab")).not.toThrow();
    expect(() => assertDisposableName("al_ict_e2e_0123456789ab")).not.toThrow();
    for (const name of [
      PERSISTENT_DATABASE,
      "al_ict_test_",
      "al_ict_test_0123456789abc",
      "al_ict_test_0123456789AB",
      "al_ict_test_0123456789ab; DROP DATABASE al_ict_whatsapp",
      "postgres",
      "al_ict_whatsapp_test_0123456789ab",
    ]) {
      expect(() => assertDisposableName(name), name).toThrow(/Refusing/);
      expect(() => disposableTarget(resolveAdminTarget(LOCAL), name), name).toThrow(/Refusing/);
    }
    expect(DISPOSABLE_DATABASE_NAME.test(PERSISTENT_DATABASE)).toBe(false);
  });

  it("derives the disposable target and URL from the validated admin target, re-checked by the driver", () => {
    const admin = resolveAdminTarget("postgresql://us%3Aer:p%40%2F%3Fss@[::1]:5433/postgres");
    const { target, url } = disposableTarget(admin, "al_ict_test_0123456789ab");
    expect(target).toEqual({ ...admin, database: "al_ict_test_0123456789ab" });
    expect(url).not.toContain("?");
    expect(new URL(url).pathname).toBe("/al_ict_test_0123456789ab");
  });

  it("the harness refuses BEFORE creating any pool or client, and connects with the validated explicit config", async () => {
    for (const raw of [
      "postgresql://u:p@127.0.0.1/postgres?host=203.0.113.10",
      "socket://localhost/postgres?db=al_ict_whatsapp",
      "postgresql://u:p@localhost/al_ict_whatsapp",
    ]) {
      vi.stubEnv("TEST_DATABASE_ADMIN_URL", raw);
      await expect(createTestDatabase(), raw).rejects.toThrow(/^Refusing to run DB tests/);
    }
    expect(attempts).toEqual([]);
    // A valid URL passes the preflight and reaches pool creation (the spy, which throws instead of connecting) with an
    // explicit config: no connection string the driver could re-interpret.
    vi.stubEnv("TEST_DATABASE_ADMIN_URL", LOCAL);
    await expect(createTestDatabase()).rejects.toThrow("CONNECTION ATTEMPTED");
    expect(attempts).toEqual([
      {
        host: "localhost",
        port: 5432,
        database: "postgres",
        user: "postgres",
        password: "postgres",
        max: 1,
      },
    ]);
  });
});
