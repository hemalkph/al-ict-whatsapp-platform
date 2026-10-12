// The browser's record of ONE outbound submission that has not been resolved yet.
//
// Why it exists: a reply is queued by POST /api/conversations/{id}/messages with an idempotency key. If the browser cannot tell
// whether the server committed the request (network failure, timeout, 5xx, or a "success" whose body cannot be read), the only
// safe way forward is to repeat THE SAME request: same key, same text, same conversation. The server's idempotency (Phase 05)
// then returns the existing request instead of creating a second one. So the operation is frozen into an immutable snapshot
// when Send is pressed, and the editable draft is never consulted again.
//
// Where it lives: in memory (survives navigation inside the app; the request keeps running if the composer unmounts) and in
// sessionStorage (survives a reload of the SAME tab; gone when the tab closes). It is a convenience for continuity, never an
// authority: the server decides. Every request carries the frozen actor (user + membership + organization) as X-Expected-Actor,
// and the server refuses it with 409 ACTOR_CHANGED when the authenticated session is someone else, so an old tab can never
// replay the key under a different member. That check is the guarantee; the scoping below only avoids showing the wrong person's
// content.
//
// Two retention periods:
//  - The PAYLOAD (exact text) is kept for 24 hours (RETENTION_MS), counted from when Send was pressed. At that point it is
//    removed - also in a page that stays open (a timer and every focus/visibility/pageshow event re-check, so a suspended tab
//    is checked the moment it resumes) - and replaced by a TOMBSTONE: scope, conversation and timestamps only, no text.
//  - The TOMBSTONE is kept for 7 days from the same moment (TOMBSTONE_MS), then dropped when the page is next loaded.
// Expiry is NOT proof the server request is absent. While a tombstone exists the conversation cannot be sent to until the person
// explicitly acknowledges that the earlier submission may still exist. Records of a different actor are never shown; when a
// different actor loads the page, their payloads are reduced to tombstones too. Explicit sign-out removes everything.
//
// Identity. A record is identified by (user, organization, membership, conversation) - journalId() - and by nothing less: two
// actors never share a record for the same conversation, so one can never overwrite the other's warning. The same identity is
// the storage key, the in-memory key, and what every read, update and delete uses.
//
// Capacity. At most MAX_RECORDS records (operations and unexpired warnings, of ALL actors in this tab) are supported. The limit
// is checked, and a slot reserved, synchronously BEFORE a new operation is created and therefore before its request is made;
// when the journal is full a new operation is refused, nothing is evicted to make room, and re-checking an existing operation
// needs no slot. A journal that is already over the limit (written by an older version) is kept whole and simply refuses new
// operations. Only legitimate retention (24 h payload -> warning, 7 d warning) or the person's confirmed action frees a slot.

import { ApiError, api } from "./api";
import { refusalReason } from "./labels";

export type Scope = { userId: string; membershipId: string; organizationId: string };

export type PendingOp = {
  readonly v: 1;
  readonly userId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly conversationId: string;
  readonly key: string;
  readonly body: string;
  readonly replyTo: string | null;
  readonly createdAt: number;
};

/** What remains of an operation after its payload expired: no text, no recipient, no key. */
export type Tombstone = {
  readonly v: 1;
  readonly kind: "expired";
  readonly userId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly conversationId: string;
  readonly createdAt: number;
  readonly expiredAt: number;
  /** Conflicting local records were merged into this warning (see migrateLegacy). At most one of the two flags is set. */
  readonly conflict?: true;
  /** The stored record could not be read. */
  readonly unreadable?: true;
};

/** The warning shown instead of a pending operation whose payload expired. */
export type ExpiredView = {
  readonly expired: true;
  /** The stored record could not be read, so the earlier submission is unknown (it is treated like an expired one). */
  readonly unreadable?: boolean;
  /** Conflicting recovery records were found for one submission; it cannot be reconciled from this browser record. */
  readonly conflict?: boolean;
  readonly conversationId: string;
  readonly createdAt: number;
  readonly expiredAt: number;
  readonly persisted: boolean;
};
export type PendingView = OpView | ExpiredView;

/** What the composer renders: the frozen operation plus what this page knows about it right now. */
export type OpView = {
  readonly expired: false;
  readonly op: PendingOp;
  /** A request for it is running in this page right now. After a reload this is false: nothing is running, its result is unknown. */
  readonly inFlight: boolean;
  /**
   * An earlier attempt ended without a trustworthy answer (or the page was reloaded): the server may already hold this request.
   * While true, a refusal says nothing about the earlier attempt unless it proves no request exists (see provesNotQueued).
   */
  readonly uncertain: boolean;
  /** The snapshot could be written to sessionStorage (false: private mode, quota, blocked). */
  readonly persisted: boolean;
};

export type SubmitAccepted = {
  requestId: string;
  messageId: string;
  state: (typeof REQUEST_STATES)[number];
  replayed: boolean;
};
export type SendOutcome =
  | ({ kind: "accepted" } & SubmitAccepted)
  | { kind: "uncertain" }
  /** Refused, but the refusal does not prove the EARLIER attempt was not queued: the operation stays unresolved. */
  | { kind: "inconclusive"; error: ApiError }
  /** The signed-in account is not the one this operation belongs to: nothing was submitted, the operation is untouched. */
  | { kind: "actor_changed" }
  | { kind: "refused"; error: ApiError };

/** Storage keys: PREFIX + journalId(). The previous version used LEGACY_PREFIX + conversationId (migrated on load). */
export const PREFIX = "al-ict.pending-send.v2:";
export const LEGACY_PREFIX = "al-ict.pending-send.v1:";
/**
 * Longest stored value that is parsed at all, as a JavaScript string LENGTH (UTF-16 code units), not a byte count. A 4096-character
 * text with the worst-case JSON escaping is far below it.
 */
export const MAX_VALUE_LENGTH = 32_768;
/** How many storage keys of this origin are inspected; more than this and the journal cannot be verified (new sends blocked). */
export const MAX_SCANNED_KEYS = 1000;
export const RETENTION_MS = 24 * 60 * 60 * 1000;
export const TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;
/** Capacity of the journal (all actors in this tab). A limit on NEW operations, never a reason to delete a record. */
export const MAX_RECORDS = 200;
const EXPIRY_CHECK_MS = 60_000;
export const BODY_MAX = 4096;
export const REQUEST_STATES = [
  "QUEUED",
  "SENDING",
  "ACCEPTED",
  "REJECTED",
  "HELD",
  "UNKNOWN_OUTCOME",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const isString = (v: unknown): v is string => typeof v === "string";
/** True when the string can be percent-encoded, i.e. it has no unpaired UTF-16 surrogate. */
const wellFormed = (v: string) => {
  try {
    encodeURIComponent(v);
    return true;
  } catch {
    return false;
  }
};

export const sameScope = (a: Scope, b: Scope) =>
  a.userId === b.userId &&
  a.membershipId === b.membershipId &&
  a.organizationId === b.organizationId;

type StoredRecord = PendingOp | Tombstone;
export const isTombstone = (r: StoredRecord): r is Tombstone => "kind" in r;
/** At or after the boundary the payload is gone: an operation is valid only while it is younger than the retention period. */
export const payloadExpired = (createdAt: number, now: number) => now - createdAt >= RETENTION_MS;
const tombstoneExpired = (createdAt: number, now: number) => now - createdAt >= TOMBSTONE_MS;

/** Strict reader for one stored record, whoever it belongs to. Anything unexpected (corrupt, tampered, oversized) is null. */
export function parseRecord(raw: unknown, now: number): StoredRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;
  // Identifiers become part of a storage key (percent-encoded), so a string that cannot be encoded (an unpaired surrogate) is
  // refused here: building an identity from untrusted storage must never throw.
  const id = (v: unknown): v is string =>
    isString(v) && v.length > 0 && v.length <= 128 && wellFormed(v);
  if (!id(o.userId) || !id(o.membershipId) || !id(o.organizationId)) return null;
  if (!isString(o.conversationId) || !UUID.test(o.conversationId)) return null;
  if (typeof o.createdAt !== "number" || !Number.isFinite(o.createdAt)) return null;
  if (o.createdAt - now > 5 * 60 * 1000) return null;
  const base = {
    v: 1 as const,
    userId: o.userId,
    membershipId: o.membershipId,
    organizationId: o.organizationId,
    conversationId: o.conversationId,
    createdAt: o.createdAt,
  };
  if (o.kind !== undefined) {
    if (o.kind !== "expired") return null;
    if (typeof o.expiredAt !== "number" || !Number.isFinite(o.expiredAt)) return null;
    if (o.expiredAt < o.createdAt) return null; // the warning cannot end before the submission began
    // exactly the tombstone fields plus at most one marker: nothing else (no text) is accepted
    const flags = (["conflict", "unreadable"] as const).filter((f) => o[f] !== undefined);
    if (flags.length > 1 || flags.some((f) => o[f] !== true)) return null;
    if (Object.keys(o).length !== 8 + flags.length) return null;
    return {
      ...base,
      kind: "expired",
      expiredAt: o.expiredAt,
      ...(flags[0] === "conflict" ? { conflict: true as const } : {}),
      ...(flags[0] === "unreadable" ? { unreadable: true as const } : {}),
    };
  }
  if (!isString(o.key) || !KEY.test(o.key)) return null;
  if (!isString(o.body) || o.body.length === 0 || o.body.length > BODY_MAX || !wellFormed(o.body))
    return null;
  if (o.replyTo !== null && !(isString(o.replyTo) && UUID.test(o.replyTo))) return null;
  return { ...base, key: o.key, body: o.body, replyTo: (o.replyTo as string | null) ?? null };
}

const toTombstone = (op: PendingOp, now: number): Tombstone => ({
  v: 1,
  kind: "expired",
  userId: op.userId,
  membershipId: op.membershipId,
  organizationId: op.organizationId,
  conversationId: op.conversationId,
  createdAt: op.createdAt,
  expiredAt: now,
});
const expiredView = (t: Tombstone, persisted: boolean): ExpiredView => ({
  expired: true,
  conversationId: t.conversationId,
  createdAt: t.createdAt,
  expiredAt: t.expiredAt,
  persisted,
  ...(t.conflict ? { conflict: true } : {}),
  ...(t.unreadable ? { unreadable: true } : {}),
});

/**
 * A refusal that proves no request exists under this key: the server only returns it AFTER looking the key up (the Phase 05
 * submission policy: window, recipient, reply target). Refusals issued before that lookup (outbound switched off, access, a
 * missing conversation, validation) say nothing about an earlier attempt that may have been committed.
 */
export function provesNotQueued(error: ApiError): boolean {
  return error.code === "OUTBOUND_REFUSED" && refusalReason(error.detail) !== "outbound_disabled";
}

/** Validates a "success" answer against the Phase 05 contract { requestId, messageId, state, replayed }. Anything else is unknown. */
export function parseSubmitResponse(raw: unknown): SubmitAccepted | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isString(o.requestId) || !UUID.test(o.requestId)) return null;
  if (!isString(o.messageId) || !UUID.test(o.messageId)) return null;
  if (typeof o.replayed !== "boolean") return null;
  const state = REQUEST_STATES.find((s) => s === o.state);
  if (!state) return null;
  // A first-time submission is always QUEUED; any other state is only possible for an existing request.
  if (!o.replayed && state !== "QUEUED") return null;
  return { requestId: o.requestId, messageId: o.messageId, state, replayed: o.replayed };
}

// ------------------------------------------------------------------------------------------------------------------ identity

/** The one canonical identity of a record: actor (user, organization, membership) + conversation. Parts cannot contain "|". */
export function journalId(scope: Scope, conversationId: string): string {
  return [scope.userId, scope.organizationId, scope.membershipId, conversationId]
    .map(encodeURIComponent)
    .join("|");
}
const storageKey = (id: string) => PREFIX + id;

function decodeJournalId(id: string): (Scope & { conversationId: string }) | null {
  const parts = id.split("|");
  if (parts.length !== 4) return null;
  try {
    const [userId, organizationId, membershipId, conversationId] = parts.map(
      decodeURIComponent,
    ) as [string, string, string, string];
    if (!UUID.test(conversationId)) return null;
    if ([userId, organizationId, membershipId].some((p) => p.length === 0 || p.length > 128))
      return null;
    const decoded = { userId, organizationId, membershipId, conversationId };
    return journalId(decoded, conversationId) === id ? decoded : null; // canonical form only
  } catch {
    return null;
  }
}
const idOf = (r: {
  userId: string;
  organizationId: string;
  membershipId: string;
  conversationId: string;
}) => journalId(r, r.conversationId);

// ------------------------------------------------------------------------------------------------------------------ store

type Entry = { readonly scope: Scope; readonly conversationId: string; view: PendingView };
/** Every record of this tab, every actor: own ones are shown, other actors' ones are text-free warnings that only count. */
const records = new Map<string, Entry>();
const listeners = new Set<() => void>();
let loaded = false;
let activeScope: Scope | null = null;
/** More keys exist than can be inspected: the journal cannot be verified, so new operations are refused. */
let incomplete = false;

const emit = () => listeners.forEach((l) => l());
export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null; // blocked: SecurityError
  }
}

/** Writes a record. A failed write leaves whatever was stored before untouched (nothing is ever removed to make room). */
function persist(id: string, record: StoredRecord): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(storageKey(id), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

function removeKey(key: string) {
  try {
    storage()?.removeItem(key);
  } catch {
    // nothing more can be done
  }
}
const forget = (id: string) => removeKey(storageKey(id));

function readValue(key: string): string | null {
  try {
    const v = storage()?.getItem(key) ?? null;
    return v !== null && v.length <= MAX_VALUE_LENGTH ? v : null; // an oversized value is never parsed
  } catch {
    return null;
  }
}
function readRecord(key: string, now: number): StoredRecord | null {
  const raw = readValue(key);
  if (raw === null) return null;
  try {
    return parseRecord(JSON.parse(raw), now);
  } catch {
    return null;
  }
}

function storedKeys(): { keys: string[]; complete: boolean } {
  const s = storage();
  if (!s) return { keys: [], complete: true };
  const keys: string[] = [];
  let complete = true;
  try {
    const total = s.length;
    if (total > MAX_SCANNED_KEYS) complete = false;
    for (let i = 0; i < Math.min(total, MAX_SCANNED_KEYS); i++) {
      const k = s.key(i);
      if (k?.startsWith(PREFIX) || k?.startsWith(LEGACY_PREFIX)) keys.push(k);
    }
  } catch {
    complete = false; // unreadable storage cannot be verified
  }
  return { keys, complete };
}

const expiredEntry = (scope: Scope, t: Tombstone, persisted: boolean): Entry => ({
  scope,
  conversationId: t.conversationId,
  view: expiredView(t, persisted),
});
const unreadableTombstone = (
  ident: Scope & { conversationId: string },
  now: number,
): Tombstone => ({
  v: 1,
  kind: "expired",
  ...ident,
  createdAt: now,
  expiredAt: now,
  unreadable: true,
});

/**
 * Puts one parsed record (or an unreadable one, `record === null`) into the journal under the rules of the current actor.
 * `copy` is set for a record that was read from a legacy key: its actor-scoped copy must be written, not just registered.
 */
function admit(
  id: string,
  ident: Scope & { conversationId: string },
  record: StoredRecord | null,
  scope: Scope,
  now: number,
  copy = false,
) {
  const entryScope: Scope = {
    userId: ident.userId,
    organizationId: ident.organizationId,
    membershipId: ident.membershipId,
  };
  if (record === null) {
    // The key says this actor had a record for this conversation, but its content cannot be read: the earlier submission is
    // unknown, so the conversation is blocked for that actor (it is not "safe"), without text.
    const t = unreadableTombstone(ident, now);
    const persisted = persist(id, t);
    records.set(id, {
      scope: entryScope,
      conversationId: ident.conversationId,
      view: expiredView(t, persisted),
    });
    return;
  }
  if (isTombstone(record)) {
    if (tombstoneExpired(record.createdAt, now)) {
      if (!copy) forget(id); // legitimate end of its 7-day life
    } else records.set(id, expiredEntry(entryScope, record, copy ? persist(id, record) : true));
    return;
  }
  if (tombstoneExpired(record.createdAt, now)) {
    // an operation whose whole 7-day protection has passed: legitimate end of its life (nothing is left to protect)
    if (!copy) forget(id);
    return;
  }
  if (sameScope(entryScope, scope) && !payloadExpired(record.createdAt, now)) {
    records.set(id, {
      scope: entryScope,
      conversationId: record.conversationId,
      view: {
        expired: false,
        op: record,
        inFlight: false,
        uncertain: true,
        persisted: copy ? persist(id, record) : true,
      },
    });
    return;
  }
  // another actor's payload, or one past its retention: reduced to a text-free warning in the SAME slot
  const t = toTombstone(record, now);
  records.set(id, expiredEntry(entryScope, t, persist(id, t)));
}

const createdAtOf = (e: Entry) => (e.view.expired ? e.view.createdAt : e.view.op.createdAt);

/**
 * The records read from the v2 keys during the current load, exactly as stored (before any reduction to a warning). Migration
 * compares a legacy record with THESE, because the journal entry may already be the text-free warning that replaced the original.
 */
let originals: Map<string, StoredRecord | null> | null = null;

/**
 * Two records are the same logical submission only when that can be PROVEN: both are live operations and every immutable field
 * is equal - actor (user, organization, membership), conversation, idempotency key, exact text and reply target. A timestamp,
 * a text or a conversation alone proves nothing (different submissions can share them, and the key decides whether the server
 * treats two sends as one). A warning has lost its key and text, so it can never be proven equal to anything.
 */
export function sameOperation(a: StoredRecord | null, b: StoredRecord | null): boolean {
  if (!a || !b || isTombstone(a) || isTombstone(b)) return false;
  return (
    a.userId === b.userId &&
    a.organizationId === b.organizationId &&
    a.membershipId === b.membershipId &&
    a.conversationId === b.conversationId &&
    a.key === b.key &&
    a.body === b.body &&
    a.replyTo === b.replyTo
  );
}

/**
 * Moves one record written by the previous version (key = conversation id only) to the actor-scoped identity. Never overwrites
 * a record and never removes a legacy key before its replacement is safely stored; running it again changes nothing.
 */
function migrateLegacy(key: string, scope: Scope, now: number) {
  const record = readRecord(key, now);
  if (!record || record.conversationId !== key.slice(LEGACY_PREFIX.length)) {
    removeKey(key); // not attributable to any actor: nothing that could be protected
    return;
  }
  const id = idOf(record);
  const existing = records.get(id);
  if (!existing) {
    admit(id, record, record, scope, now, true);
    const placed = records.get(id);
    // gone: a record whose retention ended. Otherwise the legacy key is removed only once the new copy is stored; if that write
    // failed the legacy key stays and the next load tries again.
    if (!placed || placed.view.persisted) removeKey(key);
    return;
  }
  if (sameOperation(originals?.get(id) ?? null, record)) {
    removeKey(key); // the very same submission (an earlier, interrupted migration): nothing to merge
    return;
  }
  if (tombstoneExpired(record.createdAt, now)) {
    removeKey(key); // the legacy record's own protection has ended; it must not touch a newer record
    return;
  }
  // Two DIFFERENT submissions (or ones that cannot be proven equal) share this identity and both still need protection.
  // Neither may be dropped silently or overwrite the other, and neither is ever sent: both become ONE blocking warning (no
  // text, no key) marked as a conflict. Its life follows the NEWEST submission, so an old record never shortens a new one's.
  const createdAt = Math.max(createdAtOf(existing), record.createdAt);
  const t: Tombstone = {
    v: 1,
    kind: "expired",
    userId: record.userId,
    organizationId: record.organizationId,
    membershipId: record.membershipId,
    conversationId: record.conversationId,
    createdAt,
    expiredAt: Math.max(now, createdAt),
    conflict: true,
  };
  const persisted = persist(id, t);
  records.set(id, expiredEntry(existing.scope, t, persisted));
  if (persisted) removeKey(key);
}

/** First load of the tab: reads storage once; nothing is deleted for lack of room, corrupt records block instead of vanishing. */
function loadFromStorage(scope: Scope) {
  records.clear();
  originals = new Map();
  const { keys, complete } = storedKeys();
  incomplete = !complete;
  const now = Date.now();
  for (const key of keys) {
    if (!key.startsWith(PREFIX)) continue;
    const id = key.slice(PREFIX.length);
    const ident = decodeJournalId(id);
    if (!ident) {
      removeKey(key); // a key that names no actor and conversation: unattributable
      continue;
    }
    let record = readRecord(key, now);
    try {
      if (record !== null && idOf(record) !== id) record = null; // the content names another identity than its key
    } catch {
      record = null;
    }
    originals.set(id, record);
    try {
      admit(id, ident, record, scope, now);
    } catch {
      admit(id, ident, null, scope, now); // anything unexpected blocks the conversation instead of crashing the inbox
    }
  }
  for (const key of keys) {
    if (!key.startsWith(LEGACY_PREFIX)) continue;
    try {
      migrateLegacy(key, scope, now);
    } catch {
      // an unprocessable legacy record is left where it is; it will be tried again and never crashes the page
    }
  }
  originals = null;
}

/** A different actor is now using this page: whatever the previous one still held becomes a text-free warning. */
function reduceOthers(scope: Scope) {
  const now = Date.now();
  for (const [id, entry] of records) {
    const v = entry.view;
    if (v.expired || sameScope(entry.scope, scope)) continue;
    const t = toTombstone(v.op, now);
    records.set(id, expiredEntry(entry.scope, t, persist(id, t)));
  }
}

function ensureLoaded(scope: Scope) {
  if (!loaded) {
    loadFromStorage(scope);
    loaded = true;
    activeScope = { ...scope };
    watchExpiry();
    return;
  }
  if (activeScope && sameScope(activeScope, scope)) return;
  activeScope = { ...scope };
  reduceOthers(scope);
}

/**
 * Re-checks every operation against the clock: past the retention period its payload is removed - from memory and from storage -
 * and a tombstone takes its place IN THE SAME SLOT. Runs on a timer, on focus / visibility / pageshow (a suspended tab resumes
 * through these), and on load. An operation with a request still running is checked again after it ends. Never sends anything.
 */
export function checkExpiry() {
  const now = Date.now();
  let changed = false;
  const converted = new Set<string>(); // already written once in this check: retried at the next one, never in a loop
  for (const [id, entry] of records) {
    const v = entry.view;
    if (v.expired || v.inFlight || !payloadExpired(v.op.createdAt, now)) continue;
    const t = toTombstone(v.op, now);
    records.set(id, expiredEntry(entry.scope, t, persist(id, t)));
    converted.add(id);
    changed = true;
  }
  // A warning whose write failed may have left the original payload in storage. Try again (once per check, never in a loop):
  // the in-memory state is already the warning, so nothing stale can be sent, and a stored record is never removed to do it.
  for (const [id, entry] of records) {
    const v = entry.view;
    if (!v.expired || v.persisted || converted.has(id)) continue;
    const t: Tombstone = {
      v: 1,
      kind: "expired",
      ...entry.scope,
      conversationId: entry.conversationId,
      createdAt: v.createdAt,
      expiredAt: v.expiredAt,
      ...(v.conflict ? { conflict: true as const } : {}),
      ...(v.unreadable ? { unreadable: true as const } : {}),
    };
    if (persist(id, t)) {
      entry.view = { ...v, persisted: true };
      changed = true;
    }
  }
  if (changed) emit();
}

let watching = false;
let expiryTimer: ReturnType<typeof setInterval> | undefined;
function watchExpiry() {
  if (watching || typeof window === "undefined" || typeof window.addEventListener !== "function")
    return;
  watching = true;
  const onResume = () => {
    if (typeof document === "undefined" || document.visibilityState !== "hidden") checkExpiry();
  };
  window.addEventListener("focus", onResume);
  window.addEventListener("pageshow", onResume);
  window.addEventListener("online", onResume);
  if (typeof document !== "undefined" && typeof document.addEventListener === "function")
    document.addEventListener("visibilitychange", onResume);
  // Timers do not advance while the whole machine sleeps; the events above cover the resume. This covers a page left open.
  expiryTimer = setInterval(checkExpiry, EXPIRY_CHECK_MS);
  (expiryTimer as { unref?: () => void }).unref?.();
}

// ---------------------------------------------------------------------------------------------------------------- capacity

const liveEntries = (now: number) =>
  [...records.values()].filter((e) => !(e.view.expired && tombstoneExpired(e.view.createdAt, now)));

/** Why a NEW operation cannot be created right now, or null. Counts every actor's unexpired records; mutates nothing. */
export type CapacityProblem = "full" | "overfull" | "unverifiable";
export function capacityProblem(scope: Scope): CapacityProblem | null {
  ensureLoaded(scope);
  if (incomplete) return "unverifiable";
  const used = liveEntries(Date.now()).length;
  return used > MAX_RECORDS ? "overfull" : used >= MAX_RECORDS ? "full" : null;
}

export function snapshotFor(scope: Scope, conversationId: string): PendingView | null {
  ensureLoaded(scope);
  return records.get(journalId(scope, conversationId))?.view ?? null;
}

/** Sign-out: nothing of this user's may remain on the device. */
export function clearPendingSends() {
  records.clear();
  loaded = false;
  activeScope = null;
  incomplete = false;
  for (const key of storedKeys().keys) removeKey(key);
  emit();
}

export type StartResult =
  | { kind: "started"; view: OpView }
  /** `existing`: this actor already has an unresolved operation or warning for the conversation. `capacity`: see capacityProblem. */
  | { kind: "blocked"; reason: "existing" }
  | { kind: "blocked"; reason: "capacity"; problem: CapacityProblem };

/**
 * Freezes the operation (new key, exact text) BEFORE anything is sent, so a reload mid-request still finds it. The capacity check
 * and the reservation of the slot happen in this one synchronous step, before the request exists, so two near-simultaneous
 * starts cannot both pass a check that only one slot satisfies.
 */
export function startSend(
  scope: Scope,
  conversationId: string,
  body: string,
  replyTo: string | null,
  newKey: () => string = () => crypto.randomUUID(),
): StartResult {
  ensureLoaded(scope);
  checkExpiry(); // payloads past their retention are warnings now, in the same slots
  const id = journalId(scope, conversationId);
  // one unresolved operation (or warning) per actor and conversation; a second Send is refused until it is resolved or the
  // person explicitly confirms
  if (records.has(id)) return { kind: "blocked", reason: "existing" };
  const now = Date.now();
  for (const [other, entry] of records)
    if (entry.view.expired && tombstoneExpired(entry.view.createdAt, now)) {
      records.delete(other); // a warning whose 7 days are over: legitimate retention, the only thing ever removed for room
      forget(other);
    }
  const problem = capacityProblem(scope);
  if (problem) return { kind: "blocked", reason: "capacity", problem };
  const op: PendingOp = {
    v: 1,
    ...scope,
    conversationId,
    key: newKey(),
    body,
    replyTo,
    createdAt: now,
  };
  const view: OpView = {
    expired: false,
    op,
    inFlight: false,
    uncertain: false,
    persisted: persist(id, op),
  };
  records.set(id, { scope: { ...scope }, conversationId, view });
  emit();
  return { kind: "started", view };
}

const isCurrent = (op: PendingOp) => {
  const v = records.get(idOf(op))?.view;
  return v !== undefined && !v.expired && v.op === op;
};
const liveView = (op: PendingOp): OpView | null => {
  const v = records.get(idOf(op))?.view;
  return v && !v.expired && v.op === op ? v : null;
};

/**
 * Sends (or re-sends) the frozen operation with ITS OWN key, text and actor. Used for the first attempt and for the explicit
 * "check again" action; it is never called automatically, and a re-check needs no capacity slot. The result decides the
 * operation's fate:
 *  - a validated success: resolved, the record is removed (the message shows in the timeline with its real state);
 *  - the signed-in account is not the operation's: nothing was submitted, the operation stays exactly as it was;
 *  - a definitive refusal (4xx): resolved as not queued, removed. After an earlier uncertain attempt only a refusal that PROVES no
 *    request exists counts (provesNotQueued); any other refusal leaves the operation unresolved ("inconclusive");
 *  - anything else: UNCERTAIN, the record stays exactly as it was.
 */
export async function submitPending(op: PendingOp): Promise<SendOutcome> {
  const current = liveView(op);
  if (!current || current.inFlight) return { kind: "uncertain" };
  if (payloadExpired(op.createdAt, Date.now())) {
    checkExpiry(); // never send a payload past its retention: it becomes a warning instead
    return { kind: "uncertain" };
  }
  const id = idOf(op);
  const entry = records.get(id)!;
  entry.view = { ...current, inFlight: true };
  emit();
  let outcome: SendOutcome;
  try {
    const json = await api<unknown>(`/api/conversations/${op.conversationId}/messages`, {
      method: "POST",
      okStatuses: [200, 201],
      expectedActor: {
        userId: op.userId,
        organizationId: op.organizationId,
        membershipId: op.membershipId,
      },
      body: {
        idempotencyKey: op.key,
        message: {
          type: "text",
          body: op.body,
          ...(op.replyTo ? { replyToMessageId: op.replyTo } : {}),
        },
      },
    });
    const accepted = parseSubmitResponse(json);
    outcome = accepted ? { kind: "accepted", ...accepted } : { kind: "uncertain" };
  } catch (error) {
    outcome =
      error instanceof ApiError && error.code === "ACTOR_CHANGED"
        ? { kind: "actor_changed" }
        : error instanceof ApiError && !error.uncertain
          ? current.uncertain && !provesNotQueued(error)
            ? { kind: "inconclusive", error }
            : { kind: "refused", error }
          : { kind: "uncertain" };
  }
  if (isCurrent(op)) {
    if (
      outcome.kind === "uncertain" ||
      outcome.kind === "inconclusive" ||
      outcome.kind === "actor_changed"
    ) {
      const latest = records.get(id)!;
      latest.view = { ...(latest.view as OpView), inFlight: false, uncertain: true };
    } else {
      records.delete(id);
      forget(id);
    }
    emit();
    if (outcome.kind !== "accepted" && outcome.kind !== "refused") checkExpiry();
  }
  return outcome;
}

/**
 * The staff member decided to stop tracking an unresolved operation. This does NOT cancel anything on the server; it only
 * discards the key that protects against a duplicate. The interface asks for explicit confirmation before calling it. Only THIS
 * actor's record for THIS conversation is removed.
 */
export function dismissPending(op: PendingOp) {
  const current = liveView(op);
  if (!current || current.inFlight) return;
  records.delete(idOf(op));
  forget(idOf(op));
  emit();
}

/** The staff member acknowledged that an earlier submission may still exist although its details expired (this actor only). */
export function acknowledgeExpired(scope: Scope, conversationId: string) {
  const id = journalId(scope, conversationId);
  const current = records.get(id);
  if (!current || !current.view.expired) return;
  records.delete(id);
  forget(id);
  emit();
}

/** Test seam: forget in-memory state without touching storage (simulates a fresh page load). */
export function resetMemoryForTests() {
  records.clear();
  loaded = false;
  activeScope = null;
  incomplete = false;
  clearInterval(expiryTimer); // the next load starts its own watcher (tests replace the clock)
  watching = false;
}
