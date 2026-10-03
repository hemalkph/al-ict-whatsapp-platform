import { defineConfig } from "@playwright/test";

// E2E specs live in ./e2e. None exist yet, and CI does not run Playwright (see docs/TESTING_STRATEGY.md).
export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/api/health",
    reuseExistingServer: true,
  },
});
