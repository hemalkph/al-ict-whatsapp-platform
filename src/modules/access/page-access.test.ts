import { describe, expect, it } from "vitest";
import {
  loginDestination,
  pageRedirectFor,
  type DeniedStatus,
  type PageAccess,
} from "./page-access";
import type { AccessContext } from "./access";

const ctx = {
  userId: "u",
  membershipId: "m",
  organizationId: "o",
  role: "STAFF",
  can: () => true,
} as AccessContext;
const DENIED: DeniedStatus[] = [
  "unauthenticated",
  "password_change_required",
  "forbidden",
  "organization_selection_required",
];

describe("page redirects", () => {
  it("sends each denied status to the right place", () => {
    expect(pageRedirectFor("unauthenticated")).toBe("/login");
    expect(pageRedirectFor("password_change_required")).toBe("/change-password");
    expect(pageRedirectFor("forbidden")).toBe("/login?reason=access");
    expect(pageRedirectFor("organization_selection_required")).toBe("/login?reason=organization");
  });

  it("echoes only a validated destination in ?next=", () => {
    expect(pageRedirectFor("unauthenticated", "/inbox?status=open")).toBe(
      "/login?next=%2Finbox%3Fstatus%3Dopen",
    );
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "javascript:alert(1)",
      "/\\evil.example",
      "",
    ]) {
      expect(pageRedirectFor("unauthenticated", bad), bad).toBe("/login");
    }
  });

  it("/login only forwards a visitor who already has access or a pending password change", () => {
    expect(loginDestination({ status: "ok", ctx }, "/inbox")).toBe("/inbox");
    expect(loginDestination({ status: "ok", ctx }, "https://evil.example")).toBe("/");
    expect(loginDestination({ status: "ok", ctx }, undefined)).toBe("/");
    expect(loginDestination({ status: "password_change_required" }, "/inbox")).toBe(
      "/change-password",
    );
    for (const s of ["unauthenticated", "forbidden", "organization_selection_required"] as const) {
      expect(loginDestination({ status: s }, "/inbox"), s).toBeNull();
    }
  });
});

describe("redirect-loop prevention", () => {
  // Model of the three pages' server-side decisions. A user state determines what each page sees.
  type State = "ok" | DeniedStatus;
  const accessOf = (s: State): PageAccess => (s === "ok" ? { status: "ok", ctx } : { status: s });
  // /change-password uses getPasswordChangeStatus: only an unauthenticated user or one with a pending change differs.
  const changeStatus = (s: State) =>
    s === "unauthenticated"
      ? "unauthenticated"
      : s === "password_change_required"
        ? "required"
        : "not_required";

  function visit(path: string, state: State): { rendered: string; hops: number } {
    let current = path;
    for (let hops = 0; hops < 10; hops++) {
      const url = new URL(current, "http://x");
      if (url.pathname === "/") {
        const a = accessOf(state);
        if (a.status === "ok") return { rendered: "/", hops };
        current = pageRedirectFor(a.status);
      } else if (url.pathname === "/login") {
        const dest = loginDestination(accessOf(state), url.searchParams.get("next") ?? undefined);
        if (!dest) return { rendered: "/login", hops };
        current = dest;
      } else if (url.pathname === "/change-password") {
        const s = changeStatus(state);
        if (s === "required") return { rendered: "/change-password", hops };
        current = s === "unauthenticated" ? "/login" : "/";
      }
    }
    throw new Error(`redirect loop starting at ${path} for ${state}`);
  }

  const STATES: State[] = ["ok", ...DENIED];
  it.each(
    STATES.flatMap((s) =>
      ["/", "/login", "/change-password", "/login?next=%2F"].map((p) => [p, s] as const),
    ),
  )("%s never loops for a user in state %s", (path, state) => {
    expect(() => visit(path, state)).not.toThrow();
  });

  it("lands each user state on the expected page", () => {
    expect(visit("/", "ok").rendered).toBe("/");
    expect(visit("/", "unauthenticated").rendered).toBe("/login");
    expect(visit("/", "password_change_required").rendered).toBe("/change-password");
    expect(visit("/login", "password_change_required").rendered).toBe("/change-password");
    expect(visit("/change-password", "ok").rendered).toBe("/");
    expect(visit("/", "forbidden").rendered).toBe("/login");
    expect(visit("/", "organization_selection_required").rendered).toBe("/login");
  });
});
