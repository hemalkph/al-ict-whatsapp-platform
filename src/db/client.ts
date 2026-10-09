import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { logger } from "@/shared/logging/logger";
import * as schema from "./schema";

// The ONLY runtime import of `pg` in the application (enforced by ESLint). Swapping the driver or
// runtime later means changing this file; the schema is plain portable PostgreSQL.
// Nothing connects, and DATABASE_URL is not read, until getDb() is first called.

export type Database = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __alIctDb?: Database };

/**
 * drizzle-orm 0.45.3 runs `begin` OUTSIDE the try/finally that releases the pooled client (node-postgres session
 * `transaction()`): if the connection dies exactly then, the client is never released, its pool slot is lost for good and
 * `pool.end()` never resolves. A long-running worker meets dead connections (database restarts, failovers), so its pool
 * makes the release unconditional for a client whose connection has ended: one second after `end`, a still-held client is
 * released as broken (so the pool discards it). A normal release afterwards is a harmless no-op.
 */
function releaseWhenConnectionEnds(client: PoolClient): PoolClient {
  const release = client.release;
  let released = false;
  let timer: NodeJS.Timeout | undefined;
  const onEnd = () => {
    if (!released) timer = setTimeout(() => finish(new Error("connection_lost")), 1000).unref();
  };
  const finish = (error?: Error | boolean) => {
    if (released) return; // pg-pool throws on a double release; ours is silent
    released = true;
    clearTimeout(timer);
    client.off("end", onEnd);
    release.call(client, error);
  };
  client.once("end", onEnd);
  client.release = finish;
  return client;
}

class GuardedPool extends Pool {
  // Only the promise form (the one drizzle's transaction() uses) is guarded; the callback form is pg-pool's own.
  override connect(): Promise<PoolClient>;
  override connect(
    callback: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: Error | boolean) => void,
    ) => void,
  ): void;
  override connect(
    callback?: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: Error | boolean) => void,
    ) => void,
  ): Promise<PoolClient> | void {
    if (callback) return super.connect(callback);
    return super.connect().then(releaseWhenConnectionEnds);
  }
}

/**
 * A pool that survives dead connections: bounded connect time, TCP keepalive, the begin-leak guard above, and an 'error'
 * handler on the pool (idle clients) and on every client (checked-out clients). Without those handlers Node treats a
 * connection that dies as an uncaught exception and ends the whole process. The failure still reaches the caller as a
 * rejected query (or at COMMIT), so nothing is hidden by handling the event.
 */
function guardedPool(config: PoolConfig, onError: (error: unknown) => void): Pool {
  const pool = new GuardedPool({
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    ...config,
  });
  pool.on("error", onError);
  pool.on("connect", (client) => client.on("error", () => undefined));
  return pool;
}

export type WorkerDatabase = { db: Database; close: () => Promise<void> };

/**
 * A pool OWNED by one long-running process (the WhatsApp worker); never cached globally. Unlike getDb() it bounds the
 * connect attempt (pg's default is to wait forever), names the sessions, and surfaces idle-client errors through a
 * callback instead of letting an unhandled pool 'error' event crash the process. Nothing connects until the first query.
 */
export function createWorkerDatabase(
  url: string,
  options: {
    maxConnections: number;
    applicationName: string;
    onPoolError: (error: unknown) => void;
  },
): WorkerDatabase {
  const pool = guardedPool(
    {
      connectionString: url,
      max: options.maxConnections,
      application_name: options.applicationName,
    },
    options.onPoolError,
  );
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}

export function getDb(): Database {
  if (!globalForDb.__alIctDb) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and configure it.");
    }
    // Cached on globalThis so Next.js dev hot reloads do not leak connection pools.
    globalForDb.__alIctDb = drizzle(
      guardedPool({ connectionString: url }, () =>
        logger.warn("database pool error", { reason: "idle_client_error" }),
      ),
      { schema },
    );
  }
  return globalForDb.__alIctDb;
}
