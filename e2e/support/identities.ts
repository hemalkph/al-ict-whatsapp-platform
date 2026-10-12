// TEST-ONLY identities for the browser E2E suite. Every value here is a fake that exists only inside the
// disposable E2E database, which is created for one run and dropped afterwards. Nothing here is a real secret.
// Each spec owns its identities so specs can run in parallel without sharing mutable state.

export const E2E_PASSWORD = "e2e-initial-password-1";
export const E2E_NEW_PASSWORD = "e2e-changed-password-2";

export const ORG_A = { name: "E2E Org A", slug: "e2e-org-a" } as const;
export const ORG_B = { name: "E2E Org B", slug: "e2e-org-b" } as const;
/** Owns the Phase 06 review-correction specs (e2e/inbox-review.spec.ts) so nothing there shares conversations with other specs. */
export const ORG_C = { name: "E2E Org C", slug: "e2e-org-c" } as const;

/** Created by the REAL bootstrap workflow: password_change_required = true. */
export const FIRST_ADMIN = { email: "first.admin@e2e.test", name: "First Admin" } as const;

export type SeedUser = {
  readonly email: string;
  readonly name: string;
  readonly org: "A" | "B" | "C";
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
