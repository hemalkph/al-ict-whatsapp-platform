import { and, count, eq, sql } from "drizzle-orm";
import { schema, type DbExecutor } from "@/db";
import { emitWebhookLog } from "../logging";
import { PermanentWebhookError } from "../queue/errors";
import { effectiveActivityTime } from "../time";
import { readInboundIdentity, type InboundIdentity } from "./profile";

// Contact identity resolution for NORMAL inbound messages. It decides which contact a message belongs to, creating one
// only when nothing established matches, and it NEVER merges two established identities.
//
// Trust: the organization comes only from the trusted queue event (its routing columns, set by ingest from our own
// whatsapp_accounts row). Nothing in the Meta payload can choose a tenant. Every query below carries that organization.
//
// Identity: the BSUID (messages[].from_user_id) is primary, resolved through contact_bsuids by (organization, bsuid),
// current OR retired. The phone-based id (messages[].from) is secondary. Both are opaque strings.
//
// A phone number is NOT proof of identity continuity: numbers are recycled between people. BSUID aliases are the only
// authority, and a duplicate contact is preferable to a wrong merge. So:
//
//   BSUID known (any alias)       -> that alias's contact, always. A retired alias is never reactivated or promoted.
//   BSUID unknown, phone unowned  -> new contact (+ alias, + the phone as wa_id).
//   BSUID unknown, phone owned by ANY existing contact (legacy phone-only, or one that already has an alias) -> a NEW
//                                    BSUID-only contact. The phone stays with its owner, nothing is linked or merged,
//                                    and a conflict is reported (legacy_phone_ownership_unverified for a phone-only
//                                    owner, phone_held_by_bsuid_contact for one that already has a BSUID).
//   no BSUID (legacy-shaped), phone owned by a contact WITHOUT aliases -> that contact (inherently uncertain).
//   no BSUID, phone owned by a contact WITH aliases -> refused (phone_only_identity_ambiguous); nothing is modified.
//   no BSUID, phone unknown       -> a new phone-only contact that is not BSUID-verified.
//
// Aliases are only ever INSERTED; an alias row's contact_id is never updated. wa_id is only filled when empty and free,
// never rewritten. The function runs inside the caller's (the worker's) transaction and opens none of its own.

export type TrustedWebhookEvent = {
  id: string;
  eventType: string;
  organizationId: string;
  whatsappAccountId: string;
  receivedAt: Date;
  payload: unknown;
};

export type IdentityConflict =
  /** The message's phone belongs to a different contact than its BSUID does. Nothing is moved. */
  | "phone_owned_by_other_contact"
  /** The BSUID's contact already has a different phone. The existing wa_id is never rewritten. */
  | "phone_differs_from_contact"
  /** A new BSUID arrived with a phone that belongs to a contact with another BSUID: kept apart, not merged. */
  | "phone_held_by_bsuid_contact"
  /** A new BSUID arrived with a phone that belongs to a legacy phone-only contact. Whether it is the same person is
   *  unverifiable (the number may have been recycled), so the BSUID gets its own contact. Never linked. */
  | "legacy_phone_ownership_unverified"
  /** A phone-only message whose phone belongs to a BSUID-established contact. Not resolvable: refused. */
  | "phone_only_identity_ambiguous";

export type ContactResolution = {
  contactId: string;
  created: boolean;
  conflicts: IdentityConflict[];
};

type Found = { conflict: IdentityConflict; other: string };
const RACE_RETRIES = 3;

/** Lock keys for one message, sorted so every transaction takes them in the same order. */
export function identityLockKeys(organizationId: string, who: InboundIdentity): string[] {
  const keys = new Set<string>();
  if (who.bsuid !== null) keys.add(`wa-identity:${organizationId}:bsuid:${who.bsuid}`);
  if (who.waId !== null) keys.add(`wa-identity:${organizationId}:wa:${who.waId}`);
  return [...keys].sort();
}

export async function resolveInboundContact(
  tx: DbExecutor,
  event: TrustedWebhookEvent,
  options: { observedAt: Date },
): Promise<ContactResolution> {
  // Advisory transaction locks only mean something inside the caller's transaction (a plain connection would release
  // them at the end of each statement), and the lock-then-read protocol needs READ COMMITTED snapshots.
  if (typeof (tx as unknown as { rollback?: unknown }).rollback !== "function")
    throw new Error("resolveInboundContact must run inside the worker's transaction");
  if (event.eventType !== "MESSAGE") throw new PermanentWebhookError("not_a_message_event");
  if (Number.isNaN(options.observedAt.getTime()))
    throw new PermanentWebhookError("invalid_timestamp");

  const who = readInboundIdentity(event.payload);
  const observedAt = effectiveActivityTime(options.observedAt, event.receivedAt);

  const isolation = await tx.execute<{ level: string }>(
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (isolation.rows[0]?.level !== "read committed")
    throw new Error("resolveInboundContact requires a READ COMMITTED transaction");

  for (const key of identityLockKeys(event.organizationId, who))
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

  for (let attempt = 0; attempt < RACE_RETRIES; attempt++) {
    const resolved = await resolveLocked(tx, event, who, observedAt);
    if (resolved) {
      report(event, resolved);
      return {
        contactId: resolved.contactId,
        created: resolved.created,
        conflicts: resolved.conflicts,
      };
    }
  }
  // Only reachable if a row appeared that the locks should have made impossible. Transient: the worker retries.
  throw new Error("contact_identity_race");
}

type Found2 = { id: string; waId: string | null };

async function resolveLocked(
  tx: DbExecutor,
  event: TrustedWebhookEvent,
  who: InboundIdentity,
  observedAt: Date,
): Promise<(ContactResolution & { found: Found[] }) | null> {
  const org = event.organizationId;
  const alias = who.bsuid === null ? null : await findAlias(tx, org, who.bsuid);
  const byPhone = who.waId === null ? null : await findContactByWaId(tx, org, who.waId);
  const found: Found[] = [];
  const done = (
    contactId: string,
    extra: { created?: boolean } = {},
  ): ContactResolution & { found: Found[] } => ({
    contactId,
    created: extra.created ?? false,
    conflicts: found.map((f) => f.conflict),
    found,
  });

  // 1. A known BSUID (current or retired) always resolves to its original contact.
  if (alias) {
    const contact = await loadContact(tx, org, alias.contactId);
    if (who.waId !== null) {
      if (contact.waId !== null && contact.waId !== who.waId)
        found.push({ conflict: "phone_differs_from_contact", other: contact.id });
      if (byPhone && byPhone.id !== contact.id)
        found.push({ conflict: "phone_owned_by_other_contact", other: byPhone.id });
    }
    // The phone is claimed only for a contact that has none, and only if nobody owns it.
    const claim = contact.waId === null && who.waId !== null && byPhone === null ? who.waId : null;
    await touchContact(tx, org, contact.id, who, observedAt, claim);
    if (alias.retiredAt === null) await touchAlias(tx, org, alias.id, observedAt);
    return done(contact.id);
  }

  // 2. An unseen BSUID. A phone that another contact already owns is never taken over and never merged: whether this is
  // the same person is unverifiable (numbers are recycled), so the BSUID gets its own contact WITHOUT the phone.
  if (who.bsuid !== null) {
    if (byPhone) {
      const established = (await aliasCount(tx, org, byPhone.id)) > 0;
      found.push({
        conflict: established ? "phone_held_by_bsuid_contact" : "legacy_phone_ownership_unverified",
        other: byPhone.id,
      });
      const created = await createWithAlias(tx, event, who, observedAt, null);
      return created ? done(created, { created: true }) : null;
    }
    const created = await createWithAlias(tx, event, who, observedAt, who.waId);
    return created ? done(created, { created: true }) : null;
  }

  // 3. No BSUID (a legacy-shaped observation). The phone is only a weak identifier: it may resolve a contact that has
  // no BSUID (inherently uncertain, not BSUID-verified), but never one that is BSUID-established. Nothing is written
  // before the refusal, so the existing contact is left exactly as it was.
  if (byPhone) {
    if ((await aliasCount(tx, org, byPhone.id)) > 0) {
      emitConflict(event, "phone_only_identity_ambiguous", { otherContactId: byPhone.id });
      throw new PermanentWebhookError("phone_only_identity_ambiguous");
    }
    await touchContact(tx, org, byPhone.id, who, observedAt, null);
    return done(byPhone.id);
  }
  const id = await createContact(tx, org, who.waId, who, observedAt);
  return id ? done(id, { created: true }) : null;
}

// ------------------------------------------------------------------------------------------------ reading
async function findAlias(tx: DbExecutor, org: string, bsuid: string) {
  const [row] = await tx
    .select({
      id: schema.contactBsuids.id,
      contactId: schema.contactBsuids.contactId,
      retiredAt: schema.contactBsuids.retiredAt,
    })
    .from(schema.contactBsuids)
    .where(
      and(eq(schema.contactBsuids.organizationId, org), eq(schema.contactBsuids.bsuid, bsuid)),
    );
  return row ?? null;
}

async function findContactByWaId(
  tx: DbExecutor,
  org: string,
  waId: string,
): Promise<Found2 | null> {
  const [row] = await tx
    .select({ id: schema.contacts.id, waId: schema.contacts.waId })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.organizationId, org), eq(schema.contacts.waId, waId)));
  return row ?? null;
}

async function loadContact(tx: DbExecutor, org: string, id: string): Promise<Found2> {
  const [row] = await tx
    .select({ id: schema.contacts.id, waId: schema.contacts.waId })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.organizationId, org), eq(schema.contacts.id, id)));
  if (!row) throw new Error("contact_alias_without_contact"); // the composite FK makes this unreachable
  return row;
}

async function aliasCount(tx: DbExecutor, org: string, contactId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(schema.contactBsuids)
    .where(
      and(
        eq(schema.contactBsuids.organizationId, org),
        eq(schema.contactBsuids.contactId, contactId),
      ),
    );
  return row?.n ?? 0;
}

// ------------------------------------------------------------------------------------------------ writing
/** New contact (no consent, no lead, no conversation: the consent cache defaults to UNKNOWN). null = lost a race. */
async function createContact(
  tx: DbExecutor,
  org: string,
  waId: string | null,
  who: InboundIdentity,
  observedAt: Date,
): Promise<string | null> {
  const [row] = await tx
    .insert(schema.contacts)
    .values({
      organizationId: org,
      waId,
      profileName: who.profileName,
      username: who.username,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
    })
    .onConflictDoNothing({ target: [schema.contacts.organizationId, schema.contacts.waId] })
    .returning({ id: schema.contacts.id });
  return row?.id ?? null;
}

/** A new alias. It is only ever inserted: an existing alias is never updated or re-pointed. */
async function insertAlias(
  tx: DbExecutor,
  org: string,
  contactId: string,
  bsuid: string,
  observedAt: Date,
  eventId: string,
): Promise<boolean> {
  const rows = await tx
    .insert(schema.contactBsuids)
    .values({
      organizationId: org,
      contactId,
      bsuid,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      sourceWebhookEventId: eventId,
    })
    .onConflictDoNothing({
      target: [schema.contactBsuids.organizationId, schema.contactBsuids.bsuid],
    })
    .returning({ id: schema.contactBsuids.id });
  return rows.length === 1;
}

/** A contact and its first alias together. If the alias lost a race, the contact made here is removed again. */
async function createWithAlias(
  tx: DbExecutor,
  event: TrustedWebhookEvent,
  who: InboundIdentity,
  observedAt: Date,
  waId: string | null,
): Promise<string | null> {
  const org = event.organizationId;
  const id = await createContact(tx, org, waId, who, observedAt);
  if (!id) return null;
  if (await insertAlias(tx, org, id, who.bsuid!, observedAt, event.id)) return id;
  await tx
    .delete(schema.contacts)
    .where(and(eq(schema.contacts.organizationId, org), eq(schema.contacts.id, id)));
  return null;
}

/**
 * Seen-window and profile for an existing contact. first/last seen only widen. Display text is replaced only by an event
 * at least as new as the newest one already seen, and never by nothing. wa_id is filled only when empty and unowned.
 */
async function touchContact(
  tx: DbExecutor,
  org: string,
  contactId: string,
  who: InboundIdentity,
  observedAt: Date,
  claimWaId: string | null,
): Promise<void> {
  const at = sql`${observedAt.toISOString()}::timestamptz`;
  const newer = sql`${at} >= ${schema.contacts.lastSeenAt}`;
  await tx
    .update(schema.contacts)
    .set({
      firstSeenAt: sql`LEAST(${schema.contacts.firstSeenAt}, ${at})`,
      lastSeenAt: sql`GREATEST(${schema.contacts.lastSeenAt}, ${at})`,
      profileName: sql`CASE WHEN ${newer} AND ${who.profileName}::text IS NOT NULL THEN ${who.profileName}::text ELSE ${schema.contacts.profileName} END`,
      username: sql`CASE WHEN ${newer} AND ${who.username}::text IS NOT NULL THEN ${who.username}::text ELSE ${schema.contacts.username} END`,
      waId: sql`CASE WHEN ${claimWaId}::text IS NOT NULL AND ${schema.contacts.waId} IS NULL
                      AND NOT EXISTS (SELECT 1 FROM contacts o WHERE o.organization_id = ${org} AND o.wa_id = ${claimWaId}::text)
                THEN ${claimWaId}::text ELSE ${schema.contacts.waId} END`,
    })
    .where(and(eq(schema.contacts.organizationId, org), eq(schema.contacts.id, contactId)));
}

/** Widens the seen-window of a CURRENT alias. contact_id and retired_at are never touched. */
async function touchAlias(
  tx: DbExecutor,
  org: string,
  aliasId: string,
  observedAt: Date,
): Promise<void> {
  const at = sql`${observedAt.toISOString()}::timestamptz`;
  await tx
    .update(schema.contactBsuids)
    .set({
      firstSeenAt: sql`LEAST(${schema.contactBsuids.firstSeenAt}, ${at})`,
      lastSeenAt: sql`GREATEST(${schema.contactBsuids.lastSeenAt}, ${at})`,
    })
    .where(
      and(
        eq(schema.contactBsuids.organizationId, org),
        eq(schema.contactBsuids.id, aliasId),
        sql`${schema.contactBsuids.retiredAt} IS NULL`,
      ),
    );
}

// ------------------------------------------------------------------------------------------------ reporting
function emitConflict(
  event: TrustedWebhookEvent,
  reason: IdentityConflict,
  ids: { contactId?: string; otherContactId: string },
): void {
  emitWebhookLog({
    event: "webhook.contact_identity_conflict",
    outcome: "denied",
    webhookEventId: event.id,
    organizationId: event.organizationId,
    whatsappAccountId: event.whatsappAccountId,
    contactId: ids.contactId,
    otherContactId: ids.otherContactId,
    reason,
  });
}

/** Internal ids and fixed reason codes only: never a phone number, BSUID, name or message text. */
function report(event: TrustedWebhookEvent, r: ContactResolution & { found: Found[] }): void {
  for (const f of r.found)
    emitConflict(event, f.conflict, { contactId: r.contactId, otherContactId: f.other });
}
