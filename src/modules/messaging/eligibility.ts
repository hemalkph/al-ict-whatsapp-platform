import { and, eq } from "drizzle-orm";
import { schema, type DbExecutor } from "@/db";
import { isIntactIdentifier, IDENTIFIER_LIMITS } from "@/modules/whatsapp/identifiers";
import { serviceWindow } from "./window";

// Everything that decides WHETHER and TO WHOM a message may be sent. It is evaluated twice by the same code: when the
// staff request is created, and again inside the transaction that claims the request for dispatch (the account, the
// recipient, the window and the consent can all change while a request waits).

export type Recipient = { readonly kind: "PHONE" | "BSUID"; readonly id: string };

export type HoldCode =
  | "account_inactive"
  | "contact_archived"
  | "no_inbound"
  | "window_closed"
  | "inbound_timestamp_invalid"
  | "no_identity"
  | "identity_ambiguous"
  | "bsuid_send_unavailable"
  | "template_not_found"
  | "template_not_approved"
  | "template_category_unsupported"
  | "template_parameters_mismatch"
  | "marketing_consent_missing"
  | "no_prior_contact"
  | "recipient_changed"
  | "deadline_passed";

export type ConversationContext = {
  readonly conversationId: string;
  readonly accountId: string;
  readonly contactId: string;
  readonly lastInboundAt: Date | null;
  readonly contact: {
    readonly waId: string | null;
    readonly archivedAt: Date | null;
    readonly marketingConsentStatus: "UNKNOWN" | "GRANTED" | "WITHDRAWN";
  };
  readonly aliases: ReadonlyArray<{ readonly bsuid: string; readonly retiredAt: Date | null }>;
};

export type AccountState = {
  readonly id: string;
  readonly status: "PENDING" | "ACTIVE" | "DISABLED";
  readonly archivedAt: Date | null;
  readonly phoneNumberId: string;
  readonly credentialRef: string | null;
};

export type TemplateRow = typeof schema.whatsappTemplates.$inferSelect;

/** The conversation, its contact and the contact's aliases, strictly inside one organization. Null when it is not there. */
export async function loadConversationContext(
  tx: DbExecutor,
  organizationId: string,
  conversationId: string,
): Promise<ConversationContext | null> {
  const [row] = await tx
    .select({
      conversation: schema.conversations,
      waId: schema.contacts.waId,
      archivedAt: schema.contacts.archivedAt,
      consent: schema.contacts.marketingConsentStatus,
    })
    .from(schema.conversations)
    .innerJoin(
      schema.contacts,
      and(
        eq(schema.contacts.organizationId, schema.conversations.organizationId),
        eq(schema.contacts.id, schema.conversations.contactId),
      ),
    )
    .where(
      and(
        eq(schema.conversations.organizationId, organizationId),
        eq(schema.conversations.id, conversationId),
      ),
    );
  if (!row) return null;
  const aliases = await tx
    .select({ bsuid: schema.contactBsuids.bsuid, retiredAt: schema.contactBsuids.retiredAt })
    .from(schema.contactBsuids)
    .where(
      and(
        eq(schema.contactBsuids.organizationId, organizationId),
        eq(schema.contactBsuids.contactId, row.conversation.contactId),
      ),
    );
  return {
    conversationId: row.conversation.id,
    accountId: row.conversation.whatsappAccountId,
    contactId: row.conversation.contactId,
    lastInboundAt: row.conversation.lastInboundAt,
    contact: { waId: row.waId, archivedAt: row.archivedAt, marketingConsentStatus: row.consent },
    aliases,
  };
}

/** Reads the account row; `share` takes FOR SHARE so a concurrent disable/archive waits for this transaction. */
export async function loadAccount(
  tx: DbExecutor,
  organizationId: string,
  accountId: string,
  lock: boolean,
): Promise<AccountState | null> {
  const query = tx
    .select({
      id: schema.whatsappAccounts.id,
      status: schema.whatsappAccounts.status,
      archivedAt: schema.whatsappAccounts.archivedAt,
      phoneNumberId: schema.whatsappAccounts.phoneNumberId,
      credentialRef: schema.whatsappAccounts.credentialRef,
    })
    .from(schema.whatsappAccounts)
    .where(
      and(
        eq(schema.whatsappAccounts.organizationId, organizationId),
        eq(schema.whatsappAccounts.id, accountId),
      ),
    );
  const [row] = await (lock ? query.for("share") : query);
  return row ?? null;
}

export async function loadTemplate(
  tx: DbExecutor,
  organizationId: string,
  accountId: string,
  templateId: string,
): Promise<TemplateRow | null> {
  const [row] = await tx
    .select()
    .from(schema.whatsappTemplates)
    .where(
      and(
        eq(schema.whatsappTemplates.organizationId, organizationId),
        eq(schema.whatsappTemplates.whatsappAccountId, accountId),
        eq(schema.whatsappTemplates.id, templateId),
      ),
    );
  return row ?? null;
}

/**
 * Who the message goes to, from TRUSTED internal records only (never from the browser, a username or a display name):
 *  1. a contact with a single CURRENT (not retired) BSUID is addressed by that BSUID, and only when BSUID sending is enabled
 *     (it is off until Meta's `recipient` contract is verified). With it disabled the send is refused: it NEVER falls back to
 *     the stored phone id. The resolver keeps a historical wa_id when BSUID observations change (it cannot tell a changed
 *     number from a recycled one), so for a contact that has ever been seen with a BSUID that value is not evidence of who
 *     owns the phone number today, and nothing in the schema re-verifies it;
 *  2. a contact whose aliases are all retired is ambiguous: refuse;
 *  3. only a contact that has NEVER been observed with a BSUID (a legacy phone-only contact, identified by the phone number
 *     Meta delivered on its inbound messages) is addressed by its phone id;
 *  4. nothing addressable: refuse.
 * A phone number is never derived from a BSUID, a BSUID is never derived from a phone, contacts and aliases are never
 * merged or reassigned, and an identifier is used exactly as stored (anything that is not intact is refused, never cleaned).
 */
export function chooseRecipient(
  context: ConversationContext,
  bsuidRecipientEnabled: boolean,
): { ok: true; recipient: Recipient } | { ok: false; code: HoldCode } {
  const current = context.aliases.filter((a) => a.retiredAt === null);
  if (current.length > 1) return { ok: false, code: "identity_ambiguous" };
  const alias = current[0];
  const intact = (v: string) => isIntactIdentifier(v, IDENTIFIER_LIMITS.sender);
  if (alias) {
    if (!bsuidRecipientEnabled) return { ok: false, code: "bsuid_send_unavailable" };
    return intact(alias.bsuid)
      ? { ok: true, recipient: { kind: "BSUID", id: alias.bsuid } }
      : { ok: false, code: "identity_ambiguous" };
  }
  if (context.aliases.length > 0) return { ok: false, code: "identity_ambiguous" };
  const waId = context.contact.waId;
  if (waId === null) return { ok: false, code: "no_identity" };
  return intact(waId)
    ? { ok: true, recipient: { kind: "PHONE", id: waId } }
    : { ok: false, code: "identity_ambiguous" };
}

export type Assessment = { ok: true; recipient: Recipient } | { ok: false; code: HoldCode };

/**
 * The full decision. `now` is passed in (never read here) so the window is testable at its boundary.
 *  - TEXT (and INTERACTIVE) needs the customer service window to be open.
 *  - TEMPLATE to a phone-only contact additionally needs the window to be open (see the end of this function).
 *  - TEMPLATE needs a registered, operator-attested APPROVED template of this account; UTILITY additionally needs a prior
 *    inbound message from this contact (a customer-initiated relationship); MARKETING additionally needs recorded
 *    GRANTED marketing consent (an inbound message or an advertising referral is never consent); AUTHENTICATION is not
 *    supported. No consent is ever created here.
 */
export function assess(input: {
  account: AccountState | null;
  context: ConversationContext;
  message:
    | { type: "text" }
    | { type: "interactive" }
    | { type: "template"; template: TemplateRow | null; parameterCount: number };
  bsuidRecipientEnabled: boolean;
  now: Date;
}): Assessment {
  const { account, context, message } = input;
  if (!account || account.status !== "ACTIVE" || account.archivedAt !== null)
    return { ok: false, code: "account_inactive" };
  if (context.contact.archivedAt !== null) return { ok: false, code: "contact_archived" };

  // An interactive message (Phase 08D, BOT only) is a free-form message: exactly the TEXT rules (window-bound, no template,
  // no consent path).
  if (message.type === "text" || message.type === "interactive") {
    const window = serviceWindow(context.lastInboundAt, input.now);
    if (!window.open) return { ok: false, code: window.reason };
  } else {
    const t = message.template;
    if (!t) return { ok: false, code: "template_not_found" };
    if (t.status !== "APPROVED") return { ok: false, code: "template_not_approved" };
    if (t.bodyParameterCount !== message.parameterCount)
      return { ok: false, code: "template_parameters_mismatch" };
    if (t.category === "AUTHENTICATION")
      return { ok: false, code: "template_category_unsupported" };
    if (t.category === "MARKETING" && context.contact.marketingConsentStatus !== "GRANTED")
      return { ok: false, code: "marketing_consent_missing" };
    if (t.category === "UTILITY" && context.lastInboundAt === null)
      return { ok: false, code: "no_prior_contact" };
  }
  const chosen = chooseRecipient(context, input.bsuidRecipientEnabled);
  // A template is the only message allowed outside the service window, i.e. a PROACTIVE message. A phone number that the
  // application knows only from inbound history proves who wrote at that time, not who owns the number now, and nothing in the
  // schema binds a phone to a person beyond that observation (consent is recorded per contact, not per number). So a template
  // to a phone-only contact is sent only while a recent qualifying inbound message keeps the window open; with a historical
  // inbound alone it is HELD with the window's own reason. Recorded consent and a prior inbound never substitute for this.
  if (chosen.ok && message.type === "template" && chosen.recipient.kind === "PHONE") {
    const window = serviceWindow(context.lastInboundAt, input.now);
    if (!window.open) return { ok: false, code: window.reason };
  }
  return chosen;
}
