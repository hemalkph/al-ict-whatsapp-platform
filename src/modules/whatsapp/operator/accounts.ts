import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, type Database, type DbExecutor } from "@/db";
import { payloadPhoneNumberId } from "../envelope";
import { emitWebhookLog } from "../logging";
import { requeueOnAccountActivation } from "../queue/requeue";
import { transact } from "./dryrun";

// OPERATOR-ONLY WhatsApp account management. Reached only by scripts/whatsapp-accounts.ts (not exported from the module's
// public API, not importable from src/app).
//
// Ownership rules (ADR 0013):
//  - An account's organization_id, phone_number_id and waba_id are WRITTEN ONCE, at registration. Nothing here updates
//    them; the only columns this file ever updates are status, archived_at and updated_at (a static test pins this).
//  - A phone_number_id belongs to at most one account in the whole system (unique index); a WABA belongs to at most one
//    organization (checked here under an advisory lock, because the schema has no constraint for it).
//  - One organization = one Meta Business Portfolio. This cannot be verified without a Graph call, so registration requires
//    the operator to confirm it explicitly.
//  - credential_ref is a NAME that points at a server-side secret, never a token.
//  - No account is ever moved, merged, re-homed or activated implicitly.

const metaId = z.string().regex(/^[0-9]{6,30}$/, "must be 6 to 30 digits");
// An environment-variable style name. Real Meta access tokens are long mixed-case strings (they start with "EAA"), so this
// pattern cannot hold one.
const credentialRef = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{2,63}$/, "must be an UPPER_SNAKE_CASE secret name, never a token")
  .refine((v) => !v.startsWith("EAA"), "looks like an access token");
const text = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^[^\u0000-\u001f\u007f]+$/, "must not contain control characters")
    .max(max);

export const registerSchema = z.strictObject({
  organization: z.string().trim().min(2).max(63),
  wabaId: metaId,
  phoneNumberId: metaId,
  displayPhoneNumber: text(40).min(3),
  verifiedName: text(120).min(1).optional(),
  credentialRef: credentialRef.optional(),
  /** The operator's explicit statement that this WABA belongs to the same Meta Business Portfolio as the organization's others. */
  portfolioConfirmed: z.literal(true),
});
export type RegisterInput = z.input<typeof registerSchema>;

export type AccountRefusal =
  | "invalid_input"
  | "portfolio_not_confirmed"
  | "organization_not_found"
  | "organization_archived"
  | "phone_number_id_in_use"
  | "waba_owned_by_other_organization"
  | "account_not_found"
  | "account_archived"
  | "invalid_state";

export type AccountView = {
  id: string;
  organizationId: string;
  organizationSlug: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  status: "PENDING" | "ACTIVE" | "DISABLED";
  credentialRef: string | null;
  archivedAt: string | null;
  createdAt: string;
};

export type Refused = { ok: false; refused: AccountRefusal; detail?: string };
const refuse = (refused: AccountRefusal, detail?: string): Refused => ({
  ok: false,
  refused,
  detail,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function lockKeys(tx: DbExecutor, keys: string[]) {
  for (const key of [...keys].sort())
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

function view(
  a: typeof schema.whatsappAccounts.$inferSelect,
  organizationSlug: string,
): AccountView {
  return {
    id: a.id,
    organizationId: a.organizationId,
    organizationSlug,
    wabaId: a.wabaId,
    phoneNumberId: a.phoneNumberId,
    displayPhoneNumber: a.displayPhoneNumber,
    verifiedName: a.verifiedName,
    status: a.status,
    credentialRef: a.credentialRef,
    archivedAt: a.archivedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

/** Held events of kind unknown_account / waba_mismatch that name this phone_number_id: NEVER released by registration or activation. */
async function unroutedForPhone(tx: DbExecutor, phoneNumberId: string) {
  const [row] = await tx
    .select({ n: count() })
    .from(schema.webhookEvents)
    .where(
      and(
        eq(schema.webhookEvents.status, "UNROUTABLE"),
        inArray(schema.webhookEvents.lastError, ["unknown_account", "waba_mismatch"]),
        sql`${payloadPhoneNumberId(schema.webhookEvents.payload)} = ${phoneNumberId}`,
      ),
    );
  return row?.n ?? 0;
}

// ------------------------------------------------------------------------------------------------ register

export async function registerAccount(db: Database, raw: unknown, options: { apply: boolean }) {
  const parsed = registerSchema.safeParse(raw);
  if (!parsed.success) {
    const missing = parsed.error.issues.every((i) => i.path[0] === "portfolioConfirmed");
    return refuse(
      missing ? "portfolio_not_confirmed" : "invalid_input",
      parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
    );
  }
  const input = parsed.data;

  const { applied, value } = await transact(db, options.apply, async (tx) => {
    // Serialize registrations that touch the same phone number or WABA across processes.
    await lockKeys(tx, [
      `wa-account-phone:${input.phoneNumberId}`,
      `wa-account-waba:${input.wabaId}`,
    ]);

    const org = await tx
      .select()
      .from(schema.organizations)
      .where(
        UUID.test(input.organization)
          ? eq(schema.organizations.id, input.organization)
          : eq(schema.organizations.slug, input.organization.toLowerCase()),
      )
      .for("share");
    const organization = org[0];
    if (!organization) return refuse("organization_not_found");
    if (organization.archivedAt !== null) return refuse("organization_archived");

    const [samePhone] = await tx
      .select({ organizationId: schema.whatsappAccounts.organizationId })
      .from(schema.whatsappAccounts)
      .where(eq(schema.whatsappAccounts.phoneNumberId, input.phoneNumberId));
    if (samePhone)
      return refuse(
        "phone_number_id_in_use",
        samePhone.organizationId === organization.id
          ? "already registered for this organization"
          : "already registered for ANOTHER organization; accounts are never moved",
      );

    const [otherOrgWaba] = await tx
      .select({ id: schema.whatsappAccounts.id })
      .from(schema.whatsappAccounts)
      .where(
        and(
          eq(schema.whatsappAccounts.wabaId, input.wabaId),
          ne(schema.whatsappAccounts.organizationId, organization.id),
        ),
      )
      .limit(1);
    if (otherOrgWaba)
      return refuse(
        "waba_owned_by_other_organization",
        "this WABA is already registered under a different organization (one organization = one Meta Business Portfolio)",
      );

    const [account] = await tx
      .insert(schema.whatsappAccounts)
      .values({
        organizationId: organization.id,
        wabaId: input.wabaId,
        phoneNumberId: input.phoneNumberId,
        displayPhoneNumber: input.displayPhoneNumber,
        verifiedName: input.verifiedName ?? null,
        credentialRef: input.credentialRef ?? null,
        status: "PENDING", // activation is a separate, explicit step
      })
      .returning();
    const existing = await tx
      .select({ wabaId: schema.whatsappAccounts.wabaId })
      .from(schema.whatsappAccounts)
      .where(
        and(
          eq(schema.whatsappAccounts.organizationId, organization.id),
          ne(schema.whatsappAccounts.id, account!.id),
        ),
      );
    return {
      ok: true as const,
      account: view(account!, organization.slug),
      otherWabasOfOrganization: [...new Set(existing.map((e) => e.wabaId))],
      unroutedEventsAwaitingReview: await unroutedForPhone(tx, input.phoneNumberId),
    };
  });

  if (!("ok" in value && value.ok)) return value as Refused;
  if (applied)
    emitWebhookLog({
      event: "operator.account_registered",
      outcome: "success",
      organizationId: value.account.organizationId,
      whatsappAccountId: value.account.id,
    });
  return { ...value, applied };
}

// ----------------------------------------------------------------------------------------------- transitions

type Transition = "activate" | "enable" | "disable" | "archive";
const FROM: Record<Transition, readonly ("PENDING" | "ACTIVE" | "DISABLED")[]> = {
  activate: ["PENDING"],
  enable: ["DISABLED"],
  disable: ["PENDING", "ACTIVE"],
  archive: ["PENDING", "ACTIVE", "DISABLED"],
};
const TO: Record<Transition, "ACTIVE" | "DISABLED"> = {
  activate: "ACTIVE",
  enable: "ACTIVE",
  disable: "DISABLED",
  archive: "DISABLED", // an archived account is also disabled
};

const TRANSITION_LOG = {
  activate: "operator.account_activated",
  enable: "operator.account_enabled",
  disable: "operator.account_disabled",
  archive: "operator.account_archived",
} as const;

async function transition(
  db: Database,
  accountId: string,
  kind: Transition,
  options: { apply: boolean; now?: Date },
) {
  if (!UUID.test(accountId)) return refuse("invalid_input", "account id must be a UUID");
  const { applied, value } = await transact(db, options.apply, async (tx) => {
    const [account] = await tx
      .select()
      .from(schema.whatsappAccounts)
      .where(eq(schema.whatsappAccounts.id, accountId))
      .for("update");
    if (!account) return refuse("account_not_found");
    await lockKeys(tx, [`wa-account-waba:${account.wabaId}`]);
    const [organization] = await tx
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, account.organizationId))
      .for("share");
    if (account.archivedAt !== null)
      return refuse("account_archived", "archived accounts are never changed");
    if (!FROM[kind].includes(account.status))
      return refuse("invalid_state", `cannot ${kind} an account that is ${account.status}`);

    if (kind === "activate" || kind === "enable") {
      if (!organization || organization.archivedAt !== null)
        return refuse("organization_archived", "the organization is archived");
      // The one-organization-per-WABA rule is re-verified at the moment an account starts receiving events.
      const [conflict] = await tx
        .select({ id: schema.whatsappAccounts.id })
        .from(schema.whatsappAccounts)
        .where(
          and(
            eq(schema.whatsappAccounts.wabaId, account.wabaId),
            ne(schema.whatsappAccounts.organizationId, account.organizationId),
          ),
        )
        .limit(1);
      if (conflict) return refuse("waba_owned_by_other_organization");
    }

    // The ONLY columns this module ever updates: status, archived_at, updated_at. Never organization, phone number or WABA.
    const [updated] = await tx
      .update(schema.whatsappAccounts)
      .set({
        status: TO[kind],
        updatedAt: sql`now()`,
        ...(kind === "archive" ? { archivedAt: sql`now()` } : {}),
      })
      .where(
        and(
          eq(schema.whatsappAccounts.id, account.id),
          eq(schema.whatsappAccounts.organizationId, account.organizationId),
          inArray(schema.whatsappAccounts.status, [...FROM[kind]]),
        ),
      )
      .returning();

    // Activation releases ONLY account_pending events already routed to exactly this account, received within 30 days.
    // Nothing else is released: unknown_account / waba_mismatch need an explicit operator decision, disabled / archived
    // history is never released automatically, and `enable` releases nothing.
    const release =
      kind === "activate"
        ? await requeueOnAccountActivation(tx, { whatsappAccountId: account.id, now: options.now })
        : null;
    return {
      ok: true as const,
      from: account.status,
      account: view(updated!, organization?.slug ?? ""),
      released: release
        ? { requeued: release.requeued, staleHeldLeft: release.staleHeld, skipped: release.skipped }
        : null,
      unroutedEventsAwaitingReview:
        kind === "activate" ? await unroutedForPhone(tx, account.phoneNumberId) : null,
    };
  });
  if (!("ok" in value && value.ok)) return value as Refused;
  if (applied)
    emitWebhookLog({
      event: TRANSITION_LOG[kind],
      outcome: "success",
      organizationId: value.account.organizationId,
      whatsappAccountId: value.account.id,
      counts: { events: value.released?.requeued ?? 0 },
    });
  return { ...value, applied };
}

export const activateAccount = (db: Database, id: string, o: { apply: boolean; now?: Date }) =>
  transition(db, id, "activate", o);
export const enableAccount = (db: Database, id: string, o: { apply: boolean }) =>
  transition(db, id, "enable", o);
export const disableAccount = (db: Database, id: string, o: { apply: boolean }) =>
  transition(db, id, "disable", o);
export const archiveAccount = (db: Database, id: string, o: { apply: boolean }) =>
  transition(db, id, "archive", o);

// ------------------------------------------------------------------------------------------------- inspect

export async function listAccounts(db: Database) {
  const rows = await db
    .select({ account: schema.whatsappAccounts, slug: schema.organizations.slug })
    .from(schema.whatsappAccounts)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.whatsappAccounts.organizationId),
    )
    .orderBy(schema.organizations.slug, schema.whatsappAccounts.createdAt);
  return rows.map((r) => view(r.account, r.slug));
}

export async function inspectAccount(db: Database, accountId: string) {
  if (!UUID.test(accountId)) return refuse("invalid_input", "account id must be a UUID");
  const [row] = await db
    .select({ account: schema.whatsappAccounts, slug: schema.organizations.slug })
    .from(schema.whatsappAccounts)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.whatsappAccounts.organizationId),
    )
    .where(eq(schema.whatsappAccounts.id, accountId));
  if (!row) return refuse("account_not_found");
  const events = await db
    .select({
      status: schema.webhookEvents.status,
      reason: schema.webhookEvents.lastError,
      n: count(),
    })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.whatsappAccountId, accountId))
    .groupBy(schema.webhookEvents.status, schema.webhookEvents.lastError);
  const [messages] = await db
    .select({ n: count() })
    .from(schema.messages)
    .where(eq(schema.messages.whatsappAccountId, accountId));
  const sameWaba = await db
    .select({
      id: schema.whatsappAccounts.id,
      phoneNumberId: schema.whatsappAccounts.phoneNumberId,
    })
    .from(schema.whatsappAccounts)
    .where(
      and(
        eq(schema.whatsappAccounts.organizationId, row.account.organizationId),
        eq(schema.whatsappAccounts.wabaId, row.account.wabaId),
        ne(schema.whatsappAccounts.id, accountId),
      ),
    );
  return {
    ok: true as const,
    account: view(row.account, row.slug),
    // routed events by queue state; `reason` is the hold/dead/ignore code, never message content
    events: events.map((e) => ({ status: e.status, reason: e.reason, count: e.n })),
    unroutedEventsAwaitingReview: await unroutedForPhone(
      db as unknown as DbExecutor,
      row.account.phoneNumberId,
    ),
    messages: messages?.n ?? 0,
    otherNumbersOnSameWaba: sameWaba,
    credentialNote: row.account.credentialRef
      ? "credential_ref names a server-side secret; its value is never read or shown here"
      : "no credential reference set (not needed until outbound messaging exists)",
  };
}
