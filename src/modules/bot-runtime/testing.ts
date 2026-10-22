import { randomUUID } from "node:crypto";
import { seedMessage, type TestDb } from "@/db/__tests__/helpers";

// TEST-ONLY fixtures for the trigger queue's database tests (Phase 08E-3; excluded from the boundary scans). Triggers are
// written with raw SQL, exactly as the capture primitive or any other writer reaches the table, so the table's own CHECKs and
// foreign keys are what the tests exercise. Times are relative to the DATABASE clock, the clock the queue itself uses.

export type QueueCtx = {
  readonly organizationId: string;
  readonly accountId: string;
  readonly conversationId: string;
};

export type TriggerSeed = {
  /** Milliseconds from now until the trigger is due (negative = already due). Default: due a second ago. */
  readonly dueInMs?: number;
  readonly attempts?: number;
  readonly deferrals?: number;
  /** A live-looking claim of this age (milliseconds); omitted = unclaimed. */
  readonly claimAgeMs?: number;
  /** The effective input time. Default: a second ago. */
  readonly inputOccurredAt?: Date;
  /** An already finished trigger. */
  readonly finished?: "PROCESSED" | "IGNORED" | "DEAD";
  /** Reuse an existing inbound message instead of creating one. */
  readonly messageId?: string;
};

export type SeededTrigger = {
  readonly id: string;
  readonly messageId: string;
  readonly claimToken: string | null;
};

export async function insertTrigger(
  t: TestDb,
  ctx: QueueCtx,
  o: TriggerSeed = {},
): Promise<SeededTrigger> {
  const messageId =
    o.messageId ??
    (
      await seedMessage(t.db, {
        organizationId: ctx.organizationId,
        conversationId: ctx.conversationId,
        whatsappAccountId: ctx.accountId,
        direction: "INBOUND",
      })
    ).id;
  const claimToken = o.claimAgeMs === undefined ? null : randomUUID();
  const finished = o.finished ?? null;
  const r = await t.pool.query(
    `insert into bot_triggers (organization_id, whatsapp_account_id, conversation_id, message_id, input_occurred_at,
        observed_control_seq, next_attempt_at, attempts, deferrals, claim_token, claimed_at,
        status, outcome_code, processed_at)
     values ($1, $2, $3, $4, $5, 0, clock_timestamp() + $6 * interval '1 millisecond', $7, $8, $9::uuid,
        case when $9::uuid is null then null else clock_timestamp() - $10 * interval '1 millisecond' end,
        coalesce($11, 'PENDING'),
        case $11::text when 'DEAD' then 'attempts_exhausted' when 'PROCESSED' then 'processed' when 'IGNORED' then 'ignored' end,
        case when $11::text is null then null else clock_timestamp() end)
     returning id`,
    [
      ctx.organizationId,
      ctx.accountId,
      ctx.conversationId,
      messageId,
      (o.inputOccurredAt ?? new Date(Date.now() - 1_000)).toISOString(),
      o.dueInMs ?? -1_000,
      o.attempts ?? 0,
      o.deferrals ?? 0,
      claimToken,
      o.claimAgeMs ?? 0,
      finished,
    ],
  );
  return { id: r.rows[0].id as string, messageId, claimToken };
}

export async function triggerRow(t: TestDb, id: string): Promise<Record<string, unknown>> {
  const r = await t.pool.query("select * from bot_triggers where id = $1", [id]);
  return r.rows[0] as Record<string, unknown>;
}

/** The database clock, as a Date. */
export async function dbNow(t: TestDb): Promise<Date> {
  return (await t.pool.query("select clock_timestamp() as now")).rows[0].now as Date;
}

/** Seconds from the database clock until the trigger's next_attempt_at (negative = already due). */
export async function secondsUntilDue(t: TestDb, id: string): Promise<number> {
  const r = await t.pool.query(
    "select extract(epoch from (next_attempt_at - clock_timestamp()))::float8 as s from bot_triggers where id = $1",
    [id],
  );
  return Number(r.rows[0].s);
}

/** Makes the claim old enough that the lease no longer protects it (committed; the row must not be locked). */
export async function expireClaim(t: TestDb, id: string, ageMs = 120_000): Promise<void> {
  await t.pool.query(
    "update bot_triggers set claimed_at = clock_timestamp() - $2 * interval '1 millisecond' where id = $1 and claim_token is not null",
    [id, ageMs],
  );
}

/** Makes an unclaimed PENDING trigger due now (committed; the row must not be locked). */
export async function makeDue(t: TestDb, id: string): Promise<void> {
  await t.pool.query(
    "update bot_triggers set next_attempt_at = clock_timestamp() - interval '1 second' where id = $1 and status = 'PENDING'",
    [id],
  );
}

// ------------------------------------------------------------------------------------------------ Phase 08E-4 flows
// TEST DATA only: the runtime hard-codes no wording, menu or branch.

type Json = Record<string, unknown>;

const base = (triggers: Json[], start: string, nodes: Json): Json => ({
  schemaVersion: 1,
  name: "Test flow",
  startNodeId: start,
  errorNodeId: "fallback",
  triggers,
  nodes: {
    fallback: { type: "HANDOVER", reason: "needs_staff", message: "A person will reply." },
    ...nodes,
  },
});

/** Two button prompts, an END with a notice and a HANDOVER with a notice; starts on first_message or the keyword "menu". */
export function menuFlow(): Json {
  return base([{ kind: "first_message" }, { kind: "keyword", words: ["menu"] }], "ask", {
    ask: {
      type: "BUTTONS",
      body: "Pick one",
      options: [
        { key: "a", title: "A", next: "ask2" },
        { key: "b", title: "B", next: "staff" },
      ],
      onInvalid: "staff",
    },
    ask2: {
      type: "BUTTONS",
      body: "Again",
      options: [
        { key: "ok", title: "OK", next: "done" },
        { key: "no", title: "No", next: "staff" },
      ],
      onInvalid: "staff",
    },
    done: { type: "END", message: "Bye" },
    staff: { type: "HANDOVER", reason: "needs_staff", message: "A person will reply." },
  });
}

/** The start node is an END (with or without a notice). */
export function endFirstFlow(
  message?: string,
  trigger: Json = { kind: "keyword", words: ["menu"] },
): Json {
  return base([trigger], "done", {
    done: message === undefined ? { type: "END" } : { type: "END", message },
  });
}

/** The start node is a HANDOVER with a notice. */
export function handoverFirstFlow(): Json {
  return base([{ kind: "keyword", words: ["menu"] }], "staff", {
    staff: { type: "HANDOVER", reason: "needs_staff", message: "A person will reply." },
  });
}

/** A text message then an END with a notice; the trigger is the keyword "menu" or first_message. */
export function messageFlow(trigger: Json = { kind: "keyword", words: ["menu"] }): Json {
  return base([trigger], "welcome", {
    welcome: { type: "MESSAGE", text: "Hello", next: "done" },
    done: { type: "END", message: "Bye" },
  });
}
