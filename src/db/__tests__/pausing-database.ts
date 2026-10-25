import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema";
import { assertDisposableName, type TestDb } from "./helpers";

// TEST-ONLY (Phase 08E-9 Batch 3, owner-authorized): a second database handle on the SAME validated disposable database whose
// connections can be PAUSED immediately before one chosen statement is transmitted, with REAL transactions and real locks. It
// follows the pattern of faulty-database.ts and lost-commit-ack.ts: the driver's client.query is wrapped per connection.
//
// What it does: when the armed pattern matches a statement's text for the FIRST time, the call publishes the connection's backend
// pid, waits until the test releases it, then sends the ORIGINAL statement with its ORIGINAL parameters and returns the server's
// own result or error. It never changes text, parameters, results or errors, never skips a statement, and never answers for the
// server, so it cannot bypass any authorization: it can only move the moment at which a statement is sent.
//
// Safety: the pool targets only the harness's validated disposable database (assertDisposableName); every connection carries
// connection-local idle_in_transaction_session_timeout and statement_timeout (startup parameters, never a server or database
// setting), so a forgotten pause cannot keep locks indefinitely; an unreleased pause times out and FAILS the paused statement
// (the transaction then rolls back); close() ends the pool and, if a client does not close in time, terminates its backend from
// the harness pool, so no connection with an uncertain transaction state survives a test. Never imported by production code.

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export type Paused = { readonly pid: number; readonly text: string };

export type PauseHandle = {
  /** Resolves when the matching statement is about to be sent (the connection is then idle inside its transaction). */
  readonly reached: Promise<Paused>;
  /** Lets the paused statement go (idempotent). */
  release(): void;
  /** How many statements matched the pattern so far (only the first one pauses; the test requires exactly one). */
  readonly fired: number;
};

export type PausingDatabaseOptions = {
  /** Connection-local lock_timeout (ms). Only a deliberate mutation sets it; production paths keep their own settings. */
  readonly lockTimeoutMs?: number;
  /** Connection-local idle_in_transaction_session_timeout (ms): the server-side backstop for a stalled test. */
  readonly idleInTransactionMs?: number;
  /** How long an armed pause waits for release() before failing the paused statement (ms). */
  readonly pauseLimitMs?: number;
  readonly max?: number;
};

export const PAUSING_APPLICATION_NAME = "al-ict-test-pausing-db";

export function pausingDatabase(t: TestDb, o: PausingDatabaseOptions = {}) {
  assertDisposableName(t.target.database);
  const pool = new Pool({
    ...t.target,
    max: o.max ?? 2,
    application_name: PAUSING_APPLICATION_NAME,
    idle_in_transaction_session_timeout: o.idleInTransactionMs ?? 20_000,
    statement_timeout: 20_000,
    ...(o.lockTimeoutMs === undefined ? {} : { lock_timeout: o.lockTimeoutMs }),
    connectionTimeoutMillis: 5_000,
  });
  const pauseLimitMs = o.pauseLimitMs ?? 15_000;
  /** Every statement sent through this handle, with the backend that sent it (evidence of order and placement). */
  const statements: Paused[] = [];
  const errors: Error[] = [];
  const ends: Promise<void>[] = [];
  const pids = new Set<number>();
  const handles: Array<{ go: Deferred<void> }> = [];
  let armed: {
    match: RegExp;
    fired: number;
    reached: Deferred<Paused>;
    go: Deferred<void>;
  } | null = null;

  pool.on("error", (e) => errors.push(e));
  pool.on("connect", (client) => {
    ends.push(new Promise<void>((resolve) => client.once("end", () => resolve())));
    client.on("error", (e) => errors.push(e));
    const pid = (client as unknown as { processID: number }).processID;
    pids.add(pid);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: typeof query }).query = (...args: unknown[]) => {
      const first = args[0] as string | { text?: string };
      const text = (typeof first === "string" ? first : (first?.text ?? "")).trim();
      const current = (client as unknown as { processID: number }).processID;
      statements.push({ pid: current, text });
      const a = armed;
      // only the promise form (Drizzle's) is paused; a callback-form call passes straight through
      if (a && a.match.test(text) && !args.some((arg) => typeof arg === "function")) {
        a.fired++;
        if (a.fired === 1)
          return (async () => {
            a.reached.resolve({ pid: current, text });
            let timer: NodeJS.Timeout | undefined;
            const outcome = await Promise.race([
              a.go.promise.then(() => "released" as const),
              new Promise<"timeout">((resolve) => {
                timer = setTimeout(() => resolve("timeout"), pauseLimitMs);
              }),
            ]).finally(() => clearTimeout(timer));
            if (outcome === "timeout")
              throw new Error(
                `pausing database: the paused statement was not released within ${pauseLimitMs} ms`,
              );
            return query(...args);
          })();
      }
      return query(...args);
    };
  });

  return {
    db: drizzle(pool, { schema }) as unknown as TestDb["db"],
    statements,
    /** Arms ONE pause for the first statement whose text matches `match`. One arm at a time. */
    arm(match: RegExp): PauseHandle {
      if (armed && armed.fired === 0) throw new Error("pausing database: a pause is already armed");
      const a = { match, fired: 0, reached: deferred<Paused>(), go: deferred() };
      armed = a;
      handles.push(a);
      return {
        reached: a.reached.promise,
        release: () => a.go.resolve(),
        get fired() {
          return a.fired;
        },
      };
    },
    /**
     * The pause is reached BEFORE `operation` settles: returns the paused backend. If the operation finishes (or fails) without
     * reaching the pause, the barrier is invalid and this throws, so a test can never pass vacuously.
     */
    async reachedBefore(handle: PauseHandle, operation: Promise<unknown>): Promise<Paused> {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          handle.reached,
          operation.then(() => {
            throw new Error(
              "pausing database: barrier invalid (the operation finished before the pause)",
            );
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("pausing database: the pause was never reached")),
              pauseLimitMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    /** Releases every pause, ends the pool, and terminates any backend of this handle that did not close in time. */
    async close(): Promise<void> {
      for (const h of handles) h.go.resolve();
      armed = null;
      let timer: NodeJS.Timeout | undefined;
      const closed = await Promise.race([
        pool
          .end()
          .then(() => Promise.all(ends))
          .then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 5_000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!closed) {
        await t.pool.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid = any($1)",
          [[...pids]],
        );
        throw new Error("pausing database: a connection did not close and was terminated");
      }
      if (errors.length) throw new AggregateError(errors, "pausing database pool errors");
    },
  };
}
