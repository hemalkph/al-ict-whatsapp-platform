import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Only src/db may initialize the PostgreSQL driver (ADR 0011).
const pgPaths = [
  { name: "pg", message: "Use the database via @/db. Only src/db may import pg." },
  {
    name: "drizzle-orm/node-postgres",
    message: "Use the database via @/db. Only src/db may import the driver adapter.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Modules are consumed through their public index.ts only (see docs/ARCHITECTURE.md).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/modules/**", "src/db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: pgPaths,
          patterns: [
            {
              group: ["@/modules/*/*"],
              message: "Import a module through its public API: @/modules/<name>.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/modules/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { paths: pgPaths }] },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
