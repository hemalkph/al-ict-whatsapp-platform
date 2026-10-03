import { defineConfig } from "vitest/config";

// Real-PostgreSQL integration tests (`npm run test:db`). Local/disposable PostgreSQL only.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["src/**/*.db.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
