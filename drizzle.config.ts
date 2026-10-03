import { defineConfig } from "drizzle-kit";

// Used by `drizzle-kit generate/migrate/check`. Migrations use a direct connection when provided.
// `generate` and `check` do not need a database connection.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema",
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? "",
  },
});
