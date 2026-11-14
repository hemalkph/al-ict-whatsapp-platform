import { sql } from "drizzle-orm";
import { schema } from "@/db";
import {
  signalTestBackends,
  seedAccount,
  seedContact,
  seedConversation,
  seedMessage,
  type TestDb,
} from "@/db/__tests__/helpers";
import { minimalFlow, type Json } from "@/modules/bots/testing";
import { addActor, type Actor } from "@/modules/messaging/testing";
import type { OutboundConfig } from "@/modules/messaging/config";
import { enqueueAutomatedMessage } from "@/modules/messaging/enqueue";
import type { BotOutboundMessage } from "@/modules/messaging/interactive";
import { ON } from "@/modules/messaging/testing";
import { activateDeployment, createBot, publishVersion, updateDraft } from "./index";

// TEST-ONLY helpers for the bot-control database tests (excluded from the boundary scans). Fake organizations, members,
// students and messages only. Sessions are written with raw SQL, exactly as any future writer would reach the table, so the
// database guards (not the services) are what the tests exercise.

type Db = TestDb["db"];
let n = 0;
const uniq = () => `${(n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export type Student = {
  contact: { id: string };
  conversation: { id: string };
  message: { id: string };
};

export type BotWorld = {
  org: { id: string };
  account: { id: string };
  admin: Actor;
  staff: Actor;
  viewer: Actor;
  student: Student;
};

/** One student with a conversation and one inbound message on the account. */
export async function addStudent(
  db: Db,
  organizationId: string,
  whatsappAccountId: string,
): Promise<Student> {
  const contact = await seedContact(db, organizationId);
  const conversation = await seedConversation(db, {
    organizationId,
    whatsappAccountId,
    contactId: contact.id,
  });
  const message = await seedMessage(db, {
    organizationId,
    conversationId: conversation.id,
    whatsappAccountId,
    direction: "INBOUND",
  });
  return { contact, conversation, message };
}

/** An organization with an account, an ADMIN, a STAFF and a VIEWER member, and one student. */
export async function botWorld(db: Db): Promise<BotWorld> {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Org", slug: `org-${uniq()}` })
    .returning();
  const account = await seedAccount(db, org!.id);
  return {
    org: org!,
    account,
    admin: await addActor(db, org!.id, "ADMIN"),
    staff: await addActor(db, org!.id, "STAFF"),
    viewer: await addActor(db, org!.id, "VIEWER"),
    student: await addStudent(db, org!.id, account.id),
  };
}

/** Creates a bot, saves `flow` as its draft and publishes it; returns the bot and version ids. */
export async function publishedBot(
  db: Db,
  w: BotWorld,
  flow: Json = minimalFlow(),
  key = `bot_${uniq()}`,
) {
  const deps = { db };
  const bot = (await createBot(w.admin.ctx, { key, name: "Bot" }, deps)).value;
  await updateDraft(w.admin.ctx, { botId: bot.id, expectedRevision: 0, config: flow }, deps);
  const version = (await publishVersion(w.admin.ctx, { botId: bot.id, expectedRevision: 1 }, deps))
    .value;
  return { bot, version };
}

/** A published bot deployed on the world's account. */
export async function deployedBot(db: Db, w: BotWorld, priority = 1) {
  const { bot, version } = await publishedBot(db, w);
  const deployment = (
    await activateDeployment(
      w.admin.ctx,
      { botId: bot.id, versionId: version.id, whatsappAccountId: w.account.id, priority },
      { db },
    )
  ).value;
  return { bot, version, deployment };
}

export type SessionKeys = {
  organizationId: string;
  botId: string;
  versionId: string;
  deploymentId: string;
  whatsappAccountId: string;
  student: Student;
};

/** A pool or a checked-out client (structural, so this module never imports the driver). */
export type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/** Inserts a live session with raw SQL (no control sequence, start time or end fields supplied: the database owns them). */
export async function insertSession(
  q: Queryable,
  k: SessionKeys,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const columns: Record<string, unknown> = {
    organization_id: k.organizationId,
    bot_id: k.botId,
    bot_version_id: k.versionId,
    deployment_id: k.deploymentId,
    whatsapp_account_id: k.whatsappAccountId,
    contact_id: k.student.contact.id,
    conversation_id: k.student.conversation.id,
    started_by_message_id: k.student.message.id,
    state: "WAITING_FOR_INPUT",
    current_node_id: "welcome",
    ...extra,
  };
  const names = Object.keys(columns);
  const r = await q.query(
    `insert into bot_sessions (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    Object.values(columns),
  );
  return r.rows[0] as Record<string, unknown>;
}

/** Applies a raw update to one session (revision is incremented, as the guard requires for live rows). */
export async function updateSession(
  q: Queryable,
  id: string,
  set: string,
  params: unknown[] = [],
  bumpRevision = true,
): Promise<Record<string, unknown>> {
  const r = await q.query(
    `update bot_sessions set ${set}${bumpRevision ? ", revision = revision + 1" : ""} where id = $${params.length + 1} returning *`,
    [...params, id],
  );
  return r.rows[0] as Record<string, unknown>;
}

/** Every column of one row, for byte-identical before/after comparisons. */
export async function rowOf(q: Queryable, table: string, id: string) {
  const r = await q.query(`select to_jsonb(t) as row from ${table} t where id = $1`, [id]);
  return (r.rows[0] as { row: Record<string, unknown> } | undefined)?.row;
}

/** Replaces the retention period (disposable test databases only), so terminal sessions become eligible immediately. */
export async function shortenRetention(pool: TestDb["pool"], interval = "0 seconds") {
  await pool.query(
    `create or replace function bot_session_redaction_after() returns interval language sql stable as $$ select interval '${interval}' $$`,
  );
}

// ------------------------------------------------------------------------------------------------ Phase 08D (dispatch)

/** Every gate on for BOT dispatch tests (fake transport only; nothing here can reach Meta). */
export const BOTS_ON: OutboundConfig = { ...ON, botsRuntimeEnabled: true };

export type DispatchFixture = {
  readonly w: BotWorld;
  readonly d: Awaited<ReturnType<typeof deployedBot>>;
};

/**
 * A deployed bot on a SEND-ELIGIBLE account, whose world's conversation had an inbound message at `lastInboundAt`. botWorld's
 * account comes from seedAccount, which leaves the schema default status PENDING (not eligible: assess() requires ACTIVE and
 * not archived), so the account is made eligible here explicitly, exactly like the staff messaging fixture (ACTIVE, a
 * credential NAME, not archived). `accountStatus` keeps a test able to ask for an ineligible account on purpose.
 */
export async function dispatchWorld(
  t: TestDb,
  o: {
    lastInboundAt: Date;
    priority?: number;
    w?: BotWorld;
    accountStatus?: "PENDING" | "ACTIVE" | "DISABLED";
  },
): Promise<DispatchFixture> {
  const w = o.w ?? (await botWorld(t.db));
  await t.pool.query(
    "update whatsapp_accounts set status = $2, credential_ref = 'WA_TOKEN_TEST', archived_at = NULL where id = $1",
    [w.account.id, o.accountStatus ?? "ACTIVE"],
  );
  await t.pool.query("update conversations set last_inbound_at = $2 where id = $1", [
    w.student.conversation.id,
    o.lastInboundAt,
  ]);
  const d = await deployedBot(t.db, w, o.priority ?? 1);
  return { w, d };
}

/** A further student (contact, conversation, inbound message) on the world's account, its window open since `lastInboundAt`. */
export async function windowStudent(t: TestDb, w: BotWorld, lastInboundAt: Date): Promise<Student> {
  const s = await addStudent(t.db, w.org.id, w.account.id);
  await t.pool.query("update conversations set last_inbound_at = $2 where id = $1", [
    s.conversation.id,
    lastInboundAt,
  ]);
  return s;
}

export type LiveSession = {
  readonly id: string;
  readonly student: Student;
  readonly keys: SessionKeys;
};

/** A live session of the fixture's deployment on `student` (the world's student by default). */
export async function liveSessionFor(
  t: TestDb,
  f: DispatchFixture,
  student: Student = f.w.student,
): Promise<LiveSession> {
  const keys: SessionKeys = {
    organizationId: f.w.org.id,
    botId: f.d.bot.id,
    versionId: f.d.version.id,
    deploymentId: f.d.deployment.id,
    whatsappAccountId: f.w.account.id,
    student,
  };
  const row = await insertSession(t.pool, keys); // live, WAITING_FOR_INPUT at step 0 (as after a previous prompt)
  return { id: row.id as string, student, keys };
}

export const authorityOf = (f: DispatchFixture, s: LiveSession, sendEpoch = 1) => ({
  kind: "BOT" as const,
  organizationId: f.w.org.id,
  botSessionId: s.id,
  deploymentId: f.d.deployment.id,
  botVersionId: f.d.version.id,
  whatsappAccountId: f.w.account.id,
  conversationId: s.student.conversation.id,
  contactId: s.student.contact.id,
  sendEpoch,
});

/**
 * One bot step as the 08E runtime will run it: in ONE transaction, the L.2 step locks (deployment FOR SHARE, conversation FOR
 * UPDATE, session FOR UPDATE), enqueueAutomatedMessage, then the session update the engine would make (WAITING_FOR_SEND at
 * this step, or a terminal state recording this step as its terminal notice).
 */
export async function queueBotStep(
  t: TestDb,
  f: DispatchFixture,
  s: LiveSession,
  o: {
    stepSeq: number;
    message: BotOutboundMessage;
    now: Date;
    config?: OutboundConfig;
    terminal?: "COMPLETED" | "HANDED_OVER";
    sendEpoch?: number;
  },
) {
  return t.db.transaction(async (tx) => {
    await tx.execute(sql`select id from bot_deployments where id = ${f.d.deployment.id} for share`);
    await tx.execute(
      sql`select id from conversations where id = ${s.student.conversation.id} for update`,
    );
    await tx.execute(sql`select id from bot_sessions where id = ${s.id} for update`);
    const r = await enqueueAutomatedMessage(
      tx,
      authorityOf(f, s, o.sendEpoch ?? 1),
      { stepSeq: o.stepSeq, message: o.message },
      { config: o.config ?? BOTS_ON, now: () => o.now },
    );
    if (o.terminal === "COMPLETED")
      await tx.execute(
        sql`update bot_sessions set state = 'COMPLETED', end_reason = 'flow_end', step_seq = ${o.stepSeq}, terminal_notice_step_seq = ${o.stepSeq}, revision = revision + 1 where id = ${s.id}`,
      );
    else if (o.terminal === "HANDED_OVER")
      await tx.execute(
        sql`update bot_sessions set state = 'HANDED_OVER', end_reason = 'flow_handover', handover_reason = 'needs_staff', step_seq = ${o.stepSeq}, terminal_notice_step_seq = ${o.stepSeq}, revision = revision + 1 where id = ${s.id}`,
      );
    else
      await tx.execute(
        sql`update bot_sessions set state = 'WAITING_FOR_SEND', step_seq = ${o.stepSeq}, revision = revision + 1 where id = ${s.id}`,
      );
    return r;
  });
}

/**
 * Test isolation for dispatcher tests that share one database: the claim takes the globally earliest QUEUED row, so a row left
 * QUEUED by an earlier test (same next_attempt_at) could be claimed instead of the row the current test set up. Every such
 * leftover is moved QUEUED -> HELD (an allowed, final transition) before a test claims anything. Returns how many.
 */
export async function holdLeftoverQueued(t: TestDb): Promise<number> {
  const r = await t.pool.query(
    "update outbound_requests set state = 'HELD', hold_reason = 'test_isolation', finished_at = now() where state = 'QUEUED'",
  );
  return r.rowCount ?? 0;
}

export const textMessage = (text = "Hello from the bot"): BotOutboundMessage => ({
  kind: "text",
  text,
});

/**
 * Lock-ownership barriers and bounded cleanup for concurrency tests (the 08C toolkit, shared). Every held transaction and
 * every started operation is registered; cleanup() rolls back what is still held (destroying a connection whose rollback fails
 * or hangs), waits a bounded time for the operations, and cancels (then terminates) on the server anything still running,
 * failing the test. waitUntilBlocked(pid) returns the backend blocked BY that pid (pg_blocking_pids): order is proved by lock
 * ownership, never by counting waiters or by sleeping.
 */
export function barrierKit(t: TestDb) {
  const held: { abort(): Promise<void> }[] = [];
  const running: Promise<unknown>[] = [];
  const settle = <T>(p: Promise<T>) => {
    const s = p.then(
      (value) => ({ ok: true as const, value, at: process.hrtime.bigint() }),
      (error: unknown) => ({ ok: false as const, error, at: process.hrtime.bigint() }),
    );
    running.push(s);
    return s;
  };
  async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function hold(text: string, params: unknown[]) {
    const c = await t.pool.connect();
    const ignore = () => undefined;
    c.on("error", ignore);
    let done = false;
    const finish = async (statement: "commit" | "rollback") => {
      if (done) return;
      done = true;
      c.off("error", ignore);
      try {
        const query = c.query(statement);
        if (await within(query, 5_000)) {
          await query;
          c.release();
        } else c.release(new Error(`${statement} did not return; connection destroyed`));
      } catch (error) {
        c.release(error as Error);
        if (statement === "commit") throw error;
      }
    };
    const h = { pid: 0, release: () => finish("commit"), abort: () => finish("rollback") };
    held.push(h);
    await c.query("begin");
    h.pid = ((await c.query("select pg_backend_pid() pid")).rows[0] as { pid: number }).pid;
    await c.query(text, params);
    return h;
  }
  async function waitUntilBlocked(by: number, ms = 10_000): Promise<number> {
    const deadline = Date.now() + ms;
    for (;;) {
      const r = await t.pool.query(
        "select pid from pg_stat_activity where datname = current_database() and $1 = any(pg_blocking_pids(pid)) order by pid",
        [by],
      );
      if (r.rows.length > 0) return (r.rows[0] as { pid: number }).pid;
      if (Date.now() > deadline)
        throw new Error(`no statement became blocked by backend ${by} within ${ms} ms`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  /** The pids that `pid` is currently blocked by (empty when it waits on no lock). */
  async function blockersOf(pid: number): Promise<number[]> {
    const r = await t.pool.query("select pg_blocking_pids($1) b", [pid]);
    return (r.rows[0] as { b: number[] }).b;
  }
  async function cleanup({ settleMs = 10_000, graceMs = 5_000 } = {}) {
    for (const h of held.splice(0)) await h.abort();
    const pending = Promise.all(running.splice(0));
    if (await within(pending, settleMs)) return;
    const cancelled = await signalTestBackends(t.target, "cancel");
    if (await within(pending, graceMs))
      throw new Error(`cleanup cancelled ${cancelled} statement(s) still running`);
    const terminated = await signalTestBackends(t.target, "terminate");
    await within(pending, graceMs);
    throw new Error(`cleanup terminated ${terminated} session(s) that ignored cancellation`);
  }
  return { settle, hold, waitUntilBlocked, blockersOf, cleanup, within };
}

/** The SQLSTATE of a settled failure (Drizzle wraps the driver error), or null. */
export function settledState(r: { ok: boolean; error?: unknown }): string | null {
  if (r.ok) return null;
  let current: unknown = r.error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
