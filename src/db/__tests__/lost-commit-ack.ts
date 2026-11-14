import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema";
import type { TestDb } from "./helpers";

/** Test-only: lose one acknowledgement AFTER a real COMMIT on the same validated disposable database. */
export function lostCommitAck(t: TestDb) {
  const pool = new Pool({ ...t.target, max: 1, connectionTimeoutMillis: 5000 });
  const statements: string[] = [];
  const ends: Promise<void>[] = [];
  const errors: Error[] = [];
  let afterCommit: (() => Promise<void>) | undefined;
  let injected = 0;
  pool.on("error", (error) => errors.push(error));
  pool.on("connect", (client) => {
    ends.push(new Promise<void>((resolve) => client.once("end", resolve)));
    client.on("error", (error) => errors.push(error));
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    // Preserve both driver query forms; only Drizzle's promise-form transaction COMMIT is faulted.
    (client as unknown as { query: typeof query }).query = (...args: unknown[]) => {
      const first = args[0] as string | { text?: string };
      const text = (typeof first === "string" ? first : (first.text ?? "")).trim();
      statements.push(text);
      if (/^commit$/i.test(text) && afterCommit && !args.some((arg) => typeof arg === "function")) {
        const observe = afterCommit;
        afterCommit = undefined;
        return (async () => {
          await query(...args);
          await observe(); // independent connection proves the server committed before the injected loss
          injected++;
          throw Object.assign(new Error("injected lost COMMIT acknowledgement"), { code: "08006" });
        })();
      }
      return query(...args);
    };
  });
  return {
    db: drizzle(pool, { schema }),
    statements,
    arm: (observe: () => Promise<void>) => void (afterCommit = observe),
    get injected() {
      return injected;
    },
    get checkedOut() {
      return pool.totalCount - pool.idleCount;
    },
    get waiting() {
      return pool.waitingCount;
    },
    async close() {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          pool.end().then(() => Promise.all(ends)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("lost-ack pool leaked a client")), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (errors.length) throw new AggregateError(errors, "lost-ack pool errors");
    },
  };
}
