import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { controlPortFor, isBotsOnly, runMode } from "../e2e/support/mode";
import { childEnv, serverEnv } from "../e2e/support/server-env";
import { runCleanup } from "./e2e-cleanup";
import { readOutboundConfig } from "../src/modules/messaging/config";

// The E2E servers must fail closed whatever the shell, CI or a `.env.local` says. Playwright merges the server env over the
// inherited environment, so "effective" below is exactly {...inherited, ...serverEnv}.

const HARNESS = {
  E2E_DATABASE_URL: "postgres://disposable/al_ict_e2e_x",
  E2E_AUTH_SECRET: "e2e-auth-secret",
  E2E_META_APP_SECRET: "e2e-meta-secret",
  E2E_WEBHOOK_VERIFY_TOKEN: "e2e-verify",
  E2E_HOST: "127.0.0.1",
  E2E_PORT: "3100",
  E2E_CONTROL_PORT: "3101",
  E2E_TLS_DIR: "/tmp/tls",
};
const hostile = {
  ...HARNESS,
  WHATSAPP_OUTBOUND_ENABLED: "true",
  WHATSAPP_LIVE_SEND_ENABLED: "true",
  WHATSAPP_BSUID_RECIPIENT_ENABLED: "true",
  WHATSAPP_ALLOW_PII_REVEAL: "true",
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
  WHATSAPP_SOME_FUTURE_GATE: "true",
  WA_TOKEN_E2E_UNUSED: "EAAreal-looking-token",
  WA_TOKEN_PRODUCTION: "EAAanother",
  META_ACCESS_TOKEN: "EAAthird",
  META_APP_SECRET: "the-real-app-secret",
  DATABASE_URL: "postgres://prod.example.com/al_ict_whatsapp",
  DATABASE_URL_UNPOOLED: "postgres://prod.example.com/al_ict_whatsapp",
  TEST_DATABASE_ADMIN_URL: "postgres://prod.example.com/postgres",
  BETTER_AUTH_SECRET: "real-secret",
  BETTER_AUTH_URL: "https://real.example.com",
  BOOTSTRAP_ADMIN_PASSWORD: "x",
  INBOX_POLL_LIST_MS: "3000",
  BOTS_RUNTIME_ENABLED: "true",
  BOTS_WORKER_ENABLED: "true",
  BOTS_SOME_FUTURE_GATE: "1",
  PATH: "/usr/bin",
  NODE_ENV: "development",
};
const effective = (outboundEnabled: boolean): Record<string, string> => ({
  ...hostile,
  ...serverEnv(hostile, {
    outboundEnabled,
    baseURL: "https://127.0.0.1:3100",
    port: "3100",
    controlPort: "3101",
  }),
});

describe("E2E application servers fail closed against a hostile inherited environment", () => {
  for (const outboundEnabled of [true, false]) {
    it(`outbound queueing ${outboundEnabled ? "on" : "off"}: live sending, BSUID sending, credentials and the real database stay unreachable`, () => {
      const env = effective(outboundEnabled);
      const config = readOutboundConfig(env);
      expect(config.outboundEnabled).toBe(outboundEnabled); // the only gate that differs, and explicit
      expect(config.liveSendEnabled).toBe(false);
      expect(config.botsRuntimeEnabled).toBe(false); // pinned, not inherited
      expect(env.BOTS_RUNTIME_ENABLED).toBe("false");
      expect(env.BOTS_WORKER_ENABLED).toBe(""); // every other BOTS_ name is blanked
      expect(env.BOTS_SOME_FUTURE_GATE).toBe("");
      expect(config.bsuidRecipientEnabled).toBe(false);
      expect(config.graphApiVersion).toBeNull(); // a live send could not even be configured
      expect(env.WHATSAPP_ALLOW_PII_REVEAL).toBe("false");
      expect(env.WA_TOKEN_E2E_UNUSED).toBe(""); // the seeded credential reference resolves to nothing
      expect(env.WA_TOKEN_PRODUCTION).toBe("");
      expect(env.META_ACCESS_TOKEN).toBe("");
      expect(env.WHATSAPP_SOME_FUTURE_GATE).toBe(""); // unknown names of the sensitive families are blanked, not inherited
      expect(env.META_APP_SECRET).toBe(HARNESS.E2E_META_APP_SECRET);
      expect(env.DATABASE_URL).toBe(HARNESS.E2E_DATABASE_URL);
      expect(env.DATABASE_URL_UNPOOLED).toBe("");
      expect(env.TEST_DATABASE_ADMIN_URL).toBe("");
      expect(env.BETTER_AUTH_SECRET).toBe(HARNESS.E2E_AUTH_SECRET);
      expect(env.BETTER_AUTH_URL).toBe("https://127.0.0.1:3100");
      expect(env.BOOTSTRAP_ADMIN_PASSWORD).toBe("");
      expect(env.INBOX_POLL_LIST_MS).toBe("");
      expect(env.NODE_ENV).toBe("production");
    });
  }

  it("a shell that sets nothing gets the same explicit gates", () => {
    const env = serverEnv(HARNESS, {
      outboundEnabled: false,
      baseURL: "https://127.0.0.1:3102",
      port: "3102",
      controlPort: "3103",
    });
    expect(env).toMatchObject({
      WHATSAPP_OUTBOUND_ENABLED: "false",
      WHATSAPP_LIVE_SEND_ENABLED: "false",
      WHATSAPP_BSUID_RECIPIENT_ENABLED: "false",
    });
  });

  it("refuses to build an environment without the harness-provided values", () => {
    expect(() =>
      serverEnv({}, { outboundEnabled: true, baseURL: "x", port: "1", controlPort: "2" }),
    ).toThrow(/E2E_DATABASE_URL/);
  });
});

// The harness's own children (production build, Playwright and through it the test workers) and what each server finally sees.
const CHILD_SOURCE = {
  ...hostile,
  E2E_BASE_URL: "https://127.0.0.1:3100",
  E2E_MODE: "bots",
  PGHOST: "prod.example.com",
  PGDATABASE: "al_ict_whatsapp",
  PGUSER: "prod_user",
  PGPASSWORD: "fake-pg-password",
  PGSERVICE: "prod",
  WHATSAPP_ACCESS_TOKEN: "EAAfake-token",
  GRAPH_API_BASE: "https://graph.example.com",
  DATABASE_URL: "postgres://prod.example.com/al_ict_whatsapp",
};
const GATES = [
  "BOTS_RUNTIME_ENABLED",
  "WHATSAPP_OUTBOUND_ENABLED",
  "WHATSAPP_LIVE_SEND_ENABLED",
] as const;
const WORKER = "WHATSAPP_WORKER_ENABLED";

describe("child processes of the harness get the generated database, no credentials and every gate off", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const env = () => childEnv(CHILD_SOURCE);

  it("binds the application database to the generated one and blanks every inherited target", () => {
    const e = env();
    expect(e.DATABASE_URL).toBe(HARNESS.E2E_DATABASE_URL);
    expect(e.DATABASE_URL_UNPOOLED).toBe("");
    expect(e.TEST_DATABASE_ADMIN_URL).toBe(""); // the administrative URL is not handed to any child
    for (const name of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSERVICE"])
      expect(e[name], name).toBe("");
    expect(JSON.stringify(e)).not.toMatch(
      /prod\.example\.com|al_ict_whatsapp|prod_user|fake-pg-password/,
    );
  });

  it("blanks Graph settings and every Meta/WhatsApp credential, keeping only the run's fake values", () => {
    const e = env();
    expect(e.WHATSAPP_GRAPH_API_VERSION).toBe("");
    for (const name of [
      "WA_TOKEN_E2E_UNUSED",
      "WA_TOKEN_PRODUCTION",
      "META_ACCESS_TOKEN",
      "WHATSAPP_ACCESS_TOKEN",
      "GRAPH_API_BASE",
    ])
      expect(e[name], name).toBe("");
    expect(e.META_APP_SECRET).toBe(HARNESS.E2E_META_APP_SECRET);
    expect(JSON.stringify(e)).not.toMatch(/EAA|the-real-app-secret|graph\.example\.com/);
  });

  it('pins the three gates to "false" and every other BOTS_ name to blank, defined so .env.local cannot fill them', () => {
    const e = env();
    for (const gate of GATES) expect(e[gate], gate).toBe("false");
    expect(e.BOTS_WORKER_ENABLED).toBe("");
    expect(e.BOTS_SOME_FUTURE_GATE).toBe("");
    const config = readOutboundConfig(e as Record<string, string>);
    expect([config.botsRuntimeEnabled, config.outboundEnabled, config.liveSendEnabled]).toEqual([
      false,
      false,
      false,
    ]);
    expect(config.graphApiVersion).toBeNull();
    expect(e.PATH).toBe("/usr/bin"); // unrelated names are inherited unchanged
  });

  it("keeps the worker flag false even when the shell sets it true or a .env.local would fill it in", () => {
    const hostileShell = childEnv({ ...CHILD_SOURCE, [WORKER]: "true" });
    expect(hostileShell[WORKER]).toBe("false");
    // Next loads `.env.local` only for names the process does not define: simulate that with a hostile file
    const dotEnvLocal = {
      [WORKER]: "true",
      WHATSAPP_BSUID_RECIPIENT_ENABLED: "true",
      BOTS_RUNTIME_ENABLED: "true",
    };
    for (const source of [
      childEnv({ ...CHILD_SOURCE }),
      serverEnv(CHILD_SOURCE, {
        outboundEnabled: false,
        baseURL: "https://127.0.0.1:3102",
        port: "3102",
        controlPort: "3103",
      }),
    ]) {
      const effective: Record<string, string | undefined> = { ...source };
      for (const [name, value] of Object.entries(dotEnvLocal))
        if (!(name in effective)) effective[name] = value;
      expect(effective[WORKER]).toBe("false");
      expect(effective.WHATSAPP_BSUID_RECIPIENT_ENABLED).toBe("false");
      expect(effective.BOTS_RUNTIME_ENABLED).toBe("false");
    }
    // an unset shell leaves the name defined too (the file could not fill it in)
    const bare = childEnv({ ...CHILD_SOURCE, [WORKER]: undefined });
    expect(WORKER in bare && bare[WORKER]).toBe("false");
  });

  it("the spec accepts only an all-false report that includes the three mandatory gates", () => {
    const spec = read("e2e/inbox-bot.spec.ts");
    expect(spec).toContain("function expectGatesOff(");
    expect(spec).toContain(
      'for (const [name, value] of Object.entries(gates.enabledFlags)) expect(value, name).toBe("false")',
    );
    expect(spec).toContain(
      'for (const name of MANDATORY_GATES) expect(gates.enabledFlags[name], name).toBe("false")',
    );
    expect(spec).not.toMatch(/expect\(gates\)\.toEqual\(\{\s*enabledFlags/);
    expect(spec).toContain("rejects.toThrow()"); // the composer server's control port is not listening
  });

  it("fails closed, launching nothing, when the generated database or any harness value is missing", () => {
    for (const missing of [
      "E2E_DATABASE_URL",
      "E2E_BASE_URL",
      "E2E_PORT",
      "E2E_CONTROL_PORT",
      "E2E_AUTH_SECRET",
    ]) {
      const source: Record<string, string | undefined> = { ...CHILD_SOURCE };
      delete source[missing];
      expect(() => childEnv(source), missing).toThrow(new RegExp(missing));
    }
    // and never the shell's DATABASE_URL in its place
    const noGenerated: Record<string, string | undefined> = {
      ...CHILD_SOURCE,
      E2E_DATABASE_URL: "",
    };
    expect(() => childEnv(noGenerated)).toThrow(/E2E_DATABASE_URL/);
  });

  it("the bot server (outbound off) and the composer server (queueing on) differ only in the queueing gate", () => {
    const merged = (outboundEnabled: boolean, port: string) => ({
      ...childEnv(CHILD_SOURCE),
      ...serverEnv(CHILD_SOURCE, {
        outboundEnabled,
        baseURL: `https://127.0.0.1:${port}`,
        port,
        controlPort: String(Number(port) + 1),
      }),
    });
    const composer = merged(true, "3100");
    const bots = merged(false, "3102");
    expect(GATES.map((g) => composer[g])).toEqual(["false", "true", "false"]);
    expect(GATES.map((g) => bots[g])).toEqual(["false", "false", "false"]);
    for (const e of [composer, bots]) {
      const config = readOutboundConfig(e as Record<string, string>);
      expect(config.botsRuntimeEnabled).toBe(false);
      expect(config.liveSendEnabled).toBe(false);
      expect(e.DATABASE_URL).toBe(HARNESS.E2E_DATABASE_URL);
    }
  });

  it("scripts/e2e.ts builds the child environment from the generated database only, and hands nothing else to a child", () => {
    const source = read("scripts/e2e.ts");
    const calls = source.indexOf("childEnv(");
    expect(calls).toBeGreaterThan(source.indexOf("createTestDatabase("));
    expect(source).toMatch(/E2E_DATABASE_URL: t\.url/);
    // every spawn and run uses CHILD_ENV (or, for openssl, PATH alone): no raw process.env reaches a child
    expect(source).toMatch(/run\("npm", \["run", "build"\], CHILD_ENV\)/);
    expect(source).toMatch(/env: CHILD_ENV,/);
    expect(source).toMatch(/\{ PATH: process\.env\.PATH \?\? "" \}/);
    expect(source).not.toMatch(/env: (process\.env|\{ \.\.\.process\.env)/);
    expect(source).not.toMatch(/TEST_DATABASE_ADMIN_URL|DATABASE_URL: process\.env/);
  });
});

describe("bots-only mode starts only the outbound-off server and every helper follows it", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  it("is chosen by E2E_MODE=bots alone", () => {
    expect(isBotsOnly({ E2E_MODE: "bots" })).toBe(true);
    for (const mode of [undefined, ""]) expect(isBotsOnly({ E2E_MODE: mode })).toBe(false);
    expect(runMode({})).toBe("ordinary");
    expect(runMode({ E2E_MODE: "bots" })).toBe("bots");
    // an unknown value never silently becomes ordinary (it would skip the bots-only safety checks)
    for (const mode of ["composer", "BOTS", "bots ", "true", "0"]) {
      expect(() => runMode({ E2E_MODE: mode }), mode).toThrow(/E2E_MODE/);
      expect(() => isBotsOnly({ E2E_MODE: mode }), mode).toThrow(/E2E_MODE/);
      expect(() => controlPortFor({ E2E_MODE: mode, E2E_PORT: "3100" }), mode).toThrow(/E2E_MODE/);
    }
  });

  it("points the shared helpers at the second server's control port in bots-only mode, the primary one otherwise", () => {
    expect(controlPortFor({ E2E_MODE: "bots", E2E_PORT: "3100" })).toBe("3103");
    expect(controlPortFor({ E2E_MODE: "bots", E2E_PORT: "3100", E2E_CONTROL_PORT: "3101" })).toBe(
      "3103",
    );
    expect(controlPortFor({ E2E_PORT: "3100", E2E_CONTROL_PORT: "3101" })).toBe("3101");
    expect(() => controlPortFor({ E2E_MODE: "bots" })).toThrow(/E2E_PORT/);
    expect(() => controlPortFor({ E2E_PORT: "3100" })).toThrow(/E2E_CONTROL_PORT/);
    expect(read("e2e/support/settle.ts")).toContain("controlPortFor(process.env)");
    expect(read("e2e/support/settle.ts")).not.toMatch(/process\.env\.E2E_CONTROL_PORT/);
    for (const file of ["e2e/support/ui.ts", "e2e/support/fixtures.ts"])
      expect(read(file), file).not.toMatch(/E2E_CONTROL_PORT/); // they go through serverIdle()
  });

  it("playwright.config.ts: bots-only has the bot project and the outbound-off server alone; ordinary mode is unchanged", () => {
    const config = read("playwright.config.ts");
    expect(config).toContain("const botsOnly = isBotsOnly(process.env);");
    expect(config).toContain(
      "projects: botsOnly ? [botsProject] : [composerProject, offProject, botsProject],",
    );
    expect(config).toContain(
      "webServer: botsOnly ? [outboundOffServer] : [composerServer, outboundOffServer],",
    );
    expect(config).toMatch(
      /const botsProject = \{\s*name: "chromium-bots",\s*testMatch: botSpec,\s*use: \{[^}]*baseURL: offBaseURL/,
    );
    expect(config).toMatch(
      /const composerProject = \{\s*name: "chromium",\s*testIgnore: \[offSpec, botSpec\]/,
    );
    expect(config).toMatch(
      /const composerServer: Server = \{[\s\S]*?outboundEnabled: true,\s*baseURL,[\s\S]*?\};/,
    ); // the queue-enabled server keeps its own configuration
    expect(config).toMatch(/const outboundOffServer: Server = \{[\s\S]*?outboundEnabled: false,/);
    expect(config.match(/outboundEnabled: (true|false)/g)).toEqual([
      "outboundEnabled: true",
      "outboundEnabled: false",
    ]);
    const commands = [...config.matchAll(/command: "([^"]+)"/g)].map((m) => m[1]);
    expect(commands).toEqual(["node e2e/server.mjs", "node e2e/server.mjs"]); // no worker of any kind
  });

  it("the bots-only script sets the mode, and scripts/e2e.ts forwards it explicitly rather than inheriting it", () => {
    const pkg = JSON.parse(read("package.json")).scripts;
    expect(pkg["test:e2e:bots"]).toBe("E2E_MODE=bots tsx scripts/e2e.ts --project=chromium-bots");
    expect(pkg["test:e2e"]).toBe("tsx scripts/e2e.ts");
    expect(read("scripts/e2e.ts")).toContain(
      'const MODE = process.env.E2E_MODE === "bots" ? "bots" : "";',
    );
    expect(read("scripts/e2e.ts")).toContain("E2E_MODE: MODE,");
  });

  it("the harness server reports the effective gates (values of *_ENABLED flags, only the NAMES of credentials)", () => {
    const server = read("e2e/server.mjs");
    expect(server).toContain('req.url === "/gates"');
    expect(server).toContain("_ENABLED$/");
    expect(server).not.toMatch(
      /process\.env\.(WA_TOKEN|META_APP_SECRET|DATABASE_URL|BOTS_RUNTIME)/,
    );
  });
});

describe("cleanup ordering", () => {
  it("attempts every step, in order, whatever fails, and reports each failure", async () => {
    const calls: string[] = [];
    const reported: string[] = [];
    const ok = await runCleanup(
      [
        {
          name: "tls",
          run: () => {
            calls.push("tls");
            throw new Error("rm failed");
          },
        },
        {
          name: "database",
          run: async () => {
            calls.push("database");
          },
        },
      ],
      (message) => reported.push(message),
    );
    expect(calls).toEqual(["tls", "database"]); // a TLS failure cannot prevent the database drop
    expect(ok).toBe(false);
    expect(reported).toEqual(["E2E cleanup step failed: tls"]);
  });

  it("reports a failed database drop and still reports success of the others", async () => {
    const reported: string[] = [];
    const ok = await runCleanup(
      [
        { name: "tls", run: () => undefined },
        {
          name: "database",
          run: async () => {
            throw new Error("drop failed");
          },
        },
      ],
      (message) => reported.push(message),
    );
    expect(ok).toBe(false);
    expect(reported).toEqual(["E2E cleanup step failed: database"]);
    expect(await runCleanup([{ name: "x", run: () => undefined }])).toBe(true);
  });

  it("scripts/e2e.ts: temporary setup is inside the try, and the finally runs every step through runCleanup", () => {
    const source = readFileSync(new URL("../scripts/e2e.ts", import.meta.url), "utf8");
    const tryAt = source.indexOf("  try {");
    expect(source.indexOf("mkdtempSync(")).toBeGreaterThan(tryAt);
    const finallyAt = source.indexOf("} finally {");
    expect(source.indexOf("await runCleanup(")).toBeGreaterThan(finallyAt);
    expect(source).toContain("drop database ${t.name}");
    expect(source).not.toMatch(/with\s*\(\s*force|pg_terminate_backend/i);
  });
});

describe("the first bot test's composer-absence check follows the mode (bots-only requires it, ordinary permits the composer server)", () => {
  const spec = readFileSync(new URL("../e2e/inbox-bot.spec.ts", import.meta.url), "utf8");
  const config = readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8");

  it("runs the absence assertion only inside the bots-only branch, using the shared helper", () => {
    expect(spec).toContain('import { isBotsOnly } from "./support/mode";');
    expect([...spec.matchAll(/isBotsOnly\(/g)]).toHaveLength(1);
    expect([...spec.matchAll(/rejects\.toThrow\(\)/g)]).toHaveLength(1);
    expect(spec).toMatch(
      /if \(isBotsOnly\(process\.env\)\)\s*await expect\(\s*fetch\([^)]*E2E_CONTROL_PORT[^)]*\),?\s*\)\.rejects\.toThrow\(\)/,
    );
  });

  it("keeps every gate and no-send assertion unconditional, on the outbound-off server in both modes", () => {
    const start = spec.indexOf("const OFF_CONTROL_PORT");
    expect(spec.slice(start, start + 120)).toContain("Number(process.env.E2E_PORT) + 3"); // not mode dependent
    expect(spec).not.toMatch(/if \(isBotsOnly[\s\S]{0,200}expectGatesOff/);
    expect([...spec.matchAll(/expectGatesOff\(gates\)/g)]).toHaveLength(2); // start and end of the run
    expect(spec).toContain("expect(sendProblems(baseline, after)).toEqual([])");
    // the bot project is on the outbound-off server in the ordinary configuration too
    expect(config).toContain(
      "projects: botsOnly ? [botsProject] : [composerProject, offProject, botsProject],",
    );
    expect(config).toMatch(/const botsProject = \{[\s\S]*?baseURL: offBaseURL/);
  });

  it("the modes' servers: bots-only is the outbound-off server alone; ordinary also runs the composer server", () => {
    expect(config).toContain(
      "webServer: botsOnly ? [outboundOffServer] : [composerServer, outboundOffServer],",
    );
    expect(controlPortFor({ E2E_MODE: "bots", E2E_PORT: "3100", E2E_CONTROL_PORT: "3101" })).toBe(
      "3103",
    );
    expect(controlPortFor({ E2E_PORT: "3100", E2E_CONTROL_PORT: "3101" })).toBe("3101");
  });
});
