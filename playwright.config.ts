import { defineConfig, devices } from "@playwright/test";
import { serverEnv } from "./e2e/support/server-env";

// Browser E2E (Chromium only). Run through `npm run test:e2e`: scripts/e2e.ts creates the disposable database,
// seeds it, builds the app and passes the E2E_* values used below. Running `playwright test` directly is not
// supported on purpose: it could never be pointed at a database safely.
function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set. Run the browser tests with \`npm run test:e2e\`.`);
  return value;
}

const baseURL = required("E2E_BASE_URL");
// A SECOND application server with outbound messaging switched OFF (the platform default), on the next two ports, serving the
// same database. It exists so the inbox's "sending is switched off" state is tested in a real browser without ever weakening
// the gate: the gate is read from the environment only, so the only honest way to see it off is a server that has it off.
const offPort = Number(required("E2E_PORT")) + 2;
const offControlPort = Number(required("E2E_PORT")) + 3;
const offBaseURL = `https://${required("E2E_HOST")}:${offPort}`;
const offSpec = /inbox-outbound-off\.spec\.ts/;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // Tests change real state (passwords, sessions, memberships) in one disposable database, so a retry would run
  // against already-changed data and could only hide a deterministic bug. Files own distinct identities and may run
  // in parallel; tests inside a file run in order.
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    ignoreHTTPSErrors: true, // throwaway self-signed certificate, local only
    // Traces contain request bodies and cookies (fake test passwords and sessions of a database that is dropped
    // right after the run). Kept for failures only, never committed (git-ignored), uploaded by CI on failure only.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", testIgnore: offSpec, use: { ...devices["Desktop Chrome"] } },
    {
      name: "chromium-outbound-off",
      testMatch: offSpec,
      use: { ...devices["Desktop Chrome"], baseURL: offBaseURL },
    },
  ],
  webServer: [
    {
      command: "node e2e/server.mjs",
      url: `${baseURL}/api/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      // After the browsers are closed Playwright asks the server to stop (SIGTERM) and waits, instead of killing it.
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      timeout: 90_000,
      stdout: "pipe",
      stderr: "pipe",
      // Explicit and complete (see e2e/support/server-env.ts): nothing about sending or credentials comes from the shell.
      env: serverEnv(process.env, {
        outboundEnabled: true,
        baseURL,
        port: required("E2E_PORT"),
        controlPort: required("E2E_CONTROL_PORT"),
      }),
    },
    {
      command: "node e2e/server.mjs",
      url: `${offBaseURL}/api/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      // After the browsers are closed Playwright asks the server to stop (SIGTERM) and waits, instead of killing it.
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      timeout: 90_000,
      stdout: "pipe",
      stderr: "pipe",
      // Outbound messaging is OFF here (the platform default): the inbox must show that and nothing may be queued.
      env: serverEnv(process.env, {
        outboundEnabled: false,
        baseURL: offBaseURL,
        port: String(offPort),
        controlPort: String(offControlPort),
      }),
    },
  ],
});
