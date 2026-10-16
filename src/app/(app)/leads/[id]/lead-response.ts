import type { LeadDetail, LeadEventPage, LeadPage } from "@/modules/leads";
import { isLeadStatus } from "../lead-labels";

// What a lead read or a page of history must be before the lead page holds it (Phase 07D-4). The shared client checks only that
// a 2xx body is JSON, so a 200 can still carry `{ "events": [null] }` or a contact without a label; held as-is, such an answer
// throws later, while it is appended or rendered, and the page stays busy or is replaced by the error screen. These checks run
// BEFORE anything is applied: a body that fails them is a failed read (retryable) and nothing of it is kept.
//
// The reference is the server's contract (src/modules/leads/types.ts). Checked: every field this page or its helpers read, with
// the type and nullability the contract gives it. Not checked: fields nothing here reads (createdKey, receivedKey, atKey, the
// counts inside a SourceSummary, lead.source): the page never touches them, so they cannot break it. Text stays unparsed text;
// cursors stay opaque.

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** leads.revision is a Postgres `integer` with CHECK (revision >= 0); the status-change schema accepts the same range. */
export const MAX_REVISION = 2_147_483_647;
export const isRevision = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_REVISION;

const isString = (v: unknown): v is string => typeof v === "string";

/**
 * The backend's lead, contact and conversation id contract: `z.uuid()` (src/modules/leads/schemas.ts) as zod 4.6.5 implements it
 * (node_modules/zod/v4/core/regexes.js `uuid()`): versions 1-8 with the RFC variant in either letter case, the nil UUID, and the max
 * UUID in LOWER case only. Mirrored here, not imported, because browser code must not load the backend; a unit test compares it with
 * the real schema. An id that will become part of a link (`encodeURIComponent` throws on a lone surrogate, and the error screen then
 * replaces the page) or a React key is checked with this BEFORE it is held, never with a "non-empty string" test.
 */
const UUID =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isText = (v: unknown) => v === null || typeof v === "string";
const isCount = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isList = (v: unknown, item: (x: unknown) => boolean) => Array.isArray(v) && v.every(item);
const oneOf =
  (...values: readonly unknown[]) =>
  (v: unknown) =>
    values.includes(v);
const isOrigin = oneOf("MANUAL", "AD_REFERRAL", null);

const isLabel = (l: unknown) =>
  isRecord(l) && isString(l.displayName) && typeof l.named === "boolean" && isText(l.idHint);

const isConversation = (c: unknown) =>
  isRecord(c) &&
  isUuid(c.id) && // becomes the "Open in Inbox" link
  isString(c.status) && // an unknown status is shown as "Unknown" (conversationStatusLabel)
  isString(c.accountLabel) &&
  isString(c.lastMessageAt);

const isTouch = (t: unknown): t is Record<string, unknown> =>
  isRecord(t) &&
  isString(t.id) &&
  isString(t.label) &&
  isString(t.receivedAt) &&
  isText(t.headline) &&
  isText(t.body) &&
  isText(t.sourceId) &&
  isText(t.sourceLink) &&
  isText(t.mediaType) &&
  isText(t.mediaLink) &&
  isText(t.clickIdTail) &&
  typeof t.initiating === "boolean";

const isOtherEvidence = (t: unknown) =>
  isTouch(t) && oneOf("UNLINKED", "OTHER_LEAD")(t.attachment) && isText(t.decision);

const isEvent = (e: unknown) =>
  isRecord(e) &&
  isString(e.id) &&
  isString(e.kind) && // an unknown kind is shown as "Event" / "Recorded change" (lead-labels.ts)
  isString(e.at) &&
  isText(e.actorName) &&
  isOrigin(e.origin) &&
  (e.from === null || isLeadStatus(e.from)) &&
  (e.to === null || isLeadStatus(e.to)) &&
  (e.revision === null || isRevision(e.revision)) &&
  (e.touch === null || (isRecord(e.touch) && isString(e.touch.id) && isString(e.touch.label)));

/** A page of history: every event usable, and a cursor that is either the end (null) or an opaque, non-empty string. */
export const isEventPage = (p: unknown): p is LeadEventPage =>
  isRecord(p) &&
  isList(p.events, isEvent) &&
  (p.nextCursor === null || (isString(p.nextCursor) && p.nextCursor !== ""));

/** A lead read, for the lead it claims to be (the caller compares the id with the page's lead). */
export function isLeadDetail(d: unknown): d is LeadDetail {
  if (!isRecord(d)) return false;
  const { lead, contact, attribution: a } = d;
  return (
    isRecord(lead) &&
    isString(lead.id) && // the page's own id from its route; the controller compares it with the id asked for
    isLeadStatus(lead.status) &&
    isRevision(lead.revision) &&
    typeof lead.open === "boolean" &&
    typeof lead.readOnly === "boolean" &&
    isString(lead.createdAt) &&
    isString(lead.statusChangedAt) &&
    isString(lead.cycleStartedAt) &&
    isText(lead.closedAt) &&
    isOrigin(lead.origin) &&
    isRecord(lead.contact) &&
    isUuid(lead.contact.id) &&
    isLabel(lead.contact.label) &&
    isRecord(contact) &&
    isUuid(contact.id) &&
    isLabel(contact.label) &&
    typeof contact.archived === "boolean" &&
    isString(contact.firstSeenAt) &&
    isString(contact.lastSeenAt) &&
    isRecord(contact.identity) &&
    isText(contact.identity.bsuidTail) &&
    isText(contact.identity.lastObservedPhone) &&
    isList(d.conversations, isConversation) &&
    isRecord(a) &&
    isRecord(a.source) &&
    oneOf("META_AD", "OTHER_REFERRAL", "NONE")(a.source.kind) &&
    isList(a.linked, isTouch) &&
    isCount(a.linkedTotal) &&
    (a.first === null || isTouch(a.first)) &&
    (a.latest === null || isTouch(a.latest)) &&
    isList(a.otherForContact, isOtherEvidence) &&
    isCount(a.otherTotal) &&
    isEventPage(d.history) &&
    isRecord(d.can) &&
    typeof d.can.edit === "boolean"
  );
}

/** One row of the leads listing: what the table reads. `id` becomes the row's link and key. */
const isLeadRow = (l: unknown) =>
  isRecord(l) &&
  isUuid(l.id) &&
  isLeadStatus(l.status) &&
  typeof l.open === "boolean" &&
  typeof l.readOnly === "boolean" &&
  isString(l.createdAt) &&
  isString(l.statusChangedAt) &&
  isRecord(l.contact) &&
  isUuid(l.contact.id) &&
  isLabel(l.contact.label) &&
  typeof l.contact.archived === "boolean" &&
  isRecord(l.source) &&
  oneOf("META_AD", "OTHER_REFERRAL", "NONE")(l.source.kind);

/** A page of the leads listing: every row usable, and a cursor that is either the end (null) or an opaque, non-empty string. */
export const isLeadPage = (p: unknown): p is LeadPage =>
  isRecord(p) &&
  isList(p.items, isLeadRow) &&
  (p.nextCursor === null || (isString(p.nextCursor) && p.nextCursor !== ""));
