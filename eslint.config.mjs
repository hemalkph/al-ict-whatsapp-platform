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

// The private Better Auth provisioning instance (src/modules/auth/provisioning.ts) is server-only and never
// HTTP-mounted. It may be imported only by the auth and access modules.
const provisioningPattern = {
  group: ["@/modules/auth/provisioning", "@/modules/auth/provisioning/*"],
  message:
    "The private provisioning auth instance may only be used by the auth and access modules.",
};
const dbPattern = {
  group: ["@/db", "@/db/*"],
  message:
    "Routes and pages must not touch the database directly: call a module (@/modules/<name>).",
};
const deepModulePattern = {
  group: ["@/modules/*/*"],
  message: "Import a module through its public API: @/modules/<name>.",
};

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
  {
    // Routes/pages (src/app): no direct database access, no private provisioner, public module APIs only.
    files: ["src/app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: pgPaths, patterns: [deepModulePattern, dbPattern, provisioningPattern] },
      ],
    },
  },
  {
    // Modules other than auth/access must not reach the private provisioner either.
    files: ["src/modules/**/*.{ts,tsx}"],
    ignores: ["src/modules/auth/**", "src/modules/access/**"],
    rules: {
      "no-restricted-imports": ["error", { paths: pgPaths, patterns: [provisioningPattern] }],
    },
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
