import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_PREFIX,
  MAX_RECORDS,
  PREFIX,
  RETENTION_MS,
  TOMBSTONE_MS,
  acknowledgeExpired,
  capacityProblem,
  checkExpiry,
  sameOperation,
  parseRecord,
  clearPendingSends,
  dismissPending,
  journalId,
  resetMemoryForTests,
  snapshotFor,
  startSend,
  submitPending,
  type PendingOp,
  type Scope,
  type StartResult,
} from "./pending-send";

// The journal's two integrity rules, against a fake sessionStorage, a controllable clock and a fetch stub:
//  - CAPACITY is a limit on NEW operations. It is checked and reserved synchronously before anything is sent, counts every
//    actor's unexpired records, and never deletes a record to make room (also for a journal that is already over the limit).
//  - IDENTITY is (user, organization, membership, conversation): two actors never share a record, whatever the conversation.

const A: Scope = { userId: "user-a", membershipId: "mem-a", organizationId: "org-1" };
const B: Scope = { userId: "user-b", membershipId: "mem-b", organizationId: "org-1" }; // same organization
const C: Scope = { userId: "user-c", membershipId: "mem-c", organizationId: "org-2" }; // another organization
const A2: Scope = { ...A, membershipId: "mem-a2" }; // same user, another membership
const CONV = "11111111-1111-4111-8111-111111111111";
const T0 = Date.UTC(2026, 9, 12, 8, 0, 0);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const KEY_OF = (scope: Scope, conv: string) => PREFIX + journalId(scope, conv);

class FakeStorage {
  map = new Map<string, string>();
  fail = false;
  writeAttempts = 0;
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
    this.writeAttempts++;
    if (this.fail) throw new DOMException("quota", "QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
let store: FakeStorage;
let requests = 0;
const windowStub = {
  get sessionStorage() {
    return store;
  },
  addEventListener: () => undefined,
};

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  store = new FakeStorage();
  requests = 0;
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined });
  vi.stubGlobal("fetch", async () => {
    requests++;
    throw new TypeError("network");
  });
  clearPendingSends();
  resetMemoryForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const at = (ms: number) => vi.setSystemTime(T0 + ms);
const opRecord = (
  scope: Scope,
  conv: string,
  createdAt = T0,
  key = `key-${conv.slice(-6)}-0001`,
) => ({
  v: 1,
  ...scope,
  conversationId: conv,
  key,
  body: `text of ${conv.slice(-6)}`,
  replyTo: null,
  createdAt,
});
const tombRecord = (scope: Scope, conv: string, createdAt = T0) => ({
  v: 1,
  kind: "expired",
  ...scope,
  conversationId: conv,
  createdAt,
  expiredAt: createdAt + RETENTION_MS,
});
const seed = (scope: Scope, conv: string, record: unknown) =>
  store.setItem(KEY_OF(scope, conv), JSON.stringify(record));
const start = (scope: Scope, conv: string, body = "message") => startSend(scope, conv, body, null);
const started = (r: StartResult) => {
  if (r.kind !== "started") throw new Error(`not started: ${JSON.stringify(r)}`);
  return r.view.op;
};
const stored = (prefix = PREFIX) => [...store.map.keys()].filter((k) => k.startsWith(prefix));

describe("capacity: a limit on new operations, never a reason to delete", () => {
  it("A. 200 operations fit; the 201st is refused before any request; nothing earlier is touched", () => {
    const ops: PendingOp[] = [];
    for (let i = 1; i <= MAX_RECORDS - 1; i++) ops.push(started(start(A, uuid(i))));
    expect(capacityProblem(A)).toBeNull();
    ops.push(started(start(A, uuid(MAX_RECORDS)))); // the 200th succeeds
    expect(capacityProblem(A)).toBe("full");

    const refused = start(A, uuid(MAX_RECORDS + 1));
    expect(refused).toEqual({ kind: "blocked", reason: "capacity", problem: "full" });
    expect(requests).toBe(0);
    expect(stored()).toHaveLength(MAX_RECORDS);
    for (const op of ops) expect(snapshotFor(A, op.conversationId)).toMatchObject({ op });
    expect(snapshotFor(A, uuid(MAX_RECORDS + 1))).toBeNull(); // no half-created record either
  });

  it("re-checking an existing operation needs no slot, even in a full journal", async () => {
    for (let i = 1; i <= MAX_RECORDS; i++) start(A, uuid(i));
    const view = snapshotFor(A, uuid(7));
    if (!view || view.expired) throw new Error("expected a live operation");
    await submitPending(view.op); // a request is made (the stub fails it: uncertain), no slot was involved
    expect(requests).toBe(1);
    expect(stored()).toHaveLength(MAX_RECORDS);
  });

  it("B. a reload at capacity keeps all 200 and still refuses a new operation", () => {
    for (let i = 1; i <= MAX_RECORDS; i++) seed(A, uuid(i), opRecord(A, uuid(i)));
    resetMemoryForTests();
    for (let i = 1; i <= MAX_RECORDS; i++) expect(snapshotFor(A, uuid(i))?.expired).toBe(false);
    expect(stored()).toHaveLength(MAX_RECORDS);
    expect(start(A, uuid(999)).kind).toBe("blocked");
    expect(stored()).toHaveLength(MAX_RECORDS);
  });

  it("C. a journal that already holds 201 valid records (an older version) keeps all of them and refuses new sends", () => {
    for (let i = 1; i <= MAX_RECORDS + 1; i++) seed(A, uuid(i), opRecord(A, uuid(i)));
    resetMemoryForTests();
    expect(capacityProblem(A)).toBe("overfull");
    expect(start(A, uuid(5000))).toEqual({
      kind: "blocked",
      reason: "capacity",
      problem: "overfull",
    });
    expect(stored()).toHaveLength(MAX_RECORDS + 1); // nothing evicted, nothing created
    for (let i = 1; i <= MAX_RECORDS + 1; i++) expect(snapshotFor(A, uuid(i))).not.toBeNull(); // each still reachable
    expect(requests).toBe(0);
  });

  it("C'. the same for 201 records still in the previous version's format: all are migrated, none is lost", () => {
    for (let i = 1; i <= MAX_RECORDS + 1; i++)
      store.setItem(LEGACY_PREFIX + uuid(i), JSON.stringify(opRecord(A, uuid(i))));
    resetMemoryForTests();
    expect(capacityProblem(A)).toBe("overfull");
    expect(stored()).toHaveLength(MAX_RECORDS + 1);
    expect(stored(LEGACY_PREFIX)).toHaveLength(0);
  });

  it("D. operations and warnings both count; turning an operation into a warning keeps ONE slot; a confirmed acknowledgement frees it", () => {
    for (let i = 1; i <= MAX_RECORDS; i++) start(A, uuid(i));
    expect(capacityProblem(A)).toBe("full");
    at(RETENTION_MS); // every payload expires in place
    checkExpiry();
    expect(stored()).toHaveLength(MAX_RECORDS);
    expect(snapshotFor(A, uuid(1))?.expired).toBe(true);
    expect(capacityProblem(A)).toBe("full"); // still 200: the warnings occupy the slots
    expect(start(A, uuid(999)).kind).toBe("blocked");

    acknowledgeExpired(A, uuid(1));
    expect(stored()).toHaveLength(MAX_RECORDS - 1);
    expect(started(start(A, uuid(999))).conversationId).toBe(uuid(999));
    expect(snapshotFor(A, uuid(2))?.expired).toBe(true); // nobody else's slot was touched
  });

  it("D'. confirming 'stop tracking' on an operation frees its slot", () => {
    const ops = Array.from({ length: MAX_RECORDS }, (_, i) => started(start(A, uuid(i + 1))));
    dismissPending(ops[10]!);
    expect(started(start(A, uuid(777))).conversationId).toBe(uuid(777));
    expect(stored()).toHaveLength(MAX_RECORDS);
  });

  it("E. only a warning past its own 7 days is removed to make room; every unexpired record stays", () => {
    seed(A, uuid(1), tombRecord(A, uuid(1), T0 - TOMBSTONE_MS - 1)); // legitimately over
    for (let i = 2; i <= MAX_RECORDS; i++) seed(A, uuid(i), tombRecord(A, uuid(i), T0 - 1000));
    resetMemoryForTests();
    // at load the over-age warning is already gone; the other 199 stay
    expect(snapshotFor(A, uuid(1))).toBeNull();
    expect(stored()).toHaveLength(MAX_RECORDS - 1);
    expect(started(start(A, uuid(500))).conversationId).toBe(uuid(500));
    expect(capacityProblem(A)).toBe("full");

    // a warning that ages out while the page stays open frees its slot at the next attempt, and only that one
    at(TOMBSTONE_MS); // the 199 warnings created at T0-1000 are now 7 days + 1 s old... except the new op (T0 = now-7d)
    const result = start(A, uuid(501));
    expect(result.kind).toBe("started");
    expect(stored().length).toBeLessThan(MAX_RECORDS + 1);
  });

  it("F. two near-simultaneous starts for the last slot: exactly one succeeds, before any request", async () => {
    for (let i = 1; i <= MAX_RECORDS - 1; i++) seed(A, uuid(i), opRecord(A, uuid(i)));
    resetMemoryForTests();
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => start(A, uuid(901))),
      Promise.resolve().then(() => start(A, uuid(902))),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(["blocked", "started"]);
    expect(stored()).toHaveLength(MAX_RECORDS);
    expect(requests).toBe(0);
  });

  it("G. a failing storage never deletes anything and never turns into unlimited untracked sends", () => {
    for (let i = 1; i <= 3; i++) seed(A, uuid(i), opRecord(A, uuid(i)));
    resetMemoryForTests();
    store.fail = true; // every write throws (quota)
    const view = start(A, uuid(10));
    expect(view.kind === "started" && view.view.persisted).toBe(false); // kept in memory, flagged
    expect(stored()).toHaveLength(3); // the stored records are untouched
    // memory records still count: the limit holds without storage
    for (let i = 11; i <= MAX_RECORDS + 20; i++) start(A, uuid(i));
    expect(capacityProblem(A)).toBe("full");
    expect(start(A, uuid(9999)).kind).toBe("blocked");
    expect(stored()).toHaveLength(3);

    // a warning that cannot be written leaves the old stored record in place (it is not deleted to "fix" it)
    store.fail = false;
    resetMemoryForTests();
    at(RETENTION_MS + 1);
    store.fail = true;
    checkExpiry();
    expect(snapshotFor(A, uuid(1))?.expired).toBe(true);
    expect(store.getItem(KEY_OF(A, uuid(1)))).toContain("text of");
  });

  it("H. other actors' records count under the one total, and nobody can evict another actor's warnings", () => {
    for (let i = 1; i <= 150; i++) seed(B, uuid(i), tombRecord(B, uuid(i), T0 - 1000));
    for (let i = 151; i <= 199; i++) seed(C, uuid(i), tombRecord(C, uuid(i), T0 - 1000));
    resetMemoryForTests();
    expect(capacityProblem(A)).toBeNull(); // 199 of 200
    expect(started(start(A, uuid(300))).conversationId).toBe(uuid(300));
    expect(start(A, uuid(301)).kind).toBe("blocked"); // 200 now, whoever holds them
    expect(start(B, uuid(302)).kind).toBe("blocked");
    expect(stored()).toHaveLength(200);
    expect(snapshotFor(B, uuid(1))?.expired).toBe(true); // B's warning is still B's, untouched
    expect(snapshotFor(A, uuid(1))).toBeNull(); // and invisible to A
  });

  it("an inspection that cannot be completed (too many keys, unreadable storage) fails closed", () => {
    for (let i = 0; i < 1100; i++) store.setItem(`other-${i}`, "x");
    resetMemoryForTests();
    expect(capacityProblem(A)).toBe("unverifiable");
    expect(start(A, uuid(1)).kind).toBe("blocked");
    expect(requests).toBe(0);
  });

  it("a record larger than any valid one is never parsed; it blocks its conversation instead", () => {
    store.setItem(
      KEY_OF(A, uuid(1)),
      JSON.stringify({ ...opRecord(A, uuid(1)), body: "x".repeat(60_000) }),
    );
    resetMemoryForTests();
    expect(snapshotFor(A, uuid(1))).toMatchObject({ expired: true, unreadable: true });
    expect(store.getItem(KEY_OF(A, uuid(1)))!.length).toBeLessThan(500);
  });
});

describe("identity: an actor's record is never shared with, or overwritten by, another actor's", () => {
  const send = async (scope: Scope, conv: string, body: string) => {
    const op = started(start(scope, conv, body));
    await submitPending(op); // the answer is lost (the stub fails): uncertain
    return op;
  };

  it("A → B → A in one tab, same conversation: A's warning survives B's operation and is still A's", async () => {
    const opA = await send(A, CONV, "A's private message");
    expect(snapshotFor(A, CONV)).toMatchObject({ expired: false, uncertain: true });

    // B signs in (same tab, same organization) and opens the SAME conversation
    expect(snapshotFor(B, CONV)).toBeNull(); // sees nothing of A's
    const keyOfA = KEY_OF(A, CONV);
    expect(store.getItem(keyOfA)).not.toContain("A's private message"); // reduced to a text-free warning
    expect(JSON.parse(store.getItem(keyOfA)!)).toMatchObject({ kind: "expired", userId: "user-a" });

    const opB = started(start(B, CONV, "B's message"));
    expect(opB.key).not.toBe(opA.key); // no key is ever reused across actors
    expect(stored()).toHaveLength(2);
    expect(JSON.parse(store.getItem(keyOfA)!)).toMatchObject({ kind: "expired", userId: "user-a" }); // not overwritten
    expect(store.getItem(KEY_OF(B, CONV))).toContain("B's message");

    // A signs back in (a reload, or the same page)
    for (const reload of [false, true]) {
      if (reload) resetMemoryForTests();
      const back = snapshotFor(A, CONV);
      expect(back).toMatchObject({ expired: true });
      expect(JSON.stringify(back)).not.toContain("B's message");
      expect(JSON.stringify(back)).not.toContain(opB.key);
      expect(start(A, CONV, "fresh over the warning")).toEqual({
        kind: "blocked",
        reason: "existing",
      });
    }
    expect(requests).toBe(1); // only A's original attempt: restoration and switching never send
  });

  for (const [name, other] of [
    ["another organization", C],
    ["another membership of the same user", A2],
  ] as const) {
    it(`${name}: separate records for the same conversation`, async () => {
      await send(A, CONV, "A text");
      expect(snapshotFor(other, CONV)).toBeNull();
      started(start(other, CONV, "other text"));
      expect(snapshotFor(other, CONV)?.expired).toBe(false);
      expect(stored()).toHaveLength(2);
      // within one page lifetime the page belongs to one actor; looking at A's records reduces the other's payload, but both
      // records remain and stay distinct
      expect(snapshotFor(A, CONV)?.expired).toBe(true);
      expect(stored().sort()).toEqual([KEY_OF(A, CONV), KEY_OF(other, CONV)].sort());
      expect(snapshotFor(other, CONV)).toMatchObject({ expired: true });
    });
  }

  it("the same actor: one record per conversation, independent across conversations", async () => {
    await send(A, CONV, "first");
    expect(start(A, CONV, "again").kind).toBe("blocked");
    expect(started(start(A, uuid(2), "other conversation")).conversationId).toBe(uuid(2));
    expect(stored()).toHaveLength(2);
  });

  it("acknowledging or dismissing removes only the intended actor's record", async () => {
    const opA = await send(A, CONV, "A text");
    snapshotFor(B, CONV); // B loads the page: A's payload becomes a warning
    const opB = started(start(B, CONV, "B text"));

    acknowledgeExpired(B, CONV); // B has an operation, not a warning: nothing happens
    expect(stored()).toHaveLength(2);

    acknowledgeExpired(A, CONV); // A's warning, A's confirmation
    expect(stored()).toEqual([KEY_OF(B, CONV)]);

    dismissPending(opB); // B's confirmed dismissal
    expect(stored()).toHaveLength(0);
    expect(snapshotFor(A, CONV)).toBeNull();
    expect(opA.key).not.toBe(opB.key);
  });

  it("sign-out clears every record of the tab, as before", async () => {
    await send(A, CONV, "A text");
    snapshotFor(B, CONV);
    started(start(B, uuid(2), "B text"));
    clearPendingSends();
    expect(stored()).toHaveLength(0);
    expect(snapshotFor(A, CONV)).toBeNull();
  });

  it("reconciliation always uses the operation's own actor", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(JSON.parse(decodeURIComponent(init.headers["x-expected-actor"]!)).membershipId);
      throw new TypeError("network");
    });
    const opA = started(start(A, CONV, "A"));
    await submitPending(opA);
    snapshotFor(B, CONV); // another actor loads the page in between
    await submitPending(started(start(B, CONV, "B")));
    expect(seen).toEqual(["mem-a", "mem-b"]);
  });

  it("the journal id is the same everywhere: it encodes the actor, never the text", () => {
    const id = journalId(A, CONV);
    expect(id.split("|")).toHaveLength(4);
    expect(journalId({ ...A, userId: "a|b" }, CONV)).not.toBe(
      journalId({ ...A, userId: "a", organizationId: "b|org-1" }, CONV),
    );
    expect(id).not.toMatch(/text|body/i);
  });
});

describe("migration from the conversation-only key of the previous version", () => {
  const legacyKey = (conv: string) => LEGACY_PREFIX + conv;

  it("a valid own operation moves to its actor-scoped key; the legacy key goes only after; a second load changes nothing", () => {
    store.setItem(legacyKey(CONV), JSON.stringify(opRecord(A, CONV, T0 - 1000, "legacy-key-0001")));
    resetMemoryForTests();
    const view = snapshotFor(A, CONV);
    expect(view).toMatchObject({ expired: false, uncertain: true });
    expect(view && !view.expired && view.op.key).toBe("legacy-key-0001"); // the SAME idempotency key
    expect(stored(LEGACY_PREFIX)).toHaveLength(0);
    expect(stored()).toEqual([KEY_OF(A, CONV)]);

    const snapshot = JSON.stringify([...store.map]);
    resetMemoryForTests();
    snapshotFor(A, CONV);
    expect(JSON.stringify([...store.map])).toBe(snapshot); // idempotent
    expect(requests).toBe(0);
  });

  it("another actor's legacy payload is stored as a text-free warning under its owner's identity", () => {
    store.setItem(legacyKey(CONV), JSON.stringify(opRecord(A, CONV, T0 - 1000)));
    resetMemoryForTests();
    expect(snapshotFor(B, CONV)).toBeNull();
    expect(store.getItem(KEY_OF(A, CONV))).not.toContain("text of");
    expect(JSON.parse(store.getItem(KEY_OF(A, CONV))!)).toMatchObject({
      kind: "expired",
      userId: "user-a",
    });
    expect(stored(LEGACY_PREFIX)).toHaveLength(0);
    resetMemoryForTests();
    expect(snapshotFor(A, CONV)?.expired).toBe(true); // and A finds it
  });

  it("legacy warnings keep their remaining life, expired ones and unreadable ones are dropped", () => {
    store.setItem(legacyKey(uuid(1)), JSON.stringify(tombRecord(A, uuid(1), T0 - 1000)));
    store.setItem(
      legacyKey(uuid(2)),
      JSON.stringify(tombRecord(A, uuid(2), T0 - TOMBSTONE_MS - 1)),
    );
    store.setItem(legacyKey(uuid(3)), "{broken");
    store.setItem(legacyKey(uuid(4)), JSON.stringify(opRecord(A, uuid(5)))); // content names another conversation
    resetMemoryForTests();
    expect(snapshotFor(A, uuid(1))?.expired).toBe(true);
    expect(snapshotFor(A, uuid(2))).toBeNull();
    expect(stored(LEGACY_PREFIX)).toHaveLength(0);
    expect(stored()).toEqual([KEY_OF(A, uuid(1))]);
  });

  it("the same logical record already present (an interrupted earlier migration): the legacy copy is removed, nothing else changes", () => {
    seed(A, CONV, opRecord(A, CONV, T0 - 1000));
    store.setItem(legacyKey(CONV), JSON.stringify(opRecord(A, CONV, T0 - 1000)));
    const before = store.getItem(KEY_OF(A, CONV));
    resetMemoryForTests();
    expect(snapshotFor(A, CONV)?.expired).toBe(false);
    expect(store.getItem(KEY_OF(A, CONV))).toBe(before);
    expect(stored(LEGACY_PREFIX)).toHaveLength(0);
  });

  it("a DIFFERENT record already present: neither is dropped silently or overwritten; the conversation is blocked by one text-free conflict warning", () => {
    seed(A, CONV, opRecord(A, CONV, T0 - 5000, "new-format-key-1"));
    store.setItem(legacyKey(CONV), JSON.stringify(opRecord(A, CONV, T0 - 9000, "legacy-key-0002")));
    resetMemoryForTests();
    const view = snapshotFor(A, CONV);
    expect(view).toMatchObject({ expired: true, conflict: true, createdAt: T0 - 5000 }); // follows the NEWEST submission
    expect(JSON.stringify(view)).not.toContain("key-");
    expect(store.getItem(KEY_OF(A, CONV))).not.toContain("text of");
    expect(stored(LEGACY_PREFIX)).toHaveLength(0);
    expect(start(A, CONV, "fresh").kind).toBe("blocked");
    expect(requests).toBe(0);
  });

  it("if the new copy cannot be written the legacy record stays, the operation still works in memory, and the next load completes the move", () => {
    store.setItem(legacyKey(CONV), JSON.stringify(opRecord(A, CONV, T0 - 1000)));
    store.fail = true;
    resetMemoryForTests();
    expect(snapshotFor(A, CONV)).toMatchObject({ expired: false, persisted: false });
    expect(stored(LEGACY_PREFIX)).toEqual([legacyKey(CONV)]); // not removed
    store.fail = false;
    resetMemoryForTests();
    expect(snapshotFor(A, CONV)).toMatchObject({ expired: false, persisted: true });
    expect(stored(LEGACY_PREFIX)).toHaveLength(0);
    expect(stored()).toEqual([KEY_OF(A, CONV)]);
  });

  it("migration never overwrites a record of another actor for the same conversation", () => {
    seed(B, CONV, opRecord(B, CONV, T0 - 1000, "b-key-0000001"));
    store.setItem(legacyKey(CONV), JSON.stringify(opRecord(A, CONV, T0 - 2000, "a-key-0000001")));
    resetMemoryForTests();
    expect(snapshotFor(B, CONV)).toMatchObject({ expired: false });
    expect(stored()).toHaveLength(2);
    expect(snapshotFor(A, CONV)?.expired).toBe(true); // A's payload, loaded under B, is a warning: still A's, still there
  });
});

describe("logical equivalence: only a proven identical submission is merged", () => {
  const legacyKey = (conv: string) => LEGACY_PREFIX + conv;
  const DAY = 24 * 3600 * 1000;
  const same = {
    key: "same-key-000001",
    body: "same text",
    replyTo: null as string | null,
  };
  /** A legacy record and a v2 record for one identity; returns what the journal makes of them. */
  const collide = (legacy: Record<string, unknown>, current: Record<string, unknown>) => {
    store.setItem(legacyKey(CONV), JSON.stringify({ ...opRecord(A, CONV), ...legacy }));
    seed(A, CONV, { ...opRecord(A, CONV), ...current });
    resetMemoryForTests();
    return snapshotFor(A, CONV);
  };
  const expectConflict = (view: ReturnType<typeof snapshotFor>) => {
    expect(view).toMatchObject({ expired: true, conflict: true });
    expect(JSON.stringify(view)).not.toMatch(/key-|text/);
    expect(stored(LEGACY_PREFIX)).toHaveLength(0);
    expect(start(A, CONV, "fresh over a conflict").kind).toBe("blocked");
    expect(requests).toBe(0);
  };

  it("CASE A. same timestamp, different keys and texts: NOT deduplicated; a conflict warning blocks sending", () => {
    expectConflict(
      collide(
        { createdAt: T0 - 1000, key: "legacy-key-K1", body: "message A" },
        { createdAt: T0 - 1000, key: "current-key-K2", body: "message B" },
      ),
    );
  });

  it("CASE B. same timestamp and key, different payload: a conflict", () => {
    expectConflict(
      collide(
        { ...same, createdAt: T0 - 1000, body: "payload one" },
        { ...same, createdAt: T0 - 1000, body: "payload two" },
      ),
    );
  });

  it("same timestamp and payload, different key (two logical sends): a conflict", () => {
    expectConflict(
      collide(
        { ...same, createdAt: T0 - 1000, key: "key-number-one" },
        { ...same, createdAt: T0 - 1000, key: "key-number-two" },
      ),
    );
  });

  it("different reply targets: a conflict", () => {
    expectConflict(
      collide(
        { ...same, createdAt: T0 - 1000, replyTo: uuid(7) },
        { ...same, createdAt: T0 - 1000, replyTo: uuid(8) },
      ),
    );
    const clean = collide(
      { ...same, createdAt: T0 - 1000, replyTo: null },
      { ...same, createdAt: T0 - 1000, replyTo: uuid(8) },
    );
    expect(clean).toMatchObject({ conflict: true });
  });

  it("CASE F. a truly identical submission (every immutable field equal) is merged, whatever else differs", () => {
    store.setItem(legacyKey(CONV), JSON.stringify({ ...opRecord(A, CONV, T0 - 1000), ...same }));
    seed(A, CONV, { ...opRecord(A, CONV, T0 - 1000), ...same });
    resetMemoryForTests();
    const view = snapshotFor(A, CONV);
    expect(view).toMatchObject({ expired: false });
    expect(view && !view.expired && view.op.key).toBe(same.key);
    expect(stored(LEGACY_PREFIX)).toHaveLength(0);
  });

  it("CASE E. a live operation against a warning cannot be proven equal, even with the same timestamp", () => {
    store.setItem(legacyKey(CONV), JSON.stringify(opRecord(A, CONV, T0 - 1000)));
    seed(A, CONV, tombRecord(A, CONV, T0 - 1000));
    resetMemoryForTests();
    expectConflict(snapshotFor(A, CONV));
  });

  it("two warnings with the same timestamp carry no key to compare: a conflict (conservative)", () => {
    store.setItem(legacyKey(CONV), JSON.stringify(tombRecord(A, CONV, T0 - 1000)));
    seed(A, CONV, tombRecord(A, CONV, T0 - 1000));
    resetMemoryForTests();
    expectConflict(snapshotFor(A, CONV));
  });

  it("sameOperation compares every immutable field, and never a warning", () => {
    const base = parseRecord(opRecord(A, CONV, T0, "ident-key-0001"), T0)!;
    const variant = (over: Record<string, unknown>) =>
      parseRecord({ ...opRecord(A, CONV, T0, "ident-key-0001"), ...over }, T0)!;
    expect(sameOperation(base, variant({}))).toBe(true);
    expect(sameOperation(base, variant({ createdAt: T0 + 1 }))).toBe(true); // time alone is not identity either way
    for (const over of [
      { key: "ident-key-0002" },
      { body: "other" },
      { replyTo: uuid(3) },
      { userId: "user-x" },
      { organizationId: "org-x" },
      { membershipId: "mem-x" },
      { conversationId: uuid(9) },
    ])
      expect(sameOperation(base, variant(over)), JSON.stringify(over)).toBe(false);
    const tomb = parseRecord(tombRecord(A, CONV, T0), T0)!;
    expect(sameOperation(tomb, tomb)).toBe(false);
    expect(sameOperation(base, tomb)).toBe(false);
    expect(sameOperation(null, base)).toBe(false);
  });

  it("CASE C. an old legacy record (> 7 days) against a fresh v2 operation: the fresh operation keeps its full protection", () => {
    store.setItem(
      legacyKey(CONV),
      JSON.stringify(opRecord(A, CONV, T0 - 8 * DAY, "legacy-key-0003")),
    );
    seed(A, CONV, opRecord(A, CONV, T0 - 3600_000, "fresh-v2-key-001"));
    for (let load = 0; load < 3; load++) {
      resetMemoryForTests();
      const view = snapshotFor(A, CONV);
      expect(view, `load ${load}`).toMatchObject({ expired: false }); // still the live operation, not a warning
      expect(view && !view.expired && view.op.key).toBe("fresh-v2-key-001");
      expect(stored(LEGACY_PREFIX)).toHaveLength(0);
      expect(start(A, CONV, "fresh").kind).toBe("blocked");
    }
    expect(requests).toBe(0);
  });

  it("a fresh legacy record against an over-age v2 record: the over-age one ends, the fresh one migrates normally", () => {
    seed(A, CONV, opRecord(A, CONV, T0 - 8 * DAY, "old-v2-key-0001"));
    store.setItem(
      legacyKey(CONV),
      JSON.stringify(opRecord(A, CONV, T0 - 3600_000, "fresh-legacy-01")),
    );
    resetMemoryForTests();
    const view = snapshotFor(A, CONV);
    expect(view && !view.expired && view.op.key).toBe("fresh-legacy-01");
    expect(stored(LEGACY_PREFIX)).toHaveLength(0);
  });

  it("CASE D/I. two valid records with different timestamps: the conflict lives 7 days from the NEWEST, then ends", () => {
    store.setItem(
      legacyKey(CONV),
      JSON.stringify(opRecord(A, CONV, T0 - 2 * DAY, "legacy-key-0004")),
    );
    seed(A, CONV, opRecord(A, CONV, T0 - 3600_000, "fresh-v2-key-002"));
    resetMemoryForTests();
    expect(snapshotFor(A, CONV)).toMatchObject({
      expired: true,
      conflict: true,
      createdAt: T0 - 3600_000,
    });
    const written = JSON.parse(store.getItem(KEY_OF(A, CONV))!);
    expect(written).toMatchObject({ kind: "expired", conflict: true, createdAt: T0 - 3600_000 });
    expect(written.expiredAt).toBeGreaterThanOrEqual(written.createdAt);

    // G. it survives reloads; the OLDER record's own 7 days (ending at T0 + 5 d) do not end it
    at(5 * DAY + 1000);
    for (let load = 0; load < 2; load++) {
      resetMemoryForTests();
      expect(snapshotFor(A, CONV)).toMatchObject({ expired: true, conflict: true });
      expect(start(A, CONV, "fresh").kind).toBe("blocked"); // H
    }
    // I. only the newest record's own 7-day life ends it
    at(7 * DAY - 3600_000 - 1);
    resetMemoryForTests();
    expect(snapshotFor(A, CONV)).toMatchObject({ conflict: true });
    at(7 * DAY - 3600_000);
    resetMemoryForTests();
    expect(snapshotFor(A, CONV)).toBeNull();
    expect(stored()).toHaveLength(0);
  });

  it("CASE J/K/L. acknowledging a conflict removes only that actor's record; another actor's record and repeated loads are unaffected", () => {
    store.setItem(legacyKey(CONV), JSON.stringify(opRecord(A, CONV, T0 - 2000, "legacy-key-0005")));
    seed(A, CONV, opRecord(A, CONV, T0 - 1000, "fresh-v2-key-003"));
    seed(B, CONV, tombRecord(B, CONV, T0 - 1000));
    resetMemoryForTests();
    snapshotFor(A, CONV);
    const afterFirst = JSON.stringify([...store.map].sort());
    resetMemoryForTests();
    snapshotFor(A, CONV);
    expect(JSON.stringify([...store.map].sort())).toBe(afterFirst); // L. migration and restoration are idempotent

    acknowledgeExpired(A, CONV);
    expect(stored()).toEqual([KEY_OF(B, CONV)]); // K. B's record is untouched
    expect(start(A, CONV, "now allowed").kind).toBe("started");
  });

  it("a record's expiry fields must be consistent: a warning cannot end before it began", () => {
    expect(parseRecord({ ...tombRecord(A, CONV, T0), expiredAt: T0 - 1 }, T0)).toBeNull();
    expect(parseRecord({ ...tombRecord(A, CONV, T0), conflict: true }, T0)).toMatchObject({
      conflict: true,
    });
    expect(
      parseRecord({ ...tombRecord(A, CONV, T0), conflict: true, unreadable: true }, T0),
    ).toBeNull();
    expect(parseRecord({ ...tombRecord(A, CONV, T0), conflict: false }, T0)).toBeNull();
  });
});

describe("malformed identifiers in untrusted storage never crash the inbox", () => {
  const LONE_HIGH = "user-\uD800";
  const LONE_LOW = "user-\uDC00";

  it("valid Unicode identifiers round-trip", () => {
    const sinhala: Scope = {
      userId: "ශිෂ්‍ය-😀",
      membershipId: "mem-தமிழ்",
      organizationId: "org-1",
    };
    const op = started(start(sinhala, CONV, "unicode"));
    resetMemoryForTests();
    expect(snapshotFor(sinhala, CONV)).toMatchObject({ expired: false, op: { key: op.key } });
  });

  for (const [name, lone] of [
    ["lone high surrogate", LONE_HIGH],
    ["lone low surrogate", LONE_LOW],
  ] as const) {
    it(`${name} in the embedded identity of a v2 record: no exception, the conversation is blocked, nothing is sent, repeated loads are stable`, () => {
      store.setItem(KEY_OF(A, CONV), JSON.stringify({ ...opRecord(A, CONV), userId: lone }));
      for (let load = 0; load < 3; load++) {
        resetMemoryForTests();
        expect(() => snapshotFor(A, CONV)).not.toThrow();
        expect(snapshotFor(A, CONV)).toMatchObject({ expired: true, unreadable: true });
        expect(start(A, CONV, "fresh").kind).toBe("blocked");
      }
      expect(store.getItem(KEY_OF(A, CONV))).not.toContain("text of");
      expect(requests).toBe(0);
    });

    it(`${name} in a legacy record: no exception; an unattributable legacy record is removed`, () => {
      store.setItem(
        LEGACY_PREFIX + CONV,
        JSON.stringify({ ...opRecord(A, CONV), membershipId: lone }),
      );
      resetMemoryForTests();
      expect(() => snapshotFor(A, CONV)).not.toThrow();
      expect(stored(LEGACY_PREFIX)).toHaveLength(0);
      expect(snapshotFor(A, CONV)).toBeNull();
    });
  }

  it("a lone surrogate in the text is refused too (it could never be submitted); a valid key with corrupt data keeps blocking", () => {
    store.setItem(KEY_OF(A, CONV), JSON.stringify({ ...opRecord(A, CONV), body: "bad \uD83D" }));
    resetMemoryForTests();
    expect(snapshotFor(A, CONV)).toMatchObject({ expired: true, unreadable: true });
    expect(parseRecord({ ...opRecord(A, CONV), organizationId: LONE_LOW }, T0)).toBeNull();
    expect(parseRecord({ ...opRecord(A, CONV), userId: "ශිෂ්‍ය" }, T0)).not.toBeNull();
  });

  it("a key whose encoded identity is malformed names nobody: it is dropped without an exception", () => {
    store.setItem(PREFIX + "%ED%A0%80|org|mem|" + CONV, "{}"); // an encoded lone surrogate is invalid UTF-8
    store.setItem(PREFIX + "%E0%A4%A|org|mem|" + CONV, "{}");
    resetMemoryForTests();
    expect(() => capacityProblem(A)).not.toThrow();
    expect(stored()).toHaveLength(0);
  });
});

describe("retrying the removal of an expired payload that could not be replaced", () => {
  const DAY = 24 * 3600 * 1000;
  it("memory is the warning at once (nothing can be sent); the stored payload is replaced as soon as storage works again; no loop", async () => {
    const op = started(start(A, CONV, "payload that must not outlive its retention"));
    expect(store.getItem(KEY_OF(A, CONV))).toContain("payload that must not");

    at(DAY + 1000);
    store.fail = true; // the write of the warning will fail
    store.writeAttempts = 0;
    checkExpiry();
    expect(snapshotFor(A, CONV)).toMatchObject({ expired: true, persisted: false });
    expect(store.writeAttempts).toBe(1); // one attempt for the conversion; the retry is for the NEXT check, not a loop
    expect(store.getItem(KEY_OF(A, CONV))).toContain("payload that must not"); // still there, honestly
    expect((await submitPending(op)).kind).toBe("uncertain"); // the stale operation cannot be resent
    expect(requests).toBe(0);
    expect(start(A, CONV, "fresh").kind).toBe("blocked");

    checkExpiry();
    checkExpiry(); // still failing: one more attempt per check, nothing deleted, nothing thrown
    expect(store.getItem(KEY_OF(A, CONV))).toContain("payload that must not");

    store.fail = false; // storage works again
    checkExpiry();
    expect(snapshotFor(A, CONV)).toMatchObject({ expired: true, persisted: true });
    expect(store.getItem(KEY_OF(A, CONV))).not.toContain("payload");
    expect(JSON.parse(store.getItem(KEY_OF(A, CONV))!)).toMatchObject({
      kind: "expired",
      userId: "user-a",
    });
    expect(requests).toBe(0);
  });

  it("the same across a reload: the leftover payload is replaced by the warning when the page loads", () => {
    started(start(A, CONV, "payload left behind"));
    at(DAY + 1000);
    store.fail = true;
    checkExpiry();
    store.fail = false;
    resetMemoryForTests();
    expect(snapshotFor(A, CONV)).toMatchObject({ expired: true, persisted: true });
    expect(store.getItem(KEY_OF(A, CONV))).not.toContain("payload left behind");
  });

  it("a conflict or unreadable warning that could not be stored is retried too, with its marker", () => {
    store.setItem(
      LEGACY_PREFIX + CONV,
      JSON.stringify(opRecord(A, CONV, T0 - 2000, "legacy-key-0009")),
    );
    seed(A, CONV, opRecord(A, CONV, T0 - 1000, "fresh-v2-key-009"));
    store.fail = true;
    resetMemoryForTests();
    expect(snapshotFor(A, CONV)).toMatchObject({ expired: true, conflict: true, persisted: false });
    store.fail = false;
    checkExpiry();
    expect(JSON.parse(store.getItem(KEY_OF(A, CONV))!)).toMatchObject({
      kind: "expired",
      conflict: true,
    });
  });
});
