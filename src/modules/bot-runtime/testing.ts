import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { seedMessage, type TestDb } from "@/db/__tests__/helpers";
import type { DbExecutor } from "@/db/ops/executor";
import { assignConversation } from "@/modules/inbox";
import type { ReconcileCandidate } from "@/db/ops/bot-session-store";
import { dbClock } from "@/db/ops/bot-step";
import { claimNext, executeClaim, type DispatchDeps } from "@/modules/messaging/dispatch";
import { submitOutboundMessage } from "@/modules/messaging/submit";
import { FakeTransport, ON, textInput } from "@/modules/messaging/testing";
import type { SendResult } from "@/modules/messaging/transport";
import { activateDeployment } from "../bot-control";
import { BOTS_ON, botWorld, publishedBot, type BotWorld } from "../bot-control/testing";
import type { StepSummary } from "./context";
import { FlowCache } from "./flow-cache";
import type { StepDeps } from "./outbound";
import { reconcileSession, type ReconcileOutcome } from "./reconcile";
import { processTrigger } from "./step";
import { claimTriggers, type ClaimedTrigger } from "./trigger-queue";

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

/** A text message then a HANDOVER with a notice; the trigger is the keyword "menu". */
export function messageHandoverFlow(): Json {
  return base([{ kind: "keyword", words: ["menu"] }], "welcome", {
    welcome: { type: "MESSAGE", text: "Hello", next: "staff" },
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

// ------------------------------------------------------------------------------------------------ Phase 08E-5 kit
// The 08E-4 step fixtures, shared by the 08E-5 suites (R7-F, R3-P, R3-S, R5): a send-eligible world with a deployed flow, real
// inbound rows and triggers, real claims and real T1, the real dispatcher with a FakeTransport only, and pause points inside
// T1 (its test-only hooks) so order between transactions is proved by lock ownership, never by sleeping.

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export type RuntimeFx = {
  w: BotWorld;
  bot: { id: string };
  version: { id: string };
  deployment: { id: string };
};

/** A pause inside T1: `hook` publishes the backend pid and waits until `release()` (or the kit's releaseAll). */
export type PausePoint = {
  hook: (tx: DbExecutor) => Promise<void>;
  reached: Promise<number>;
  release: () => void;
};

export function runtimeKit(t: TestDb) {
  let tokens = 0;
  // Head-of-line orders PENDING triggers by (input_occurred_at, id): two triggers created in the same millisecond would be
  // ordered by their random ids. Input times are therefore strictly increasing in creation order.
  let lastInputMs = 0;
  const pauses: PausePoint[] = [];
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
  const rows = async (text: string, params: unknown[] = []) =>
    (await q(text, params)).rows as Record<string, unknown>[];
  const one = async (text: string, params: unknown[] = []) => (await rows(text, params))[0]!;

  const deps = (over: Partial<StepDeps> = {}): StepDeps => ({
    config: BOTS_ON,
    flows: new FlowCache(),
    newPromptToken: () => `T${String(++tokens).padStart(21, "A")}`,
    random: () => 0.5,
    ...over,
  });

  function pause(): PausePoint {
    const reached = deferred<number>();
    const go = deferred();
    const p: PausePoint = {
      hook: async (tx) => {
        const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`)).rows[0]!
          .pid;
        reached.resolve(pid);
        await go.promise;
      },
      reached: reached.promise,
      release: () => go.resolve(),
    };
    pauses.push(p);
    return p;
  }
  const releaseAll = () => {
    for (const p of pauses.splice(0)) p.release();
  };

  /** A world with a send-eligible account, an open window, and `flow` published and deployed on it. */
  async function fixture(flow: Record<string, unknown> = menuFlow()): Promise<RuntimeFx> {
    const w = await botWorld(t.db);
    await q(
      "update whatsapp_accounts set status = 'ACTIVE', credential_ref = 'WA_TOKEN_TEST', archived_at = NULL where id = $1",
      [w.account.id],
    );
    await q(
      "update conversations set last_inbound_at = clock_timestamp() - interval '1 minute' where id = $1",
      [w.student.conversation.id],
    );
    const { bot, version } = await publishedBot(t.db, w, flow);
    const deployment = (
      await activateDeployment(
        w.admin.ctx,
        { botId: bot.id, versionId: version.id, whatsappAccountId: w.account.id, priority: 1 },
        { db: t.db },
      )
    ).value;
    return { w, bot, version, deployment };
  }

  async function inbound(
    f: RuntimeFx,
    o: { type?: string; body?: string; content?: Record<string, unknown> } = {},
  ): Promise<string> {
    const r = await q(
      `insert into messages (organization_id, conversation_id, whatsapp_account_id, wamid, direction, type, body, content, occurred_at)
       values ($1, $2, $3, $4, 'INBOUND', $5, $6, $7::jsonb, clock_timestamp()) returning id`,
      [
        f.w.org.id,
        f.w.student.conversation.id,
        f.w.account.id,
        `wamid.${randomUUID()}`,
        o.type ?? "TEXT",
        o.body ?? "hi",
        o.content ? JSON.stringify(o.content) : null,
      ],
    );
    return r.rows[0].id as string;
  }

  const ctxOf = (f: RuntimeFx): QueueCtx => ({
    organizationId: f.w.org.id,
    accountId: f.w.account.id,
    conversationId: f.w.student.conversation.id,
  });

  /** The first trigger of the world's student uses its seeded (first eligible) message; later ones get a fresh inbound row. */
  async function trigger(
    f: RuntimeFx,
    o: {
      first?: boolean;
      body?: string;
      type?: string;
      content?: Record<string, unknown>;
      observed?: number;
    } = {},
  ): Promise<SeededTrigger> {
    let messageId: string;
    if (o.first) {
      messageId = f.w.student.message.id;
      await q("update messages set type = 'TEXT', body = $2 where id = $1", [
        messageId,
        o.body ?? "hi",
      ]);
    } else messageId = await inbound(f, o);
    lastInputMs = Math.max(Date.now() - 1_000, lastInputMs + 1);
    const seeded = await insertTrigger(t, ctxOf(f), {
      messageId,
      inputOccurredAt: new Date(lastInputMs),
    });
    if (o.observed !== undefined)
      await q("update bot_triggers set observed_control_seq = $2 where id = $1", [
        seeded.id,
        o.observed,
      ]);
    return seeded;
  }

  async function claimOf(id: string): Promise<ClaimedTrigger> {
    const c = (await claimTriggers(t.db, 50)).find((x) => x.id === id);
    if (!c) throw new Error(`trigger ${id} was not claimed`);
    return c;
  }
  const runClaim = (claim: ClaimedTrigger, over: Partial<StepDeps> = {}): Promise<StepSummary> =>
    processTrigger(t.db as unknown as DbExecutor, claim, deps(over));
  const run = async (id: string, over: Partial<StepDeps> = {}) => runClaim(await claimOf(id), over);

  /** Real dispatcher deps on the real clock (T1-created requests carry database-clock deadlines). */
  const dispatchDeps = (
    transport: FakeTransport,
    over: Partial<DispatchDeps> = {},
  ): DispatchDeps => ({
    db: t.db as never,
    transport,
    config: BOTS_ON,
    now: () => new Date(Date.now() + 1_000),
    random: () => 0.5,
    accountMinIntervalMs: 0,
    conversationMinIntervalMs: 0,
    ...over,
  });
  const accepted = (wamid: string): SendResult => ({
    kind: "accepted",
    wamid,
    providerStatus: "accepted",
    httpStatus: 200,
  });

  const session = (id: string) => one("select * from bot_sessions where id = $1", [id]);
  const request = (id: string) => one("select * from outbound_requests where id = $1", [id]);
  const botRequests = (f: RuntimeFx) =>
    rows(
      "select * from outbound_requests where organization_id = $1 and conversation_id = $2 and origin = 'BOT' order by bot_step_seq",
      [f.w.org.id, f.w.student.conversation.id],
    );
  const events = (sessionId: string) =>
    rows(
      "select kind, code, message_id, step_seq from bot_session_events where session_id = $1 order by created_at, id",
      [sessionId],
    );
  /** In-flight BOT requests of a session as an independent READ COMMITTED observer sees them (QUEUED or SENDING). */
  const inFlight = async (sessionId: string) =>
    Number(
      (
        await one(
          "select count(*)::int n from outbound_requests where bot_session_id = $1 and origin = 'BOT' and state in ('QUEUED', 'SENDING')",
          [sessionId],
        )
      ).n,
    );
  const controlSeq = async (f: RuntimeFx) =>
    Number(
      (
        await one("select control_seq from conversations where id = $1", [
          f.w.student.conversation.id,
        ])
      ).control_seq,
    );
  const replyContent = (token: string, key: string) => ({
    subtype: "button_reply",
    id: `b1.${token}.${key}`,
    title: key,
  });

  /** menuFlow started by real T1: the session WAITING_FOR_SEND at step 1 with its one QUEUED prompt request R. */
  async function startedPrompt(f: RuntimeFx) {
    const tr = await trigger(f, { first: true });
    const summary = await run(tr.id);
    if (summary.kind !== "finished" || summary.outcome !== "session_started")
      throw new Error(`the fixture session did not start: ${JSON.stringify(summary)}`);
    const s = await one(
      "select * from bot_sessions where organization_id = $1 and conversation_id = $2",
      [f.w.org.id, f.w.student.conversation.id],
    );
    const [r, ...more] = await botRequests(f);
    if (!r || more.length > 0 || r.state !== "QUEUED")
      throw new Error("fixture: expected one QUEUED request");
    return { session: s, request: r };
  }

  /** A button reply trigger for the session's current prompt. */
  const replyTrigger = (f: RuntimeFx, token: string, key = "a") =>
    trigger(f, { type: "INTERACTIVE", body: key, content: replyContent(token, key) });

  /** The real assignment action, as staff in the Inbox makes it. */
  const assign = (f: RuntimeFx) =>
    assignConversation(
      f.w.staff.ctx,
      f.w.student.conversation.id,
      { assigneeMembershipId: f.w.staff.membershipId, expectedAssigneeMembershipId: null },
      { db: t.db as never },
    );
  /** The real STAFF outbound submission (it creates a STAFF QUEUED request; its transport is never executed here). */
  const submit = (f: RuntimeFx, body = "staff reply") =>
    submitOutboundMessage(f.w.staff.ctx, textInput(f.w.student.conversation.id, body), {
      db: t.db as never,
      config: ON,
      now: () => new Date(),
    });

  // ---------------------------------------------------------------------------------- 08E-6 reconciler helpers

  /** One real dispatcher pass for the next QUEUED request, with the given fake transport result. Returns its outcome. */
  /**
   * One real dispatcher pass with the given fake transport result. The claim takes the GLOBALLY earliest QUEUED request, so the
   * caller names the request it means: claiming any other one fails here instead of silently sending another world's request.
   */
  async function dispatchWith(
    result: SendResult | Error,
    expectedRequestId: string,
    over: Partial<DispatchDeps> = {},
  ) {
    const transport = new FakeTransport().next(result);
    const d = dispatchDeps(transport, over);
    const { claim } = await claimNext(d);
    if (!claim) throw new Error("dispatchWith: nothing was claimed");
    if (claim.requestId !== expectedRequestId)
      throw new Error(
        "dispatchWith: the dispatcher claimed a different request (an earlier QUEUED one)",
      );
    return { outcome: await executeClaim(d, claim), transport, claim };
  }
  /** menuFlow started and its prompt ACCEPTED by the real dispatcher: S WAITING_FOR_SEND, R ACCEPTED (not yet reconciled). */
  async function acceptedPrompt(f: RuntimeFx) {
    const x = await startedPrompt(f);
    const { outcome } = await dispatchWith(
      accepted(`wamid.TEST08E6.${randomUUID()}`),
      x.request.id as string,
    );
    if (outcome !== "accepted") throw new Error(`fixture: prompt not accepted (${outcome})`);
    return x;
  }
  const candidateOf = (s: Record<string, unknown>): ReconcileCandidate => ({
    organizationId: s.organization_id as string,
    sessionId: s.id as string,
    conversationId: s.conversation_id as string,
    deploymentId: s.deployment_id as string,
  });
  const reconcile = (
    s: Record<string, unknown>,
    over: Partial<StepDeps> = {},
  ): Promise<ReconcileOutcome> =>
    reconcileSession(t.db as unknown as DbExecutor, candidateOf(s), deps(over));
  /**
   * A reconciliation whose backend is TERMINATED while it holds its locks (after its decision clock, before any write): the
   * expected connection error is consumed by a termination watch and verified (anything else fails the test). Returns the
   * rejected outcome and checks that the conversation row and its advisory lock were released with the dead session.
   */
  async function interruptedReconcile(s: Record<string, unknown>) {
    const watch = terminationWatch(t.pool);
    const p = pause();
    const running = reconcile(s, { hooks: { afterDecisionClock: p.hook } }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const pid = await p.reached;
    watch.stopCapturing();
    await watch.terminate(pid);
    await watch.terminated(); // resume only once the client knows its connection is dead: one order, not a race
    p.release();
    const result = await running;
    await watch.verify();
    const conversationId = s.conversation_id as string;
    const free = await q("select 1 from conversations where id = $1 for update nowait", [
      conversationId,
    ]).then(
      () => true,
      () => false,
    );
    const advisory = (
      await one("select pg_try_advisory_xact_lock(hashtextextended($1, 0)) ok", [
        `bot-conv:${s.organization_id as string}:${conversationId}`,
      ])
    ).ok as boolean;
    return { result, pid, locksReleased: free && advisory === true };
  }

  /** A decision clock `ms` after the database clock (the reconciler's time rules without sleeping). */
  const shifted = (ms: number) => async (tx: DbExecutor) =>
    new Date((await dbClock(tx)).getTime() + ms);
  /** A decision clock fixed at an exact instant (boundary tests). */
  const at = (d: Date) => async () => new Date(d.getTime());
  const sessionJson = async (id: string) =>
    (await one("select to_jsonb(s) j from bot_sessions s where id = $1", [id])).j as Record<
      string,
      unknown
    >;
  const requestJson = async (id: string) =>
    (await one("select to_jsonb(r) j from outbound_requests r where id = $1", [id])).j as Record<
      string,
      unknown
    >;

  return {
    q,
    rows,
    one,
    deps,
    pause,
    releaseAll,
    fixture,
    inbound,
    ctxOf,
    trigger,
    claimOf,
    run,
    runClaim,
    dispatchDeps,
    accepted,
    session,
    request,
    botRequests,
    events,
    inFlight,
    controlSeq,
    replyContent,
    startedPrompt,
    replyTrigger,
    assign,
    submit,
    dispatchWith,
    acceptedPrompt,
    candidateOf,
    reconcile,
    interruptedReconcile,
    shifted,
    at,
    sessionJson,
    requestJson,
  };
}

// ------------------------------------------------------------------------------------------------ backend termination

type WatchedClient = {
  readonly processID?: number | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
};

/**
 * Connection-loss regressions terminate a backend while a pooled client is CHECKED OUT (pg-pool removes its idle error listener
 * on checkout). Without a listener the client's `error` event throws ("Connection terminated unexpectedly", an unhandled error)
 * from inside its connection-end handler, which then never emits `end`, so the harness pool cannot close. This watch attaches a
 * listener to the clients acquired while it is capturing; it records the ONE expected termination (that backend, that message)
 * and records anything else as unexpected, which `verify()` turns into a test failure. It never swallows other errors silently.
 *
 * pg delivers the termination in one of two orders (pg 8 Client._handleErrorMessage): if the server's FATAL 57P01 arrives while
 * a query is in flight, that query rejects with it and only `end` emits "Connection terminated unexpectedly"; if it arrives while
 * the client is idle in its transaction, the client ALSO emits the 57P01 itself as an `error` event first. Both are the one
 * expected termination; under load the second order happens (Phase 08E-8A, E-DRAIN). `terminated()` waits for the client to
 * have seen the end, so a caller can resume the victim only once its connection is known dead (one deterministic order).
 */
export function terminationWatch(pool: TestDb["pool"]) {
  const clients: WatchedClient[] = [];
  const expected: Error[] = [];
  const serverFatal: Error[] = [];
  const unexpected: unknown[] = [];
  let target: number | null = null;
  let capturing = true;
  const listenerFor = (client: WatchedClient) => (error: Error) => {
    const victim = target !== null && client.processID === target;
    if (victim && /Connection terminated/.test(error.message)) expected.push(error);
    // the server's own termination notice, from that backend only, before its end (at most once)
    else if (
      victim &&
      expected.length === 0 &&
      serverFatal.length === 0 &&
      (error as { code?: unknown }).code === "57P01"
    )
      serverFatal.push(error);
    else unexpected.push(error);
  };
  const settled = async () => {
    for (let i = 0; i < 500 && expected.length === 0 && unexpected.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const listeners = new Map<WatchedClient, (error: Error) => void>();
  const onAcquire = (client: WatchedClient) => {
    if (!capturing || listeners.has(client)) return;
    const l = listenerFor(client);
    listeners.set(client, l);
    clients.push(client);
    client.on("error", l);
  };
  pool.on("acquire", onAcquire as never);
  return {
    /** Stop attaching to newly acquired clients (call once the transaction under test has its connection). */
    stopCapturing() {
      capturing = false;
      pool.removeListener("acquire", onAcquire as never);
    },
    /** Terminates the backend from a separate connection; the watched client's error becomes the expected one. */
    async terminate(pid: number) {
      if (!clients.some((c) => c.processID === pid))
        throw new Error("terminationWatch: the backend to terminate is not a watched client");
      target = pid;
      const r = await pool.query("select pg_terminate_backend($1) ok", [pid]);
      if (r.rows[0]?.ok !== true) throw new Error("terminationWatch: pg_terminate_backend failed");
    },
    /** Waits (bounded) until the victim's client has seen its connection end; listeners stay attached. */
    async terminated() {
      await settled();
      if (expected.length === 0)
        throw new AggregateError(
          unexpected as Error[],
          "terminationWatch: the client never saw the termination",
        );
    },
    /** Waits for the expected error, asserts there was nothing else, and detaches every listener. */
    async verify() {
      await settled();
      this.stopCapturing();
      for (const [client, l] of listeners) client.removeListener("error", l);
      listeners.clear();
      if (unexpected.length > 0)
        throw new AggregateError(unexpected as Error[], "unexpected client error");
      if (expected.length !== 1)
        throw new Error(`expected exactly one termination error, saw ${expected.length}`);
    },
  };
}
