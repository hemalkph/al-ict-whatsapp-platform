import { defineConfig, devices } from "@playwright/test";

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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/server.mjs",
    url: `${baseURL}/api/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    // After the browsers are closed Playwright asks the server to stop (SIGTERM) and waits, instead of killing it.
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    timeout: 90_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "production",
      DATABASE_URL: required("E2E_DATABASE_URL"),
      BETTER_AUTH_SECRET: required("E2E_AUTH_SECRET"),
      BETTER_AUTH_URL: baseURL,
      E2E_HOST: required("E2E_HOST"),
      E2E_PORT: required("E2E_PORT"),
      E2E_CONTROL_PORT: required("E2E_CONTROL_PORT"),
      E2E_TLS_DIR: required("E2E_TLS_DIR"),
    },
  },
});
