import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { schema } from "@/db";
import type { TestDb } from "@/db/__tests__/helpers";
import { bootstrapFirstAdmin } from "@/modules/access/operator";
import type { AuthEnv } from "@/modules/auth";
import { createProvisioningAuth } from "@/modules/auth/provisioning";
import {
  DETAIL_CONTACTS,
  DETAIL_HOSTILE,
  DETAIL_STATUS_CHANGES,
  DETAIL_USERS,
  E2E_PASSWORD,
  FIRST_ADMIN,
  INBOX_CONTACTS,
  INBOX_TEXT,
  INBOX_USERS,
  LEADS_CONTACTS,
  LEADS_SEED,
  LEADS_USERS,
  ORG_A,
  ORG_B,
  ORG_C,
  ORG_D,
  ORG_E,
  ORG_F,
  ORG_G,
  ORG_H,
  PANEL_CONTACTS,
  INTEG_CONTACTS,
  INTEG_USERS,
  PANEL_USERS,
  REVIEW_CONTACTS,
  REVIEW_USERS,
  STATUS_CONTACTS,
  USERS,
} from "../e2e/support/identities";
import { seedAccount } from "@/db/__tests__/helpers";
import { can, type Role } from "@/modules/access";
import { changeLeadStatus, createManualLead } from "@/modules/leads";
import { addContact, addTouch, seedLead } from "@/modules/leads/testing";
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
  const [orgD] = await t.db.insert(schema.organizations).values(ORG_D).returning();
  const [orgE] = await t.db.insert(schema.organizations).values(ORG_E).returning();
  if (!orgC || !orgD || !orgE) throw new Error("E2E seed: organizations were not created.");
  const [orgF] = await t.db.insert(schema.organizations).values(ORG_F).returning();
  const [orgG] = await t.db.insert(schema.organizations).values(ORG_G).returning();
  const [orgH] = await t.db.insert(schema.organizations).values(ORG_H).returning();
  if (!orgF || !orgG || !orgH) throw new Error("E2E seed: organizations were not created.");
  const orgIds = {
    A: orgA.id,
    B: orgB.id,
    C: orgC.id,
    D: orgD.id,
    E: orgE.id,
    F: orgF.id,
    G: orgG.id,
    H: orgH.id,
  };

  for (const u of [
    ...Object.values(USERS),
    ...Object.values(INBOX_USERS),
    ...Object.values(REVIEW_USERS),
    ...Object.values(LEADS_USERS),
    ...Object.values(DETAIL_USERS),
    ...Object.values(PANEL_USERS),
    ...Object.values(INTEG_USERS),
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
  // FIRST among the fixtures that run the reconciler: it processes every organization's pending touches, so running it after the
  // lead-page fixtures would link evidence those fixtures deliberately leave alone (and change their expected history).
  await seedIntegration(t, orgIds.H);
  await seedLeads(t, orgIds);
  await seedLeadDetail(t, orgIds.F);
  await seedLeadStatus(t, orgIds.F);
  await seedInboxLeads(t, orgIds.G);
}

// An access context for a seeded account, so the REAL lead services can run as that member.
async function actorOf(t: TestDb, email: string, organizationId: string, role: Role) {
  const [m] = await t.db
    .select({
      id: schema.organizationMemberships.id,
      userId: schema.organizationMemberships.userId,
    })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
    .where(eq(schema.users.email, email));
  if (!m) throw new Error("E2E seed: leads actor missing.");
  return {
    userId: m.userId,
    membershipId: m.id,
    organizationId,
    role,
    can: (p: Parameters<typeof can>[1]) => can(role, p),
  };
}

// The reconciler is run as the REAL command (the only importer of the reconciler the 07C boundaries allow), against this
// disposable database only: an explicit environment, no .env.local, nothing inherited but PATH.
function runReconciler(t: TestDb): {
  created?: number;
  linked?: number;
  skipped?: { beforeCycle?: number };
} {
  const run = spawnSync(
    process.execPath,
    [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "scripts/leads-reconcile.ts"],
    {
      env: {
        PATH: process.env.PATH ?? "",
        LEADS_RECONCILER_ENABLED: "true",
        DATABASE_URL: t.url,
      } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  if (run.status !== 0) throw new Error("E2E seed: the reconciler command failed.");
  return JSON.parse(run.stdout.trim());
}

// ------------------------------------------------------------------------------------------------------ leads data
// Organization D's leads for the Leads page specs (Phase 07D-2), made the way the application makes them: manual leads and status
// changes through the REAL lead services, ad-referral leads through the REAL reconciler. One fixture writes directly, through the
// module's own test helper, a state the application cannot produce on its own: a lead in a reserved status (nothing in Phase 07
// sets one). A lead with a NON-Meta referral is not seeded: since migration 0006 the database links only confirmed Meta ad
// touches, so that source kind cannot occur in this schema (the UI's wording for it is unit-tested).
// Creation order decides the list order (newest first): 33 bulk (oldest), 3 closed, the reserved one, 2 ad leads.
async function seedLeads(t: TestDb, orgIds: { D: string; E: string }): Promise<void> {
  const deps = { db: t.db };
  const staffD = await actorOf(t, LEADS_USERS.staff.email, orgIds.D, "STAFF");
  const staffE = await actorOf(t, LEADS_USERS.otherOrg.email, orgIds.E, "STAFF");
  const worldD = { org: { id: orgIds.D }, account: await seedAccount(t.db, orgIds.D) };
  const contact = (organizationId: string, name: string) =>
    addContact(t.db, organizationId, { profileName: name });
  const manual = async (name: string) =>
    (await createManualLead(staffD, { contactId: (await contact(orgIds.D, name)).id }, deps)).lead;

  for (let i = 1; i <= LEADS_SEED.bulk; i++)
    await manual(`${LEADS_CONTACTS.bulkPrefix} ${String(i).padStart(2, "0")}`);
  for (let i = 1; i <= LEADS_SEED.closed; i++) {
    const lead = await manual(`${LEADS_CONTACTS.closedPrefix} ${i}`);
    await changeLeadStatus(
      staffD,
      lead.id,
      { to: "NOT_INTERESTED", expectedRevision: lead.revision },
      deps,
    );
  }
  await seedLead(t.db, worldD, (await contact(orgIds.D, LEADS_CONTACTS.reserved)).id, {
    status: "PAID",
  });
  for (const name of [LEADS_CONTACTS.adAmaya, LEADS_CONTACTS.adBimal])
    await addTouch(t.db, worldD, (await contact(orgIds.D, name)).id); // a confirmed Meta ad touch of an inbound message
  const report = runReconciler(t);
  if (report.created !== 2)
    throw new Error("E2E seed: the reconciler command did not create the two ad-referral leads.");

  await createManualLead(
    staffE,
    { contactId: (await contact(orgIds.E, LEADS_CONTACTS.otherOrg)).id },
    deps,
  );
}

// ------------------------------------------------------------------------------------------------------ lead page data
// Organization F's leads for the lead page specs (Phase 07D-3), made the way the application makes them: leads and status changes
// through the REAL lead services, automatic leads and every "not linked" decision through the REAL reconciler command. Only the
// reserved-status lead is written directly (nothing in Phase 07 can set a reserved status), exactly as in organization D.
//   rich      a staff-created lead; Meta ad evidence linked to it (hostile text); older evidence skipped by the reconciler
//             (SKIPPED_BEFORE_CYCLE); a later touch nobody has considered yet; CREATED, TOUCH_LINKED and 43 status changes
//   reopened  an automatic lead, closed, then a second lead made by staff: the first lead's evidence belongs to another lead
//   auto      an open automatic lead
//   paid      a reserved-status lead with no history     plain  a staff-created lead with no evidence and no conversation
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

async function seedLeadDetail(t: TestDb, orgId: string): Promise<void> {
  const deps = { db: t.db };
  const staff = await actorOf(t, DETAIL_USERS.staff.email, orgId, "STAFF");
  const world = { org: { id: orgId }, account: await seedAccount(t.db, orgId) };
  const contact = (name: string) => addContact(t.db, orgId, { profileName: name });

  const rich = await contact(DETAIL_CONTACTS.rich);
  const reopened = await contact(DETAIL_CONTACTS.reopened);
  const auto = await contact(DETAIL_CONTACTS.auto);

  // the older touch comes first: it predates the lead made next, so the reconciler must refuse it (SKIPPED_BEFORE_CYCLE)
  await addTouch(t.db, world, rich.id, {
    receivedAt: hoursAgo(72),
    headline: "Old campaign, before this lead",
    body: "An earlier ad of the same contact",
    sourceId: "120000000000009",
  });
  const richLead = (await createManualLead(staff, { contactId: rich.id }, deps)).lead;
  await sleep(300); // the linked touch must be received after the lead's cycle began
  await addTouch(t.db, world, rich.id, {
    headline: DETAIL_HOSTILE.headline,
    body: DETAIL_HOSTILE.body,
    sourceId: "120000000000001",
  });
  await addTouch(t.db, world, reopened.id, { receivedAt: hoursAgo(2), headline: "Reopened ad" });
  await addTouch(t.db, world, auto.id, { receivedAt: hoursAgo(1), headline: "Auto ad" });

  const report = runReconciler(t);
  if (report.created !== 2 || report.linked !== 1 || report.skipped?.beforeCycle !== 1)
    throw new Error(`E2E seed: the reconciler did not do what the lead page fixtures need.`);

  // a touch nobody has considered yet: "not linked to any lead yet"
  await addTouch(t.db, world, rich.id, {
    receivedAt: new Date(),
    headline: "A later ad, not yet considered",
    sourceId: "120000000000002",
  });

  let revision = richLead.revision;
  for (let i = 0; i < DETAIL_STATUS_CHANGES; i++) {
    const to = i % 2 === 0 ? "QUALIFIED" : "NEW";
    revision = (
      await changeLeadStatus(staff, richLead.id, { to, expectedRevision: revision }, deps)
    ).lead.revision;
  }

  // reopened: close the automatic lead, then staff open a second one for the same contact
  const [first] = (
    await t.db.execute<{ id: string; revision: number }>(
      sql`SELECT id, revision FROM leads WHERE organization_id = ${orgId}::uuid AND contact_id = ${reopened.id}::uuid`,
    )
  ).rows;
  if (!first) throw new Error("E2E seed: the automatic lead of the reopened contact is missing.");
  await changeLeadStatus(
    staff,
    first.id,
    { to: "NOT_INTERESTED", expectedRevision: first.revision },
    deps,
  );
  await createManualLead(staff, { contactId: reopened.id }, deps);

  await seedLead(t.db, world, (await contact(DETAIL_CONTACTS.paid)).id, { status: "PAID" });
  await createManualLead(staff, { contactId: (await contact(DETAIL_CONTACTS.plain)).id }, deps);
}

// ------------------------------------------------------------------------------------------------------ status specs data
// Leads for the status management specs (Phase 07D-4): one open NEW lead per mutating test, made by the real lead services, so no
// test depends on another's changes. `blocked` is closed through the real service, then a second lead is opened for its contact.
async function seedLeadStatus(t: TestDb, orgId: string): Promise<void> {
  const deps = { db: t.db };
  const staff = await actorOf(t, DETAIL_USERS.staff.email, orgId, "STAFF");
  for (const [key, name] of Object.entries(STATUS_CONTACTS)) {
    const contact = await addContact(t.db, orgId, { profileName: name });
    const first = (await createManualLead(staff, { contactId: contact.id }, deps)).lead;
    if (key !== "blocked") continue;
    await changeLeadStatus(
      staff,
      first.id,
      { to: "NOT_INTERESTED", expectedRevision: first.revision },
      deps,
    );
    await createManualLead(staff, { contactId: contact.id }, deps);
  }
}

// ------------------------------------------------------------------------------------------------------ inbox lead panel data
/** One conversation with one inbound message for a contact, so the Inbox lists it. `i` spreads the times (newest first). */
async function addConversation(
  t: TestDb,
  orgId: string,
  accountId: string,
  contactId: string,
  name: string,
  i: number,
): Promise<void> {
  const at = new Date(Date.now() - i * 60_000);
  const [conv] = await t.db
    .insert(schema.conversations)
    .values({
      organizationId: orgId,
      whatsappAccountId: accountId,
      contactId,
      lastMessageAt: at,
      lastInboundAt: at,
    })
    .returning();
  await t.db.insert(schema.messages).values({
    organizationId: orgId,
    conversationId: conv!.id,
    whatsappAccountId: accountId,
    direction: "INBOUND",
    type: "TEXT",
    body: `Hello from ${name}`,
    occurredAt: at,
    wamid: `wamid.PANEL${orgId.slice(0, 4)}${i}${Math.floor(Math.random() * 1e9)}`,
  });
}

// Organization G (Phase 07D-5): one conversation per contact, and leads made by the REAL lead services (manual creation and status
// changes), so the panel reads exactly what the application wrote. The archived contact is archived by the module's test helper.
async function seedInboxLeads(t: TestDb, orgId: string): Promise<void> {
  const deps = { db: t.db };
  const staff = await actorOf(t, PANEL_USERS.staff.email, orgId, "STAFF");
  const account = await seedAccount(t.db, orgId);
  const contacts: Record<string, string> = {};
  let i = 0;
  for (const [key, name] of Object.entries(PANEL_CONTACTS)) {
    const contact = await addContact(t.db, orgId, {
      profileName: name,
      archived: key === "archived",
    });
    await addConversation(t, orgId, account.id, contact.id, name, ++i);
    contacts[key] = contact.id;
  }
  const close = async (lead: { id: string; revision: number }) =>
    changeLeadStatus(
      staff,
      lead.id,
      { to: "NOT_INTERESTED", expectedRevision: lead.revision },
      deps,
    );
  // open: an earlier lead, closed; then the current one, Qualified
  await close((await createManualLead(staff, { contactId: contacts.open! }, deps)).lead);
  const current = (await createManualLead(staff, { contactId: contacts.open! }, deps)).lead;
  await changeLeadStatus(staff, current.id, { to: "QUALIFIED", expectedRevision: 0 }, deps);
  // closed: two closed leads, none open
  await close((await createManualLead(staff, { contactId: contacts.closed! }, deps)).lead);
  await close((await createManualLead(staff, { contactId: contacts.closed! }, deps)).lead);
  // raceA: an open lead, so its panel can never be mistaken for raceB's (no lead)
  await createManualLead(staff, { contactId: contacts.raceA! }, deps);
}

// Organization H (Phase 07D-6): the integration journeys. One fixture per journey, made the way the application makes it: the ad
// lead by the REAL reconciler command from a confirmed Meta ad touch, the staff lead by the real service, the Paid lead directly
// (no service produces a reserved status).
async function seedIntegration(t: TestDb, orgId: string): Promise<void> {
  const deps = { db: t.db };
  const staff = await actorOf(t, INTEG_USERS.staff.email, orgId, "STAFF");
  const account = await seedAccount(t.db, orgId);
  const world = { org: { id: orgId }, account };
  const contact = async (name: string, i: number, conversation = true) => {
    const c = await addContact(t.db, orgId, { profileName: name });
    if (conversation) await addConversation(t, orgId, account.id, c.id, name, i);
    return c;
  };
  const ad = await contact(INTEG_CONTACTS.ad, 1, false); // its conversation comes with the touch's inbound message
  await addTouch(t.db, world, ad.id);
  await contact(INTEG_CONTACTS.manual, 2);
  const cycle = await contact(INTEG_CONTACTS.cycle, 3);
  await createManualLead(staff, { contactId: cycle.id }, deps);
  await seedLead(t.db, world, (await contact(INTEG_CONTACTS.reserved, 4)).id, { status: "PAID" });
  await contact(INTEG_CONTACTS.viewer, 5);
  await contact(INTEG_CONTACTS.mobile, 6);
  const report = runReconciler(t);
  if (report.created !== 1)
    throw new Error("E2E seed: the reconciler command did not create the integration ad lead.");
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
        botsRuntimeEnabled: false,
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
