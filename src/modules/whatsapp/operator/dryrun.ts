import type { Database, DbExecutor } from "@/db";

// Every operator command that changes state is a DRY RUN unless `apply` is true. A dry run executes the very same code in a
// transaction and rolls it back, so the preview can never drift from what apply would do.

/** An operator-facing refusal that must roll the whole transaction back. Messages may be specific: the audience is an operator. */
export class OperatorAbort extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OperatorAbort";
  }
}

class DryRunRollback<T> extends Error {
  constructor(readonly value: T) {
    super("dry_run");
  }
}

export async function transact<T>(
  db: Database,
  apply: boolean,
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<{ applied: boolean; value: T }> {
  try {
    const value = await db.transaction(async (tx) => {
      const v = await fn(tx);
      if (!apply) throw new DryRunRollback(v);
      return v;
    });
    return { applied: true, value };
  } catch (error) {
    if (error instanceof DryRunRollback) return { applied: false, value: error.value as T };
    throw error;
  }
}
