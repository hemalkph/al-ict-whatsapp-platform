import { afterEach, describe, expect, it, vi } from "vitest";
import * as publicApi from "./index";
import { readAuthEnv } from "./env";

const SECRET = "x".repeat(40);

describe("auth environment (validated lazily)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { __alIctPublicAuth?: unknown }).__alIctPublicAuth;
  });

  it("accepts a valid secret and base URL and derives the trusted origin", () => {
    const env = readAuthEnv({
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "https://app.example.com/",
    });
    expect(env.origin).toBe("https://app.example.com");
    expect(env.baseURL).toBe("https://app.example.com");
    expect(env.secret).toBe(SECRET);
  });

  it.each([
    [{}, "BETTER_AUTH_SECRET"],
    [{ BETTER_AUTH_SECRET: "short", BETTER_AUTH_URL: "https://a.example" }, "BETTER_AUTH_SECRET"],
    [{ BETTER_AUTH_SECRET: SECRET }, "BETTER_AUTH_URL"],
    [{ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: "not a url" }, "BETTER_AUTH_URL"],
  ])("rejects %j naming %s but never echoing values", (source, name) => {
    let message = "";
    try {
      readAuthEnv(source);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(name);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("short");
  });

  it("requires https in production", () => {
    const source = { BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: "http://app.example.com" };
    expect(() => readAuthEnv(source, "production")).toThrow(/https/);
    expect(() => readAuthEnv(source, "development")).not.toThrow();
  });

  it("importing the module needs no auth env; creating the instance without env fails clearly", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    expect(typeof publicApi.getAuth).toBe("function"); // import already succeeded without env
    expect(() => publicApi.getAuth()).toThrow();
  });

  it("does NOT export the private provisioning instance from the public barrel", () => {
    const keys = Object.keys(publicApi);
    expect(keys).toEqual(
      expect.arrayContaining(["getAuth", "getSession", "readAuthEnv", "PUBLIC_DISABLED_PATHS"]),
    );
    for (const k of keys) expect(k).not.toMatch(/provision/i);
  });

  it("lists the generic user-mutation paths that stay closed on the public instance", () => {
    expect([...publicApi.PUBLIC_DISABLED_PATHS].sort()).toEqual(
      [
        "/change-email",
        "/delete-user",
        "/delete-user/callback",
        "/link-social",
        "/request-password-reset",
        "/reset-password",
        "/set-password",
        "/sign-up/email",
        "/update-user",
      ].sort(),
    );
  });
});
