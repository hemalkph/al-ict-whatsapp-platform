import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_IP_HEADER, trustedClientIp } from "./client-ip";
import { readAuthEnv } from "./env";
import { handleAuthRequest } from "./handler";

// Phase 08G-7B C1B-P3: the trusted client-IP contract (client-ip.ts). Pure: no database, no Better Auth instance.

const never = () => false;
const ip = (value: string | null, extra: Record<string, string> = {}) =>
  trustedClientIp(
    new Headers(value === null ? extra : { [CLIENT_IP_HEADER]: value, ...extra }),
    never,
  );

describe("trustedClientIp", () => {
  it("accepts one IPv4 address unchanged", () => {
    expect(ip("203.0.113.7")).toBe("203.0.113.7");
    expect(ip(" 203.0.113.7 ")).toBe("203.0.113.7");
  });

  it("masks IPv6 to its /64 in one canonical lowercase form", () => {
    expect(ip("2001:DB8:AB:CD:1:2:3:4")).toBe("2001:0db8:00ab:00cd:0000:0000:0000:0000");
    expect(ip("2001:db8:ab:cd::ffff")).toBe(ip("2001:DB8:AB:CD:1:2:3:4"));
    expect(ip("2001:db8:ab:ce::1")).not.toBe(ip("2001:db8:ab:cd::1"));
  });

  it("turns IPv4-mapped IPv6 into the IPv4 address (one identity, not two)", () => {
    expect(ip("::ffff:198.51.100.9")).toBe("198.51.100.9");
    expect(ip("::FFFF:c633:6409")).toBe("198.51.100.9");
    expect(ip("0:0:0:0:0:ffff:198.51.100.9")).toBe("198.51.100.9");
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["comma chain", "203.0.113.7, 10.0.0.1"],
    ["same address twice", "203.0.113.7,203.0.113.7"],
    ["trailing comma", "203.0.113.7,"],
    ["leading comma", ",203.0.113.7"],
    ["whitespace-only extra element", "203.0.113.7, "],
    ["whitespace-only leading element", " , 203.0.113.7"],
    ["only commas", ",,"],
    ["space separated", "203.0.113.7 10.0.0.1"],
    ["port", "203.0.113.7:443"],
    ["bracketed IPv6", "[2001:db8::1]"],
    ["zone id", "fe80::1%eth0"],
    ["CIDR", "203.0.113.0/24"],
    ["octet out of range", "999.1.1.1"],
    ["leading zeros", "203.000.113.007"],
    ["hostname", "localhost"],
    ["text", "unknown"],
    ["too many IPv6 groups", "1:2:3:4:5:6:7:8:9"],
  ])("rejects a malformed value: %s", (_name, value) => {
    expect(ip(value)).toBeNull();
  });

  it("rejects a repeated header (Headers joins the copies into a chain)", () => {
    const headers = new Headers();
    headers.append(CLIENT_IP_HEADER, "203.0.113.7");
    headers.append(CLIENT_IP_HEADER, "203.0.113.7");
    expect(trustedClientIp(headers, never)).toBeNull();
  });

  it("rejects a repeated header whose other copy is empty", () => {
    for (const [first, second] of [
      ["203.0.113.7", ""],
      ["", "203.0.113.7"],
    ] as const) {
      const headers = new Headers();
      headers.append(CLIENT_IP_HEADER, first);
      headers.append(CLIENT_IP_HEADER, second);
      expect(trustedClientIp(headers, never)).toBeNull();
    }
  });

  it("never falls back to X-Forwarded-For, X-Real-IP or Forwarded", () => {
    const forged = {
      "x-forwarded-for": "198.51.100.1",
      "x-real-ip": "198.51.100.2",
      forwarded: "for=198.51.100.3",
    };
    expect(ip(null, forged)).toBeNull();
    expect(ip("not-an-ip", forged)).toBeNull();
    expect(ip("203.0.113.7", forged)).toBe("203.0.113.7");
  });

  it("local fallback fills in ONLY an absent header, never an invalid one", () => {
    expect(trustedClientIp(new Headers(), () => true)).toBe("127.0.0.1");
    expect(trustedClientIp(new Headers({ [CLIENT_IP_HEADER]: "nope" }), () => true)).toBeNull();
    expect(
      trustedClientIp(new Headers({ [CLIENT_IP_HEADER]: "1.2.3.4,5.6.7.8" }), () => true),
    ).toBeNull();
  });

  it("the development server binds to loopback only (the local fallback does not verify the peer)", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string>; dependencies: Record<string, string> };
    expect(pkg.scripts.dev).toBe("next dev --hostname 127.0.0.1");
    expect(pkg.dependencies["@better-auth/core"]).toBe(pkg.dependencies["better-auth"]); // declared, exact, same version
  });

  it("parses with the SAME @better-auth/core build that better-auth itself uses", () => {
    const version = (name: string) =>
      JSON.parse(
        readFileSync(
          new URL(`../../../node_modules/${name}/package.json`, import.meta.url),
          "utf8",
        ),
      ) as { version: string; dependencies?: Record<string, string> };
    expect(version("@better-auth/core").version).toBe(
      version("better-auth").dependencies?.["@better-auth/core"],
    );
  });
});

describe("BETTER_AUTH_LOCAL_INGRESS (readAuthEnv)", () => {
  const base = { BETTER_AUTH_SECRET: "s".repeat(48) };
  const local = { ...base, BETTER_AUTH_URL: "http://localhost:3000" };

  it("is off unless set", () => {
    expect(readAuthEnv(local, "development").loopbackClientIp).toBe(false);
    expect(
      readAuthEnv({ ...local, BETTER_AUTH_LOCAL_INGRESS: "" }, "development").loopbackClientIp,
    ).toBe(false);
  });

  it("is on only for the exact value, outside production, with a loopback URL", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "https://[::1]:3000"])
      expect(
        readAuthEnv(
          { ...base, BETTER_AUTH_URL: url, BETTER_AUTH_LOCAL_INGRESS: "loopback" },
          "development",
        ).loopbackClientIp,
      ).toBe(true);
  });

  it.each([
    ["production", { ...base, BETTER_AUTH_URL: "https://localhost:3000" }, "production"],
    ["a public URL", { ...base, BETTER_AUTH_URL: "https://app.example.com" }, "development"],
    ["a lookalike host", { ...base, BETTER_AUTH_URL: "http://localhost.example.com" }, "test"],
  ])("refuses to start with it in %s", (_name, source, nodeEnv) => {
    expect(() =>
      readAuthEnv({ ...source, BETTER_AUTH_LOCAL_INGRESS: "loopback" }, nodeEnv),
    ).toThrow(/BETTER_AUTH_LOCAL_INGRESS/);
  });

  it.each(["true", "1", "LOOPBACK", "any"])("refuses the unknown value %s", (value) => {
    expect(() =>
      readAuthEnv({ ...local, BETTER_AUTH_LOCAL_INGRESS: value }, "development"),
    ).toThrow(/BETTER_AUTH_LOCAL_INGRESS/);
  });
});

describe("handleAuthRequest guard", () => {
  afterEach(() => vi.unstubAllEnvs());

  const strictEnv = () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(48));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("BETTER_AUTH_LOCAL_INGRESS", "");
  };
  const recorder = () => {
    const seen: Request[] = [];
    return {
      seen,
      handler: async (request: Request) => (
        seen.push(request),
        new Response("{}", { status: 200 })
      ),
    };
  };
  const request = (headers: Record<string, string>, method = "POST") =>
    new Request("http://localhost:3000/api/auth/sign-in/email", {
      method,
      headers: { "content-type": "application/json", ...headers },
      body:
        method === "POST" ? JSON.stringify({ email: "a@example.com", password: "p" }) : undefined,
    });

  it("rejects a missing or invalid client IP with a fixed 403 before Better Auth is called (every method)", async () => {
    strictEnv();
    const auth = recorder();
    for (const [headers, method] of [
      [{}, "POST"],
      [{}, "GET"],
      [{ "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" }, "POST"],
      [{ [CLIENT_IP_HEADER]: "198.51.100.1, 198.51.100.2" }, "POST"],
      [{ [CLIENT_IP_HEADER]: "SECRET-MARKER-not-an-ip" }, "POST"],
    ] as const) {
      const res = await handleAuthRequest(request(headers, method), auth);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('{"code":"CLIENT_IP_REQUIRED","message":"Request rejected."}');
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(auth.seen).toHaveLength(0);
  });

  it("hands Better Auth the validated value in canonical form and leaves the body readable", async () => {
    strictEnv();
    const auth = recorder();
    const res = await handleAuthRequest(
      request({ [CLIENT_IP_HEADER]: "::ffff:203.0.113.7", "x-forwarded-for": "198.51.100.1" }),
      auth,
    );
    expect(res.status).toBe(200);
    expect(auth.seen[0]!.headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.7");
    expect(await auth.seen[0]!.json()).toEqual({ email: "a@example.com", password: "p" });
  });

  it("the explicit local fallback supplies loopback for an absent header only", async () => {
    strictEnv();
    vi.stubEnv("BETTER_AUTH_LOCAL_INGRESS", "loopback");
    const auth = recorder();
    expect(
      (await handleAuthRequest(request({ "x-forwarded-for": "198.51.100.1" }), auth)).status,
    ).toBe(200);
    expect(auth.seen[0]!.headers.get(CLIENT_IP_HEADER)).toBe("127.0.0.1");
    expect((await handleAuthRequest(request({ [CLIENT_IP_HEADER]: "x" }), auth)).status).toBe(403);
    expect(auth.seen).toHaveLength(1);
  });
});
