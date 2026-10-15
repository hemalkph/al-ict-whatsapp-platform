import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as dbSchema from "../schema";
import type { TestDb } from "./helpers";

// --------------------------------------------------------------------------------- an unreliable connection (ambiguous COMMIT)
/**
 * A second database handle on the SAME disposable database whose connections misbehave on demand, with REAL transactions:
 *  - loseAckOfCommit(n): the next n COMMITs are really sent and really committed by the server, and THEN the call fails with
 *    SQLSTATE 08006 (the acknowledgement was lost);
 *  - rollbackInsteadOfCommit(n): the next n COMMITs are replaced by a real ROLLBACK and the call fails with 08006 (the
 *    transaction certainly did not commit);
 *  - failBefore(match, n): the next n statements whose text matches fail with 08006 BEFORE they are sent.
 * Production triggers stay enabled. close() must be awaited before the fixture is closed.
 */
export function faultyDatabase(t: TestDb) {
  const pool = new Pool({ connectionString: t.url, max: 4 });
  const plan = { lose: 0, rollback: 0, before: null as RegExp | null, beforeCount: 0 };
  /** The text of every statement sent through this handle, in order (to count scans and probes). */
  const statements: string[] = [];
  const lost = () =>
    Object.assign(new Error("connection terminated unexpectedly"), { code: "08006" });
  const connect = pool.connect.bind(pool) as () => Promise<import("pg").PoolClient>;
  (pool as unknown as { connect: () => Promise<import("pg").PoolClient> }).connect = async () => {
    const client = await connect();
    if ((client as unknown as { wrapped?: boolean }).wrapped) return client;
    (client as unknown as { wrapped?: boolean }).wrapped = true;
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const first = args[0] as string | { text?: string };
      const text = (typeof first === "string" ? first : (first?.text ?? "")).trim();
      statements.push(text);
      if (plan.before && plan.beforeCount > 0 && plan.before.test(text)) {
        plan.beforeCount--;
        return Promise.reject(lost());
      }
      // only the transaction of an ATTEMPT (it tried the contact's advisory lock) is faulted, not a scan or a count
      const state = client as unknown as { attempt?: boolean };
      if (/pg_try_advisory_xact_lock/.test(text)) state.attempt = true;
      if (/^(commit|rollback)$/i.test(text)) {
        const faulted = state.attempt === true;
        state.attempt = false;
        if (/^commit$/i.test(text) && faulted && plan.rollback > 0) {
          plan.rollback--;
          return query("rollback").then(() => Promise.reject(lost()));
        }
        if (/^commit$/i.test(text) && faulted && plan.lose > 0) {
          plan.lose--;
          return query(...args).then(() => Promise.reject(lost()));
        }
      }
      return query(...args);
    };
    return client;
  };
  return {
    db: drizzle(pool, { schema: dbSchema }) as unknown as TestDb["db"],
    statements,
    loseAckOfCommit: (n = 1) => void (plan.lose = n),
    rollbackInsteadOfCommit: (n = 1) => void (plan.rollback = n),
    failBefore: (match: RegExp, n = 1) => {
      plan.before = match;
      plan.beforeCount = n;
    },
    close: () => pool.end(),
  };
}
