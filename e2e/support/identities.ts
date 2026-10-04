// TEST-ONLY identities for the browser E2E suite. Every value here is a fake that exists only inside the
// disposable E2E database, which is created for one run and dropped afterwards. Nothing here is a real secret.
// Each spec owns its identities so specs can run in parallel without sharing mutable state.

export const E2E_PASSWORD = "e2e-initial-password-1";
export const E2E_NEW_PASSWORD = "e2e-changed-password-2";

export const ORG_A = { name: "E2E Org A", slug: "e2e-org-a" } as const;
export const ORG_B = { name: "E2E Org B", slug: "e2e-org-b" } as const;

/** Created by the REAL bootstrap workflow: password_change_required = true. */
export const FIRST_ADMIN = { email: "first.admin@e2e.test", name: "First Admin" } as const;

export type SeedUser = {
  readonly email: string;
  readonly name: string;
  readonly org: "A" | "B";
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
