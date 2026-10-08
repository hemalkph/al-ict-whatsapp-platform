import { inArray } from "drizzle-orm";
import { schema, type DbExecutor } from "@/db";
import type { NormalizedEvent } from "./normalize";

// Routing. The organization comes ONLY from the whatsapp_accounts row found through metadata.phone_number_id, never
// from anything in the body. Existing webhook_events statuses are used; nothing here interprets the event's content.
//
// Tenant provenance rule: once ingest matched an account (consistent phone_number_id AND WABA), the event keeps that
// organization/account for life, even while it is held. Provenance is never erased and never re-derived later.
//
//   ACTIVE account                      -> PENDING      routing set
//   PENDING account (being set up)      -> UNROUTABLE   routing SET   account_pending   (a hold; released only for
//                                                       exactly this account when it is activated)
//   DISABLED account                    -> IGNORED      routing set    account_disabled
//   archived account                    -> IGNORED      routing set    account_archived
//   unknown phone_number_id             -> UNROUTABLE   routing NULL   unknown_account   (no proven owner; operator
//                                                       review and an explicit target account are required)
//   entry.id differs from waba_id       -> UNROUTABLE   routing NULL   waba_mismatch     (not proven to belong to the
//                                                       account; operator review and an explicit target)
//   an event that needs no processing   -> IGNORED      routing set when the account is known and consistent
//   a malformed element                 -> DEAD         routing NULL
// Nothing is dropped: held and ignored events keep their payload and reason code.

export type EventStatus = "PENDING" | "UNROUTABLE" | "IGNORED" | "DEAD";

export type AccountRow = {
  id: string;
  organizationId: string;
  wabaId: string;
  phoneNumberId: string;
  status: "PENDING" | "ACTIVE" | "DISABLED";
  archivedAt: Date | null;
};

export type AccountLookup = (
  db: DbExecutor,
  phoneNumberIds: readonly string[],
) => Promise<Map<string, AccountRow>>;

export type RoutingDecision = {
  status: EventStatus;
  organizationId: string | null;
  whatsappAccountId: string | null;
  reason: string | null;
};

export const lookupAccounts: AccountLookup = async (db, phoneNumberIds) => {
  const found = new Map<string, AccountRow>();
  if (phoneNumberIds.length === 0) return found;
  const rows = await db
    .select({
      id: schema.whatsappAccounts.id,
      organizationId: schema.whatsappAccounts.organizationId,
      wabaId: schema.whatsappAccounts.wabaId,
      phoneNumberId: schema.whatsappAccounts.phoneNumberId,
      status: schema.whatsappAccounts.status,
      archivedAt: schema.whatsappAccounts.archivedAt,
    })
    .from(schema.whatsappAccounts)
    .where(inArray(schema.whatsappAccounts.phoneNumberId, [...phoneNumberIds]));
  for (const row of rows) found.set(row.phoneNumberId, row);
  return found;
};

const unrouted = (status: EventStatus, reason: string): RoutingDecision => ({
  status,
  organizationId: null,
  whatsappAccountId: null,
  reason,
});

export function decideRouting(
  event: NormalizedEvent,
  accounts: ReadonlyMap<string, AccountRow>,
): RoutingDecision {
  const { intrinsic } = event;
  if (intrinsic.kind === "dead") return unrouted("DEAD", intrinsic.reason);

  const account = event.phoneNumberId ? accounts.get(event.phoneNumberId) : undefined;
  const consistent =
    account !== undefined && event.wabaId !== null && account.wabaId === event.wabaId;
  const routed = (status: EventStatus, reason: string | null): RoutingDecision => ({
    status,
    organizationId: account!.organizationId,
    whatsappAccountId: account!.id,
    reason,
  });

  if (intrinsic.kind === "ignored") {
    return consistent ? routed("IGNORED", intrinsic.reason) : unrouted("IGNORED", intrinsic.reason);
  }
  if (!event.phoneNumberId) return unrouted("UNROUTABLE", "missing_phone_number_id");
  if (!account) return unrouted("UNROUTABLE", "unknown_account");
  if (!consistent) return unrouted("UNROUTABLE", "waba_mismatch");
  if (account.archivedAt !== null) return routed("IGNORED", "account_archived");
  if (account.status === "DISABLED") return routed("IGNORED", "account_disabled");
  if (account.status === "PENDING") return routed("UNROUTABLE", "account_pending");
  return routed("PENDING", null);
}
