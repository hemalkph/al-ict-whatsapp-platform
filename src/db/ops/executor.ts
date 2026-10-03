import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type * as schema from "../schema";

/** A Drizzle database or transaction. Ops take an executor so callers control transaction boundaries. */
export type DbExecutor = PgDatabase<NodePgQueryResultHKT, typeof schema>;
