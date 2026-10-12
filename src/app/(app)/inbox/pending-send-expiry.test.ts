import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PREFIX,
  journalId,
  RETENTION_MS,
  TOMBSTONE_MS,
  acknowledgeExpired,
  checkExpiry,
  clearPendingSends,
  resetMemoryForTests,
  snapshotFor,
  startSend,
  submitPending,
  subscribe,
  type Scope,
} from "./pending-send";

// Expiry of the sensitive payload, the tombstone that replaces it, and the guarantee that expiry never frees the conversation
// for a fresh Send without an explicit acknowledgement. A controllable clock (fake timers) and a fake window/document whose
// event handlers the tests invoke by hand. No request is ever made (the fetch stub fails the test if one is attempted).

const ME: Scope = { userId: "user-1", membershipId: "mem-1", organizationId: "org-1" };
const CONV = "11111111-1111-4111-8111-111111111111";
const KEY_OF = (scope: Scope, conv: string) => PREFIX + journalId(scope, conv);
const KEY = KEY_OF(ME, CONV);
const T0 = Date.UTC(2026, 9, 12, 8, 0, 0);

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
let requests = 0;
const handlers: Record<string, Array<() => void>> = {};
let visibility = "visible";

// the module registers its window/document listeners once per file: one stable stub for the whole file
const windowStub = {
  get sessionStorage() {
    return store;
  },
  addEventListener: (type: string, fn: () => void) => (handlers[type] ??= []).push(fn),
};
const documentStub = {
  get visibilityState() {
    return visibility;
  },
  addEventListener: (type: string, fn: () => void) => (handlers[type] ??= []).push(fn),
};
const fire = (type: string) => handlers[type]?.forEach((fn) => fn());

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  store = new FakeStorage();
  requests = 0;
  visibility = "visible";
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("fetch", async () => {
    requests++;
    throw new TypeError("no request is expected here");
  });
  clearPendingSends();
  resetMemoryForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const begin = (body = "the exact sensitive text", scope = ME) => {
  const r = startSend(scope, CONV, body, null, () => "key-0123456789");
  if (r.kind !== "started") throw new Error("not started");
  const view = r.view;
  expect(view).not.toBeNull();
  return view;
};
const stored = () => store.getItem(KEY) ?? "";
const at = (msFromStart: number) => vi.setSystemTime(T0 + msFromStart);

describe("payload retention", () => {
  it("A. an operation younger than 24 hours is kept, payload and all", () => {
    begin();
    at(RETENTION_MS - 1);
    checkExpiry();
    const v = snapshotFor(ME, CONV)!;
    expect(v.expired).toBe(false);
    expect(stored()).toContain("the exact sensitive text");
  });

  it("B. exactly at the boundary the payload is gone and a warning remains", () => {
    begin();
    at(RETENTION_MS);
    checkExpiry();
    expect(snapshotFor(ME, CONV)).toMatchObject({ expired: true, conversationId: CONV });
  });

  it("C. an expired operation restored after a reload comes back as a warning, never as text and never as an empty composer", () => {
    begin();
    at(RETENTION_MS + 1);
    resetMemoryForTests(); // a reload: memory is gone, storage remains
    const v = snapshotFor(ME, CONV)!;
    expect(v.expired).toBe(true);
    expect(startSend(ME, CONV, "fresh", null).kind).toBe("blocked");
  });

  it("D. an operation that expires while the page stays open is replaced by the warning (the timer re-checks)", () => {
    begin();
    let notified = 0;
    const off = subscribe(() => notified++);
    vi.advanceTimersByTime(RETENTION_MS + 60_000);
    expect(snapshotFor(ME, CONV)!.expired).toBe(true);
    expect(notified).toBeGreaterThan(0); // the panel re-renders: the text is no longer displayed
    off();
  });

  it("E. a suspended tab that resumes after the expiry is checked on focus, visibility and pageshow, without waiting for a timer", () => {
    for (const event of ["focus", "pageshow", "visibilitychange"]) {
      clearPendingSends();
      resetMemoryForTests();
      at(0);
      begin();
      // the machine slept: the clock jumped, no timer ran
      vi.setSystemTime(T0 + RETENTION_MS + 5 * 60_000);
      expect(snapshotFor(ME, CONV)!.expired).toBe(false); // nothing has looked yet
      fire(event);
      expect(snapshotFor(ME, CONV)!.expired).toBe(true);
    }
  });

  it("a hidden tab is not checked by focus-type events but is by the timer and by becoming visible", () => {
    begin();
    at(RETENTION_MS + 1);
    visibility = "hidden";
    fire("visibilitychange");
    expect(snapshotFor(ME, CONV)!.expired).toBe(false);
    visibility = "visible";
    fire("visibilitychange");
    expect(snapshotFor(ME, CONV)!.expired).toBe(true);
  });

  it("F/G. after expiry neither storage nor memory holds the text, the key or the reply target", () => {
    startSend(
      ME,
      CONV,
      "the exact sensitive text",
      "55555555-5555-4555-8555-555555555555",
      () => "key-0123456789",
    );
    at(RETENTION_MS);
    checkExpiry();
    const memory = JSON.stringify(snapshotFor(ME, CONV));
    for (const secret of [
      "sensitive",
      "key-0123456789",
      "55555555",
      '"body"',
      '"key"',
      "replyTo",
    ]) {
      expect(stored(), secret).not.toContain(secret);
      expect(memory, secret).not.toContain(secret);
    }
    expect(JSON.parse(stored())).toEqual({
      v: 1,
      kind: "expired",
      ...ME,
      conversationId: CONV,
      createdAt: T0,
      expiredAt: T0 + RETENTION_MS,
    });
  });

  it("H/I/J. the warning stays, blocks a fresh Send, and only an explicit acknowledgement releases the conversation", () => {
    begin();
    at(RETENTION_MS + 1);
    checkExpiry();
    at(RETENTION_MS * 3); // days later, still there
    resetMemoryForTests();
    expect(snapshotFor(ME, CONV)!.expired).toBe(true);
    expect(startSend(ME, CONV, "fresh", null).kind).toBe("blocked");
    // cancelling the acknowledgement dialog calls nothing: the warning is unchanged
    expect(snapshotFor(ME, CONV)!.expired).toBe(true);
    acknowledgeExpired(ME, CONV);
    expect(snapshotFor(ME, CONV)).toBeNull();
    expect(stored()).toBe("");
    expect(startSend(ME, CONV, "fresh", null).kind).toBe("started");
  });

  it("an operation whose request is running is not expired under it; it is checked again when the request ends", async () => {
    const view = begin();
    let finish!: () => void;
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise((_, reject) => {
          finish = () => reject(new TypeError("network"));
        }),
    );
    const pending = submitPending(view.op);
    at(RETENTION_MS + 1);
    checkExpiry();
    expect(snapshotFor(ME, CONV)!.expired).toBe(false);
    finish();
    await pending;
    expect(snapshotFor(ME, CONV)!.expired).toBe(true); // uncertain outcome, past retention: the warning
  });

  it("a payload past its retention is never sent, even by an explicit re-check", async () => {
    const view = begin();
    at(RETENTION_MS + 1);
    expect((await submitPending(view.op)).kind).toBe("uncertain");
    expect(requests).toBe(0);
    expect(snapshotFor(ME, CONV)!.expired).toBe(true);
  });
});

describe("the warning record", () => {
  it("L. is scoped to its actor: another user never sees it, and does not delete it", () => {
    begin();
    at(RETENTION_MS);
    checkExpiry();
    const other: Scope = { ...ME, userId: "user-2", membershipId: "mem-2" };
    resetMemoryForTests();
    expect(snapshotFor(other, CONV)).toBeNull();
    expect(startSend(other, CONV, "theirs", null).kind).toBe("started"); // their own conversation state is free
  });

  it("the original actor still finds the warning after someone else loaded the page", () => {
    begin();
    at(RETENTION_MS);
    checkExpiry();
    resetMemoryForTests();
    expect(snapshotFor({ ...ME, userId: "user-2", membershipId: "mem-2" }, CONV)).toBeNull();
    expect(JSON.parse(stored())).toMatchObject({ kind: "expired", userId: "user-1" });
    resetMemoryForTests();
    expect(snapshotFor(ME, CONV)!.expired).toBe(true);
  });

  it("is dropped after its own lifetime (7 days from submission) when the page is next loaded, not before", () => {
    begin();
    at(RETENTION_MS);
    checkExpiry();
    at(TOMBSTONE_MS - 1);
    resetMemoryForTests();
    expect(snapshotFor(ME, CONV)!.expired).toBe(true);
    at(TOMBSTONE_MS);
    resetMemoryForTests();
    expect(snapshotFor(ME, CONV)).toBeNull();
    expect(stored()).toBe("");
  });

  it("M. a smuggled or corrupt record under a valid key blocks that conversation (no text); a key that names no one is dropped", () => {
    store.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        kind: "expired",
        ...ME,
        conversationId: CONV,
        createdAt: T0,
        expiredAt: T0,
        body: "smuggled",
      }),
    );
    expect(snapshotFor(ME, CONV)).toMatchObject({ expired: true, unreadable: true });
    expect(stored()).not.toContain("smuggled");
    expect(JSON.parse(stored())).toMatchObject({ kind: "expired", conversationId: CONV });
    expect(startSend(ME, CONV, "fresh", null).kind).toBe("blocked"); // not "safe": the earlier submission is unknown

    store.setItem(KEY, "{broken");
    resetMemoryForTests();
    expect(snapshotFor(ME, CONV)).toMatchObject({ expired: true, unreadable: true });
    expect(JSON.parse(stored())).toMatchObject({ kind: "expired" });

    store.setItem(PREFIX + "garbage", "x");
    resetMemoryForTests();
    snapshotFor(ME, CONV);
    expect(store.getItem(PREFIX + "garbage")).toBeNull();
  });

  it("N. without usable storage the warning exists in memory only and says so; nothing throws", () => {
    store.fail = true;
    const view = begin();
    expect(view.persisted).toBe(false);
    at(RETENTION_MS);
    checkExpiry();
    const v = snapshotFor(ME, CONV)!;
    expect(v).toMatchObject({ expired: true, persisted: false });
    expect(startSend(ME, CONV, "fresh", null).kind).toBe("blocked"); // still blocked inside this page
    vi.stubGlobal("window", {
      ...windowStub,
      get sessionStorage(): never {
        throw new DOMException("denied", "SecurityError");
      },
    });
    resetMemoryForTests();
    expect(snapshotFor(ME, CONV)).toBeNull(); // after a reload nothing can be recovered; the documentation says so
  });

  it("explicit sign-out removes warnings too", () => {
    begin();
    at(RETENTION_MS);
    checkExpiry();
    clearPendingSends();
    expect(store.map.size).toBe(0);
    expect(snapshotFor(ME, CONV)).toBeNull();
  });

  it("O. nothing is ever requested by expiry, restoration, the timers or the acknowledgement", () => {
    begin();
    vi.advanceTimersByTime(RETENTION_MS + 120_000);
    resetMemoryForTests();
    snapshotFor(ME, CONV);
    fire("focus");
    acknowledgeExpired(ME, CONV);
    expect(requests).toBe(0);
  });
});
