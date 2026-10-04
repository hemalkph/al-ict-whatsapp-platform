import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "@/db/__tests__/helpers";
import { seedE2E } from "./e2e-seed";

// Browser E2E orchestrator (`npm run test:e2e [-- <playwright args>]`).
//
// One run = one disposable PostgreSQL database named al_ict_e2e_<random>:
//   create (local hosts only, guarded by the shared test harness) -> migrate from the committed migrations ->
//   seed the minimum identities -> real production build served over HTTPS -> Playwright (Chromium) -> drop the
//   database in `finally`, also after failures and Ctrl-C. It never reads DATABASE_URL: the application database of
//   a developer machine cannot be reached from here.
//
// Production mode requires an https BETTER_AUTH_URL (readAuthEnv) and `next start` has no https option, so the app is
// served by e2e/server.mjs (Next's documented custom server) with a throwaway self-signed certificate.
//
// Set E2E_SKIP_BUILD=1 when a build was just made (CI builds in its own step).

const HOST = "127.0.0.1";
const PORT = process.env.E2E_PORT ?? "3100";
const BASE_URL = `https://${HOST}:${PORT}`;
// Test-only, deterministic, and meaningless outside the disposable database: not a real secret.
const AUTH_SECRET = "e2e-only-better-auth-secret-".padEnd(48, "x");
const SERVER_LOG = "e2e-output/server.log";

// Lines the application server must never print during a run. Expected 4xx responses are not logged by the app.
const SERVER_ERROR_PATTERN =
  /unhandled|uncaught|TypeError|ReferenceError|RangeError|⨯|\bERROR\b|57P01|ECONNRESET/i;

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  return spawnSync(command, args, { stdio: "inherit", env }).status ?? 1;
}

async function main(): Promise<number> {
  const t = await createTestDatabase({ prefix: "al_ict_e2e" });
  console.log(`E2E database: ${t.name}`);
  const tlsDir = mkdtempSync(join(tmpdir(), "al-ict-e2e-tls-"));
  let exitCode = 1;
  let child: ReturnType<typeof spawn> | undefined;
  const stop = () => child?.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    await seedE2E(t, { secret: AUTH_SECRET, baseURL: BASE_URL, origin: BASE_URL });

    if (
      run("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        `/CN=${HOST}`,
        "-keyout",
        join(tlsDir, "key.pem"),
        "-out",
        join(tlsDir, "cert.pem"),
      ]) !== 0
    ) {
      throw new Error("Could not create the throwaway TLS certificate (openssl).");
    }
    if (process.env.E2E_SKIP_BUILD !== "1" && run("npm", ["run", "build"]) !== 0) {
      throw new Error("next build failed.");
    }

    const output: string[] = [];
    child = spawn("npx", ["playwright", "test", ...process.argv.slice(2)], {
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
        E2E_DATABASE_URL: t.url,
        E2E_BASE_URL: BASE_URL,
        E2E_AUTH_SECRET: AUTH_SECRET,
        E2E_TLS_DIR: tlsDir,
        E2E_HOST: HOST,
        E2E_PORT: PORT,
      },
    });
    const tee = (target: NodeJS.WriteStream) => (chunk: Buffer) => {
      target.write(chunk);
      output.push(chunk.toString());
    };
    child.stdout?.on("data", tee(process.stdout));
    child.stderr?.on("data", tee(process.stderr));
    exitCode = await new Promise<number>((resolve) => {
      child!.on("exit", (code) => resolve(code ?? 1));
      child!.on("error", () => resolve(1));
    });

    // The application server's own output (Playwright prefixes it with [WebServer]).
    const serverLines = output
      .join("")
      .split("\n")
      .filter((line) => line.includes("[WebServer]"));
    mkdirSync("e2e-output", { recursive: true });
    writeFileSync(SERVER_LOG, serverLines.join("\n") + "\n");
    const bad = serverLines.filter((line) => SERVER_ERROR_PATTERN.test(line));
    if (bad.length > 0) {
      console.error(`\nThe application server logged errors during the run (see ${SERVER_LOG}):`);
      for (const line of bad.slice(0, 10)) console.error(`  ${line}`);
      exitCode = exitCode || 1;
    }
  } finally {
    rmSync(tlsDir, { recursive: true, force: true });
    try {
      await t.close();
      console.log(`E2E database dropped: ${t.name}`);
    } catch (error) {
      console.error(`E2E database ${t.name} was NOT dropped:`, error);
      exitCode = 1;
    }
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
