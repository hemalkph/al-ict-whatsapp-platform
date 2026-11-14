import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { getIPFromHeader } from "@better-auth/core/utils/ip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CookieJar,
  RECOVERY,
  SIGN_OUT_MESSAGES,
  createOperatorClient,
  describeSignIn,
  parseBaseUrl,
} from "./platform-auth-proof";
import {
  ProofRefused,
  envFileNames,
  launch,
  neutralizeEnvFiles,
  validateProofEnvironment,
} from "./platform-auth-proof-server";
import { promptHidden } from "./prompt";

// Supplementary unit checks for the C1B-P1 proof client (the real HTTP/PostgreSQL evidence is in
// src/modules/platform/cli-auth-proof.db.test.ts). The stub HTTPS servers here are loopback-only and verified by a throwaway CA.

describe("parseBaseUrl", () => {
  it("accepts an https origin only", () => {
    expect(parseBaseUrl("https://127.0.0.1:3100")).toBe("https://127.0.0.1:3100");
    expect(parseBaseUrl("https://ops.example.test/")).toBe("https://ops.example.test");
    for (const bad of [
      "http://127.0.0.1:3100",
      "https://user:pw@127.0.0.1",
      "https://127.0.0.1/api",
      "https://127.0.0.1/?x=1",
      "https://127.0.0.1/#f",
      "ftp://127.0.0.1",
      "not a url",
    ])
      expect(() => parseBaseUrl(bad), bad).toThrow();
  });
});

describe("CookieJar (memory only)", () => {
  const S = "__Secure-better-auth.session_token";
  const D = "__Secure-better-auth.dont_remember";
  it("keeps several cookies, replaces by name, deletes on Max-Age=0, past Expires or empty value", () => {
    const jar = new CookieJar();
    jar.apply([
      `${S}=a.sig; Path=/; HttpOnly; Secure; SameSite=Lax`,
      `${D}=true.sig; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ]);
    expect(jar.header()).toBe(`${S}=a.sig; ${D}=true.sig`);
    jar.apply([`${S}=b.sig; Path=/; HttpOnly; Secure; SameSite=Lax`]);
    expect(jar.header()).toBe(`${S}=b.sig; ${D}=true.sig`);
    jar.apply([`${D}=; Max-Age=0; Path=/; HttpOnly; Secure`]);
    expect(jar.header()).toBe(`${S}=b.sig`);
    jar.apply([`${S}=c.sig; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure`]);
    expect(jar.header()).toBeUndefined();
  });
  it("expires cookies by Max-Age (which wins over Expires) and refuses cookies without Secure", () => {
    const jar = new CookieJar();
    jar.apply([`${S}=x; Max-Age=10; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure`], 1_000);
    expect(jar.header(10_999)).toBe(`${S}=x`);
    expect(jar.header(11_000)).toBeUndefined();
    jar.apply([`${S}=plain; Path=/; HttpOnly`]);
    expect(jar.header()).toBeUndefined();
    jar.apply([`${S}=y; Secure; HttpOnly; SameSite=Strict`]);
    expect(jar.describe()).toEqual([
      { name: S, secure: true, httpOnly: true, sameSite: "strict", path: null, persistent: false },
    ]);
    jar.clear();
    expect(jar.header()).toBeUndefined();
  });
});

describe("client against stub HTTPS servers", () => {
  let dir: string;
  let ca: Buffer;
  const servers: Server[] = [];
  const hits = new Map<string, number>(); // origin -> requests received

  /** `handler` returning null drops the connection without an answer (an unreachable server, from the client's side). */
  async function stub(
    handler: (
      path: string,
    ) => { status: number; headers?: Record<string, string>; body?: string } | null,
  ) {
    let origin = "";
    const server = createServer(
      { key: readFileSync(join(dir, "key.pem")), cert: ca },
      (req, res) => {
        hits.set(origin, (hits.get(origin) ?? 0) + 1);
        req.resume();
        req.on("end", () => {
          const r = handler(req.url ?? "");
          if (r === null) req.socket.destroy();
          else res.writeHead(r.status, r.headers).end(r.body ?? "");
        });
      },
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    return origin;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "al-ict-c1b-p1-unit-"));
    const res = spawnSync(
      "openssl",
      [
        ...[
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=127.0.0.1",
        ],
        ...[
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-keyout",
          join(dir, "key.pem"),
          "-out",
          join(dir, "cert.pem"),
        ],
      ],
      { env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv, stdio: "ignore" },
    );
    if (res.status !== 0) throw new Error("openssl failed");
    ca = readFileSync(join(dir, "cert.pem"));
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    rmSync(dir, { recursive: true, force: true });
  });

  const SESSION =
    "__Secure-better-auth.session_token=tok.sig; Path=/; HttpOnly; Secure; SameSite=Lax";
  const signInOk = {
    status: 200,
    headers: { "set-cookie": SESSION, "content-type": "application/json" },
    body: '{"user":{"id":"u1"}}',
  };

  it("never follows a redirect: the cookie is not sent to the Location", async () => {
    const elsewhere = await stub(() => ({ status: 200 }));
    const origin = await stub((path) =>
      path === "/api/auth/sign-in/email"
        ? signInOk
        : { status: 302, headers: { location: `${elsewhere}/steal` } },
    );
    const client = createOperatorClient({ baseUrl: origin, ca });
    expect(await client.signIn("a@example.test", "pw")).toEqual({
      ok: true,
      previousSession: "NO_SESSION",
    });
    await expect(client.get("/api/platform/audit")).rejects.toThrow(/Redirect refused/);
    expect(hits.get(elsewhere)).toBeUndefined();
    await expect(client.get("//evil.example/x")).rejects.toThrow(/origin-relative/);
  });

  it("reports UNCONFIRMED when sign-out cannot be verified, and clears local state anyway", async () => {
    const origin = await stub((path) =>
      path === "/api/auth/sign-in/email"
        ? signInOk
        : path === "/api/auth/sign-out"
          ? { status: 200, body: '{"success":true}' }
          : { status: 500 },
    );
    const client = createOperatorClient({ baseUrl: origin, ca });
    await client.signIn("a@example.test", "pw");
    expect(await client.signOut()).toBe("UNCONFIRMED");
    expect(client.hasSession()).toBe(false);
  });

  it("reports UNCONFIRMED when the server is unreachable at sign-out", async () => {
    const origin = await stub((path) =>
      path === "/api/auth/sign-in/email" ? signInOk : { status: 200, body: "null" },
    );
    const client = createOperatorClient({ baseUrl: origin, ca });
    await client.signIn("a@example.test", "pw");
    const server = servers.at(-1)!;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    expect(await client.signOut()).toBe("UNCONFIRMED");
    expect(client.hasSession()).toBe(false);
  });

  it("re-authentication with an unreachable cleanup: the new session is held and the old one reported UNCONFIRMED, no retry", async () => {
    let signOuts = 0;
    const origin = await stub((path) => {
      if (path === "/api/auth/sign-in/email") return signInOk;
      if (path === "/api/auth/sign-out") {
        signOuts++;
        return null; // the connection drops before any answer
      }
      return { status: 200, body: "null" };
    });
    const client = createOperatorClient({ baseUrl: origin, ca });
    await client.signIn("a@example.test", "pw");
    const res = await client.signIn("a@example.test", "pw");
    expect(res).toEqual({ ok: true, previousSession: "UNCONFIRMED" });
    expect(describeSignIn(res)).toMatch(/could not be confirmed; treat it as still accepted/);
    expect(client.hasSession()).toBe(true);
    expect(client.userId).toBe("u1");
    expect(signOuts).toBe(1);
  });

  it("an identity switch keeps the held session; a refused sign-in leaves it untouched", async () => {
    let user = "u1";
    const origin = await stub((path) =>
      path === "/api/auth/sign-in/email"
        ? { ...signInOk, body: `{"user":{"id":"${user}"}}` }
        : path === "/api/auth/get-session"
          ? { status: 200, body: "null" }
          : { status: 200, body: '{"success":true}' },
    );
    const client = createOperatorClient({ baseUrl: origin, ca });
    await client.signIn("a@example.test", "pw");
    user = "u2";
    const res = await client.signIn("b@example.test", "pw");
    expect(res).toEqual({
      ok: false,
      status: 200,
      reason: "identity_changed",
      rejectedSession: "CONFIRMED",
    });
    expect(client.userId).toBe("u1");
    expect(client.hasSession()).toBe(true);
  });
});

describe("operator-visible wording", () => {
  it("never claims an unverified ending and never offers sign-in-and-sign-out as recovery", () => {
    expect(describeSignIn({ ok: true, previousSession: "NO_SESSION" })).toBe("Signed in.");
    expect(describeSignIn({ ok: true, previousSession: "NOT_REVOKED" })).toMatch(
      /could NOT be ended.*still accepts it/,
    );
    expect(describeSignIn({ ok: false, status: 429 })).toBe("Sign-in refused (HTTP 429).");
    for (const text of [SIGN_OUT_MESSAGES.NOT_REVOKED, SIGN_OUT_MESSAGES.UNCONFIRMED, RECOVERY]) {
      expect(text).not.toMatch(/sign in again and sign out/i);
      expect(text).toMatch(/\/revoke-other-sessions.*\/list-sessions/);
      expect(text).toMatch(
        /only by revoking its platform role, which also removes its platform access/,
      );
    }
  });
});

describe("proof server launcher: refusal before any connection or listener", () => {
  const NONCE = "ab".repeat(32);
  const GOOD_DB = "postgresql://postgres:pw@127.0.0.1:55432/al_ict_test_0123456789ab";
  const base = (): Record<string, string | undefined> => ({
    NODE_ENV: "production",
    DATABASE_URL: GOOD_DB,
    E2E_HOST: "127.0.0.1",
    E2E_PORT: "3123",
    BETTER_AUTH_URL: "https://127.0.0.1:3123",
    PROOF_BINDING_NONCE: NONCE,
    WHATSAPP_OUTBOUND_ENABLED: "false",
    WHATSAPP_LIVE_SEND_ENABLED: "false",
    WHATSAPP_WORKER_ENABLED: "false",
    BOTS_RUNTIME_ENABLED: "false",
    PGHOST: "", // blank overrides are fine: they shadow env files
  });
  const deps = () => {
    const envFiles: string[] = [];
    return {
      envFiles,
      envFileNames: () => envFiles,
      verifyBinding: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
    };
  };

  it("accepts the harness environment and only then connects and starts, in that order", async () => {
    const d = deps();
    await launch(base(), d);
    expect(d.verifyBinding).toHaveBeenCalledWith(
      {
        host: "127.0.0.1",
        port: 55432,
        database: "al_ict_test_0123456789ab",
        user: "postgres",
        password: "pw",
      },
      NONCE,
    );
    expect(d.start).toHaveBeenCalledTimes(1);
    expect(d.verifyBinding.mock.invocationCallOrder[0]!).toBeLessThan(
      d.start.mock.invocationCallOrder[0]!,
    );
  });

  const refusals: Array<[string, Record<string, string | undefined>]> = [
    [
      "permanent database",
      { DATABASE_URL: "postgresql://postgres:pw@127.0.0.1:55432/al_ict_whatsapp" },
    ],
    [
      "permanent database, encoded",
      { DATABASE_URL: "postgresql://postgres:pw@127.0.0.1:55432/al%5Fict%5Fwhatsapp" },
    ],
    [
      "other application database",
      { DATABASE_URL: "postgresql://postgres:pw@127.0.0.1:55432/postgres" },
    ],
    [
      "E2E-prefixed database",
      { DATABASE_URL: "postgresql://postgres:pw@127.0.0.1:55432/al_ict_e2e_0123456789ab" },
    ],
    [
      "upper-case name",
      { DATABASE_URL: "postgresql://postgres:pw@127.0.0.1:55432/al_ict_test_0123456789AB" },
    ],
    ["short name", { DATABASE_URL: "postgresql://postgres:pw@127.0.0.1:55432/al_ict_test_0123" }],
    [
      "localhost",
      { DATABASE_URL: "postgresql://postgres:pw@localhost:55432/al_ict_test_0123456789ab" },
    ],
    [
      "IPv6 loopback",
      { DATABASE_URL: "postgresql://postgres:pw@[::1]:55432/al_ict_test_0123456789ab" },
    ],
    [
      "remote host",
      { DATABASE_URL: "postgresql://postgres:pw@10.0.0.5:55432/al_ict_test_0123456789ab" },
    ],
    [
      "default port",
      { DATABASE_URL: "postgresql://postgres:pw@127.0.0.1/al_ict_test_0123456789ab" },
    ],
    [
      "other port",
      { DATABASE_URL: "postgresql://postgres:pw@127.0.0.1:5432/al_ict_test_0123456789ab" },
    ],
    ["query override", { DATABASE_URL: `${GOOD_DB}?host=10.0.0.5` }],
    ["socket protocol", { DATABASE_URL: "socket:/var/run/postgresql?db=al_ict_test_0123456789ab" }],
    ["no user", { DATABASE_URL: "postgresql://127.0.0.1:55432/al_ict_test_0123456789ab" }],
    ["malformed", { DATABASE_URL: "not a url" }],
    ["missing", { DATABASE_URL: undefined }],
    ["PGHOST override", { PGHOST: "10.0.0.5" }],
    ["PGDATABASE override", { PGDATABASE: "al_ict_whatsapp" }],
    [
      "admin URL present",
      { TEST_DATABASE_ADMIN_URL: "postgresql://postgres:pw@127.0.0.1:55432/postgres" },
    ],
    ["second database URL", { DATABASE_URL_UNPOOLED: "postgresql://x@10.0.0.5/al_ict_whatsapp" }],
    ["TLS verification off", { NODE_TLS_REJECT_UNAUTHORIZED: "0" }],
    ["NODE_OPTIONS", { NODE_OPTIONS: "--require ./evil.js" }],
    ["a WhatsApp token", { WA_TOKEN_MAIN: "x" }],
    ["live send gate", { WHATSAPP_LIVE_SEND_ENABLED: "true" }],
    ["worker gate missing", { WHATSAPP_WORKER_ENABLED: undefined }],
    ["not production", { NODE_ENV: "test" }],
    ["public host", { E2E_HOST: "0.0.0.0" }],
    ["foreign auth URL", { BETTER_AUTH_URL: "https://ops.example.test" }],
    ["http auth URL", { BETTER_AUTH_URL: "http://127.0.0.1:3123" }],
    ["missing binding nonce", { PROOF_BINDING_NONCE: undefined }],
    ["malformed binding nonce", { PROOF_BINDING_NONCE: "not-hex" }],
  ];
  for (const [label, override] of refusals)
    it(`refuses: ${label}`, async () => {
      const d = deps();
      const env = { ...base(), ...override };
      for (const [k, v] of Object.entries(override)) if (v === undefined) delete env[k];
      await expect(launch(env, d)).rejects.toBeInstanceOf(ProofRefused);
      await expect(launch(env, d)).rejects.not.toThrow(/pw@|:pw/); // no credential echoed
      expect(d.verifyBinding).not.toHaveBeenCalled();
      expect(d.start).not.toHaveBeenCalled();
    });

  it("an env-file name the process does not define is blanked first, so it cannot supply a database or gate", async () => {
    const d = deps();
    const env = base();
    delete env.DATABASE_URL;
    d.envFiles.push("DATABASE_URL", "PGHOST", "WA_TOKEN_MAIN");
    await expect(launch(env, d)).rejects.toBeInstanceOf(ProofRefused);
    expect(env).toMatchObject({ DATABASE_URL: "", WA_TOKEN_MAIN: "" });
    expect(env.PGHOST).toBe(""); // already defined (blank) by the harness: unchanged
    expect(d.verifyBinding).not.toHaveBeenCalled();
  });

  it("validateProofEnvironment opens nothing (pure)", () => {
    expect(() =>
      validateProofEnvironment({
        ...base(),
        DATABASE_URL: "postgresql://postgres:pw@127.0.0.1:55432/al_ict_whatsapp",
      }),
    ).toThrow(ProofRefused);
  });

  it("a failure to list the env files refuses before any connection", async () => {
    const d = deps();
    await expect(
      launch(base(), {
        ...d,
        envFileNames: () => {
          throw new ProofRefused("Next's env files could not be listed");
        },
      }),
    ).rejects.toThrow("Next's env files could not be listed");
    expect(d.verifyBinding).not.toHaveBeenCalled();
    expect(d.start).not.toHaveBeenCalled();
  });
});

describe("env files: names come from Next's own loader, and neutralization holds through Next's real env loading", () => {
  let dir: string;
  // Synthetic values only. Colon assignments, `export`, quoted and multi-line values, [\w.-] names: Next's dotenv grammar.
  const ENV_LOCAL = [
    "PGOPTIONS: -c search_path=evil",
    "PGHOST: 10.9.9.9",
    "PGPORT:5433", // no space after the colon: NOT an assignment in Next's grammar (neither listed nor loaded)
    "export PGDATABASE=al_ict_whatsapp",
    'DATABASE_URL="postgresql://x@10.0.0.5:5432/al_ict_whatsapp"',
    "WA_TOKEN_MAIN: 'synthetic-token'",
    "WHATSAPP_LIVE_SEND_ENABLED: true",
    'MULTI_LINE="a',
    'b"',
    "DOTTED.NAME-X=1",
    "# COMMENTED=1",
  ].join("\n");
  const ENV_PRODUCTION = "PGSSLMODE: disable\n";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "al-ict-c1b-p1-env-"));
    // Next resolves `next` from the directory it loads; the listing child resolves it the same way, so link node_modules.
    symlinkSync(join(process.cwd(), "node_modules"), join(dir, "node_modules"), "dir");
    writeFileSync(join(dir, ".env.local"), ENV_LOCAL);
    writeFileSync(join(dir, ".env.production"), ENV_PRODUCTION);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("lists colon-style PG overrides (PGOPTIONS, PGHOST), export, quoted, multi-line and dotted names, in every production file", () => {
    const names = envFileNames(dir).sort();
    expect(names).toEqual(
      [
        "DATABASE_URL",
        "DOTTED.NAME-X",
        "MULTI_LINE",
        "PGDATABASE",
        "PGHOST",
        "PGOPTIONS",
        "PGSSLMODE",
        "WA_TOKEN_MAIN",
        "WHATSAPP_LIVE_SEND_ENABLED",
      ].sort(),
    );
  });

  /** Runs Next's real loadEnvConfig on `dir` in a child with `env`, and reports ONLY whether each name ended up as expected. */
  const effective = (env: Record<string, string>, expected: Record<string, string>) => {
    const script = `
      const { createRequire } = require("node:module");
      const r = createRequire(require.resolve("next/package.json", { paths: [process.cwd()] }));
      r("@next/env").loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
      const expected = JSON.parse(process.argv[1]);
      process.stdout.write(JSON.stringify(Object.fromEntries(Object.keys(expected).map((k) => [k, process.env[k] === expected[k]]))));`;
    const res = spawnSync(process.execPath, ["-e", script, JSON.stringify(expected)], {
      cwd: dir,
      env: env as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    return JSON.parse(res.stdout) as Record<string, boolean>;
  };

  it("after neutralization Next's own loading leaves every listed name blank and keeps the harness values", () => {
    const harness = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://postgres:pw@127.0.0.1:55432/al_ict_test_0123456789ab",
      WHATSAPP_LIVE_SEND_ENABLED: "false",
    };
    const env: Record<string, string | undefined> = { ...harness };
    neutralizeEnvFiles(env, envFileNames(dir));
    const result = effective(env as Record<string, string>, {
      PGOPTIONS: "",
      PGHOST: "",
      PGDATABASE: "",
      PGSSLMODE: "",
      WA_TOKEN_MAIN: "",
      DATABASE_URL: harness.DATABASE_URL,
      WHATSAPP_LIVE_SEND_ENABLED: "false",
    });
    expect(Object.values(result).every(Boolean), JSON.stringify(result)).toBe(true);
    // ...and the effective environment passes the launcher's checks (blank PG* names are allowed).
    expect(() =>
      validateProofEnvironment({
        ...env,
        E2E_HOST: "127.0.0.1",
        E2E_PORT: "3123",
        BETTER_AUTH_URL: "https://127.0.0.1:3123",
        PROOF_BINDING_NONCE: "ab".repeat(32),
        WHATSAPP_OUTBOUND_ENABLED: "false",
        WHATSAPP_WORKER_ENABLED: "false",
        BOTS_RUNTIME_ENABLED: "false",
      }),
    ).not.toThrow();
  });

  it("control: WITHOUT neutralization Next would load the colon-style PGOPTIONS, and the launcher refuses it", () => {
    const result = effective(
      { NODE_ENV: "production" },
      { PGOPTIONS: "-c search_path=evil", PGHOST: "10.9.9.9" },
    );
    expect(result).toEqual({ PGOPTIONS: true, PGHOST: true });
    // The listing and Next agree on the grammar edge: a colon without a following space assigns nothing.
    expect(effective({ NODE_ENV: "production" }, { PGPORT: "5433" })).toEqual({ PGPORT: false });
    expect(envFileNames(dir)).not.toContain("PGPORT");
    expect(() =>
      validateProofEnvironment({
        NODE_ENV: "production",
        PGOPTIONS: "-c search_path=evil",
      }),
    ).toThrow("PGOPTIONS must not be set");
  });

  it("the previous key scanner would have missed them (documents the defect this replaces)", () => {
    const old = [...ENV_LOCAL.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(
      (m) => m[1],
    );
    expect(old).not.toContain("PGOPTIONS");
    expect(old).not.toContain("PGHOST");
  });
});

describe("promptHidden (scripts/prompt.ts)", () => {
  function fakeTerminal(isTTY = true) {
    const stdin = Object.assign(new PassThrough(), {
      isTTY,
      modes: [] as boolean[],
      setRawMode(mode: boolean) {
        stdin.modes.push(mode);
        return stdin;
      },
    });
    const written: string[] = [];
    const spies = [
      vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin),
      vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
        written.push(String(c));
        return true;
      }),
    ];
    return { stdin, written, restore: () => spies.forEach((s) => s.mockRestore()) };
  }

  it("reads in raw mode without echo, honours backspace, restores the terminal", async () => {
    const term = fakeTerminal();
    try {
      const p = promptHidden("Password: ");
      term.stdin.write("secrex\u007ft\r");
      expect(await p).toBe("secret");
      expect(term.written.join("")).toBe("Password: \n");
      expect(term.stdin.modes).toEqual([true, false]);
    } finally {
      term.restore();
    }
  });

  it("Ctrl-C cancels; no terminal means no prompt", async () => {
    const term = fakeTerminal();
    try {
      const p = promptHidden("Password: ");
      term.stdin.write("sec\u0003");
      await expect(p).rejects.toThrow("Cancelled.");
      expect(term.stdin.modes).toEqual([true, false]);
    } finally {
      term.restore();
    }
    const pipe = fakeTerminal(false);
    try {
      await expect(promptHidden("Password: ")).rejects.toThrow(/No interactive terminal/);
    } finally {
      pipe.restore();
    }
  });
});

describe("Better Auth 1.7.7 forwarded-IP rule (production prerequisite evidence; no configuration is changed)", () => {
  it("without trustedProxies only a single valid address is trusted, so the client chooses it", () => {
    expect(getIPFromHeader("203.0.113.9")).toBe("203.0.113.9"); // whatever the client sends
    expect(getIPFromHeader("203.0.113.9, 10.0.0.1")).toBeNull(); // appended by a proxy: shared fallback bucket
    expect(getIPFromHeader("garbage")).toBeNull();
  });
  it("with trustedProxies the rightmost untrusted hop is the client, so a prepended spoof is ignored", () => {
    const opts = { trustedProxies: ["10.0.0.0/8"] };
    expect(getIPFromHeader("6.6.6.6, 203.0.113.9, 10.0.0.1", opts)).toBe("203.0.113.9");
    expect(getIPFromHeader("203.0.113.9, 10.0.0.1, 10.0.0.2", opts)).toBe("203.0.113.9");
    expect(getIPFromHeader("10.0.0.1", opts)).toBeNull(); // only proxies: no client address
  });
});
