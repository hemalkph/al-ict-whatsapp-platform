import { describe, expect, it } from "vitest";
import { readWorkerConfig } from "./config";

const URL_OK = "postgresql://worker:s3cret-pw@localhost:5432/appdb";

describe("worker configuration (fail closed)", () => {
  it.each([undefined, "", "false"])("is disabled when WHATSAPP_WORKER_ENABLED is %j", (flag) => {
    expect(readWorkerConfig({ WHATSAPP_WORKER_ENABLED: flag, DATABASE_URL: URL_OK })).toEqual({
      kind: "disabled",
    });
  });

  it("is disabled without validating (or touching) anything else", () => {
    expect(readWorkerConfig({})).toEqual({ kind: "disabled" });
    expect(
      readWorkerConfig({ DATABASE_URL: "not a url", WHATSAPP_WORKER_BATCH_SIZE: "x" }),
    ).toEqual({
      kind: "disabled",
    });
  });

  it.each(["TRUE", "True", "1", "yes", "on", " true", "true ", "enabled"])(
    "refuses an enablement value that is not exactly true or false (%j)",
    (flag) => {
      const r = readWorkerConfig({ WHATSAPP_WORKER_ENABLED: flag, DATABASE_URL: URL_OK });
      expect(r.kind).toBe("invalid");
    },
  );

  it("is ready only for exactly true with a postgres URL, with the queue defaults", () => {
    expect(readWorkerConfig({ WHATSAPP_WORKER_ENABLED: "true", DATABASE_URL: URL_OK })).toEqual({
      kind: "ready",
      config: { databaseUrl: URL_OK, batchSize: 20, concurrency: 2 },
    });
    expect(
      readWorkerConfig({
        WHATSAPP_WORKER_ENABLED: "true",
        DATABASE_URL: "postgres://u@h/db",
        WHATSAPP_WORKER_BATCH_SIZE: "100",
        WHATSAPP_WORKER_CONCURRENCY: "8",
      }),
    ).toMatchObject({ kind: "ready", config: { batchSize: 100, concurrency: 8 } });
  });

  it.each([
    undefined,
    "",
    "mysql://u@h/db",
    "http://localhost/db",
    "postgresql://localhost",
    "nope",
  ])("rejects DATABASE_URL %j", (url) => {
    expect(readWorkerConfig({ WHATSAPP_WORKER_ENABLED: "true", DATABASE_URL: url }).kind).toBe(
      "invalid",
    );
  });

  it.each(["0", "-1", "101", "1.5", "abc", "20 ", "99999"])("rejects batch size %j", (value) => {
    expect(
      readWorkerConfig({
        WHATSAPP_WORKER_ENABLED: "true",
        DATABASE_URL: URL_OK,
        WHATSAPP_WORKER_BATCH_SIZE: value,
      }).kind,
    ).toBe("invalid");
  });

  it.each(["0", "9", "-2", "2.5", "many"])(
    "rejects concurrency %j (bounded, never unbounded)",
    (value) => {
      expect(
        readWorkerConfig({
          WHATSAPP_WORKER_ENABLED: "true",
          DATABASE_URL: URL_OK,
          WHATSAPP_WORKER_CONCURRENCY: value,
        }).kind,
      ).toBe("invalid");
    },
  );

  it("never puts a value (the database password above all) into a problem message", () => {
    const r = readWorkerConfig({
      WHATSAPP_WORKER_ENABLED: "maybe",
      DATABASE_URL: "mysql://worker:s3cret-pw@localhost/appdb",
      WHATSAPP_WORKER_BATCH_SIZE: "SECRET-BATCH",
    });
    expect(r.kind).toBe("invalid");
    const text = JSON.stringify(r);
    for (const leak of ["s3cret-pw", "mysql", "worker:", "SECRET-BATCH", "maybe"])
      expect(text, leak).not.toContain(leak);
    expect(text).toContain("DATABASE_URL");
  });

  it("requires no Meta credential", () => {
    const r = readWorkerConfig({ WHATSAPP_WORKER_ENABLED: "true", DATABASE_URL: URL_OK });
    expect(r.kind).toBe("ready"); // no META_APP_SECRET, verify token or access token present
  });
});
