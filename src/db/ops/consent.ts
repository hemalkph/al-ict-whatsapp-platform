import { and, desc, eq } from "drizzle-orm";
import { contactConsents, contacts } from "../schema/contacts";
import type { CONSENT_ACTIONS, CONSENT_SOURCES } from "../schema/enums";
import type { DbExecutor } from "./executor";

/**
 * Appends a MARKETING consent event and refreshes the cache on contacts to equal the latest event
 * (by occurred_at, then created_at, then id). Run inside a transaction; the contact row lock
 * serializes concurrent consent changes for the same contact.
 */
export async function recordMarketingConsent(
  tx: DbExecutor,
  input: {
    organizationId: string;
    contactId: string;
    action: (typeof CONSENT_ACTIONS)[number];
    source: (typeof CONSENT_SOURCES)[number];
    sourceRef?: string | null;
    evidence?: unknown;
    occurredAt: Date;
  },
): Promise<void> {
  await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.organizationId, input.organizationId), eq(contacts.id, input.contactId)))
    .for("update");

  await tx.insert(contactConsents).values({
    organizationId: input.organizationId,
    contactId: input.contactId,
    scope: "MARKETING",
    action: input.action,
    source: input.source,
    sourceRef: input.sourceRef ?? null,
    evidence: input.evidence ?? null,
    occurredAt: input.occurredAt,
  });

  const [latest] = await tx
    .select()
    .from(contactConsents)
    .where(
      and(
        eq(contactConsents.organizationId, input.organizationId),
        eq(contactConsents.contactId, input.contactId),
        eq(contactConsents.scope, "MARKETING"),
      ),
    )
    .orderBy(
      desc(contactConsents.occurredAt),
      desc(contactConsents.createdAt),
      desc(contactConsents.id),
    )
    .limit(1);
  if (!latest) throw new Error("consent event vanished");

  await tx
    .update(contacts)
    .set({
      marketingConsentStatus: latest.action,
      marketingConsentUpdatedAt: latest.occurredAt,
      updatedAt: new Date(),
    })
    .where(
      and(eq(contacts.organizationId, input.organizationId), eq(contacts.id, input.contactId)),
    );
}
