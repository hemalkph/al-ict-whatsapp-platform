import { eq } from "drizzle-orm";
import { schema } from "@/db";
import type { TestDb } from "@/db/__tests__/helpers";
import { bootstrapFirstAdmin } from "@/modules/access/operator";
import type { AuthEnv } from "@/modules/auth";
import { createProvisioningAuth } from "@/modules/auth/provisioning";
import {
  E2E_PASSWORD,
  FIRST_ADMIN,
  INBOX_CONTACTS,
  INBOX_TEXT,
  INBOX_USERS,
  ORG_A,
  ORG_B,
  ORG_C,
  REVIEW_CONTACTS,
  REVIEW_USERS,
  USERS,
} from "../e2e/support/identities";
import { can } from "@/modules/access";
import { submitOutboundMessage } from "@/modules/messaging";

// Seeds the DISPOSABLE E2E database with the minimum identities the browser tests need.
//  - The first admin is created by the real bootstrap workflow (organization + ADMIN, password_change_required).
//  - Every other account goes through the same private provisioning instance the services use, plus a membership
//    row: the same fixture pattern as the integration tests' provisionUser. No production auth logic is duplicated.

export async function seedE2E(t: TestDb, env: AuthEnv): Promise<void> {
  const provisioner = createProvisioningAuth({ db: t.db, env });

  await bootstrapFirstAdmin(
    {
      organizationName: ORG_A.name,
      organizationSlug: ORG_A.slug,
      email: FIRST_ADMIN.email,
      name: FIRST_ADMIN.name,
      password: E2E_PASSWORD,
    },
    { db: t.db, provisioner },
  );

  const [orgA] = await t.db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, ORG_A.slug));
  const [orgB] = await t.db.insert(schema.organizations).values(ORG_B).returning();
  if (!orgA || !orgB) throw new Error("E2E seed: organizations were not created.");
  const [orgC] = await t.db.insert(schema.organizations).values(ORG_C).returning();
  if (!orgC) throw new Error("E2E seed: organizations were not created.");
  const orgIds = { A: orgA.id, B: orgB.id, C: orgC.id };

  for (const u of [
    ...Object.values(USERS),
    ...Object.values(INBOX_USERS),
    ...Object.values(REVIEW_USERS),
  ]) {
    const created = await provisioner.api.signUpEmail({
      body: { name: u.name, email: u.email, password: E2E_PASSWORD },
    });
    await t.db.insert(schema.organizationMemberships).values({
      organizationId: orgIds[u.org],
      userId: created.user.id,
      role: u.role,
      status: "ACTIVE",
    });
  }

  await seedInbox(t, orgIds);
}

// ------------------------------------------------------------------------------------------------------ inbox data
// Fake students and fake messages for the Phase 06 browser tests. Timestamps are relative to "now" because the 24-hour reply
// window is part of what is being tested; the whole run takes minutes.
async function seedInbox(t: TestDb, orgIds: { A: string; B: string; C: string }): Promise<void> {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const digits = (n: number) =>
    `1${Array.from({ length: n - 1 }, () => Math.floor(Math.random() * 10)).join("")}`;
  const account = async (organizationId: string, label: string) =>
    (
      await t.db
        .insert(schema.whatsappAccounts)
        .values({
          organizationId,
          wabaId: digits(15),
          phoneNumberId: digits(15),
          displayPhoneNumber: label,
          status: "ACTIVE",
          credentialRef: "WA_TOKEN_E2E_UNUSED",
        })
        .returning()
    )[0]!;
  const accountA1 = await account(orgIds.A, "+94 77 123 4567");
  const accountA2 = await account(orgIds.A, "+94 71 765 4321");
  const accountB = await account(orgIds.B, "+94 76 000 1111");
  const accountC = await account(orgIds.C, "+94 75 222 3333");

  type Opts = {
    org: string;
    account: { id: string };
    name: string | null;
    waId: string | null;
    bsuid?: string;
    status?: "OPEN" | "PENDING" | "RESOLVED";
    lastInbound: Date | null;
    lastMessage: Date;
  };
  async function conversation(o: Opts) {
    const [contact] = await t.db
      .insert(schema.contacts)
      .values({
        organizationId: o.org,
        waId: o.waId,
        profileName: o.name,
        firstSeenAt: ago(60 * 24 * 10),
        lastSeenAt: o.lastMessage,
      })
      .returning();
    if (o.bsuid)
      await t.db.insert(schema.contactBsuids).values({
        organizationId: o.org,
        contactId: contact!.id,
        bsuid: o.bsuid,
        firstSeenAt: ago(60 * 24 * 10),
        lastSeenAt: o.lastMessage,
      });
    const [conv] = await t.db
      .insert(schema.conversations)
      .values({
        organizationId: o.org,
        whatsappAccountId: o.account.id,
        contactId: contact!.id,
        status: o.status ?? "OPEN",
        lastMessageAt: o.lastMessage,
        lastInboundAt: o.lastInbound,
        resolvedAt: o.status === "RESOLVED" ? o.lastMessage : null,
      })
      .returning();
    return { contact: contact!, conv: conv! };
  }
  let n = 0;
  async function message(
    c: { conv: { id: string }; contact?: unknown },
    org: string,
    account: { id: string },
    m: Partial<typeof schema.messages.$inferInsert> & { occurredAt: Date },
  ) {
    const direction = m.direction ?? "INBOUND";
    const [row] = await t.db
      .insert(schema.messages)
      .values({
        organizationId: org,
        conversationId: c.conv.id,
        whatsappAccountId: account.id,
        direction,
        type: "TEXT",
        wamid: direction === "INBOUND" ? `wamid.E2E${++n}` : null,
        ...m,
      })
      .returning();
    return row!;
  }

  // 1. Nimal: inside the reply window, Sinhala text, an earlier delivered outbound reply, a reply-to relationship.
  const nimal = await conversation({
    org: orgIds.A,
    account: accountA1,
    name: INBOX_CONTACTS.nimal,
    waId: "94771110001",
    lastInbound: ago(8),
    lastMessage: ago(8),
  });
  const earlier = await message(nimal, orgIds.A, accountA1, {
    direction: "OUTBOUND",
    body: "ICT theory class starts at 8.00 am.",
    wamid: "wamid.E2EOUT1",
    latestStatus: "DELIVERED",
    latestStatusAt: ago(58),
    occurredAt: ago(60),
  });
  await message(nimal, orgIds.A, accountA1, {
    body: "ok sir, thank you",
    occurredAt: ago(55),
    replyToMessageId: earlier.id,
    replyToWamid: "wamid.E2EOUT1",
  });
  await message(nimal, orgIds.A, accountA1, { body: INBOX_TEXT.nimalSinhala, occurredAt: ago(8) });
  await message(nimal, orgIds.A, accountA1, {
    type: "IMAGE",
    body: "Class timetable",
    occurredAt: ago(7),
  });

  // 2. Kavindi: Tamil text, PENDING, the 24-hour window has closed.
  const kavindi = await conversation({
    org: orgIds.A,
    account: accountA1,
    name: INBOX_CONTACTS.kavindi,
    waId: "94771110002",
    status: "PENDING",
    lastInbound: ago(60 * 40),
    lastMessage: ago(60 * 40),
  });
  await message(kavindi, orgIds.A, accountA1, {
    body: INBOX_TEXT.kavindiTamil,
    occurredAt: ago(60 * 40),
  });

  // 3. An unnamed contact known only by a BSUID (with a retained phone that must not be used).
  const bsuid = await conversation({
    org: orgIds.A,
    account: accountA1,
    name: null,
    waId: "94771110003",
    bsuid: "LK.E2eBsuid0001zz",
    lastInbound: ago(20),
    lastMessage: ago(20),
  });
  await message(bsuid, orgIds.A, accountA1, {
    body: "Hello? Is anyone there?",
    occurredAt: ago(20),
  });

  // 4. Ruwan: an outbound message whose outcome is unknown (created through the real Phase 05 submission path).
  const ruwan = await conversation({
    org: orgIds.A,
    account: accountA1,
    name: INBOX_CONTACTS.ruwan,
    waId: "94771110004",
    lastInbound: ago(30),
    lastMessage: ago(30),
  });
  await message(ruwan, orgIds.A, accountA1, {
    body: "Sir, when is the exam?",
    occurredAt: ago(30),
  });
  const [staffRow] = await t.db
    .select({
      id: schema.organizationMemberships.id,
      userId: schema.organizationMemberships.userId,
    })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
    .where(eq(schema.users.email, INBOX_USERS.staff.email));
  const submitted = await submitOutboundMessage(
    {
      userId: staffRow!.userId,
      membershipId: staffRow!.id,
      organizationId: orgIds.A,
      role: "STAFF",
      can: (p) => can("STAFF", p),
    },
    {
      idempotencyKey: "e2e-seed-unknown-outcome-key",
      conversationId: ruwan.conv.id,
      message: { type: "text", body: INBOX_TEXT.unknownOutcomeBody },
    },
    {
      db: t.db,
      config: {
        outboundEnabled: true,
        liveSendEnabled: false,
        bsuidRecipientEnabled: false,
        graphApiVersion: null,
      },
    },
  );
  await t.pool.query(
    "update outbound_requests set state='SENDING', claimed_by='e2e-seed', claimed_at=now(), send_started_at=now() where id=$1",
    [submitted.requestId],
  );
  await t.pool.query(
    "update outbound_requests set state='UNKNOWN_OUTCOME', failure_code='transport_timeout', finished_at=now() where id=$1",
    [submitted.requestId],
  );

  // 5. A second WhatsApp number with an attachment and an unsupported type.
  const dilani = await conversation({
    org: orgIds.A,
    account: accountA2,
    name: INBOX_CONTACTS.dilani,
    waId: "94711110005",
    lastInbound: ago(120),
    lastMessage: ago(120),
  });
  const photo = await message(dilani, orgIds.A, accountA2, {
    type: "IMAGE",
    body: "my project",
    occurredAt: ago(121),
  });
  await t.pool.query(
    "insert into message_attachments (organization_id, message_id, meta_media_id, mime_type, size_bytes, filename, storage_status) values ($1,$2,'e2e-media-1','image/jpeg',48213,'project.jpg','PENDING')",
    [orgIds.A, photo.id],
  );
  await message(dilani, orgIds.A, accountA2, {
    type: "UNKNOWN",
    body: null,
    content: { rawType: "order" },
    occurredAt: ago(120),
  });

  // 6. Filler conversations (older), so the list has more than one page.
  for (let i = 1; i <= 35; i++) {
    const filler = await conversation({
      org: orgIds.A,
      account: accountA1,
      name: `Filler Student ${String(i).padStart(2, "0")}`,
      waId: `9477200${String(i).padStart(4, "0")}`,
      status: "RESOLVED",
      lastInbound: ago(60 * 24 * 3 + i),
      lastMessage: ago(60 * 24 * 3 + i),
    });
    await message(filler, orgIds.A, accountA1, {
      body: `older message ${i}`,
      occurredAt: ago(60 * 24 * 3 + i),
    });
  }

  // 7. Another organization's conversation: it must never be visible to organization A.
  const other = await conversation({
    org: orgIds.B,
    account: accountB,
    name: INBOX_CONTACTS.orgB,
    waId: "94761110009",
    lastInbound: ago(5),
    lastMessage: ago(5),
  });
  await message(other, orgIds.B, accountB, { body: INBOX_TEXT.orgBSecret, occurredAt: ago(5) });

  // 8. Organization C (e2e/inbox-review.spec.ts only): four conversations inside the reply window. Nothing else uses them, so
  //    the specs there may send, resolve, assign and receive messages without affecting any other spec.
  const reviewNames = [
    [REVIEW_CONTACTS.alpha, "94751110001", 6],
    [REVIEW_CONTACTS.beta, "94751110002", 7],
    [REVIEW_CONTACTS.gamma, "94751110003", 8],
    [REVIEW_CONTACTS.delta, "94751110004", 9],
  ] as const;
  for (const [name, waId, minutes] of reviewNames) {
    const c = await conversation({
      org: orgIds.C,
      account: accountC,
      name,
      waId,
      lastInbound: ago(minutes),
      lastMessage: ago(minutes),
    });
    // Delta also has a long history, so that part of it is below the fold when it opens (unseen messages that are loaded but
    // not on screen must stay unseen).
    const earlier = name === REVIEW_CONTACTS.delta ? 30 : 0;
    for (let i = earlier; i >= 1; i--)
      await message(c, orgIds.C, accountC, {
        body: `Earlier question ${i}: ${"please explain the practical exam format again. ".repeat(3)}`,
        occurredAt: ago(minutes + i),
      });
    await message(c, orgIds.C, accountC, {
      body: `Hello from ${name}`,
      occurredAt: ago(minutes),
    });
  }
}
