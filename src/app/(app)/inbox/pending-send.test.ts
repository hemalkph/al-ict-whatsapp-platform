import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActorChanged } from "./api";
import {
  PREFIX,
  journalId,
  RETENTION_MS,
  clearPendingSends,
  dismissPending,
  parseRecord,
  TOMBSTONE_MS,
  type OpView,
  parseSubmitResponse,
  resetMemoryForTests,
  snapshotFor,
  startSend,
  submitPending,
  type Scope,
} from "./pending-send";
import { acceptedNotice } from "./labels";

// The browser's record of an unresolved submission, against a fake fetch and a fake sessionStorage. No timers, no server: each
// test decides exactly what the browser "sees". (The same lifecycle against the real server and database is in e2e/inbox.spec.ts.)

const ME: Scope = { userId: "user-1", membershipId: "mem-1", organizationId: "org-1" };
const CONV = "11111111-1111-4111-8111-111111111111";
const KEY_OF = (scope: Scope, conv: string) => PREFIX + journalId(scope, conv);
const KEY = KEY_OF(ME, CONV);
const OTHER_CONV = "22222222-2222-4222-8222-222222222222";
const REQ = "33333333-3333-4333-8333-333333333333";
const MSG = "44444444-4444-4444-8444-444444444444";
const ok = { requestId: REQ, messageId: MSG, state: "QUEUED", replayed: false };

class FakeStorage {
  map = new Map<string, string>();
  fail = false;
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.fail) throw new DOMException("quota", "QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

let store: FakeStorage;
const calls: Array<{
  url: string;
  headers: Record<string, string>;
  body: { idempotencyKey: string; message: { body: string } };
}> = [];
const queue: Array<() => Response | Promise<Response>> = [];

beforeEach(() => {
  store = new FakeStorage();
  vi.stubGlobal("window", { sessionStorage: store });
  vi.stubGlobal(
    "fetch",
    async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const next = queue.shift();
      if (!next) throw new Error("unexpected request");
      return next();
    },
  );
  calls.length = 0;
  queue.length = 0;
  clearPendingSends();
  resetMemoryForTests();
});
afterEach(() => vi.unstubAllGlobals());

const json =
  (body: unknown, status = 201) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const truncated = () => new Response('{"requestId":"', { status: 201 });
const bodyReadFails = () =>
  new Response(new ReadableStream({ start: (c) => c.error(new TypeError("terminated")) }), {
    status: 201,
  });
const networkFailure = () => {
  throw new TypeError("Failed to fetch");
};
const refused = (code: string, message: string, status = 409) =>
  json({ error: { code, message } }, status);

const live = (scope: Scope, conv: string): OpView => {
  const v = snapshotFor(scope, conv);
  if (!v || v.expired) throw new Error("expected a live operation");
  return v;
};
const tombstoneOf = (conv: string) =>
  JSON.parse(store.getItem(KEY_OF(ME, conv)) ?? "null") as Record<string, unknown> | null;

function begin(body = "hello", replyTo: string | null = null, conv = CONV) {
  const r = startSend(ME, conv, body, replyTo);
  if (r.kind !== "started") throw new Error("not started");
  return r.view.op;
}

describe("an uncertain answer keeps the operation and its identity", () => {
  const cases: Array<[string, () => Response | Promise<Response>]> = [
    ["a success with truncated JSON", truncated],
    ["a success whose body cannot be read", bodyReadFails],
    ["a success that does not match the contract", json({ ok: true })],
    ["a success with an unknown state", json({ ...ok, state: "DONE" })],
    ["a success with a missing id", json({ ...ok, requestId: "x" })],
    ["a first-time success that is not QUEUED", json({ ...ok, state: "ACCEPTED" })],
    ["an unexpected 2xx status", json(ok, 202)],
    ["a network failure / timeout", networkFailure],
    ["a server error", refused("INTERNAL", "boom", 500)],
    [
      "a gateway error with an HTML body",
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    ],
  ];
  for (const [name, answer] of cases) {
    it(`${name}: same key, same text, nothing sent twice, retry reuses both`, async () => {
      const op = begin("Message A");
      queue.push(answer, json({ ...ok, replayed: true }, 200));
      expect((await submitPending(op)).kind).toBe("uncertain");

      const view = live(ME, CONV);
      expect(view.op).toBe(op); // the very same frozen snapshot
      expect(view.inFlight).toBe(false);
      expect(view.uncertain).toBe(true);
      expect(calls).toHaveLength(1); // nothing is re-sent automatically

      const retry = await submitPending(op); // the explicit action
      expect(retry).toMatchObject({ kind: "accepted", replayed: true, state: "QUEUED" });
      expect(calls).toHaveLength(2);
      expect(calls[1]!.body.idempotencyKey).toBe(calls[0]!.body.idempotencyKey); // SAME key
      expect(calls[1]!.body.message.body).toBe("Message A"); // SAME payload
      expect(snapshotFor(ME, CONV)).toBeNull(); // resolved
    });
  }

  it("a request that resolves while the composer is unmounted still resolves the operation", async () => {
    const op = begin();
    queue.push(json(ok));
    await submitPending(op); // nobody is subscribed: the module owns the lifecycle
    expect(snapshotFor(ME, CONV)).toBeNull();
  });
});

describe("definitive answers", () => {
  it("a validated success resolves and removes the record", async () => {
    const op = begin();
    queue.push(json(ok));
    expect(await submitPending(op)).toMatchObject({
      kind: "accepted",
      state: "QUEUED",
      replayed: false,
    });
    expect(snapshotFor(ME, CONV)).toBeNull();
    expect(store.map.size).toBe(0);
  });

  it("a refusal of a first attempt (4xx) is definitive: not queued, record removed, next Send is a new action", async () => {
    const op = begin();
    queue.push(refused("OUTBOUND_REFUSED", "This message cannot be sent: window_closed", 422));
    expect((await submitPending(op)).kind).toBe("refused");
    expect(snapshotFor(ME, CONV)).toBeNull();
    queue.push(json(ok));
    const next = begin("hello");
    expect(next.key).not.toBe(op.key); // a genuinely new action gets a new key
    await submitPending(next);
    expect(calls[1]!.body.idempotencyKey).not.toBe(calls[0]!.body.idempotencyKey);
  });

  it("after an uncertain attempt a refusal only counts if it proves no request exists", async () => {
    const op = begin();
    queue.push(truncated);
    await submitPending(op);

    // switched off, or an access/lookup problem: says NOTHING about the earlier attempt
    for (const answer of [
      refused("OUTBOUND_REFUSED", "This message cannot be sent: outbound_disabled", 422),
      refused("UNAUTHENTICATED", "x", 401),
      refused("FORBIDDEN", "x", 403),
      refused("NOT_FOUND", "x", 404),
    ]) {
      queue.push(answer);
      expect((await submitPending(op)).kind).toBe("inconclusive");
      expect(snapshotFor(ME, CONV)).toMatchObject({ op, uncertain: true, inFlight: false });
    }

    // the policy refused AFTER looking the key up and finding nothing: now it is known
    queue.push(refused("OUTBOUND_REFUSED", "This message cannot be sent: window_closed", 422));
    expect((await submitPending(op)).kind).toBe("refused");
    expect(snapshotFor(ME, CONV)).toBeNull();
  });

  it("every Phase 05 request state is reported as itself, never as queued", async () => {
    for (const state of ["QUEUED", "SENDING", "ACCEPTED", "REJECTED", "HELD", "UNKNOWN_OUTCOME"]) {
      const op = begin(`m-${state}`);
      queue.push(json({ ...ok, state, replayed: true }, 200));
      expect(await submitPending(op)).toMatchObject({ kind: "accepted", state, replayed: true });
      const notice = acceptedNotice(state, true);
      expect(notice.text).toMatch(/^Existing request found/);
      if (state !== "QUEUED") expect(notice.text).not.toMatch(/\bqueued\b/i);
      if (state === "ACCEPTED") expect(notice.text).toMatch(/does not mean it was delivered/);
      if (state === "REJECTED") expect(notice.kind).toBe("warning");
      if (state === "UNKNOWN_OUTCOME") {
        expect(notice.kind).toBe("warning");
        expect(notice.text).toMatch(/may or may not have been sent/);
        expect(notice.text).not.toMatch(/not (been )?(sent|queued)\b(?! to WhatsApp yet)/i);
      }
    }
    expect(acceptedNotice("QUEUED", false).text).toMatch(/has not been sent to WhatsApp yet/);
  });
});

describe("continuity across navigation, reload and users", () => {
  it("survives a reload: the same key and exact text come back, marked unresolved, and nothing is sent by loading", async () => {
    const op = begin("Sinhala සිංහල & <b>raw</b>", "55555555-5555-4555-8555-555555555555");
    queue.push(truncated);
    await submitPending(op);

    resetMemoryForTests(); // a new page load: memory is gone, sessionStorage remains
    const back = live(ME, CONV);
    expect(back.op).toEqual(op);
    expect(back).toMatchObject({ inFlight: false, uncertain: true, persisted: true });
    expect(calls).toHaveLength(1); // loading never sends

    queue.push(json({ ...ok, replayed: true }, 200));
    await submitPending(back.op);
    expect(calls[1]!.body.idempotencyKey).toBe(op.key);
    expect(calls[1]!.body.message).toMatchObject({
      body: "Sinhala සිංහල & <b>raw</b>",
      replyToMessageId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("a reload in the middle of a request finds the operation (it is saved BEFORE anything is sent)", () => {
    const op = begin("mid-flight");
    resetMemoryForTests();
    expect(snapshotFor(ME, CONV)).toMatchObject({ op, inFlight: false, uncertain: true });
  });

  it("is per conversation: switching conversations neither shows nor blocks another one's operation", async () => {
    const a = begin("A", null, CONV);
    queue.push(truncated);
    await submitPending(a);
    expect(snapshotFor(ME, OTHER_CONV)).toBeNull();
    const b = begin("B", null, OTHER_CONV); // allowed: a different conversation
    expect(b.key).not.toBe(a.key);
    expect(live(ME, CONV).op).toBe(a);
  });

  it("allows one unresolved operation per conversation: a second Send is refused until it is resolved or dismissed", async () => {
    const a = begin("A");
    expect(startSend(ME, CONV, "B", null).kind).toBe("blocked");
    queue.push(truncated);
    await submitPending(a);
    expect(startSend(ME, CONV, "B", null).kind).toBe("blocked"); // still unresolved
    dismissPending(a);
    expect(snapshotFor(ME, CONV)).toBeNull();
    expect(store.map.size).toBe(0);
    expect(startSend(ME, CONV, "B", null).kind).toBe("started");
  });

  it("another membership or user never sees the previous one's operation, and its text does not stay on the device", async () => {
    const op = begin("private reply");
    queue.push(truncated);
    await submitPending(op);
    const original = store.getItem(KEY)!;

    for (const other of [
      { ...ME, membershipId: "mem-2" }, // another membership of the same user
      { ...ME, userId: "user-2" },
      { ...ME, organizationId: "org-2" },
    ]) {
      resetMemoryForTests();
      expect(snapshotFor(other, CONV)).toBeNull(); // not shown
      const kept = store.getItem(KEY)!; // reduced to a tombstone: no text, no key, no recipient
      expect(kept).not.toContain("private reply");
      expect(kept).not.toContain(op.key);
      expect(tombstoneOf(CONV)).toMatchObject({
        kind: "expired",
        userId: ME.userId,
        conversationId: CONV,
      });
      store.setItem(KEY, original); // restore it for the next case
    }
  });

  it("the original actor signing back in finds a warning, not a free composer (the payload was reduced when someone else loaded the page)", async () => {
    const op = begin("private reply");
    queue.push(truncated);
    await submitPending(op);
    expect(snapshotFor({ ...ME, userId: "user-2", membershipId: "mem-9" }, CONV)).toBeNull();
    const back = snapshotFor(ME, CONV)!; // same page lifetime: memory was dropped when the scope changed
    expect(back.expired).toBe(true);
    expect(startSend(ME, CONV, "again", null).kind).toBe("blocked");
    expect(JSON.stringify(back)).not.toContain("private reply");
  });

  it("explicit sign-out clears every entry, in memory and in storage", async () => {
    const a = begin("A", null, CONV);
    const b = begin("B", null, OTHER_CONV);
    queue.push(truncated, truncated);
    await submitPending(a);
    await submitPending(b);
    expect(store.map.size).toBe(2);
    clearPendingSends();
    expect(store.map.size).toBe(0);
    expect(snapshotFor(ME, CONV)).toBeNull();
    expect(snapshotFor(ME, OTHER_CONV)).toBeNull();
  });

  it("corrupt, tampered and oversized records block their conversation instead of vanishing; an expired payload becomes a tombstone; a key naming no one is dropped", () => {
    const at = (conv: string) => KEY_OF(ME, conv);
    const good = {
      v: 1,
      ...ME,
      conversationId: CONV,
      key: "key-12345678",
      body: "ok",
      replyTo: null,
      createdAt: Date.now(),
    };
    const C3 = "33333333-3333-4333-8333-333333333333";
    const C4 = "44444444-4444-4444-8444-444444444444";
    const C5 = "55555555-5555-4555-8555-555555555555";
    const C6 = "66666666-6666-4666-8666-666666666666";
    store.setItem(PREFIX + "garbage", "{not json"); // names no actor or conversation
    store.setItem(
      at(OTHER_CONV),
      JSON.stringify({ ...good, conversationId: OTHER_CONV, body: "x".repeat(4097) }),
    );
    store.setItem(
      at(C3),
      JSON.stringify({ ...good, conversationId: C3, createdAt: Date.now() - RETENTION_MS - 1 }),
    );
    store.setItem(at(C4), JSON.stringify({ ...good, conversationId: C4, key: "has spaces!" }));
    store.setItem(at(C5), JSON.stringify({ ...good, conversationId: C5, v: 2 }));
    store.setItem(at(C6), JSON.stringify(good)); // content names CONV, stored under C6's key: identity mismatch
    store.setItem(KEY, JSON.stringify(good));
    store.setItem("unrelated", "keep");
    resetMemoryForTests();

    expect(live(ME, CONV).op.body).toBe("ok");
    expect(store.getItem(PREFIX + "garbage")).toBeNull();
    expect(snapshotFor(ME, C3)).toMatchObject({ expired: true }); // expired payload -> warning
    expect(store.getItem(at(C3))).not.toContain('"body"');
    for (const c of [OTHER_CONV, C4, C5, C6]) {
      expect(snapshotFor(ME, c), c).toMatchObject({ expired: true, unreadable: true }); // blocked, not forgotten
      expect(store.getItem(at(c)), c).not.toContain('"body"');
    }
    expect(store.getItem("unrelated")).toBe("keep");
    expect(parseRecord(null, Date.now())).toBeNull();
    expect(parseRecord("x", Date.now())).toBeNull();
  });

  it("works without storage (private mode, quota, blocked): kept in memory, flagged as unsaved, never silently dropped", async () => {
    store.fail = true; // writes throw
    const op = begin("no storage");
    const view = snapshotFor(ME, CONV)!;
    expect(view.persisted).toBe(false);
    queue.push(truncated);
    await submitPending(op);
    expect(snapshotFor(ME, CONV)).toMatchObject({ op, uncertain: true, persisted: false });
    expect(startSend(ME, CONV, "again", null).kind).toBe("blocked"); // an identical fresh submission is not silently allowed

    // storage that throws on access altogether
    vi.stubGlobal("window", {
      get sessionStorage(): never {
        throw new DOMException("denied", "SecurityError");
      },
    });
    resetMemoryForTests();
    expect(snapshotFor(ME, CONV)).toBeNull(); // the reload case: nothing can be recovered, which the panel text states
    const r = startSend(ME, CONV, "x", null);
    expect(r.kind === "started" && r.view.persisted).toBe(false);
  });
});

describe("response contract", () => {
  it("accepts exactly the Phase 05 shape", () => {
    expect(parseSubmitResponse(ok)).toEqual(ok);
    expect(parseSubmitResponse({ ...ok, replayed: true, state: "UNKNOWN_OUTCOME" })).not.toBeNull();
    for (const bad of [
      null,
      [],
      "x",
      {},
      { ...ok, replayed: "no" },
      { ...ok, messageId: 5 },
      { ...ok, state: "queued" },
    ])
      expect(parseSubmitResponse(bad)).toBeNull();
  });
});

describe("the signed-in account changed (H2)", () => {
  const actorHeader = (call: (typeof calls)[number]) =>
    JSON.parse(decodeURIComponent(call.headers["x-expected-actor"]!)) as Record<string, string>;

  it("every submission states the operation's own actor, first attempt and every re-check", async () => {
    const op = begin("who am I");
    queue.push(truncated, json({ ...ok, replayed: true }, 200));
    await submitPending(op);
    await submitPending(op);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(actorHeader(call)).toEqual(ME);
  });

  it("when the server says the account changed, nothing is discarded, re-keyed or sent again, and the page is told to stop", async () => {
    const op = begin("belongs to the previous account");
    queue.push(truncated, refused("ACTOR_CHANGED", "The signed-in account has changed", 409));
    await submitPending(op); // committed, answer lost
    expect(getActorChanged()).toBe(false);

    const outcome = await submitPending(op); // the explicit "check again" under another account
    expect(outcome.kind).toBe("actor_changed");
    expect(getActorChanged()).toBe(true);
    expect(calls).toHaveLength(2); // no automatic retry
    const view = live(ME, CONV);
    expect(view.op).toBe(op); // the very same operation: same key, same text
    expect(view).toMatchObject({ inFlight: false, uncertain: true });
    expect(store.getItem(KEY)).toContain(op.key); // and still on record for its own account
  });

  it("a first attempt refused for the same reason keeps the operation too (it is not silently moved to the new account)", async () => {
    const op = begin("fresh send from an old tab");
    queue.push(refused("ACTOR_CHANGED", "The signed-in account has changed", 409));
    expect((await submitPending(op)).kind).toBe("actor_changed");
    expect(live(ME, CONV).op).toBe(op);
  });
});

describe("record validation", () => {
  it("a tombstone carries exactly its fixed fields: smuggled text is rejected", () => {
    const t = {
      v: 1,
      kind: "expired",
      ...ME,
      conversationId: CONV,
      createdAt: Date.now() - 1000,
      expiredAt: Date.now(),
    };
    expect(parseRecord(t, Date.now())).toMatchObject({ kind: "expired" });
    expect(parseRecord({ ...t, body: "secret text" }, Date.now())).toBeNull();
    expect(parseRecord({ ...t, kind: "other" }, Date.now())).toBeNull();
    expect(parseRecord({ ...t, expiredAt: "x" }, Date.now())).toBeNull();
    expect(parseRecord({ ...t, userId: "" }, Date.now())).toBeNull();
    expect(parseRecord({ ...t, userId: "u".repeat(129) }, Date.now())).toBeNull();
    expect(parseRecord({ ...t, createdAt: Date.now() + 3_600_000 }, Date.now())).toBeNull();
  });
  it("keeps the retention constants the documentation states", () => {
    expect(RETENTION_MS).toBe(24 * 3600 * 1000);
    expect(TOMBSTONE_MS).toBe(7 * 24 * 3600 * 1000);
  });
});
