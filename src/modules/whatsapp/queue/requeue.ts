import { and, count, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { schema, type DbExecutor } from "@/db";
import { payloadPhoneNumberId, payloadWabaId, phoneNumberIdOf, wabaIdOf } from "../envelope";
import { REQUEUE_MAX_AGE_MS } from "./policy";

// Release of held events. TENANT PROVENANCE IS STRONGER THAN CURRENT PHONE-NUMBER OWNERSHIP: an event never changes
// organization or account, and a phone_number_id that is configured under some organization today is not, by itself,
// a reason to hand it an old payload. Two distinct operations make that obvious:
//
//   requeueRoutedHeldEvents   events that ingest ALREADY routed (organization_id + whatsapp_account_id set). They are
//                             released only against that exact account; nothing is ever re-homed.
//   requeueUnroutedEvent      ONE event with no proven owner (unknown_account / waba_mismatch). An operator names the
//                             target account; the target is independently verified; only then does the event acquire
//                             routing. An explicit ownership decision, never an automatic one.
//
// Organization is never caller input: it comes from the target account row (and, for routed events, must equal the
// event's own organization).

/** Routed holds that activation of THAT account releases automatically (within the age window). */
export const AUTO_REQUEUE_REASONS = ["account_pending"] as const;
/** Routed events released only by an explicit operator action, and only against their own account. */
export const OPERATOR_ROUTED_REASONS = ["account_disabled", "account_archived"] as const;
/** Unrouted events: only requeueUnroutedEvent, with an explicit target account. */
export const UNROUTED_REASONS = ["unknown_account", "waba_mismatch"] as const;

export type RoutedRequeueReason =
  (typeof AUTO_REQUEUE_REASONS)[number] | (typeof OPERATOR_ROUTED_REASONS)[number];
export type UnroutedRequeueReason = (typeof UNROUTED_REASONS)[number];

const ROUTED = new Set<string>([...AUTO_REQUEUE_REASONS, ...OPERATOR_ROUTED_REASONS]);

const released = {
  status: "PENDING",
  attempts: 0,
  nextAttemptAt: sql`now()`,
  lockedAt: null,
  lockedBy: null,
  lastError: null,
} as const;

export type RoutedRequeueResult = {
  requeued: number;
  /** Why nothing was released when the account itself is not eligible. */
  skipped: "account_not_found" | "account_not_active" | "organization_mismatch" | null;
};

/**
 * Releases held events that ingest routed to `whatsappAccountId`, back to PENDING (attempts 0, due now, lease and
 * last_error cleared). The routing columns are NOT rewritten: an event is eligible only if its own organization_id and
 * whatsapp_account_id are exactly this account's, and its stored phone_number_id and WABA agree with the account.
 * Refused as a whole when the account no longer exists, is not ACTIVE, is archived, or when any held event of this
 * account names a different organization than the account row (ownership drift is never repaired by requeue).
 * Run it inside the transaction that activates/changes the account; the account row is locked FOR SHARE.
 */
export async function requeueRoutedHeldEvents(
  tx: DbExecutor,
  options: {
    whatsappAccountId: string;
    reasons: readonly RoutedRequeueReason[];
    receivedAfter: Date;
  },
): Promise<RoutedRequeueResult> {
  const { whatsappAccountId, reasons, receivedAfter } = options;
  if (reasons.length === 0 || !reasons.every((r) => ROUTED.has(r)))
    throw new RangeError("reasons must be a non-empty list of routed hold reasons");
  if (Number.isNaN(receivedAfter.getTime())) throw new RangeError("receivedAfter is invalid");

  const [account] = await tx
    .select()
    .from(schema.whatsappAccounts)
    .where(eq(schema.whatsappAccounts.id, whatsappAccountId))
    .for("share");
  if (!account) return { requeued: 0, skipped: "account_not_found" };
  if (account.status !== "ACTIVE" || account.archivedAt !== null)
    return { requeued: 0, skipped: "account_not_active" };

  const held = and(
    inArray(schema.webhookEvents.status, ["UNROUTABLE", "IGNORED"]),
    inArray(schema.webhookEvents.lastError, [...reasons]),
    eq(schema.webhookEvents.whatsappAccountId, account.id),
  );
  const [drift] = await tx
    .select({ n: count() })
    .from(schema.webhookEvents)
    .where(and(held, sql`${schema.webhookEvents.organizationId} <> ${account.organizationId}`));
  if ((drift?.n ?? 0) > 0) return { requeued: 0, skipped: "organization_mismatch" };

  const rows = await tx
    .update(schema.webhookEvents)
    .set(released)
    .where(
      and(
        held,
        eq(schema.webhookEvents.organizationId, account.organizationId),
        gte(schema.webhookEvents.receivedAt, receivedAfter),
        sql`${payloadPhoneNumberId(schema.webhookEvents.payload)} = ${account.phoneNumberId}`,
        sql`${payloadWabaId(schema.webhookEvents.payload)} = ${account.wabaId}`,
      ),
    )
    .returning({ id: schema.webhookEvents.id });
  return { requeued: rows.length, skipped: null };
}

/**
 * The automatic release on activation of `whatsappAccountId`: ONLY `account_pending` events already routed to exactly
 * that account, received within 30 days. Older ones stay held (never discarded) and are counted as `staleHeld`.
 * Unknown-account, WABA-mismatch, disabled and archived history are never released here.
 */
export async function requeueOnAccountActivation(
  tx: DbExecutor,
  options: { whatsappAccountId: string; now?: Date },
): Promise<RoutedRequeueResult & { staleHeld: number }> {
  const cutoff = new Date((options.now ?? new Date()).getTime() - REQUEUE_MAX_AGE_MS);
  const result = await requeueRoutedHeldEvents(tx, {
    whatsappAccountId: options.whatsappAccountId,
    reasons: AUTO_REQUEUE_REASONS,
    receivedAfter: cutoff,
  });
  if (result.skipped) return { ...result, staleHeld: 0 };
  const [stale] = await tx
    .select({ n: count() })
    .from(schema.webhookEvents)
    .where(
      and(
        eq(schema.webhookEvents.status, "UNROUTABLE"),
        eq(schema.webhookEvents.lastError, "account_pending"),
        eq(schema.webhookEvents.whatsappAccountId, options.whatsappAccountId),
        lt(schema.webhookEvents.receivedAt, cutoff),
      ),
    );
  return { ...result, staleHeld: stale?.n ?? 0 };
}

export type UnroutedRequeueRefusal =
  | "event_not_found"
  | "event_not_unrouted"
  | "account_not_found"
  | "account_not_active"
  | "phone_number_mismatch"
  | "waba_mismatch"
  | "event_too_old";

export type UnroutedRequeueResult =
  { requeued: true; refused: null } | { requeued: false; refused: UnroutedRequeueRefusal };

/**
 * An operator's explicit decision that ONE unrouted event (`unknown_account` or `waba_mismatch`, organization and
 * account both NULL) belongs to `targetWhatsappAccountId`. Everything is verified independently: the event must still be
 * a hold with no routing; the target must exist, be ACTIVE and not archived; the event's stored phone_number_id must be
 * the target's; the event's WABA must equal the target's (it must be present for `waba_mismatch`, and when an
 * `unknown_account` event carries one it must match); the event must be no older than `receivedAfter`, which the
 * operator confirms explicitly. Only then does the event acquire the target's organization and account. An event that
 * already has routing is refused here, so it can never be moved to another organization or account.
 */
export async function requeueUnroutedEvent(
  tx: DbExecutor,
  options: { webhookEventId: string; targetWhatsappAccountId: string; receivedAfter: Date },
): Promise<UnroutedRequeueResult> {
  const { webhookEventId, targetWhatsappAccountId, receivedAfter } = options;
  if (Number.isNaN(receivedAfter.getTime())) throw new RangeError("receivedAfter is invalid");
  const refuse = (refused: UnroutedRequeueRefusal): UnroutedRequeueResult => ({
    requeued: false,
    refused,
  });

  const [event] = await tx
    .select()
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.id, webhookEventId))
    .for("update");
  if (!event) return refuse("event_not_found");
  if (
    event.status !== "UNROUTABLE" ||
    event.organizationId !== null ||
    event.whatsappAccountId !== null ||
    !(UNROUTED_REASONS as readonly (string | null)[]).includes(event.lastError)
  )
    return refuse("event_not_unrouted");

  const [account] = await tx
    .select()
    .from(schema.whatsappAccounts)
    .where(eq(schema.whatsappAccounts.id, targetWhatsappAccountId))
    .for("share");
  if (!account) return refuse("account_not_found");
  if (account.status !== "ACTIVE" || account.archivedAt !== null)
    return refuse("account_not_active");

  const phoneNumberId = phoneNumberIdOf(event.payload);
  if (phoneNumberId === null || phoneNumberId !== account.phoneNumberId)
    return refuse("phone_number_mismatch");
  const wabaId = wabaIdOf(event.payload);
  if (wabaId !== null ? wabaId !== account.wabaId : event.lastError === "waba_mismatch")
    return refuse("waba_mismatch");
  if (event.receivedAt < receivedAfter) return refuse("event_too_old");

  const rows = await tx
    .update(schema.webhookEvents)
    .set({ ...released, organizationId: account.organizationId, whatsappAccountId: account.id })
    .where(
      and(
        eq(schema.webhookEvents.id, event.id),
        eq(schema.webhookEvents.status, "UNROUTABLE"),
        isNull(schema.webhookEvents.organizationId),
        isNull(schema.webhookEvents.whatsappAccountId),
      ),
    )
    .returning({ id: schema.webhookEvents.id });
  return rows.length === 1 ? { requeued: true, refused: null } : refuse("event_not_unrouted");
}
