import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@/db";
import { can, type AccessContext, type Role } from "@/modules/access";
import { seedContact, seedWorld, type TestDb } from "@/db/__tests__/helpers";

// TEST-ONLY helpers (excluded from the boundary scans). Fake students, fake ads and fake messages only. Nothing here can reach
// Meta, and nothing sets a lead up through the services under test: fixtures are written straight to the tables.

type Db = TestDb["db"];
let n = 0;
const uniq = () => `${(n++).toString(36)}${randomBytes(2).toString("hex")}`;

export const minutesAgo = (m: number, from = new Date()) => new Date(from.getTime() - m * 60_000);

export type Actor = { ctx: AccessContext; userId: string; membershipId: string; role: Role };

export async function addActor(
  db: Db | Database,
  organizationId: string,
  role: Role = "STAFF",
): Promise<Actor> {
  const [user] = await db
    .insert(schema.users)
    .values({ name: `Staff ${uniq()}`, email: `s-${uniq()}@example.com` })
    .returning();
  const [membership] = await db
    .insert(schema.organizationMemberships)
    .values({ organizationId, userId: user!.id, role })
    .returning();
  return {
    userId: user!.id,
    membershipId: membership!.id,
    role,
    ctx: {
      userId: user!.id,
      membershipId: membership!.id,
      organizationId,
      role,
      can: (p) => can(role, p),
    },
  };
}

/** An organization with a WhatsApp account, one contact with a conversation, and one actor of each role. */
export async function world(db: Db) {
  const w = await seedWorld(db);
  return {
    ...w,
    admin: await addActor(db, w.org.id, "ADMIN"),
    staff: await addActor(db, w.org.id, "STAFF"),
    viewer: await addActor(db, w.org.id, "VIEWER"),
  };
}
export type World = Awaited<ReturnType<typeof world>>;

/** Another contact of the organization, optionally BSUID-only (no phone-based id), named, or archived. */
export async function addContact(
  db: Db,
  organizationId: string,
  o: {
    waId?: string | null;
    bsuid?: string;
    profileName?: string | null;
    username?: string | null;
    archived?: boolean;
  } = {},
) {
  const contact = await seedContact(db, organizationId);
  const seen = new Date("2026-01-01T00:00:00Z");
  await db
    .update(schema.contacts)
    .set({
      waId: o.waId === undefined ? contact.waId : o.waId,
      profileName: o.profileName ?? null,
      username: o.username ?? null,
      archivedAt: o.archived ? new Date() : null,
    })
    .where(
      and(eq(schema.contacts.organizationId, organizationId), eq(schema.contacts.id, contact.id)),
    );
  if (o.bsuid)
    await db.insert(schema.contactBsuids).values({
      organizationId,
      contactId: contact.id,
      bsuid: o.bsuid,
      firstSeenAt: seen,
      lastSeenAt: seen,
    });
  return contact;
}

/** An inbound message of the contact (conversation created when needed). */
async function messageFor(
  db: Db,
  w: { org: { id: string }; account: { id: string } },
  contactId: string,
  occurredAt: Date,
  direction: "INBOUND" | "OUTBOUND" = "INBOUND",
) {
  let [conversation] = await db
    .select()
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.organizationId, w.org.id),
        eq(schema.conversations.contactId, contactId),
      ),
    );
  if (!conversation)
    [conversation] = await db
      .insert(schema.conversations)
      .values({
        organizationId: w.org.id,
        whatsappAccountId: w.account.id,
        contactId,
        lastMessageAt: occurredAt,
        lastInboundAt: occurredAt,
      })
      .returning();
  const [message] = await db
    .insert(schema.messages)
    .values({
      organizationId: w.org.id,
      conversationId: conversation!.id,
      whatsappAccountId: w.account.id,
      direction,
      type: "TEXT",
      body: "hello",
      occurredAt,
      wamid: `wamid.L${uniq()}`,
    })
    .returning();
  return message!;
}

/** An attribution touch exactly as the Phase 04 handler writes it: UNLINKED, for an inbound message of the contact. */
export async function addTouch(
  db: Db,
  w: { org: { id: string }; account: { id: string } },
  contactId: string,
  o: {
    sourceType?: (typeof schema.ATTRIBUTION_SOURCE_TYPES)[number];
    receivedAt?: Date;
    occurredAt?: Date;
    withMessage?: boolean;
    /** The direction of the message that carried the referral (a real inquiry is INBOUND). */
    direction?: "INBOUND" | "OUTBOUND";
    headline?: string | null;
    body?: string | null;
    sourceUrl?: string | null;
    mediaUrl?: string | null;
    sourceId?: string | null;
    ctwaClid?: string | null;
  } = {},
) {
  const receivedAt = o.receivedAt ?? new Date();
  const message =
    o.withMessage === false
      ? null
      : await messageFor(db, w, contactId, o.occurredAt ?? receivedAt, o.direction);
  const [touch] = await db
    .insert(schema.leadAttributions)
    .values({
      organizationId: w.org.id,
      contactId,
      messageId: message?.id ?? null,
      sourceType: o.sourceType ?? "META_AD",
      sourceId: o.sourceId === undefined ? "120000000000001" : o.sourceId,
      sourceUrl: o.sourceUrl === undefined ? "https://fb.me/abc?utm=secret#frag" : o.sourceUrl,
      headline: o.headline === undefined ? "A/L ICT 2027" : o.headline,
      body: o.body === undefined ? "Join our class" : o.body,
      mediaType: "image",
      mediaUrl: o.mediaUrl === undefined ? "https://cdn.example.test/ad.jpg?sig=x" : o.mediaUrl,
      ctwaClid:
        o.ctwaClid === undefined ? "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNpqrstuv" : o.ctwaClid,
      providerData: { thumbnail_url: "https://cdn.example.test/t.jpg", secret: "provider-only" },
      receivedAt,
    })
    .returning();
  return touch!;
}

/**
 * A lead written straight to the table, as fixtures of any state need (including reserved statuses and old cycles, which the
 * services never produce). A closed lead gets closed_at = now unless given; the cycle starts a minute ago unless given.
 */
export async function seedLead(
  db: Db,
  w: { org: { id: string } },
  contactId: string,
  o: {
    status?: (typeof schema.LEAD_STATUSES)[number];
    cycleStartedAt?: Date;
    closedAt?: Date | null;
    createdAt?: Date;
  } = {},
) {
  const status = o.status ?? "NEW";
  const closed = (schema.CLOSED_LEAD_STATUSES as readonly string[]).includes(status);
  const [lead] = await db
    .insert(schema.leads)
    .values({
      organizationId: w.org.id,
      contactId,
      status,
      closedAt: closed ? (o.closedAt ?? new Date()) : null,
      cycleStartedAt: o.cycleStartedAt ?? minutesAgo(1),
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    })
    .returning();
  return lead!;
}

/** Links a touch to a lead the way a compliant writer does: the link and its TOUCH_LINKED history row in one transaction. */
export async function linkTouch(
  db: Db,
  w: { org: { id: string } },
  lead: { id: string; contactId: string },
  touchId: string,
) {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.leadAttributions)
      .set({ leadId: lead.id })
      .where(
        and(
          eq(schema.leadAttributions.organizationId, w.org.id),
          eq(schema.leadAttributions.id, touchId),
        ),
      );
    await tx.insert(schema.leadEvents).values({
      organizationId: w.org.id,
      leadId: lead.id,
      contactId: lead.contactId,
      kind: "TOUCH_LINKED",
      attributionId: touchId,
    });
  });
}

/**
 * A lead as the reconciler of checkpoint 07C will create it, written by hand (07B has no automatic creation): the lead names its
 * initiating touch in its INSERT, then its CREATED event, the link and the link's history, in one transaction. The database sets
 * the lead's cycle start from the touch's receipt time.
 */
export async function seedAutomaticLead(
  db: Db,
  w: { org: { id: string } },
  contactId: string,
  touchId: string,
) {
  return db.transaction(async (tx) => {
    const [lead] = await tx
      .insert(schema.leads)
      .values({ organizationId: w.org.id, contactId, initiatingAttributionId: touchId })
      .returning();
    await tx.insert(schema.leadEvents).values({
      organizationId: w.org.id,
      leadId: lead!.id,
      contactId,
      kind: "CREATED",
      origin: "AD_REFERRAL",
      attributionId: touchId,
      revision: 0,
    });
    await tx
      .update(schema.leadAttributions)
      .set({ leadId: lead!.id })
      .where(
        and(
          eq(schema.leadAttributions.organizationId, w.org.id),
          eq(schema.leadAttributions.id, touchId),
        ),
      );
    await tx.insert(schema.leadEvents).values({
      organizationId: w.org.id,
      leadId: lead!.id,
      contactId,
      kind: "TOUCH_LINKED",
      attributionId: touchId,
    });
    return lead!;
  });
}
