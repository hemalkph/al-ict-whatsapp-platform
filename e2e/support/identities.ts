// TEST-ONLY identities for the browser E2E suite. Every value here is a fake that exists only inside the
// disposable E2E database, which is created for one run and dropped afterwards. Nothing here is a real secret.
// Each spec owns its identities so specs can run in parallel without sharing mutable state.

export const E2E_PASSWORD = "e2e-initial-password-1";
export const E2E_NEW_PASSWORD = "e2e-changed-password-2";

export const ORG_A = { name: "E2E Org A", slug: "e2e-org-a" } as const;
export const ORG_B = { name: "E2E Org B", slug: "e2e-org-b" } as const;
/** Owns the Phase 06 review-correction specs (e2e/inbox-review.spec.ts) so nothing there shares conversations with other specs. */
export const ORG_C = { name: "E2E Org C", slug: "e2e-org-c" } as const;
/** Owns the Phase 07D Leads page specs (e2e/leads.spec.ts): every lead seeded for them lives here. */
export const ORG_D = { name: "E2E Org D", slug: "e2e-org-d" } as const;
/** A second organization with a lead of its own, so the Leads specs can prove it never shows up in organization D. */
export const ORG_E = { name: "E2E Org E", slug: "e2e-org-e" } as const;

/** Owns the Phase 07D-3 lead page specs (e2e/lead-detail.spec.ts): the leads with evidence and history seeded for them live here. */
export const ORG_F = { name: "E2E Org F", slug: "e2e-org-f" } as const;
/** Owns the Phase 07D-5 Inbox lead panel specs (e2e/inbox-leads.spec.ts): conversations of contacts with and without leads. */
export const ORG_G = { name: "E2E Org G", slug: "e2e-org-g" } as const;
/** Phase 07D-6 integration journeys (Inbox -> Lead Details -> Status -> Leads). */
export const ORG_H = { name: "E2E Org H", slug: "e2e-org-h" } as const;

/** Created by the REAL bootstrap workflow: password_change_required = true. */
export const FIRST_ADMIN = { email: "first.admin@e2e.test", name: "First Admin" } as const;

export type SeedUser = {
  readonly email: string;
  readonly name: string;
  readonly org: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
  readonly role: "ADMIN" | "STAFF" | "VIEWER";
};

const user = (key: string, name: string, role: SeedUser["role"], org: SeedUser["org"] = "A") =>
  ({ email: `${key}@e2e.test`, name, org, role }) satisfies SeedUser;

/** Ready-to-use accounts (no pending password change). */
export const USERS = {
  invalidLogin: user("invalid.login", "Invalid Login", "STAFF"),
  logout: user("logout.user", "Logout User", "ADMIN"),
  redirect: user("redirect.user", "Redirect User", "STAFF"),
  proxy: user("proxy.user", "Proxy User", "STAFF"),
  apiAdmin: user("api.admin", "Api Admin", "ADMIN"),
  apiStaff: user("api.staff", "Api Staff", "STAFF"),
  apiViewer: user("api.viewer", "Api Viewer", "VIEWER"),
  apiTarget: user("api.target", "Api Target", "STAFF"),
  orgBStaff: user("b.staff", "Org B Staff", "STAFF", "B"),
} as const;

// Inbox (Phase 06) identities. Org A staff share the seeded conversations below; org B has one conversation of its own.
export const INBOX_USERS = {
  staff: user("inbox.staff", "Inbox Staff", "STAFF"),
  staff2: user("inbox.staff2", "Inbox Second Staff", "STAFF"),
  viewer: user("inbox.viewer", "Inbox Viewer", "VIEWER"),
  admin: user("inbox.admin", "Inbox Admin", "ADMIN"),
  mobile: user("inbox.mobile", "Inbox Mobile", "STAFF"),
  orgB: user("inbox.orgb", "Inbox Org B", "STAFF", "B"),
} as const;

// Review-correction identities (organization C): two memberships to prove browser state is not shared between them.
export const REVIEW_USERS = {
  staff: user("review.staff", "Review Staff", "STAFF", "C"),
  staff2: user("review.staff2", "Review Second Staff", "STAFF", "C"),
} as const;
export const REVIEW_CONTACTS = {
  alpha: "Review Alpha",
  beta: "Review Beta",
  gamma: "Review Gamma",
  delta: "Review Delta",
} as const;

/** Fake students. Names are what the profile says; nothing here is real personal data. */
export const INBOX_CONTACTS = {
  nimal: "Nimal Perera",
  kavindi: "Kavindi Selvaraj",
  ruwan: "Ruwan Jayasinghe",
  dilani: "Dilani Fernando",
  orgB: "Org B Student",
} as const;
export const INBOX_TEXT = {
  nimalSinhala: "සුබ සන්ධ්‍යාවක්! ICT පන්තිය ඉරිදා කීයටද?",
  kavindiTamil: "வணக்கம், ICT வகுப்பு கட்டணம் எவ்வளவு?",
  orgBSecret: "ORG B CONFIDENTIAL MESSAGE",
  unknownOutcomeBody: "Please bring your index number on Sunday.",
} as const;

// Leads page identities (Phase 07D-2, organizations D and E). `actor` is the one that signs out and back in during the
// account-change test, so it never disturbs the sessions of the others.
export const LEADS_USERS = {
  staff: user("leads.staff", "Leads Staff", "STAFF", "D"),
  viewer: user("leads.viewer", "Leads Viewer", "VIEWER", "D"),
  actor: user("leads.actor", "Leads Actor", "STAFF", "D"),
  otherOrg: user("leads.other", "Leads Other Org", "STAFF", "E"),
} as const;

/** Fake contacts of the Leads specs. Names are what a WhatsApp profile would say; nothing here is real personal data. */
export const LEADS_CONTACTS = {
  adAmaya: "Lead Ad Amaya",
  adBimal: "Lead Ad Bimal",
  reserved: "Lead Paid Dinesh",
  closedPrefix: "Lead Closed",
  bulkPrefix: "Lead Bulk",
  otherOrg: "Org E Confidential Lead",
} as const;
/** Organization D's leads: 2 from Meta ad referrals (the reconciler), 1 reserved, 3 closed, 33 bulk: 39 in all. */
export const LEADS_SEED = { bulk: 33, closed: 3 } as const;

// Lead page identities (Phase 07D-3, organization F). Each test that changes the signed-in account owns its own actor.
export const DETAIL_USERS = {
  staff: user("detail.staff", "Detail Staff", "STAFF", "F"),
  viewer: user("detail.viewer", "Detail Viewer", "VIEWER", "F"),
  actor: user("detail.actor", "Detail Actor", "STAFF", "F"),
  actor2: user("detail.actor2", "Detail Actor Two", "STAFF", "F"),
  /** Owns the account-change test of the status specs (e2e/lead-status.spec.ts): it signs out in a second tab. */
  statusActor: user("status.actor", "Status Actor", "STAFF", "F"),
  /** A second staff member, for the specs where two people change the same lead. */
  statusStaff2: user("status.staff2", "Status Second Staff", "STAFF", "F"),
} as const;

/** Fake contacts of the lead page specs. Names are what a WhatsApp profile would say; nothing here is real personal data. */
export const DETAIL_CONTACTS = {
  /** A staff-created lead with linked Meta ad evidence (hostile text), other evidence that is not linked, and 45 history events. */
  rich: "Detail Rich Kamal",
  /** A closed automatic lead and, after it, a second lead made by staff: the first lead's evidence belongs to ANOTHER lead. */
  reopened: "Detail Reopened Nadee",
  /** An open automatic lead from one Meta ad referral. */
  auto: "Detail Auto Hasini",
  /** A lead in a reserved status (Paid) written straight to the table: no history, read-only. */
  paid: "Detail Paid Esha",
  /** A staff-created lead with no evidence and no conversation. */
  plain: "Detail Plain Gayan",
} as const;
/** The rich lead's history: CREATED + TOUCH_LINKED + this many status changes (=45 events; the page shows 20, then 20, then 5). */
export const DETAIL_STATUS_CHANGES = 43;
/** The text a Meta ad could carry. It must reach the screen as plain text, and nothing here may become markup or a link. */
export const DETAIL_HOSTILE = {
  headline: "<script>window.__xss=1</script><b>FREE</b> A/L ICT class",
  body: 'Pay now <a href="https://evil.example/pay">here</a>\n<img src=x onerror="window.__xss=1"> javascript:alert(1) http://evil.example/steal',
} as const;

/**
 * Fake contacts of the status specs (Phase 07D-4, organization F). Each test that changes a lead owns its own, all created through
 * the real lead services as open NEW leads (revision 0), except `blocked` (a closed lead and a second, open lead of its contact).
 */
export const STATUS_CONTACTS = {
  move: "Status Move Anil",
  close: "Status Close Bimali",
  stale: "Status Stale Chamara",
  refresh: "Status Refresh Dilhan",
  duplicate: "Status Duplicate Eranga",
  lostApplied: "Status Lost Applied Farah",
  lostBefore: "Status Lost Before Gayan",
  readFails: "Status Read Fails Hiran",
  actor: "Status Actor Isuri",
  /** The account changes AFTER the server committed the change (the answer is held back meanwhile). */
  actorCommitted: "Status Committed Mahesh",
  /** The server commits, and the browser receives HTTP 200 with an envelope that has no lead (and one whose lead is null). */
  malformed: "Status Malformed Nuwan",
  malformedNull: "Status Malformed Null Oshadi",
  /** The server commits revision 1, and the browser is told the impossible revision 101. */
  impossibleRevision: "Status Impossible Revision Ruwan",
  /** Somebody else changes the lead again before this person's follow-up read arrives. */
  newer: "Status Newer Pasindu",
  keyboard: "Status Keyboard Janaka",
  mobile: "Status Mobile Kumari",
  /** A CLOSED lead (the first one) and an OPEN one made after it for the same contact: reopening the first is refused. */
  blocked: "Status Blocked Lasantha",
} as const;

// Inbox lead panel identities (Phase 07D-5, organization G). `actor` signs out in a second tab during the account-change test.
export const PANEL_USERS = {
  staff: user("panel.staff", "Panel Staff", "STAFF", "G"),
  viewer: user("panel.viewer", "Panel Viewer", "VIEWER", "G"),
  admin: user("panel.admin", "Panel Admin", "ADMIN", "G"),
  actor: user("panel.actor", "Panel Actor", "STAFF", "G"),
} as const;

/**
 * Fake contacts of the panel specs, each with ONE conversation in organization G. Every test that creates owns its contact.
 * `open`: an open Qualified lead and an earlier closed one. `closed`: two closed leads, none open. `archived`: an archived
 * contact without a lead. `raceA`: one open New lead. The rest have no lead.
 */
export const PANEL_CONTACTS = {
  open: "Panel Open Asha",
  closed: "Panel Closed Bandara",
  none: "Panel None Chathu",
  create: "Panel Create Deepa",
  archived: "Panel Archived Eshan",
  raceA: "Panel Race Anura",
  raceB: "Panel Race Bimsara",
  navigate: "Panel Navigate Chamari",
  lostAfter: "Panel Lost After Dinuka",
  lostBefore: "Panel Lost Before Erandi",
  malformed: "Panel Malformed Fathima",
  actor: "Panel Actor Gihan",
  mobile: "Panel Mobile Hasara",
  badCreated: "Panel Bad Created Isuru",
  badExisting: "Panel Bad Existing Janaka",
  actorAfter: "Panel Actor After Kumari",
  actorUnknown: "Panel Actor Unknown Lasith",
  noMutation: "Panel No Mutation Nuwan",
} as const;

// Phase 07D-6 integration identities (organization H): the whole Leads Management system in one organization.
export const INTEG_USERS = {
  staff: user("integ.staff", "Integ Staff", "STAFF", "H"),
  viewer: user("integ.viewer", "Integ Viewer", "VIEWER", "H"),
} as const;

/**
 * Fake contacts of the integration journeys, each with ONE conversation in organization H. `ad`: a confirmed Meta ad referral,
 * turned into a lead by the real reconciler. `manual`, `cycle` (a staff-created lead), `reserved` (a Paid lead), `viewer`
 * (nothing) and `foreign` (nothing) are owned by one test each.
 */
export const INTEG_CONTACTS = {
  ad: "Integ Ad Nimali",
  manual: "Integ Manual Oshan",
  cycle: "Integ Cycle Pavithra",
  reserved: "Integ Reserved Rukshan",
  viewer: "Integ Viewer Sachini",
  mobile: "Integ Mobile Tharindu",
} as const;

// Inbox bot indicator identities (Phase 08F, e2e/inbox-bot.spec.ts). They are NOT created by scripts/e2e-seed.ts: the spec creates
// its own organizations, members, conversations and bot history with plain SQL (e2e/support/bot-fixtures.ts), so the shared seed
// and every other spec are untouched. Organization A holds the bot history; organization B holds one conversation of its own.
export const BOT_ORG_A = { name: "E2E Bots Org A", slug: "e2e-bots-org-a" } as const;
export const BOT_ORG_B = { name: "E2E Bots Org B", slug: "e2e-bots-org-b" } as const;
export const BOT_USERS = {
  admin: { email: "bots.admin@e2e.test", name: "Bots Admin", org: "A", role: "ADMIN" },
  staff: { email: "bots.staff@e2e.test", name: "Bots Staff", org: "A", role: "STAFF" },
  viewer: { email: "bots.viewer@e2e.test", name: "Bots Viewer", org: "A", role: "VIEWER" },
  orgB: { email: "bots.orgb@e2e.test", name: "Bots Org B Staff", org: "B", role: "STAFF" },
} as const;
