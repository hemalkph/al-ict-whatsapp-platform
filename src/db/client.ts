import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// The ONLY runtime import of `pg` in the application (enforced by ESLint). Swapping the driver or
// runtime later means changing this file; the schema is plain portable PostgreSQL.
// Nothing connects, and DATABASE_URL is not read, until getDb() is first called.

export type Database = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __alIctDb?: Database };

export function getDb(): Database {
  if (!globalForDb.__alIctDb) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and configure it.");
    }
    // Cached on globalThis so Next.js dev hot reloads do not leak connection pools.
    globalForDb.__alIctDb = drizzle(new Pool({ connectionString: url }), { schema });
  }
  return globalForDb.__alIctDb;
}
