import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, type TestDb } from "@/db/__tests__/helpers";
import { handleInboundMessage } from "@/modules/whatsapp/inbound/handler";
import {
  addAccount,
  deliver,
  handleDirect,
  handlerContext,
} from "@/modules/whatsapp/inbound/testing";
import { PN, tenant } from "@/modules/whatsapp/identity/testing";
import type { WebhookEventKind } from "@/modules/whatsapp/queue/process";
import {
  claimNext,
  dispatchBatch,
  executeClaim,
  recoverStuck,
  type DispatchDeps,
} from "./dispatch";
import { MetaTransport, type HttpPost } from "./meta-transport";
import { SEND_START_BUDGET_MS, SENDING_RECOVERY_AFTER_MS } from "./policy";
import { submitOutboundMessage } from "./submit";
import {
  FakeTransport,
  ON,
  addActor,
  addTemplate,
  minutesAgo,
  textInput,
  world,
  type WorldOptions,
} from "./testing";

// Independent-review corrections (Phase 05), on real PostgreSQL with injected fakes only (no network exists here):
//   C1 a BSUID-established contact is never sent to its stored phone      H1 uncertain provider answers are never repeated
//   H2 time is read after blocking waits, and waits are bounded           H3 a worker never starts HTTP on a claim it no longer owns
//   M1 a reply that arrived before the outbound wamid was stored is linked when the wamid is stored

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("outbound corrections", () => {
  let t: TestDb;
  let clock: Date;
  const T0 = new Date("2026-06-01T12:00:00Z");
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await t.pool.query("delete from outbound_requests"); // each test sees only its own requests
    clock = T0;
    for (const m of ["log", "warn", "error"] as const)
      vi.spyOn(console, m).mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  type W = Awaited<ReturnType<typeof world>>;
  const w = (o: WorldOptions = {}) => world(t.db, { lastInboundAt: minutesAgo(30, T0), ...o });
  const deps = (
    transport: DispatchDeps["transport"],
    over: Partial<DispatchDeps> = {},
  ): DispatchDeps => ({
    db: t.db as never,
    transport,
    config: ON,
    now: () => clock,
    random: () => 0.5,
    accountMinIntervalMs: 0,
    conversationMinIntervalMs: 0,
    ...over,
  });
  const queue = (x: W, body = "Hello", over: Record<string, unknown> = {}) =>
    submitOutboundMessage(x.actor.ctx, textInput(x.conversation.id, body), {
      db: t.db as never,
      config: ON,
      now: () => clock,
      ...over,
    });
  const row = async (id: string) =>
    (await t.pool.query("select * from outbound_requests where id = $1", [id])).rows[0];
  const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
  const run = (transport: DispatchDeps["transport"], over: Partial<DispatchDeps> = {}) =>
    dispatchBatch(deps(transport, over), { batchSize: 10, concurrency: 1 });

  // ================================================================================================ C1
  describe("C1: recipient safety at dispatch", () => {
    it("a legacy phone-only contact follows the phone policy: exactly one send, to the stored phone", async () => {
      const x = await w({ waId: "94771110001" });
      const r = await queue(x);
      const transport = new FakeTransport();
      await run(transport);
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]!.recipient).toEqual({ kind: "PHONE", id: "94771110001" });
      expect((await row(r.requestId)).state).toBe("ACCEPTED");
    });

    it("a contact that is observed with a BSUID AFTER the request was queued is HELD at dispatch and nothing reaches the transport", async () => {
      const x = await w({ waId: "94771110002" });
      const r = await queue(x); // queued while the contact was phone-only
      await t.db.insert(schema.contactBsuids).values({
        organizationId: x.org.id,
        contactId: x.contact.id,
        bsuid: "LK.Late0001",
        firstSeenAt: T0,
        lastSeenAt: T0,
      });
      const transport = new FakeTransport();
      await run(transport);
      expect(transport.calls).toHaveLength(0);
      expect(await row(r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "bsuid_send_unavailable",
      });
    });

    it("the same, with BSUID sending enabled: the queued PHONE recipient no longer matches, so it is HELD recipient_changed", async () => {
      const on = { ...ON, bsuidRecipientEnabled: true };
      const x = await w({ waId: "94771110003" });
      const r = await queue(x, "Hello", { config: on });
      expect((await row(r.requestId)).recipient_kind).toBe("PHONE");
      await t.db.insert(schema.contactBsuids).values({
        organizationId: x.org.id,
        contactId: x.contact.id,
        bsuid: "LK.Late0002",
        firstSeenAt: T0,
        lastSeenAt: T0,
      });
      const transport = new FakeTransport();
      await run(transport, { config: on });
      expect(transport.calls).toHaveLength(0);
      expect(await row(r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "recipient_changed",
      });
    });

    it("an alias retired after queueing (the number may have changed hands) is HELD, never sent to the old phone", async () => {
      const on = { ...ON, bsuidRecipientEnabled: true };
      const x = await w({ waId: "94771110004", bsuids: [{ bsuid: "LK.Rot00001" }] });
      const r = await queue(x, "Hello", { config: on });
      expect((await row(r.requestId)).recipient_kind).toBe("BSUID");
      await t.pool.query("update contact_bsuids set retired_at = $2 where contact_id = $1", [
        x.contact.id,
        T0,
      ]);
      const transport = new FakeTransport();
      await run(transport, { config: on });
      expect(transport.calls).toHaveLength(0);
      expect((await row(r.requestId)).state).toBe("HELD");
    });
  });

  describe("phone-only proactive templates are re-checked at dispatch", () => {
    it("a template queued while the window was open is HELD if the window closed before the claim; nothing is sent", async () => {
      const x = await w({ lastInboundAt: new Date(T0.getTime() - (23 * 60 + 45) * 60_000) });
      const template = await addTemplate(t.db, x, { category: "UTILITY" });
      const r = await submitOutboundMessage(
        x.actor.ctx,
        {
          idempotencyKey: "tpl-dispatch-key-1",
          conversationId: x.conversation.id,
          message: { type: "template", templateId: template.id, parameters: [] },
        },
        { db: t.db as never, config: ON, now: () => clock },
      );
      advance(7 * 60_000); // inside the dispatch deadline, past the window
      const transport = new FakeTransport();
      await run(transport);
      expect(transport.calls).toHaveLength(0);
      expect(await row(r.requestId)).toMatchObject({ state: "HELD", hold_reason: "window_closed" });
    });
  });

  // ================================================================================================ H1
  describe("H1: provider answers (through the real transport with an injected fetch)", () => {
    const TOKEN = "t".repeat(32);
    const liveEnv = {
      WHATSAPP_OUTBOUND_ENABLED: "true",
      WHATSAPP_LIVE_SEND_ENABLED: "true",
      WHATSAPP_GRAPH_API_VERSION: "v25.0",
      WA_TOKEN_TEST: TOKEN,
    };
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      body: Buffer.from(
        typeof body === "string" ? body : JSON.stringify(body),
      ) as Uint8Array | null,
    });
    const meta = (fetchImpl: HttpPost) =>
      new MetaTransport({ env: () => liveEnv, post: fetchImpl });
    const created = { messages: [{ id: "wamid.MAYBE" }] };
    const fail = (message: string, props: Record<string, unknown>) =>
      Object.assign(new Error(message), props);

    const uncertain: Array<[string, () => Promise<ReturnType<typeof reply>> | never]> = [
      ["a bare HTTP 429", async () => reply(429, "")],
      ["HTTP 429 with malformed JSON", async () => reply(429, "{not json")],
      [
        "HTTP 429 with an unknown provider code",
        async () => reply(429, { error: { code: 424242 } }),
      ],
      [
        "HTTP 429 with contradictory success-shaped data",
        async () => reply(429, { error: { code: 130429 }, ...created }),
      ],
      [
        "an unknown 4xx with an arbitrary numeric code",
        async () => reply(400, { error: { code: 999999 } }),
      ],
      ["a malformed successful response", async () => reply(200, {})],
      [
        "a timeout after possible transmission",
        async () => {
          throw fail("aborted", { name: "AbortError" });
        },
      ],
      ["a provider 5xx", async () => reply(503, { error: { code: 131016 } })],
      [
        "a connection reset",
        async () => {
          throw fail("read ECONNRESET", { code: "ECONNRESET" });
        },
      ],
    ];

    it.each(uncertain)(
      "%s: ONE http call, UNKNOWN_OUTCOME, and never another call, even after a restart",
      async (_name, impl) => {
        const x = await w();
        const r = await queue(x);
        const post = vi.fn<HttpPost>(impl as never);
        advance(5_000);
        const summary = await run(meta(post));
        expect(summary).toMatchObject({ claimed: 1, unknown: 1, accepted: 0, retryScheduled: 0 });
        expect(post).toHaveBeenCalledTimes(1);
        expect(await row(r.requestId)).toMatchObject({
          state: "UNKNOWN_OUTCOME",
          attempt_count: 1,
        });

        // time passes, the worker keeps running...
        for (let i = 0; i < 3; i++) {
          advance(60 * 60_000);
          await run(meta(post));
        }
        // ...and a brand-new worker (new transport instance, new owner id) takes over after recovery has also run
        advance(SENDING_RECOVERY_AFTER_MS + 1);
        expect(await recoverStuck(deps(meta(post)))).toBe(0);
        await run(meta(post), { newOwner: () => randomUUID() });
        expect(post).toHaveBeenCalledTimes(1);
        expect(await row(r.requestId)).toMatchObject({
          state: "UNKNOWN_OUTCOME",
          attempt_count: 1,
        });
      },
    );

    it("a documented definitive rejection is REJECTED after one call and never repeated", async () => {
      const x = await w();
      const r = await queue(x);
      const post = vi.fn<HttpPost>(async () => reply(400, { error: { code: 100 } }));
      advance(5_000);
      await run(meta(post));
      advance(60 * 60_000);
      await run(meta(post));
      expect(post).toHaveBeenCalledTimes(1);
      expect(await row(r.requestId)).toMatchObject({
        state: "REJECTED",
        failure_code: "invalid_request",
      });
    });

    it.each([130429, 131056, 80007, 4])(
      "documented throttling (HTTP 429, code %i, Retry-After) is UNKNOWN_OUTCOME after ONE call, never repeated, even after a restart",
      async (code) => {
        const x = await w();
        const r = await queue(x);
        const post = vi.fn<HttpPost>(async () =>
          reply(429, { error: { code } }, { "retry-after": "1" }),
        );
        advance(5_000);
        const summary = await run(meta(post));
        expect(summary).toMatchObject({ claimed: 1, unknown: 1, retryScheduled: 0, accepted: 0 });
        expect(await row(r.requestId)).toMatchObject({
          state: "UNKNOWN_OUTCOME",
          failure_code: "rate_limited_semantics_unverified",
          provider_error_code: String(code),
          provider_http_status: 429,
          attempt_count: 1,
          claimed_by: expect.any(String),
        });
        for (let i = 0; i < 3; i++) {
          advance(60 * 60_000);
          await run(meta(post), { newOwner: () => randomUUID() });
        }
        advance(SENDING_RECOVERY_AFTER_MS + 1);
        await recoverStuck(deps(meta(post)));
        expect(post).toHaveBeenCalledTimes(1);
        expect((await row(r.requestId)).state).toBe("UNKNOWN_OUTCOME");
        const message = (
          await t.pool.query("select wamid from messages where id = $1", [
            (await row(r.requestId)).message_id,
          ])
        ).rows[0];
        expect(message.wamid).toBeNull(); // no id is ever invented
      },
    );

    it("a connection refusal is UNKNOWN_OUTCOME after ONE attempt: an error code never proves that nothing was transmitted", async () => {
      const x = await w();
      const r = await queue(x);
      const post = vi.fn<HttpPost>(async () => {
        throw fail("fetch failed", { cause: { code: "ECONNREFUSED" } });
      });
      advance(5_000);
      await run(meta(post));
      expect(await row(r.requestId)).toMatchObject({ state: "UNKNOWN_OUTCOME", attempt_count: 1 });
      advance(10 * 60_000);
      await run(meta(post));
      expect(post).toHaveBeenCalledTimes(1);
    });

    it("the one automatic retry left: a refusal BEFORE any HTTP attempt (a missing credential) is retried, with zero HTTP calls until it is fixed", async () => {
      const x = await w();
      const r = await queue(x);
      const post = vi.fn<HttpPost>(async () =>
        reply(200, { messages: [{ id: "wamid.AFTERFIX" }] }),
      );
      const env: Record<string, string | undefined> = { ...liveEnv, WA_TOKEN_TEST: undefined };
      const transport = new MetaTransport({ env: () => env, post });
      advance(5_000);
      await run(transport);
      expect(post).not.toHaveBeenCalled();
      expect((await row(r.requestId)).state).toBe("QUEUED");
      env.WA_TOKEN_TEST = TOKEN;
      advance(10 * 60_000);
      await run(transport);
      expect(post).toHaveBeenCalledTimes(1);
      expect((await row(r.requestId)).state).toBe("ACCEPTED");
    });

    it("a worker that dies after SENDING: recovery makes it UNKNOWN_OUTCOME and nothing is ever sent for it", async () => {
      const x = await w();
      const r = await queue(x);
      advance(5_000);
      const { claim } = await claimNext(deps(new FakeTransport())); // the process "dies" here
      expect(claim).not.toBeNull();
      const post = vi.fn<HttpPost>(async () => reply(200, created));
      advance(SENDING_RECOVERY_AFTER_MS + 1_000);
      const summary = await run(meta(post));
      expect(summary.recoveredUnknown).toBe(1);
      advance(60 * 60_000);
      await run(meta(post));
      expect(post).not.toHaveBeenCalled();
      expect((await row(r.requestId)).state).toBe("UNKNOWN_OUTCOME");
    });
  });

  // ================================================================================================ H2
  describe("H2: time is read after blocking waits", () => {
    /** Holds a row lock on the account so the claim's FOR SHARE read blocks, until released. */
    async function holdAccountLock(accountId: string) {
      const c = await t.pool.connect();
      await c.query("begin");
      await c.query("select 1 from whatsapp_accounts where id = $1 for update", [accountId]);
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          await c.query("rollback");
          c.release();
        },
      };
    }
    async function untilBlocked() {
      for (let i = 0; i < 200; i++) {
        const r = await t.pool.query(
          "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        if (r.rows[0].n > 0) return;
        await sleep(10);
      }
      throw new Error("the claim never blocked on the lock");
    }

    it("the service window expires while the claim waits for a lock: HELD window_closed, nothing sent", async () => {
      const x = await w({ lastInboundAt: new Date(T0.getTime() - (23 * 60 + 45) * 60_000) }); // 5 minutes of eligibility left
      const r = await queue(x);
      const lock = await holdAccountLock(x.account.id);
      const transport = new FakeTransport();
      const claiming = claimNext(deps(transport));
      await untilBlocked();
      advance(7 * 60_000); // still inside the 15-minute dispatch deadline, but past the window
      await lock.release();
      const { claim, held } = await claiming;
      expect(claim).toBeNull();
      expect(held).toBe(1);
      expect(transport.calls).toHaveLength(0);
      expect(await row(r.requestId)).toMatchObject({ state: "HELD", hold_reason: "window_closed" });
    });

    it("the dispatch deadline passes while the claim waits for a lock: HELD deadline_passed, nothing sent", async () => {
      const x = await w();
      const r = await queue(x);
      const lock = await holdAccountLock(x.account.id);
      const transport = new FakeTransport();
      const claiming = claimNext(deps(transport));
      await untilBlocked();
      advance(16 * 60_000);
      await lock.release();
      const { claim } = await claiming;
      expect(claim).toBeNull();
      expect(transport.calls).toHaveLength(0);
      expect(await row(r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "deadline_passed",
      });
    });

    it("send_started_at is the time AFTER the wait, not the time the claim began", async () => {
      const x = await w();
      const r = await queue(x);
      const lock = await holdAccountLock(x.account.id);
      const claiming = claimNext(deps(new FakeTransport()));
      await untilBlocked();
      advance(3_000);
      await lock.release();
      const { claim } = await claiming;
      expect(claim).not.toBeNull();
      const after = await row(r.requestId);
      expect(after.state).toBe("SENDING");
      expect(new Date(after.send_started_at).toISOString()).toBe(
        new Date(T0.getTime() + 3_000).toISOString(),
      );
      expect(new Date(after.claimed_at).toISOString()).toBe(
        new Date(T0.getTime() + 3_000).toISOString(),
      );
    });

    it("pacing is judged at the time after the wait: a request that was too close when the claim began is sent once the gap has passed", async () => {
      const x = await w();
      const a = await queue(x, "first");
      const b = await queue(x, "second");
      const gap = 10_000;
      // one of them goes out at T0 + 1s
      advance(1_000);
      const paced = { conversationMinIntervalMs: gap, accountMinIntervalMs: 0 };
      await dispatchBatch(deps(new FakeTransport(), paced), { batchSize: 1, concurrency: 1 });
      const states = [(await row(a.requestId)).state, (await row(b.requestId)).state].sort();
      expect(states).toEqual(["ACCEPTED", "QUEUED"]);
      const second = (await row(a.requestId)).state === "QUEUED" ? a : b;
      // the other begins at T0 + 3s (inside the gap) but waits for a lock; when it gets the lock the time is T0 + 12s
      advance(2_000);
      const lock = await holdAccountLock(x.account.id);
      const claiming = claimNext(deps(new FakeTransport(), paced));
      await untilBlocked();
      advance(9_000);
      await lock.release();
      const { claim } = await claiming;
      expect(claim).not.toBeNull();
      expect(new Date((await row(second.requestId)).send_started_at).getTime()).toBe(
        T0.getTime() + 12_000,
      );
    });

    it("the wait itself is bounded: a lock held too long leaves the request QUEUED and unchanged", async () => {
      const x = await w();
      const r = await queue(x);
      const lock = await holdAccountLock(x.account.id);
      try {
        const started = Date.now();
        const result = await claimNext(deps(new FakeTransport(), { lockTimeoutMs: 300 }));
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(result).toEqual({ claim: null, held: 0 });
      } finally {
        await lock.release();
      }
      expect(await row(r.requestId)).toMatchObject({
        state: "QUEUED",
        attempt_count: 0,
        claimed_by: null,
      });
      const transport = new FakeTransport();
      await run(transport); // the next tick succeeds
      expect(transport.calls).toHaveLength(1);
    });
  });

  // ================================================================================================ H3
  describe("H3: pre-transmission authorization", () => {
    const claimed = async (x: W) => {
      const r = await queue(x);
      advance(1_000);
      const { claim } = await claimNext(deps(new FakeTransport()));
      expect(claim).not.toBeNull();
      return { requestId: r.requestId, claim: claim! };
    };

    it("D: a valid claim sends exactly once and is recorded", async () => {
      const x = await w();
      const { requestId, claim } = await claimed(x);
      const transport = new FakeTransport();
      expect(await executeClaim(deps(transport), claim)).toBe("accepted");
      expect(transport.calls).toHaveLength(1);
      expect((await row(requestId)).state).toBe("ACCEPTED");
    });

    it("A: worker A is paused after claiming, worker B recovers the request, A resumes: ZERO calls and no state regression", async () => {
      const x = await w();
      const { requestId, claim } = await claimed(x);
      advance(SENDING_RECOVERY_AFTER_MS + 1_000);
      expect(await recoverStuck(deps(new FakeTransport()))).toBe(1); // worker B
      const before = await row(requestId);
      expect(before.state).toBe("UNKNOWN_OUTCOME");
      const transport = new FakeTransport(); // worker A resumes
      expect(await executeClaim(deps(transport), claim)).toBe("fence_lost");
      expect(transport.calls).toHaveLength(0);
      expect(await row(requestId)).toEqual(before);
    });

    it("B: a claim token that no longer matches sends nothing and changes nothing", async () => {
      const x = await w();
      const { requestId, claim } = await claimed(x);
      await t.pool.query("update outbound_requests set claimed_by = $2 where id = $1", [
        requestId,
        randomUUID(),
      ]);
      const before = await row(requestId);
      const transport = new FakeTransport();
      expect(await executeClaim(deps(transport), claim)).toBe("fence_lost");
      expect(transport.calls).toHaveLength(0);
      expect(await row(requestId)).toEqual(before);
    });

    it.each([
      ["ACCEPTED", "state = 'ACCEPTED', accepted_at = now(), finished_at = now()"],
      ["REJECTED", "state = 'REJECTED', failure_code = 'invalid_request', finished_at = now()"],
      ["HELD", "state = 'HELD', hold_reason = 'window_closed', finished_at = now()"],
      ["UNKNOWN_OUTCOME", "state = 'UNKNOWN_OUTCOME', failure_code = 'x', finished_at = now()"],
      ["QUEUED", "state = 'QUEUED', claimed_by = null"],
    ])("C: a request that is already %s sends nothing", async (state, set) => {
      const x = await w();
      const { requestId, claim } = await claimed(x);
      await t.pool.query(`update outbound_requests set ${set} where id = $1`, [requestId]);
      const before = await row(requestId);
      expect(before.state).toBe(state);
      const transport = new FakeTransport();
      expect(await executeClaim(deps(transport), claim)).toBe("fence_lost");
      expect(transport.calls).toHaveLength(0);
      expect(await row(requestId)).toEqual(before);
    });

    it("E: a claim that is too old to START is not sent; it provably did not leave, so it returns to the queue", async () => {
      const x = await w();
      const { requestId, claim } = await claimed(x);
      advance(SEND_START_BUDGET_MS + 1_000);
      const transport = new FakeTransport();
      expect(await executeClaim(deps(transport), claim)).toBe("retry_scheduled");
      expect(transport.calls).toHaveLength(0);
      expect((await row(requestId)).state).toBe("QUEUED");
    });

    it("the dispatch deadline passing between claim and send stops the send; the next claim then HELDs it", async () => {
      const x = await w();
      const r = await queue(x);
      advance(14 * 60_000 + 30_000);
      const { claim } = await claimNext(deps(new FakeTransport()));
      expect(claim).not.toBeNull();
      advance(40_000); // inside the send-start budget, past the 15-minute deadline
      const transport = new FakeTransport();
      expect(await executeClaim(deps(transport), claim!)).toBe("retry_scheduled");
      expect(transport.calls).toHaveLength(0);
      advance(60 * 60_000);
      await run(transport);
      expect(transport.calls).toHaveLength(0);
      expect(await row(r.requestId)).toMatchObject({
        state: "HELD",
        hold_reason: "deadline_passed",
      });
    });

    it("an account disabled between claim and send, or the outbound gate turned off, stops the send", async () => {
      const x = await w();
      const { requestId, claim } = await claimed(x);
      const transport = new FakeTransport();
      expect(
        await executeClaim(deps(transport, { config: { ...ON, outboundEnabled: false } }), claim),
      ).toBe("retry_scheduled");
      expect(transport.calls).toHaveLength(0);
      expect((await row(requestId)).state).toBe("QUEUED");

      const y = await w();
      const second = await claimed(y);
      await t.pool.query("update whatsapp_accounts set status = 'DISABLED' where id = $1", [
        y.account.id,
      ]);
      expect(await executeClaim(deps(transport), second.claim)).toBe("retry_scheduled");
      expect(transport.calls).toHaveLength(0);
    });

    it("F: recovery racing a dispatch that already started its request: the late result cannot overwrite UNKNOWN_OUTCOME and no id is fabricated", async () => {
      const x = await w();
      const { requestId, claim } = await claimed(x);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const transport = new FakeTransport().next(async () => {
        await gate;
        return {
          kind: "accepted",
          wamid: "wamid.LATE",
          providerStatus: "accepted",
          httpStatus: 200,
        };
      });
      const sending = executeClaim(deps(transport), claim);
      await sleep(50); // authorization passed; the request is "in flight"
      expect(transport.calls).toHaveLength(1);
      advance(SENDING_RECOVERY_AFTER_MS + 1_000);
      expect(await recoverStuck(deps(transport))).toBe(1);
      release();
      expect(await sending).toBe("fence_lost");
      expect(transport.calls).toHaveLength(1);
      expect((await row(requestId)).state).toBe("UNKNOWN_OUTCOME");
      const message = (
        await t.pool.query("select wamid from messages where id = $1", [claim.messageId])
      ).rows[0];
      expect(message.wamid).toBeNull();
    });

    it("two dispatchers racing for the same single request: exactly one claim, one call", async () => {
      const x = await w();
      const r = await queue(x);
      advance(1_000);
      const transport = new FakeTransport();
      await Promise.all([run(transport), run(transport), run(transport)]);
      expect(transport.calls).toHaveLength(1);
      expect((await row(r.requestId)).state).toBe("ACCEPTED");
    });
  });

  // ================================================================================================ M1
  describe("M1: a reply that arrived before the outbound wamid was stored", () => {
    // These tests use the real clock because inbound timestamps come from the real ingest path.
    const NOW = () => new Date();
    async function start(pn = PN, waba = "200000000000001") {
      const { org, account } = await tenant(t.db, { pn, waba });
      const first = await deliver(t.db, { pn, waba, from: "15550100123" });
      await handleDirect(t.db, first); // creates the contact and the conversation (last_inbound_at = just now)
      const [conversation] = (
        await t.pool.query("select * from conversations where organization_id = $1", [org.id])
      ).rows;
      const actor = await addActor(t.db, org.id);
      const submit = (body = "Hi") =>
        submitOutboundMessage(actor.ctx, textInput(conversation.id, body), {
          db: t.db as never,
          config: ON,
          now: NOW,
        });
      return { org, account, conversation, actor, submit, pn, waba };
    }
    const accepted = (wamid: string) =>
      new FakeTransport().next({
        kind: "accepted",
        wamid,
        providerStatus: "accepted",
        httpStatus: 200,
      });
    const dep = (transport: FakeTransport) => deps(transport, { now: NOW });
    const replyRow = async (wamid: string) =>
      (
        await t.pool.query(
          "select id, reply_to_wamid, reply_to_message_id from messages where wamid = $1",
          [wamid],
        )
      ).rows[0];
    const sendAccepted = async (s: Awaited<ReturnType<typeof start>>, wamid: string) => {
      const r = await s.submit();
      const { claim } = await claimNext(dep(accepted(wamid)));
      expect(claim).not.toBeNull();
      return { requestId: r.requestId, claim: claim!, transport: accepted(wamid) };
    };

    it("the reply is initially unlinked and is linked to the outbound parent once the acceptance is stored", async () => {
      const s = await start("100000000000101");
      const W = "wamid.OUT.M1.A";
      const { claim, transport } = await sendAccepted(s, W);
      const reply = await deliver(t.db, {
        pn: s.pn,
        waba: s.waba,
        from: "15550100123",
        message: { type: "text", text: { body: "re" }, context: { id: W } },
      });
      await handleDirect(t.db, reply);
      const before = await replyRow(reply.providerObjectId);
      expect(before.reply_to_wamid).toBe(W);
      expect(before.reply_to_message_id).toBeNull();
      expect(await executeClaim(dep(transport), claim)).toBe("accepted");
      const after = await replyRow(reply.providerObjectId);
      expect(after.reply_to_message_id).toBe(claim.messageId);
      const parent = (
        await t.pool.query("select wamid, direction from messages where id = $1", [claim.messageId])
      ).rows[0];
      expect(parent).toEqual({ wamid: W, direction: "OUTBOUND" });
    });

    it("the reply is processed by a transaction that is still open while the acceptance is recorded: the acceptance waits for it and links the reply", async () => {
      const s = await start("100000000000102");
      const W = "wamid.OUT.M1.RACE";
      const { claim, transport } = await sendAccepted(s, W);
      const reply = await deliver(t.db, {
        pn: s.pn,
        waba: s.waba,
        from: "15550100123",
        message: { type: "text", text: { body: "re" }, context: { id: W } },
      });
      let handled!: () => void;
      const handlerDone = new Promise<void>((resolve) => (handled = resolve));
      let commit!: () => void;
      const gate = new Promise<void>((resolve) => (commit = resolve));
      const inbound = t.db.transaction(async (tx) => {
        await handleInboundMessage(
          tx,
          { ...reply, eventType: reply.eventType as WebhookEventKind },
          handlerContext(),
        );
        handled();
        await gate; // the reply is stored in this transaction but not committed
      });
      await handlerDone;
      const executing = executeClaim(dep(transport), claim);
      await sleep(300);
      // the acceptance is waiting on the per-message lock the inbound handler holds for the parent wamid
      expect((await row(claim.requestId)).state).toBe("SENDING");
      commit();
      await inbound;
      expect(await executing).toBe("accepted");
      expect((await replyRow(reply.providerObjectId)).reply_to_message_id).toBe(claim.messageId);
    });

    it("replies in another conversation, another account, or another organization are never linked", async () => {
      const s = await start("100000000000103");
      const W = "wamid.OUT.M1.SCOPE";
      const { claim, transport } = await sendAccepted(s, W);
      // another conversation, same account
      const sameAccount = await deliver(t.db, {
        pn: s.pn,
        waba: s.waba,
        from: "15550100777",
        message: { type: "text", text: { body: "x" }, context: { id: W } },
      });
      await handleDirect(t.db, sameAccount);
      // another account of the same organization
      const second = await addAccount(t.db, s.org.id, "100000000000203", "200000000000203");
      const otherAccount = await deliver(t.db, {
        pn: second.phoneNumberId,
        waba: second.wabaId,
        from: "15550100123",
        message: { type: "text", text: { body: "y" }, context: { id: W } },
      });
      await handleDirect(t.db, otherAccount);
      // another organization
      await tenant(t.db, { pn: "100000000000303", waba: "200000000000303" });
      const otherOrg = await deliver(t.db, {
        pn: "100000000000303",
        waba: "200000000000303",
        from: "15550100123",
        message: { type: "text", text: { body: "z" }, context: { id: W } },
      });
      await handleDirect(t.db, otherOrg);

      expect(await executeClaim(dep(transport), claim)).toBe("accepted");
      for (const e of [sameAccount, otherAccount, otherOrg]) {
        const r = await replyRow(e.providerObjectId);
        expect(r.reply_to_wamid).toBe(W);
        expect(r.reply_to_message_id).toBeNull();
      }
    });

    it("duplicate acceptance is harmless: the second attempt sends nothing and the link is unchanged", async () => {
      const s = await start("100000000000104");
      const W = "wamid.OUT.M1.DUP";
      const { claim, transport } = await sendAccepted(s, W);
      const reply = await deliver(t.db, {
        pn: s.pn,
        waba: s.waba,
        from: "15550100123",
        message: { type: "text", text: { body: "re" }, context: { id: W } },
      });
      await handleDirect(t.db, reply);
      expect(await executeClaim(dep(transport), claim)).toBe("accepted");
      const linked = await replyRow(reply.providerObjectId);
      expect(await executeClaim(dep(transport), claim)).toBe("fence_lost");
      expect(transport.calls).toHaveLength(1);
      expect(await replyRow(reply.providerObjectId)).toEqual(linked);
    });
  });
});
