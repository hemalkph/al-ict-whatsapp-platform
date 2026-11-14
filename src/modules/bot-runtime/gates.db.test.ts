import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import type { DbExecutor } from "@/db/ops/executor";
import { readOutboundConfig } from "@/modules/messaging/config";
import { dispatchBatch } from "@/modules/messaging/dispatch";
import { OutboundRefusedError } from "@/modules/messaging/errors";
import { FakeTransport } from "@/modules/messaging/testing";
import {
  EXIT_REFUSED as OUTBOUND_EXIT_REFUSED,
  readWorkerConfig,
  runOutboundWorker,
} from "@/modules/messaging/worker";
import {
  deliver,
  deliveryBytes,
  handlerContext,
  ingestBytes,
  type DeliverOptions,
  type StoredEvent,
} from "@/modules/whatsapp/inbound/testing";
import { buildWebhookWorkerHandlers } from "@/modules/whatsapp/worker/registry";
import { queueBotStep, textMessage } from "../bot-control/testing";
import { productionStepDeps } from "../bot-worker/compose";
import { readBotWorkerConfig } from "../bot-worker/config";
import {
  botWorkerDatabase,
  EXIT_REFUSED as BOT_EXIT_REFUSED,
  EXIT_STOPPED as BOT_EXIT_STOPPED,
  preflight,
  runBotWorker,
} from "../bot-worker/run";
import { startWorker, until, workerConnections } from "../bot-worker/testing";
import type { StepSummary } from "./context";
import type { StepDeps } from "./outbound";
import { reconcileSession } from "./reconcile";
import { processTrigger } from "./step";
import { menuFlow, runtimeKit, triggerRow, type RuntimeFx } from "./testing";
import { claimTriggers } from "./trigger-queue";

// E-GATE (Phase 08E-9 Batch 2; plan section M rows 1-8, N.2 E-GATE, N.3 item 7) on disposable PostgreSQL 17.
//
// Capture (P-W), the bot runtime (P-B) and dispatch (P-D) are three independently configured processes. Each row gives every
// process its OWN explicit environment object (never process.env) and runs that process's real production decision and code
// path on it:
//   P-W  buildWebhookWorkerHandlers(env): the webhook worker's registry; messages arrive through the real ingest and handler.
//   P-B  readBotWorkerConfig(env) and runBotWorker(env) (the bot worker's start guard); when it would start: the worker's own
//        pool and preflight, then claimTriggers + processTrigger with productionStepDeps(env) (exactly the trigger loop's work)
//        and reconcileSession for the sweeper's per-session step.
//   P-D  readWorkerConfig(env, true) and runOutboundWorker(env) (the outbound worker's start guard, the live-send gate required
//        exactly as in production, where the script passes a real transport); when it would start: dispatchBatch with
//        readWorkerConfig's own outbound config, which is exactly the loop's work.
// SIMULATED: only the environment objects, a FakeTransport in place of Meta (no MetaTransport is ever constructed here), and
// where a row is about elapsed time, an explicit clock (the dispatcher's `now`, the runtime's decision-clock seam). The real
// environment's gates stay OFF. DATABASE_URL appears only inside the bot and outbound workers' explicit env objects, pointing at
// this disposable database (as the existing worker tests do); the harness itself never reads DATABASE_URL.

const STUDENT = "15550100123";
const OFF: Readonly<Record<string, string>> = {};
const CAPTURE_ON = { BOTS_RUNTIME_ENABLED: "true" } as const;

describe("E-GATE: the three-process gate matrix through the production entry points", () => {
  let t: TestDb;
  let k: ReturnType<typeof runtimeKit>;
  const logs: string[] = [];

  /** P-B with both of its gates. */
  const botWorkerOn = () => ({
    BOTS_RUNTIME_ENABLED: "true",
    WHATSAPP_OUTBOUND_ENABLED: "true",
    DATABASE_URL: t.url,
  });
  /** P-D with all three of its gates (row 6, row 8). */
  const dispatcherAll = () => ({
    WHATSAPP_OUTBOUND_ENABLED: "true",
    WHATSAPP_LIVE_SEND_ENABLED: "true",
    BOTS_RUNTIME_ENABLED: "true",
    DATABASE_URL: t.url,
  });
  /** P-D running WITHOUT BOTS_RUNTIME_ENABLED (row 5). */
  const dispatcherNoBots = () => ({
    WHATSAPP_OUTBOUND_ENABLED: "true",
    WHATSAPP_LIVE_SEND_ENABLED: "true",
    DATABASE_URL: t.url,
  });

  beforeAll(async () => {
    t = await createTestDatabase({
      sessionTimeouts: {
        lock_timeout: 10_000,
        statement_timeout: 15_000,
        idle_in_transaction_session_timeout: 20_000,
      },
    });
    k = runtimeKit(t);
  });
  afterAll(async () => {
    if (t) await t.close();
  });
  beforeEach(async () => {
    await k.q("truncate organizations, webhook_requests cascade");
    logs.length = 0;
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation((line: unknown) => void logs.push(String(line)));
    // the real environment's gates are OFF and are never read by anything below
    for (const gate of [
      "BOTS_RUNTIME_ENABLED",
      "WHATSAPP_OUTBOUND_ENABLED",
      "WHATSAPP_LIVE_SEND_ENABLED",
    ])
      expect(process.env[gate] === undefined || process.env[gate] === "false").toBe(true);
  });
  afterEach(() => {
    k.releaseAll();
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------------------------------------ P-W (capture)

  type Row = Record<string, unknown>;
  type Real = {
    event: StoredEvent;
    options: DeliverOptions;
    message: Row & { id: string };
    trigger: (Row & { id: string }) | null;
  };
  /** One student message through the real ingest and the webhook worker built from `captureEnv`. */
  async function inbound(
    f: RuntimeFx,
    captureEnv: Readonly<Record<string, string>>,
    o: { from?: string; message?: Row } = {},
  ): Promise<Real> {
    const account = await k.one(
      "select phone_number_id, waba_id from whatsapp_accounts where id = $1",
      [f.w.account.id],
    );
    const dbMs = ((await k.one("select clock_timestamp() t")).t as Date).getTime();
    const options: DeliverOptions = {
      id: `wamid.TEST08E9GATE.${randomUUID()}`,
      from: o.from ?? STUDENT,
      pn: account.phone_number_id as string,
      waba: account.waba_id as string,
      timestamp: new Date(dbMs + 1_000),
      message: o.message ?? { type: "text", text: { body: "hi" } },
    };
    const event = await deliver(t.db, options);
    await handle(captureEnv, event);
    const message = (await k.one("select * from messages where wamid = $1", [
      event.providerObjectId,
    ])) as Real["message"];
    const trigger =
      ((await k.rows("select * from bot_triggers where message_id = $1", [message.id]))[0] as
        Real["trigger"] | undefined) ?? null;
    return { event, options, message, trigger };
  }
  const handle = (captureEnv: Readonly<Record<string, string>>, event: StoredEvent) =>
    t.db.transaction((tx) =>
      buildWebhookWorkerHandlers(captureEnv).MESSAGE!(
        tx,
        { ...event, eventType: "MESSAGE" },
        handlerContext(),
      ),
    );
  /** The world seen from the conversation the real handler created for one student. */
  async function fxOf(f0: RuntimeFx, r: Real): Promise<RuntimeFx> {
    const c = await k.one("select id, contact_id from conversations where id = $1", [
      r.message.conversation_id,
    ]);
    return {
      ...f0,
      w: {
        ...f0.w,
        student: {
          contact: { id: c.contact_id as string },
          conversation: { id: c.id as string },
          message: { id: r.message.id },
        },
      },
    };
  }

  // ------------------------------------------------------------------------------------------------ P-B (bot worker)

  /** The bot worker's real start guard: runBotWorker on `env`; when refused it returns at once, before any connection. */
  async function botWorkerRefuses(env: Readonly<Record<string, string>>, missing: string[]) {
    const read = readBotWorkerConfig(env);
    expect(read).toMatchObject({ kind: "refused" });
    expect(read.kind === "refused" && read.problems.map((p) => p.split(" ")[0])).toEqual(missing);
    const printed: string[] = [];
    const pids = async () => (await workerConnections(t)).map((c) => c.pid);
    const before = await pids();
    const code = await runBotWorker({
      env,
      signal: new AbortController().signal,
      print: (m) => void printed.push(m),
    });
    expect(code).toBe(BOT_EXIT_REFUSED);
    expect(printed.join(" ")).toContain("Nothing was claimed or changed");
    // no pool was opened: no worker connection appeared (one closed by an earlier pass may still be leaving)
    expect((await pids()).filter((pid) => !before.includes(pid))).toEqual([]);
  }
  /**
   * One pass of the bot worker's trigger loop on `env`: start decision, the worker's own pool and J.6 preflight, then every
   * claimable trigger through processTrigger with the production dependency composition (the loop's exact work).
   */
  async function botWorkerPass(
    env: Readonly<Record<string, string>>,
    over: Partial<StepDeps> = {},
  ): Promise<StepSummary[]> {
    const read = readBotWorkerConfig(env);
    if (read.kind !== "ready") throw new Error(`the bot worker would not start: ${read.kind}`);
    const pool = botWorkerDatabase(read.config);
    try {
      const db = pool.db as unknown as DbExecutor;
      await preflight(db);
      const deps = { ...productionStepDeps(env), ...over };
      const results: StepSummary[] = [];
      for (const claim of await claimTriggers(db, 50))
        results.push(await processTrigger(db, claim, deps));
      return results;
    } finally {
      await pool.close();
    }
  }

  // ------------------------------------------------------------------------------------------------ P-D (outbound worker)

  /** The outbound worker's real start guard on `env` (live-send gate required, as when the script passes a real transport). */
  async function dispatcherRefuses(env: Readonly<Record<string, string>>, missing: string[]) {
    const read = readWorkerConfig(env, true);
    expect(read).toMatchObject({ kind: "refused" });
    expect(read.kind === "refused" && read.problems.map((p) => p.split(" ")[0])).toEqual(missing);
    const transport = new FakeTransport();
    const printed: string[] = [];
    const code = await runOutboundWorker({
      env,
      signal: new AbortController().signal,
      print: (m) => void printed.push(m),
      transport,
    });
    expect(code).toBe(OUTBOUND_EXIT_REFUSED);
    expect(printed.join(" ")).toContain("Nothing was claimed or sent");
    expect(transport.calls).toHaveLength(0);
    // belt and braces in the dispatcher itself: with this process's own config not even a batch would claim anything
    expect(
      await dispatchBatch({ db: t.db as never, transport, config: readOutboundConfig(env) }),
    ).toMatchObject({ claimed: 0, held: 0, accepted: 0 });
    expect(transport.calls).toHaveLength(0);
  }
  /**
   * One dispatchBatch with the configuration the outbound worker would run with. `now` is the dispatcher's clock option: the
   * default is one second ahead of the host clock so that database-stamped next_attempt_at values are due (as runtimeKit does).
   */
  async function dispatcherPass(
    env: Readonly<Record<string, string>>,
    transport: FakeTransport,
    now: () => Date = () => new Date(Date.now() + 1_000),
  ) {
    const read = readWorkerConfig(env, true);
    if (read.kind !== "ready") throw new Error("the outbound worker would not start");
    return dispatchBatch(
      { db: t.db as never, transport, config: read.config.outbound, now },
      { batchSize: read.config.batchSize, concurrency: read.config.concurrency },
    );
  }

  // ------------------------------------------------------------------------------------------------ state

  const conv = (f: RuntimeFx) => f.w.student.conversation.id;
  const sessionsOf = (f: RuntimeFx) =>
    k.rows("select * from bot_sessions where conversation_id = $1 order by started_control_seq", [
      conv(f),
    ]);
  /** Every bot-owned row of the organization: nothing here is written by anything but the bot code (or Stop/admin). */
  const botRows = async (f: RuntimeFx) => ({
    triggers: Number(
      (
        await k.one("select count(*)::int n from bot_triggers where organization_id = $1", [
          f.w.org.id,
        ])
      ).n,
    ),
    sessions: Number(
      (
        await k.one("select count(*)::int n from bot_sessions where organization_id = $1", [
          f.w.org.id,
        ])
      ).n,
    ),
    events: Number(
      (
        await k.one("select count(*)::int n from bot_session_events where organization_id = $1", [
          f.w.org.id,
        ])
      ).n,
    ),
    botRequests: Number(
      (
        await k.one(
          "select count(*)::int n from outbound_requests where organization_id = $1 and origin = 'BOT'",
          [f.w.org.id],
        )
      ).n,
    ),
  });
  function finished(summary: StepSummary | undefined, s: "PROCESSED" | "IGNORED", out: string) {
    expect(summary).toMatchObject({ kind: "finished", status: s, outcome: out });
  }
  /** A "previous run" with P-W and P-B on: a real session whose first BOT request is QUEUED. */
  async function previousRunRequest() {
    const f0 = await k.fixture(menuFlow());
    const first = await inbound(f0, CAPTURE_ON);
    const f = await fxOf(f0, first);
    const [summary] = await botWorkerPass(botWorkerOn());
    finished(summary, "PROCESSED", "session_started");
    const [r] = await k.botRequests(f);
    expect(r).toMatchObject({ state: "QUEUED", origin: "BOT", bot_step_seq: 1 });
    return { f0, f, r: r!, session: (await sessionsOf(f))[0]! };
  }

  // ================================================================================================= the eight rows

  it("row 1 (P-W off, P-B off, P-D off: the default): no trigger, no session, no request; neither worker starts; a trigger left by an earlier run is untouched; no transport call", async () => {
    const f0 = await k.fixture(menuFlow());
    // an earlier run had capture on: its trigger is still PENDING
    const earlier = await inbound(f0, CAPTURE_ON);
    const f = await fxOf(f0, earlier);
    const leftover = await triggerRow(t, earlier.trigger!.id);
    expect(leftover).toMatchObject({ status: "PENDING", attempts: 0 });

    const now = await inbound(f0, OFF);
    expect(now.message).toMatchObject({ direction: "INBOUND", type: "TEXT" }); // stored for the Inbox
    expect(now.trigger).toBeNull(); // P-W: no capture dependency is built

    await botWorkerRefuses(OFF, ["BOTS_RUNTIME_ENABLED", "WHATSAPP_OUTBOUND_ENABLED"]);
    await dispatcherRefuses(OFF, [
      "WHATSAPP_OUTBOUND_ENABLED",
      "WHATSAPP_LIVE_SEND_ENABLED",
      "DATABASE_URL",
    ]);
    expect(await triggerRow(t, earlier.trigger!.id)).toEqual(leftover);
    expect(await botRows(f)).toEqual({ triggers: 1, sessions: 0, events: 0, botRequests: 0 });
  });

  it("row 2 (P-W on, P-B off, P-D off): triggers are captured and accumulate PENDING (20 per conversation, then skipped and logged); nothing processes them; they go stale", async () => {
    const f0 = await k.fixture(menuFlow());
    const first = await inbound(f0, CAPTURE_ON);
    const f = await fxOf(f0, first);
    for (let i = 0; i < 19; i++) await inbound(f0, CAPTURE_ON);
    const capped = await inbound(f0, CAPTURE_ON);
    expect(capped.message).toMatchObject({ direction: "INBOUND" }); // the 21st message is stored ...
    expect(capped.trigger).toBeNull(); // ... with no trigger
    expect(logs.some((l) => l.includes('"bots.trigger_capped"'))).toBe(true);
    const pending = await k.rows(
      "select status, attempts, claim_token from bot_triggers where conversation_id = $1",
      [conv(f)],
    );
    expect(pending).toHaveLength(20);
    expect(pending.every((p) => p.status === "PENDING" && p.attempts === 0 && !p.claim_token)).toBe(
      true,
    );

    await botWorkerRefuses(OFF, ["BOTS_RUNTIME_ENABLED", "WHATSAPP_OUTBOUND_ENABLED"]);
    await dispatcherRefuses(OFF, [
      "WHATSAPP_OUTBOUND_ENABLED",
      "WHATSAPP_LIVE_SEND_ENABLED",
      "DATABASE_URL",
    ]);
    expect(await botRows(f)).toEqual({ triggers: 20, sessions: 0, events: 0, botRequests: 0 });

    // when a bot worker finally runs, more than maxInputAge later, the head of the queue is stale: never a session
    const input = (await triggerRow(t, first.trigger!.id)).input_occurred_at as Date;
    const [head] = await botWorkerPass(botWorkerOn(), {
      readClock: async () => new Date(input.getTime() + 10 * 60_000 + 1),
    });
    finished(head, "IGNORED", "stale_trigger");
    expect(await triggerRow(t, first.trigger!.id)).toMatchObject({ last_error_code: null });
    expect(await botRows(f)).toEqual({ triggers: 20, sessions: 0, events: 0, botRequests: 0 });
  });

  it("row 3 (P-W off, P-B on, P-D off): the real bot worker starts, passes preflight and finds nothing to claim; nothing is written", async () => {
    const f0 = await k.fixture(menuFlow());
    const m = await inbound(f0, OFF);
    const f = await fxOf(f0, m);
    expect(m.trigger).toBeNull();

    expect(readBotWorkerConfig(botWorkerOn())).toMatchObject({ kind: "ready" });
    expect(await botWorkerPass(botWorkerOn())).toEqual([]); // preflight passed; nothing claimable
    const worker = startWorker(t); // the real worker: its own pool, real loops, production composition
    await until(async () => (await workerConnections(t)).length > 0, 10_000, "worker connected");
    expect(await worker.stop()).toBe(BOT_EXIT_STOPPED);
    await dispatcherRefuses(OFF, [
      "WHATSAPP_OUTBOUND_ENABLED",
      "WHATSAPP_LIVE_SEND_ENABLED",
      "DATABASE_URL",
    ]);
    expect(await botRows(f)).toEqual({ triggers: 0, sessions: 0, events: 0, botRequests: 0 });
  });

  it("row 4 (P-W on, P-B on, P-D off): the session starts and queues its first request; nothing dispatches; after the 120 s deadline plus 30 s the sweeper holds it bot_send_deadline and hands the session over; no transport call", async () => {
    const x = await previousRunRequest();
    await dispatcherRefuses(OFF, [
      "WHATSAPP_OUTBOUND_ENABLED",
      "WHATSAPP_LIVE_SEND_ENABLED",
      "DATABASE_URL",
    ]);
    expect(await k.request(x.r.id as string)).toMatchObject({
      state: "QUEUED",
      send_started_at: null,
    });

    // the bot worker's sweeper step for this session, at the decision clock 1 ms past dispatch_deadline + 30 s
    const deadline = new Date(x.r.dispatch_deadline as Date).getTime();
    expect(
      await reconcileSession(t.db as never, k.candidateOf(x.session), {
        ...productionStepDeps(botWorkerOn()),
        readClock: async () => new Date(deadline + 30_000 + 1),
      }),
    ).toMatchObject({ kind: "applied" });
    expect(await k.request(x.r.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "bot_send_deadline",
      send_started_at: null,
    });
    const [s] = await sessionsOf(x.f);
    expect(s).toMatchObject({
      state: "HANDED_OVER",
      end_reason: "system_handover",
      handover_reason: "send_held",
    });
    expect(s!.output_suppressed_at).toBeTruthy();
    expect((await k.events(s!.id as string)).map((e) => [e.kind, e.code])).toEqual([
      ["HANDED_OVER", "bot_send_deadline"],
    ]);
    expect(await k.botRequests(x.f)).toHaveLength(1);
  });

  it("row 5 (P-W on, P-B on, P-D running WITHOUT BOTS_RUNTIME_ENABLED): the dispatcher claims and sends the STAFF request only; the BOT request stays QUEUED, untouched (negative control: with the bot gate the same row is claimed)", async () => {
    const x = await previousRunRequest();
    const staff = await k.submit(x.f0); // a STAFF reply in another conversation of the same account
    const before = await k.requestJson(x.r.id as string);
    // the BOT row was due FIRST: had it been a candidate, the claim (next_attempt_at, id order) would have taken it before the
    // STAFF row, while no send yet restricted the account's spacing. Its exclusion is the gate's doing.
    expect(
      (
        await k.one(
          "select b.next_attempt_at < s.next_attempt_at bot_first from outbound_requests b, outbound_requests s where b.id = $1 and s.id = $2",
          [x.r.id, staff.requestId],
        )
      ).bot_first,
    ).toBe(true);

    const transport = new FakeTransport().next(k.accepted("wamid.TEST08E9GATE.STAFF"));
    expect(await dispatcherPass(dispatcherNoBots(), transport)).toMatchObject({
      claimed: 1,
      accepted: 1,
      held: 0,
    });
    expect(transport.calls).toHaveLength(1);
    expect(await k.request(staff.requestId)).toMatchObject({ origin: "STAFF", state: "ACCEPTED" });
    expect(await k.requestJson(x.r.id as string)).toEqual(before); // BOT row: byte-identical, still QUEUED

    // control: the same dispatcher process WITH BOTS_RUNTIME_ENABLED claims and sends that very row. It runs one account
    // spacing interval later (DEFAULT_ACCOUNT_MIN_INTERVAL_MS = 1 s after the STAFF send), well inside the 120 s deadline
    const control = new FakeTransport().next(k.accepted("wamid.TEST08E9GATE.BOT"));
    expect(
      await dispatcherPass(dispatcherAll(), control, () => new Date(Date.now() + 3_000)),
    ).toMatchObject({
      claimed: 1,
      accepted: 1,
    });
    expect(control.calls).toHaveLength(1);
    expect(await k.request(x.r.id as string)).toMatchObject({ state: "ACCEPTED" });
  });

  it("row 6 (P-W off or on, P-B off, P-D all three on): a QUEUED BOT request from a previous run is sent inside its 120 s deadline and held after it; no new request; no reconciliation; a captured input is stale when P-B returns", async () => {
    const x = await previousRunRequest();
    await botWorkerRefuses(OFF, ["BOTS_RUNTIME_ENABLED", "WHATSAPP_OUTBOUND_ENABLED"]);
    const transport = new FakeTransport().next(k.accepted("wamid.TEST08E9GATE.ROW6"));
    expect(await dispatcherPass(dispatcherAll(), transport)).toMatchObject({
      claimed: 1,
      accepted: 1,
    });
    expect(transport.calls).toHaveLength(1);
    expect(await k.request(x.r.id as string)).toMatchObject({ state: "ACCEPTED" });

    // P-W off: a student message creates nothing; P-W on: a reply is captured, but nothing processes it
    expect((await inbound(x.f0, OFF)).trigger).toBeNull();
    const token = x.session.awaiting_token as string;
    const reply = await inbound(x.f0, CAPTURE_ON, {
      message: {
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: `b1.${token}.a`, title: "a" } },
      },
    });
    expect(reply.trigger).toMatchObject({ status: "PENDING", attempts: 0 });
    // no reconciliation while P-B is off: the accepted prompt is not applied (the sweeper's own function also refuses
    // under P-B's gates, defensively)
    const s0 = await k.sessionJson(x.session.id as string);
    expect(
      await reconcileSession(t.db as never, k.candidateOf(x.session), productionStepDeps(OFF)),
    ).toEqual({ kind: "gates_off" });
    expect(await k.sessionJson(x.session.id as string)).toEqual(s0);
    expect(s0).toMatchObject({ state: "WAITING_FOR_SEND" });
    expect(await k.botRequests(x.f)).toHaveLength(1); // no new request

    // P-B returns more than maxInputAge after the reply: it is stale, the session row is not written
    const input = (await triggerRow(t, reply.trigger!.id)).input_occurred_at as Date;
    const [late] = await botWorkerPass(botWorkerOn(), {
      readClock: async () => new Date(input.getTime() + 10 * 60_000 + 1),
    });
    finished(late, "IGNORED", "stale_trigger");
    expect(await k.sessionJson(x.session.id as string)).toEqual(s0);

    // a second previous-run request whose deadline passed while P-D was away: the claim holds it, no transport call
    await k.q("truncate organizations, webhook_requests cascade");
    const y = await previousRunRequest();
    const expiredAt = new Date(y.r.dispatch_deadline as Date).getTime() + 1_000;
    const afterDeadline = new FakeTransport();
    expect(
      await dispatcherPass(dispatcherAll(), afterDeadline, () => new Date(expiredAt)),
    ).toMatchObject({ claimed: 0, held: 1 });
    expect(afterDeadline.calls).toHaveLength(0);
    expect(await k.request(y.r.id as string)).toMatchObject({
      state: "HELD",
      hold_reason: "deadline_passed",
      send_started_at: null,
    });
    expect(await k.botRequests(y.f)).toHaveLength(1);
  });

  it("row 7 (P-W on, P-B with WHATSAPP_OUTBOUND_ENABLED off, P-D any): the bot worker refuses to start, the enqueue path refuses with its configuration, and the captured trigger stays PENDING; even a fully enabled dispatcher has no BOT row to claim", async () => {
    // another world from a previous run (made FIRST: its bot-worker pass must not see this row's trigger): a real live
    // session to aim the enqueue at, and a leftover QUEUED BOT request
    const other = await previousRunRequest();
    const f0 = await k.fixture(menuFlow());
    const m = await inbound(f0, CAPTURE_ON);
    const f = await fxOf(f0, m);
    const before = await triggerRow(t, m.trigger!.id);
    const pbEnv = { BOTS_RUNTIME_ENABLED: "true", DATABASE_URL: t.url };

    await botWorkerRefuses(pbEnv, ["WHATSAPP_OUTBOUND_ENABLED"]);
    // "enqueue would refuse": the approved enqueue path, given this process's configuration, refuses at its gate check
    const refused = await queueBotStep(
      t,
      {
        w: other.f.w,
        d: { bot: other.f.bot, version: other.f.version, deployment: other.f.deployment },
      } as never,
      {
        id: other.session.id as string,
        student: other.f.w.student,
        keys: {} as never,
      },
      { stepSeq: 2, message: textMessage(), now: new Date(), config: readOutboundConfig(pbEnv) },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(OutboundRefusedError);
    expect((refused as OutboundRefusedError).reason).toBe("outbound_disabled");
    expect(await k.botRequests(other.f)).toHaveLength(1); // nothing added

    // P-D "any": fully enabled, it claims only what exists; this world has no BOT request
    const transport = new FakeTransport().next(k.accepted("wamid.TEST08E9GATE.ROW7"));
    expect(await dispatcherPass(dispatcherAll(), transport)).toMatchObject({
      claimed: 1,
      accepted: 1,
    });
    expect(transport.calls).toHaveLength(1); // the OTHER world's leftover request, nothing of this world
    expect(await k.request(other.r.id as string)).toMatchObject({ state: "ACCEPTED" });
    expect(await triggerRow(t, m.trigger!.id)).toEqual(before);
    expect(await botRows(f)).toEqual({ triggers: 1, sessions: 0, events: 0, botRequests: 0 });
  });

  it("row 8 (all on: the activation scenario, here with a FakeTransport only): capture, session, one request, one claim and exactly one transport call; duplicates and repeated passes add nothing", async () => {
    const f0 = await k.fixture(menuFlow());
    const first = await inbound(f0, CAPTURE_ON);
    const f = await fxOf(f0, first);
    expect(readBotWorkerConfig(botWorkerOn())).toMatchObject({ kind: "ready" });
    expect(readWorkerConfig(dispatcherAll(), true)).toMatchObject({ kind: "ready" });

    const [step] = await botWorkerPass(botWorkerOn());
    finished(step, "PROCESSED", "session_started");
    const [s] = await sessionsOf(f);
    const [r] = await k.botRequests(f);
    expect(r).toMatchObject({ state: "QUEUED", bot_session_id: s!.id, bot_step_seq: 1 });

    const transport = new FakeTransport().next(k.accepted("wamid.TEST08E9GATE.ROW8"));
    expect(await dispatcherPass(dispatcherAll(), transport)).toMatchObject({
      claimed: 1,
      accepted: 1,
    });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.message).toMatchObject({ type: "interactive" }); // the flow's first prompt
    expect(await k.request(r!.id as string)).toMatchObject({ state: "ACCEPTED" });
    expect((await k.one("select wamid from messages where id = $1", [r!.message_id])).wamid).toBe(
      "wamid.TEST08E9GATE.ROW8",
    );

    // idempotence: the same webhook again (re-ingest and a worker retry), and repeated worker passes
    expect(await ingestBytes(t.db, deliveryBytes(first.options).bytes)).toEqual([]);
    await handle(CAPTURE_ON, first.event);
    expect(await botWorkerPass(botWorkerOn())).toEqual([]);
    expect(await dispatcherPass(dispatcherAll(), transport)).toMatchObject({ claimed: 0 });
    expect(transport.calls).toHaveLength(1);
    expect(await botRows(f)).toEqual({ triggers: 1, sessions: 1, events: 0, botRequests: 1 });
  });
});
