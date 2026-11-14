import { sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import type { OutboundConfig } from "./config";
import { assess, type AccountState, type ConversationContext } from "./eligibility";
import { SEND_START_BUDGET_MS } from "./policy";

// The FINAL pre-HTTP authorization of an origin-BOT request (Phase 08D, ADR 0020; V3.2 I.4 and I.5). Staff requests never
// come here: their final read (dispatch.ts authorizeSend) is unchanged.
//
// ONE statement reads everything the decision rests on, in one snapshot: the request and its claim fence, the account, the
// conversation's inbound activity, the contact (archive, consent, phone), every BSUID alias, and the bot rule
// bot_request_hold_code() (deployment, epoch, archive, output suppression, session step or terminal notice, staff control
// after the session start). The clock is read AFTER the statement returns, and from there the decision is synchronous up to
// the transport call. Any refusal is recorded by the dispatcher as a fenced SENDING -> HELD with the code (no HTTP attempt,
// never re-queued).
//
// Boundary that remains (V3.2 I.4, blocker 42): a Stop, takeover, window closure or recipient change that becomes visible
// only AFTER this statement cannot stop the send it authorized.

export type BotFinalClaim = {
  readonly requestId: string;
  readonly organizationId: string;
  readonly owner: string;
  readonly recipient: { readonly kind: "PHONE" | "BSUID"; readonly id: string };
  readonly messageType: "TEXT" | "INTERACTIVE";
};

type Row = {
  state: string;
  claimed_by: string | null;
  send_started_at: Date | null;
  dispatch_deadline: Date;
  recipient_kind: string;
  recipient_id: string;
  origin: string;
  account_id: string;
  account_status: AccountState["status"];
  account_archived_at: Date | null;
  phone_number_id: string;
  credential_ref: string | null;
  conversation_id: string;
  whatsapp_account_id: string;
  contact_id: string;
  last_inbound_at: Date | null;
  wa_id: string | null;
  contact_archived_at: Date | null;
  marketing_consent_status: ConversationContext["contact"]["marketingConsentStatus"];
  aliases: Array<{ bsuid: string; retiredAt: string | null }>;
  bot_hold_code: string | null;
};

const date = (v: Date | string | null): Date | null =>
  v === null ? null : v instanceof Date ? v : new Date(v);

/** The single authoritative read. Organization-scoped on every table. */
async function readFinalState(
  db: DbExecutor,
  organizationId: string,
  requestId: string,
): Promise<Row | null> {
  const result = await db.execute<Row>(sql`
    SELECT r.state, r.claimed_by, r.send_started_at, r.dispatch_deadline, r.recipient_kind, r.recipient_id, r.origin,
           a.id AS account_id, a.status AS account_status, a.archived_at AS account_archived_at,
           a.phone_number_id, a.credential_ref,
           c.id AS conversation_id, c.whatsapp_account_id, c.contact_id, c.last_inbound_at,
           k.wa_id, k.archived_at AS contact_archived_at, k.marketing_consent_status,
           COALESCE((SELECT json_agg(json_build_object('bsuid', b.bsuid, 'retiredAt', b.retired_at) ORDER BY b.bsuid)
                       FROM contact_bsuids b
                      WHERE b.organization_id = r.organization_id AND b.contact_id = c.contact_id), '[]'::json) AS aliases,
           bot_request_hold_code(r.organization_id, r.id) AS bot_hold_code
      FROM outbound_requests r
      JOIN whatsapp_accounts a ON a.organization_id = r.organization_id AND a.id = r.whatsapp_account_id
      JOIN conversations c ON c.organization_id = r.organization_id AND c.id = r.conversation_id
      JOIN contacts k ON k.organization_id = c.organization_id AND k.id = c.contact_id
     WHERE r.organization_id = ${organizationId} AND r.id = ${requestId}`);
  return (result.rows[0] as Row | undefined) ?? null;
}

export type BotFinalVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "stale" }
  | { readonly kind: "refused"; readonly reason: string };

/** Pure: the decision over one read, at one fresh time. Order is the approved one (plan G.3); the first failure wins. */
export function botFinalVerdict(
  row: Row | null,
  claim: BotFinalClaim,
  config: OutboundConfig,
  now: Date,
): BotFinalVerdict {
  // 1. the claim fence
  if (
    !row ||
    row.origin !== "BOT" ||
    row.state !== "SENDING" ||
    row.claimed_by !== claim.owner ||
    !row.send_started_at
  )
    return { kind: "stale" };
  // 2. gates
  if (!config.outboundEnabled) return { kind: "refused", reason: "outbound_disabled" };
  if (!config.botsRuntimeEnabled) return { kind: "refused", reason: "bots_runtime_disabled" };
  // 3. account
  const account: AccountState = {
    id: row.account_id,
    status: row.account_status,
    archivedAt: date(row.account_archived_at),
    phoneNumberId: row.phone_number_id,
    credentialRef: row.credential_ref,
  };
  if (account.status !== "ACTIVE" || account.archivedAt !== null)
    return { kind: "refused", reason: "account_inactive_before_dispatch" };
  // 4. start budget, 5. deadline (120 s for BOT requests)
  if (now.getTime() - date(row.send_started_at)!.getTime() > SEND_START_BUDGET_MS)
    return { kind: "refused", reason: "claim_expired_before_dispatch" };
  if (now.getTime() > date(row.dispatch_deadline)!.getTime())
    return { kind: "refused", reason: "deadline_passed_before_dispatch" };
  // 6. the bot rule (deployment, epoch, archive, suppression, session step / terminal notice, staff control)
  if (row.bot_hold_code !== null) return { kind: "refused", reason: row.bot_hold_code };
  // 7. window, contact and recipient, with the fresh clock
  const context: ConversationContext = {
    conversationId: row.conversation_id,
    accountId: row.whatsapp_account_id,
    contactId: row.contact_id,
    lastInboundAt: date(row.last_inbound_at),
    contact: {
      waId: row.wa_id,
      archivedAt: date(row.contact_archived_at),
      marketingConsentStatus: row.marketing_consent_status,
    },
    aliases: row.aliases.map((a) => ({ bsuid: a.bsuid, retiredAt: date(a.retiredAt) })),
  };
  const assessment = assess({
    account,
    context,
    message: claim.messageType === "TEXT" ? { type: "text" } : { type: "interactive" },
    bsuidRecipientEnabled: config.bsuidRecipientEnabled,
    now,
  });
  if (!assessment.ok) return { kind: "refused", reason: assessment.code };
  // 8. the recipient chosen now is still the one queued (and the one the claim prepared)
  if (
    assessment.recipient.kind !== row.recipient_kind ||
    assessment.recipient.id !== row.recipient_id ||
    assessment.recipient.kind !== claim.recipient.kind ||
    assessment.recipient.id !== claim.recipient.id
  )
    return { kind: "refused", reason: "recipient_changed" };
  return { kind: "ok" };
}

/** Reads, THEN takes the time, then decides. */
export async function authorizeBotSend(
  deps: { readonly db: DbExecutor; readonly config: OutboundConfig; readonly now?: () => Date },
  claim: BotFinalClaim,
): Promise<BotFinalVerdict> {
  const row = await readFinalState(deps.db, claim.organizationId, claim.requestId);
  const now = (deps.now ?? (() => new Date()))();
  return botFinalVerdict(row, claim, deps.config, now);
}
